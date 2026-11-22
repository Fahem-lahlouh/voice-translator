// Ma bibliothèque : vidéos enregistrées, transcription bilingue, recherche,
// corrections, notes, exports. Tout est lu et écrit dans la base locale.

import {
  fileName, formatDuration, formatTime, matches, normalize, summaryToMarkdown, toClipboard, toJson, toMarkdown,
  toSrt, toTxt,
} from './lib/exporters.js';
import { detectContentMode } from './lib/settings.js';
import * as store from './lib/store.js';
import { extractiveSummary, supportFor } from './lib/summary.js';
import { connectTool } from './lib/toolclient.js';

const $ = (id) => document.getElementById(id);
const LANGS = { en: 'Anglais', fr: 'Français' };
let videos = [];
let current = null; // vidéo ouverte
let segments = [];
const selected = new Set();
let refreshTimer = null;

// ---------------------------------------------------------------- outils

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

function note(text, kind = 'ok') {
  const m = $('msg');
  m.textContent = text;
  m.className = `notice ${kind}`;
  m.hidden = !text;
  clearTimeout(note.t);
  if (text && kind !== 'error') note.t = setTimeout(() => { m.hidden = true; }, 4000);
}

function progressOf(v) {
  if (!v.duration) return null;
  return Math.min(1, store.coveredSeconds(v.covered || []) / v.duration);
}

function siteName(site) {
  const names = { youtube: 'YouTube', udemy: 'Udemy', vimeo: 'Vimeo' };
  return names[site] || site || 'Autre';
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Surligne `query` dans `text` (nœuds texte uniquement, jamais de HTML).
function highlighted(text, query) {
  const q = normalize(query).trim();
  if (!q) return [document.createTextNode(text)];
  const norm = normalize(text);
  const out = [];
  let pos = 0;
  let i = norm.indexOf(q);
  while (i >= 0) {
    out.push(document.createTextNode(text.slice(pos, i)), el('mark', { text: text.slice(i, i + q.length) }));
    pos = i + q.length;
    i = norm.indexOf(q, pos);
  }
  out.push(document.createTextNode(text.slice(pos)));
  return out;
}

// ------------------------------------------------------------- navigation

function show(view) {
  for (const v of ['viewList', 'viewSearch', 'viewVideo']) $(v).hidden = v !== view;
  $('tabVideos').setAttribute('aria-pressed', String(view !== 'viewSearch'));
  $('tabSearch').setAttribute('aria-pressed', String(view === 'viewSearch'));
  clearInterval(refreshTimer);
}

async function route() {
  const m = location.hash.match(/^#video=(.+)$/);
  if (m) await openVideo(decodeURIComponent(m[1]));
  else if (location.hash === '#recherche') { show('viewSearch'); $('gq').focus(); } else await showList();
}

// ------------------------------------------------------------ liste vidéos

async function showList() {
  show('viewList');
  videos = await store.listVideos();
  const sites = [...new Set(videos.map((v) => v.site))].sort();
  const langs = [...new Set(videos.flatMap((v) => [v.sourceLang, v.targetLang]))].filter(Boolean).sort();
  fillSelect($('site'), sites.map((s) => [s, siteName(s)]));
  fillSelect($('lang'), langs.map((l) => [l, LANGS[l] || l]));
  renderList();
}

function fillSelect(sel, items) {
  const keep = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  for (const [v, label] of items) sel.append(el('option', { value: v, text: label }));
  sel.value = items.some(([v]) => v === keep) ? keep : '';
}

function renderList() {
  const q = normalize($('q').value).trim();
  const site = $('site').value;
  const lang = $('lang').value;
  let list = videos.filter((v) => (!q || normalize(`${v.title} ${v.site} ${v.url}`).includes(q))
    && (!site || v.site === site) && (!lang || v.sourceLang === lang || v.targetLang === lang));
  const by = $('sort').value;
  const cmp = {
    date: (a, b) => b.lastSeenAt - a.lastSeenAt,
    title: (a, b) => a.title.localeCompare(b.title, 'fr'),
    site: (a, b) => siteName(a.site).localeCompare(siteName(b.site), 'fr') || b.lastSeenAt - a.lastSeenAt,
    progress: (a, b) => (progressOf(b) || 0) - (progressOf(a) || 0),
  }[by];
  list = [...list].sort(cmp);
  const ul = $('videos');
  ul.textContent = '';
  for (const v of list) {
    const p = progressOf(v);
    ul.append(el('li', { class: 'card' },
      el('h3', {}, el('a', { href: `#video=${encodeURIComponent(v.id)}`, text: v.title })),
      el('p', { class: 'hint' },
        `${siteName(v.site)} · ${LANGS[v.sourceLang] || v.sourceLang} → ${LANGS[v.targetLang] || v.targetLang}`
        + ` · durée ${formatDuration(v.duration)} · vue le ${new Date(v.lastSeenAt).toLocaleString('fr-FR')}`),
      el('div', { class: 'progress-line' },
        el('progress', { max: '1', value: String(p || 0), 'aria-label': 'Progression' }),
        el('span', { class: 'hint', text: `${p === null ? '—' : `${Math.round(p * 100)} %`} · ${v.segmentCount || 0} phrase(s)` })),
      el('div', { class: 'card-actions' },
        el('a', { href: `#video=${encodeURIComponent(v.id)}`, class: 'button', text: 'Ouvrir la transcription' }),
        el('button', { type: 'button', class: 'danger', text: 'Supprimer', onclick: () => removeVideo(v) }))));
  }
  $('count').textContent = `${list.length} vidéo(s)${list.length !== videos.length ? ` sur ${videos.length}` : ''}`;
  $('empty').hidden = videos.length > 0;
}

async function removeVideo(v) {
  if (!window.confirm(`Supprimer « ${v.title} » et toutes ses phrases enregistrées ?`)) return;
  await store.deleteVideo(v.id);
  note('Vidéo supprimée de la bibliothèque.');
  if (current && current.id === v.id) location.hash = '';
  else await showList();
}

// ---------------------------------------------------- recherche globale

async function globalSearch() {
  const q = $('gq').value.trim();
  const ul = $('gresults');
  ul.textContent = '';
  if (q.length < 2) { $('gcount').textContent = 'Tapez au moins deux caractères.'; return; }
  const res = await store.searchAll(q);
  $('gcount').textContent = `${res.length} résultat(s)${res.length >= 200 ? ' (200 premiers)' : ''}`;
  for (const { video, segment: s } of res) {
    ul.append(el('li', {},
      el('a', { href: `#video=${encodeURIComponent(video.id)}`, class: 'res-title', text: video.title }),
      el('button', { type: 'button', class: 'time', title: 'Aller à ce moment de la vidéo',
        onclick: () => seek(video, s.start) }, formatTime(s.start)),
      el('p', { lang: 'en' }, ...highlighted(s.en, q)),
      el('p', { lang: 'fr' }, ...highlighted(s.fr, q))));
  }
}

// ------------------------------------------------------- transcription

async function openVideo(id) {
  show('viewVideo');
  showTab('transcript');
  current = await store.getVideo(id);
  if (!current) { note('Cette vidéo n\'existe plus dans la bibliothèque.', 'error'); location.hash = ''; return; }
  selected.clear();
  await loadSegments();
  // Pendant un doublage en cours, la transcription se complète toute seule.
  refreshTimer = setInterval(async () => {
    if (document.hidden || !current) return;
    const v = await store.getVideo(current.id);
    if (v && v.segmentCount !== current.segmentCount) { current = v; await loadSegments(true); }
  }, 3000);
}

async function loadSegments(keepScroll = false) {
  const y = window.scrollY;
  segments = (await store.getSegments(current.id)).sort((a, b) => a.start - b.start);
  const p = progressOf(current);
  $('vTitle').textContent = current.title;
  $('vMeta').textContent = `${siteName(current.site)} · ${LANGS[current.sourceLang] || current.sourceLang} → `
    + `${LANGS[current.targetLang] || current.targetLang} · durée ${formatDuration(current.duration)} · `
    + `vue le ${new Date(current.lastSeenAt).toLocaleString('fr-FR')}`
    + (current.timeBase === 'session' ? ' · horodatage depuis le début de la session (pas de lecteur vidéo)' : '');
  $('vProgress').value = p || 0;
  $('vProgressText').textContent = p === null ? '' : `${Math.round(p * 100)} % de la vidéo transcrite`;
  document.title = `${current.title} — ma bibliothèque`;
  renderSegments();
  if (keepScroll) window.scrollTo(0, y);
}

function renderSegments() {
  const q = $('tq').value;
  const ol = $('segments');
  ol.textContent = '';
  const shown = segments.filter((s) => matches(s, q));
  for (const s of shown) ol.append(segmentItem(s, q));
  $('tcount').textContent = `${shown.length} phrase(s)${shown.length !== segments.length ? ` sur ${segments.length}` : ''}`
    + (selected.size ? ` · ${selected.size} sélectionnée(s)` : '');
  $('copySel').disabled = selected.size === 0;
}

function segmentItem(s, q) {
  const li = el('li', { class: 'seg', id: `seg-${s.id}` });
  const box = el('input', { type: 'checkbox', class: 'noprint', 'aria-label': `Sélectionner la phrase de ${formatTime(s.start)}` });
  box.checked = selected.has(s.id);
  box.addEventListener('change', () => {
    if (box.checked) selected.add(s.id); else selected.delete(s.id);
    renderSegments();
  });
  const fr = el('p', { class: 'fr', lang: 'fr' }, el('span', { class: 'tag', text: 'FR' }), ...highlighted(s.fr, q));
  if (s.translationStatus === 'validee') fr.append(el('span', { class: 'badge', text: 'corrigée' }));
  const noteP = s.note ? el('p', { class: 'note' }, el('span', { class: 'tag', text: 'Note' }), ...highlighted(s.note, q)) : null;
  li.append(
    el('div', { class: 'seg-head' }, box,
      el('button', { type: 'button', class: 'time', title: 'Aller à ce moment de la vidéo',
        onclick: () => seek(current, s.start) }, formatTime(s.start)),
      el('span', { class: 'hint', text: `→ ${formatTime(s.end)}` }),
      el('span', { class: 'grow' }),
      el('button', { type: 'button', class: 'link noprint', text: 'Copier', onclick: () => copy([s]) }),
      el('button', { type: 'button', class: 'link noprint', text: 'Modifier', onclick: () => edit(li, s) }),
      el('button', { type: 'button', class: 'link noprint', text: s.note ? 'Note' : 'Ajouter une note', onclick: () => editNote(li, s) })),
    el('p', { class: 'en', lang: 'en' }, el('span', { class: 'tag', text: 'EN' }), ...highlighted(s.en, q)),
    fr, noteP);
  return li;
}

function inlineEditor(li, label, value, onSave) {
  const ta = el('textarea', { 'aria-label': label, rows: '3' });
  ta.value = value;
  const form = el('div', { class: 'editor' }, ta,
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'primary', text: 'Enregistrer', onclick: async () => { await onSave(ta.value.trim()); } }),
      el('button', { type: 'button', text: 'Annuler', onclick: () => renderSegments() })));
  li.append(form);
  ta.focus();
}

function edit(li, s) {
  inlineEditor(li, 'Traduction française', s.fr, async (val) => {
    if (!val) { note('La traduction ne peut pas être vide.', 'error'); return; }
    await store.updateSegment(s.id, { fr: val });
    s.fr = val;
    s.translationStatus = 'validee';
    note('Traduction corrigée : c\'est elle qui sera lue au prochain visionnage.');
    renderSegments();
  });
}

function editNote(li, s) {
  inlineEditor(li, 'Note', s.note || '', async (val) => {
    await store.updateSegment(s.id, { note: val });
    s.note = val;
    note(val ? 'Note enregistrée.' : 'Note supprimée.');
    renderSegments();
  });
}

async function copy(list) {
  try {
    await navigator.clipboard.writeText(toClipboard(list));
    note(`${list.length} phrase(s) copiée(s) dans le presse-papiers.`);
  } catch (err) {
    note(`Copie impossible : ${err.message || err}`, 'error');
  }
}

async function seek(video, time) {
  const res = await chrome.runtime.sendMessage({ target: 'sw', type: 'ui:seekVideo', videoId: video.id,
    time, url: video.url, site: video.site });
  if (!res || !res.ok) note((res && res.error) || 'Impossible d\'ouvrir la vidéo.', 'error');
  else if (res.how === 'ouverture') {
    note(`Vidéo ouverte dans un nouvel onglet : placez-vous à ${formatTime(time)} (ce site ne permet pas `
      + 'd\'ouvrir directement à un moment précis).', 'info');
  }
}

function exportAs(fmt) {
  if (!current) return;
  const title = current.title;
  if (fmt === 'txt') download(fileName(title, 'txt'), toTxt(current, segments), 'text/plain');
  else if (fmt === 'md') download(fileName(title, 'md'), toMarkdown(current, segments), 'text/markdown');
  else if (fmt === 'srt') download(fileName(title, 'fr.srt'), toSrt(segments, 'fr'), 'application/x-subrip');
  else if (fmt === 'srt2') download(fileName(title, 'bilingue.srt'), toSrt(segments, 'bilingue'), 'application/x-subrip');
  else if (fmt === 'json') download(fileName(title, 'json'), toJson(current, segments), 'application/json');
  else if (fmt === 'pdf') {
    $('tq').value = '';
    renderSegments();
    note('Dans la fenêtre d\'impression, choisissez « Enregistrer au format PDF ».', 'info');
    setTimeout(() => window.print(), 300);
  }
}

// ---------------------------------------------------------------- résumés

let tool = null; // connexion « outil » au serveur local
let express = null;
let aiSummary = null;

function showTab(which) {
  const sum = which === 'summary';
  $('summaryPanel').hidden = !sum;
  $('transcriptTools').hidden = sum;
  $('transcriptPanel').hidden = sum;
  $('tabTranscript').setAttribute('aria-pressed', String(!sum));
  $('tabSummary').setAttribute('aria-pressed', String(sum));
  if (sum) openSummary();
}

function timeButton(t) {
  return el('button', { type: 'button', class: 'time', title: 'Aller à ce moment de la vidéo',
    onclick: () => seek(current, t) }, formatTime(t));
}

async function openSummary() {
  express = extractiveSummary(segments, { duration: current.duration });
  renderExpress();
  const mode = detectContentMode(current.url);
  $('sumMode').value = mode;
  $('sumSheet').checked = mode === 'formation';
  aiSummary = (await store.getSummary(current.id)) || null;
  renderAi();
  await refreshModels();
}

function renderExpress() {
  const box = $('express');
  box.textContent = '';
  if (!express) { box.append(el('p', { class: 'hint', text: 'Pas encore de phrases traduites pour cette vidéo.' })); return; }
  box.append(el('h4', { text: 'En bref' }), ...express.court.map((s) => el('p', { class: 'extrait' }, timeButton(s.start), ' ', s.fr)));
  box.append(el('h4', { text: 'Termes clés' }), el('ul', { class: 'chips' }, ...express.termes.map((t) => el('li', { text: t }))));
  box.append(el('h4', { text: 'Passages importants' }),
    el('ul', {}, ...express.points.map((s) => el('li', { class: 'extrait' }, timeButton(s.start), ' ', s.fr))));
  if (express.chapitres.length > 1) {
    box.append(el('h4', { text: 'Par chapitre' }), ...express.chapitres.map((c) => el('div', { class: 'chapitre' },
      el('p', {}, timeButton(c.start), ` → ${formatTime(c.end)} · `, el('strong', { text: c.terms.join(', ') })),
      ...c.extraits.map((s) => el('p', { class: 'extrait hint', text: s.fr })))));
  }
}

async function getTool() {
  if (tool) return tool;
  tool = await connectTool();
  return tool;
}

async function refreshModels() {
  const sel = $('sumModel');
  try {
    const t = await getTool();
    const r = await t.request({ type: 'llm_status' });
    sel.textContent = '';
    for (const m of r.llm) {
      const size = `${(m.size / 1e9).toFixed(1).replace('.', ',')} Go`;
      sel.append(el('option', { value: m.id, text: `${m.default ? 'Standard' : 'Léger'} — ${m.label}${m.installed ? '' : ` (à télécharger : ${size})`}` }));
    }
    sel.dataset.models = JSON.stringify(r.llm);
    if (!aiSummary) $('sumInfo').textContent = '';
  } catch (err) {
    tool = null;
    sel.textContent = '';
    sel.dataset.models = '[]';
    $('sumInfo').textContent = `Le résumé par IA demande le serveur local : ${err.message}. `
      + 'Lancez scripts\\demarrer-serveur.bat. (Le résumé express ci-dessus fonctionne sans lui.)';
  }
}

async function generate() {
  // Serveur démarré après l'ouverture de l'onglet : on se reconnecte.
  if (!JSON.parse($('sumModel').dataset.models || '[]').length) await refreshModels();
  const models = JSON.parse($('sumModel').dataset.models || '[]');
  const m = models.find((x) => x.id === $('sumModel').value);
  if (!m) return;
  const t = await getTool();
  const box = $('sumProgressBox');
  const bar = $('sumProgress');
  const step = $('sumStep');
  $('sumGo').disabled = true;
  $('sumCancel').hidden = false;
  box.hidden = false;
  try {
    if (!m.installed) {
      const size = `${(m.size / 1e9).toFixed(1).replace('.', ',')} Go`;
      if (!window.confirm(`Le modèle « ${m.label} » doit être téléchargé une fois (${size}) depuis huggingface.co.\n`
        + `Licence : ${m.license}.\nContinuer ?`)) return;
      await t.request({ type: 'llm_download', model: m.id }, (ev) => {
        if (ev.type === 'llm_download') {
          bar.value = ev.done / ev.total;
          step.textContent = `Téléchargement : ${Math.round((100 * ev.done) / ev.total)} %`;
        }
      });
      await refreshModels();
    }
    const t0 = Date.now();
    const res = await t.request({
      type: 'summarize', model: m.id, mode: $('sumMode').value, withSheet: $('sumSheet').checked,
      segments: segments.map((s) => ({ start: s.start, end: s.end, en: s.en })),
    }, (ev) => {
      if (ev.type === 'summary_progress') {
        bar.value = ev.progress;
        const el2 = Math.round((Date.now() - t0) / 1000);
        step.textContent = `${ev.step} — ${el2} s écoulées`;
      }
    });
    if (res.type === 'summary_cancelled') { $('sumInfo').textContent = 'Résumé annulé.'; return; }
    const r = res.result;
    // Chaque point est relié au passage qui l'appuie, ou signalé « à vérifier ».
    r.points = r.points.map((p) => {
      const sup = supportFor(p, segments);
      return { texte: p, aVerifier: sup.doubtful, start: sup.segment ? sup.segment.start : null, absents: sup.absents };
    });
    await store.saveSummary(current.id, r);
    aiSummary = await store.getSummary(current.id);
    renderAi();
  } catch (err) {
    $('sumInfo').textContent = `Résumé impossible : ${err.message}`;
    tool = null;
  } finally {
    $('sumGo').disabled = false;
    $('sumCancel').hidden = true;
    box.hidden = true;
  }
}

function renderAi() {
  const box = $('ai');
  box.textContent = '';
  if (!aiSummary) return;
  const a = aiSummary;
  $('sumInfo').textContent = `Généré le ${new Date(a.createdAt).toLocaleString('fr-FR')} avec ${a.model}, `
    + `en ${String(a.dureeCalcul).replace('.', ',')} s.`;
  box.append(el('p', { class: 'avert', text: 'Rédigé par un petit modèle d\'IA local : il peut contenir des erreurs. '
    + 'Chaque point est relié au passage le plus proche ; « à vérifier » signale un appui faible ou un nom '
    + 'introuvable dans la vidéo (c\'est un indice, pas une preuve).' }));
  if (a.court) box.append(el('h4', { text: 'Résumé' }), el('p', { text: a.court }));
  if (a.points && a.points.length) {
    box.append(el('h4', { text: a.mode === 'film' ? 'Événements importants' : a.mode === 'formation'
      ? 'Concepts et points à retenir' : 'Points essentiels' }),
    el('ul', {}, ...a.points.map((p) => el('li', { class: 'point' }, p.texte,
      p.aVerifier ? el('span', { class: 'verif doute', text: `à vérifier${(p.absents || []).length ? ` : ${p.absents.join(', ')} introuvable(s)` : ''}` })
        : el('span', { class: 'verif ok', text: 'appuyé' }),
      p.start !== null ? [' ', timeButton(p.start)] : null))));
  }
  if (a.chapitres && a.chapitres.length > 1) {
    box.append(el('h4', { text: 'Résumé par chapitre' }), ...a.chapitres.map((c) => el('div', { class: 'chapitre' },
      el('p', {}, timeButton(c.start), ` → ${formatTime(c.end)} · `, el('strong', { text: c.title })),
      el('p', { text: c.summary }),
      c.points && c.points.length ? el('ul', {}, ...c.points.map((p) => el('li', { text: p }))) : null)));
  }
  if (a.fiche) {
    box.append(el('h4', { text: 'Fiche de révision' }));
    if (a.fiche.definitions.length) {
      box.append(el('dl', {}, ...a.fiche.definitions.flatMap((d) => [el('dt', { text: d.terme }), el('dd', { text: d.definition })])));
    }
    box.append(...a.fiche.questions.map((q) => el('details', { class: 'carte' },
      el('summary', { text: q.question }), el('p', { text: q.reponse || '(pas de réponse proposée)' }))));
  }
}

// ------------------------------------------------------------- événements

$('tabTranscript').addEventListener('click', () => showTab('transcript'));
$('tabSummary').addEventListener('click', () => showTab('summary'));
$('sumGo').addEventListener('click', generate);
$('sumCancel').addEventListener('click', () => tool && tool.cancel());
$('sumExport').addEventListener('click', () => {
  if (!current) return;
  download(fileName(current.title, 'resume.md'), summaryToMarkdown(current, express, aiSummary), 'text/markdown');
});

$('tabVideos').addEventListener('click', () => { location.hash = ''; });
$('tabSearch').addEventListener('click', () => { location.hash = '#recherche'; });
$('home').addEventListener('click', (e) => { e.preventDefault(); location.hash = ''; });
$('back').addEventListener('click', (e) => { e.preventDefault(); location.hash = ''; });
for (const id of ['q', 'sort', 'site', 'lang']) $(id).addEventListener('input', renderList);
$('tq').addEventListener('input', renderSegments);
let gTimer = null;
$('gq').addEventListener('input', () => { clearTimeout(gTimer); gTimer = setTimeout(globalSearch, 250); });
$('exportFmt').addEventListener('change', (e) => { exportAs(e.target.value); e.target.value = ''; });
$('copySel').addEventListener('click', () => copy(segments.filter((s) => selected.has(s.id))));
$('openVideo').addEventListener('click', () => current && seek(current, current.lastPosition || 0));
$('deleteVideo').addEventListener('click', () => current && removeVideo(current));
window.addEventListener('hashchange', route);

route().catch((err) => note(`Bibliothèque illisible : ${err.message || err}`, 'error'));
