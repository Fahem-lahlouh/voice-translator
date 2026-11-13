// Service worker : coordination entre la popup, le document « offscreen »
// (traitement audio) et le script injecté dans l'onglet (lecteur vidéo,
// sous-titres). Il peut être mis en veille par Chrome à tout moment sans
// interrompre la traduction : l'état vit dans le document offscreen.

import { loadSettings, toServerSettings } from './lib/settings.js';

const OFFSCREEN_URL = 'offscreen.html';
const ADAPTER_FILE = 'content/adapter.js';

// ------------------------------------------------------- document offscreen

let creating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capturer le son de l\'onglet choisi, l\'envoyer au serveur local de '
        + 'traduction et lire la voix française générée.',
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch (_) { /* déjà fermé */ }
  }
}

function toOffscreen(type, payload = {}) {
  return chrome.runtime.sendMessage({ target: 'offscreen', type, ...payload });
}

async function connectionPayload() {
  const settings = await loadSettings();
  return {
    settings,
    serverSettings: await toServerSettings(settings),
    port: settings.serverPort,
    token: settings.token,
  };
}

// --------------------------------------------------------------- état léger

async function getSession() {
  const { session } = await chrome.storage.session.get('session');
  return session || { tabId: null };
}

async function setSession(session) {
  await chrome.storage.session.set({ session });
}

const IDLE_STATE = {
  running: false, paused: false, tabId: null, status: 'pret', error: null, warning: null,
  server: { connected: false, ready: false, components: null, voices: [], pairs: [] },
  metrics: { lag: null, queue: 0, level: 0, speech: false, asrBacklog: 0, rtf: 0, dropped: 0, uncertain: 0, skipped: 0 },
  media: { found: false, controllable: false, site: 'generique', autoPaused: false, rate: 1 },
  last: { en: '', fr: '' },
};

async function currentState() {
  if (!(await hasOffscreen())) return IDLE_STATE;
  try {
    const res = await toOffscreen('getState');
    return res && res.ok ? res.state : IDLE_STATE;
  } catch (_) {
    return IDLE_STATE;
  }
}

// ----------------------------------------------------------------- pastille

async function setBadge(state) {
  const map = {
    marche: { text: 'FR', color: '#1a7f37', title: 'Doublage en cours' },
    pause: { text: 'II', color: '#9a6700', title: 'Doublage en pause' },
    erreur: { text: '!', color: '#cf222e', title: 'Doublage : erreur' },
    arret: { text: '', color: '#666666', title: 'Doublage vocal local' },
  };
  const b = map[state] || map.arret;
  await chrome.action.setBadgeText({ text: b.text });
  if (b.text) await chrome.action.setBadgeBackgroundColor({ color: b.color });
  await chrome.action.setTitle({ title: b.title });
}

// --------------------------------------------------- script du lecteur vidéo

async function injectAdapter(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [ADAPTER_FILE],
    });
    return true;
  } catch (err) {
    // Page protégée ou autorisation expirée : le mode générique reste utilisable.
    console.debug('[doublage] script du lecteur non injecté :', err && err.message);
    return false;
  }
}

function toTab(tabId, msg) {
  if (tabId === null || tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, { target: 'adapter', ...msg }).catch(() => {});
}

// ------------------------------------------------------------------ démarrage

function captureErrorMessage(err) {
  const m = String((err && err.message) || err);
  if (/Chrome pages cannot be captured|cannot be captured/i.test(m)) {
    return 'Chrome interdit la capture de cette page (pages internes chrome://, Chrome Web Store, '
      + 'nouvel onglet…). Ouvrez la vidéo dans un onglet normal.';
  }
  if (/has not been invoked|activeTab/i.test(m)) {
    return 'Chrome n\'a pas autorisé la capture de cet onglet. Affichez l\'onglet de la vidéo, '
      + 'cliquez sur l\'icône de l\'extension, puis sur « Démarrer ».';
  }
  if (/active stream/i.test(m)) {
    return 'Cet onglet est déjà capturé (par cette extension ou une autre). Arrêtez l\'autre '
      + 'capture puis réessayez.';
  }
  return `Capture impossible : ${m}`;
}

async function start(tabId) {
  if (!Number.isInteger(tabId)) return { ok: false, error: 'Onglet introuvable.' };
  await ensureOffscreen();
  const state = await currentState();
  if (state.running) await toOffscreen('stop');
  let streamId;
  try {
    // Autorisé parce que l'utilisateur vient d'ouvrir la popup sur cet onglet
    // (autorisation activeTab). L'identifiant n'est utilisable qu'une fois,
    // pendant quelques secondes, par cette extension.
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    await closeIfIdle();
    return { ok: false, error: captureErrorMessage(err) };
  }
  const payload = await connectionPayload();
  const res = await toOffscreen('start', { streamId, tabId, ...payload });
  if (!res || !res.ok) {
    await closeIfIdle();
    return { ok: false, error: (res && res.error) || 'La capture n\'a pas pu démarrer.' };
  }
  await setSession({ tabId });
  const injected = await injectAdapter(tabId);
  return { ok: true, adapter: injected };
}

async function closeIfIdle() {
  const state = await currentState();
  if (!state.running) {
    await closeOffscreen();
    await setBadge('arret');
  }
}

async function stop() {
  if (await hasOffscreen()) {
    try { await toOffscreen('stop'); } catch (_) { /* document déjà fermé */ }
  }
  await afterStop();
  return { ok: true };
}

async function afterStop() {
  const session = await getSession();
  if (session.tabId !== null) toTab(session.tabId, { type: 'dispose' });
  await setSession({ tabId: null });
  // Fermer le document offscreen libère définitivement micro-services audio,
  // contextes et connexion : plus rien ne tourne après « Arrêter ».
  await closeOffscreen();
  await setBadge('arret');
}

// -------------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id || msg.target !== 'sw') return false;
  handle(msg, sender).then(sendResponse, (err) => {
    console.error('[doublage]', err);
    sendResponse({ ok: false, error: String((err && err.message) || err) });
  });
  return true;
});

async function handle(msg, sender) {
  // Les commandes de pilotage ne sont acceptées que des pages de l'extension
  // (popup, options, document offscreen). Un script de contenu a pour `url`
  // l'adresse de la page web, jamais une adresse chrome-extension:// de cette
  // extension ; une page web, elle, ne peut pas écrire sur ce canal
  // (`externally_connectable` n'est pas déclaré).
  const fromExtensionPage = typeof sender.url === 'string'
    && sender.url.startsWith(chrome.runtime.getURL(''));
  switch (msg.type) {
    // --- depuis la popup / les options
    case 'ui:getState': {
      if (!fromExtensionPage) return { ok: false };
      return { ok: true, state: await currentState(), settings: await loadSettings() };
    }
    case 'ui:start':
      if (!fromExtensionPage) return { ok: false };
      return start(msg.tabId);
    case 'ui:pause':
      if (!fromExtensionPage) return { ok: false };
      return (await hasOffscreen()) ? toOffscreen('pause') : { ok: true };
    case 'ui:resume':
      if (!fromExtensionPage) return { ok: false };
      return (await hasOffscreen()) ? toOffscreen('resume') : { ok: true };
    case 'ui:stop':
      if (!fromExtensionPage) return { ok: false };
      return stop();
    case 'ui:probe': // popup ouverte : vérifier la présence du serveur local
      if (!fromExtensionPage) return { ok: false };
      await ensureOffscreen();
      return toOffscreen('connect', await connectionPayload());
    case 'ui:testVoice': {
      if (!fromExtensionPage) return { ok: false };
      await ensureOffscreen();
      return toOffscreen('testVoice', { voice: msg.voice, rate: msg.rate, ...(await connectionPayload()) });
    }
    case 'ui:reinject': {
      if (!fromExtensionPage) return { ok: false };
      const session = await getSession();
      return { ok: session.tabId !== null && await injectAdapter(session.tabId) };
    }

    // --- depuis le document offscreen
    case 'offscreenReady':
      return { ok: true };
    case 'badge':
      await setBadge(msg.state);
      return { ok: true };
    case 'subtitle':
      toTab(msg.tabId, { type: 'subtitle', fr: msg.fr, en: msg.en, duration: msg.duration, clear: !!msg.clear });
      return { ok: true };
    case 'subtitleConfig':
      toTab(msg.tabId, { type: 'subtitleConfig', enabled: !!msg.enabled });
      return { ok: true };
    case 'mediaCommand':
      toTab(msg.tabId, { type: 'command', command: msg.command });
      return { ok: true };
    case 'stopped': // arrêt décidé par le document offscreen (onglet fermé, etc.)
      await afterStop();
      return { ok: true };
    case 'idle': // test de voix terminé, aucune session en cours
      await closeIfIdle();
      return { ok: true };
    default:
      return { ok: false, error: 'message inconnu' };
  }
}

// ------------------------------------------------------- suivi des réglages

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  if (!(await hasOffscreen())) return;
  try {
    await toOffscreen('settings', await connectionPayload());
  } catch (_) { /* document fermé entre-temps */ }
});

// ---------------------------------------------------------- suivi de l'onglet

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await getSession();
  if (session.tabId !== tabId) return;
  if (await hasOffscreen()) {
    try { await toOffscreen('tabGone', { tabId }); } catch (_) { /* rien */ }
  }
  await afterStop();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const session = await getSession();
  if (session.tabId !== tabId || !(await hasOffscreen())) return;
  // Rechargement ou nouvelle page dans l'onglet capturé : la capture continue,
  // mais ce qui était en attente ne correspond plus à ce qui est affiché.
  try { await toOffscreen('navigated', { tabId }); } catch (_) { /* rien */ }
  await injectAdapter(tabId);
});

chrome.runtime.onStartup.addListener(() => setBadge('arret'));
chrome.runtime.onInstalled.addListener(() => setBadge('arret'));
