"""Moteurs locaux : reconnaissance (Whisper), traduction (OPUS-MT), voix (Piper)."""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from . import models
from .config import Config
from .textproc import (
    Glossary,
    looks_degenerate,
    protect,
    protected_terms,
    restore,
    speakable_fr,
)

log = logging.getLogger("vt.engines")

# ------------------------------------------------------------- reconnaissance

# Phrases typiquement « inventées » par Whisper sur du bruit ou du silence.
_HALLUCINATIONS = {
    "thank you.", "thanks for watching.", "thanks for watching!", "thank you for watching.",
    "thank you for watching!", "bye.", "bye-bye.", "you", ".", "so", "okay.",
    "subtitles by the amara.org community", "please subscribe.", "i'll see you next time.",
}


@dataclass
class AsrResult:
    text: str
    avg_logprob: float
    no_speech_prob: float
    compression_ratio: float
    uncertain: bool
    reason: str = ""


class Recognizer:
    def __init__(self, model_dir: Path, cfg: Config):
        from faster_whisper import WhisperModel

        device = cfg.device
        compute = cfg.compute_type or ("int8" if device == "cpu" else "default")
        self.model = WhisperModel(
            str(model_dir), device=device, compute_type=compute, cpu_threads=cfg.cpu_threads
        )
        self.beam_size = cfg.beam_size

    def transcribe(self, audio: np.ndarray, *, prompt: str = "",
                   fast: bool = False, language: str = "en") -> AsrResult:
        segments, _info = self.model.transcribe(
            audio,
            language=language,
            beam_size=1 if fast else self.beam_size,
            temperature=(0.0,) if fast else (0.0, 0.4),
            condition_on_previous_text=False,
            initial_prompt=prompt or None,
            without_timestamps=True,
            vad_filter=False,
            no_speech_threshold=0.6,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.4,
        )
        segs = list(segments)
        if not segs:
            return AsrResult("", 0.0, 1.0, 0.0, True, "aucune parole reconnue")
        text = " ".join(s.text.strip() for s in segs).strip()
        n = len(segs)
        avg_lp = sum(s.avg_logprob for s in segs) / n
        nsp = max(s.no_speech_prob for s in segs)
        cr = max(s.compression_ratio for s in segs)
        reason = ""
        if avg_lp < -1.0:
            reason = "reconnaissance trop incertaine"
        elif nsp > 0.6 and avg_lp < -0.5:
            reason = "probablement pas de la parole"
        elif cr > 2.4:
            reason = "texte répétitif (reconnaissance douteuse)"
        elif text.lower() in _HALLUCINATIONS and (nsp > 0.3 or avg_lp < -0.6 or len(audio) < 16000):
            reason = "phrase parasite sur un passage sans parole nette"
        elif not any(ch.isalnum() for ch in text):
            reason = "aucun mot reconnu"
        return AsrResult(text, avg_lp, nsp, cr, bool(reason), reason)


# ------------------------------------------------------------------ traduction


@dataclass
class Translation:
    text: str
    ok: bool  # False : traduction rejetée (ne pas prononcer)
    note: str = ""


class Translator:
    def __init__(self, model_dir: Path, cfg: Config):
        import ctranslate2
        import sentencepiece as spm

        compute = "int8" if cfg.device == "cpu" else "default"
        self.tr = ctranslate2.Translator(
            str(model_dir), device=cfg.device, compute_type=compute,
            intra_threads=max(1, min(4, cfg.cpu_threads)),
        )
        self.sp_src = spm.SentencePieceProcessor(model_file=str(model_dir / "source.spm"))
        self.sp_tgt = spm.SentencePieceProcessor(model_file=str(model_dir / "target.spm"))

    def _raw(self, text: str) -> str:
        toks = self.sp_src.encode(text, out_type=str)[:400] + ["</s>"]
        res = self.tr.translate_batch(
            [toks], beam_size=4, max_decoding_length=400, repetition_penalty=1.1,
            no_repeat_ngram_size=5,
        )
        out = self.sp_tgt.decode(res[0].hypotheses[0])
        return out.replace("⁇", " ").strip()

    def translate(self, sentence: str, glossary: Glossary) -> Translation:
        """Traduit une phrase en préservant le glossaire et les termes techniques."""
        sentence = sentence.strip()
        if not sentence:
            return Translation("", False, "vide")
        must_keep = protected_terms(sentence, glossary)
        # 1er essai : les traductions imposées sont insérées dans la phrase
        # source ; le reste est laissé au modèle, qui recopie en général
        # correctement les noms propres et les identifiants.
        src1, forced = glossary.substitute_forced(sentence)
        out = self._raw(src1)
        low = out.lower()
        if all(t in out for t in must_keep) and all(f.lower() in low for f in forced) \
                and not looks_degenerate(sentence, out):
            return Translation(glossary.apply_post(out), True)
        # 2e essai : tous les termes protégés sont remplacés par des jetons
        # que le modèle recopie, puis réinsérés.
        prot = protect(sentence, glossary, code=True)
        out2, ok2 = restore(self._raw(prot.text), prot)
        if ok2 and not looks_degenerate(sentence, out2):
            return Translation(glossary.apply_post(out2), True, "termes protégés par jetons")
        # Repli : garder la meilleure sortie non dégénérée, sinon rejeter.
        for cand in (out, out2):
            if not looks_degenerate(sentence, cand):
                return Translation(glossary.apply_post(cand), True,
                                   "glossaire partiellement appliqué")
        return Translation("", False, "traduction incohérente rejetée")


# ----------------------------------------------------------------------- voix

VOICES = {
    # identifiant : (clé du modèle, fichier, numéro de locuteur, libellé)
    "siwis": ("tts:siwis", "fr_FR-siwis-medium.onnx", None, "Siwis — voix féminine (France)"),
    "upmc-jessica": ("tts:upmc", "fr_FR-upmc-medium.onnx", 0, "Jessica — voix féminine (France)"),
    "upmc-pierre": ("tts:upmc", "fr_FR-upmc-medium.onnx", 1, "Pierre — voix masculine (France)"),
}


@dataclass
class Speech:
    pcm: bytes  # PCM 16 bits mono
    sample_rate: int
    duration: float


def trim_silence(pcm: bytes, sr: int, keep_s: float = 0.04) -> bytes:
    """Retire le blanc que Piper ajoute avant et après chaque phrase.

    Chaque phrase française démarre ainsi plus tôt et la file de lecture se
    vide plus vite (le blanc entre deux phrases est géré par l'extension)."""
    a = np.frombuffer(pcm, dtype="<i2")
    if a.size == 0:
        return pcm
    loud = np.nonzero(np.abs(a) > 300)[0]  # ≈ -40 dB
    if loud.size == 0:
        return pcm
    keep = int(keep_s * sr)
    lo = max(0, int(loud[0]) - keep)
    hi = min(a.size, int(loud[-1]) + keep)
    return a[lo:hi].tobytes()


class Speaker:
    def __init__(self, models_dir: str):
        self.models_dir = models_dir
        self._voices: dict = {}
        self._lock = threading.Lock()

    def available(self) -> list:
        out = []
        for vid, (key, _file, _spk, label) in VOICES.items():
            spec = models.CATALOG[key]
            out.append({
                "id": vid,
                "label": label,
                "lang": "fr",
                "installed": models.is_installed(self.models_dir, spec),
                "license": spec.license,
            })
        return out

    def _load(self, voice_id: str):
        if voice_id not in VOICES:
            raise KeyError(f"Voix inconnue : {voice_id}")
        key, fname, _spk, _label = VOICES[voice_id]
        with self._lock:
            if key not in self._voices:
                from piper import PiperVoice

                spec = models.CATALOG[key]
                if not models.is_installed(self.models_dir, spec):
                    raise FileNotFoundError(
                        f"La voix « {voice_id} » n'est pas installée "
                        "(relancez scripts\\installer.bat)."
                    )
                path = models.model_dir(self.models_dir, spec) / fname
                self._voices[key] = PiperVoice.load(str(path))
            return self._voices[key]

    def preload(self, voice_id: str) -> None:
        self._load(voice_id)

    def synthesize(self, text: str, voice_id: str, rate: float = 1.0) -> Optional[Speech]:
        from piper import SynthesisConfig

        spoken = speakable_fr(text)
        if not any(ch.isalnum() for ch in spoken):
            return None
        voice = self._load(voice_id)
        spk = VOICES[voice_id][2]
        rate = min(2.0, max(0.5, rate))
        cfg = SynthesisConfig(speaker_id=spk, length_scale=1.0 / rate)
        with self._lock:  # une synthèse à la fois par processus
            chunks = list(voice.synthesize(spoken, cfg))
        if not chunks:
            return None
        pcm = trim_silence(b"".join(c.audio_int16_bytes for c in chunks), chunks[0].sample_rate)
        sr = chunks[0].sample_rate
        return Speech(pcm, sr, len(pcm) / 2 / sr)


# ------------------------------------------------------------ gestion globale

StatusCb = Callable[[dict], None]


class Engines:
    """Charge les moteurs en arrière-plan et publie la progression."""

    def __init__(self, cfg: Config, *, download: bool = True):
        self.cfg = cfg
        self.download = download
        self.recognizer: Optional[Recognizer] = None
        self.translator: Optional[Translator] = None
        self.speaker = Speaker(cfg.models_dir)
        self.vad_ready = False
        self._listeners: list = []
        self._lock = threading.Lock()
        self.state = {
            "asr": {"state": "attente", "progress": 0.0, "label": "", "detail": ""},
            "mt": {"state": "attente", "progress": 0.0, "label": "", "detail": ""},
            "tts": {"state": "attente", "progress": 0.0, "label": "", "detail": ""},
        }
        self.error: str = ""
        self.ready = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- observation
    def subscribe(self, cb: StatusCb) -> None:
        with self._lock:
            self._listeners.append(cb)

    def unsubscribe(self, cb: StatusCb) -> None:
        with self._lock:
            if cb in self._listeners:
                self._listeners.remove(cb)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "ready": self.ready.is_set(),
                "error": self.error,
                "components": {k: dict(v) for k, v in self.state.items()},
            }

    def _set(self, comp: str, **kw) -> None:
        with self._lock:
            self.state[comp].update(kw)
            listeners = list(self._listeners)
        snap = self.snapshot()
        for cb in listeners:
            try:
                cb(snap)
            except Exception:  # un auditeur défaillant ne doit pas bloquer le chargement
                log.exception("auditeur de statut")

    # -- chargement
    # Modèle de reconnaissance plus rapide à utiliser si le PC ne suit pas.
    FASTER_ASR = {"medium.en": "small.en", "small.en": "base.en", "base.en": "tiny.en"}

    def downgrade_asr(self, on_done: Callable[[str, str], None] | None = None) -> bool:
        """Passe en arrière-plan à un modèle de reconnaissance plus rapide.

        Le modèle actuel reste utilisé jusqu'à ce que le nouveau soit prêt.
        Renvoie False s'il n'existe pas de modèle plus rapide ou si un
        changement est déjà en cours."""
        current = self.cfg.asr_model
        target = self.FASTER_ASR.get(current)
        if target is None or getattr(self, "_downgrading", False):
            return False
        self._downgrading = True

        def run():
            try:
                d = self._prepare("asr", f"asr:{target}")
                rec = Recognizer(d, self.cfg)
                import numpy as np
                rec.transcribe(np.zeros(16000, dtype=np.float32), fast=True)
                self.recognizer = rec  # remplacement atomique
                self.cfg.asr_model = target
                self._set("asr", state="pret", label=models.CATALOG[f"asr:{target}"].label)
                log.warning("Reconnaissance trop lente avec %s : passage à %s", current, target)
                if on_done:
                    on_done(current, target)
            except Exception:
                log.exception("Passage à un modèle plus rapide impossible")
            finally:
                self._downgrading = False

        threading.Thread(target=run, name="vt-asr-rapide", daemon=True).start()
        return True

    def start(self) -> None:
        self._thread = threading.Thread(target=self._load_all, name="vt-load", daemon=True)
        self._thread.start()

    def _prepare(self, comp: str, key: str) -> Path:
        spec = models.CATALOG[key]
        self._set(comp, label=spec.label, detail="")
        if models.is_installed(self.cfg.models_dir, spec):
            return models.model_dir(self.cfg.models_dir, spec)
        if not self.download:
            raise FileNotFoundError(
                f"Modèle absent : {spec.label}. Lancez scripts\\installer.bat "
                "pour le télécharger."
            )
        self._set(comp, state="telechargement", progress=0.0,
                  detail=models.human_size(spec.total_size))
        last = [0.0]

        def progress(_key, done, total):
            now = time.monotonic()
            if now - last[0] > 0.3 or done == total:
                last[0] = now
                self._set(comp, state="telechargement", progress=done / max(1, total))

        return models.ensure_model(self.cfg.models_dir, key, progress)

    def _load_all(self) -> None:
        cfg = self.cfg
        comp = "asr"
        try:
            d = self._prepare("asr", f"asr:{cfg.asr_model}")
            self._set("asr", state="chargement", progress=1.0)
            self.recognizer = Recognizer(d, cfg)
            # Échauffement : le premier appel est nettement plus lent.
            import numpy as np
            self.recognizer.transcribe(np.zeros(16000, dtype=np.float32), fast=True)
            self._set("asr", state="pret")

            comp = "mt"
            d = self._prepare("mt", f"mt:{cfg.mt_model}")
            self._set("mt", state="chargement", progress=1.0)
            self.translator = Translator(d, cfg)
            self._set("mt", state="pret")

            comp = "tts"
            voice = cfg.default_voice if cfg.default_voice in VOICES else "siwis"
            self._prepare("tts", VOICES[voice][0])
            self._set("tts", state="chargement", progress=1.0)
            self.speaker.preload(voice)
            # Échauffement : la première synthèse est nettement plus lente.
            self.speaker.synthesize("Bonjour.", voice)
            self._set("tts", state="pret")
            self.ready.set()
            self._set("tts", state="pret")  # republie l'état « prêt » global
            log.info("Moteurs prêts (ASR %s, MT %s, voix %s)", cfg.asr_model, cfg.mt_model, voice)
        except Exception as exc:
            log.exception("Échec du chargement des moteurs")
            self.error = f"{exc}"
            self._set(comp, state="erreur", detail=str(exc))
