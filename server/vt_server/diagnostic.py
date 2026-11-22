"""Vérification complète d'un PC, en une commande (scripts\\verifier-pc.bat).

Enchaîne : caractéristiques du PC, bibliothèques, modèles, port local, tests
unitaires, chaîne complète sur un extrait réel, mesure des profils et, si un
modèle de résumé est installé, durée d'un résumé. Tout est affiché et écrit
dans un rapport texte à transmettre.

Le rapport ne contient ni nom d'utilisateur ni chemin personnel : les
chemins sont remplacés par « ~ » ou par un chemin relatif au projet.
"""

from __future__ import annotations

import contextlib
import ctypes
import io
import json
import logging
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
import unittest
from importlib import metadata
from pathlib import Path

from . import __version__, models

ROOT = Path(__file__).resolve().parents[2]
PACKAGES = ["faster-whisper", "ctranslate2", "sentencepiece", "piper-tts", "onnxruntime",
            "websockets", "numpy", "av", "tokenizers"]


def _anonymize(text: str) -> str:
    out = text.replace(str(ROOT), "<projet>")
    home = os.path.expanduser("~")
    if home and home not in ("~", "/", "\\"):
        out = out.replace(home, "~")
    user = os.environ.get("USERNAME") or os.environ.get("USER")
    if user and len(user) >= 3:
        out = out.replace(user, "<utilisateur>")
    return out


class _Tee(io.TextIOBase):
    """Écrit à la fois à l'écran et dans le rapport (anonymisé)."""

    def __init__(self, screen, report):
        self.screen, self.report = screen, report

    def write(self, s):
        s = _anonymize(s)
        try:
            self.screen.write(s)
        except UnicodeEncodeError:  # console Windows sans UTF-8
            self.screen.write(s.encode("ascii", "replace").decode())
        self.report.write(s)
        self.report.flush()  # rapport partiel utilisable même en cas d'arrêt brutal
        return len(s)

    def flush(self):
        self.screen.flush()
        self.report.flush()


def _title(t: str) -> None:
    print(f"\n{'=' * 64}\n  {t}\n{'=' * 64}")


def _ram_gb() -> float | None:
    try:
        if sys.platform == "win32":
            class MEM(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            m = MEM()
            m.dwLength = ctypes.sizeof(MEM)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return m.ullTotalPhys / 1e9
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9
    except Exception:
        return None


def _windows_query(cmd: str) -> str:
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True,
                           text=True, timeout=20)
        return " / ".join(x.strip() for x in r.stdout.splitlines() if x.strip()) or "?"
    except Exception:
        return "?"


def machine() -> dict:
    info = {
        "systeme": platform.platform(),
        "processeur": platform.processor() or "?",
        "coeurs_logiques": os.cpu_count(),
        "memoire_go": _ram_gb(),
        "disque_libre_go": shutil.disk_usage(ROOT).free / 1e9,
        "python": platform.python_version(),
        "carte_graphique": "?",
    }
    if sys.platform == "win32":
        info["processeur"] = _windows_query("(Get-CimInstance Win32_Processor).Name")
        info["coeurs_physiques"] = _windows_query("(Get-CimInstance Win32_Processor).NumberOfCores")
        info["carte_graphique"] = _windows_query("(Get-CimInstance Win32_VideoController).Name")
    return info


def _port_state(port: int) -> str:
    with socket.socket() as s:
        s.settimeout(0.5)
        busy = s.connect_ex(("127.0.0.1", port)) == 0
    return ("occupé (serveur déjà démarré ? fermez sa fenêtre pour une mesure fiable)"
            if busy else "libre")


def _unit_tests() -> bool:
    suite = unittest.defaultTestLoader.discover(str(ROOT / "server" / "tests"), top_level_dir=str(ROOT / "server"))
    buf = io.StringIO()
    res = unittest.TextTestRunner(stream=buf, verbosity=1).run(suite)
    print(f"{res.testsRun} tests, {len(res.failures)} échec(s), {len(res.errors)} erreur(s)")
    if not res.wasSuccessful():
        print(buf.getvalue()[-4000:])
    return res.wasSuccessful()


def _summary_bench(cfg) -> bool | None:
    """Durée d'un résumé de 10 min de vidéo ; None si aucun modèle installé."""
    from .summarizer import LLM_MODELS, Summarizer

    data = ROOT / "test" / "js" / "donnees" / "canterville_10min.json"
    s = Summarizer(cfg.models_dir, threads=max(1, cfg.cpu_threads))
    installed = [m for m in s.status() if m["installed"]]
    if not installed:
        print("Aucun modèle de résumé téléchargé : mesure ignorée.\n"
              "(Il se télécharge depuis « Ma bibliothèque » → Résumé → « Générer le résumé ».)")
        return None
    segs = json.loads(data.read_text(encoding="utf-8"))
    ok = False
    for m in installed:
        assert m["id"] in LLM_MODELS
        t = time.perf_counter()
        s._ensure_loaded(m["id"])
        load = time.perf_counter() - t
        t = time.perf_counter()
        r = s.summarize(segs, "auto", m["id"], False, lambda *_: None)
        gen = time.perf_counter() - t
        print(f"{m['label']} : chargement {load:.1f} s, résumé de 10 min de vidéo en {gen:.0f} s "
              f"({len(r['points'])} points)")
        print(f"  Début du résumé : {r['court'][:200]}")
        ok = True
        s._gen = None
        s._loaded = None
    return ok


def run(cfg, report_path: str, with_summary: bool = True) -> int:
    report = open(report_path, "w", encoding="utf-8")
    tee = _Tee(sys.stdout, report)
    ok = {}
    # Les messages du journal (avertissements, erreurs) vont aussi au rapport.
    root = logging.getLogger()
    saved = list(root.handlers)
    handler = logging.StreamHandler(tee)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s : %(message)s", "%H:%M:%S"))
    root.handlers = [handler]
    try:
        with contextlib.redirect_stdout(tee), contextlib.redirect_stderr(tee):
            ok = _run_steps(cfg, with_summary)
    finally:
        root.handlers = saved
        report.close()
    print(f"\nRapport enregistré : {_anonymize(str(Path(report_path).resolve()))}")
    return 0 if all(ok.values()) else 1


def _run_steps(cfg, with_summary: bool) -> dict:
    from .__main__ import cmd_bench, cmd_self_test

    ok = {}
    print(f"Rapport de vérification — doublage vocal local {__version__} — "
          f"{time.strftime('%Y-%m-%d %H:%M')}")

    _title("1. Ce PC")
    for k, v in machine().items():
        print(f"  {k:16s} : {f'{v:.1f}' if isinstance(v, float) else v}")

    _title("2. Bibliothèques et modèles")
    for p in PACKAGES:
        try:
            print(f"  {p:16s} {metadata.version(p)}")
        except metadata.PackageNotFoundError:
            print(f"  {p:16s} ABSENTE")
    print(f"  profil configuré : {cfg.profile} (ASR {cfg.asr_model}, traduction {cfg.mt_model}, "
          f"{cfg.cpu_threads} fils)")
    for key, spec in models.CATALOG.items():
        if models.is_installed(cfg.models_dir, spec):
            print(f"  installé : {key}")
    print(f"  port {cfg.port} : {_port_state(cfg.port)}")

    _title("3. Tests automatiques")
    try:
        ok["tests"] = _unit_tests()
    except Exception as exc:
        print(f"Impossible de lancer les tests : {exc!r}")
        ok["tests"] = False

    _title("4. Chaîne complète sur un extrait réel (anglais → français → voix)")
    out = ROOT / "test" / "out" / "voix-francaise.wav"
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        ok["chaine"] = cmd_self_test(cfg, str(ROOT / "test" / "audio" / "tibco_demo_en.ogg"), str(out),
                                     str(ROOT / "extension" / "glossaire-defaut.json")) == 0
    except Exception as exc:
        print(f"Échec : {exc!r}")
        ok["chaine"] = False

    _title("5. Vitesse de ce PC, profil par profil")
    try:
        ok["mesure"] = cmd_bench(cfg) == 0
    except Exception as exc:
        print(f"Échec : {exc!r}")
        ok["mesure"] = False

    if with_summary:
        _title("6. Résumé par IA (si le modèle est téléchargé)")
        try:
            res = _summary_bench(cfg)
            if res is not None:
                ok["resume"] = res
        except Exception as exc:
            print(f"Échec : {exc!r}")
            ok["resume"] = False

    _title("Bilan")
    for k, v in ok.items():
        print(f"  {k:8s} : {'OK' if v else 'ÉCHEC'}")
    print("\nÉcoutez test\\out\\voix-francaise.wav pour juger la voix française.")
    return ok
