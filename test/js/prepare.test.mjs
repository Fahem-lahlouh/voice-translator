// Tests de la logique de préparation du doublage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coveredFrom, paceFor, reachedEnd, remainingS, skipTarget } from '../../extension/lib/prepare.js';

test('cadence : ralentit puis met en pause quand la reconnaissance prend du retard', () => {
  assert.equal(paceFor(0), 1.5);
  assert.equal(paceFor(3), 1.25);
  assert.equal(paceFor(5), 1);
  assert.equal(paceFor(7), 0);
});

test('passages déjà traduits : intervalles réunis et saut', () => {
  const cov = coveredFrom([{ start: 10, end: 12 }, { start: 13, end: 20 }, { start: 40, end: 42 }]);
  assert.deepEqual(cov, [[10, 20], [40, 42]]);
  assert.equal(skipTarget(cov, 11), 19); // saute à 1 s avant la fin
  assert.equal(skipTarget(cov, 17), null); // presque fini : inutile
  assert.equal(skipTarget(cov, 25), null); // hors passage connu
});

test('fin de vidéo détectée', () => {
  assert.equal(reachedEnd(76.0, 76.2, false), true);
  assert.equal(reachedEnd(75.0, 76.2, true), true); // arrêtée juste avant la fin
  assert.equal(reachedEnd(50, 76.2, true), false); // simple pause
  assert.equal(reachedEnd(50, NaN, false), false);
});

test('temps restant estimé', () => {
  assert.equal(remainingS(30, 90, 1.5), 40);
  assert.equal(remainingS(30, null, 1.5), null);
});
