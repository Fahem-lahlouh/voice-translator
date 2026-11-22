// « Préparer le doublage » : la vidéo est lue en accéléré, son coupé, pour
// traduire et enregistrer toutes ses phrases à l'avance. Ensuite, la lecture
// synchronisée les joue au bon moment dès le premier visionnage.
//
// Fonctions pures (testées) : cadence de lecture selon la charge du PC et
// saut des passages déjà traduits.

export const PREP_RATE = 1.5; // mesuré : reconnaissance fiable à × 1,5 (94–99 % d'accord avec × 1)

// Vitesse de lecture selon le retard de reconnaissance du serveur (secondes
// d'audio en attente). Un PC lent ralentit la préparation au lieu de perdre
// des phrases ; au-delà de 6 s d'attente, la vidéo est mise en pause.
export function paceFor(backlogS, maxRate = PREP_RATE) {
  if (backlogS > 6) return 0; // pause
  if (backlogS > 4) return 1;
  if (backlogS > 2) return Math.min(maxRate, 1.25);
  return maxRate;
}

// Intervalles couverts par des phrases connues (blancs de moins de 3 s réunis).
export function coveredFrom(segs, gap = 3) {
  const out = [];
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.start <= last[1] + gap) last[1] = Math.max(last[1], s.end);
    else out.push([s.start, s.end]);
  }
  return out;
}

// Si la lecture entre dans un long passage déjà traduit, position où sauter
// (une seconde avant sa fin, pour ne pas couper la phrase suivante) ; sinon null.
export function skipTarget(covered, mediaNow, minGain = 4) {
  for (const [a, b] of covered) {
    if (mediaNow >= a && mediaNow < b && b - mediaNow > minGain) return Math.max(mediaNow, b - 1);
  }
  return null;
}

// Fin de vidéo atteinte ?
export function reachedEnd(mediaNow, duration, paused) {
  if (!Number.isFinite(duration) || duration <= 0) return false;
  return mediaNow >= duration - 0.4 || (paused && mediaNow >= duration - 1.5);
}

// Temps réel restant estimé (s).
export function remainingS(mediaNow, duration, rate) {
  if (!Number.isFinite(duration) || duration <= 0 || !(rate > 0)) return null;
  return Math.max(0, (duration - mediaNow) / rate);
}
