"""Traitement du texte : phrases, glossaire, termes protégés, texte à prononcer."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# --------------------------------------------------------------------- phrases

_ABBREV = {
    "e.g.", "i.e.", "etc.", "vs.", "mr.", "mrs.", "ms.", "dr.", "prof.", "inc.",
    "ltd.", "no.", "fig.", "approx.", "a.m.", "p.m.", "u.s.", "st.", "jr.", "sr.",
}
_SENT_END = re.compile(r"""([.!?…]+["')\]]*)\s+(?=["'(\[]?[A-Z0-9])""")
_TERMINAL = re.compile(r"""[.!?…]["')\]]*\s*$""")


def split_sentences(text: str) -> list:
    """Découpe un texte anglais en phrases, sans couper sur les abréviations,
    les nombres décimaux (« 6.5 ») ni les identifiants à points."""
    text = " ".join(text.split())
    if not text:
        return []
    out, start = [], 0
    for m in _SENT_END.finditer(text):
        end = m.end(1)
        last_word = text[start:end].rsplit(" ", 1)[-1].lower()
        if last_word in _ABBREV:
            continue
        # Initiale isolée (« J. Smith ») : ne pas couper.
        if re.fullmatch(r"[a-z]\.", last_word):
            continue
        out.append(text[start:end].strip())
        start = m.end()
    rest = text[start:].strip()
    if rest:
        out.append(rest)
    return out


def ends_sentence(text: str) -> bool:
    return bool(_TERMINAL.search(text))


# -------------------------------------------------------------------- glossaire


@dataclass
class GlossaryEntry:
    """Entrée du glossaire.

    kind="term" : terme anglais `src`. Si `dst` est vide (ou identique), le
        terme est conservé tel quel ; sinon `dst` est la traduction imposée.
        `aliases` liste les formes mal reconnues à corriger (« tipco »).
    kind="post" : remplacement appliqué au texte français après traduction
        (« conférence » -> « leçon »).
    """

    src: str
    dst: str = ""
    aliases: list = field(default_factory=list)
    kind: str = "term"

    @property
    def keep(self) -> bool:
        return not self.dst or self.dst == self.src


MAX_GLOSSARY = 300
MAX_TERM_LEN = 80


def parse_glossary(raw) -> list:
    """Valide la liste reçue de l'extension. Lève ValueError si invalide."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("glossaire : liste attendue")
    if len(raw) > MAX_GLOSSARY:
        raise ValueError(f"glossaire : {MAX_GLOSSARY} entrées au maximum")
    out = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("glossaire : entrée invalide")
        src = item.get("src")
        dst = item.get("dst", "")
        aliases = item.get("aliases", [])
        kind = item.get("kind", "term")
        if kind not in ("term", "post", "idiom"):
            raise ValueError("glossaire : type d'entrée inconnu")
        if kind in ("post", "idiom") and (not isinstance(dst, str) or not dst.strip()):
            raise ValueError("glossaire : remplacement sans texte cible")
        if not isinstance(src, str) or not src.strip():
            raise ValueError("glossaire : terme source manquant")
        if not isinstance(dst, str) or not isinstance(aliases, list):
            raise ValueError("glossaire : entrée invalide")
        if len(src) > MAX_TERM_LEN or len(dst) > MAX_TERM_LEN or len(aliases) > 12:
            raise ValueError("glossaire : terme trop long")
        clean_aliases = []
        for a in aliases:
            if not isinstance(a, str) or len(a) > MAX_TERM_LEN:
                raise ValueError("glossaire : alias invalide")
            if a.strip():
                clean_aliases.append(" ".join(a.split()))
        out.append(GlossaryEntry(" ".join(src.split()), " ".join(dst.split()), clean_aliases, kind))
    return out


def _term_regex(term: str) -> re.Pattern:
    # Frontières de mot « souples » : fonctionnent aussi pour « C++ » ou « .NET ».
    body = r"\s+".join(re.escape(p) for p in term.split())
    return re.compile(r"(?<![\w])" + body + r"(?![\w])", re.IGNORECASE)


class Glossary:
    def __init__(self, entries: list | None = None):
        all_entries = list(entries or [])
        self.entries = [e for e in all_entries if e.kind == "term"]
        self.post = [e for e in all_entries if e.kind == "post"]
        self.idioms = [(e.src, e.dst) for e in all_entries if e.kind == "idiom"]
        self._alias_rx = []
        for e in self.entries:
            for a in e.aliases:
                if a.lower() != e.src.lower():
                    self._alias_rx.append((_term_regex(a), e.src))
            # Restaurer la casse officielle (« tibco » -> « TIBCO »).
            if any(ch.isupper() for ch in e.src):
                self._alias_rx.append((_term_regex(e.src), e.src))
        # Les termes les plus longs d'abord (« TIBCO Business Studio » avant « TIBCO »).
        self._terms = sorted(self.entries, key=lambda e: -len(e.src))
        self._term_rx = [(_term_regex(e.src), e) for e in self._terms]
        self._post_rx = [(_term_regex(e.src), e.dst)
                         for e in sorted(self.post, key=lambda e: -len(e.src))]

    def correct_transcript(self, text: str) -> str:
        """Corrige les formes mal reconnues et la casse des termes connus."""
        for rx, good in self._alias_rx:
            text = rx.sub(lambda m, g=good: g, text)
        return text

    def asr_prompt(self, limit: int = 30, extra: list | None = None) -> str:
        """Phrase-amorce donnée au moteur de reconnaissance.

        Une phrase ponctuée contenant les noms propres du glossaire améliore
        leur reconnaissance sans dégrader la ponctuation (contrairement à une
        simple liste de mots-clés, d'après nos essais)."""
        names = [e.src for e in self.entries if any(ch.isupper() for ch in e.src)][:limit]
        for n in extra or []:
            if n not in names and len(names) < limit + 15:
                names.append(n)
        if not names:
            return ""
        # Formulation neutre (tous contenus) ; comparée sur l'extrait de test,
        # elle reconnaît les noms aussi bien que « This course covers… », alors
        # que « Glossary: … » dégradait la reconnaissance (« OpenTico »).
        return "This video mentions " + ", ".join(names) + "."

    def find(self, text: str, entries_filter=None) -> list:
        """Occurrences (début, fin, entrée) sans chevauchement."""
        spans = []
        for rx, e in self._term_rx:
            if entries_filter is not None and not entries_filter(e):
                continue
            for m in rx.finditer(text):
                if not any(m.start() < b and a < m.end() for a, b, _ in spans):
                    spans.append((m.start(), m.end(), e))
        return sorted(spans, key=lambda s: s[0])

    def substitute_forced(self, text: str):
        """Insère les traductions imposées directement dans la phrase source.

        Les modèles OPUS-MT recopient en général ces termes français et
        accordent correctement le reste de la phrase autour d'eux.
        Renvoie (texte, liste des termes français attendus dans la sortie)."""
        spans = self.find(text, lambda e: not e.keep)
        if not spans:
            return text, []
        out, pos, expected = [], 0, []
        for a, b, e in spans:
            out.append(text[pos:a])
            out.append(e.dst)
            expected.append(e.dst)
            pos = b
        out.append(text[pos:])
        return "".join(out), expected

    def apply_post(self, text: str) -> str:
        """Remplacements français -> français, en conservant la majuscule initiale."""
        for rx, dst in self._post_rx:
            def rep(m, dst=dst):
                return dst[:1].upper() + dst[1:] if m.group(0)[:1].isupper() else dst
            text = rx.sub(rep, text)
        return text


# ------------------------------------------------------------ termes « code »

_CODE_PATTERNS = [
    r"https?://[^\s,;]+",  # URL
    r"[A-Za-z]:\\[^\s,;]+",  # chemin Windows
    r"(?<![\w/])(?:~|\.{1,2})?(?:/[\w.\-]+){2,}/?",  # chemin Unix
    r"(?<![\w\-])--?[A-Za-z][\w\-]*=?[\w./\\:-]*(?<![.,;:])",  # option de commande
    r"\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?:\(\))?",  # identifiant à points, fichier.ext
    r"\b\w+(?:_\w+)+\b",  # snake_case
    r"\b[a-z]+\d*[A-Z]\w*(?:\(\))?",  # camelCase
    r"\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b(?:\(\))?",  # PascalCase
    r"\b[A-Za-z_]\w*\(\)",  # appel()
    r"`[^`]+`",
]
_CODE_RX = re.compile("|".join(f"(?:{p})" for p in _CODE_PATTERNS))
_NOT_CODE = {"e.g", "i.e", "a.m", "p.m", "u.s", "e.g.", "i.e."}


def find_code_spans(text: str) -> list:
    spans = []
    for m in _CODE_RX.finditer(text):
        tok = m.group(0)
        if tok.lower().rstrip(".") in _NOT_CODE:
            continue
        end = m.end()
        # Ne pas avaler la ponctuation finale de la phrase.
        while end > m.start() + 1 and text[end - 1] in ".,;:!?":
            end -= 1
        if end - m.start() >= 2:
            spans.append((m.start(), end))
    return spans


@dataclass
class Protected:
    """Texte dont certains passages sont remplacés par des jetons stables."""

    text: str  # texte avec jetons
    items: list  # [(jeton, texte d'origine, texte final)]


def placeholder(i: int) -> str:
    # Forme validée expérimentalement : recopiée telle quelle par les modèles
    # OPUS-MT (base et tc-big).
    return f"ZX{i}Q"


_PLACEHOLDER_RX = re.compile(r"ZX(\d+)Q")


def protect(text: str, glossary: Glossary, *, code: bool, extra: list | None = None) -> Protected:
    """Remplace par des jetons les termes du glossaire (et, si code=True,
    les passages ressemblant à du code). `extra` : passages prioritaires
    [(début, fin, texte final)], par exemple des expressions idiomatiques."""
    spans = list(extra or [])
    for a, b, e in glossary.find(text):
        if not any(a < y and x < b for x, y, _ in spans):
            spans.append((a, b, e.src if e.keep else e.dst))
    if code:
        for a, b in find_code_spans(text):
            if not any(a < y and x < b for x, y, _ in spans):
                spans.append((a, b, text[a:b]))
    spans.sort(key=lambda s: s[0])
    out, pos, items = [], 0, []
    for idx, (a, b, final) in enumerate(spans, start=1):
        tok = placeholder(idx)
        out.append(text[pos:a])
        out.append(tok)
        items.append((tok, text[a:b], final))
        pos = b
    out.append(text[pos:])
    return Protected("".join(out), items)


def restore(translated: str, prot: Protected):
    """Réinsère les termes. Renvoie (texte, ok) ; ok=False si un jeton a été
    perdu ou dupliqué par le traducteur."""
    ok = True
    for tok, _orig, final in prot.items:
        if translated.count(tok) != 1:
            ok = False
        translated = translated.replace(tok, final)
    if _PLACEHOLDER_RX.search(translated):
        ok = False
        translated = _PLACEHOLDER_RX.sub("", translated)
    return " ".join(translated.split()), ok


def protected_terms(text: str, glossary: Glossary) -> list:
    """Termes à retrouver à l'identique dans la traduction."""
    terms = [text[a:b] for a, b in find_code_spans(text)]
    terms += [e.src for _a, _b, e in glossary.find(text) if e.keep]
    seen, out = set(), []
    for t in terms:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


# ------------------------------------------------------- qualité de traduction

_REPEAT_RX = re.compile(r"(\b\w+\b)(?:\W+\1\b){4,}", re.IGNORECASE)


def looks_degenerate(src: str, dst: str) -> bool:
    """Détecte les sorties manifestement invalides du traducteur."""
    if not dst.strip():
        return True
    if _REPEAT_RX.search(dst) and not _REPEAT_RX.search(src):
        return True
    ls, ld = max(1, len(src)), len(dst)
    if ls >= 12 and (ld > 3.5 * ls or ld < 0.2 * ls):
        return True
    return False


# ------------------------------------------------------- texte à prononcer (fr)

_CAMEL_SPLIT = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_URL_RX = re.compile(r"https?://([^\s/,;]+)[^\s,;]*")
_WINPATH_RX = re.compile(r"\b([A-Za-z]):\\([^\s,;]*)")
_UNIXPATH_RX = re.compile(r"(?<![\w/])(?:~|\.{1,2})?((?:/[\w.\-]+){2,})/?")
_IDENT_RX = re.compile(r"\b[A-Za-z_][\w]*(?:[._][A-Za-z_]\w*)+\b|\b\w*[a-z0-9][A-Z]\w*\b")


def _speak_components(parts: list) -> str:
    parts = [p for p in parts if p]
    if len(parts) > 5:  # chemin long : on ne lit que la fin
        parts = parts[-3:]
    return " ".join(parts)


def _speak_ident(tok: str) -> str:
    words = []
    for part in re.split(r"[._]+", tok):
        words.extend(w for w in _CAMEL_SPLIT.split(part) if w)
    return " ".join(words)


def speakable_fr(text: str) -> str:
    """Prépare le texte pour la synthèse : évite d'épeler chemins, symboles
    et identifiants caractère par caractère. N'altère pas les sous-titres."""
    t = text
    t = _URL_RX.sub(lambda m: m.group(1).replace(".", " point "), t)
    t = _WINPATH_RX.sub(
        lambda m: m.group(1).upper() + " " + _speak_components(re.split(r"[\\/]+", m.group(2))), t
    )
    t = _UNIXPATH_RX.sub(lambda m: _speak_components(m.group(1).split("/")), t)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"\(\)", "", t)
    t = _IDENT_RX.sub(lambda m: _speak_ident(m.group(0)), t)
    t = re.sub(r"\s*(==|=)\s*", " égal ", t)
    t = re.sub(r"\s*->\s*|\s*=>\s*", " vers ", t)
    t = t.replace("&&", " et ").replace("||", " ou ")
    t = re.sub(r"[{}\[\]<>|\\^~*#_]+", " ", t)
    t = re.sub(r"\s+([,.;:!?])", r"\1", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t
