// Popup : commandes et réglages. Elle n'héberge aucun traitement : la fermer
// n'interrompt pas la traduction.

import { loadSettings, saveSettings } from './lib/settings.js';

const $ = (id) => document.getElementById(id);

const STATUS_LABELS = {
  pret: 'Prêt',
  connexion: 'Connexion au serveur local…',
  chargement: 'Chargement des modèles…',
  capture: 'Écoute de l\'onglet',
  transcription: 'Transcription…',
  traduction: 'Traduction…',
  lecture: 'Lecture de la voix française',
  pause: 'En pause',
  erreur: 'Erreur',
};

const COMPONENT_LABELS = {
  attente: 'en attente',
  telechargement: 'téléchargement',
  chargement: 'chargement en mémoire',
  pret: 'prêt',
  erreur: 'erreur',
};

const UDEMY_ORIGINS = { origins: ['https://www.udemy.com/*'] };

let settings = null;
let state = null;
let currentTab = null;
let busy = false;
let localError = null;
let detectedMode = 'auto';

const MODE_LABELS = {
  film: 'film ou série', formation: 'formation', documentaire: 'documentaire',
  conversation: 'conversation',
};

function sw(type, payload = {}) {
  return chrome.runtime.sendMessage({ target: 'sw', type, ...payload });
}

// ------------------------------------------------------------------- rendu

function render() {
  if (!state || !settings) return;
  const s = state;
  $('status').dataset.status = s.status;
  $('statusText').textContent = STATUS_LABELS[s.status] || s.status;

  const err = localError || (s.error && s.error.message);
  $('alert').hidden = !err;
  $('alert').textContent = err || '';
  $('warning').hidden = !s.warning || !!err;
  $('warning').textContent = s.warning || '';

  const elsewhere = s.running && currentTab && s.tabId !== currentTab.id;
  $('otherTab').hidden = !elsewhere;

  $('start').disabled = busy || (s.running && !elsewhere);
  $('start').textContent = elsewhere ? 'Démarrer sur cet onglet' : 'Démarrer';
  $('pause').disabled = busy || !s.running;
  $('pause').textContent = s.paused ? 'Reprendre' : 'Pause';
  $('pause').setAttribute('aria-pressed', String(!!s.paused));
  $('stop').disabled = busy || !s.running;

  // Progression des modèles (affichée tant que tout n'est pas prêt).
  const comp = s.server.components;
  const showModels = s.server.connected && comp && !s.server.ready;
  $('models').hidden = !showModels;
  if (comp) {
    for (const [key, bar, label] of [['asr', 'pAsr', 'lAsr'], ['mt', 'pMt', 'lMt'], ['tts', 'pTts', 'lTts']]) {
      const c = comp[key] || {};
      const pct = c.state === 'pret' ? 1 : (c.state === 'telechargement' ? c.progress || 0 : (c.state === 'chargement' ? 1 : 0));
      $(bar).value = pct;
      let txt = COMPONENT_LABELS[c.state] || '';
      if (c.state === 'telechargement') txt += ` ${Math.round((c.progress || 0) * 100)} %${c.detail ? ` de ${c.detail}` : ''}`;
      $(label).textContent = txt;
    }
  }

  // Mesures.
  const m = s.metrics;
  const active = s.running && !s.paused;
  $('mLag').textContent = active && m.lag !== null ? `${fmt(m.lag)} s` : '—';
  $('mQueue').textContent = active ? `${fmt(m.queue)} s` : '—';
  $('mLoad').textContent = active && m.rtf ? `${Math.round(m.rtf * 100)} %` : '—';
  $('mLevel').value = active ? Math.min(1, (m.level || 0) * 6) : 0;
  const extra = [];
  if (m.skipped) extra.push(`${m.skipped} passage(s) sauté(s) à la lecture`);
  if (m.dropped) extra.push(`${m.dropped} passage(s) ignoré(s) par manque de puissance`);
  if (m.uncertain) extra.push(`${m.uncertain} passage(s) trop incertain(s) non traduit(s)`);
  if (s.media.autoPaused) extra.push('vidéo en pause automatique : la traduction rattrape son retard');
  $('mExtra').textContent = extra.join(' · ');
  $('mExtra').hidden = !extra.length;

  // Voix proposées par le serveur.
  const voices = s.server.voices || [];
  const sel = $('voice');
  const wanted = voices.length ? voices : [{ id: settings.voice, label: 'Voix du serveur (serveur non connecté)', installed: true }];
  const sig = JSON.stringify(wanted.map((v) => [v.id, v.installed]));
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.textContent = '';
    for (const v of wanted) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.installed ? v.label : `${v.label} — non installée`;
      o.disabled = !v.installed;
      sel.appendChild(o);
    }
  }
  sel.value = settings.voice;
  $('testVoice').disabled = !s.server.connected || !s.server.ready;
  $('testVoice').title = $('testVoice').disabled ? 'Le serveur local doit être démarré et prêt.' : '';

  // Synchronisation.
  let mediaInfo = '';
  if (s.running) {
    if (s.media.controllable) {
      mediaInfo = s.media.site === 'udemy'
        ? 'Lecteur Udemy détecté : pause, reprise, sauts et changements de leçon sont suivis.'
        : 'Lecteur vidéo détecté : pause, reprise et sauts sont suivis.';
    } else {
      mediaInfo = 'Aucun lecteur vidéo contrôlable sur cette page : mode générique (son de l\'onglet uniquement). '
        + 'La pause automatique est indisponible.';
    }
  }
  $('mediaInfo').textContent = mediaInfo;
  $('mediaInfo').hidden = !mediaInfo;

  const lib = s.library;
  let libText = '';
  if (s.running && lib && lib.enabled) {
    libText = lib.title ? `Bibliothèque : « ${lib.title} » — ${lib.saved} phrase(s) enregistrée(s)` : 'Bibliothèque : en attente de la vidéo…';
    if (lib.progress !== null && lib.progress !== undefined) libText += `, ${Math.round(lib.progress * 100)} % de la vidéo`;
    if (lib.duplicates) libText += ` (${lib.duplicates} passage(s) déjà connus, non dupliqués)`;
    if (lib.timeBase === 'session') libText += ' — pas de lecteur vidéo : datation depuis le début de la session';
    if (lib.error) libText = lib.error;
  } else if (s.running && lib && !lib.enabled) {
    libText = 'Bibliothèque désactivée : rien n\'est enregistré (voir les options).';
  }
  $('libInfo').textContent = libText;
  $('libInfo').hidden = !libText;

  $('lastFr').textContent = s.last.fr || '';
  $('lastEn').textContent = s.last.en || '';

  let info = 'Serveur local : non connecté';
  if (s.server.connected) {
    info = `Serveur local : ${s.server.ready ? 'prêt' : 'préparation'}`
      + (s.server.profile ? ` · profil ${s.server.profile}` : '');
  }
  $('serverInfo').textContent = info;
}

const fmt = (x) => (Math.round(x * 10) / 10).toLocaleString('fr-FR', { minimumFractionDigits: 1 });

function renderSettings() {
  for (const id of ['duck', 'subtitles', 'subtitlesEnglish', 'catchupPause', 'autoSpeedup']) $(id).checked = settings[id];
  for (const id of ['rate', 'originalVolume', 'frenchVolume']) $(id).value = settings[id];
  $('source').value = settings.source;
  $('contentMode').value = settings.contentMode;
  $('modeInfo').textContent = settings.contentMode === 'auto'
    ? (detectedMode !== 'auto'
      ? `Détecté d'après le site : ${MODE_LABELS[detectedMode]}.`
      : 'Réglage général, adapté à tous les contenus.')
    : 'Choisi manuellement.';
  $('target').value = settings.target;
  $('subtitlesEnglish').disabled = !settings.subtitles;
  $('oRate').textContent = `× ${settings.rate.toFixed(2).replace('.', ',')}`;
  $('oOrig').textContent = `${Math.round(settings.originalVolume * 100)} %`;
  $('oFr').textContent = `${Math.round(settings.frenchVolume * 100)} %`;
}

// ------------------------------------------------------------------ actions

async function update(patch) {
  settings = await saveSettings(patch);
  renderSettings();
  render();
}

async function withBusy(fn) {
  busy = true;
  localError = null;
  render();
  try {
    const res = await fn();
    if (res && res.ok === false && res.error) localError = res.error;
  } catch (err) {
    localError = String((err && err.message) || err);
  } finally {
    busy = false;
    await refresh();
  }
}

async function refresh() {
  const res = await sw('ui:getState');
  if (res && res.ok) {
    state = res.state;
    settings = res.settings;
    detectedMode = res.detectedMode || 'auto';
  }
  renderSettings();
  render();
}

function bind() {
  $('start').addEventListener('click', () => withBusy(async () => {
    if (!currentTab) return { ok: false, error: 'Onglet actif introuvable.' };
    return sw('ui:start', { tabId: currentTab.id });
  }));
  $('pause').addEventListener('click', () => withBusy(() => sw(state.paused ? 'ui:resume' : 'ui:pause')));
  $('stop').addEventListener('click', () => withBusy(() => sw('ui:stop')));
  $('showTab').addEventListener('click', () => {
    if (state && state.tabId !== null) chrome.tabs.update(state.tabId, { active: true });
  });
  $('testVoice').addEventListener('click', () => sw('ui:testVoice', { voice: settings.voice, rate: settings.rate }));

  for (const id of ['duck', 'subtitles', 'subtitlesEnglish', 'catchupPause', 'autoSpeedup']) {
    $(id).addEventListener('change', (e) => update({ [id]: e.target.checked }));
  }
  for (const id of ['rate', 'originalVolume', 'frenchVolume']) {
    $(id).addEventListener('input', (e) => update({ [id]: Number(e.target.value) }));
  }
  $('voice').addEventListener('change', (e) => update({ voice: e.target.value }));
  $('source').addEventListener('change', (e) => update({ source: e.target.value }));
  $('contentMode').addEventListener('change', (e) => update({ contentMode: e.target.value }));
  $('target').addEventListener('change', (e) => update({ target: e.target.value }));

  $('udemyGrant').addEventListener('click', async () => {
    // Demandée seulement ici, à l'initiative de l'utilisateur.
    const granted = await chrome.permissions.request(UDEMY_ORIGINS);
    $('udemyBox').hidden = granted;
    if (granted) await sw('ui:reinject');
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'ui') return;
    if (msg.type === 'state') {
      state = msg.state;
      render();
    }
  });
}

async function init() {
  bind();
  settings = await loadSettings();
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();
  // Vérifie la présence du serveur local dès l'ouverture (sans rien capturer).
  sw('ui:probe').catch(() => {});
  setInterval(() => { if (!state || !state.running) sw('ui:probe').catch(() => {}); }, 15000);
  // Adaptateur Udemy : proposer l'autorisation durable seulement sur Udemy.
  const onUdemy = currentTab && /^https:\/\/([\w-]+\.)?udemy\.com\//.test(currentTab.url || '');
  if (onUdemy && !(await chrome.permissions.contains(UDEMY_ORIGINS))) $('udemyBox').hidden = false;
}

init();
