// Lecture synchronisée des phrases déjà traduites (doublage « façon film »).
//
// Quand une phrase est déjà connue pour un moment de la vidéo, sa voix est
// préparée quelques secondes à l'avance puis lancée exactement quand
// l'anglais commence, au lieu d'être retraduite en direct avec du retard.
// Ce module contient la logique de décision (fonctions pures, testées) ;
// offscreen.js s'occupe de l'audio et des échanges avec le serveur.

export const LOOKAHEAD_S = 6; // préparer la voix 6 s (temps vidéo) à l'avance
export const LATE_S = 0.6; // un démarrage en retard de moins de 0,6 s reste acceptable
export const START_AHEAD_S = 0.3; // programmer le démarrage audio 0,3 s à l'avance
// Une phrase enregistrée commence un peu avant la parole (marge de 0,25 s pour
// ne pas couper le premier mot) et le son d'origine entendu passe par la
// capture : mesuré dans Chrome, le français partait 0,14 s trop tôt sans ce
// décalage (médiane sur 10 phrases).
export const START_OFFSET_S = 0.15;

// Durée maximale (en secondes réelles) pour la voix d'une phrase : jusqu'au
// début de la phrase suivante, avec au plus 1,5 s de débordement sur un blanc.
export function maxDuration(segs, i, videoRate = 1) {
  const s = segs[i];
  const next = segs[i + 1];
  const limit = next ? Math.min(next.start, s.end + 1.5) : s.end + 1.5;
  const rate = videoRate > 0 ? videoRate : 1;
  return Math.max(0.5, (limit - s.start) / rate - 0.08);
}

// Clé de préparation : une voix préparée pour une vitesse vidéo donnée.
export function prepKey(seg, videoRate) {
  return `${seg.id}@${Math.round((videoRate || 1) * 20) / 20}`;
}

// Index des phrases à préparer maintenant.
export function toPrepare(segs, mediaNow, prepared, videoRate = 1, lookahead = LOOKAHEAD_S) {
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.start < mediaNow - LATE_S) continue;
    if (s.start > mediaNow + lookahead * Math.max(1, videoRate)) break;
    if (!prepared.has(prepKey(s, videoRate))) out.push(i);
  }
  return out;
}

// Phrase à lancer maintenant : renvoie { index, delayS } où delayS est le
// délai réel avant le début (négatif = déjà en retard), ou null.
export function dueToStart(segs, mediaNow, started, videoRate = 1, offset = 0) {
  const rate = videoRate > 0 ? videoRate : 1;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (started.has(s.id)) continue;
    const delayS = (s.start + offset - mediaNow) / rate;
    if (delayS > START_AHEAD_S) return null; // liste triée : rien d'autre avant
    if (delayS >= -LATE_S / rate) return { index: i, delayS };
  }
  return null;
}

// Une phrase en direct est-elle déjà couverte par une phrase jouée (ou sur
// le point de l'être) par la lecture synchronisée ? Évite la double voix.
export function coveredBySync(range, segs, active) {
  if (!range) return false;
  for (const s of segs) {
    if (!active.has(s.id)) continue;
    const o = Math.min(range.end, s.end) - Math.max(range.start, s.start);
    if (o > 0.4 * Math.max(0.3, range.end - range.start)) return true;
  }
  return false;
}

// Insère une phrase dans la liste triée (sans doublon d'identifiant).
export function insertSorted(segs, seg) {
  if (segs.some((s) => s.id === seg.id)) return segs;
  const out = [...segs, seg];
  out.sort((a, b) => a.start - b.start);
  return out;
}
