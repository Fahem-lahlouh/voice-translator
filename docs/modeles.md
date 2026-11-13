# Modèles, tailles et licences

Tous les modèles sont téléchargés **une seule fois** depuis
[huggingface.co](https://huggingface.co), sur une **révision figée** (commit
précis), et chaque fichier de poids est vérifié par **empreinte SHA-256** après
téléchargement. Ils sont ensuite exécutés localement : aucune requête réseau
n'est faite pendant l'utilisation.

Dossier d'installation : `server\models\`.

## Reconnaissance vocale (anglais)

Modèles **Whisper** (OpenAI), convertis au format CTranslate2 par Systran,
exécutés en entier 8 bits (`int8`) sur le processeur.

| Clé | Taille | Licence | Source |
| --- | --- | --- | --- |
| `asr:tiny.en` | 78 Mo | MIT | [Systran/faster-whisper-tiny.en](https://huggingface.co/Systran/faster-whisper-tiny.en) |
| `asr:base.en` | 148 Mo | MIT | [Systran/faster-whisper-base.en](https://huggingface.co/Systran/faster-whisper-base.en) |
| `asr:small.en` | 486 Mo | MIT | [Systran/faster-whisper-small.en](https://huggingface.co/Systran/faster-whisper-small.en) |
| `asr:medium.en` | 1,53 Go | MIT | [Systran/faster-whisper-medium.en](https://huggingface.co/Systran/faster-whisper-medium.en) |
| `asr:small` (tests) | 486 Mo | MIT | [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small) |

`asr:small` est le modèle **multilingue** ; il n'est utilisé que par la
procédure de test automatique, pour vérifier que la voix produite est bien du
français. Il n'est pas nécessaire à l'usage normal.

## Traduction anglais → français

Modèles **OPUS-MT** (Helsinki-NLP / projet Tatoeba), convertis en CTranslate2.

| Clé | Taille | Licence du modèle d'origine | Source |
| --- | --- | --- | --- |
| `mt:opus-mt-en-fr` | 152 Mo | **Apache-2.0** | [Helsinki-NLP/opus-mt-en-fr](https://huggingface.co/Helsinki-NLP/opus-mt-en-fr) |
| `mt:opus-mt-tc-big-en-fr` | 236 Mo | **CC-BY-4.0** | [Helsinki-NLP/opus-mt-tc-big-en-fr](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-fr) |

Les fichiers réellement téléchargés sont des conversions CTranslate2
publiées par des tiers
([michaelfeil/ct2fast-opus-mt-en-fr](https://huggingface.co/michaelfeil/ct2fast-opus-mt-en-fr),
[craftwise/ct2-opus-mt-tc-big-en-fr-int8](https://huggingface.co/craftwise/ct2-opus-mt-tc-big-en-fr-int8)).
Ces dépôts de conversion ne redéclarent pas toujours la licence ; la licence
applicable reste celle du modèle d'origine indiquée ci-dessus. Pour un usage
strictement personnel, les deux conviennent. Pour une redistribution, le
modèle **Apache-2.0** (profils `prudent` et `equilibre`) est le plus simple,
le modèle CC-BY-4.0 demandant une attribution.

## Voix françaises (synthèse vocale)

Voix **Piper**, exécutées avec `onnxruntime`.

| Identifiant | Taille | Voix | Licence du jeu de données |
| --- | --- | --- | --- |
| `siwis` (défaut) | 63 Mo | féminine, France | **CC-BY-4.0** — attribution requise |
| `upmc` | 77 Mo | Jessica (féminine) et Pierre (masculine), France | **CC-BY-SA-4.0** — attribution + partage à l'identique |

Sources : [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices),
fiches `MODEL_CARD` recopiées dans chaque dossier de voix installé.

Deux autres voix françaises existent dans le dépôt Piper mais ne sont pas
proposées ici :

* `fr_FR-tom-medium` : jeu de données sous **AGPLv3**, contraignante ;
* `fr_FR-gilles-low` : qualité « low » et prononciation des nasales dégradée
  (le modèle rejette des phonèmes), constaté pendant les essais.

> **Attention à la bibliothèque, pas seulement au modèle.** `piper-tts`
> (le logiciel de synthèse) est distribué sous **GPL-3.0-or-later**. Elle est
> installée comme dépendance Python et exécutée dans le processus du serveur
> local. Pour un usage personnel, cela n'impose rien. Pour redistribuer un
> produit basé sur ce dépôt, il faut en tenir compte.

## Détection de parole

**Silero VAD v6** (fichier ONNX, licence **MIT**), fourni avec la bibliothèque
`faster-whisper` : rien à télécharger séparément.

## Taille totale par profil

| Profil | Modèles | Téléchargement | Sur disque |
| --- | --- | --- | --- |
| `prudent` | base.en + opus-mt-en-fr + siwis | ≈ 360 Mo | ≈ 360 Mo |
| `equilibre` | small.en + opus-mt-en-fr + siwis | ≈ 700 Mo | ≈ 700 Mo |
| `qualite` | small.en + opus-mt-tc-big + siwis | ≈ 790 Mo | ≈ 790 Mo |

À quoi s'ajoutent les bibliothèques Python dans `server\.venv` : **≈ 1,0 Go**
(mesuré sur la machine de test ; principalement `ctranslate2`, `onnxruntime`,
`numpy` et `av`).

**Prévoyez 2 Go d'espace libre** pour une installation confortable.

## Besoins machine

Mesures réelles sur la machine de test (4 cœurs x86-64 à 2,3 GHz, 15 Go de
RAM, **sans GPU**, Linux) — voir [tests.md](tests.md) pour le détail.

| Profil | Mémoire du serveur (pic) | Charge processeur | Verdict sur cette machine |
| --- | --- | --- | --- |
| `prudent` | ≈ 0,9 Go | ≈ 0,19 × temps réel | confortable |
| `equilibre` | ≈ 1,5 Go | ≈ 0,36 × temps réel | utilisable |
| `qualite` | ≈ 1,6 Go | non mesuré en continu | à vérifier sur votre PC |

« Charge 0,19 × temps réel » signifie que traiter 60 s de parole demande
≈ 11 s de calcul : il reste une large marge pour la lecture vidéo.

**Recommandations prudentes** (non mesurées sur d'autres machines) :

* **Minimum** : 4 cœurs, 8 Go de RAM, profil `prudent`.
* **Confortable** : 6 cœurs ou plus, 16 Go de RAM, profil `equilibre`.
* **GPU** : non requis, et **non testé**. Le serveur accepte
  `"device": "cuda"` dans `server\config.json` (CTranslate2 sait l'utiliser),
  mais cela demande d'installer une version CUDA de `ctranslate2` et n'a pas
  été vérifié ici. Ne comptez pas dessus sans l'avoir essayé.

Lancez **`scripts\mesurer-pc.bat`** pour obtenir ces chiffres **sur votre
propre PC** plutôt que de vous fier à ce tableau.

## Pourquoi ces modèles

Le raisonnement et les options écartées sont détaillés dans
[architecture.md](architecture.md).
