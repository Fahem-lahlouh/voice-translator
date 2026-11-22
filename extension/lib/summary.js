// Résumés côté extension (fonctions pures, testées).
//
// 1. Résumé express par extraits : il ne contient que des phrases réellement
//    prononcées dans la vidéo, choisies pour leur représentativité. Instantané,
//    sans téléchargement, et sans risque d'invention.
// 2. Vérification d'un résumé produit par l'IA : chaque point est relié au
//    passage de la transcription qui l'appuie, ou signalé s'il n'en a pas.

const STOP = new Set((
  'le la les un une des du de d l au aux et ou mais donc or ni car que qui quoi dont ou ce cet cette ces '
  + 'son sa ses mon ma mes ton ta tes notre nos votre vos leur leurs je tu il elle on nous vous ils elles me te '
  + 'se lui y en ne pas plus moins tres tout tous toute toutes est sont etait ete etre avoir a ont avait fait '
  + 'faire peut pour par sur sous dans avec sans entre comme si alors aussi bien encore deja ici la cela ca '
  + 'c j n s qu m t quand comment pourquoi tres puis ensuite donc meme autre autres chaque quelque quelques '
  + 'vers chez apres avant depuis pendant oui non voici voila nous allons va vais vont faut tres beaucoup '
  + 'the a an and or of to in on at for is are was were be been it this that with as by from we you they '
  + 'he she i our your their his her its so then now well just like going get got do does did not no yes'
).split(' '));

export function normalize(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const HONORIFICS = new Set(['I', 'OK', 'Mr', 'Mrs', 'Ms', 'Dr', 'Sir', 'Lord', 'Lady', 'Miss', 'Madam',
  'American', 'English', 'British', 'French', 'Yes', 'No', 'Oh', 'Well']);

export function contentWords(text) {
  return (normalize(text).match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w));
}

// Termes importants : sigles et noms propres (depuis l'anglais) + mots
// fréquents (depuis le français).
export function keyTerms(segs, limit = 12) {
  const names = new Map();
  for (const s of segs) {
    const words = String(s.en || '').split(/\s+/);
    words.forEach((w, i) => {
      const clean = w.replace(/^[^\w]+|[^\w.+#-]+$/g, '');
      const isAcronym = /^[A-Z][A-Z0-9]{1,6}s?$/.test(clean);
      const isName = /^[A-Z][a-z]+[A-Z]?\w*$/.test(clean) && i > 0 && !/[.!?]$/.test(words[i - 1]);
      if ((isAcronym || isName) && clean.length > 1 && !HONORIFICS.has(clean)) {
        names.set(clean, (names.get(clean) || 0) + 1);
      }
    });
  }
  const freq = new Map();
  for (const s of segs) for (const w of contentWords(s.fr)) freq.set(w, (freq.get(w) || 0) + 1);
  const terms = [...names.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const words = [...freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const out = [];
  for (const t of [...terms, ...words]) {
    if (out.length >= limit) break;
    if (!out.some((o) => normalize(o) === normalize(t))) out.push(t);
  }
  return out;
}

// Score de représentativité d'une phrase (méthode de Luhn : fréquence des
// mots porteurs de sens dans l'ensemble du texte).
function scorer(segs) {
  const freq = new Map();
  for (const s of segs) for (const w of new Set(contentWords(s.fr))) freq.set(w, (freq.get(w) || 0) + 1);
  return (s) => {
    const ws = contentWords(s.fr);
    if (ws.length < 4) return 0; // bribes : jamais retenues
    const sum = ws.reduce((n, w) => n + (freq.get(w) > 1 ? freq.get(w) : 0), 0);
    return sum / Math.sqrt(ws.length);
  };
}

function topSentences(segs, n) {
  const score = scorer(segs);
  return segs.map((s) => ({ s, v: score(s) })).filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v).slice(0, n).map((x) => x.s).sort((a, b) => a.start - b.start);
}

// Regroupe les segments audio en phrases complètes (un segment coupe souvent
// une phrase en deux) : un extrait est ainsi toujours une phrase entière.
export function toSentences(segs) {
  const out = [];
  let cur = null;
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    if (!s.fr || !s.fr.trim()) continue;
    if (!cur) cur = { ...s };
    else {
      cur = { ...cur, end: s.end, fr: `${cur.fr} ${s.fr}`, en: `${cur.en} ${s.en}` };
    }
    const ended = /[.!?…»"]\s*$/.test(s.fr.trim());
    if (ended || cur.fr.length > 400) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

// Résumé express : phrases réelles, dans l'ordre de la vidéo.
export function extractiveSummary(segs, { duration = null } = {}) {
  const sorted = toSentences(segs);
  if (!sorted.length) return null;
  const span = (duration || sorted[sorted.length - 1].end) - sorted[0].start;
  const nChapters = Math.max(1, Math.min(12, Math.round(span / 300)));
  const chapters = [];
  for (let i = 0; i < nChapters; i++) {
    const a = sorted[0].start + (span * i) / nChapters;
    const b = sorted[0].start + (span * (i + 1)) / nChapters;
    const part = sorted.filter((s) => s.start >= a && (s.start < b || i === nChapters - 1));
    if (!part.length) continue;
    chapters.push({ start: part[0].start, end: part[part.length - 1].end,
      terms: keyTerms(part, 3), extraits: topSentences(part, 2) });
  }
  return {
    court: topSentences(sorted, 3),
    points: topSentences(sorted, Math.min(8, Math.max(3, Math.round(sorted.length / 12)))),
    termes: keyTerms(sorted),
    chapitres: chapters,
  };
}

// Passage de la transcription qui appuie le mieux un point du résumé IA.
// Renvoie { segment, score, absents } : `absents` liste les noms propres et
// nombres du point introuvables dans la transcription (signe d'invention).
export function supportFor(point, segs) {
  const pw = [...new Set(contentWords(point))];
  let best = null;
  let bestScore = 0;
  // Fenêtre de 2 phrases consécutives : une idée tient souvent sur deux.
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const text = `${sorted[i].fr} ${sorted[i].en} ${sorted[i + 1] ? `${sorted[i + 1].fr} ${sorted[i + 1].en}` : ''}`;
    const sw = new Set(contentWords(text));
    const hits = pw.filter((w) => sw.has(w) || [...sw].some((x) => x.length > 4 && w.length > 4 && x.slice(0, 5) === w.slice(0, 5))).length;
    const score = pw.length ? hits / pw.length : 0;
    if (score > bestScore) { bestScore = score; best = sorted[i]; }
  }
  const all = normalize(sorted.map((s) => `${s.en} ${s.fr}`).join(' '));
  // Mots précis (6 lettres et plus) absents de TOUTE la transcription : un
  // résumé fidèle reprend les mots de la vidéo, une invention en apporte.
  const vocab = new Set(contentWords(all));
  const stems = new Set([...vocab].map((w) => w.slice(0, 5)));
  const motsAbsents = pw.filter((w) => w.length >= 6 && !vocab.has(w) && !stems.has(w.slice(0, 5)));
  const absents = (String(point).match(/(?<![\p{L}\d])(?:\p{Lu}\p{L}+(?:\s\p{Lu}\p{L}+)*|\p{Lu}{2,}|\d{2,})(?![\p{L}\d])/gu) || [])
    .filter((n) => !(String(point).trim().startsWith(n) && /^\p{Lu}\p{Ll}+$/u.test(n))) // 1er mot de la phrase
    .filter((n) => !all.includes(normalize(n)));
  const res = { segment: best, score: Math.round(bestScore * 100) / 100, absents: [...new Set(absents)], motsAbsents };
  res.doubtful = isDoubtful(res);
  return res;
}

export const SUPPORT_MIN = 0.35;

// Point « à vérifier » : appui faible, nom introuvable, ou au moins deux
// mots précis absents de la vidéo.
export function isDoubtful(r) {
  return r.score < SUPPORT_MIN || r.absents.length > 0 || r.motsAbsents.length >= 2;
}
