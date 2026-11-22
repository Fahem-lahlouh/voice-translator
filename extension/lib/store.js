// Bibliothèque locale (IndexedDB) : vidéos et phrases traduites.
//
// Tout reste dans le navigateur de ce PC. Aucune donnée n'est envoyée.
// Les phrases sont enregistrées une à une, au fil de la lecture : fermer le
// navigateur ne fait perdre que la phrase en cours.

export const DB_NAME = 'doublage-bibliotheque';
export const DB_VERSION = 2;

// ------------------------------------------------- fonctions pures (testées)

// Fusionne [a, b] dans une liste d'intervalles triés. Deux intervalles
// séparés de moins de `gap` secondes (silence entre deux phrases) sont réunis.
export function mergeInterval(list, a, b, gap = 3) {
  const all = [...list.map((x) => [x[0], x[1]]), [a, b]].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [s, e] of all) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + gap) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out.map(([s, e]) => [Math.round(s * 100) / 100, Math.round(e * 100) / 100]);
}

export function coveredSeconds(list) {
  return list.reduce((n, [s, e]) => n + Math.max(0, e - s), 0);
}

// Part de [a, b] recouverte par [c, d].
function overlap(a, b, c, d) {
  return Math.max(0, Math.min(b, d) - Math.max(a, c));
}

// Une phrase est un doublon si elle recouvre en grande partie une phrase
// déjà enregistrée (retour en arrière, deuxième visionnage).
export function findDuplicate(existing, start, end) {
  const len = Math.max(0.3, end - start);
  for (const s of existing) {
    const o = overlap(start, end, s.start, s.end);
    if (o / len >= 0.5 || o / Math.max(0.3, s.end - s.start) >= 0.5) return s;
  }
  return null;
}

export function segmentId(videoId, start) {
  return `${videoId}#${Math.round(start * 10)}`;
}

// ------------------------------------------------------------- IndexedDB

let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => migrate(req.result, ev.oldVersion);
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => reject(new Error('base de données bloquée par un autre onglet'));
    });
  }
  return dbPromise;
}

// Migrations successives : ajouter un cas par nouvelle version, sans jamais
// modifier les précédents.
function migrate(db, oldVersion) {
  if (oldVersion < 1) {
    const videos = db.createObjectStore('videos', { keyPath: 'id' });
    videos.createIndex('byLastSeen', 'lastSeenAt');
    const segs = db.createObjectStore('segments', { keyPath: 'id' });
    segs.createIndex('byVideo', ['videoId', 'start']);
  }
  if (oldVersion < 2) {
    // Version 2 : résumés (un par vidéo). Les données de la version 1 sont gardées.
    db.createObjectStore('summaries', { keyPath: 'videoId' });
  }
}

function tx(db, stores, mode = 'readonly') {
  return db.transaction(stores, mode);
}

function done(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction annulée'));
  });
}

function req2p(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Crée ou met à jour la fiche d'une vidéo.
export async function upsertVideo(info) {
  const db = await openDb();
  const t = tx(db, ['videos'], 'readwrite');
  const store = t.objectStore('videos');
  const now = Date.now();
  const old = await req2p(store.get(info.id));
  const rec = {
    id: info.id,
    title: info.title || (old && old.title) || 'Vidéo sans titre',
    url: info.url || (old && old.url) || '',
    site: info.site || (old && old.site) || '',
    duration: Number.isFinite(info.duration) && info.duration > 0 ? info.duration : (old && old.duration) || null,
    sourceLang: info.sourceLang || (old && old.sourceLang) || 'en',
    targetLang: info.targetLang || (old && old.targetLang) || 'fr',
    timeBase: info.timeBase || (old && old.timeBase) || 'video',
    createdAt: (old && old.createdAt) || now,
    lastSeenAt: now,
    covered: (old && old.covered) || [],
    segmentCount: (old && old.segmentCount) || 0,
    lastPosition: Number.isFinite(info.position) ? info.position : (old && old.lastPosition) || 0,
  };
  store.put(rec);
  await done(t);
  return rec;
}

// Enregistre une phrase, sauf si elle double une phrase déjà connue.
// Renvoie { status: 'enregistree' | 'doublon', segment, video }.
export async function addSegment(videoId, seg) {
  const db = await openDb();
  const t = tx(db, ['videos', 'segments'], 'readwrite');
  const vids = t.objectStore('videos');
  const segs = t.objectStore('segments');
  const video = await req2p(vids.get(videoId));
  if (!video) throw new Error(`vidéo inconnue : ${videoId}`);
  const range = IDBKeyRange.bound([videoId, seg.start - 60], [videoId, seg.end + 1]);
  const near = await req2p(segs.index('byVideo').getAll(range));
  const dup = video.timeBase === 'video' ? findDuplicate(near, seg.start, seg.end) : null;
  let result;
  if (dup) {
    result = { status: 'doublon', segment: dup, video };
  } else {
    const now = Date.now();
    const rec = {
      id: segmentId(videoId, seg.start),
      videoId,
      start: seg.start,
      end: seg.end,
      en: seg.en || '',
      fr: seg.fr || '',
      // La transcription est stabilisée (le serveur n'envoie que des phrases
      // terminées) ; la traduction reste « provisoire » tant qu'elle n'a pas
      // été relue ou corrigée par l'utilisateur.
      transcriptStatus: 'stable',
      translationStatus: 'provisoire',
      note: '',
      conf: seg.conf || null,
      createdAt: now,
      updatedAt: now,
    };
    segs.put(rec);
    video.covered = mergeInterval(video.covered || [], seg.start, seg.end);
    video.segmentCount = (video.segmentCount || 0) + 1;
    result = { status: 'enregistree', segment: rec, video };
  }
  video.lastSeenAt = Date.now();
  video.lastPosition = Math.max(video.lastPosition || 0, seg.end);
  vids.put(video);
  await done(t);
  return result;
}

export async function getVideo(id) {
  const db = await openDb();
  return req2p(tx(db, ['videos']).objectStore('videos').get(id));
}

export async function listVideos() {
  const db = await openDb();
  const all = await req2p(tx(db, ['videos']).objectStore('videos').getAll());
  return all.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export async function getSegments(videoId) {
  const db = await openDb();
  const range = IDBKeyRange.bound([videoId, -Infinity], [videoId, Infinity]);
  return req2p(tx(db, ['segments']).objectStore('segments').index('byVideo').getAll(range));
}

// Recherche d'une phrase dans toute la bibliothèque (anglais, français, notes).
export async function searchAll(query, limit = 200) {
  const { matches } = await import('./exporters.js');
  const db = await openDb();
  const t = tx(db, ['videos', 'segments']);
  const [videos, segs] = await Promise.all([
    req2p(t.objectStore('videos').getAll()), req2p(t.objectStore('segments').getAll()),
  ]);
  const byId = new Map(videos.map((v) => [v.id, v]));
  const out = [];
  for (const s of segs) {
    if (out.length >= limit) break;
    if (matches(s, query) && byId.has(s.videoId)) out.push({ video: byId.get(s.videoId), segment: s });
  }
  return out;
}

export async function updateSegment(id, patch) {
  const db = await openDb();
  const t = tx(db, ['segments'], 'readwrite');
  const store = t.objectStore('segments');
  const rec = await req2p(store.get(id));
  if (!rec) throw new Error('phrase introuvable');
  const allowed = {};
  if (typeof patch.fr === 'string') {
    allowed.fr = patch.fr.slice(0, 2000);
    allowed.translationStatus = 'validee';
  }
  if (typeof patch.note === 'string') allowed.note = patch.note.slice(0, 2000);
  store.put({ ...rec, ...allowed, updatedAt: Date.now() });
  await done(t);
}

export async function saveSummary(videoId, data) {
  const db = await openDb();
  const t = tx(db, ['summaries'], 'readwrite');
  t.objectStore('summaries').put({ ...data, videoId, createdAt: Date.now() });
  await done(t);
}

export async function getSummary(videoId) {
  const db = await openDb();
  return req2p(tx(db, ['summaries']).objectStore('summaries').get(videoId));
}

export async function deleteVideo(id) {
  const db = await openDb();
  const t = tx(db, ['videos', 'segments', 'summaries'], 'readwrite');
  t.objectStore('videos').delete(id);
  t.objectStore('summaries').delete(id);
  const idx = t.objectStore('segments').index('byVideo');
  const keys = await req2p(idx.getAllKeys(IDBKeyRange.bound([id, -Infinity], [id, Infinity])));
  for (const k of keys) t.objectStore('segments').delete(k);
  await done(t);
}

export async function clearAll() {
  const db = await openDb();
  const t = tx(db, ['videos', 'segments', 'summaries'], 'readwrite');
  t.objectStore('videos').clear();
  t.objectStore('segments').clear();
  t.objectStore('summaries').clear();
  await done(t);
}

export async function stats() {
  const db = await openDb();
  const t = tx(db, ['videos', 'segments']);
  const [videos, segments] = await Promise.all([
    req2p(t.objectStore('videos').count()), req2p(t.objectStore('segments').count()),
  ]);
  return { videos, segments };
}
