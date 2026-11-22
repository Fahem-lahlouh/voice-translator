// Identité stable d'une vidéo, pour retrouver la même session quand on y
// revient. Les paramètres temporaires de l'adresse (position « t= »,
// jetons, suivi, etc.) sont ignorés ; seuls quelques paramètres qui
// désignent vraiment le contenu sont conservés.

const KEEP_PARAMS = ['v', 'id', 'video', 'lecture', 'episode', 'ep', 'e', 'list'];

const TITLE_SUFFIXES = [
  / [-|–] YouTube$/i, / \| Udemy$/i, / \| Coursera$/i, / [-|–] Vimeo$/i, / [-|–] Dailymotion$/i,
  / \| Netflix$/i, / \| LinkedIn Learning.*$/i, /^\(\d+\) /,
];

export function cleanTitle(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  for (const rx of TITLE_SUFFIXES) t = t.replace(rx, '');
  return t.slice(0, 200) || 'Vidéo sans titre';
}

export function videoIdentity(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    return { id: 'inconnu', url: '', site: 'inconnu' };
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const path = u.pathname.replace(/\/+$/, '') || '/';

  // YouTube : identifiant de la vidéo, quel que soit le format d'adresse.
  if (/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be') {
    const id = host === 'youtu.be' ? path.slice(1)
      : (u.searchParams.get('v') || (path.match(/^\/(?:shorts|embed|live)\/([\w-]+)/) || [])[1]);
    if (id) return { id: `youtube:${id}`, url: `https://www.youtube.com/watch?v=${id}`, site: 'youtube' };
  }
  // Udemy : cours + leçon.
  if (/(^|\.)udemy\.com$/.test(host)) {
    const m = path.match(/^\/course\/([^/]+)\/learn\/(lecture|quiz|practice)\/(\d+)/);
    if (m) {
      return { id: `udemy:${m[1]}:${m[3]}`, url: `https://www.udemy.com/course/${m[1]}/learn/${m[2]}/${m[3]}`, site: 'udemy' };
    }
  }
  // Vimeo.
  if (/(^|\.)vimeo\.com$/.test(host)) {
    const m = path.match(/\/(\d{5,})/);
    if (m) return { id: `vimeo:${m[1]}`, url: `https://vimeo.com/${m[1]}`, site: 'vimeo' };
  }

  // Cas général : domaine + chemin + paramètres utiles, triés.
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => KEEP_PARAMS.includes(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : '';
  const site = host.split('.').slice(-2, -1)[0] || host;
  return { id: `${host}${path}${query}`, url: `${u.origin}${path}${query}`, site };
}
