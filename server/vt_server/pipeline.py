"""Pipeline d'une session : audio -> segments -> texte -> traduction -> voix.

Trois fils d'exécution :
* la boucle réseau reçoit l'audio et exécute la détection de parole (rapide) ;
* un fil « texte » transcrit et traduit les segments, dans l'ordre ;
* un fil « voix » synthétise les phrases traduites, dans l'ordre.

Chaque élément porte l'« époque » de la session. Un changement de vidéo ou
un déplacement dans la timeline incrémente l'époque : tout ce qui est en
file d'attente ou en cours de calcul pour une époque antérieure est jeté.
"""

from __future__ import annotations

import json
import logging
import struct
import threading
import time
import wave
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from .config import Config
from .engines import VOICES, Engines
from .segmenter import SAMPLE_RATE, Segmenter, SileroVad, SpeechSegment
from .textproc import Glossary, ends_sentence, parse_glossary, split_sentences

log = logging.getLogger("vt.pipeline")

SUPPORTED_PAIRS = {("en", "fr")}
MAX_CARRY_CHARS = 220
CARRY_TIMEOUT_S = 1.6


@dataclass
class Settings:
    source: str = "en"
    target: str = "fr"
    voice: str = "siwis"
    rate: float = 1.0  # vitesse de voix choisie par l'utilisateur
    video_rate: float = 1.0  # vitesse de lecture de la vidéo
    auto_speedup: bool = True
    glossary: Glossary = None  # type: ignore[assignment]

    def __post_init__(self):
        if self.glossary is None:
            self.glossary = Glossary([])


def parse_settings(raw: dict, base: Optional[Settings] = None) -> Settings:
    """Valide les réglages envoyés par l'extension."""
    if not isinstance(raw, dict):
        raise ValueError("réglages : objet attendu")
    s = Settings() if base is None else Settings(**vars(base))
    allowed = {"source", "target", "voice", "rate", "videoRate", "autoSpeedup", "glossary"}
    unknown = set(raw) - allowed
    if unknown:
        raise ValueError(f"réglages inconnus : {', '.join(sorted(unknown))}")
    if "source" in raw or "target" in raw:
        src, tgt = raw.get("source", s.source), raw.get("target", s.target)
        if (src, tgt) not in SUPPORTED_PAIRS:
            raise ValueError(f"paire de langues non installée : {src} → {tgt}")
        s.source, s.target = src, tgt
    if "voice" in raw:
        if raw["voice"] not in VOICES:
            raise ValueError("voix inconnue")
        s.voice = raw["voice"]
    for key, attr, lo, hi in (("rate", "rate", 0.6, 1.8), ("videoRate", "video_rate", 0.25, 4.0)):
        if key in raw:
            v = raw[key]
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not (lo <= v <= hi):
                raise ValueError(f"valeur invalide pour {key}")
            setattr(s, attr, float(v))
    if "autoSpeedup" in raw:
        if not isinstance(raw["autoSpeedup"], bool):
            raise ValueError("autoSpeedup : booléen attendu")
        s.auto_speedup = raw["autoSpeedup"]
    if "glossary" in raw:
        s.glossary = Glossary(parse_glossary(raw["glossary"]))
    return s


@dataclass
class _TtsItem:
    epoch: int
    seg_id: int
    seq: int
    text: str
    t0: float
    t1: float
    last: bool


class Session:
    def __init__(self, engines: Engines, cfg: Config,
                 send_json: Callable[[dict], None], send_binary: Callable[[bytes], None]):
        self.engines = engines
        self.cfg = cfg
        self._send_json = send_json
        self._send_binary = send_binary
        self.settings = Settings(voice=cfg.default_voice if cfg.default_voice in VOICES else "siwis")
        self.epoch = -1
        self.active = False
        self.segmenter = Segmenter(
            SileroVad(),
            threshold=cfg.vad_threshold,
            min_silence_s=cfg.min_silence_s,
            soft_max_s=cfg.soft_max_segment_s,
            hard_max_s=cfg.hard_max_segment_s,
            min_speech_s=cfg.min_speech_s,
        )
        self._cv = threading.Condition()
        self._seg_q: deque = deque()  # (epoch, id, SpeechSegment)
        self._tts_q: deque = deque()
        self._closed = False
        self._seg_counter = 0
        self._client_queue_s = 0.0
        self._last_level_clock = -1.0
        self._silent_s = 0.0  # durée de silence numérique absolu (diagnostic)
        # État du fil « texte » (accédé uniquement par lui).
        self._carry = ""
        self._carry_epoch = -1
        self._carry_t0 = 0.0
        self._carry_t1 = 0.0
        self._carry_wall = 0.0
        self._context = ""
        # Statistiques.
        self.stats = {"segments": 0, "abandonnes": 0, "incertains": 0, "phrases": 0,
                      "audio_s": 0.0, "asr_s": 0.0, "mt_s": 0.0, "tts_s": 0.0, "voix_s": 0.0}
        self._busy_text = False
        self._busy_tts = False
        self._phase = "transcription"
        self._threads = [
            threading.Thread(target=self._text_loop, name="vt-texte", daemon=True),
            threading.Thread(target=self._tts_loop, name="vt-voix", daemon=True),
        ]
        for t in self._threads:
            t.start()

    # ----------------------------------------------------------- commandes
    def start(self, epoch: int, settings: Settings) -> None:
        self.settings = settings
        self._reset_to(epoch)
        self.active = True

    def update_settings(self, settings: Settings) -> None:
        self.settings = settings

    def reset(self, epoch: int) -> None:
        """Jette tout le travail en cours (changement de vidéo, saut, pause)."""
        self._reset_to(epoch)

    def _reset_to(self, epoch: int) -> None:
        with self._cv:
            self.epoch = epoch
            self._seg_q.clear()
            self._tts_q.clear()
            self._client_queue_s = 0.0
            self._cv.notify_all()
        self.segmenter.reset()
        self._last_level_clock = -1.0
        self._silent_s = 0.0

    def stop(self) -> None:
        """Arrêt de la capture : termine le segment ouvert, puis se met au repos."""
        if self.active:
            seg = self.segmenter.finish()
            if seg is not None:
                self._enqueue_segment(seg)
        self.active = False

    def close(self) -> None:
        self.active = False
        with self._cv:
            self._closed = True
            self._seg_q.clear()
            self._tts_q.clear()
            self._cv.notify_all()

    def playback_report(self, queue_s: float) -> None:
        self._client_queue_s = max(0.0, min(600.0, queue_s))

    # --------------------------------------------------------------- audio
    def feed(self, epoch: int, pcm: bytes) -> None:
        if not self.active or epoch != self.epoch:
            return  # audio d'une époque périmée
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        if samples.size and not np.any(samples):
            self._silent_s += samples.size / SAMPLE_RATE
        else:
            self._silent_s = 0.0
        for seg in self.segmenter.feed(samples):
            self._enqueue_segment(seg)
        clock = self.segmenter.clock_s
        if clock - self._last_level_clock >= 0.25:
            self._last_level_clock = clock
            self._send_json(self._metrics(clock))

    def _metrics(self, clock: float) -> dict:
        with self._cv:
            backlog = sum(s.t1 - s.t0 for _e, _i, s in self._seg_q)
            tts_n = len(self._tts_q)
        st = self.stats
        rtf = (st["asr_s"] + st["mt_s"] + st["tts_s"]) / st["audio_s"] if st["audio_s"] > 0 else 0.0
        return {
            "type": "metrics",
            "epoch": self.epoch,
            "clock": round(clock, 2),
            "level": round(self.segmenter.last_rms, 4),
            "speech": self.segmenter.in_speech,
            "openSegment": round(self.segmenter.open_segment_s, 1),
            "silentInput": round(self._silent_s, 1),
            "asrBacklog": round(backlog, 1),
            "ttsQueue": tts_n,
            "busy": self._phase if self._busy_text else ("voix" if self._busy_tts else ""),
            "rtf": round(rtf, 3),
            "dropped": st["abandonnes"],
            "uncertain": st["incertains"],
        }

    def _enqueue_segment(self, seg: SpeechSegment) -> None:
        dropped = []
        with self._cv:
            self._seg_counter += 1
            self._seg_q.append((self.epoch, self._seg_counter, seg))
            backlog = sum(s.t1 - s.t0 for _e, _i, s in self._seg_q)
            # Le PC ne suit pas : abandonner les segments les plus anciens
            # plutôt que d'accumuler un retard sans fin.
            while backlog > self.cfg.max_asr_backlog_s and len(self._seg_q) > 1:
                e, i, old = self._seg_q.popleft()
                backlog -= old.t1 - old.t0
                dropped.append((e, i, old))
            self._cv.notify_all()
        for e, i, old in dropped:
            self.stats["abandonnes"] += 1
            self._send_json({
                "type": "segment", "id": i, "epoch": e, "t0": round(old.t0, 2),
                "t1": round(old.t1, 2), "status": "abandonne",
                "reason": "traitement trop lent : passage ignoré pour rattraper le retard",
            })

    # ---------------------------------------------------------- fil « texte »
    def _text_loop(self) -> None:
        while True:
            with self._cv:
                while not self._seg_q and not self._closed:
                    if self._carry:
                        self._cv.wait(timeout=0.4)
                        if not self._seg_q:
                            break
                    else:
                        self._cv.wait()
                if self._closed:
                    return
                item = self._seg_q.popleft() if self._seg_q else None
                backlog = sum(s.t1 - s.t0 for _e, _i, s in self._seg_q)
            try:
                if item is None:
                    self._maybe_flush_carry()
                else:
                    self._busy_text = True
                    self._process_segment(*item, backlog=backlog)
            except Exception as exc:
                log.exception("Erreur de traitement d'un segment")
                self._send_json({"type": "error", "code": "pipeline",
                                 "message": f"Erreur de traitement : {exc}"})
            finally:
                self._busy_text = False

    def _maybe_flush_carry(self) -> None:
        if not self._carry:
            return
        if self._carry_epoch != self.epoch:
            self._carry = ""
            return
        waited = time.monotonic() - self._carry_wall
        if waited >= CARRY_TIMEOUT_S and not self.segmenter.in_speech:
            text, self._carry = self._carry, ""
            with self._cv:
                self._seg_counter += 1
                seg_id = self._seg_counter
            self._translate_and_queue(self._carry_epoch, seg_id, text,
                                      self._carry_t0, self._carry_t1, asr_ms=0, conf=None)

    def _process_segment(self, epoch: int, seg_id: int, seg: SpeechSegment, *, backlog: float) -> None:
        if epoch != self.epoch:
            return
        eng = self.engines
        if not eng.ready.is_set():
            self._send_json({"type": "segment", "id": seg_id, "epoch": epoch,
                             "t0": round(seg.t0, 2), "t1": round(seg.t1, 2),
                             "status": "abandonne", "reason": "moteurs en cours de chargement"})
            return
        if self._carry_epoch != epoch:
            self._carry, self._context = "", ""
            self._carry_epoch = epoch
        st = self.settings
        fast = backlog > self.cfg.fast_mode_backlog_s
        self._phase = "transcription"
        t = time.perf_counter()
        prompt = (st.glossary.asr_prompt() + " " + self._context[-200:]).strip()
        res = eng.recognizer.transcribe(seg.audio, prompt=prompt, fast=fast, language=st.source)
        asr_s = time.perf_counter() - t
        dur = seg.t1 - seg.t0
        self.stats["segments"] += 1
        self.stats["audio_s"] += dur
        self.stats["asr_s"] += asr_s
        if epoch != self.epoch:
            return  # résultat périmé (saut ou changement de vidéo pendant le calcul)
        conf = {"logprob": round(res.avg_logprob, 2), "noSpeech": round(res.no_speech_prob, 2)}
        if res.uncertain:
            # Ne rien inventer : un passage douteux n'est ni traduit ni prononcé.
            self.stats["incertains"] += 1
            self._send_json({
                "type": "segment", "id": seg_id, "epoch": epoch, "t0": round(seg.t0, 2),
                "t1": round(seg.t1, 2), "status": "incertain", "reason": res.reason,
                "en": res.text, "asrMs": int(asr_s * 1000), "conf": conf,
            })
            return
        text = st.glossary.correct_transcript(res.text)
        self._context = (self._context + " " + text)[-400:]
        t0 = seg.t0
        if self._carry:
            text = self._carry + " " + text
            t0 = self._carry_t0
            self._carry = ""
        sentences = split_sentences(text)
        # Coupe forcée en pleine phrase : garder la fin inachevée pour la
        # joindre au segment suivant, au lieu de traduire une demi-phrase.
        if seg.end == "forcee" and sentences and not ends_sentence(sentences[-1]) \
                and len(sentences[-1]) <= MAX_CARRY_CHARS:
            self._carry = sentences.pop()
            self._carry_t0 = seg.t0 if not sentences else seg.t1 - 0.5
            self._carry_t1 = seg.t1
            self._carry_wall = time.monotonic()
        if not sentences:
            return
        self._translate_and_queue(epoch, seg_id, " ".join(sentences), t0, seg.t1,
                                  asr_ms=int(asr_s * 1000), conf=conf, sentences=sentences,
                                  fast=fast)

    def _translate_and_queue(self, epoch, seg_id, text, t0, t1, *, asr_ms, conf,
                             sentences=None, fast=False) -> None:
        st = self.settings
        sentences = sentences or split_sentences(text)
        self._phase = "traduction"
        t = time.perf_counter()
        fr_parts, notes = [], []
        for s in sentences:
            tr = self.engines.translator.translate(s, st.glossary)
            if tr.ok:
                fr_parts.append(tr.text)
            if tr.note:
                notes.append(tr.note)
            if epoch != self.epoch:
                return
        mt_s = time.perf_counter() - t
        self.stats["mt_s"] += mt_s
        self.stats["phrases"] += len(fr_parts)
        self._send_json({
            "type": "segment", "id": seg_id, "epoch": epoch, "t0": round(t0, 2),
            "t1": round(t1, 2), "status": "ok" if fr_parts else "incertain",
            "reason": "" if fr_parts else "traduction rejetée",
            "en": text, "fr": " ".join(fr_parts), "asrMs": asr_ms, "mtMs": int(mt_s * 1000),
            "conf": conf, "fast": fast, "notes": notes,
        })
        with self._cv:
            if epoch != self.epoch:
                return
            for i, fr in enumerate(fr_parts):
                self._tts_q.append(_TtsItem(epoch, seg_id, i, fr, t0, t1, i == len(fr_parts) - 1))
            self._cv.notify_all()

    # ----------------------------------------------------------- fil « voix »
    def _speech_rate(self, item: _TtsItem) -> tuple:
        st = self.settings
        rate = st.rate * min(1.5, max(1.0, st.video_rate))
        lag = max(0.0, self.segmenter.clock_s - item.t1) + self._client_queue_s
        boost = 1.0
        if st.auto_speedup and lag > 4.0:
            boost = min(self.cfg.max_speedup, 1.0 + (lag - 4.0) * 0.03)
        return min(1.9, rate * boost), lag, boost

    def _tts_loop(self) -> None:
        while True:
            with self._cv:
                while not self._tts_q and not self._closed:
                    self._cv.wait()
                if self._closed:
                    return
                item = self._tts_q.popleft()
            if item.epoch != self.epoch:
                continue
            self._busy_tts = True
            try:
                rate, lag, boost = self._speech_rate(item)
                t = time.perf_counter()
                speech = self.engines.speaker.synthesize(item.text, self.settings.voice, rate)
                tts_s = time.perf_counter() - t
                self.stats["tts_s"] += tts_s
                if speech is None or item.epoch != self.epoch:
                    continue
                self.stats["voix_s"] += speech.duration
                header = {
                    "type": "audio", "id": item.seg_id, "seq": item.seq, "epoch": item.epoch,
                    "sampleRate": speech.sample_rate, "duration": round(speech.duration, 3),
                    "t0": round(item.t0, 2), "t1": round(item.t1, 2), "text": item.text,
                    "rate": round(rate, 2), "boost": round(boost, 2),
                    "ttsMs": int(tts_s * 1000), "serverLag": round(lag, 2), "last": item.last,
                }
                self._send_binary(pack_audio(header, speech.pcm))
                self._debug_dump(header, speech)
            except Exception as exc:
                log.exception("Erreur de synthèse vocale")
                self._send_json({"type": "error", "code": "tts",
                                 "message": f"Synthèse vocale impossible : {exc}"})
            finally:
                self._busy_tts = False

    def _debug_dump(self, header: dict, speech) -> None:
        d = self.cfg.debug_dump_dir
        if not d:
            return
        out = Path(d)
        out.mkdir(parents=True, exist_ok=True)
        stem = f"e{header['epoch']}_s{header['id']:04d}_{header['seq']}"
        with wave.open(str(out / f"{stem}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(speech.sample_rate)
            w.writeframes(speech.pcm)
        (out / f"{stem}.json").write_text(json.dumps(header, ensure_ascii=False), encoding="utf-8")

    # ------------------------------------------------------------ test de voix
    def voice_test(self, voice: str, rate: float, text: str) -> None:
        def run():
            try:
                speech = self.engines.speaker.synthesize(text, voice, rate)
                if speech is None:
                    return
                header = {"type": "audio", "test": True, "id": 0, "seq": 0, "epoch": -1,
                          "sampleRate": speech.sample_rate, "duration": round(speech.duration, 3),
                          "text": text, "rate": rate}
                self._send_binary(pack_audio(header, speech.pcm))
            except Exception as exc:
                self._send_json({"type": "error", "code": "tts",
                                 "message": f"Test de voix impossible : {exc}"})

        threading.Thread(target=run, name="vt-test-voix", daemon=True).start()


def pack_audio(header: dict, pcm: bytes) -> bytes:
    """Trame binaire : longueur de l'en-tête (uint32 LE) + en-tête JSON + PCM16."""
    h = json.dumps(header, ensure_ascii=False).encode("utf-8")
    return struct.pack("<I", len(h)) + h + pcm
