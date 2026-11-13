"""Génère l'extrait de test « formation TIBCO » (anglais synthétique).

L'extrait est produit avec la voix Piper en_US « ljspeech » (jeu de données
LJ Speech, domaine public). Il sert à tester le vocabulaire technique ; les
tests de reconnaissance sur voix humaine utilisent jfk_16k.wav et
canterville_90s.ogg.

Usage (depuis la racine du dépôt, environnement du serveur activé) :
    python test/tools/make_tibco_demo.py
"""

import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from vt_server.models import _download_file  # noqa: E402

REV = "2f358b6a560e3a913ebf509b2f3344f20b367f94"
BASE = f"https://huggingface.co/rhasspy/piper-voices/resolve/{REV}/en/en_US/ljspeech/medium/"
FILES = {"en_US-ljspeech-medium.onnx": 63531379, "en_US-ljspeech-medium.onnx.json": 4972}

# (texte, pause en secondes après la phrase)
SCRIPT = [
    ("Welcome back. In this lecture, we are going to create our first process in TIBCO BusinessWorks.", 0.9),
    ("Open TIBCO Business Studio, and in the Project Explorer, right-click on the package and select New, then BusinessWorks Process.", 0.8),
    ("Give it a name, for example GetCustomer, and click Finish.", 1.2),
    ("Now, from the palette on the right, drag the HTTP Receiver onto the canvas. This is our process starter.", 0.7),
    ("Every time a request comes in, the engine creates a new job and runs this process.", 1.0),
    ("Next, we need a JDBC Query activity to read the customer from the database.", 0.6),
    ("It uses a shared resource called JDBC Connection, which you configure in the module properties.", 1.5),
    ("In the input tab, map the customer ID from the request to the query parameter.", 0.7),
    ("If the query fails, the activity throws a JDBC exception, so let's add a catch block to handle the error.", 0.9),
    ("Finally, save the process, build the EAR file, and deploy it to the AppNode.", 0.8),
    ("In the next lecture, we will test the service and look at the log file.", 1.0),
]


def main() -> None:
    from piper import PiperVoice, SynthesisConfig

    voice_dir = ROOT / "server" / "models" / "test" / "en_US-ljspeech-medium"
    voice_dir.mkdir(parents=True, exist_ok=True)
    for name, size in FILES.items():
        dest = voice_dir / name
        if not dest.exists() or dest.stat().st_size != size:
            print("Téléchargement de", name)
            _download_file(BASE + name, dest, size, lambda n: None)
    voice = PiperVoice.load(str(voice_dir / "en_US-ljspeech-medium.onnx"))
    out_wav = ROOT / "test" / "audio" / "tibco_demo_en.wav"
    sr = voice.config.sample_rate
    with wave.open(str(out_wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(int(sr * 0.5) * 2))
        for text, pause in SCRIPT:
            for chunk in voice.synthesize(text, SynthesisConfig(length_scale=1.0)):
                w.writeframes(chunk.audio_int16_bytes)
            w.writeframes(bytes(int(sr * pause) * 2))
    out_ogg = out_wav.with_suffix(".ogg")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(out_wav),
                    "-c:a", "libvorbis", "-q:a", "3", str(out_ogg)], check=True)
    out_wav.unlink()
    (out_wav.parent / "tibco_demo_en.txt").write_text(
        "\n".join(t for t, _p in SCRIPT) + "\n", encoding="utf-8")
    print("Écrit :", out_ogg)


if __name__ == "__main__":
    main()
