// Page d'options : serveur local et glossaire.

import { parseGlossaryText } from './lib/glossary.js';
import { parsePronunciationText, PRONUNCIATION_HELP } from './lib/pronunciation.js';
import * as store from './lib/store.js';
import {
  DEFAULTS, defaultGlossaryText, effectiveGlossaryText, effectivePronunciationText, loadSettings, saveSettings,
} from './lib/settings.js';

const $ = (id) => document.getElementById(id);
let settings = null;

function note(text, kind = 'ok') {
  const el = $('msg');
  el.hidden = !text;
  el.textContent = text;
  el.className = `notice ${kind}`;
}

function validate() {
  const { entries, errors } = parseGlossaryText($('glossary').value);
  $('count').textContent = String(entries.length);
  $('glossaryErrors').hidden = !errors.length;
  $('glossaryErrors').textContent = errors.join(' ');
  return { entries, errors };
}

async function load() {
  settings = await loadSettings();
  $('serverPort').value = settings.serverPort;
  $('token').value = settings.token;
  $('glossary').value = await effectiveGlossaryText(settings);
  $('pronunciation').value = effectivePronunciationText(settings);
  $('saveSessions').checked = settings.saveSessions;
  await showLibStats();
  validatePron();
  $('savedInfo').textContent = settings.glossaryText === null
    ? 'Glossaire par défaut (TIBCO) en cours d\'utilisation.' : 'Glossaire personnalisé.';
  validate();
}

async function save() {
  const { errors } = validate();
  if (errors.length) {
    note('Le glossaire contient des erreurs : corrigez-les avant d\'enregistrer.', 'error');
    return;
  }
  const port = Number($('serverPort').value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    note('Le port doit être un nombre entier entre 1024 et 65535.', 'error');
    return;
  }
  const text = $('glossary').value;
  const isDefault = text.trim() === (await defaultGlossaryText()).trim();
  settings = await saveSettings({
    serverPort: port,
    token: $('token').value,
    glossaryText: isDefault ? null : text,
  });
  $('savedInfo').textContent = isDefault ? 'Glossaire par défaut (TIBCO) en cours d\'utilisation.' : 'Glossaire personnalisé.';
  note('Réglages enregistrés. Ils s\'appliquent immédiatement, même pendant une traduction en cours.');
}

function validatePron() {
  const { rules, errors } = parsePronunciationText($('pronunciation').value);
  $('pcount').textContent = `${rules.length} règle(s) personnelle(s)`;
  $('pronErrors').hidden = !errors.length;
  $('pronErrors').textContent = errors.join(' ');
  return errors;
}

async function showLibStats() {
  try {
    const st = await store.stats();
    $('libStats').textContent = `${st.videos} vidéo(s), ${st.segments} phrase(s) enregistrée(s).`;
  } catch (err) {
    $('libStats').textContent = `Bibliothèque illisible : ${err.message || err}`;
  }
}

$('saveSessions').addEventListener('change', async (e) => {
  settings = await saveSettings({ saveSessions: e.target.checked });
  note(e.target.checked ? 'Les prochaines phrases traduites seront enregistrées sur ce PC.'
    : 'Enregistrement désactivé : plus rien ne sera conservé. La bibliothèque existante est gardée.');
});
$('clearLibrary').addEventListener('click', async () => {
  if (!window.confirm('Effacer définitivement toutes les vidéos et phrases enregistrées ?')) return;
  await store.clearAll();
  await showLibStats();
  note('Bibliothèque effacée.');
});

$('pronunciation').addEventListener('input', validatePron);
$('savePron').addEventListener('click', async () => {
  if (validatePron().length) {
    note('Les règles de prononciation contiennent des erreurs : corrigez-les avant d\'enregistrer.', 'error');
    return;
  }
  const text = $('pronunciation').value;
  settings = await saveSettings({ pronunciationText: text.trim() === PRONUNCIATION_HELP.trim() ? null : text });
  note('Prononciation enregistrée. Elle s\'applique immédiatement, même pendant une traduction en cours.');
});

$('save').addEventListener('click', save);
$('glossary').addEventListener('input', validate);
$('reset').addEventListener('click', async () => {
  $('glossary').value = await defaultGlossaryText();
  validate();
  note('Glossaire par défaut restauré. Cliquez sur « Enregistrer » pour confirmer.', 'info');
});
$('wipe').addEventListener('click', async () => {
  await chrome.storage.local.clear();
  await store.clearAll();
  await load();
  note('Tous les réglages ont été effacés et remis à leurs valeurs par défaut.');
});

$('testServer').addEventListener('click', async () => {
  const port = Number($('serverPort').value) || DEFAULTS.serverPort;
  $('probe').textContent = 'Test en cours…';
  try {
    // Simple vérification de présence : le serveur répond sur /health.
    const res = await fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store' });
    const body = (await res.text()).trim();
    $('probe').textContent = res.ok && body.includes('ok')
      ? `Le serveur local répond sur le port ${port}.`
      : `Un service répond sur le port ${port}, mais ce n'est pas le serveur de doublage.`;
  } catch (_) {
    $('probe').textContent = `Aucun serveur ne répond sur le port ${port}. `
      + 'Lancez scripts\\demarrer-serveur.bat et laissez la fenêtre ouverte.';
  }
});

load();
