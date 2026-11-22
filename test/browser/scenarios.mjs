// Scénarios de bout en bout dans un vrai Chrome, avec le vrai serveur local.
//
//   node test/browser/scenarios.mjs            (tous les scénarios)
//   node test/browser/scenarios.mjs base pause (une sélection)
//
// À lancer sous un affichage X (xvfb-run) : l'extension doit être invoquée par
// un vrai raccourci clavier pour que Chrome accorde l'autorisation activeTab.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as H from './harness.mjs';

const OUT = path.join(H.ROOT, 'test/out');
fs.mkdirSync(OUT, { recursive: true });

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const want = (name) => !only.length || only.includes(name);

// ------------------------------------------------------------- utilitaires

async function session({ serverOpts, startServerFirst = true, profileDir } = {}) {
  const pageSrv = H.startPageServer();
  const server = startServerFirst ? H.startServer(serverOpts) : null;
  await H.sleep(800);
  const { ctx, sw, profileDir: usedProfile } = await H.launch({ profileDir });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${H.PORT}/page/`);
  await page.bringToFront();
  await H.sleep(600);
  // Réglages : port du serveur de test, voix et volumes fixés.
  const extPage = await H.attach('popup.html').catch(() => null);
  if (extPage) extPage.close();
  await sw.evaluate(async (p) => {
    await chrome.storage.local.set({ settings: { serverPort: p, originalVolume: 0.2, frenchVolume: 1,
      subtitles: true, catchupPause: false, voice: 'siwis', rate: 1 } });
  }, serverOpts?.port ?? H.SERVER_PORT);
  return {
    ctx, sw, page, server, pageSrv, profileDir: usedProfile,
    async popup() {
      // Le raccourci referme une popup déjà ouverte : on part d'un état propre.
      for (let i = 0; i < 3; i++) {
        if ((await H.listTargets()).some((t) => t.url.includes('popup.html'))) {
          const old = await H.attach('popup.html');
          await old.closeWindow();
          await H.sleep(400);
        }
        await page.bringToFront();
        await H.sleep(300);
        H.invokeExtension();
        await H.sleep(1000);
        if ((await H.listTargets()).some((t) => t.url.includes('popup.html'))) return H.attach('popup.html');
      }
      throw new Error('la fenêtre de l\'extension ne s\'ouvre pas avec le raccourci clavier');
    },
    async offscreen() { return H.attach('offscreen.html'); },
    async tabId() { return sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id); },
    async state() {
      const off = await H.attach('offscreen.html').catch(() => null);
      if (!off) return null;
      const s = await off.evaluate('return globalThis.__doublage ? __doublage.snapshot() : null;');
      off.close();
      return s;
    },
    async close() {
      await ctx.close().catch(() => {});
      if (server) await server.stop();
      pageSrv.stop();
    },
  };
}

async function startDubbing(S, popup) {
  const p = popup || await S.popup();
  await p.evaluate('document.getElementById("start").click(); return true;');
  // Attendre que la capture soit réellement en cours (le clic est asynchrone).
  await H.waitFor('capture de l\'onglet démarrée', async () => {
    const st = await S.state();
    if (st && st.error && st.error.code === 'capture') throw new Error(st.error.message);
    return st && st.running;
  }, { timeout: 20000 });
  return p;
}

async function waitReady(S, timeout = 300000) {
  return H.waitFor('moteurs du serveur prêts', async () => {
    const s = await S.state();
    return s && s.server.connected && s.server.ready ? s : false;
  }, { timeout });
}

async function waitSegment(S, { minFr = 1, timeout = 90000 } = {}) {
  return H.waitFor(`${minFr} phrase(s) française(s) produite(s)`, async () => {
    const off = await H.attach('offscreen.html').catch(() => null);
    if (!off) return false;
    const n = await off.evaluate('return globalThis.__vtSeen ? __vtSeen.length : 0;');
    const s = await off.evaluate('return __doublage.snapshot();');
    off.close();
    return n >= minFr ? s : false;
  }, { timeout });
}

// Compteur de phrases françaises jouées, installé dans le document offscreen
// (il observe le flux de sortie, il ne remplace aucun moteur).
async function instrument(S) {
  const off = await S.offscreen();
  await off.evaluate(`
    if (!globalThis.__vtSeen) {
      globalThis.__vtSeen = [];
      const orig = globalThis.__doublage.snapshot;
      globalThis.__vtTimer = setInterval(() => {
        const s = orig();
        const fr = s.last.fr;
        if (fr && (!__vtSeen.length || __vtSeen[__vtSeen.length - 1].fr !== fr)) {
          __vtSeen.push({ fr, en: s.last.en, t: Date.now() });
        }
      }, 120);
    }
    return true;`);
  off.close();
}

async function seen(S) {
  const off = await H.attach('offscreen.html').catch(() => null);
  if (!off) return [];
  const v = await off.evaluate('return globalThis.__vtSeen || [];');
  off.close();
  return v;
}

// --------------------------------------------------------------- scénarios

const TESTS = {};

// 1) Parcours complet : phrase anglaise -> voix française réellement jouée.
TESTS.base = async () => {
  const S = await session();
  try {
    const popup = await S.popup();
    H.record('popup ouverte par le raccourci clavier', !!popup);
    await startDubbing(S, popup);
    await instrument(S);
    const ready = await waitReady(S);
    H.record('serveur local connecté et moteurs prêts', !!ready,
      `profil ${ready.server.profile}, modèle ${ready.server.asrModel}`);

    // Enregistre ce qui sort réellement du haut-parleur, voix française seule.
    const off = await S.offscreen();
    await off.evaluate(`
      const s = __doublage.tapOutput('fr');
      const rec = new MediaRecorder(s, { mimeType: 'audio/webm;codecs=opus' });
      globalThis.__chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) __chunks.push(e.data); };
      rec.start(500);
      globalThis.__rec = rec;
      return true;`);

    await S.page.evaluate(() => document.getElementById('play').click());
    const st = await waitSegment(S, { minFr: 3, timeout: 120000 });
    H.record('phrases anglaises transcrites et traduites', true,
      `${(await seen(S)).length} phrase(s)`);
    H.record('retard mesuré pendant la lecture', st.metrics.lag !== null && st.metrics.lag < 8,
      `≈ ${st.metrics.lag} s entre la fin de la phrase anglaise et le début de la voix française`);
    H.record('capture convertie en 16 kHz pour la reconnaissance',
      st.capture && st.capture.sampleRate === 16000,
      `contexte de capture à ${st.capture ? st.capture.sampleRate : '?'} Hz, sortie à ${st.capture ? st.capture.outputRate : '?'} Hz`);

    await H.sleep(3000);
    const b64 = await off.evaluate(`
      __rec.stop();
      await new Promise((r) => setTimeout(r, 400));
      const blob = new Blob(__chunks, { type: 'audio/webm' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return btoa(s);`);
    off.close();
    const webm = path.join(OUT, 'voix-francaise.webm');
    fs.writeFileSync(webm, Buffer.from(b64, 'base64'));
    const wav = path.join(OUT, 'voix-francaise.wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', webm, '-ac', '1', '-ar', '16000', wav]);
    const size = fs.statSync(wav).size;
    H.record('voix française réellement envoyée aux haut-parleurs', size > 16000 * 2 * 2,
      `${(size / 32000).toFixed(1)} s d'audio enregistré en sortie`);

    const phrases = await seen(S);
    fs.writeFileSync(path.join(OUT, 'phrases.json'), JSON.stringify(phrases, null, 1));

    // Vérification indépendante : re-transcrire la sortie et détecter le français.
    try {
      const check = execFileSync(H.PY, [path.join(H.HERE, 'verifier_audio.py'), wav], { encoding: 'utf8' }).trim();
      const r = JSON.parse(check);
      H.record('langue de la voix produite = français', r.language === 'fr',
        `langue détectée « ${r.language} » (confiance ${r.probability}) : « ${r.text.slice(0, 80)}… »`);
    } catch (e) {
      H.record('langue de la voix produite = français', false, `vérification impossible : ${e.message}`);
    }

    // 2) Fermeture de la popup : le doublage continue.
    const before = (await seen(S)).length;
    await popup.closeWindow();
    await H.sleep(500);
    const noPopup = !(await H.listTargets()).some((t) => t.url.includes('popup.html'));
    H.record('popup effectivement fermée', noPopup);
    await H.waitFor('nouvelles phrases après fermeture de la popup',
      async () => (await seen(S)).length > before, { timeout: 60000 });
    H.record('la traduction continue après la fermeture de la popup', true,
      `${(await seen(S)).length - before} phrase(s) supplémentaires`);
  } finally { await S.close(); }
};

// 3) Pause, reprise, arrêt, redémarrage, libération de la capture.
TESTS.controles = async () => {
  const S = await session();
  try {
    const popup = await startDubbing(S, await S.popup());
    await instrument(S);
    await waitReady(S);
    await S.page.evaluate(() => document.getElementById('play').click());
    await waitSegment(S, { minFr: 1, timeout: 120000 });

    await popup.evaluate('document.getElementById("pause").click(); return true;');
    await H.sleep(1200);
    let st = await S.state();
    H.record('pause : état « en pause », file de lecture vidée', st.paused && st.metrics.queue === 0,
      `statut ${st.status}, file ${st.metrics.queue} s`);
    const nPause = (await seen(S)).length;
    await H.sleep(6000);
    H.record('pause : plus aucune nouvelle phrase', (await seen(S)).length === nPause);

    await popup.evaluate('document.getElementById("pause").click(); return true;');
    await H.sleep(800);
    st = await S.state();
    H.record('reprise : capture de nouveau active', !st.paused && st.running, `statut ${st.status}`);
    await H.waitFor('nouvelles phrases après la reprise',
      async () => (await seen(S)).length > nPause, { timeout: 90000 });
    H.record('reprise : la traduction repart', true);

    await popup.evaluate('document.getElementById("stop").click(); return true;');
    await H.sleep(1500);
    // Chrome peut encore lister l'onglet, mais avec le statut « stopped » :
    // ce qui compte est qu'aucune capture ne soit plus active.
    const captured = await S.sw.evaluate(async () => chrome.tabCapture.getCapturedTabs());
    H.record('arrêt : capture de l\'onglet libérée',
      captured.every((c) => c.status === 'stopped' || c.status === 'error'),
      `tabCapture.getCapturedTabs() = ${JSON.stringify(captured)}`);
    const targets = await H.listTargets();
    H.record('arrêt : document de traitement audio fermé',
      !targets.some((t) => t.url.includes('offscreen.html')));
    const badge = await S.sw.evaluate(async () => chrome.action.getBadgeText({}));
    H.record('arrêt : pastille de l\'icône remise à zéro', badge === '', `pastille « ${badge} »`);

    // Redémarrage après arrêt.
    const popup2 = await S.popup();
    await popup2.evaluate('document.getElementById("start").click(); return true;');
    await instrument(S);
    await waitReady(S);
    await S.page.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 0; v.play(); });
    await waitSegment(S, { minFr: 1, timeout: 120000 });
    H.record('redémarrage après arrêt complet', true);
    popup2.close();
  } finally { await S.close(); }
};

// 4) Changement de leçon et retour arrière : les résultats périmés sont jetés.
TESTS.navigation = async () => {
  const S = await session();
  try {
    const popup = await startDubbing(S, await S.popup());
    await instrument(S);
    await waitReady(S);
    await S.page.evaluate(() => document.getElementById('play').click());
    await waitSegment(S, { minFr: 2, timeout: 120000 });
    const st1 = await S.state();
    H.record('lecteur vidéo détecté sur la page', st1.media.found && st1.media.controllable,
      `site « ${st1.media.site} »`);

    const e1 = (await S.state()) && await (async () => {
      const off = await H.attach('offscreen.html'); const e = await off.evaluate('return __doublage.epoch;'); off.close(); return e;
    })();
    await S.page.evaluate(() => document.getElementById('back').click());
    await H.sleep(1500);
    const off2 = await H.attach('offscreen.html');
    const e2 = await off2.evaluate('return __doublage.epoch;');
    const q2 = await off2.evaluate('return __doublage.queuedSeconds();');
    off2.close();
    H.record('retour arrière : travail en cours annulé (nouvelle époque)', e2 > e1, `époque ${e1} → ${e2}`);
    H.record('retour arrière : file de voix vidée', q2 < 0.6, `${q2.toFixed(2)} s en attente`);

    await S.page.evaluate(() => document.getElementById('switch').click());
    await H.sleep(1800);
    const off3 = await H.attach('offscreen.html');
    const e3 = await off3.evaluate('return __doublage.epoch;');
    off3.close();
    H.record('changement de leçon : nouvelle époque', e3 > e2, `époque ${e2} → ${e3}`);

    await S.page.evaluate(() => { document.getElementById('fast').click(); });
    await H.sleep(1200);
    const st3 = await S.state();
    H.record('changement de vitesse de lecture transmis', Math.abs(st3.media.rate - 1.25) < 0.01,
      `vitesse ${st3.media.rate}×`);
    popup.close();
  } finally { await S.close(); }
};

// 5) Silences : aucune phrase inventée pendant un passage sans parole.
TESTS.silence = async () => {
  const S = await session();
  try {
    const popup = await startDubbing(S, await S.popup());
    await instrument(S);
    await waitReady(S);
    // La vidéo reste en pause : l'onglet n'émet aucun son pendant 75 s.
    // C'est aussi le test de la durée de vie du document « offscreen » :
    // Chrome ferme au bout de 30 s un document déclaré pour la seule lecture
    // audio. Le nôtre déclare aussi USER_MEDIA, qui n'a pas de limite — à
    // vérifier en vrai, et pas seulement dans le code de Chromium.
    await H.sleep(75000);
    const phrases = await seen(S);
    H.record('silence : aucune phrase inventée', phrases.length === 0,
      phrases.length ? `phrases produites : ${JSON.stringify(phrases.slice(0, 2))}` : '75 s de silence');
    const vivant = (await H.listTargets()).some((t) => t.url.includes('offscreen.html'));
    H.record('silence prolongé : le traitement audio n\'est pas fermé par Chrome', vivant,
      '75 s sans aucun son capté ni joué');
    const st = await S.state();
    H.record('silence : la session est toujours active', !!st && st.running && !st.paused,
      st ? `statut ${st.status}` : 'état introuvable');
    H.record('silence : diagnostic « aucun son capté » affiché',
      !!st && !!st.warning && /Aucun son/.test(st.warning), (st && st.warning) || 'aucun message');
    // Et la traduction doit repartir immédiatement après le silence.
    await S.page.evaluate(() => document.getElementById('play').click());
    await waitSegment(S, { minFr: 1, timeout: 120000 });
    H.record('silence : la traduction repart dès le retour du son', true);
    popup.close();
  } finally { await S.close(); }
};

// 6) Aucune boucle audio : la voix française n'est jamais re-transcrite.
TESTS.boucle = async () => {
  const S = await session();
  try {
    const popup = await startDubbing(S, await S.popup());
    await instrument(S);
    await waitReady(S);
    // Vidéo en pause (onglet muet) ; on fait parler la voix française en boucle.
    for (let i = 0; i < 6; i++) {
      await popup.evaluate('document.getElementById("testVoice").click(); return true;').catch(() => {});
      await H.sleep(2500);
    }
    await H.sleep(3000);
    const phrases = await seen(S);
    const st = await S.state();
    H.record('la voix française n\'est pas réinjectée dans la reconnaissance',
      phrases.length === 0 && st.metrics.asrBacklog === 0,
      phrases.length ? `phrases parasites : ${JSON.stringify(phrases.slice(0, 2))}`
                     : 'aucune parole détectée pendant la lecture de la voix française');
    popup.close();
  } finally { await S.close(); }
};

// 7) Serveur local indisponible, puis démarré : reconnexion automatique.
TESTS.serveur = async () => {
  const S = await session({ startServerFirst: false });
  let server = null;
  try {
    const popup = await startDubbing(S, await S.popup());
    await H.sleep(3000);
    let st = await S.state();
    H.record('serveur absent : message d\'erreur compréhensible',
      !!st.error && /injoignable/.test(st.error.message), st.error ? st.error.message.slice(0, 110) : 'aucune erreur');
    H.record('serveur absent : la capture reste active, prête à reprendre', st.running);

    server = H.startServer({ port: H.SERVER_PORT });
    await instrument(S).catch(() => {});
    await H.waitFor('reconnexion automatique au serveur', async () => {
      const s = await S.state();
      return s && s.server.connected;
    }, { timeout: 60000 });
    H.record('reconnexion automatique dès que le serveur démarre', true);
    await waitReady(S);
    await instrument(S);
    await S.page.evaluate(() => document.getElementById('play').click());
    await waitSegment(S, { minFr: 1, timeout: 120000 });
    H.record('traduction opérationnelle après la reconnexion', true);
    popup.close();
  } finally {
    await S.close();
    if (server) await server.stop();
  }
};

// 8) Routage audio : baisser la voix originale ne coupe pas la transcription.
TESTS.routage = async () => {
  const S = await session();
  try {
    const popup = await startDubbing(S, await S.popup());
    await instrument(S);
    await waitReady(S);
    await popup.evaluate(`
      const el = document.getElementById('originalVolume');
      el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await H.sleep(600);
    const stored = await S.sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.originalVolume);
    H.record('volume de la voix originale réglé à 0', stored === 0, `valeur enregistrée ${stored}`);
    await S.page.evaluate(() => document.getElementById('play').click());
    await waitSegment(S, { minFr: 2, timeout: 120000 });
    H.record('la transcription continue avec la voix originale coupée', true,
      `${(await seen(S)).length} phrase(s) traduites`);
    popup.close();
  } finally { await S.close(); }
};

// 9) Traitement trop lent : files bornées, passages abandonnés, pas de retard infini.
TESTS.surcharge = async () => {
  const cfg = path.join(OUT, 'config-surcharge.json');
  // Serveur volontairement bridé (profil lourd, un seul fil de calcul, file
  // d'attente très courte) et vidéo très accélérée et bouclée : on force la
  // situation « le PC ne suit pas » pour vérifier que le retard ne s'accumule
  // pas indéfiniment et que l'utilisateur en est informé.
  fs.writeFileSync(cfg, JSON.stringify({
    profile: 'qualite', cpu_threads: 1, beam_size: 5,
    max_asr_backlog_s: 1.0, fast_mode_backlog_s: 0.5,
    soft_max_segment_s: 4.0, hard_max_segment_s: 6.0, min_silence_s: 0.25,
  }, null, 1));
  const S = await session({ serverOpts: { profile: 'qualite', extraArgs: ['--config', cfg] } });
  try {
    const popup = await startDubbing(S, await S.popup());
    await instrument(S);
    await waitReady(S);
    await S.page.evaluate(() => {
      const v = document.getElementById('v');
      v.loop = true; v.playbackRate = 3; v.play();
    });
    // Mesures pendant la surcharge (et non après coup).
    let maxBacklog = 0; let maxQueue = 0; let dropped = 0; let skipped = 0; let warning = '';
    for (let i = 0; i < 40; i++) {
      await H.sleep(1500);
      const m = await S.state();
      if (!m) continue;
      maxBacklog = Math.max(maxBacklog, m.metrics.asrBacklog || 0);
      maxQueue = Math.max(maxQueue, m.metrics.queue || 0);
      dropped = Math.max(dropped, m.metrics.dropped || 0);
      skipped = Math.max(skipped, m.metrics.skipped || 0);
      if (m.warning && !/Aucun son/.test(m.warning)) warning = m.warning;
    }
    H.record('surcharge : des passages sont abandonnés plutôt qu\'accumulés', dropped > 0 || skipped > 0,
      `${dropped} abandonné(s) côté serveur, ${skipped} sauté(s) à la lecture`);
    H.record('surcharge : les files restent bornées', maxBacklog <= 10 && maxQueue <= 20,
      `maximum observé : attente serveur ${maxBacklog.toFixed(1)} s, file de voix ${maxQueue.toFixed(1)} s`);
    H.record('surcharge : la traduction continue malgré tout', (await seen(S)).length > 0,
      `${(await seen(S)).length} phrase(s) tout de même traduites`);
    H.record('surcharge : avertissement affiché à l\'utilisateur', !!warning, warning.slice(0, 110) || 'aucun');
    popup.close();
  } finally { await S.close(); }
};

// 10) Pause automatique de la vidéo pour laisser la traduction rattraper.
TESTS.pauseauto = async () => {
  const cfg = path.join(OUT, 'config-pauseauto.json');
  fs.writeFileSync(cfg, JSON.stringify({
    profile: 'qualite', cpu_threads: 1, beam_size: 5, max_asr_backlog_s: 20,
    soft_max_segment_s: 4.0, hard_max_segment_s: 6.0, min_silence_s: 0.25,
  }, null, 1));
  const S = await session({ serverOpts: { profile: 'qualite', extraArgs: ['--config', cfg] } });
  try {
    const popup = await startDubbing(S, await S.popup());
    await popup.evaluate(`
      const el = document.getElementById('catchupPause');
      if (!el.checked) el.click();
      return el.checked;`);
    await H.sleep(500);
    await instrument(S);
    await waitReady(S);
    await S.page.evaluate(() => {
      const v = document.getElementById('v');
      v.loop = true; v.playbackRate = 3; v.play();
    });
    let paused = false; let resumed = false; let sawAutoPause = false;
    for (let i = 0; i < 40 && !(paused && resumed); i++) {
      await H.sleep(1200);
      const st = await S.state();
      if (st && st.media.autoPaused) sawAutoPause = true;
      const isPaused = await S.page.evaluate(() => document.getElementById('v').paused);
      if (isPaused) paused = true;
      else if (paused) resumed = true;
    }
    H.record('pause automatique : la vidéo est mise en pause quand la voix est en retard',
      paused && sawAutoPause, paused ? 'vidéo mise en pause par l\'extension' : 'jamais déclenchée');
    H.record('pause automatique : la vidéo repart une fois le retard rattrapé', resumed);
    const st = await S.state();
    H.record('pause automatique : état final cohérent (vidéo relancée, pas bloquée)',
      !st.media.autoPaused || st.metrics.queue > 0,
      `autoPaused=${st.media.autoPaused}, file ${st.metrics.queue} s`);
    popup.close();
  } finally { await S.close(); }
};

// 11) Page d'options : test de connexion, glossaire, conservation des réglages.
TESTS.options = async () => {
  const S = await session();
  try {
    await H.sleep(4000);
    const opt = await S.ctx.newPage();
    await opt.goto(`chrome-extension://${new URL(S.sw.url()).host}/options.html`);
    await opt.fill('#serverPort', String(H.SERVER_PORT));
    await opt.click('#testServer');
    await opt.waitForFunction(() => !/en cours/.test(document.getElementById('probe').textContent), null, { timeout: 10000 });
    const probe = await opt.textContent('#probe');
    H.record('options : test de connexion au serveur local', /répond sur le port/.test(probe) && !/n'est pas/.test(probe), probe);
    const n = Number(await opt.textContent('#count'));
    H.record('options : glossaire par défaut chargé', n >= 10, `${n} entrées`);
    await opt.fill('#glossary', 'TIBCO | tipco\nligne = \n= sans terme');
    await opt.click('#save');
    const err = await opt.textContent('#glossaryErrors');
    H.record('options : glossaire invalide refusé avec un message', /terme manquant/.test(err), err.trim());
    await opt.fill('#glossary', 'TIBCO | tipco\nshared resource = ressource partagée\nfr: conférence => leçon\n');
    await opt.click('#save');
    await H.sleep(300);
    await opt.reload();
    await H.sleep(500);
    const kept = await opt.inputValue('#glossary');
    H.record('options : glossaire personnalisé conservé après rechargement', kept.includes('ressource partagée'));
    await opt.close();
  } finally { await S.close(); }
};

// 12) Bibliothèque : datation dans la vidéo, doublons, conservation.
TESTS.bibliotheque = async () => {
  // Débuts réels des phrases de l'extrait (mesurés hors navigateur).
  const REF = { 'Give it a name': 16.9, 'Every time a request': 30.8, 'Next, we need': 38.0 };
  const S = await session();
  let profileDir = S.profileDir;
  const readDb = async (off) => off.evaluate(`
    const st = await import('./lib/store.js');
    const vids = await st.listVideos();
    const segs = vids.length ? await st.getSegments(vids[0].id) : [];
    return { vids, segs };`);
  try {
    const popup = await startDubbing(S, await S.popup());
    await instrument(S);
    await waitReady(S);
    await S.page.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 0; v.play(); });
    await H.waitFor('phrase « Give it a name » enregistrée', async () => {
      const off = await H.attach('offscreen.html'); const db = await readDb(off); off.close();
      return db.segs.some((x) => /give it a name/i.test(x.en));
    }, { timeout: 90000 });

    // Retour en arrière de 20 s : les passages déjà traduits ne doivent pas être dupliqués.
    await S.page.evaluate(() => document.getElementById('back').click());
    await H.sleep(14000);
    // Puis vitesse × 1,25 jusqu'à la phrase de 38 s.
    await S.page.evaluate(() => { document.getElementById('fast').click(); });
    await H.waitFor('phrase « Next, we need » enregistrée', async () => {
      const off = await H.attach('offscreen.html'); const db = await readDb(off); off.close();
      return db.segs.some((x) => /next, we need/i.test(x.en));
    }, { timeout: 90000 });
    await H.sleep(1500);

    const off = await H.attach('offscreen.html');
    const st = await off.evaluate('return __doublage.snapshot();');
    const db = await readDb(off);
    off.close();
    const v = db.vids[0];
    H.record('bibliothèque : fiche de la vidéo créée', db.vids.length === 1 && /Page de test/.test(v.title),
      `« ${v && v.title} », identifiant ${v && v.id}, durée ${v && v.duration && v.duration.toFixed(1)} s`);
    H.record('bibliothèque : phrases datées dans le temps de la vidéo', v && v.timeBase === 'video',
      `${db.segs.length} phrase(s) enregistrée(s)`);
    for (const [txt, ref] of Object.entries(REF)) {
      const seg = db.segs.find((x) => x.en.toLowerCase().includes(txt.toLowerCase()));
      const ecart = seg ? Math.abs(seg.start - ref) : Infinity;
      H.record(`datation « ${txt}… » (${txt === 'Next, we need' ? 'lue à × 1,25' : 'lue à × 1'})`, ecart <= 1.0,
        seg ? `début ${seg.start.toFixed(2)} s, attendu ≈ ${ref} s (écart ${ecart.toFixed(2)} s)` : 'phrase absente');
    }
    let overlaps = 0;
    const sorted = [...db.segs].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const o = Math.min(sorted[i - 1].end, sorted[i].end) - sorted[i].start;
      if (o > 0.5 * (sorted[i].end - sorted[i].start)) overlaps++;
    }
    H.record('retour en arrière : aucun doublon enregistré', overlaps === 0 && st.library.duplicates > 0,
      `${st.library.duplicates} passage(s) réentendu(s) reconnu(s) comme déjà traduit(s), ${overlaps} chevauchement(s)`);
    H.record('progression calculée', v && v.covered.length > 0 && v.duration > 70,
      `${Math.round(st.library.progress * 100)} % de la vidéo couverts`);

    // Écran bibliothèque pendant la session : « aller à ce moment » fait
    // sauter la vidéo de l'onglet doublé.
    const lib = await S.ctx.newPage();
    await lib.goto(`chrome-extension://${new URL(S.sw.url()).host}/library.html#video=${encodeURIComponent(v.id)}`);
    await lib.waitForSelector('#segments li');
    const target = db.segs.find((x) => /give it a name/i.test(x.en));
    await lib.locator(`[id="seg-${target.id}"] button.time`).click();
    const t0 = Date.now();
    await H.sleep(600);
    // La vidéo continue de jouer après le saut : on retranche le temps écoulé.
    const vid = await S.page.evaluate(() => { const x = document.getElementById('v'); return { t: x.currentTime, r: x.playbackRate }; });
    const landed = vid.t - ((Date.now() - t0) / 1000) * vid.r;
    H.record('bibliothèque : « aller à ce moment » positionne la vidéo doublée', Math.abs(landed - target.start) < 0.8,
      `arrivée ≈ ${landed.toFixed(1)} s, phrase à ${target.start.toFixed(1)} s`);
    await lib.close();
    popup.close();
  } finally {
    await S.ctx.close().catch(() => {});
    if (S.server) await S.server.stop();
    S.pageSrv.stop();
  }

  // Navigateur fermé puis relancé avec le même profil : tout doit être là.
  const { ctx, sw } = await H.launch({ profileDir });
  try {
    const extId = new URL(sw.url()).host;
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await H.sleep(800);
    const stats = await opt.textContent('#libStats');
    const n = await opt.evaluate(async () => {
      const st = await import('./lib/store.js');
      const vids = await st.listVideos();
      return vids.length ? (await st.getSegments(vids[0].id)).length : 0;
    });
    H.record('conservation après fermeture du navigateur', n > 5 && /1 vidéo/.test(stats), `${stats.trim()}`);
  } finally {
    await ctx.close().catch(() => {});
  }
};

// 13) Lecture synchronisée : phrases déjà traduites jouées pile au bon moment.
TESTS.synchro = async () => {
  const S = await session();
  try {
    const popup = await startDubbing(S, await S.popup());
    // Son d'origine à plein volume et sans atténuation : sert de référence.
    await S.sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, originalVolume: 1, duck: false } });
    });
    await instrument(S);
    await waitReady(S);
    // 1er passage en direct : la vidéo est traduite et enregistrée.
    await S.page.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 0; v.play(); });
    await H.waitFor('premier passage enregistré jusqu\'à 40 s', async () => {
      const st = await S.state();
      const t = await S.page.evaluate(() => document.getElementById('v').currentTime);
      return st && st.sync.known >= 9 && t >= 45 ? st : false;
    }, { timeout: 120000 });

    // 2e passage : retour au début, la lecture doit être synchronisée.
    const off = await S.offscreen();
    await off.evaluate(`
      const s = __doublage.tapStereo();
      const rec = new MediaRecorder(s, { mimeType: 'audio/webm;codecs=opus' });
      globalThis.__chunks = []; rec.ondataavailable = (e) => { if (e.data.size) __chunks.push(e.data); };
      rec.start(500); globalThis.__rec = rec; return true;`);
    await S.page.evaluate(() => { document.getElementById('v').currentTime = 0; });
    await H.sleep(30000);
    const b64 = await off.evaluate(`
      __rec.stop(); await new Promise((r) => setTimeout(r, 400));
      const buf = new Uint8Array(await new Blob(__chunks).arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]); return btoa(s);`);
    const st = await S.state();
    const log = await off.evaluate('return __doublage.syncLog;');
    off.close();
    const webm = path.join(OUT, 'synchro.webm');
    const wav = path.join(OUT, 'synchro.wav');
    fs.writeFileSync(webm, Buffer.from(b64, 'base64'));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', webm, '-ac', '2', '-ar', '16000', wav]);
    const m = JSON.parse(execFileSync('python3', [path.join(H.HERE, 'mesure_synchro.py'), wav], { encoding: 'utf8' }));
    fs.writeFileSync(path.join(OUT, 'synchro.json'), JSON.stringify({ mesure: m, journal: log }, null, 1));
    const played = log.filter((x) => !x.missed);
    H.record('second passage : phrases jouées par la lecture synchronisée', played.length >= 6,
      `${played.length} phrase(s) calée(s), ${st.sync.missed} manquée(s)`);
    H.record('écart mesuré dans l\'audio entre l\'anglais et le français', m.median_abs !== null && m.median_abs <= 0.3,
      `médiane ${m.median_abs} s, maximum ${m.max_abs} s sur ${m.appariees} début(s) apparié(s), `
      + `${m.non_appariees.length} non apparié(s) (avant : 1 à 5 s)`);
    H.record('pas de double voix : le direct est coupé sur les passages calés', st.sync.suppressed > 0,
      `${st.sync.suppressed} phrase(s) en direct écartée(s)`);

    // Pause : la voix synchronisée s'arrête avec la vidéo.
    await S.page.evaluate(() => { document.getElementById('v').currentTime = 0; });
    await H.waitFor('une phrase calée en cours', async () => (await S.state()).sync.speaking, { timeout: 20000 });
    await S.page.evaluate(() => document.getElementById('v').pause());
    await H.sleep(500);
    H.record('pause de la vidéo : la voix calée s\'arrête', !(await S.state()).sync.speaking);

    // Vitesse × 1,25 : toujours calé.
    const n0 = (await S.state()).sync.played;
    await S.page.evaluate(() => { const v = document.getElementById('v'); v.playbackRate = 1.25; v.currentTime = 0; v.play(); });
    await H.sleep(16000);
    const off2 = await S.offscreen();
    const log2 = (await off2.evaluate('return __doublage.syncLog;')).slice(-8).filter((x) => !x.missed);
    off2.close();
    const st2 = await S.state();
    const errs = log2.map((x) => Math.abs(x.err));
    H.record('vitesse × 1,25 : phrases toujours calées', st2.sync.played - n0 >= 3 && Math.max(...errs) <= 0.3,
      `${st2.sync.played - n0} phrase(s), écart calculé max ${Math.max(...errs).toFixed(2)} s`);
    popup.close();
  } finally { await S.close(); }
};

// 14) « Préparer le doublage » : tout traduire à l'avance, puis premier visionnage calé.
TESTS.preparation = async () => {
  const S = await session();
  const record = async (off) => off.evaluate(`
    const s = __doublage.tapStereo();
    const rec = new MediaRecorder(s, { mimeType: 'audio/webm;codecs=opus' });
    globalThis.__chunks = []; rec.ondataavailable = (e) => { if (e.data.size) __chunks.push(e.data); };
    rec.start(500); globalThis.__rec = rec; return true;`);
  const save = async (off, name) => {
    const b64 = await off.evaluate(`
      __rec.stop(); await new Promise((r) => setTimeout(r, 400));
      const buf = new Uint8Array(await new Blob(__chunks).arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]); return btoa(s);`);
    const webm = path.join(OUT, `${name}.webm`);
    const wav = path.join(OUT, `${name}.wav`);
    fs.writeFileSync(webm, Buffer.from(b64, 'base64'));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', webm, '-ac', '2', '-ar', '16000', wav]);
    return wav;
  };
  try {
    await S.sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, originalVolume: 1, duck: false } });
    });
    const popup = await S.popup();
    await popup.evaluate('document.getElementById("prepare").click(); return true;');
    await H.waitFor('préparation lancée', async () => {
      const st = await S.state();
      if (st && st.prepare && st.prepare.error) throw new Error(st.prepare.error);
      return st && st.prepare && st.prepare.active;
    }, { timeout: 60000 });
    await instrument(S);
    const off = await S.offscreen();
    await record(off);
    const t0 = Date.now();
    await H.sleep(4000);
    const rate = await S.page.evaluate(() => document.getElementById('v').playbackRate);
    H.record('préparation : vidéo lue en accéléré', Math.abs(rate - 1.5) < 0.01 || rate === 1.25, `× ${rate}`);
    const st = await H.waitFor('préparation terminée', async () => {
      const x = await S.state();
      return x && x.prepare.phase === 'pret' ? x : false;
    }, { timeout: 180000, step: 1000 });
    const elapsed = (Date.now() - t0) / 1000;
    const silentWav = await save(off, 'preparation');
    const silence = JSON.parse(execFileSync(H.PY, ['-c', `
import wave, numpy as np, json
w = wave.open(${JSON.stringify(silentWav)}); a = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').reshape(-1, 2)
print(json.dumps({"orig": float(np.abs(a[:, 0]).max()), "fr": float(np.abs(a[:, 1]).max())}))`], { encoding: 'utf8' }));
    H.record('préparation : son coupé, aucune voix jouée', silence.orig < 200 && silence.fr < 200,
      `crête son d'origine ${silence.orig}, crête voix française ${silence.fr} (sur 32767)`);
    H.record('préparation plus rapide que la vidéo', elapsed < 76 * 0.85,
      `${elapsed.toFixed(0)} s pour une vidéo de 76 s (dont la finalisation)`);
    const v = await S.page.evaluate(() => { const x = document.getElementById('v'); return { t: x.currentTime, r: x.playbackRate, p: x.paused }; });
    H.record('fin de préparation : retour au début, vidéo en pause, vitesse rétablie',
      v.p && v.t < 1.5 && Math.abs(v.r - 1) < 0.01, `position ${v.t.toFixed(1)} s, × ${v.r}, ${v.p ? 'en pause' : 'en lecture'}`);
    const db = await off.evaluate(`
      const st = await import('./lib/store.js'); const vids = await st.listVideos();
      return { segs: await st.getSegments(vids[0].id), video: vids[0] };`);
    const script = fs.readFileSync(path.join(H.ROOT, 'test/audio/tibco_demo_en.txt'), 'utf8');
    const words = (t) => t.toLowerCase().match(/[a-z0-9']+/g) || [];
    const ref = words(script);
    const got = words(db.segs.map((x) => x.en).join(' '));
    const common = ref.filter((w) => got.includes(w)).length;
    const lastEnd = Math.max(...db.segs.map((x) => x.end));
    H.record('préparation : toute la vidéo traduite et enregistrée', lastEnd > 70 && common / ref.length > 0.9,
      `${db.segs.length} phrase(s), jusqu'à ${lastEnd.toFixed(1)} s, ${Math.round(100 * common / ref.length)} % des mots du texte de référence retrouvés`);

    // Premier visionnage : tout doit être calé dès le début.
    await record(off);
    await S.page.evaluate(() => document.getElementById('v').play());
    await H.sleep(32000);
    const wav = await save(off, 'apres-preparation');
    const m = JSON.parse(execFileSync('python3', [path.join(H.HERE, 'mesure_synchro.py'), wav], { encoding: 'utf8' }));
    const st2 = await S.state();
    off.close();
    fs.writeFileSync(path.join(OUT, 'preparation.json'), JSON.stringify({ mesure: m, prepare: st.prepare, sync: st2.sync }, null, 1));
    H.record('premier visionnage après préparation : voix calée sur l\'anglais',
      m.median_abs !== null && m.median_abs <= 0.3 && st2.sync.played >= 6 && st2.sync.missed === 0,
      `${st2.sync.played} phrase(s) calée(s), écart médian ${m.median_abs} s, max ${m.max_abs} s, ${st2.sync.missed} manquée(s)`);
    popup.close();
  } finally { await S.close(); }
};

// 15) Écran « Ma bibliothèque » (données de test déterministes).
TESTS.bibliothequeui = async () => {
  const { ctx, sw } = await H.launch();
  try {
    const extId = new URL(sw.url()).host;
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/library.html`);
    await page.evaluate(async () => {
      const st = await import('./lib/store.js');
      await st.clearAll();
      const add = async (v, segs) => { await st.upsertVideo(v); for (const s of segs) await st.addSegment(v.id, s); };
      await add({ id: 'youtube:abc', url: 'https://www.youtube.com/watch?v=abc', site: 'youtube', duration: 600,
        title: 'Zebra <img src=x onerror="window.__xss=1"> talk' },
      [{ start: 12, end: 15, en: 'Today we discover something interesting.', fr: "Aujourd'hui, nous découvrons quelque chose d'intéressant." }]);
      await add({ id: 'udemy:spring:1', url: 'https://www.udemy.com/course/spring/learn/lecture/1', site: 'udemy',
        duration: 8100, title: 'Introduction to Spring Boot' },
      [{ start: 5, end: 7.5, en: 'Hello everyone, welcome to this course.', fr: 'Bonjour à tous, bienvenue dans cette formation.' },
        { start: 20, end: 22, en: "Let's get started.", fr: "C'est parti." }]);
    });
    await page.reload();
    await page.waitForSelector('#videos li');
    const n = await page.locator('#videos li').count();
    const xssImg = await page.locator('#videos img').count();
    H.record('liste des vidéos affichée', n === 2, `${n} vidéo(s)`);
    H.record('titre piégé affiché comme du texte (pas de HTML injecté)',
      xssImg === 0 && !(await page.evaluate(() => window.__xss)), `${xssImg} image(s) injectée(s)`);
    await page.selectOption('#sort', 'title');
    const first = await page.locator('#videos li h3').first().textContent();
    H.record('tri par titre', first.startsWith('Introduction'), first);
    await page.selectOption('#site', 'udemy');
    H.record('filtre par plateforme', (await page.locator('#videos li').count()) === 1);
    await page.selectOption('#site', '');

    // Transcription.
    await page.click('text=Introduction to Spring Boot');
    await page.waitForSelector('#segments li');
    const rows = await page.locator('#segments li').count();
    const firstTime = await page.locator('#segments li button.time').first().textContent();
    H.record('transcription bilingue horodatée', rows === 2 && firstTime === '00:00:05', `${rows} phrase(s), première à ${firstTime}`);
    await page.fill('#tq', 'FORMATION');
    H.record('recherche dans la transcription (casse ignorée, surlignage)',
      (await page.locator('#segments li').count()) === 1 && (await page.locator('#segments mark').count()) === 1);
    await page.fill('#tq', '');

    // Correction et note.
    await page.locator('#segments li').first().locator('text=Modifier').click();
    await page.fill('#segments li textarea', 'Bonjour à tous et bienvenue dans ce cours.');
    await page.click('text=Enregistrer');
    await page.waitForSelector('.badge');
    await page.locator('#segments li').first().locator('text=Ajouter une note').click();
    await page.fill('#segments li textarea', 'Point important');
    await page.click('text=Enregistrer');
    await page.waitForSelector('.note');
    const saved = await page.evaluate(async () => {
      const st = await import('./lib/store.js');
      return (await st.getSegments('udemy:spring:1'))[0];
    });
    H.record('traduction corrigée et note enregistrées dans la base',
      saved.fr === 'Bonjour à tous et bienvenue dans ce cours.' && saved.translationStatus === 'validee' && saved.note === 'Point important');

    // Exports réels (téléchargements).
    const exported = {};
    for (const fmt of ['txt', 'md', 'srt', 'srt2', 'json']) {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.selectOption('#exportFmt', fmt)]);
      exported[fmt] = { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
    }
    const ok = /EN : Hello everyone/.test(exported.txt.text) && /Point important/.test(exported.txt.text)
      && /### 00:00:05/.test(exported.md.text)
      && /^1\n00:00:05,000 --> 00:00:07,500\nBonjour à tous et bienvenue/.test(exported.srt.text)
      && /Hello everyone/.test(exported.srt2.text)
      && JSON.parse(exported.json.text).phrases.length === 2;
    H.record('exports TXT, Markdown, SRT (français et bilingue), JSON', ok,
      Object.values(exported).map((e) => e.name).join(', '));

    // Impression (PDF) : seule la transcription est imprimée.
    await page.emulateMedia({ media: 'print' });
    const printHidesTools = !(await page.locator('.toolbar').first().isVisible()) && (await page.locator('#segments').isVisible());
    await page.emulateMedia({ media: 'screen' });
    H.record('mise en page d\'impression (PDF) sans les commandes', printHidesTools);

    // Recherche globale, accents ignorés.
    await page.click('#tabSearch');
    await page.fill('#gq', 'interessant');
    await page.waitForSelector('#gresults li');
    H.record('recherche d\'une phrase dans toute la bibliothèque', (await page.locator('#gresults li').count()) === 1);

    // Aller à ce moment : YouTube s'ouvre au bon moment. YouTube n'est pas
    // joignable depuis l'environnement de test : on vérifie l'adresse demandée.
    const [req] = await Promise.all([
      ctx.waitForEvent('request', (r) => r.url().includes('youtube.com')),
      page.locator('#gresults button.time').click(),
    ]);
    const url = req.url();
    for (const pg of ctx.pages()) if (pg !== page) await pg.close().catch(() => {});
    H.record('« aller à ce moment » ouvre YouTube à la bonne seconde', /[?&]t=12s/.test(url), url);

    // Suppression.
    page.on('dialog', (d) => d.accept());
    await page.click('#tabVideos');
    await page.waitForSelector('#videos li');
    await page.locator('#videos li').filter({ hasText: 'Zebra' }).locator('text=Supprimer').click();
    await H.sleep(500);
    const left = await page.evaluate(async () => (await (await import('./lib/store.js')).stats()));
    H.record('suppression d\'une vidéo et de ses phrases', left.videos === 1 && left.segments === 2,
      `${left.videos} vidéo(s), ${left.segments} phrase(s) restante(s)`);
  } finally { await ctx.close(); }
};

// --------------------------------------------------------------------- run

const names = Object.keys(TESTS).filter(want);
console.log(`Scénarios : ${names.join(', ')}\n`);
for (const name of names) {
  console.log(`--- ${name} ---`);
  const t0 = Date.now();
  try {
    await TESTS[name]();
  } catch (e) {
    H.record(`scénario « ${name} » mené à son terme`, false, e.message);
  }
  console.log(`    (${Math.round((Date.now() - t0) / 1000)} s)\n`);
}
const ok = H.summary();
fs.writeFileSync(path.join(OUT, 'resultats.json'), JSON.stringify(H.allResults(), null, 1));
process.exit(ok ? 0 : 1);
