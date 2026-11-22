// Tests de la logique de lecture synchronisée.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coveredBySync, dueToStart, insertSorted, maxDuration, prepKey, toPrepare,
} from '../../extension/lib/syncplayer.js';

const SEGS = [
  { id: 'a', start: 10, end: 12, fr: 'Un.' },
  { id: 'b', start: 13, end: 17, fr: 'Deux.' },
  { id: 'c', start: 30, end: 33, fr: 'Trois.' },
];

test('préparation : seulement les phrases des 6 prochaines secondes', () => {
  assert.deepEqual(toPrepare(SEGS, 8, new Set()), [0, 1]);
  assert.deepEqual(toPrepare(SEGS, 8, new Set([prepKey(SEGS[0], 1)])), [1]);
  assert.deepEqual(toPrepare(SEGS, 26, new Set()), [2]);
});

test('préparation : une autre vitesse vidéo demande une autre voix', () => {
  assert.notEqual(prepKey(SEGS[0], 1), prepKey(SEGS[0], 1.25));
  assert.equal(prepKey(SEGS[0], 1.01), prepKey(SEGS[0], 1));
});

test('durée maximale : jusqu’à la phrase suivante, convertie en temps réel', () => {
  assert.ok(Math.abs(maxDuration(SEGS, 0, 1) - 2.92) < 1e-9); // 10 -> 13 (début suivant)
  assert.ok(Math.abs(maxDuration(SEGS, 1, 1) - 5.42) < 1e-9); // 13 -> 17 + 1,5 de blanc
  assert.ok(Math.abs(maxDuration(SEGS, 0, 2) - 1.42) < 1e-9); // vidéo à × 2
});

test('démarrage : au bon moment, pas trop tôt', () => {
  assert.equal(dueToStart(SEGS, 9.0, new Set()), null); // 1 s avant : trop tôt
  const d = dueToStart(SEGS, 9.8, new Set());
  assert.equal(d.index, 0);
  assert.ok(Math.abs(d.delayS - 0.2) < 1e-9);
});

test('démarrage : léger retard toléré, gros retard abandonné', () => {
  assert.equal(dueToStart(SEGS, 10.4, new Set()).index, 0);
  assert.equal(dueToStart(SEGS, 11.0, new Set()), null);
});

test('démarrage : une phrase déjà lancée ne repart pas', () => {
  assert.equal(dueToStart(SEGS, 9.9, new Set(['a'])), null);
  assert.equal(dueToStart(SEGS, 12.9, new Set(['a'])).index, 1);
});

test('démarrage : à × 2, le délai réel est divisé par deux', () => {
  const d = dueToStart(SEGS, 9.6, new Set(), 2);
  assert.ok(Math.abs(d.delayS - 0.2) < 1e-9);
});

test('démarrage : décalage de compensation', () => {
  const d = dueToStart(SEGS, 9.9, new Set(), 1, 0.15);
  assert.ok(Math.abs(d.delayS - 0.25) < 1e-9);
});

test('pas de double voix : le direct est coupé sur un passage déjà doublé', () => {
  assert.equal(coveredBySync({ start: 10.2, end: 12.1 }, SEGS, new Set(['a'])), true);
  assert.equal(coveredBySync({ start: 10.2, end: 12.1 }, SEGS, new Set()), false); // pas lancé
  assert.equal(coveredBySync({ start: 20, end: 22 }, SEGS, new Set(['a', 'b'])), false);
  assert.equal(coveredBySync(null, SEGS, new Set(['a'])), false);
});

test('insertion triée sans doublon', () => {
  const out = insertSorted(SEGS, { id: 'z', start: 20, end: 21 });
  assert.deepEqual(out.map((x) => x.id), ['a', 'b', 'z', 'c']);
  assert.equal(insertSorted(out, { id: 'z', start: 20, end: 21 }).length, 4);
});
