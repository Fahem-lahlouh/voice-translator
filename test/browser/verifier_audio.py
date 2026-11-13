"""Vérifie, indépendamment de l'extension, qu'un fichier audio contient du
français intelligible, en le re-transcrivant avec le modèle Whisper
multilingue. Sortie : JSON {language, probability, text}."""
import json
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "server"))
from faster_whisper import WhisperModel  # noqa: E402

MODEL = Path(__file__).resolve().parents[2] / "server" / "models" / "asr" / "small"


def main() -> int:
    with wave.open(sys.argv[1], "rb") as w:
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    m = WhisperModel(str(MODEL), device="cpu", compute_type="int8", cpu_threads=4)
    segments, info = m.transcribe(audio, beam_size=2, vad_filter=True)
    text = " ".join(s.text.strip() for s in segments)
    print(json.dumps({
        "language": info.language,
        "probability": round(info.language_probability, 3),
        "text": text,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
