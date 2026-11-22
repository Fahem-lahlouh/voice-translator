// Connexion « outil » au serveur local (bibliothèque) : résumés et
// téléchargement du modèle de résumé. Elle n'interrompt pas un doublage en
// cours (le serveur ne la traite pas comme une session de doublage).

import { loadSettings } from './settings.js';

const PROTOCOL = 1;

export async function connectTool() {
  const settings = await loadSettings();
  const ws = new WebSocket(`ws://127.0.0.1:${settings.serverPort}/ws`);
  const listeners = new Set();
  const hello = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('le serveur local ne répond pas')), 5000);
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`serveur local injoignable sur le port ${settings.serverPort}`)); };
    ws.onclose = (ev) => { clearTimeout(timer); reject(new Error(ev.reason || 'connexion refusée par le serveur local')); };
    ws.onopen = () => {
      const msg = { type: 'hello', protocol: PROTOCOL, role: 'outil' };
      if (settings.token) msg.token = settings.token;
      ws.send(JSON.stringify(msg));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'hello_ok') { clearTimeout(timer); resolve(msg); }
    };
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    for (const fn of listeners) fn(msg);
  };
  ws.onclose = () => { for (const fn of listeners) fn({ type: 'closed' }); };
  let n = 0;
  return {
    hello,
    // Envoie une requête ; `onEvent` reçoit chaque message lié. La promesse
    // se résout au message final (résultat, état du modèle ou annulation).
    request(msg, onEvent = () => {}, finals = ['summary_result', 'llm_status', 'summary_cancelled']) {
      const requestId = `r${Date.now()}-${++n}`;
      return new Promise((resolve, reject) => {
        const fn = (m) => {
          if (m.type === 'closed') { listeners.delete(fn); reject(new Error('connexion au serveur local perdue')); return; }
          if (m.requestId !== requestId) return;
          if (m.type === 'error') { listeners.delete(fn); reject(new Error(m.message)); return; }
          onEvent(m);
          if (finals.includes(m.type)) { listeners.delete(fn); resolve(m); }
        };
        listeners.add(fn);
        ws.send(JSON.stringify({ ...msg, requestId }));
      });
    },
    cancel() { ws.send(JSON.stringify({ type: 'cancel' })); },
    close() { try { ws.close(); } catch (_) { /* déjà fermée */ } },
  };
}
