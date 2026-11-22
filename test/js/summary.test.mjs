// Tests du résumé express et de la vérification des résumés IA
// (sur une vraie transcription : The Canterville Ghost, domaine public).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractiveSummary, keyTerms, supportFor, toSentences } from '../../extension/lib/summary.js';

const SEGS = JSON.parse(fs.readFileSync(new URL('./donnees/canterville_10min.json', import.meta.url), 'utf8'));

test('phrases reconstituées à partir des segments audio', () => {
  const sents = toSentences(SEGS);
  assert.ok(sents.length > 20 && sents.length < SEGS.length);
  assert.ok(sents.every((s) => s.end >= s.start));
});

test('résumé express : uniquement des phrases réellement prononcées, dans l’ordre', () => {
  const r = extractiveSummary(SEGS);
  const all = SEGS.map((s) => s.fr).join(' ');
  for (const s of [...r.court, ...r.points]) {
    for (const part of s.fr.split(' ').slice(0, 5)) assert.ok(all.includes(part));
  }
  const starts = r.court.map((s) => s.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(r.court.length, 3);
  assert.ok(r.chapitres.length >= 2);
});

test('termes clés : noms propres de l’histoire, sans titres de politesse', () => {
  const t = keyTerms(SEGS);
  assert.ok(t.includes('Canterville'));
  assert.ok(t.includes('Washington'));
  assert.ok(!t.includes('Mr') && !t.includes('Lord'));
});

test('vérification : un point fidèle est relié à son passage', () => {
  const r = supportFor('Mr. Hiram B. Otis, ministre américain, achète Canterville Chase.', SEGS);
  assert.equal(r.doubtful, false);
  assert.ok(r.segment.start < 30);
});

test('vérification : des inventions grossières sont signalées', () => {
  assert.equal(supportFor('Les otages ont deux enfants républicains.', SEGS).doubtful, true);
  assert.equal(supportFor('Le fantôme joue du piano chaque nuit à minuit dans la bibliothèque.', SEGS).doubtful, true);
  assert.deepEqual(supportFor('Le château appartient à Napoléon.', SEGS).absents, ['Napoléon']);
});
