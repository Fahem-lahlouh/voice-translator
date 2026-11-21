"""Prononciation : texte affiché ≠ texte prononcé.

Ce module ne transforme QUE le texte envoyé au moteur vocal. Les sous-titres,
la transcription et la traduction affichée gardent l'orthographe d'origine.

Règles, par ordre de priorité :
1. dictionnaire utilisateur (options de l'extension) ;
2. dictionnaire intégré (sigles et noms courants) ;
3. règle générale : un sigle en majuscules de 2 ou 3 lettres est épelé à la
   française ; à partir de 4 lettres, il est laissé au moteur vocal, qui le
   prononce comme un mot quand c'est prononçable (NASA, OTAN) et l'épelle
   sinon (constaté sur Piper / espeak-ng).

Le principal défaut constaté sans ce module : après une élision, « l'ERP »
était lu « lèrp ». Les sigles épelés sont donc écrits en noms de lettres
(« euh èr pé »), ce que le moteur vocal ne peut pas fusionner en un mot.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Nom des lettres en français, écrit pour être lu correctement par la voix.
LETTRES = {
    "A": "a", "B": "bé", "C": "cé", "D": "dé", "E": "euh", "F": "èf", "G": "gé",
    "H": "ache", "I": "i", "J": "ji", "K": "ka", "L": "èl", "M": "èm", "N": "èn",
    "O": "o", "P": "pé", "Q": "ku", "R": "èr", "S": "èss", "T": "té", "U": "u",
    "V": "vé", "W": "double vé", "X": "iks", "Y": "i grec", "Z": "zèd",
}

MODES = ("epeler", "mot", "dire")


@dataclass
class Rule:
    term: str
    mode: str  # "epeler" | "mot" | "dire"
    say: str = ""  # texte à prononcer (mode « dire »)
    domain: str = ""  # vide = tous les contenus
    priority: int = 0

    def spoken(self) -> str:
        if self.mode == "epeler":
            return spell(self.term)
        if self.mode == "dire":
            return self.say
        # « mot » : en minuscules, le moteur vocal le lit comme un mot.
        return self.term.lower()


def spell(term: str) -> str:
    out = []
    for ch in term:
        up = ch.upper()
        if up in LETTRES:
            out.append(LETTRES[up])
        elif ch.isdigit():
            out.append(ch)
    return " ".join(out)


def _r(term, mode, say="", domain=""):
    return Rule(term, mode, say, domain)


# Dictionnaire intégré, vérifié phonème par phonème sur la voix Piper :
# seuls figurent les cas où la règle générale ou le moteur vocal se trompent
# (CIA, UE, JSON, Wi-Fi…) et des sigles fréquents épelés explicitement pour
# résister aux élisions (« l'ERP », « l'API »).
DEFAULT_RULES = [
    _r("CIA", "epeler"),           # le moteur lit « séya » sans cette règle
    _r("OK", "dire", "o-ké"),
    _r("Wi-Fi", "dire", "oui-fi"), _r("WiFi", "dire", "oui-fi"), _r("wifi", "dire", "oui-fi"),
    _r("JSON", "dire", "djé-sonne"),
    _r("SaaS", "dire", "sasse"),
    _r("iOS", "dire", "aïe o èss"),
    _r("iPhone", "dire", "aïe faune"), _r("iPad", "dire", "aïe pad"),
    _r("GitHub", "dire", "guite heub"),
    _r("YouTube", "dire", "you tioube"),
    _r("Docker", "dire", "dockeur"),
    _r("Kubernetes", "dire", "kou beur né tisse"),
    _r("DevOps", "dire", "dèv opse"),
    _r("NASA", "mot"), _r("OTAN", "mot"), _r("UNESCO", "mot"), _r("UNICEF", "mot"),
    _r("ONU", "epeler"), _r("UE", "epeler"),
    _r("SNCF", "epeler"), _r("RATP", "epeler"), _r("PDG", "epeler"),
    _r("SQL", "epeler"), _r("AWS", "epeler"), _r("GCP", "epeler"),
    _r("CEO", "epeler"), _r("CTO", "epeler"), _r("CRM", "epeler"),
    _r("ERP", "epeler"), _r("SAP", "epeler"), _r("API", "epeler"),
    _r("PDF", "epeler"), _r("USB", "epeler"), _r("GPS", "epeler"),
    _r("BMW", "epeler"), _r("BBC", "epeler"), _r("CNN", "epeler"), _r("FBI", "epeler"),
    _r("HTTP", "epeler"), _r("HTTPS", "epeler"), _r("HTML", "epeler"), _r("CSS", "epeler"),
    _r("URL", "epeler"), _r("IA", "epeler"), _r("AI", "epeler"),
]

# Mots français courants qu'un texte peut contenir en majuscules (cri,
# titre) et qu'il ne faut surtout pas épeler.
_MOTS_FRANCAIS = {
    "A", "À", "AU", "AUX", "CE", "CES", "DE", "DES", "DU", "EN", "ET", "EST", "IL", "ILS",
    "JE", "LA", "LE", "LES", "LUI", "MA", "ME", "MES", "MOI", "NE", "NI", "NON", "NOS",
    "NOUS", "ON", "OU", "OUI", "PAR", "PAS", "QUE", "QUI", "SA", "SE", "SES", "SI", "SON",
    "SUR", "TA", "TE", "TES", "TOI", "TON", "TU", "UN", "UNE", "VA", "VAS", "VOS", "VU",
    "Y", "ÇA", "ZUT", "OH", "AH", "EH", "HEIN", "BON", "MAL", "FIN", "TOP", "SOS",
}
_ROMAIN = re.compile(r"^(?=[IVXLC]+$)C{0,3}(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$")
_SIGLE = re.compile(r"(?<![\w-])([A-Z][A-Z0-9]{1,4})(s?)(?![\w-])")


def parse_rules(raw) -> list:
    """Valide le dictionnaire envoyé par l'extension. Lève ValueError."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 300:
        raise ValueError("prononciation : liste de 300 entrées au maximum attendue")
    out = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("prononciation : entrée invalide")
        term, mode = item.get("term"), item.get("mode")
        say, domain = item.get("say", ""), item.get("domain", "")
        if not isinstance(term, str) or not term.strip() or len(term) > 60:
            raise ValueError("prononciation : terme invalide")
        if mode not in MODES:
            raise ValueError(f"prononciation : mode inconnu pour « {term[:30]} »")
        if not isinstance(say, str) or len(say) > 120 or (mode == "dire" and not say.strip()):
            raise ValueError(f"prononciation : texte à dire invalide pour « {term[:30]} »")
        if not isinstance(domain, str) or len(domain) > 30:
            raise ValueError("prononciation : domaine invalide")
        out.append(Rule(" ".join(term.split()), mode, say.strip(), domain.strip().lower(), 10))
    return out


class Pronouncer:
    def __init__(self, user_rules: list | None = None, domain: str = ""):
        self.domain = (domain or "").lower()
        self.user_rules = list(user_rules or [])
        rules = list(user_rules or []) + DEFAULT_RULES
        seen, kept = set(), []
        for r in rules:  # la règle utilisateur l'emporte sur la règle intégrée
            key = (r.term.lower() if r.term.upper() != r.term else r.term, r.domain)
            if key in seen:
                continue
            seen.add(key)
            kept.append(r)
        self.rules = sorted(kept, key=lambda r: (-r.priority, -len(r.term)))
        self._rx = [(self._compile(r), r) for r in self.rules]

    @staticmethod
    def _compile(r: Rule) -> re.Pattern:
        body = r"\s+".join(re.escape(p) for p in r.term.split())
        # Un sigle en majuscules n'est reconnu qu'en majuscules (« SAP » et
        # non « sap ») ; un nom (« YouTube ») l'est quelle que soit la casse.
        flags = 0 if r.term.isupper() else re.IGNORECASE
        return re.compile(r"(?<![\w-])" + body + r"(s?)(?![\w-])", flags)

    def _applies(self, r: Rule) -> bool:
        return not r.domain or r.domain == self.domain

    def apply(self, text: str) -> str:
        spans = []  # (début, fin, remplacement)
        for rx, r in self._rx:
            if not self._applies(r):
                continue
            for m in rx.finditer(text):
                if any(m.start() < b and a < m.end() for a, b, _ in spans):
                    continue
                spans.append((m.start(), m.end(), r.spoken()))
        for m in _SIGLE.finditer(text):
            if any(m.start() < b and a < m.end() for a, b, _ in spans):
                continue
            token = m.group(1)
            if token in _MOTS_FRANCAIS or self._is_roman(text, m.start(), token):
                continue
            letters = sum(ch.isalpha() for ch in token)
            if letters <= 3 or any(ch.isdigit() for ch in token):
                spans.append((m.start(), m.end(), spell(token)))
        if not spans:
            return text
        spans.sort()
        out, pos = [], 0
        for a, b, rep in spans:
            out.append(text[pos:a])
            out.append(rep)
            pos = b
        out.append(text[pos:])
        return "".join(out)

    @staticmethod
    def _is_roman(text: str, start: int, token: str) -> bool:
        """« Louis XIV », « chapitre III » : chiffres romains, pas des sigles."""
        if not _ROMAIN.match(token):
            return False
        before = text[:start].rstrip().split(" ")[-1:] or [""]
        prev = before[0]
        return bool(prev) and (prev[:1].isupper() or prev.lower() in {
            "chapitre", "tome", "partie", "acte", "saison", "épisode", "siècle"})
