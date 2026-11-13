"""Serveur local de doublage vocal (anglais -> français).

Tout le traitement (détection de parole, transcription, traduction,
synthèse vocale) est effectué sur cette machine. Le serveur n'écoute que
sur l'interface loopback et n'accepte que l'extension autorisée.
"""

__version__ = "0.1.0"
PROTOCOL_VERSION = 1
