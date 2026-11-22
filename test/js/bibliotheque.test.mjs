// Tests des modules de l'étape 1 (datation et bibliothèque).
// Lancer : node --test test/js/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../../extension/lib/timeline.js';
import { cleanTitle, videoIdentity } from '../../extension/lib/videoid.js';
import { coveredSeconds, findDuplicate, mergeInterval, segmentId } from '../../extension/lib/store.js';

// Capture régulière : 1 s d'audio par seconde murale, à partir de `wall0`.
function capture(tl, wall0, seconds) {
  for (let i = 1; i <= seconds * 10; i++) tl.markCapture(i / 10, wall0 + i * 100);
}

test('datation : lecture normale', () => {
  const tl = new Timeline();
  capture(tl, 1_000_000, 30);
  tl.markMedia({ time: 120, rate: 1, paused: false, wall: 1_000_000 });
  assert.deepEqual(tl.toMedia(5, 8), { start: 125, end: 128 });
});

test('datation : vitesse de lecture 1,5', () => {
  const tl = new Timeline();
  capture(tl, 0, 20);
  tl.markMedia({ time: 10, rate: 1.5, paused: false, wall: 0 });
  assert.deepEqual(tl.toMedia(2, 4), { start: 13, end: 16 });
});

test('datation : pause puis reprise', () => {
  const tl = new Timeline();
  capture(tl, 0, 30);
  tl.markMedia({ time: 0, rate: 1, paused: false, wall: 0 });
  tl.markMedia({ time: 10, rate: 1, paused: true, wall: 10_000 }); // pause à 10 s
  tl.markMedia({ time: 10, rate: 1, paused: false, wall: 15_000 }); // reprise 5 s plus tard
  assert.deepEqual(tl.toMedia(16, 18), { start: 11, end: 13 });
  assert.equal(tl.wallToMedia(12_000), 10); // pendant la pause
});

test('datation : saut en arrière', () => {
  const tl = new Timeline();
  capture(tl, 0, 40);
  tl.markMedia({ time: 100, rate: 1, paused: false, wall: 0 });
  tl.markMedia({ time: 60, rate: 1, paused: false, wall: 20_000 }); // retour à 60 s
  assert.deepEqual(tl.toMedia(25, 27), { start: 65, end: 67 });
});

test('datation : phrase à cheval sur un saut arrière, rejetée', () => {
  const tl = new Timeline();
  capture(tl, 0, 40);
  tl.markMedia({ time: 100, rate: 1, paused: false, wall: 0 });
  tl.markMedia({ time: 60, rate: 1, paused: false, wall: 20_000 });
  assert.equal(tl.toMedia(18, 22), null);
});

test('datation : sans lecteur vidéo, impossible', () => {
  const tl = new Timeline();
  capture(tl, 0, 10);
  assert.equal(tl.hasMedia, false);
  assert.equal(tl.toMedia(1, 2), null);
});

test('identité : YouTube, quel que soit le format, sans paramètres temporaires', () => {
  const a = videoIdentity('https://www.youtube.com/watch?v=abc123XYZ&t=42s&si=xyz');
  const b = videoIdentity('https://youtu.be/abc123XYZ?t=10');
  const c = videoIdentity('https://m.youtube.com/watch?feature=share&v=abc123XYZ');
  assert.equal(a.id, 'youtube:abc123XYZ');
  assert.equal(b.id, a.id);
  assert.equal(c.id, a.id);
  assert.equal(a.url, 'https://www.youtube.com/watch?v=abc123XYZ');
});

test('identité : Udemy, cours + leçon', () => {
  const a = videoIdentity('https://www.udemy.com/course/spring-boot-intro/learn/lecture/12345678?start=30#overview');
  assert.equal(a.id, 'udemy:spring-boot-intro:12345678');
  assert.equal(a.site, 'udemy');
  const b = videoIdentity('https://www.udemy.com/course/spring-boot-intro/learn/lecture/87654321');
  assert.notEqual(a.id, b.id);
});

test('identité : cas général, paramètres utiles gardés et triés', () => {
  const a = videoIdentity('https://exemple.org/videos/play/?utm_source=x&id=7&token=secret');
  assert.equal(a.id, 'exemple.org/videos/play?id=7');
  assert.ok(!a.url.includes('token'));
});

test('titre nettoyé', () => {
  assert.equal(cleanTitle('(3) Introduction to Spring Boot - YouTube'), 'Introduction to Spring Boot');
  assert.equal(cleanTitle('Leçon 4 | Udemy'), 'Leçon 4');
  assert.equal(cleanTitle(''), 'Vidéo sans titre');
});

test('couverture : fusion des intervalles et progression', () => {
  let c = mergeInterval([], 0, 4);
  c = mergeInterval(c, 5, 9); // silence de 1 s : fusionné
  c = mergeInterval(c, 30, 35); // trou de 21 s : séparé
  assert.deepEqual(c, [[0, 9], [30, 35]]);
  assert.equal(coveredSeconds(c), 14);
});

test('doublons : retour en arrière sur un passage déjà traduit', () => {
  const existing = [{ start: 10, end: 13 }, { start: 13.2, end: 16 }];
  assert.ok(findDuplicate(existing, 10.3, 13.1)); // même phrase, découpée un peu autrement
  assert.ok(findDuplicate(existing, 12.9, 15.8));
  assert.equal(findDuplicate(existing, 16.5, 19), null); // phrase suivante, nouvelle
});

test('identifiant de phrase stable', () => {
  assert.equal(segmentId('youtube:x', 12.34), 'youtube:x#123');
});
