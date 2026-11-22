// Exports d'une session de la bibliothèque (fonctions pures, testées).
// Formats : texte, Markdown, sous-titres SRT, JSON. Le PDF passe par
// l'impression du navigateur (« Enregistrer au format PDF »).

const LANG_NAMES = { en: 'anglais', fr: 'français' };

export function formatTime(s, withMs = false) {
  const t = Math.max(0, Number(s) || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = Math.floor(t % 60);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const base = `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return withMs ? `${base},${pad(Math.round((t % 1) * 1000) % 1000, 3)}` : base;
}

export function formatDuration(s) {
  if (!Number.isFinite(s) || s <= 0) return 'inconnue';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

function header(video) {
  return {
    titre: video.title || 'Vidéo sans titre',
    adresse: video.url || '',
    plateforme: video.site || '',
    duree: formatDuration(video.duration),
    langues: `${LANG_NAMES[video.sourceLang] || video.sourceLang || '?'} → ${LANG_NAMES[video.targetLang] || video.targetLang || '?'}`,
    vue: video.lastSeenAt ? new Date(video.lastSeenAt).toLocaleString('fr-FR') : '',
  };
}

const sorted = (segs) => [...segs].sort((a, b) => a.start - b.start);

export function toTxt(video, segs) {
  const h = header(video);
  const lines = [
    h.titre, `Adresse : ${h.adresse}`, `Plateforme : ${h.plateforme}`, `Durée : ${h.duree}`,
    `Langues : ${h.langues}`, `Consultée le : ${h.vue}`, '',
  ];
  for (const s of sorted(segs)) {
    lines.push('----------------------------------------', '', formatTime(s.start), '', `EN : ${s.en}`, '', `FR : ${s.fr}`);
    if (s.note) lines.push('', `Note : ${s.note}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const mdEscape = (t) => String(t || '').replace(/([\\`*_[\]#>|])/g, '\\$1');

export function toMarkdown(video, segs) {
  const h = header(video);
  const out = [
    `# ${mdEscape(h.titre)}`, '',
    `- **Adresse** : ${h.adresse}`, `- **Plateforme** : ${h.plateforme}`, `- **Durée** : ${h.duree}`,
    `- **Langues** : ${h.langues}`, `- **Consultée le** : ${h.vue}`, '',
  ];
  for (const s of sorted(segs)) {
    out.push(`### ${formatTime(s.start)}`, '', `**EN** : ${mdEscape(s.en)}`, '', `**FR** : ${mdEscape(s.fr)}`);
    if (s.translationStatus === 'validee') out.push('', '_Traduction corrigée à la main._');
    if (s.note) out.push('', `> Note : ${mdEscape(s.note)}`);
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

// Sous-titres SRT. `mode` : 'fr' (français seul) ou 'bilingue' (FR puis EN).
export function toSrt(segs, mode = 'fr') {
  const out = [];
  let n = 0;
  for (const s of sorted(segs)) {
    const text = mode === 'bilingue' ? `${s.fr}\n${s.en}` : s.fr;
    if (!text.trim()) continue;
    n += 1;
    const end = Math.max(s.end, s.start + 0.8);
    out.push(String(n), `${formatTime(s.start, true)} --> ${formatTime(end, true)}`, text, '');
  }
  return out.join('\n');
}

export function toJson(video, segs) {
  return JSON.stringify({
    format: 'doublage-vocal-local',
    version: 1,
    exporteLe: new Date().toISOString(),
    video: {
      id: video.id, titre: video.title, adresse: video.url, plateforme: video.site,
      duree: video.duration, langueSource: video.sourceLang, langueCible: video.targetLang,
      baseDeTemps: video.timeBase, premiereVue: video.createdAt, derniereVue: video.lastSeenAt,
    },
    phrases: sorted(segs).map((s) => ({
      id: s.id, debut: s.start, fin: s.end, anglais: s.en, francais: s.fr,
      statutTranscription: s.transcriptStatus, statutTraduction: s.translationStatus,
      note: s.note || '',
    })),
  }, null, 2);
}

// Nom de fichier sûr, dérivé du titre.
export function fileName(title, ext) {
  const base = String(title || 'video')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, ' ').trim().replace(/\s+/g, '-').slice(0, 80) || 'video';
  return `${base}.${ext}`;
}

// Texte d'une sélection de phrases, pour le presse-papiers.
export function toClipboard(segs) {
  return sorted(segs).map((s) => `[${formatTime(s.start)}]\nEN : ${s.en}\nFR : ${s.fr}`).join('\n\n');
}

// Recherche insensible à la casse et aux accents.
export function normalize(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function matches(seg, query) {
  const q = normalize(query).trim();
  if (!q) return true;
  return normalize(`${seg.en} ${seg.fr} ${seg.note || ''}`).includes(q);
}
