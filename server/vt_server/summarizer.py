"""Résumés d'une vidéo avec un petit modèle de langage local (CTranslate2).

Le résumé se fait APRÈS coup, à la demande, à partir de la transcription
anglaise réellement enregistrée (plus fiable que sa traduction automatique),
et il est rédigé en français.

Une vidéo longue est découpée en chapitres d'environ 1 300 mots (≈ 10 min de
parole) : chacun est résumé séparément, puis le résumé global est construit à
partir des chapitres. Cela borne la mémoire et donne gratuitement le
« résumé par chapitre ».

Garde-fous contre l'invention : consigne stricte de fidélité, rappel qu'une
transcription ne contient que ce qui est dit (pas les images), réponse
amorcée en français. L'extension relie ensuite chaque point au passage qui
le justifie et signale ceux qu'elle ne retrouve pas.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from . import models

log = logging.getLogger("vt.resume")

LLM_MODELS = {
    # identifiant : (clé du catalogue, format du dialogue)
    "llama3.2-3b": ("llm:llama3.2-3b", "llama3"),
    "qwen3-1.7b": ("llm:qwen3-1.7b", "qwen3"),
}
DEFAULT_LLM = "llama3.2-3b"
CHUNK_WORDS = 1300
IDLE_UNLOAD_S = 120  # libérer la mémoire après 2 min sans résumé

SYSTEM = (
    "Tu es un assistant qui résume fidèlement la transcription d'une vidéo. Tu écris toujours en français. "
    "Tu n'utilises QUE les informations présentes dans la transcription : aucun fait, aucun nom, aucune "
    "scène inventés ; si une information manque, tu ne la supposes pas. Une transcription ne contient que "
    "ce qui est dit : ne décris jamais des actions visuelles qui n'y sont pas. Garde les noms propres, "
    "les noms de produits et les sigles exactement comme dans la transcription."
)

GENRE = {
    "formation": "une formation ou un cours",
    "documentaire": "un documentaire",
    "film": "un film, une série ou un récit",
    "conversation": "une conversation, une interview ou un podcast",
    "auto": "une vidéo",
}
POINTS_LABEL = {
    "formation": "les concepts et points à retenir",
    "documentaire": "les faits et événements importants",
    "film": "les événements importants de l'histoire",
    "conversation": "les idées et informations importantes",
    "auto": "les points importants",
}


class Cancelled(Exception):
    pass


@dataclass
class Chapter:
    start: float
    end: float
    title: str
    summary: str
    points: list = field(default_factory=list)


def chunk_segments(segments: list, max_words: int = CHUNK_WORDS) -> list:
    """Découpe la transcription en chapitres d'au plus `max_words` mots, de
    tailles équilibrées (pas de dernier chapitre minuscule)."""
    total = sum(len(str(s.get("en", "")).split()) for s in segments)
    n_chunks = max(1, -(-total // max_words))
    target = total / n_chunks
    chunks, cur, words = [], [], 0
    for s in segments:
        n = len(str(s.get("en", "")).split())
        if cur and words + n > target * 1.08 and len(chunks) < n_chunks - 1:
            chunks.append(cur)
            cur, words = [], 0
        cur.append(s)
        words += n
    if cur:
        chunks.append(cur)
    return chunks


def _clean_item(line: str) -> str:
    """Retire puces, numéros et préfixes répétés (« Point 2 : », « Réponse : »)."""
    item = re.sub(r"^([-•*]|\d+[.)])\s*", "", line.strip())
    item = re.sub(r"^(point|élément|réponse)\s*\d*\s*:\s*", "", item, flags=re.IGNORECASE)
    return item.strip(" *")


def parse_sections(text: str) -> dict:
    """Lit une réponse au format « TITRE : … / RÉSUMÉ : … / POINTS : - … »."""
    out = {"titre": "", "resume": "", "points": []}
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = re.match(r"^[#*\s]*(titre|résumé|resume|points?|événements?|evenements?|concepts?|faits?|idées?)"
                     r"\b[^:\n]{0,50}:\s*(.*)$", line, re.IGNORECASE)
        if m:
            key = m.group(1).lower()
            current = "titre" if key == "titre" else "resume" if key.startswith("r") else "points"
            rest = m.group(2).strip(" *#")
            if rest:
                if current == "points":
                    out["points"].append(rest.lstrip("-•* ").strip())
                else:
                    out[current] = (out[current] + " " + rest).strip()
            continue
        if current == "points" or re.match(r"^([-•*]|\d+[.)])\s+", line):
            item = _clean_item(line)
            if item:
                out["points"].append(item)
            current = "points"
        elif current in ("titre", "resume"):
            out[current] = (out[current] + " " + line).strip()
    out["titre"] = out["titre"].strip(" *#\"«»")
    return out


class Summarizer:
    def __init__(self, models_dir: str, threads: int = 4):
        self.models_dir = models_dir
        self.threads = threads
        self._lock = threading.Lock()  # un seul résumé à la fois
        self._gen = None
        self._tok = None
        self._loaded: Optional[str] = None
        self._last_used = 0.0
        self._cancel = threading.Event()
        threading.Thread(target=self._idle_unloader, name="vt-resume-memoire", daemon=True).start()

    # ------------------------------------------------------------ modèles
    def status(self) -> list:
        out = []
        for mid, (key, _fmt) in LLM_MODELS.items():
            spec = models.CATALOG[key]
            out.append({"id": mid, "label": spec.label, "size": spec.total_size, "license": spec.license,
                        "installed": models.is_installed(self.models_dir, spec), "default": mid == DEFAULT_LLM})
        return out

    def download(self, model_id: str, progress: Callable[[int, int], None]) -> None:
        key = LLM_MODELS[model_id][0]
        models.ensure_model(self.models_dir, key, lambda _k, d, t: progress(d, t))

    def _ensure_loaded(self, model_id: str) -> None:
        if self._loaded == model_id and self._gen is not None:
            return
        import ctranslate2
        from tokenizers import Tokenizer

        key = LLM_MODELS[model_id][0]
        spec = models.CATALOG[key]
        if not models.is_installed(self.models_dir, spec):
            raise FileNotFoundError(f"Le modèle de résumé « {model_id} » n'est pas installé.")
        d = Path(models.model_dir(self.models_dir, spec))
        self._gen = None  # libère l'ancien avant de charger le nouveau
        self._gen = ctranslate2.Generator(str(d), device="cpu", compute_type="int8", intra_threads=self.threads)
        self._tok = Tokenizer.from_file(str(d / "tokenizer.json"))
        self._loaded = model_id
        log.info("Modèle de résumé chargé : %s", model_id)

    def _idle_unloader(self) -> None:
        while True:
            time.sleep(15)
            if self._gen is not None and time.monotonic() - self._last_used > IDLE_UNLOAD_S \
                    and self._lock.acquire(blocking=False):
                try:
                    self._gen = None
                    self._tok = None
                    self._loaded = None
                    log.info("Modèle de résumé déchargé (inactif)")
                finally:
                    self._lock.release()

    # ------------------------------------------------------------ génération
    def _prompt(self, model_id: str, user: str, prefix: str):
        fmt = LLM_MODELS[model_id][1]
        if fmt == "llama3":
            return (f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{SYSTEM}<|eot_id|>"
                    f"<|start_header_id|>user<|end_header_id|>\n\n{user}<|eot_id|>"
                    f"<|start_header_id|>assistant<|end_header_id|>\n\n{prefix}"), "<|eot_id|>"
        # Qwen3 : mode « sans réflexion » pour une réponse directe.
        return (f"<|im_start|>system\n{SYSTEM}<|im_end|>\n<|im_start|>user\n{user} /no_think<|im_end|>\n"
                f"<|im_start|>assistant\n<think>\n\n</think>\n\n{prefix}"), "<|im_end|>"

    def _generate(self, model_id: str, user: str, prefix: str, max_new: int) -> str:
        prompt, end = self._prompt(model_id, user, prefix)
        tokens = self._tok.encode(prompt, add_special_tokens=False).tokens
        ids = []
        for step in self._gen.generate_tokens(tokens, max_length=max_new, sampling_topk=1, end_token=end,
                                              repetition_penalty=1.1):
            if self._cancel.is_set():
                raise Cancelled()
            ids.append(step.token_id)
        self._last_used = time.monotonic()
        return prefix + self._tok.decode(ids)

    def cancel(self) -> None:
        self._cancel.set()

    def summarize(self, segments: list, mode: str = "auto", model_id: str = DEFAULT_LLM,
                  with_sheet: bool = False, progress: Callable[[float, str], None] | None = None) -> dict:
        """Résumé complet : chapitres, résumé court, points clés (+ fiche).

        `segments` : [{start, end, en, fr}] triés. Renvoie un dictionnaire
        prêt à être envoyé à l'extension."""
        mode = mode if mode in GENRE else "auto"
        progress = progress or (lambda f, m: None)
        if not self._lock.acquire(blocking=False):
            raise RuntimeError("Un résumé est déjà en cours.")
        self._cancel.clear()
        t0 = time.perf_counter()
        try:
            progress(0.0, "chargement du modèle")
            self._ensure_loaded(model_id)
            self._last_used = time.monotonic()
            chunks = chunk_segments(segments)
            steps = len(chunks) + 1 + (1 if with_sheet else 0)
            genre = GENRE[mode]
            chapters = []
            for i, ch in enumerate(chunks):
                progress(i / steps, f"chapitre {i + 1} sur {len(chunks)}")
                text = " ".join(s["en"] for s in ch)
                raw = self._generate(model_id, (
                    f"Voici la transcription d'une partie de {genre}.\n\nTranscription :\n{text}\n\n"
                    "Réponds exactement dans ce format, en français :\n"
                    "TITRE : un titre court (6 mots maximum)\n"
                    "RÉSUMÉ : 2 ou 3 phrases\n"
                    "POINTS :\n- point 1\n- point 2\n- point 3"), "TITRE :", 420)
                sec = parse_sections(raw)
                chapters.append(Chapter(ch[0]["start"], ch[-1]["end"], sec["titre"] or f"Partie {i + 1}",
                                        sec["resume"], sec["points"][:5]))
            # Résumé global : directement sur la transcription si elle est courte,
            # sinon à partir des résumés de chapitres.
            progress(len(chunks) / steps, "résumé global")
            if len(chunks) == 1:
                source = "Transcription :\n" + " ".join(s["en"] for s in chunks[0])
            else:
                source = "Résumés des parties successives :\n" + "\n".join(
                    f"{i + 1}. {c.title} — {c.summary}" for i, c in enumerate(chapters))
            raw = self._generate(model_id, (
                f"Il s'agit de {genre}.\n\n{source}\n\n"
                "Réponds exactement dans ce format, en français :\n"
                "RÉSUMÉ : 3 phrases maximum\n"
                f"POINTS : {POINTS_LABEL[mode]}, 5 à 7 éléments\n- …\n- …"), "RÉSUMÉ :", 500)
            glob = parse_sections(raw)
            result = {
                "model": model_id, "mode": mode,
                "court": glob["resume"], "points": glob["points"][:8],
                "chapitres": [c.__dict__ for c in chapters],
                "fiche": None,
            }
            if with_sheet:
                progress((len(chunks) + 1) / steps, "fiche de révision")
                result["fiche"] = self._sheet(model_id, chunks, chapters)
            result["dureeCalcul"] = round(time.perf_counter() - t0, 1)
            progress(1.0, "terminé")
            return result
        finally:
            self._lock.release()

    def _sheet(self, model_id: str, chunks: list, chapters: list) -> dict:
        if len(chunks) == 1:
            source = "Transcription :\n" + " ".join(s["en"] for s in chunks[0])
        else:
            source = "Résumés des parties :\n" + "\n".join(f"- {c.title} : {c.summary} " + " ".join(c.points)
                                                           for c in chapters)
        raw = self._generate(model_id, (
            f"{source}\n\nRédige une fiche de révision en français, en n'utilisant que ce contenu, "
            "exactement dans ce format :\nDÉFINITIONS :\n- terme : définition (3 à 5)\n"
            "QUESTIONS :\n- question ? | réponse (3 à 5)"), "DÉFINITIONS :\n", 600)
        defs, questions, part = [], [], "def"
        for line in raw.splitlines():
            line = line.strip()
            if re.match(r"^\**\s*questions?\s*\**\s*:", line, re.IGNORECASE):
                part = "q"
                continue
            if re.match(r"^\**\s*d[ée]finitions?\s*\**\s*:", line, re.IGNORECASE) or not line:
                continue
            item = _clean_item(line)
            if not item:
                continue
            if part == "def" and ":" in item:
                term, _, desc = item.partition(":")
                defs.append({"terme": term.strip(" *"), "definition": desc.strip()})
            elif part == "q":
                if "|" in item:
                    q, _, a = item.partition("|")
                    questions.append({"question": q.strip(), "reponse": _clean_item(a)})
                elif re.match(r"^r[ée]ponse\s*:", item, re.IGNORECASE) and questions:
                    questions[-1]["reponse"] = item.split(":", 1)[1].strip()
                elif item.endswith("?"):
                    questions.append({"question": item, "reponse": ""})
        return {"definitions": defs[:6], "questions": questions[:6]}
