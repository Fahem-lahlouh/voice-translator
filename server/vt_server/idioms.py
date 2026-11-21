"""Expressions idiomatiques anglaises → équivalents français naturels.

Le modèle de traduction local (OPUS-MT) traduit les expressions mot à mot
(« It's raining cats and dogs » → « Il pleut des chats et des chiens »). Ce
lexique corrige les expressions courantes :

* si la phrase entière est l'expression (éventuellement entourée de mots
  comme « well », « guys »), la traduction est donnée directement ;
* sinon, l'expression est remplacée par un jeton que le traducteur recopie,
  puis par son équivalent français (même mécanisme que pour les termes
  techniques, cf. textproc.protect).

Limites assumées : seules les expressions listées (ou ajoutées par
l'utilisateur dans le glossaire) sont reconnues, et une expression à double
sens peut être mal interprétée. Les expressions dont le verbe se conjugue
selon le sujet ne sont listées qu'avec leurs sujets les plus courants.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


def _p(s: str) -> str:
    """Motif lisible → regex : apostrophes souples, espaces multiples."""
    s = s.replace("'", "['’]?")
    return re.sub(r" ", r"\\s+", s)


@dataclass(frozen=True)
class Idiom:
    pattern: str  # regex (minuscules)
    fr: str  # équivalent français
    full_only: bool = False  # ne s'applique qu'à une phrase entière


# (motif, français, phrase entière uniquement)
_DATA = [
    # --- phrases complètes
    ("it's raining cats and dogs", "Il pleut des cordes.", False),
    ("let's call it a day", "On s'arrête là pour aujourd'hui.", False),
    ("let's call it a night", "On s'arrête là pour ce soir.", False),
    ("he's (just )?pulling your leg", "Il te fait marcher.", True),
    ("she's (just )?pulling your leg", "Elle te fait marcher.", True),
    ("you're pulling my leg", "Tu me fais marcher.", True),
    ("(are )?you kidding( me)?", "Sans blague !", True),
    ("you('re| are) kidding( me)?", "Sans blague !", True),
    ("you('ve| have) got to be kidding( me)?", "C'est pas vrai !", True),
    ("no way", "Pas possible !", True),
    ("break a leg", "Merde !", True),
    ("break a leg tonight", "Merde pour ce soir !", True),
    ("(it's|that's) a piece of cake", "C'est du gâteau.", True),
    ("(it|that) was a piece of cake", "C'était du gâteau.", True),
    ("i'm (gonna|going to) hit the sack", "Je vais aller me coucher.", False),
    ("i'm (gonna|going to) hit the hay", "Je vais aller me coucher.", False),
    ("i'm beat", "Je suis crevé.", False),
    ("i'm (all )?ears", "Je suis tout ouïe.", True),
    ("it's not rocket science", "Ce n'est pas sorcier.", True),
    ("(that's|this is|it's) the last straw", "C'est la goutte d'eau qui fait déborder le vase.", True),
    ("(that|it) costs an arm and a leg", "Ça coûte les yeux de la tête.", True),
    ("(the )?ball is in your court", "La balle est dans ton camp.", True),
    ("(it's|that's) not my cup of tea", "Ce n'est pas mon truc.", True),
    ("beats me", "Aucune idée.", True),
    ("my bad", "Au temps pour moi.", True),
    ("no worries", "Pas de souci.", True),
    ("fair enough", "D'accord, c'est juste.", True),
    ("you bet", "Et comment !", True),
    ("i'm just messing with you", "Je te taquine.", True),
    ("what's up", "Quoi de neuf ?", True),
    ("speak of the devil", "Quand on parle du loup…", False),
    ("better late than never", "Mieux vaut tard que jamais.", False),
    ("it's a deal", "Marché conclu.", True),
    ("keep me posted", "Tiens-moi au courant.", True),
    ("let's get started", "C'est parti.", True),
    ("let's get going", "C'est parti.", True),
    ("let's do this", "Allons-y.", True),
    ("let's dive (right )?in(to it)?", "Entrons dans le vif du sujet.", True),
    ("let's get the ball rolling", "Lançons-nous.", True),
    ("let's wrap (it )?up", "Concluons.", True),
    ("that's a wrap", "C'est terminé.", True),
    ("let's hit the road", "On y va.", True),
    ("i (need to|have to|gotta|got to) hit the road", "Je dois y aller.", True),
    ("i'm on it", "Je m'en occupe.", True),
    ("hang in there", "Tiens bon.", True),
    ("(cut|knock) it out", "Arrête ça.", True),
    ("my lips are sealed", "Motus et bouche cousue.", True),
    ("you nailed it", "Tu as assuré !", True),
    ("nailed it", "Réussi !", True),
    ("(it's|that's) no big deal", "Ce n'est pas grave.", True),
    ("no big deal", "Pas grave.", True),
    ("(it's|that's) a big deal", "C'est important.", True),
    ("he kicked the bucket", "Il a cassé sa pipe.", True),
    ("she kicked the bucket", "Elle a cassé sa pipe.", True),
    ("time flies", "Le temps passe vite.", False),
    ("i'm feeling blue", "J'ai le cafard.", True),
    ("long story short", "Bref", False),
    ("to make a long story short", "Bref", False),
    ("don't spill the beans", "Ne vends pas la mèche.", True),
    ("he spilled the beans", "Il a vendu la mèche.", True),
    ("she spilled the beans", "Elle a vendu la mèche.", True),
    ("let's touch base", "Faisons un point.", True),
    ("think outside the box", "Sortez des sentiers battus.", True),
    # --- fragments invariables (insérés dans la phrase traduite)
    ("a piece of cake", "du gâteau", False),
    ("break a leg", "merde", False),
    ("an arm and a leg", "les yeux de la tête", False),
    ("once in a blue moon", "tous les trente-six du mois", False),
    ("under the weather", "patraque", False),
    ("in a nutshell", "en bref", False),
    ("the elephant in the room", "le sujet que tout le monde évite", False),
    ("a blessing in disguise", "un mal pour un bien", False),
    ("the tip of the iceberg", "la partie émergée de l'iceberg", False),
    ("a no-brainer", "une évidence", False),
    ("on the same page", "sur la même longueur d'onde", False),
    ("out of the blue", "sans prévenir", False),
    ("on thin ice", "en terrain glissant", False),
    ("back to square one", "retour à la case départ", False),
    ("at the drop of a hat", "au quart de tour", False),
    ("a long shot", "un pari risqué", False),
    ("a ballpark figure", "un ordre de grandeur", False),
    ("in the long run", "à long terme", False),
    ("on the fence", "indécis", False),
    ("over the moon", "aux anges", False),
    ("hands down", "sans conteste", False),
    ("a pain in the neck", "une plaie", False),
    ("as a rule of thumb", "en règle générale", False),
    ("up in the air", "en suspens", False),
    ("at the end of the day", "au bout du compte", False),
    ("without further ado", "sans plus attendre", False),
    ("that being said", "cela dit", False),
    ("out of the box", "prêt à l'emploi", False),
    ("the low-hanging fruit", "les gains les plus faciles", False),
    ("on the fly", "à la volée", False),
    ("just a heads up", "petite précision", False),
    ("a heads up", "un avertissement", False),
]

# Mots d'enrobage qui n'empêchent pas de reconnaître une phrase-expression,
# avec leur traduction (le traducteur les déplace mal autour d'un jeton).
_PREFIX_FR = {
    "oh": "Oh", "well": "Eh bien", "ok": "D'accord", "okay": "D'accord", "so": "Alors",
    "yeah": "Ouais", "alright": "Bon", "all right": "Bon", "wow": "Waouh", "man": "Mon vieux",
    "hey": "Hé", "and": "Et", "but": "Mais", "guys": "Les gars",
}
_SUFFIX_FR = {
    "guys": "les gars", "man": "mon vieux", "everyone": "tout le monde",
    "everybody": "tout le monde", "folks": "les amis", "dude": "mec", "buddy": "mon pote",
    "then": "alors", "now": "maintenant", "right": "d'accord", "okay": "d'accord", "ok": "d'accord",
}
_PREFIX_WORDS = "|".join(sorted(_PREFIX_FR, key=len, reverse=True))
_SUFFIX_WORDS = "|".join(sorted(_SUFFIX_FR, key=len, reverse=True))
_PREFIX = r"(?:(?:" + _PREFIX_WORDS + r")[,!]?\s+)*"
_SUFFIX = r"(?:,?\s+(?:" + _SUFFIX_WORDS + r"))*"
_END = r"[\s.!?…]*"


def _lower_first(s: str) -> str:
    """Minuscule initiale, sauf si le premier mot est un sigle (« NASA »)."""
    first = s.split(" ", 1)[0]
    if sum(c.isalpha() for c in first) >= 2 and first.isupper():
        return s
    return s[:1].lower() + s[1:]


def _norm(s: str) -> str:
    return s.replace("’", "'").strip()


class Idioms:
    def __init__(self, user: list | None = None):
        """user : [(anglais, français)] tirés du glossaire (prioritaires)."""
        items = [Idiom(_p(re.escape(en.lower()).replace(r"\ ", " ")), fr) for en, fr in (user or [])]
        items += [Idiom(_p(p), fr, full) for p, fr, full in _DATA]
        self.items = items
        self._full = [(re.compile(r"^\W*" + _PREFIX + "(" + i.pattern + ")" + _SUFFIX + _END + "$",
                                  re.IGNORECASE), i) for i in items]
        self._wrapped = [(re.compile(r"^\W*(?P<pre>" + _PREFIX + r")(?:" + i.pattern + r")(?P<suf>" + _SUFFIX
                                     + r")" + _END + "$", re.IGNORECASE), i) for i in items]
        self._exact = [(re.compile(r"^\W*" + i.pattern + _END + "$", re.IGNORECASE), i) for i in items]
        self._frag = [(re.compile(r"(?<![\w'])" + i.pattern + r"(?![\w'])", re.IGNORECASE), i)
                      for i in items if not i.full_only]
        self._embed = [(re.compile(r"(?<![\w'])" + i.pattern + r"(?![\w'])", re.IGNORECASE), i)
                       for i in items]

    def whole(self, sentence: str) -> str | None:
        """Traduction directe si la phrase EST l'expression (sans enrobage)."""
        s = _norm(sentence)
        for rx, i in self._exact:
            if rx.match(s):
                return i.fr
        return None

    def wrapped(self, sentence: str) -> str | None:
        """« Well, let's call it a day, guys. » → « Eh bien, on s'arrête là
        pour aujourd'hui, les gars. » : l'expression et ses mots d'enrobage
        sont traduits directement, sans passer par le traducteur."""
        s = _norm(sentence)
        for rx, i in self._wrapped:
            m = rx.match(s)
            if not m:
                continue
            pre = re.findall(_PREFIX_WORDS, m.group("pre") or "", re.IGNORECASE)
            suf = re.findall(_SUFFIX_WORDS, m.group("suf") or "", re.IGNORECASE)
            if not pre and not suf:
                return None  # phrase nue : traitée par whole()
            core = i.fr
            end = core[-1] if core[-1:] in ".!?…" else "."
            core = core.rstrip(".!?… ")
            parts = [_PREFIX_FR[w.lower()] for w in pre]
            if parts:
                core = _lower_first(core)
                head = ", ".join(parts) + ", " + core
            else:
                head = core
            if suf:
                head += ", " + ", ".join(_SUFFIX_FR[w.lower()] for w in suf)
            return head + (" " + end if end in "!?" else end)
        return None

    def spans(self, sentence: str) -> list:
        """Occurrences à remplacer par un jeton : [(début, fin, français)].

        Une expression « phrase entière » entourée de mots d'enrobage
        (« Well, let's call it a day, guys. ») est aussi remplacée, sans sa
        ponctuation finale, pour que le reste soit traduit normalement."""
        s = sentence.replace("’", "'")
        out = []
        whole_wrapped = any(rx.match(_norm(sentence)) for rx, _i in self._full)
        table = self._embed if whole_wrapped else self._frag
        for rx, i in table:
            for m in rx.finditer(s):
                if any(m.start() < b and a < m.end() for a, b, _ in out):
                    continue
                fr = i.fr.rstrip(".!?… ")
                fr = _lower_first(fr)
                out.append((m.start(), m.end(), fr))
        return sorted(out)
