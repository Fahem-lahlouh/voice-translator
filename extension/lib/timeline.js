// Conversion « horloge de capture » → « temps de la vidéo ».
//
// Le serveur date chaque phrase en secondes de son anglais capté depuis le
// début de l'époque (t0, t1). Pour la retrouver dans la vidéo, on relie :
//   1. horloge de capture → heure murale (Date.now) : un repère par bloc
//      audio envoyé (toutes les 100 ms) ;
//   2. heure murale → temps de la vidéo : un repère envoyé par le lecteur
//      (position, vitesse, pause) à chaque événement et chaque seconde.
// Date.now() est commun à tous les contextes de l'extension, ce qui permet de
// croiser les deux sources.

const MAX_CAPTURE_MARKS = 1800; // 3 min de blocs de 100 ms
const MAX_MEDIA_MARKS = 600;

export class Timeline {
  constructor() {
    this.capture = []; // [{ clock, wall }] croissants
    this.media = []; // [{ wall, time, rate, paused }] croissants
  }

  resetCapture() {
    this.capture = [];
  }

  clear() {
    this.capture = [];
    this.media = [];
  }

  markCapture(clock, wall) {
    this.capture.push({ clock, wall });
    if (this.capture.length > MAX_CAPTURE_MARKS) this.capture.splice(0, this.capture.length - MAX_CAPTURE_MARKS);
  }

  markMedia({ time, rate = 1, paused = false, wall }) {
    if (!Number.isFinite(time) || !Number.isFinite(wall)) return;
    const last = this.media[this.media.length - 1];
    if (last && wall < last.wall) return; // repère obsolète
    this.media.push({ wall, time, rate: rate > 0 ? rate : 1, paused: !!paused });
    if (this.media.length > MAX_MEDIA_MARKS) this.media.splice(0, this.media.length - MAX_MEDIA_MARKS);
  }

  get hasMedia() {
    return this.media.length > 0;
  }

  // Heure murale à laquelle l'audio de l'instant `clock` a été capté.
  captureToWall(clock) {
    const c = this.capture;
    if (!c.length) return null;
    if (clock <= c[0].clock) return c[0].wall - (c[0].clock - clock) * 1000;
    const last = c[c.length - 1];
    if (clock >= last.clock) return last.wall + (clock - last.clock) * 1000;
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid].clock <= clock) lo = mid; else hi = mid;
    }
    const a = c[lo];
    const b = c[hi];
    const f = (clock - a.clock) / (b.clock - a.clock || 1);
    return a.wall + f * (b.wall - a.wall);
  }

  // Position dans la vidéo à une heure murale donnée (null si inconnue).
  wallToMedia(wall) {
    const m = this.media;
    if (!m.length || wall < m[0].wall - 2000) return null;
    let i = m.length - 1;
    while (i > 0 && m[i].wall > wall) i--;
    const s = m[i];
    if (s.wall > wall) return s.time; // juste avant le premier repère
    return s.paused ? s.time : s.time + ((wall - s.wall) / 1000) * s.rate;
  }

  // Intervalle de capture [t0, t1] → intervalle dans la vidéo.
  toMedia(t0, t1) {
    const w0 = this.captureToWall(t0);
    const w1 = this.captureToWall(t1);
    if (w0 === null || w1 === null) return null;
    const m0 = this.wallToMedia(w0);
    const m1 = this.wallToMedia(w1);
    if (m0 === null || m1 === null || m1 < m0) return null;
    return { start: round2(m0), end: round2(m1) };
  }
}

const round2 = (x) => Math.round(x * 100) / 100;
