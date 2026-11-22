// Réglages conservés entre les sessions (chrome.storage.local).
// Ni l'audio ni les transcriptions ne sont jamais enregistrés.

import { glossaryToText, parseGlossaryText } from './glossary.js';
import { PRONUNCIATION_HELP, parsePronunciationText } from './pronunciation.js';

export const CONTENT_MODES = ['auto', 'film', 'formation', 'documentaire', 'conversation'];

export const DEFAULT_PORT = 47831;

export const DEFAULTS = Object.freeze({
  source: 'en',
  target: 'fr',
  voice: 'siwis',
  rate: 1.0, // vitesse de la voix française
  originalVolume: 0.2, // 0..1 : voix originale entendue (la capture n'est pas affectée)
  frenchVolume: 1.0, // 0..1.5
  duck: true, // baisser encore l'original pendant que la voix française parle
  subtitles: true,
  subtitlesEnglish: false,
  catchupPause: false, // mettre la vidéo en pause pour laisser la traduction rattraper
  autoSpeedup: true, // accélérer légèrement la voix quand elle prend du retard
  serverPort: DEFAULT_PORT,
  token: '',
  glossaryText: null, // null = glossaire par défaut
  pronunciationText: null, // null = aide seule (règles intégrées du serveur)
  contentMode: 'auto', // auto = détecté d'après le site
  saveSessions: true, // bibliothèque locale : phrases traduites enregistrées sur ce PC
  syncPlayback: true, // phrases déjà traduites jouées pile au bon moment
});

const LIMITS = {
  rate: [0.7, 1.6],
  originalVolume: [0, 1],
  frenchVolume: [0, 1.5],
  serverPort: [1024, 65535],
};

export function sanitize(raw) {
  const s = { ...DEFAULTS };
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = raw ? raw[k] : undefined;
    if (v === undefined || v === null) continue;
    if (typeof def === 'boolean') {
      if (typeof v === 'boolean') s[k] = v;
    } else if (typeof def === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) {
        const [lo, hi] = LIMITS[k] || [-Infinity, Infinity];
        s[k] = Math.min(hi, Math.max(lo, v));
      }
    } else if (typeof v === 'string') {
      s[k] = v.slice(0, (k === 'glossaryText' || k === 'pronunciationText') ? 40000 : 200);
    }
  }
  s.serverPort = Math.round(s.serverPort);
  if (!CONTENT_MODES.includes(s.contentMode)) s.contentMode = 'auto';
  return s;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return sanitize(settings);
}

export async function saveSettings(patch) {
  const next = sanitize({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ settings: next });
  return next;
}

let defaultGlossaryCache = null;
export async function defaultGlossaryText() {
  if (defaultGlossaryCache === null) {
    const res = await fetch(chrome.runtime.getURL('glossaire-defaut.json'));
    defaultGlossaryCache = glossaryToText(await res.json());
  }
  return defaultGlossaryCache;
}

export async function effectiveGlossaryText(settings) {
  return settings.glossaryText === null ? defaultGlossaryText() : settings.glossaryText;
}

export function effectivePronunciationText(settings) {
  return settings.pronunciationText === null ? PRONUNCIATION_HELP : settings.pronunciationText;
}

// Type de contenu deviné d'après le site (mode « auto »). Volontairement
// prudent : en cas de doute, aucun type n'est imposé.
const SITE_MODES = [
  [/(^|\.)(udemy|coursera|edx|pluralsight|khanacademy|openclassrooms|skillshare|egghead|frontendmasters|datacamp|codecademy)\./i, 'formation'],
  [/(^|\.)linkedin\.com$/i, 'formation'],
  [/(^|\.)(netflix|primevideo|disneyplus|max|hulu|crunchyroll|canalplus|mubi|paramountplus|appletv)\./i, 'film'],
  [/(^|\.)(ted|arte|nationalgeographic|curiositystream)\./i, 'documentaire'],
];

export function detectContentMode(url) {
  try {
    const host = new URL(url).hostname;
    for (const [rx, mode] of SITE_MODES) if (rx.test(host)) return mode;
  } catch (_) { /* adresse illisible */ }
  return 'auto';
}

// Réglages transmis au serveur local (jamais le jeton, envoyé à part).
export async function toServerSettings(settings, videoRate = 1, detectedMode = 'auto') {
  const { entries } = parseGlossaryText(await effectiveGlossaryText(settings));
  const { rules } = parsePronunciationText(effectivePronunciationText(settings));
  return {
    contentMode: settings.contentMode === 'auto' ? detectedMode : settings.contentMode,
    pronunciation: rules,
    source: settings.source,
    target: settings.target,
    voice: settings.voice,
    rate: settings.rate,
    videoRate: Math.min(4, Math.max(0.25, videoRate || 1)),
    autoSpeedup: settings.autoSpeedup,
    glossary: entries,
  };
}
