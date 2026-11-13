"""Détection de parole (Silero VAD) et découpage en segments cohérents.

Le flux audio (16 kHz mono) est analysé par trames de 32 ms. Un segment
commence quand de la parole est détectée et se termine :

* sur un silence suffisamment long (fin « pause ») ; la durée de silence
  exigée diminue quand le segment s'allonge, pour limiter le retard ;
* ou, si l'orateur ne s'arrête jamais, à la durée maximale : la coupe est
  alors placée sur la trame la moins « parlée » des dernières secondes
  (fin « forcee »), afin de ne pas trancher un mot.

Il n'y a aucun recouvrement entre segments : aucune parole n'est
transcrite deux fois.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16000
FRAME = 512  # 32 ms
CONTEXT = 64
FRAME_S = FRAME / SAMPLE_RATE


class SileroVad:
    """Silero VAD v6 (fichier ONNX fourni avec faster-whisper, licence MIT)."""

    def __init__(self, path: str | None = None):
        import onnxruntime

        if path is None:
            from faster_whisper.utils import get_assets_path
            import os

            path = os.path.join(get_assets_path(), "silero_vad_v6.onnx")
        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 4
        self.session = onnxruntime.InferenceSession(
            path, providers=["CPUExecutionProvider"], sess_options=opts
        )
        self.reset()

    def reset(self) -> None:
        self._h = np.zeros((1, 1, 128), dtype=np.float32)
        self._c = np.zeros((1, 1, 128), dtype=np.float32)
        self._ctx = np.zeros(CONTEXT, dtype=np.float32)

    def probs(self, frames: np.ndarray) -> np.ndarray:
        """frames : tableau (n, 512) float32 -> probabilités de parole (n,)."""
        n = frames.shape[0]
        ctx = np.empty((n, CONTEXT), dtype=np.float32)
        ctx[0] = self._ctx
        if n > 1:
            ctx[1:] = frames[:-1, -CONTEXT:]
        batch = np.concatenate([ctx, frames], axis=1)
        out, self._h, self._c = self.session.run(
            None, {"input": batch, "h": self._h, "c": self._c}
        )
        self._ctx = frames[-1, -CONTEXT:].copy()
        return np.asarray(out, dtype=np.float32).reshape(-1)


@dataclass
class SpeechSegment:
    audio: np.ndarray  # float32, 16 kHz
    t0: float  # secondes sur l'horloge du flux (depuis le dernier reset)
    t1: float
    end: str  # "pause" | "forcee" | "fin"
    speech_s: float  # durée de parole effective


class Segmenter:
    def __init__(
        self,
        vad: SileroVad,
        *,
        threshold: float = 0.5,
        min_silence_s: float = 0.6,
        soft_max_s: float = 7.0,
        hard_max_s: float = 14.0,
        min_speech_s: float = 0.3,
        pre_roll_s: float = 0.25,
        post_roll_s: float = 0.20,
    ):
        self.vad = vad
        self.threshold = threshold
        self.neg_threshold = max(0.1, threshold - 0.15)
        self.min_silence_s = min_silence_s
        self.soft_max_s = soft_max_s
        self.hard_max_s = hard_max_s
        self.min_speech_s = min_speech_s
        self.pre_frames = max(1, int(round(pre_roll_s / FRAME_S)))
        self.post_frames = max(1, int(round(post_roll_s / FRAME_S)))
        self.reset()

    # ------------------------------------------------------------------ état
    def reset(self) -> None:
        self.vad.reset()
        self._rest = np.zeros(0, dtype=np.float32)
        self._pre = deque(maxlen=self.pre_frames)
        self._frames: list = []
        self._probs: list = []
        self._in_speech = False
        self._silence_run = 0
        self._trigger_run = 0
        self._n_frames = 0  # trames traitées depuis le reset
        self._seg_start_frame = 0
        self.last_prob = 0.0
        self.last_rms = 0.0

    @property
    def clock_s(self) -> float:
        return self._n_frames * FRAME_S + len(self._rest) / SAMPLE_RATE

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    @property
    def open_segment_s(self) -> float:
        return len(self._frames) * FRAME_S if self._in_speech else 0.0

    # ------------------------------------------------------------- traitement
    def feed(self, samples: np.ndarray) -> list:
        """Ajoute des échantillons float32 ; renvoie les segments terminés."""
        if samples.size == 0:
            return []
        data = np.concatenate([self._rest, samples]) if self._rest.size else samples
        n = data.size // FRAME
        if n == 0:
            self._rest = data
            return []
        frames = data[: n * FRAME].reshape(n, FRAME)
        self._rest = data[n * FRAME:].copy()
        probs = self.vad.probs(frames)
        self.last_prob = float(probs[-1])
        self.last_rms = float(np.sqrt(np.mean(frames[-1] ** 2)))
        out = []
        for i in range(n):
            seg = self._step(frames[i], float(probs[i]))
            if seg is not None:
                out.append(seg)
        return out

    def _required_silence(self, dur: float) -> float:
        """Silence exigé pour clore un segment, selon sa durée actuelle.

        Segment court : on attend une vraie pause, pour ne pas traduire des
        bribes (« Ask not. ») et parce que chaque appel au moteur de
        reconnaissance a un coût fixe. Segment long : une respiration suffit.
        """
        base = self.min_silence_s
        if dur < 2.5:
            return base * 1.5
        if dur < 5.0:
            return base * 1.15
        if dur < self.soft_max_s:
            return base * 0.8
        if dur < self.soft_max_s + 3.0:
            return min(base, 0.30)
        return min(base, 0.16)

    def _step(self, frame: np.ndarray, p: float):
        self._n_frames += 1
        if not self._in_speech:
            self._pre.append(frame)
            if p >= self.threshold:
                self._trigger_run += 1
            else:
                self._trigger_run = 0
            if self._trigger_run >= 2:
                self._in_speech = True
                self._frames = list(self._pre)
                self._probs = [self.threshold] * len(self._frames)
                self._seg_start_frame = self._n_frames - len(self._frames)
                self._pre.clear()
                self._silence_run = 0
                self._trigger_run = 0
            return None

        self._frames.append(frame)
        self._probs.append(p)
        if p < self.neg_threshold:
            self._silence_run += 1
        elif p >= self.threshold:
            self._silence_run = 0
        dur = len(self._frames) * FRAME_S
        if self._silence_run * FRAME_S >= self._required_silence(dur):
            return self._close("pause")
        if dur >= self.hard_max_s:
            return self._force_cut()
        return None

    def _make(self, frames: list, probs: list, start_frame: int, end: str):
        speech_s = sum(1 for q in probs if q >= self.threshold) * FRAME_S
        if speech_s < self.min_speech_s or not frames:
            return None
        audio = np.concatenate(frames)
        t0 = start_frame * FRAME_S
        return SpeechSegment(
            audio=audio, t0=t0, t1=t0 + len(frames) * FRAME_S, end=end, speech_s=speech_s
        )

    def _close(self, end: str):
        # Retirer le silence final en gardant une courte marge.
        keep = len(self._frames) - max(0, self._silence_run - self.post_frames)
        seg = self._make(self._frames[:keep], self._probs[:keep], self._seg_start_frame, end)
        tail = self._frames[keep:]
        self._in_speech = False
        self._frames, self._probs = [], []
        self._silence_run = 0
        self._pre.clear()
        for f in tail[-self.pre_frames:]:
            self._pre.append(f)
        return seg

    def _force_cut(self):
        n = len(self._probs)
        window = int(4.0 / FRAME_S)
        lo = max(int(1.0 / FRAME_S), n - window)
        probs = np.asarray(self._probs[lo:n], dtype=np.float32)
        # Lissage sur 3 trames : on cherche un creux, pas un point isolé.
        if probs.size >= 3:
            sm = np.convolve(probs, np.ones(3) / 3.0, mode="same")
        else:
            sm = probs
        # À creux équivalent, préférer la coupe la plus tardive.
        best = float(sm.min())
        cand = np.nonzero(sm <= best + 0.05)[0]
        cut = lo + int(cand[-1]) + 1
        cut = max(1, min(cut, n))
        seg = self._make(self._frames[:cut], self._probs[:cut], self._seg_start_frame, "forcee")
        self._frames = self._frames[cut:]
        self._probs = self._probs[cut:]
        self._seg_start_frame += cut
        self._silence_run = 0
        if not self._frames:
            self._in_speech = False
        return seg

    def finish(self):
        """Clôt le segment en cours (arrêt ou pause de la capture)."""
        if not self._in_speech:
            return None
        seg = self._make(self._frames, self._probs, self._seg_start_frame, "fin")
        self._in_speech = False
        self._frames, self._probs = [], []
        self._silence_run = 0
        return seg
