// Tests des exports de la bibliothèque.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fileName, formatDuration, formatTime, matches, toClipboard, toJson, toMarkdown, toSrt, toTxt,
} from '../../extension/lib/exporters.js';

const VIDEO = { id: 'udemy:spring:1', title: 'Introduction to Spring Boot', url: 'https://www.udemy.com/course/spring/learn/lecture/1',
  site: 'udemy', duration: 8100, sourceLang: 'en', targetLang: 'fr', lastSeenAt: 0, timeBase: 'video' };
const SEGS = [
  { id: 'b', start: 12.4, end: 15, en: "Today we're going to discover something interesting.", fr: "Aujourd'hui, nous allons découvrir quelque chose d'intéressant.", translationStatus: 'provisoire' },
  { id: 'a', start: 5, end: 7.5, en: 'Hello everyone, welcome to this course.', fr: 'Bonjour à tous, bienvenue dans cette formation.', translationStatus: 'validee', note: 'Introduction' },
];

test('horodatages', () => {
  assert.equal(formatTime(5), '00:00:05');
  assert.equal(formatTime(3725.5, true), '01:02:05,500');
  assert.equal(formatDuration(8100), '2 h 15');
  assert.equal(formatDuration(null), 'inconnue');
});

test('texte : phrases dans l\'ordre, horodatées, avec la note', () => {
  const t = toTxt(VIDEO, SEGS);
  assert.ok(t.startsWith('Introduction to Spring Boot'));
  assert.ok(t.indexOf('00:00:05') < t.indexOf('00:00:12'));
  assert.match(t, /EN : Hello everyone/);
  assert.match(t, /FR : Bonjour à tous/);
  assert.match(t, /Note : Introduction/);
  assert.match(t, /Durée : 2 h 15/);
});

test('Markdown : titres par horodatage, correction signalée, caractères échappés', () => {
  const md = toMarkdown({ ...VIDEO, title: 'C# *basics*' }, SEGS);
  assert.ok(md.startsWith('# C\\# \\*basics\\*'));
  assert.match(md, /### 00:00:05/);
  assert.match(md, /Traduction corrigée à la main/);
});

test('SRT : numérotation, format des temps, mode bilingue', () => {
  const srt = toSrt(SEGS);
  assert.match(srt, /^1\n00:00:05,000 --> 00:00:07,500\nBonjour à tous/);
  assert.match(srt, /2\n00:00:12,400 --> 00:00:15,000\nAujourd'hui/);
  assert.match(toSrt(SEGS, 'bilingue'), /Bonjour à tous, bienvenue dans cette formation.\nHello everyone/);
});

test('JSON : complet et relisible', () => {
  const j = JSON.parse(toJson(VIDEO, SEGS));
  assert.equal(j.format, 'doublage-vocal-local');
  assert.equal(j.phrases.length, 2);
  assert.equal(j.phrases[0].debut, 5);
  assert.equal(j.phrases[0].statutTraduction, 'validee');
  assert.equal(j.video.titre, 'Introduction to Spring Boot');
});

test('nom de fichier sûr', () => {
  assert.equal(fileName('Leçon 3 : API / REST ?', 'md'), 'Lecon-3-API-REST.md');
  assert.equal(fileName('', 'txt'), 'video.txt');
});

test('copie et recherche (casse et accents ignorés)', () => {
  assert.match(toClipboard(SEGS), /^\[00:00:05\]\nEN : Hello/);
  assert.ok(matches(SEGS[1], 'FORMATION'));
  assert.ok(matches(SEGS[0], 'interessant'));
  assert.ok(matches(SEGS[1], 'introduction')); // la note est aussi cherchée
  assert.ok(!matches(SEGS[0], 'kubernetes'));
});
