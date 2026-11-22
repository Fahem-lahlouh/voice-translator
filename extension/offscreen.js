// Document « offscreen » : tout le traitement audio de l'extension.
//
// Il vit indépendamment de la popup : la fermer n'arrête rien.
//
// Routage audio (les deux branches partent du même flux capturé) :
//
//   onglet ──capture──┬─► [contexte 16 kHz] ─► AudioWorklet ─► WebSocket ─► serveur local
//                     │        (jamais atténué : c'est ce que le serveur transcrit)
//                     └─► [contexte de lecture] ─► gain « original » ─► haut-parleurs
//
//   serveur local ─► voix française (PCM) ─► gain « français » ─► haut-parleurs
//
// La voix française n'est jouée que par ce document : elle ne fait pas partie
// du son de l'onglet et ne peut donc pas être re-capturée (pas de boucle).

import * as store from './lib/store.js';
import {
  START_OFFSET_S, coveredBySync, dueToStart, insertSorted, maxDuration, prepKey, toPrepare,
} from './lib/syncplayer.js';
import { Timeline } from './lib/timeline.js';
import { cleanTitle, videoIdentity } from './lib/videoid.js';

const PROTOCOL = 1;
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000];
const QUEUE_DROP_AT_S = 8; // sans pause automatique : au-delà, on saute des passages
const QUEUE_DROP_TO_S = 3;
const AUTOPAUSE_AT_S = 4; // avec pause automatique : on met la vidéo en pause
const AUTOPAUSE_RESUME_S = 0.8;
const DUCK_FACTOR = 0.35;
const GAP_S = 0.12; // silence entre deux phrases françaises

const state = {
  running: false,
  paused: false,
  tabId: null,
  status: 'pret', // pret | connexion | chargement | capture | transcription | traduction | lecture | pause | erreur
  error: null, // { code, message }
  warning: null,
  server: { connected: false, ready: false, components: null, profile: '', asrModel: '', voices: [], pairs: [] },
  metrics: {
    lag: null, queue: 0, level: 0, speech: false, asrBacklog: 0, rtf: 0,
    dropped: 0, uncertain: 0, skipped: 0, clock: 0, silentInput: 0,
  },
  media: { found: false, controllable: false, site: 'generique', autoPaused: false, rate: 1 },
  capture: { sampleRate: 0, outputRate: 0 },
  last: { en: '', fr: '' },
  // Bibliothèque : session en cours d'enregistrement.
  library: { enabled: true, title: '', saved: 0, duplicates: 0, progress: null, timeBase: '', error: '' },
  // Lecture synchronisée des phrases déjà traduites.
  sync: { enabled: true, known: 0, played: 0, missed: 0, suppressed: 0, avgError: null, maxError: null },
};

let settings = null; // réglages de l'extension (volumes, etc.)
let serverSettings = null; // réglages transmis au serveur
let port = 47831;
let token = '';

let ws = null;
let wsWanted = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let helloOk = false;
let pendingVoiceTest = null;

let stream = null;
let playCtx = null;
let capCtx = null;
let origGain = null;
let frGain = null;
let workletNode = null;

let epoch = 0;
let samplesSent = 0; // horloge de capture de l'époque courante

// Datation des phrases dans le temps de la vidéo, et enregistrement local.
const timeline = new Timeline();
let page = { url: '', title: '' }; // page de la vidéo (cadre principal)
let mediaDuration = null;
let currentVideo = null; // { id, url, site, title, timeBase }
let pendingSegments = []; // phrases arrivées avant les informations de la page
let writeChain = Promise.resolve(); // écritures une à une (pas de doublon concurrent)
let sessionWall0 = 0;

// Lecture synchronisée : phrases connues de la vidéo, voix préparées, etc.
let knownSegs = []; // triées par début, temps de la vidéo
let preparedBuffers = new Map(); // clé de préparation -> AudioBuffer
let requested = new Set(); // clés déjà demandées au serveur
let startedIds = new Set(); // phrases lancées (ou abandonnées) depuis le dernier saut
let syncSources = []; // voix synchronisées en cours
let syncTimer = null;
let syncErrors = []; // écart (s) entre le début de l'anglais et celui du français
const syncLog = [];
let queue = []; // [{ buffer, header }]
let current = null; // { source, header, endsAt }
let playTimer = null;
let reportTimer = null;
let lastBroadcast = 0;
let broadcastTimer = null;
let serverBusy = '';
let serverTtsQueue = 0;
let lastSpeechAt = 0;
let startedAt = 0;
let closeIdleTimer = null;

// ------------------------------------------------------------------ messages

function toSw(type, payload = {}) {
  chrome.runtime.sendMessage({ target: 'sw', type, ...payload }).catch(() => {});
}

function broadcast(force = false) {
  const now = performance.now();
  if (!force && now - lastBroadcast < 200) {
    if (!broadcastTimer) broadcastTimer = setTimeout(() => { broadcastTimer = null; broadcast(true); }, 220);
    return;
  }
  lastBroadcast = now;
  computeStatus();
  chrome.runtime.sendMessage({ target: 'ui', type: 'state', state: snapshot() }).catch(() => {});
}

function snapshot() {
  return JSON.parse(JSON.stringify(state));
}

function setError(code, message) {
  state.error = { code, message };
  broadcast(true);
  toSw('badge', { state: 'erreur' });
}

function clearError(code) {
  if (state.error && (!code || state.error.code === code)) state.error = null;
}

function computeStatus() {
  const m = state.metrics;
  let s = 'pret';
  if (state.error && (state.error.fatal || !state.running)) s = 'erreur';
  else if (!state.running) s = 'pret';
  else if (state.paused) s = 'pause';
  else if (state.error) s = 'erreur';
  else if (!state.server.connected) s = 'connexion';
  else if (!state.server.ready) s = 'chargement';
  else if (current || syncSources.length) s = 'lecture';
  else if (serverBusy === 'transcription') s = 'transcription';
  else if (serverBusy === 'traduction' || serverBusy === 'voix' || serverTtsQueue > 0) s = 'traduction';
  else s = 'capture';
  state.status = s;
  state.sync.speaking = syncSources.length > 0;
  m.queue = round1(queuedSeconds());
  m.clock = round1(samplesSent / 16000);
}

const round1 = (x) => Math.round(x * 10) / 10;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  if (msg.target === 'offscreen') {
    handleCommand(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  // Événements du lecteur vidéo, émis par le script injecté dans l'onglet capturé.
  if (msg.target === 'media' && sender.tab && sender.tab.id === state.tabId) {
    onMediaEvent(msg);
  }
  return false;
});

async function handleCommand(msg) {
  switch (msg.type) {
    case 'getState':
      computeStatus();
      return { ok: true, state: snapshot() };
    case 'start':
      return start(msg);
    case 'pause':
      return pause();
    case 'resume':
      return resume();
    case 'stop':
      await stop('utilisateur');
      return { ok: true };
    case 'settings':
      applySettings(msg.settings, msg.serverSettings, msg.port, msg.token);
      return { ok: true };
    case 'testVoice':
      return testVoice(msg);
    case 'connect': // popup ouverte : vérifier que le serveur répond
      applySettings(msg.settings, msg.serverSettings, msg.port, msg.token);
      ensureSocket();
      scheduleIdleClose();
      return { ok: true };
    case 'tabGone':
      if (state.running && msg.tabId === state.tabId) await stop('onglet fermé');
      return { ok: true };
    case 'navigated':
      if (state.running && msg.tabId === state.tabId) resetEpoch('nouvelle page');
      return { ok: true };
    default:
      return { ok: false, error: 'commande inconnue' };
  }
}

// ----------------------------------------------------------------- réglages

function applySettings(next, nextServer, nextPort, nextToken) {
  if (next) settings = next;
  if (nextServer) {
    serverSettings = { ...nextServer, videoRate: state.media.rate || 1 };
    if (helloOk && state.running) send({ type: 'settings', settings: serverSettings });
  }
  if (typeof nextToken === 'string') token = nextToken;
  if (nextPort && nextPort !== port) {
    port = nextPort;
    if (ws) { try { ws.close(1000, 'changement de port'); } catch (_) { /* déjà fermé */ } }
  }
  updateGains();
  if (state.running) toSw('subtitleConfig', { tabId: state.tabId, enabled: !!settings.subtitles });
}

function updateGains() {
  if (!playCtx || !settings) return;
  const t = playCtx.currentTime;
  let orig = settings.originalVolume;
  if (state.paused) orig = 1; // traduction en pause : on rend le son d'origine
  else if (settings.duck && (current || syncSources.length)) orig *= DUCK_FACTOR;
  origGain.gain.setTargetAtTime(orig, t, 0.08);
  frGain.gain.setTargetAtTime(settings.frenchVolume, t, 0.05);
}

// -------------------------------------------------------------- WebSocket

function ensureSocket() {
  wsWanted = true;
  clearTimeout(closeIdleTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  helloOk = false;
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  } catch (err) {
    onSocketDown();
    return;
  }
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => {
    if (ws !== sock) return;
    const hello = { type: 'hello', protocol: PROTOCOL };
    if (token) hello.token = token;
    sock.send(JSON.stringify(hello));
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    if (typeof ev.data === 'string') onServerJson(JSON.parse(ev.data));
    else onServerAudio(ev.data);
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    onSocketDown(ev);
  };
  sock.onerror = () => { /* suivi d'un onclose */ };
}

function onSocketDown(ev) {
  const wasConnected = state.server.connected;
  helloOk = false;
  state.server.connected = false;
  state.server.ready = false;
  serverBusy = '';
  serverTtsQueue = 0;
  if (pendingVoiceTest) { pendingVoiceTest = null; }
  if (ev && ev.code === 1008) {
    setError('refus', `Le serveur local a refusé la connexion (${ev.reason || 'accès refusé'}). `
      + 'Vérifiez le jeton dans les options et l\'identifiant de l\'extension autorisé côté serveur.');
  } else if (ev && ev.code === 4001) {
    setError('remplace', 'Une autre session a pris la place de celle-ci sur le serveur local.');
    wsWanted = false;
  } else if (wsWanted) {
    setError('serveur', wasConnected
      ? 'La connexion au serveur local a été perdue. Nouvelle tentative en cours… '
        + 'Vérifiez que la fenêtre « Serveur de doublage » est toujours ouverte.'
      : `Serveur local injoignable sur le port ${port}. Lancez scripts\\demarrer-serveur.bat `
        + 'puis attendez « Moteurs prêts ». Nouvelle tentative automatique…');
  }
  if (wsWanted) {
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt++, RECONNECT_DELAYS.length - 1)];
    reconnectTimer = setTimeout(ensureSocket, delay);
  }
  broadcast(true);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function onServerJson(msg) {
  switch (msg.type) {
    case 'hello_ok':
      helloOk = true;
      reconnectAttempt = 0;
      state.server.connected = true;
      state.server.profile = msg.profile;
      state.server.asrModel = msg.asrModel;
      state.server.mtModel = msg.mtModel;
      state.server.voices = msg.voices || [];
      state.server.pairs = msg.pairs || [];
      clearError('serveur');
      clearError('refus');
      if (state.running && !state.paused) {
        // (Re)connexion en cours de session : nouvelle époque propre.
        beginEpoch();
      }
      if (pendingVoiceTest) {
        send(pendingVoiceTest);
        pendingVoiceTest = null;
      }
      toSw('badge', { state: badgeState() });
      break;
    case 'status':
      state.server.ready = !!msg.ready;
      state.server.components = msg.components || null;
      if (msg.error) setError('moteur', `Un moteur n'a pas pu être chargé : ${msg.error}`);
      else clearError('moteur');
      break;
    case 'metrics':
      if (msg.epoch !== epoch) break;
      Object.assign(state.metrics, {
        level: msg.level, speech: msg.speech, asrBacklog: msg.asrBacklog, rtf: msg.rtf,
        dropped: msg.dropped, uncertain: msg.uncertain, silentInput: msg.silentInput,
      });
      serverBusy = msg.busy || '';
      serverTtsQueue = msg.ttsQueue || 0;
      if (msg.speech) lastSpeechAt = performance.now();
      updateDiagnostics();
      maybeAutoResume();
      break;
    case 'segment':
      if (msg.epoch !== epoch) break; // résultat d'une époque périmée
      if (msg.status === 'ok') {
        state.last = { en: msg.en || '', fr: msg.fr || '' };
        saveSegment(msg);
      } else if (msg.status === 'abandonne') {
        state.warning = 'Le PC ne suit pas le rythme : des passages sont ignorés. '
          + 'Choisissez un profil plus léger côté serveur ou activez la pause automatique.';
      }
      break;
    case 'notice':
      state.warning = msg.message || '';
      break;
    case 'error':
      // Erreur ponctuelle d'un moteur : on la signale sans interrompre la session.
      state.warning = msg.code === 'reglages'
        ? `Réglage refusé par le serveur local : ${msg.message}`
        : (msg.message || 'Erreur du serveur local.');
      break;
    default:
      break;
  }
  broadcast();
}

function badgeState() {
  if (!state.running) return 'arret';
  if (state.paused) return 'pause';
  return 'marche';
}

// ------------------------------------------------------------------ capture

async function start({ streamId, tabId, settings: s, serverSettings: ss, port: p, token: t }) {
  if (state.running) await stop('redémarrage');
  state.error = null;
  state.warning = null;
  applySettings(s, ss, p, t);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
  } catch (err) {
    setError('capture', `Impossible de capturer le son de l'onglet : ${err.message || err.name}.`);
    return { ok: false, error: state.error.message };
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    setError('capture', 'Cet onglet ne fournit aucune piste audio.');
    releaseAudio();
    return { ok: false, error: state.error.message };
  }
  track.addEventListener('ended', () => { if (state.running) stop('capture terminée par Chrome'); });

  // Branche « écoute » : rejoue le son de l'onglet (Chrome le coupe pendant la
  // capture) à travers un gain réglable.
  playCtx = new AudioContext({ latencyHint: 'interactive' });
  origGain = playCtx.createGain();
  frGain = playCtx.createGain();
  playCtx.createMediaStreamSource(stream).connect(origGain).connect(playCtx.destination);
  frGain.connect(playCtx.destination);
  origGain.gain.value = settings.originalVolume;
  frGain.gain.value = settings.frenchVolume;

  // Branche « analyse » : 16 kHz mono vers le serveur, sans aucun gain.
  capCtx = new AudioContext({ sampleRate: 16000 });
  await capCtx.audioWorklet.addModule('capture-worklet.js');
  workletNode = new AudioWorkletNode(capCtx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
  workletNode.port.onmessage = (ev) => onCaptureBlock(ev.data);
  const sink = capCtx.createGain();
  sink.gain.value = 0; // la branche d'analyse ne produit aucun son
  capCtx.createMediaStreamSource(stream).connect(workletNode).connect(sink).connect(capCtx.destination);
  await Promise.all([playCtx.resume(), capCtx.resume()]);

  state.running = true;
  state.paused = false;
  state.tabId = tabId;
  state.metrics.skipped = 0;
  state.metrics.lag = null;
  state.last = { en: '', fr: '' };
  state.media = { found: false, controllable: false, site: 'generique', autoPaused: false, rate: 1 };
  state.capture = { sampleRate: capCtx.sampleRate, outputRate: playCtx.sampleRate };
  startedAt = performance.now();
  sessionWall0 = Date.now();
  timeline.clear();
  page = { url: '', title: '' };
  mediaDuration = null;
  currentVideo = null;
  pendingSegments = [];
  state.sync = { enabled: settings.syncPlayback !== false, known: 0, played: 0, missed: 0, suppressed: 0,
    avgError: null, maxError: null };
  syncLog.length = 0;
  syncErrors = [];
  state.library = { enabled: settings.saveSessions !== false, title: '', saved: 0, duplicates: 0,
    progress: null, timeBase: '', error: '' };
  lastSpeechAt = 0;
  epoch = (Date.now() & 0x3fffffff); // base unique par session, puis incrémentée
  ensureSocket();
  if (helloOk) beginEpoch();
  clearInterval(reportTimer);
  reportTimer = setInterval(reportPlayback, 500);
  toSw('badge', { state: 'marche' });
  toSw('subtitleConfig', { tabId, enabled: !!settings.subtitles });
  broadcast(true);
  return { ok: true };
}

function beginEpoch() {
  epoch += 1;
  samplesSent = 0;
  timeline.resetCapture();
  clearPlayback();
  send({ type: 'start', epoch, settings: serverSettings });
}

function resetEpoch(reason) {
  if (!state.running) return;
  epoch += 1;
  samplesSent = 0;
  timeline.resetCapture();
  clearPlayback();
  state.metrics.lag = null;
  state.last = { en: '', fr: '' };
  toSw('subtitle', { tabId: state.tabId, clear: true });
  if (helloOk && !state.paused) send({ type: 'reset', epoch });
  console.debug('[doublage] nouvelle époque :', reason);
  broadcast(true);
}

function onCaptureBlock({ pcm }) {
  if (!state.running || state.paused || !helloOk || !ws || ws.readyState !== WebSocket.OPEN) return;
  // Contre-pression : si le serveur ne lit plus, on ne remplit pas la mémoire.
  if (ws.bufferedAmount > 1_000_000) return;
  const frame = new Uint8Array(4 + pcm.byteLength);
  new DataView(frame.buffer).setUint32(0, epoch, true);
  frame.set(new Uint8Array(pcm), 4);
  ws.send(frame);
  samplesSent += pcm.byteLength / 2;
  timeline.markCapture(samplesSent / 16000, Date.now());
}

function pause() {
  if (!state.running || state.paused) return { ok: true };
  state.paused = true;
  clearPlayback();
  send({ type: 'stop' }); // le serveur termine puis jette : on change d'époque à la reprise
  epoch += 1;
  send({ type: 'reset', epoch });
  if (state.media.autoPaused) releaseAutoPause();
  updateGains();
  toSw('badge', { state: 'pause' });
  toSw('subtitle', { tabId: state.tabId, clear: true });
  broadcast(true);
  return { ok: true };
}

function resume() {
  if (!state.running || !state.paused) return { ok: true };
  state.paused = false;
  state.warning = null;
  if (helloOk) beginEpoch();
  updateGains();
  toSw('badge', { state: 'marche' });
  broadcast(true);
  return { ok: true };
}

async function stop(reason) {
  const tabId = state.tabId;
  stopSync();
  clearInterval(syncTimer);
  syncTimer = null;
  knownSegs = [];
  preparedBuffers = new Map();
  requested = new Set();
  if (state.media.autoPaused) releaseAutoPause();
  state.running = false;
  state.paused = false;
  clearInterval(reportTimer);
  clearPlayback();
  send({ type: 'stop' });
  wsWanted = false;
  clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(1000, 'arrêt'); } catch (_) { /* déjà fermé */ } ws = null; }
  helloOk = false;
  state.server.connected = false;
  releaseAudio();
  state.tabId = null;
  state.metrics.lag = null;
  state.warning = null;
  if (reason === 'onglet fermé' || reason === 'capture terminée par Chrome') {
    state.warning = 'La capture s\'est arrêtée (onglet fermé ou capture interrompue par Chrome).';
  }
  if (state.error && !['capture'].includes(state.error.code)) state.error = null;
  broadcast(true);
  toSw('stopped', { tabId, reason });
}

function releaseAudio() {
  if (stream) {
    for (const t of stream.getTracks()) t.stop(); // libère la capture de l'onglet
    stream = null;
  }
  if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); workletNode = null; }
  if (playCtx) { playCtx.close().catch(() => {}); playCtx = null; }
  if (capCtx) { capCtx.close().catch(() => {}); capCtx = null; }
  origGain = null;
  frGain = null;
}

// ------------------------------------------------------- lecture de la voix

function onServerAudio(data) {
  const view = new DataView(data);
  const hlen = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, hlen)));
  const pcm = new Int16Array(data.slice(4 + hlen));
  if (header.test) {
    playTest(pcm, header.sampleRate);
    return;
  }
  if (header.prepared) {
    onPreparedVoice(header, pcm);
    return;
  }
  if (!state.running || state.paused || header.epoch !== epoch || !playCtx) return; // périmé
  // Passage déjà doublé par la lecture synchronisée : pas de double voix.
  if (coveredBySync(timeline.toMedia(header.t0, header.t1), knownSegs, startedIds)) {
    state.sync.suppressed += 1;
    return;
  }
  const buffer = playCtx.createBuffer(1, pcm.length, header.sampleRate);
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  queue.push({ buffer, header });
  enforceQueueLimit();
  if (!current) playNext();
  broadcast();
}

function queuedSeconds() {
  let s = 0;
  for (const q of queue) s += q.buffer.duration + GAP_S;
  if (current && playCtx) s += Math.max(0, current.endsAt - playCtx.currentTime);
  return s;
}

function enforceQueueLimit() {
  const q = queuedSeconds();
  if (settings.catchupPause && state.media.controllable) {
    if (!state.media.autoPaused && q > AUTOPAUSE_AT_S) {
      state.media.autoPaused = true;
      toSw('mediaCommand', { tabId: state.tabId, command: 'pause' });
    }
    return;
  }
  if (q <= QUEUE_DROP_AT_S) return;
  // La voix française a trop de retard : on saute les passages les plus anciens.
  let total = q;
  while (queue.length > 1 && total > QUEUE_DROP_TO_S) {
    const dropped = queue.shift();
    total -= dropped.buffer.duration + GAP_S;
    state.metrics.skipped += 1;
  }
  state.warning = 'La voix française prenait trop de retard : des passages ont été sautés. '
    + 'Augmentez la vitesse de la voix ou activez la pause automatique de la vidéo.';
}

function maybeAutoResume() {
  if (!state.media.autoPaused) return;
  const idle = queuedSeconds() < AUTOPAUSE_RESUME_S && !serverBusy && serverTtsQueue === 0
    && state.metrics.asrBacklog === 0;
  if (idle) releaseAutoPause();
}

function releaseAutoPause() {
  state.media.autoPaused = false;
  if (state.tabId !== null) toSw('mediaCommand', { tabId: state.tabId, command: 'play' });
}

function playNext() {
  clearTimeout(playTimer);
  if (syncSources.length && queue.length) {
    // Une phrase synchronisée parle : la voix en direct attend son tour.
    playTimer = setTimeout(playNext, 200);
    return;
  }
  if (!playCtx || !queue.length) {
    current = null;
    updateGains();
    maybeAutoResume();
    broadcast();
    return;
  }
  const item = queue.shift();
  const src = playCtx.createBufferSource();
  src.buffer = item.buffer;
  src.connect(frGain);
  const startAt = playCtx.currentTime + 0.03;
  current = { source: src, header: item.header, endsAt: startAt + item.buffer.duration };
  src.onended = () => {
    if (!current || current.source !== src) return;
    current = null;
    playTimer = setTimeout(playNext, GAP_S * 1000);
    updateGains();
    broadcast();
  };
  src.start(startAt);
  // Retard perçu = temps écoulé entre la FIN de la phrase anglaise et le début
  // de sa version française (mesuré sur l'horloge de capture). C'est le délai
  // réel pendant lequel l'utilisateur attend la traduction.
  const lag = Math.max(0, samplesSent / 16000 - item.header.t1);
  state.metrics.lag = state.metrics.lag === null ? round1(lag) : round1(0.6 * state.metrics.lag + 0.4 * lag);
  if (settings.subtitles) {
    toSw('subtitle', {
      tabId: state.tabId, fr: item.header.text,
      en: settings.subtitlesEnglish ? state.last.en : '', duration: item.buffer.duration + 1.5,
    });
  }
  updateGains();
  broadcast();
}

function clearPlayback() {
  clearTimeout(playTimer);
  queue = [];
  if (current) {
    const src = current.source;
    current = null;
    try { src.onended = null; src.stop(); } catch (_) { /* déjà arrêtée */ }
  }
  updateGains();
}

function reportPlayback() {
  if (!state.running || state.paused) return;
  send({ type: 'playback', queue: round1(queuedSeconds()) });
  maybeAutoResume();
  updateDiagnostics();
  broadcast();
}

// ------------------------------------------------------------- diagnostics

function updateDiagnostics() {
  if (!state.running || state.paused || !state.server.connected || !state.server.ready) return;
  const m = state.metrics;
  const sinceStart = (performance.now() - startedAt) / 1000;
  const sinceSpeech = lastSpeechAt ? (performance.now() - lastSpeechAt) / 1000 : sinceStart;
  const autoPaused = state.media.autoPaused;
  if (m.silentInput >= 8 && !autoPaused) {
    state.warning = 'Aucun son ne provient de l\'onglet. Vérifiez que la vidéo est en lecture, '
      + 'que son volume n\'est pas à zéro dans le lecteur et que l\'onglet capturé est le bon.';
  } else if (sinceSpeech > 25 && m.silentInput < 1 && sinceStart > 25 && !autoPaused) {
    state.warning = 'Du son est capté mais aucune parole n\'est détectée (musique, bruit ou volume trop faible ?).';
  } else if (state.warning && (state.warning.startsWith('Aucun son') || state.warning.startsWith('Du son est capté'))) {
    state.warning = null;
  }
}

// ------------------------------------------------------------ bibliothèque

function libraryOn() {
  return state.running && settings && settings.saveSessions !== false;
}

function onPageInfo() {
  if (!libraryOn() || !page.url) return;
  const ident = videoIdentity(page.url);
  if (!currentVideo || currentVideo.id !== ident.id) {
    currentVideo = { ...ident, title: cleanTitle(page.title) };
    state.library.saved = 0;
    state.library.duplicates = 0;
    loadKnownSegments(currentVideo.id);
  } else {
    currentVideo.title = cleanTitle(page.title);
  }
  state.library.title = currentVideo.title;
  refreshVideo();
  const waiting = pendingSegments;
  pendingSegments = [];
  for (const m of waiting) saveSegment(m);
}

function refreshVideo() {
  if (!currentVideo) return;
  const v = currentVideo;
  queueWrite(() => store.upsertVideo({
    id: v.id, url: v.url, site: v.site, title: v.title, duration: mediaDuration,
    timeBase: timeline.hasMedia ? 'video' : 'session',
    sourceLang: serverSettings ? serverSettings.source : 'en',
    targetLang: serverSettings ? serverSettings.target : 'fr',
  }));
}

function queueWrite(fn) {
  writeChain = writeChain.then(fn).catch((err) => {
    state.library.error = `Enregistrement local impossible : ${err.message || err}`;
    console.warn('[doublage] bibliothèque :', err);
  });
  return writeChain;
}

// Enregistre une phrase traduite, datée dans le temps de la vidéo.
function saveSegment(msg) {
  if (!libraryOn() || !msg.fr) return;
  if (!currentVideo) {
    if (pendingSegments.length < 30) pendingSegments.push(msg);
    return;
  }
  const range = timeline.toMedia(msg.t0, msg.t1);
  let start;
  let end;
  if (range) {
    start = range.start;
    end = range.end;
  } else if (!timeline.hasMedia) {
    // Pas de lecteur contrôlable : datation depuis le début de la session.
    const w0 = timeline.captureToWall(msg.t0);
    const w1 = timeline.captureToWall(msg.t1);
    if (w0 === null || w1 === null) return;
    start = Math.round((w0 - sessionWall0) / 10) / 100;
    end = Math.round((w1 - sessionWall0) / 10) / 100;
  } else {
    return; // phrase à cheval sur un saut dans la vidéo : non datable, ignorée
  }
  const videoId = currentVideo.id;
  const seg = { start, end, en: msg.en, fr: msg.fr, conf: msg.conf };
  queueWrite(async () => {
    const res = await store.addSegment(videoId, seg);
    if (!currentVideo || currentVideo.id !== videoId) return;
    if (res.status === 'enregistree') {
      state.library.saved += 1;
      knownSegs = insertSorted(knownSegs, res.segment);
      state.sync.known = knownSegs.length;
    }
    else state.library.duplicates += 1;
    const v = res.video;
    state.library.timeBase = v.timeBase;
    state.library.progress = v.duration ? Math.min(1, store.coveredSeconds(v.covered) / v.duration) : null;
    state.library.error = '';
    broadcast();
  });
}

// --------------------------------------------------- lecture synchronisée

function syncOn() {
  return state.running && !state.paused && settings && settings.syncPlayback !== false;
}

async function loadKnownSegments(videoId) {
  knownSegs = [];
  preparedBuffers = new Map();
  requested = new Set();
  startedIds = new Set();
  try {
    const segs = await store.getSegments(videoId);
    if (currentVideo && currentVideo.id === videoId) {
      knownSegs = segs.filter((x) => x.fr).sort((a, b) => a.start - b.start);
      state.sync.known = knownSegs.length;
    }
  } catch (err) {
    console.warn('[doublage] lecture synchronisée :', err);
  }
  if (!syncTimer) syncTimer = setInterval(syncTick, 80);
}

function syncTick() {
  if (!syncOn() || !knownSegs.length || !timeline.hasMedia || !playCtx) return;
  const last = timeline.media[timeline.media.length - 1];
  if (last.paused) return;
  const vr = last.rate || 1;
  const mediaNow = timeline.wallToMedia(Date.now());
  if (mediaNow === null) return;
  // 1. Préparer les voix des prochaines phrases connues.
  if (helloOk) {
    for (const i of toPrepare(knownSegs, mediaNow, requested, vr)) {
      const seg = knownSegs[i];
      const key = prepKey(seg, vr);
      requested.add(key);
      send({ type: 'tts_fit', id: key, text: seg.fr, voice: settings.voice, rate: settings.rate,
        maxDuration: Math.round(maxDuration(knownSegs, i, vr) * 100) / 100 });
    }
  }
  // 2. Lancer celle dont le début arrive.
  const due = dueToStart(knownSegs, mediaNow, startedIds, vr, START_OFFSET_S);
  if (!due) return;
  const seg = knownSegs[due.index];
  const buf = preparedBuffers.get(prepKey(seg, vr));
  if (buf) {
    startedIds.add(seg.id);
    startSync(seg, buf, due.delayS, mediaNow, vr);
  } else if (due.delayS < -0.25) {
    // Voix pas prête à temps : on laisse le direct prendre le relais.
    startedIds.add(seg.id);
    state.sync.missed += 1;
    syncLog.push({ id: seg.id, start: seg.start, missed: true });
  }
}

function startSync(seg, buffer, delayS, mediaNow, vr) {
  const when = playCtx.currentTime + Math.max(0, delayS);
  for (const old of syncSources) {
    try { old.stop(when); } catch (_) { /* déjà arrêtée */ }
  }
  if (current || queue.length) clearPlayback(); // la voix en direct concerne un passage dépassé
  const src = playCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(frGain);
  src.start(when);
  syncSources.push(src);
  src.onended = () => {
    syncSources = syncSources.filter((x) => x !== src);
    updateGains();
    broadcast();
  };
  // Écart entre le début prévu de la phrase anglaise et celui de la voix.
  const err = Math.round(((mediaNow + Math.max(0, delayS) * vr) - seg.start - START_OFFSET_S) * 1000) / 1000;
  syncErrors.push(Math.abs(err));
  if (syncErrors.length > 200) syncErrors.shift();
  state.sync.played += 1;
  state.sync.avgError = Math.round((syncErrors.reduce((a, b) => a + b, 0) / syncErrors.length) * 1000) / 1000;
  state.sync.maxError = Math.max(...syncErrors);
  syncLog.push({ id: seg.id, start: seg.start, err, delayS, duration: buffer.duration, fr: seg.fr });
  if (syncLog.length > 300) syncLog.shift();
  if (settings.subtitles) {
    setTimeout(() => toSw('subtitle', {
      tabId: state.tabId, fr: seg.fr, en: settings.subtitlesEnglish ? seg.en : '', duration: buffer.duration + 1,
    }), Math.max(0, delayS) * 1000);
  }
  updateGains();
  broadcast();
}

function stopSync() {
  for (const src of syncSources) {
    try { src.onended = null; src.stop(); } catch (_) { /* déjà arrêtée */ }
  }
  syncSources = [];
  startedIds = new Set();
  updateGains();
}

function onPreparedVoice(header, pcm) {
  if (!state.running || !playCtx || !requested.has(header.segId)) return;
  const buffer = playCtx.createBuffer(1, pcm.length, header.sampleRate);
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  preparedBuffers.set(header.segId, buffer);
  if (preparedBuffers.size > 80) preparedBuffers.delete(preparedBuffers.keys().next().value);
}

// ---------------------------------------------------------- lecteur vidéo

let seekDebounce = null;

function onMediaEvent(msg) {
  if (!state.running) return;
  switch (msg.type) {
    case 'time':
      timeline.markMedia({ time: msg.t, rate: msg.rate, paused: msg.paused, wall: msg.wall });
      if (Number.isFinite(msg.duration) && msg.duration > 0 && msg.duration !== mediaDuration) {
        mediaDuration = msg.duration;
        if (currentVideo) refreshVideo();
      }
      return; // fréquent : pas de diffusion d'état
    case 'pageinfo':
      if (msg.top && typeof msg.url === 'string') {
        page = { url: msg.url, title: String(msg.title || '') };
        onPageInfo();
      }
      return;
    case 'hello':
      // Plusieurs cadres peuvent répondre : celui qui contient le lecteur l'emporte.
      if (msg.hasMedia) {
        state.media.found = true;
        state.media.controllable = true;
      }
      if (msg.top) state.media.site = msg.site || 'generique';
      if (msg.rate) onRate(msg.rate);
      toSw('subtitleConfig', { tabId: state.tabId, enabled: !!settings.subtitles });
      break;
    case 'seeked':
    case 'lessonchange':
    case 'srcchange':
      // Saut dans la vidéo ou changement de leçon : ce qui est en attente
      // concerne un autre passage, on le jette.
      clearTimeout(seekDebounce);
      seekDebounce = setTimeout(() => resetEpoch(msg.type), 150);
      stopSync();
      if (state.media.autoPaused) state.media.autoPaused = false;
      break;
    case 'pause':
      if (!msg.byExtension) stopSync(); // vidéo en pause : la voix synchronisée s'arrête aussi
      break;
    case 'ratechange':
      onRate(msg.rate);
      break;
    case 'play':
      if (!msg.byExtension && state.media.autoPaused) state.media.autoPaused = false;
      break;
    case 'gone':
      state.media.found = false;
      state.media.controllable = false;
      break;
    default:
      break;
  }
  broadcast();
}

function onRate(rate) {
  if (typeof rate !== 'number' || !(rate > 0)) return;
  state.media.rate = rate;
  if (serverSettings) {
    serverSettings = { ...serverSettings, videoRate: Math.min(4, Math.max(0.25, rate)) };
    if (helloOk && state.running) send({ type: 'settings', settings: serverSettings });
  }
}

// ------------------------------------------------------------ test de voix

let testCtx = null;

async function testVoice({ voice, rate, settings: s, serverSettings: ss, port: p, token: t }) {
  applySettings(s, ss, p, t);
  const req = { type: 'tts_test', voice, rate };
  ensureSocket();
  if (helloOk) send(req);
  else pendingVoiceTest = req;
  scheduleIdleClose();
  return { ok: true };
}

// Hors session (popup ouverte, test de voix) : la liaison est refermée après
// un moment d'inactivité, puis le document offscreen est fermé.
function scheduleIdleClose() {
  clearTimeout(closeIdleTimer);
  if (state.running) return;
  closeIdleTimer = setTimeout(() => {
    if (state.running) return;
    wsWanted = false;
    clearTimeout(reconnectTimer);
    if (ws) { try { ws.close(1000, 'inactif'); } catch (_) { /* déjà fermé */ } }
    toSw('idle');
  }, 30000);
}

function playTest(pcm, sampleRate) {
  const ctx = playCtx || (testCtx = testCtx || new AudioContext());
  const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  if (playCtx) src.connect(frGain);
  else {
    const g = ctx.createGain();
    g.gain.value = settings ? settings.frenchVolume : 1;
    src.connect(g).connect(ctx.destination);
  }
  ctx.resume().then(() => src.start());
  chrome.runtime.sendMessage({ target: 'ui', type: 'voiceTestPlayed', duration: buffer.duration }).catch(() => {});
}

// Point d'observation réservé aux tests automatisés (test/browser). Il ne fait
// qu'exposer l'état déjà affiché dans la fenêtre de l'extension et permettre
// d'écouter ce que ce document joue, afin de vérifier automatiquement que la
// voix française sort bien du haut-parleur. Rien n'en sort vers l'extérieur :
// seul du code de l'extension peut y accéder, dans ce document.
globalThis.__doublage = {
  snapshot,
  get epoch() { return epoch; },
  timeline,
  get video() { return currentVideo; },
  flushWrites: () => writeChain,
  syncLog,
  queuedSeconds,
  // Renvoie un flux contenant ce qui est envoyé aux haut-parleurs :
  // 'fr' = voix française seule, 'orig' = son de l'onglet seul, sinon les deux.
  // Sortie en stéréo pour mesurer la synchronisation : gauche = son
  // d'origine, droite = voix française.
  tapStereo() {
    if (!playCtx) return null;
    const merger = playCtx.createChannelMerger(2);
    origGain.connect(merger, 0, 0);
    frGain.connect(merger, 0, 1);
    const dest = playCtx.createMediaStreamDestination();
    dest.channelCount = 2;
    merger.connect(dest);
    return dest.stream;
  },
  tapOutput(which) {
    if (!playCtx) return null;
    const dest = playCtx.createMediaStreamDestination();
    if (which !== 'orig') frGain.connect(dest);
    if (which !== 'fr') origGain.connect(dest);
    return dest.stream;
  },
};

toSw('offscreenReady');
