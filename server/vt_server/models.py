"""Catalogue des modèles et téléchargement vérifié.

Chaque modèle est épinglé sur une révision précise du dépôt Hugging Face
et les fichiers de poids sont vérifiés par empreinte SHA-256. Les
téléchargements se font en HTTPS simple (urllib), avec reprise.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger("vt.models")

HF_BASE = "https://huggingface.co"


@dataclass(frozen=True)
class ModelFile:
    remote: str  # chemin dans le dépôt
    size: int  # octets
    sha256: Optional[str] = None  # None pour les petits fichiers texte
    local: Optional[str] = None  # nom local (défaut : nom du fichier distant)

    @property
    def local_name(self) -> str:
        return self.local or self.remote.rsplit("/", 1)[-1]


@dataclass(frozen=True)
class ModelSpec:
    key: str
    kind: str  # "asr" | "mt" | "tts"
    label: str
    repo: str
    revision: str
    files: tuple
    license: str
    source_note: str
    local_dir: str

    @property
    def total_size(self) -> int:
        return sum(f.size for f in self.files)


def _whisper(key, repo, rev, cfg_size, bin_size, sha, tok=2128466, voc=422309, label=""):
    return ModelSpec(
        key=f"asr:{key}",
        kind="asr",
        label=label or f"Whisper {key} (reconnaissance vocale)",
        repo=repo,
        revision=rev,
        files=(
            ModelFile("config.json", cfg_size),
            ModelFile("model.bin", bin_size, sha),
            ModelFile("tokenizer.json", tok),
            ModelFile("vocabulary.txt", voc),
        ),
        license="MIT (modèle OpenAI Whisper, conversion CTranslate2 par Systran)",
        source_note="https://huggingface.co/" + repo,
        local_dir=f"asr/{key}",
    )


CATALOG: dict = {}


def _add(spec: ModelSpec) -> None:
    CATALOG[spec.key] = spec


_add(_whisper("tiny.en", "Systran/faster-whisper-tiny.en", "0d3d19a32d3338f10357c0889762bd8d64bbdeba",
              2317, 75537502, "1a5afae06a4db91c975c9a9d78be5cc110ee4ea022ad57d55492e4550e936b2a"))
_add(_whisper("base.en", "Systran/faster-whisper-base.en", "3d3d5dee26484f91867d81cb899cfcf72b96be6c",
              2227, 145216508, "2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef"))
_add(_whisper("small.en", "Systran/faster-whisper-small.en", "d1d751a5f8271d482d14ca55d9e2deeebbae577f",
              2657, 483545366, "62b2a45b05ee59acb4a5341b33ee35e041395d378d418a18acfe4c9e768ee37a"))
_add(_whisper("medium.en", "Systran/faster-whisper-medium.en", "a29b04bd15381511a9af671baec01072039215e3",
              2643, 1527904330, "11b220779aea4c6f3ce9d2549c8a95ea869ed84066864b999531ef53e594fe5b"))
# Modèle multilingue : utilisé uniquement par les tests (vérification de la
# voix française par re-transcription). Non requis pour l'usage normal.
_add(_whisper("small", "Systran/faster-whisper-small", "536b0662742c02347bc0e980a01041f333bce120",
              2370, 483546902, "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
              tok=2203239, voc=459861, label="Whisper small multilingue (tests uniquement)"))

_add(ModelSpec(
    key="mt:opus-mt-en-fr",
    kind="mt",
    label="OPUS-MT anglais→français (traduction)",
    repo="michaelfeil/ct2fast-opus-mt-en-fr",
    revision="55bcef18761227161433d86b81bbbcd9d813b429",
    files=(
        ModelFile("config.json", 159),
        ModelFile("model.bin", 149872839, "636d926880a6e6e4b773403a5991b50d4dfdfabe49a230e148676a05e99f2bec"),
        ModelFile("shared_vocabulary.txt", 556777),
        ModelFile("source.spm", 778395),
        ModelFile("target.spm", 802397),
    ),
    license="Apache-2.0 (Helsinki-NLP/opus-mt-en-fr ; conversion CTranslate2 communautaire)",
    source_note="https://huggingface.co/Helsinki-NLP/opus-mt-en-fr",
    local_dir="mt/opus-mt-en-fr",
))
_add(ModelSpec(
    key="mt:opus-mt-tc-big-en-fr",
    kind="mt",
    label="OPUS-MT « tc-big » anglais→français (traduction, qualité)",
    repo="craftwise/ct2-opus-mt-tc-big-en-fr-int8",
    revision="5a4bdbbc160d8e18c10e69109e990817f1177e33",
    files=(
        ModelFile("config.json", 223),
        ModelFile("model.bin", 233813642, "e8f65078dc16af2996ff74cbc4c9b8885c4c4bd0f92d727d9f7bdf4ac32871a8"),
        ModelFile("shared_vocabulary.json", 971990),
        ModelFile("source.spm", 802408),
        ModelFile("target.spm", 819955),
    ),
    license="CC-BY-4.0 (Helsinki-NLP/opus-mt-tc-big-en-fr ; conversion CTranslate2 communautaire)",
    source_note="https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-fr",
    local_dir="mt/opus-mt-tc-big-en-fr",
))

_PIPER_REV = "2f358b6a560e3a913ebf509b2f3344f20b367f94"
_add(ModelSpec(
    key="tts:siwis",
    kind="tts",
    label="Voix Piper fr_FR « siwis » (féminine)",
    repo="rhasspy/piper-voices",
    revision=_PIPER_REV,
    files=(
        ModelFile("fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx", 63221984,
                  "b1d946fd68d0347155fa59bce0a018924abbef3c1561181db45ca463d83963ef"),
        ModelFile("fr/fr_FR/siwis/medium/fr_FR-siwis-medium.onnx.json", 5458),
        ModelFile("fr/fr_FR/siwis/medium/MODEL_CARD", 502),
    ),
    license="Voix : jeu de données SIWIS, CC-BY-4.0 (attribution requise)",
    source_note="https://huggingface.co/rhasspy/piper-voices",
    local_dir="tts/fr_FR-siwis-medium",
))
_add(ModelSpec(
    key="tts:upmc",
    kind="tts",
    label="Voix Piper fr_FR « upmc » (Jessica, féminine / Pierre, masculine)",
    repo="rhasspy/piper-voices",
    revision=_PIPER_REV,
    files=(
        ModelFile("fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx", 76733615,
                  "9abb3800c199148897a9ed64e100d224f3de83579f100044174ad19418f1786f"),
        ModelFile("fr/fr_FR/upmc/medium/fr_FR-upmc-medium.onnx.json", 4996),
        ModelFile("fr/fr_FR/upmc/medium/MODEL_CARD", 316),
    ),
    license="Voix : jeu de données UPMC (MaryTTS), CC-BY-SA-4.0",
    source_note="https://huggingface.co/rhasspy/piper-voices",
    local_dir="tts/fr_FR-upmc-medium",
))


# Modèles de langage pour les résumés (facultatifs, téléchargés à la demande).
_add(ModelSpec(
    key="llm:llama3.2-3b",
    kind="llm",
    label="Llama 3.2 3B Instruct (résumés, standard)",
    repo="jncraton/Llama-3.2-3B-Instruct-ct2-int8",
    revision="5da4ba8ba6252bbb33476404e9b8450ffc8e762d",
    files=(
        ModelFile("config.json", 241),
        ModelFile("generation_config.json", 189),
        ModelFile("model.bin", 3216566523, "9125c9540ee5bc6507be7182c24edadf73f560ff2803cfee977342846996cb8e"),
        ModelFile("special_tokens_map.json", 296),
        ModelFile("tokenizer.json", 9085657),
        ModelFile("tokenizer_config.json", 54528),
        ModelFile("vocabulary.json", 2783517),
    ),
    license="Llama 3.2 Community License (usage personnel et professionnel autorisé ; « Built with Llama »)",
    source_note="https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct",
    local_dir="llm/llama3.2-3b",
))
_add(ModelSpec(
    key="llm:qwen3-1.7b",
    kind="llm",
    label="Qwen3 1.7B (résumés, léger, moins fiable)",
    repo="jncraton/Qwen3-1.7B-ct2-int8",
    revision="4d92852b8d2733fe891aabec779e1d9c8a2f419c",
    files=(
        ModelFile("config.json", 147),
        ModelFile("generation_config.json", 239),
        ModelFile("model.bin", 1723631567, "d29d3e99d421082bd6b699394b39b654918000b69f499fdcb1c1492255e38bbd"),
        ModelFile("tokenizer.json", 11422654, "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4"),
        ModelFile("tokenizer_config.json", 9732),
        ModelFile("vocab.json", 2776833),
        ModelFile("vocabulary.json", 3861154),
    ),
    license="Apache-2.0",
    source_note="https://huggingface.co/Qwen/Qwen3-1.7B",
    local_dir="llm/qwen3-1.7b",
))


ProgressCb = Callable[[str, int, int], None]  # (clé, octets reçus, octets attendus)


class DownloadError(RuntimeError):
    pass


def model_dir(models_dir: str | os.PathLike, spec: ModelSpec) -> Path:
    return Path(models_dir) / spec.local_dir


def is_installed(models_dir: str | os.PathLike, spec: ModelSpec) -> bool:
    d = model_dir(models_dir, spec)
    for f in spec.files:
        p = d / f.local_name
        if not p.is_file() or p.stat().st_size != f.size:
            return False
    return True


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _download_file(url: str, dest: Path, expected_size: int, on_bytes: Callable[[int], None]) -> None:
    tmp = dest.with_name(dest.name + ".part")
    have = tmp.stat().st_size if tmp.exists() else 0
    if have > expected_size:
        tmp.unlink()
        have = 0
    attempts = 0
    while have < expected_size:
        attempts += 1
        req = urllib.request.Request(url, headers={"User-Agent": "voice-translator-local/0.1"})
        if have:
            req.add_header("Range", f"bytes={have}-")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                if have and resp.status != 206:
                    have = 0  # le serveur ignore la reprise : on recommence
                mode = "ab" if have else "wb"
                on_bytes(have)
                with open(tmp, mode) as out:
                    while True:
                        block = resp.read(1 << 18)
                        if not block:
                            break
                        out.write(block)
                        have += len(block)
                        on_bytes(have)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            if attempts >= 5:
                raise DownloadError(
                    f"Téléchargement impossible : {url}\n  -> {exc}\n"
                    "Vérifiez la connexion Internet (ou le proxy) puis relancez."
                ) from exc
            wait = 2 ** attempts
            log.warning("Téléchargement interrompu (%s), nouvelle tentative dans %ss", exc, wait)
            time.sleep(wait)
            have = tmp.stat().st_size if tmp.exists() else 0
    if have != expected_size:
        tmp.unlink(missing_ok=True)
        raise DownloadError(f"Taille inattendue pour {dest.name} : {have} au lieu de {expected_size}.")
    os.replace(tmp, dest)


def ensure_model(models_dir: str | os.PathLike, key: str, progress: ProgressCb | None = None) -> Path:
    """Télécharge le modèle s'il est absent, puis vérifie son intégrité."""
    spec = CATALOG.get(key)
    if spec is None:
        raise KeyError(f"Modèle inconnu : {key}")
    d = model_dir(models_dir, spec)
    if is_installed(models_dir, spec):
        return d
    d.mkdir(parents=True, exist_ok=True)
    total = spec.total_size
    done_before = 0
    for f in spec.files:
        dest = d / f.local_name
        if dest.is_file() and dest.stat().st_size == f.size:
            done_before += f.size
            continue
        url = f"{HF_BASE}/{spec.repo}/resolve/{spec.revision}/{f.remote}"
        base = done_before

        def on_bytes(n, base=base):
            if progress:
                progress(key, base + n, total)

        log.info("Téléchargement de %s (%.1f Mo)", f.local_name, f.size / 1e6)
        _download_file(url, dest, f.size, on_bytes)
        if f.sha256:
            digest = _sha256(dest)
            if digest != f.sha256:
                dest.unlink(missing_ok=True)
                raise DownloadError(
                    f"Empreinte SHA-256 incorrecte pour {f.local_name} ({spec.repo}). "
                    "Le fichier a été supprimé ; relancez le téléchargement."
                )
        done_before += f.size
    if progress:
        progress(key, total, total)
    return d


def remove_model(models_dir: str | os.PathLike, key: str) -> None:
    spec = CATALOG[key]
    shutil.rmtree(model_dir(models_dir, spec), ignore_errors=True)


def required_keys(asr_model: str, mt_model: str, voices: list) -> list:
    keys = [f"asr:{asr_model}", f"mt:{mt_model}"]
    keys += [f"tts:{v}" for v in voices]
    for k in keys:
        if k not in CATALOG:
            raise KeyError(f"Modèle inconnu : {k}")
    return keys


def human_size(n: int) -> str:
    if n >= 1e9:
        return f"{n / 1e9:.2f} Go"
    return f"{n / 1e6:.0f} Mo"
