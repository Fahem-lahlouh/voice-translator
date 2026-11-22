"""Mesure l'écart réel entre le début de chaque phrase anglaise (canal
gauche) et celui de la voix française (canal droit) dans un enregistrement
stéréo de la sortie de l'extension. Sortie : JSON."""
import json
import sys
import wave

import numpy as np


def onsets(x, sr, frame=0.02, rel=0.08, min_gap=0.25):
    n = int(sr * frame)
    e = np.sqrt(np.mean(x[: len(x) // n * n].reshape(-1, n) ** 2, axis=1))
    thr = max(1e-4, rel * np.percentile(e, 95))
    out, quiet = [], int(min_gap / frame)
    run = quiet
    for i, v in enumerate(e):
        if v > thr:
            if run >= quiet:
                out.append(i * frame)
            run = 0
        else:
            run += 1
    return out


def main() -> int:
    with wave.open(sys.argv[1]) as w:
        sr = w.getframerate()
        a = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    a = a.reshape(-1, 2)
    en, fr = onsets(a[:, 0], sr), onsets(a[:, 1], sr)
    # Un début français est apparié au début anglais le plus proche à ± 0,6 s.
    # Les autres (pause après une virgule à l'intérieur d'une phrase
    # française, par exemple) sont comptés à part, pour rester visibles.
    diffs, unmatched = [], []
    for t in fr:
        near = [e for e in en if abs(t - e) <= 0.6]
        if near:
            e = min(near, key=lambda e: abs(t - e))
            diffs.append(round(t - e, 3))
        else:
            unmatched.append(round(t, 2))
    ad = sorted(abs(d) for d in diffs)
    print(json.dumps({
        "phrases_fr": len(fr), "appariees": len(diffs), "ecarts": diffs, "non_appariees": unmatched,
        "median_abs": ad[len(ad) // 2] if ad else None, "max_abs": ad[-1] if ad else None,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
