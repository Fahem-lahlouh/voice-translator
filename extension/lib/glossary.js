// Glossaire personnalisable : syntaxe texte <-> entrées envoyées au serveur.
//
//   TIBCO | tipco, tibko              terme conservé tel quel, avec les formes
//                                     mal reconnues à corriger
//   shared resource = ressource partagée     traduction imposée
//   fr: conférence => leçon           remplacement dans le texte français
//   # commentaire

export const MAX_ENTRIES = 300;
export const MAX_TERM = 80;

export function parseGlossaryText(text) {
  const entries = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const n = i + 1;
    const post = line.match(/^fr\s*:\s*(.+?)\s*=>\s*(.+)$/i);
    if (post) {
      entries.push({ kind: 'post', src: post[1].trim(), dst: post[2].trim(), aliases: [] });
      return;
    }
    const [main, aliasPart] = splitOnce(line, '|');
    const [src, dst] = splitOnce(main, '=');
    const entry = {
      src: src.trim(),
      dst: (dst || '').trim(),
      aliases: (aliasPart || '').split(',').map((a) => a.trim()).filter(Boolean),
    };
    if (!entry.src) {
      errors.push(`Ligne ${n} : terme manquant.`);
      return;
    }
    entries.push(entry);
  });
  for (const e of entries) {
    if (e.src.length > MAX_TERM || e.dst.length > MAX_TERM || e.aliases.some((a) => a.length > MAX_TERM)) {
      errors.push(`« ${e.src.slice(0, 30)}… » : ${MAX_TERM} caractères au maximum par terme.`);
    }
    if (e.aliases.length > 12) errors.push(`« ${e.src} » : 12 formes alternatives au maximum.`);
  }
  if (entries.length > MAX_ENTRIES) errors.push(`${MAX_ENTRIES} entrées au maximum.`);
  return { entries: errors.length ? [] : entries, errors };
}

function splitOnce(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + sep.length)];
}

export function glossaryToText(entries) {
  const out = [
    '# Une entrée par ligne.',
    '#   Terme | forme mal reconnue, autre forme     → terme conservé tel quel',
    '#   english term = traduction française         → traduction imposée',
    '#   fr: mot français => autre mot               → remplacement après traduction',
    '',
  ];
  for (const e of entries) {
    if (e.kind === 'post') {
      out.push(`fr: ${e.src} => ${e.dst}`);
      continue;
    }
    let line = e.src;
    if (e.dst && e.dst !== e.src) line += ` = ${e.dst}`;
    if (e.aliases && e.aliases.length) line += ` | ${e.aliases.join(', ')}`;
    out.push(line);
  }
  return out.join('\n') + '\n';
}
