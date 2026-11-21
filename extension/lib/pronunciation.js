// Dictionnaire de prononciation personnalisable (texte <-> règles serveur).
//
//   SAP = épeler                 lettres prononcées à la française
//   NASA = mot                   lu comme un mot
//   Kubernetes = kou beur né tisse   texte à prononcer
//   IT = épeler @formation       seulement pour ce type de contenu
//   # commentaire
//
// Ces règles ne changent QUE la voix : sous-titres et transcriptions gardent
// l'orthographe d'origine.

const MODES = { 'épeler': 'epeler', epeler: 'epeler', mot: 'mot' };
const DOMAINS = ['film', 'formation', 'documentaire', 'conversation'];

export function parsePronunciationText(text) {
  const rules = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = line.match(/^(.+?)\s*=\s*(.+?)(?:\s+@(\S+))?$/);
    if (!m) {
      errors.push(`Ligne ${i + 1} : forme attendue « terme = épeler », « terme = mot » ou « terme = texte à dire ».`);
      return;
    }
    const term = m[1].trim();
    const value = m[2].trim();
    const domain = (m[3] || '').toLowerCase();
    if (term.length > 60 || value.length > 120) {
      errors.push(`Ligne ${i + 1} : terme ou prononciation trop long.`);
      return;
    }
    if (domain && !DOMAINS.includes(domain)) {
      errors.push(`Ligne ${i + 1} : type de contenu inconnu « ${domain} » (${DOMAINS.join(', ')}).`);
      return;
    }
    const mode = MODES[value.toLowerCase()] || 'dire';
    rules.push({ term, mode, say: mode === 'dire' ? value : '', domain });
  });
  if (rules.length > 300) errors.push('300 règles au maximum.');
  return { rules: errors.length ? [] : rules, errors };
}

export const PRONUNCIATION_HELP = [
  '# Une règle par ligne. Seule la voix est concernée, jamais les sous-titres.',
  '#   SAP = épeler                     lettres prononcées à la française',
  '#   NASA = mot                       lu comme un mot',
  '#   Kubernetes = kou beur né tisse   texte à prononcer',
  '#   IT = épeler @formation           seulement pour ce type de contenu',
  '# Les sigles courants (SAP, ERP, API, FBI, NASA, OTAN…) sont déjà gérés.',
  '',
].join('\n');
