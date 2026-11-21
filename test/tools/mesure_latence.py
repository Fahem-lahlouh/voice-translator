"""Mesure de latence du pipeline actuel, étape par étape (audit).

Alimente le vrai pipeline (vrais moteurs) en temps réel avec un fichier audio,
et simule la file de lecture de l'extension (lecture séquentielle des phrases
françaises, 0,12 s d'écart, accélération et sauts comme dans offscreen.js).

Usage :
  python test/tools/mesure_latence.py AUDIO [--profile prudent] [--threads N]
         [--bruit DB] [--json sortie.json]
"""
import argparse
import json
import struct
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

import numpy as np  # noqa: E402

from vt_server.__main__ import _read_wav_16k  # noqa: E402
from vt_server.config import Config  # noqa: E402
from vt_server.engines import Engines  # noqa: E402
from vt_server.pipeline import Session, Settings  # noqa: E402
from vt_server.textproc import Glossary, parse_glossary  # noqa: E402

GAP_S = 0.12
QUEUE_DROP_AT_S, QUEUE_DROP_TO_S = 14.0, 7.0  # valeurs de offscreen.js


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--profile", default="prudent")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--bruit", type=float, default=None, help="ajoute un bruit de fond à N dB sous la parole")
    ap.add_argument("--musique", type=float, default=None, help="ajoute une musique synthétique à N dB sous la parole")
    ap.add_argument("--duree", type=float, default=0, help="ne garder que les N premières secondes")
    ap.add_argument("--json")
    a = ap.parse_args()

    audio = _read_wav_16k(a.audio)
    if a.duree:
        audio = audio[: int(a.duree * 16000)]
    if a.bruit is not None:
        rng = np.random.default_rng(0)
        rms = float(np.sqrt(np.mean(audio[np.abs(audio) > 0.02] ** 2)))
        noise = rng.standard_normal(audio.size).astype(np.float32)
        noise = np.convolve(noise, np.ones(8) / 8, mode="same")  # bruit coloré, type fond sonore
        noise *= rms * 10 ** (-a.bruit / 20) / (np.sqrt(np.mean(noise**2)) + 1e-9)
        audio = np.clip(audio + noise, -1, 1)

    if a.musique is not None:
        t = np.arange(audio.size) / 16000
        notes = [220.0, 277.18, 329.63, 440.0, 261.63, 329.63, 392.0, 523.25]
        mus = np.zeros_like(audio)
        for k in range(int(t[-1] / 0.5) + 1):  # un accord toutes les 0,5 s, avec attaque
            a0, a1 = int(k * 0.5 * 16000), int((k + 1) * 0.5 * 16000)
            tt = t[a0:a1] - t[a0]
            env = np.exp(-tt * 3)
            base = notes[k % 4: k % 4 + 3]
            mus[a0:a1] = env * sum(np.sin(2 * np.pi * f * tt) for f in base)
        mus += 0.3 * np.sin(2 * np.pi * 55 * t) * (np.sin(2 * np.pi * 2 * t) > 0)  # basse rythmée
        rms = float(np.sqrt(np.mean(audio[np.abs(audio) > 0.02] ** 2)))
        mus *= rms * 10 ** (-a.musique / 20) / (np.sqrt(np.mean(mus**2)) + 1e-9)
        audio = np.clip(audio + mus.astype(np.float32), -1, 1)

    cfg = Config(profile=a.profile, models_dir=str(ROOT / "server/models"), cpu_threads=a.threads).resolved()
    eng = Engines(cfg, download=False)
    eng.start()
    eng.ready.wait(600)
    gl = Glossary(parse_glossary(json.loads((ROOT / "extension/glossaire-defaut.json").read_text())))

    t_start = [0.0]
    closes, events, chunks = {}, [], []

    def now():
        return time.monotonic() - t_start[0]

    def send_json(o):
        if o["type"] == "segment":
            events.append((now(), o))

    def send_bin(d):
        (n,) = struct.unpack_from("<I", d, 0)
        h = json.loads(d[4:4 + n])
        chunks.append((now(), h))

    s = Session(eng, cfg, send_json, send_bin)
    orig_enq = s._enqueue_segment

    def enq(seg):
        closes[round(seg.t0, 2)] = (now(), seg.t1 - seg.t0, seg.end)
        orig_enq(seg)

    s._enqueue_segment = enq
    s.start(1, Settings(voice="siwis", glossary=gl))

    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    step = 1600
    t_start[0] = time.monotonic()
    play_end = 0.0  # simulation de la file de lecture

    def sim_queue_s(t):
        return max(0.0, play_end - t)

    for i in range(0, len(pcm), step):
        target = i / 16000
        d = target - now()
        if d > 0:
            time.sleep(d)
        s.feed(1, pcm[i:i + step].tobytes())
        if i % 8000 == 0:
            s.playback_report(sim_queue_s(now()))
    for _ in range(40):
        time.sleep(0.1)
        s.feed(1, bytes(3200))
    t_end = time.monotonic() + 120
    while time.monotonic() < t_end:
        with s._cv:
            idle = not s._seg_q and not s._tts_q
        if idle and not s._busy_text and not s._busy_tts and not s._carry:
            break
        time.sleep(0.1)
    time.sleep(0.3)
    s.close()

    # Lecture simulée, dans l'ordre d'arrivée.
    rows, skipped = [], 0
    play_end = 0.0
    for t_ready, h in chunks:
        q = max(0.0, play_end - t_ready)
        if q > QUEUE_DROP_AT_S:
            skipped += 1
            continue
        start = max(t_ready, play_end + (GAP_S if play_end else 0))
        play_end = start + h["duration"]
        rows.append({"t0": h["t0"], "t1": h["t1"], "pret": t_ready, "debut_voix": start,
                     "attente_file": start - t_ready, "duree_fr": h["duration"], "texte": h["text"],
                     "rate": h.get("rate"), "tts_ms": h.get("ttsMs")})

    segs = []
    for t_ev, o in events:
        c = closes.get(round(o["t0"], 2))
        segs.append({"t0": o["t0"], "t1": o["t1"], "statut": o["status"],
                     "ferme_a": c[0] if c else None, "fin": c[2] if c else "report",
                     "asr_ms": o.get("asrMs"), "mt_ms": o.get("mtMs"), "pret_texte": t_ev,
                     "en": o.get("en", ""), "fr": o.get("fr", "")})

    # Indicateurs.
    def med(v):
        v = sorted(v)
        return v[len(v) // 2] if v else float("nan")

    seg_dur = [r["t1"] - r["t0"] for r in segs]
    speech_s = sum(seg_dur)
    fr_s = sum(r["duree_fr"] for r in rows)
    lat_fin = [r["debut_voix"] - r["t1"] for r in rows]  # depuis la fin du segment source
    lat_debut = [r["debut_voix"] - r["t0"] for r in rows]  # depuis le début de la parole
    wait_close = [r["ferme_a"] - r["t1"] for r in segs if r["ferme_a"] is not None]
    wait_asr = []
    for r in segs:
        if r["ferme_a"] is not None and r["asr_ms"] is not None:
            asr_start = r["pret_texte"] - (r["asr_ms"] + (r["mt_ms"] or 0)) / 1000
            wait_asr.append(max(0.0, asr_start - r["ferme_a"]))
    res = {
        "fichier": Path(a.audio).name, "profil": a.profile, "fils": cfg.cpu_threads, "bruit_db": a.bruit,
        "segments": len(segs), "duree_segment_med": med(seg_dur), "duree_segment_max": max(seg_dur, default=0),
        "fins": {k: sum(1 for r in segs if r["fin"] == k) for k in ("pause", "forcee", "fin", "report")},
        "attente_fermeture_med": med(wait_close),
        "attente_file_asr_med": med(wait_asr), "attente_file_asr_max": max(wait_asr, default=0),
        "asr_ms_med": med([r["asr_ms"] for r in segs if r["asr_ms"]]),
        "mt_ms_med": med([r["mt_ms"] for r in segs if r["mt_ms"]]),
        "tts_ms_med": med([r["tts_ms"] for r in rows if r["tts_ms"]]),
        "attente_lecture_med": med([r["attente_file"] for r in rows]),
        "attente_lecture_max": max([r["attente_file"] for r in rows], default=0),
        "ratio_duree_fr_en": fr_s / speech_s if speech_s else 0,
        "latence_depuis_fin_med": med(lat_fin), "latence_depuis_fin_max": max(lat_fin, default=0),
        "latence_depuis_debut_med": med(lat_debut), "latence_depuis_debut_max": max(lat_debut, default=0),
        "premiere_voix": rows[0]["debut_voix"] if rows else None,
        "premiere_parole": segs[0]["t0"] if segs else None,
        "derive_finale": (rows[-1]["debut_voix"] - rows[-1]["t0"]) if rows else None,
        "phrases_sautees": skipped, "abandonnes_serveur": s.stats["abandonnes"],
        "incertains": s.stats["incertains"],
    }
    print(json.dumps(res, ensure_ascii=False, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps({"resume": res, "segments": segs, "lecture": rows},
                                           ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
