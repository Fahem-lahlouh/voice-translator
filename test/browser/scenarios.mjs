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

async function session({ serverOpts, startServerFirst = true } = {}) {
  const pageSrv = H.startPageServer();
  const server = startServerFirst ? H.startServer(serverOpts) : null;
  await H.sleep(800);
  const { ctx, sw } = await H.launch();
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
    ctx, sw, page, server, pageSrv,
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
