"""Point d'entrée : python -m vt_server [options]"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import platform
import sys
import time
import wave

from . import __version__, models
from .config import PROFILES, load_config
from .engines import VOICES


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m vt_server",
        description="Serveur local de doublage vocal anglais → français (100 % local).",
    )
    p.add_argument("--config", help="fichier de configuration JSON (défaut : server/config.json)")
    p.add_argument("--profile", choices=list(PROFILES), help="profil matériel")
    p.add_argument("--port", type=int, help="port d'écoute sur 127.0.0.1")
    p.add_argument("--models-dir", help="dossier des modèles")
    p.add_argument("--device", choices=["cpu", "cuda", "auto"], help="processeur de calcul")
    p.add_argument("--no-download", action="store_true",
                   help="ne jamais télécharger de modèle au démarrage")
    p.add_argument("--debug-dump-dir", help="(tests) enregistrer la voix générée dans ce dossier")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--list-models", action="store_true", help="afficher le catalogue et quitter")
    g.add_argument("--download-only", action="store_true",
                   help="télécharger les modèles du profil puis quitter")
    g.add_argument("--self-test", metavar="WAV",
                   help="tester la chaîne complète sur un fichier WAV anglais, sans navigateur")
    g.add_argument("--bench", action="store_true",
                   help="mesurer les performances de ce PC et recommander un profil")
    p.add_argument("--out", help="avec --self-test : fichier WAV français à écrire")
    p.add_argument("--glossary", help="avec --self-test : glossaire JSON "
                   "(défaut : extension/glossaire-defaut.json)")
    p.add_argument("--no-glossary", action="store_true", help="avec --self-test : sans glossaire")
    p.add_argument("--all-voices", action="store_true",
                   help="avec --download-only : télécharger toutes les voix françaises")
    p.add_argument("--version", action="version", version=f"vt_server {__version__}")
    return p


def _console_progress():
    last = {"t": 0.0}

    def cb(key, done, total):
        now = time.monotonic()
        if now - last["t"] < 0.5 and done != total:
            return
        last["t"] = now
        pct = 100 * done / max(1, total)
        sys.stdout.write(f"\r  {key:28s} {pct:5.1f} %  ({models.human_size(done)} / "
                         f"{models.human_size(total)})   ")
        if done == total:
            sys.stdout.write("\n")
        sys.stdout.flush()

    return cb


def cmd_list(cfg) -> int:
    print(f"Dossier des modèles : {cfg.models_dir}\n")
    for key, spec in models.CATALOG.items():
        state = "installé" if models.is_installed(cfg.models_dir, spec) else "absent"
        print(f"{key:26s} {models.human_size(spec.total_size):>8s}  [{state}]")
        print(f"    {spec.label}\n    Licence : {spec.license}\n    Source  : {spec.source_note}")
    print("\nProfils :")
    for name, prof in PROFILES.items():
        keys = models.required_keys(prof["asr_model"], prof["mt_model"], ["siwis"])
        size = sum(models.CATALOG[k].total_size for k in keys)
        print(f"  {name:10s} {prof['asr_model']:9s} + {prof['mt_model']:22s} "
              f"≈ {models.human_size(size)} — {prof['description']}")
    return 0


def cmd_download(cfg, all_voices: bool) -> int:
    voices = sorted({VOICES[v][0].split(":", 1)[1] for v in VOICES}) if all_voices \
        else [VOICES.get(cfg.default_voice, VOICES["siwis"])[0].split(":", 1)[1]]
    keys = models.required_keys(cfg.asr_model, cfg.mt_model, voices)
    total = sum(models.CATALOG[k].total_size for k in keys
                if not models.is_installed(cfg.models_dir, models.CATALOG[k]))
    print(f"Profil « {cfg.profile} » — modèles requis : {', '.join(keys)}")
    if total == 0:
        print("Tous les modèles sont déjà installés.")
        return 0
    print(f"Téléchargement nécessaire : {models.human_size(total)} (depuis huggingface.co)")
    try:
        for k in keys:
            models.ensure_model(cfg.models_dir, k, _console_progress())
    except models.DownloadError as exc:
        print(f"\nERREUR : {exc}", file=sys.stderr)
        return 2
    print("Modèles installés et vérifiés (SHA-256).")
    return 0


def _read_wav_16k(path: str):
    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit("Le fichier doit être un WAV PCM 16 bits.")
        sr, ch = w.getframerate(), w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    if sr != 16000:  # rééchantillonnage linéaire, suffisant pour un test
        n = int(len(data) * 16000 / sr)
        data = np.interp(np.linspace(0, len(data) - 1, n), np.arange(len(data)), data).astype(np.float32)
    return data


def cmd_self_test(cfg, wav_path: str, out_path: str | None, glossary_path: str | None) -> int:
    """Chaîne complète hors navigateur, avec les vrais moteurs."""
    import json as _json

    import numpy as np

    from .engines import Engines
    from .pipeline import Session, Settings
    from .textproc import Glossary, parse_glossary

    glossary = Glossary([])
    if glossary_path:
        with open(glossary_path, encoding="utf-8") as fh:
            glossary = Glossary(parse_glossary(_json.load(fh)))
        print(f"Glossaire : {len(glossary.entries)} entrées ({glossary_path})")

    audio = _read_wav_16k(wav_path)
    dur = len(audio) / 16000
    print(f"Fichier : {wav_path} ({dur:.1f} s) — profil « {cfg.profile} »")
    engines = Engines(cfg, download=True)
    engines.start()
    engines.ready.wait(timeout=1800)
    if not engines.ready.is_set():
        print(f"ERREUR : moteurs non chargés : {engines.error}", file=sys.stderr)
        return 2
    events, chunks = [], []

    def send_json(obj):
        if obj["type"] in ("segment", "error"):
            events.append((time.monotonic(), obj))

    def send_binary(data):
        import struct

        (n,) = struct.unpack_from("<I", data, 0)
        chunks.append((time.monotonic(), _json.loads(data[4:4 + n]), data[4 + n:]))

    sess = Session(engines, cfg, send_json, send_binary)
    sess.start(1, Settings(voice=cfg.default_voice, glossary=glossary))
    t_start = time.monotonic()
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    step = 1600  # 100 ms, au rythme du temps réel
    for i in range(0, len(pcm), step):
        target = t_start + i / 16000
        delay = target - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        sess.feed(1, pcm[i:i + step].tobytes())
    # 2 s de silence pour clore le dernier segment.
    for _ in range(20):
        time.sleep(0.1)
        sess.feed(1, bytes(3200))
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        with sess._cv:
            idle = not sess._seg_q and not sess._tts_q
        if idle and not sess._busy_text and not sess._busy_tts:
            break
        time.sleep(0.1)
    time.sleep(0.2)
    sess.close()
    print()
    for _t, ev in events:
        if ev["type"] == "segment":
            print(f"[{ev['t0']:6.1f}–{ev['t1']:6.1f} s] ({ev['status']}) EN : {ev.get('en', '')}")
            if ev.get("fr"):
                print(f"{'':18s}FR : {ev['fr']}")
            if ev.get("reason"):
                print(f"{'':18s}-> {ev['reason']}")
        else:
            print("ERREUR :", ev["message"])
    if not chunks:
        print("\nAucune voix générée (aucune parole reconnue ?).")
        return 1
    print()
    for t, h, _pcm in chunks:
        ready = t - t_start
        print(f"Voix prête à t={ready:5.1f} s pour la parole de {h['t0']:.1f}–{h['t1']:.1f} s "
              f"(retard après la fin de la phrase : {ready - h['t1']:.1f} s) : {h['text'][:70]}")
    st = sess.stats
    proc = st["asr_s"] + st["mt_s"] + st["tts_s"]
    print(f"\nTemps de calcul : ASR {st['asr_s']:.2f} s, traduction {st['mt_s']:.2f} s, "
          f"voix {st['tts_s']:.2f} s pour {st['audio_s']:.1f} s de parole "
          f"(charge = {proc / max(0.01, st['audio_s']):.2f} × temps réel)")
    if out_path:
        sr = chunks[0][1]["sampleRate"]
        with wave.open(out_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            for _t, _h, data in chunks:
                w.writeframes(data)
                w.writeframes(bytes(int(sr * 0.25) * 2))
        print(f"Voix française enregistrée dans : {out_path}")
    return 0


def cmd_bench(cfg) -> int:
    """Mesure le temps de calcul réel de ce PC pour chaque profil installé."""
    import numpy as np

    from .config import Config
    from .engines import Recognizer, Speaker, Translator
    from .textproc import Glossary

    sample = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
                          "test", "audio", "jfk_16k.wav")
    if not os.path.exists(sample):
        print(f"Extrait de test introuvable : {sample}", file=sys.stderr)
        return 2
    audio = _read_wav_16k(sample)
    dur = len(audio) / 16000
    print(f"Machine : {platform.platform()} — {os.cpu_count()} cœurs logiques — "
          f"Python {platform.python_version()}")
    print(f"Extrait : {dur:.1f} s d'anglais. Chaque mesure est faite deux fois (on garde la 2e).\n")
    results = {}
    for name, prof in PROFILES.items():
        c = Config(profile=name, models_dir=cfg.models_dir, device=cfg.device).resolved()
        keys = models.required_keys(c.asr_model, c.mt_model, ["siwis"])
        if not all(models.is_installed(c.models_dir, models.CATALOG[k]) for k in keys):
            print(f"{name:10s} : modèles non installés (ignoré)")
            continue
        rec = Recognizer(models.model_dir(c.models_dir, models.CATALOG[keys[0]]), c)
        tr = Translator(models.model_dir(c.models_dir, models.CATALOG[keys[1]]), c)
        spk = Speaker(c.models_dir)
        spk.preload("siwis")
        for _ in range(2):
            t = time.perf_counter()
            res = rec.transcribe(audio)
            t_asr = time.perf_counter() - t
            t = time.perf_counter()
            fr = tr.translate(res.text, Glossary([]))
            t_mt = time.perf_counter() - t
            t = time.perf_counter()
            sp = spk.synthesize(fr.text, "siwis")
            t_tts = time.perf_counter() - t
        load = (t_asr + t_mt + t_tts) / dur
        results[name] = load
        print(f"{name:10s} : ASR {t_asr:.2f} s, traduction {t_mt:.2f} s, voix {t_tts:.2f} s "
              f"(voix de {sp.duration:.1f} s) → charge {load:.2f} × temps réel")
        del rec, tr, spk
    if not results:
        print("\nAucun profil mesurable : lancez d'abord l'installation.")
        return 1
    # Une charge de 0,5 laisse une marge pour la lecture vidéo et les pics.
    ok = [n for n, v in results.items() if v <= 0.5]
    best = ok[-1] if ok else None
    print()
    if best:
        print(f"Profil recommandé : « {best} » (charge mesurée {results[best]:.2f}, seuil 0,50).")
    else:
        print("Aucun profil ne tient sous le seuil de 0,50 × temps réel sur ce PC.\n"
              "Utilisez « prudent » avec la pause automatique de la vidéo, ou le modèle tiny.en "
              "(\"asr_model\": \"tiny.en\" dans server/config.json).")
    return 0


def main(argv=None) -> int:
    args = _parser().parse_args(argv)
    try:
        cfg = load_config(args.config, {
            "profile": args.profile, "port": args.port, "models_dir": args.models_dir,
            "device": args.device, "debug_dump_dir": args.debug_dump_dir,
        })
    except ValueError as exc:
        print(f"Configuration invalide : {exc}", file=sys.stderr)
        return 2
    logging.basicConfig(
        level=getattr(logging, cfg.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s : %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("faster_whisper").setLevel(logging.WARNING)
    if args.list_models:
        return cmd_list(cfg)
    if args.download_only:
        return cmd_download(cfg, args.all_voices)
    if args.self_test:
        default_gl = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__)))), "extension", "glossaire-defaut.json")
        gl = None if args.no_glossary else (args.glossary or (
            default_gl if os.path.exists(default_gl) else None))
        return cmd_self_test(cfg, args.self_test, args.out, gl)
    if args.bench:
        return cmd_bench(cfg)

    from .engines import Engines
    from .server import LocalServer

    print(f"Voice Translator — serveur local {__version__}")
    print(f"  Profil : {cfg.profile} (ASR {cfg.asr_model}, traduction {cfg.mt_model}, "
          f"{cfg.cpu_threads} fils de calcul, {cfg.device})")
    print(f"  Écoute : ws://{cfg.host}:{cfg.port}/ws — boucle locale uniquement")
    print("  Laissez cette fenêtre ouverte pendant la formation. Ctrl+C pour arrêter.\n")
    engines = Engines(cfg, download=not args.no_download)
    engines.start()
    server = LocalServer(cfg, engines)
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        print("\nServeur arrêté.")
    except OSError as exc:
        print(f"\nImpossible de démarrer le serveur sur le port {cfg.port} : {exc}\n"
              "Un autre programme (ou une autre fenêtre du serveur) utilise peut-être ce port.",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
