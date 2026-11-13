"""Configuration du serveur : profils matériels, réseau, limites."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent.parent
DEFAULT_MODELS_DIR = SERVER_DIR / "models"
DEFAULT_CONFIG_FILE = SERVER_DIR / "config.json"

DEFAULT_PORT = 47831

# Identifiant de l'extension, dérivé de la clé publique placée dans
# extension/manifest.json ("key"). Il est donc identique sur tous les PC
# où l'extension est chargée depuis ce dépôt.
DEFAULT_EXTENSION_ID = "hphdjdgoecdegmdanhnlgdihjclkmnjp"

SAMPLE_RATE = 16000

# Profils matériels. "prudent" est le choix par défaut tant que les
# performances du PC n'ont pas été mesurées (voir scripts/mesurer-pc).
PROFILES = {
    "prudent": {
        "asr_model": "base.en",
        "mt_model": "opus-mt-en-fr",
        "beam_size": 2,
        "description": "PC modeste (4 cœurs, 8 Go de RAM, sans GPU).",
    },
    "equilibre": {
        "asr_model": "small.en",
        "mt_model": "opus-mt-en-fr",
        "beam_size": 3,
        "description": "PC récent (6 cœurs ou plus, 16 Go de RAM).",
    },
    "qualite": {
        "asr_model": "small.en",
        "mt_model": "opus-mt-tc-big-en-fr",
        "beam_size": 5,
        "description": "PC puissant ; meilleure traduction, plus lente.",
    },
}


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    profile: str = "prudent"
    models_dir: str = str(DEFAULT_MODELS_DIR)

    # Sécurité des connexions locales.
    allowed_extension_ids: list = field(default_factory=lambda: [DEFAULT_EXTENSION_ID])
    auth_token: str = ""  # facultatif : jeton partagé avec l'extension

    # Moteurs (vides = valeurs du profil).
    asr_model: str = ""
    mt_model: str = ""
    beam_size: int = 0
    device: str = "cpu"  # "cpu", "cuda" ou "auto"
    compute_type: str = ""  # vide = int8 sur CPU, float16 sur GPU
    cpu_threads: int = 0  # 0 = automatique

    default_voice: str = "siwis"

    # Découpage de la parole (secondes).
    min_silence_s: float = 0.60
    soft_max_segment_s: float = 7.0
    hard_max_segment_s: float = 14.0
    min_speech_s: float = 0.30
    vad_threshold: float = 0.5

    # Files d'attente.
    max_asr_backlog_s: float = 25.0  # au-delà, les segments les plus anciens sont abandonnés
    fast_mode_backlog_s: float = 6.0  # au-delà, décodage rapide (beam 1)
    max_speedup: float = 1.25  # accélération maximale de la voix pour rattraper

    # Confidentialité : rien n'est écrit sur disque sauf demande explicite.
    debug_dump_dir: str = ""

    log_level: str = "INFO"

    def resolved(self) -> "Config":
        prof = PROFILES.get(self.profile)
        if prof is None:
            raise ValueError(
                f"Profil inconnu : {self.profile!r} (choix : {', '.join(PROFILES)})"
            )
        if not self.asr_model:
            self.asr_model = prof["asr_model"]
        if not self.mt_model:
            self.mt_model = prof["mt_model"]
        if not self.beam_size:
            self.beam_size = prof["beam_size"]
        if not self.cpu_threads:
            cores = os.cpu_count() or 4
            # Laisser de la marge au navigateur et à la lecture vidéo.
            self.cpu_threads = max(1, min(8, cores - 1 if cores > 2 else cores))
        if self.host not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError(
                "Le serveur n'accepte d'écouter que sur l'interface loopback "
                "(127.0.0.1). Valeur refusée : " + str(self.host)
            )
        return self

    def allowed_origins(self) -> set:
        return {f"chrome-extension://{i}" for i in self.allowed_extension_ids if i}

    def public_dict(self) -> dict:
        d = asdict(self)
        d.pop("auth_token", None)
        return d


def load_config(path: str | os.PathLike | None = None, overrides: dict | None = None) -> Config:
    cfg = Config()
    p = Path(path) if path else DEFAULT_CONFIG_FILE
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"Fichier de configuration illisible ({p}) : {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError(f"{p} doit contenir un objet JSON.")
        for k, v in data.items():
            if k.startswith("_"):
                continue
            if not hasattr(cfg, k):
                raise ValueError(f"Option inconnue dans {p} : {k}")
            setattr(cfg, k, v)
    for k, v in (overrides or {}).items():
        if v is not None:
            setattr(cfg, k, v)
    return cfg.resolved()
