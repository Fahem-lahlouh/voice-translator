// Outils communs aux tests de bout en bout dans un vrai Chrome.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');
export const EXT = path.join(ROOT, 'extension');
export const PY = path.join(ROOT, 'server/.venv/bin/python');
export const PORT = Number(process.env.PAGE_PORT || 8777);
export const SERVER_PORT = Number(process.env.VT_PORT || 47931);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(label, fn, { timeout = 30000, step = 250 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(step);
  }
  throw new Error(`délai dépassé (${Math.round((Date.now() - t0) / 1000)} s) : ${label}`
    + (last && typeof last !== 'boolean' ? ` — dernier état : ${JSON.stringify(last).slice(0, 300)}` : ''));
}

// ------------------------------------------------------------------ serveur

export function startServer({ profile = 'prudent', port = SERVER_PORT, extraArgs = [] } = {}) {
  const args = ['-m', 'vt_server', '--profile', profile, '--port', String(port), ...extraArgs];
  const proc = spawn(PY, args, { cwd: path.join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  for (const s of [proc.stdout, proc.stderr]) {
    s.setEncoding('utf8');
    s.on('data', (d) => { for (const l of d.split('\n')) if (l.trim()) lines.push(l.trim()); });
  }
  return { proc, lines, port, stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGINT'); setTimeout(() => { proc.kill('SIGKILL'); r(); }, 4000); }) };
}

export function startPageServer() {
  const proc = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: path.join(ROOT, 'test'), stdio: 'ignore' });
  return { proc, stop: () => proc.kill('SIGKILL') };
}

// ----------------------------------------------------------------- Chrome

export async function launch({ profileDir } = {}) {
  // Un profil existant peut être réutilisé : c'est ce qui permet de vérifier
  // que la bibliothèque survit à la fermeture du navigateur.
  const profile = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'vt-chrome-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--autoplay-policy=no-user-gesture-required', '--no-sandbox',
           '--window-size=1280,900', '--window-position=0,0',
           `--remote-debugging-port=${DEBUG_PORT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  return { ctx, sw, extId, profileDir: profile };
}

// Invoque l'extension comme le ferait l'utilisateur (raccourci clavier
// Ctrl+Maj+Y) : c'est ce qui accorde l'autorisation activeTab sur l'onglet.
export function invokeExtension() {
  return execFileSync(PY, [path.join(HERE, 'sendkey.py'), 'ctrl+shift+y'], { encoding: 'utf8' }).trim();
}

// ---------------------------------- accès CDP aux contextes de l'extension
//
// La popup et le document « offscreen » ne sont pas des onglets : Playwright
// ne les expose pas. On passe donc par le port de débogage de Chrome, qui
// liste toutes les cibles et donne une adresse WebSocket pour chacune.

export const DEBUG_PORT = Number(process.env.CDP_PORT || 9333);

export async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return res.json();
}

export async function attach(urlPart, { timeout = 15000 } = {}) {
  const target = await waitFor(`cible ${urlPart}`, async () => {
    const all = await listTargets();
    return all.find((t) => t.url.includes(urlPart) && t.webSocketDebuggerUrl) || false;
  }, { timeout });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP injoignable')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  };
  let dead = false;
  ws.onclose = () => { dead = true; for (const p of pending.values()) p({ closed: true }); pending.clear(); };
  // Une cible qui se ferme (fermeture de la popup) ne répond jamais : on borne
  // chaque appel pour ne pas bloquer le test.
  const send = (method, params = {}, timeoutMs = 20000) => new Promise((res) => {
    if (dead) return res({ closed: true });
    const n = ++id;
    const t = setTimeout(() => { pending.delete(n); res({ timedOut: true }); }, timeoutMs);
    pending.set(n, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return {
    url: target.url,
    async evaluate(expr, { timeoutMs = 20000 } = {}) {
      const msg = await send('Runtime.evaluate', {
        expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
      }, timeoutMs);
      if (msg.closed || msg.timedOut) throw new Error(`${urlPart} : cible fermée ou sans réponse`);
      const r = msg.result;
      if (!r) throw new Error(`${urlPart} : réponse CDP vide`);
      if (r.exceptionDetails) {
        throw new Error(`${urlPart} : ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      }
      return r.result.value;
    },
    // Ferme la fenêtre côté navigateur sans attendre de réponse CDP.
    async closeWindow() {
      send('Runtime.evaluate', { expression: 'window.close()' }, 1000).catch(() => {});
      await sleep(600);
      try { ws.close(); } catch (_) { /* déjà fermé */ }
    },
    close: () => { try { ws.close(); } catch (_) { /* déjà fermé */ } },
  };
}

// --------------------------------------------------------------- journal

const results = [];
export function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'OK  ' : 'ECHEC';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}
export function summary() {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} vérifications réussies =====`);
  for (const b of bad) console.log(`  ECHEC : ${b.name} — ${b.detail}`);
  return bad.length === 0;
}
export function allResults() { return results; }
