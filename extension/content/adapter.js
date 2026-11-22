// Script injecté dans l'onglet capturé (uniquement après « Démarrer »).
//
// Rôle : observer le lecteur vidéo (lecture, pause, saut, vitesse, changement
// de leçon), exécuter « pause / lecture » pour la synchronisation, et afficher
// les sous-titres. Il ne lit ni cookies, ni identifiants, ni contenu de page,
// et n'émet aucune requête réseau.
//
// Mode générique : n'importe quelle balise <video> ou <audio>.
// Adaptateur Udemy : détection du changement de leçon par l'adresse de la page.

(() => {
  if (window.__doublageAdapter) {
    window.__doublageAdapter.announce();
    return;
  }

  const isTop = window.top === window;
  const isUdemy = /(^|\.)udemy\.com$/i.test(location.hostname);
  const site = isUdemy ? 'udemy' : 'generique';

  let media = null;
  let disposed = false;
  let lastTime = 0;
  let lastTimeAt = 0;
  let commandUntil = 0; // fenêtre pendant laquelle un play/pause vient de l'extension
  let lastLessonKey = lessonKey();
  let overlay = null;
  let overlayTimer = null;
  let subtitlesEnabled = true;

  const send = (type, extra = {}) => {
    if (disposed) return;
    try {
      chrome.runtime.sendMessage({ target: 'media', type, site, top: isTop, ...extra }).catch(() => {});
    } catch (_) {
      dispose(); // extension rechargée : ce script est orphelin
    }
  };

  // ------------------------------------------------------- choix du lecteur
  function pickMedia() {
    const all = Array.from(document.querySelectorAll('video, audio'));
    if (!all.length) return null;
    const score = (el) => {
      const r = el.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      return (el.paused ? 0 : 1e9) + (el.readyState > 0 ? 1e6 : 0) + area;
    };
    return all.sort((a, b) => score(b) - score(a))[0];
  }

  const EVENTS = ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'emptied', 'timeupdate', 'ended',
    'loadedmetadata', 'durationchange'];
  let lastMarkAt = 0;

  // Repère de temps : position de la vidéo à une heure murale donnée. Sert à
  // dater chaque phrase traduite dans le temps de la vidéo.
  function mark() {
    if (!media) return;
    lastMarkAt = performance.now();
    send('time', {
      t: media.currentTime, rate: media.playbackRate, paused: media.paused || media.seeking,
      wall: Date.now(), duration: Number.isFinite(media.duration) ? media.duration : null,
    });
  }

  // Informations de la page (la page principale seulement) : adresse et titre,
  // pour retrouver la vidéo dans la bibliothèque. Rien d'autre n'est lu.
  function pageInfo() {
    if (!isTop) return;
    send('pageinfo', { url: location.href, title: document.title });
  }

  function bind(el) {
    if (media === el) return;
    if (media) EVENTS.forEach((ev) => media.removeEventListener(ev, onMedia, true));
    media = el;
    if (!media) {
      send('gone');
      return;
    }
    EVENTS.forEach((ev) => media.addEventListener(ev, onMedia, true));
    lastTime = media.currentTime;
    lastTimeAt = performance.now();
    announce();
  }

  function announce() {
    send('hello', { hasMedia: !!media, rate: media ? media.playbackRate : 1, paused: media ? media.paused : true });
    pageInfo();
    mark();
  }

  function onMedia(ev) {
    const el = ev.target;
    if (el !== media) return;
    const now = performance.now();
    const byExtension = now < commandUntil;
    switch (ev.type) {
      case 'timeupdate': {
        // Saut détecté même si le site n'émet pas « seeked » de façon fiable.
        const expected = lastTime + ((now - lastTimeAt) / 1000) * el.playbackRate;
        if (!el.seeking && Math.abs(el.currentTime - expected) > 2.5 && lastTimeAt) {
          send('seeked', { time: el.currentTime, inferred: true });
        }
        lastTime = el.currentTime;
        lastTimeAt = now;
        if (now - lastMarkAt > 1000) mark();
        return;
      }
      case 'seeked':
        lastTime = el.currentTime;
        lastTimeAt = now;
        send('seeked', { time: el.currentTime });
        break;
      case 'play':
        lastTime = el.currentTime;
        lastTimeAt = now;
        send('play', { byExtension });
        break;
      case 'pause':
        send('pause', { byExtension });
        break;
      case 'ratechange':
        send('ratechange', { rate: el.playbackRate });
        break;
      case 'emptied': // la source de la vidéo a changé
        send('srcchange');
        break;
      default:
        break;
    }
    mark();
  }

  // ---------------------------------------- changement de leçon (adresse)
  function lessonKey() {
    if (isUdemy) {
      const m = location.pathname.match(/\/learn\/(?:lecture|quiz|practice)\/(\d+)/);
      return m ? `udemy:${m[1]}` : `udemy:${location.pathname}`;
    }
    return location.origin + location.pathname;
  }

  function checkLesson() {
    const key = lessonKey();
    if (key !== lastLessonKey) {
      lastLessonKey = key;
      if (isTop) {
        send('lessonchange', { key: isUdemy ? key : '' });
        pageInfo();
        setTimeout(pageInfo, 1500); // le titre de la page est souvent mis à jour après l'adresse
      }
    }
  }

  // ------------------------------------------------------------ surveillance
  const observer = new MutationObserver(() => {
    if (!media || !media.isConnected) bind(pickMedia());
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const poll = setInterval(() => {
    checkLesson();
    const best = pickMedia();
    if (best && best !== media && (!media || !media.isConnected || (media.paused && !best.paused))) bind(best);
  }, 700);
  window.addEventListener('popstate', checkLesson);

  // -------------------------------------------------------------- sous-titres
  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement('div');
    overlay.setAttribute('data-doublage-sous-titres', '');
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'off'); // la voix lit déjà le texte
    overlay.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:9%', 'transform:translateX(-50%)',
      'max-width:min(80vw,1100px)', 'padding:.45em .8em', 'border-radius:.45em',
      'background:rgba(0,0,0,.78)', 'color:#fff', 'font:500 clamp(15px,1.9vw,26px)/1.35 system-ui,Segoe UI,Arial,sans-serif',
      'text-align:center', 'z-index:2147483647', 'pointer-events:none', 'white-space:pre-line',
      'text-shadow:0 1px 2px #000', 'display:none',
    ].join(';');
    const fr = document.createElement('div');
    fr.lang = 'fr';
    const en = document.createElement('div');
    en.lang = 'en';
    en.style.cssText = 'font-size:.72em;opacity:.8;margin-top:.2em';
    overlay.append(fr, en);
    place();
    return overlay;
  }

  function place() {
    if (!overlay) return;
    // En plein écran, seul le contenu de l'élément plein écran est visible.
    const host = document.fullscreenElement || document.documentElement;
    if (overlay.parentNode !== host) host.appendChild(overlay);
  }

  function showSubtitle(fr, en, duration) {
    if (!subtitlesEnabled) return;
    const el = ensureOverlay();
    place();
    el.children[0].textContent = fr || '';
    el.children[1].textContent = en || '';
    el.children[1].style.display = en ? '' : 'none';
    el.style.display = fr ? '' : 'none';
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(hideSubtitle, Math.max(2, duration || 5) * 1000);
  }

  function hideSubtitle() {
    clearTimeout(overlayTimer);
    if (overlay) overlay.style.display = 'none';
  }

  document.addEventListener('fullscreenchange', place);

  // ----------------------------------------------------------------- commandes
  function onMessage(msg, sender) {
    if (!msg || msg.target !== 'adapter' || sender.id !== chrome.runtime.id) return;
    switch (msg.type) {
      case 'command':
        if (!media) return;
        commandUntil = performance.now() + 800;
        if (msg.command === 'pause' && !media.paused) media.pause();
        else if (msg.command === 'play' && media.paused) media.play().catch(() => send('playRefused'));
        break;
      case 'subtitle':
        // La page principale affiche les sous-titres ; un cadre interne ne le
        // fait que s'il est en plein écran (il masque alors la page).
        if (msg.clear) hideSubtitle();
        else if (isTop || document.fullscreenElement) showSubtitle(msg.fr, msg.en, msg.duration);
        break;
      case 'subtitleConfig':
        subtitlesEnabled = !!msg.enabled;
        if (!subtitlesEnabled) hideSubtitle();
        break;
      case 'dispose':
        dispose();
        break;
      default:
        break;
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    clearInterval(poll);
    window.removeEventListener('popstate', checkLesson);
    document.removeEventListener('fullscreenchange', place);
    if (media) EVENTS.forEach((ev) => media.removeEventListener(ev, onMedia, true));
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch (_) { /* contexte invalidé */ }
    hideSubtitle();
    if (overlay) overlay.remove();
    delete window.__doublageAdapter;
  }

  window.__doublageAdapter = { announce, dispose };
  bind(pickMedia());
  if (!media && isTop) announce();
})();
