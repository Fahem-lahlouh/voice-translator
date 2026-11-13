const v = document.getElementById('v');
const log = (m) => {
  const el = document.getElementById('log');
  el.textContent += `${new Date().toLocaleTimeString('fr-FR')}  ${m}\n`;
  el.scrollTop = el.scrollHeight;
};
const CLIPS = ['../audio/tibco_demo_en.ogg', '../audio/canterville_90s.ogg'];
let clip = 0;

document.getElementById('play').onclick = () => v.play();
document.getElementById('pause').onclick = () => v.pause();
document.getElementById('back').onclick = () => { v.currentTime = Math.max(0, v.currentTime - 20); };
document.getElementById('fwd').onclick = () => { v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 20); };
document.getElementById('fast').onclick = () => { v.playbackRate = 1.25; };
document.getElementById('normal').onclick = () => { v.playbackRate = 1; };
document.getElementById('switch').onclick = () => {
  clip = (clip + 1) % CLIPS.length;
  document.getElementById('src').src = CLIPS[clip];
  document.getElementById('now').textContent = CLIPS[clip].split('/').pop();
  v.load();
  v.play();
  // Changement d'adresse : vérifie la détection du changement de leçon.
  history.pushState({}, '', `?lecon=${clip + 1}`);
  log(`changement d'extrait -> ${CLIPS[clip]}`);
};
document.getElementById('silence').onclick = () => {
  // Remplace la piste par 15 s de silence (test des silences).
  const ctx = new AudioContext();
  const dst = ctx.createMediaStreamDestination();
  ctx.createConstantSource().connect(dst);
  log('silence : mettez la vidéo en pause pendant 15 s pour tester');
  v.pause();
  setTimeout(() => { v.play(); log('reprise après silence'); }, 15000);
};

for (const ev of ['play', 'pause', 'seeked', 'ratechange', 'ended', 'error']) {
  v.addEventListener(ev, () => log(`vidéo : ${ev} (t=${v.currentTime.toFixed(1)} s)`));
}
setInterval(() => {
  document.getElementById('pos').textContent = v.currentTime.toFixed(1).replace('.', ',');
  document.getElementById('rate').textContent = String(v.playbackRate);
}, 250);
log('page de test prête');
