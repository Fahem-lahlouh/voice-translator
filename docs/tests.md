# Tests effectués et mesures

Ce document distingue ce qui a été **testé réellement**, ce qui est **supposé**
et ce qui reste **à vérifier**. Toutes les mesures proviennent de la machine
de développement décrite ci-dessous ; elles ne promettent rien pour votre PC.

## Configuration de test

| Élément | Valeur |
| --- | --- |
| Système | Linux (noyau 6.18), **pas Windows** |
| Processeur | Intel Xeon 2,3 GHz, **4 cœurs** (AVX-512, AMX), virtualisé |
| Mémoire | 15 Go |
| GPU | aucun |
| Navigateur | Chromium 153 (Chrome for Testing), **fenêtré** sous Xvfb |
| Python | 3.13, et 3.14 (tests unitaires + chaîne complète) |
| Versions | faster-whisper 1.2.1, ctranslate2 4.9.0, piper-tts 1.8.0, onnxruntime 1.31.1, websockets 17.4 |

## Extraits audio utilisés

Tous libres de droits, dans `test/audio/` :

| Fichier | Contenu | Origine / licence |
| --- | --- | --- |
| `tibco_demo_en.ogg` (77 s) | Faux cours TIBCO BusinessWorks, 11 phrases techniques, **sans sous-titres** | Généré pour ce projet avec la voix Piper `en_US-ljspeech` (jeu de données LJ Speech, **domaine public**) ; script : `test/tools/make_tibco_demo.py`, texte : `tibco_demo_en.txt` |
| `jfk_16k.wav` (11 s) | Discours d'investiture de J. F. Kennedy (1961) | Voix humaine réelle ; œuvre du gouvernement américain, **domaine public** ; fichier de test du dépôt `openai/whisper` |
| `canterville_90s.ogg` (90 s) | Lecture de *The Canterville Ghost* (O. Wilde) | Voix humaine réelle ; enregistrement **LibriVox, domaine public** |

Limite : l'extrait TIBCO est une **voix de synthèse**, plus facile à
reconnaître qu'un vrai formateur. Les deux autres extraits sont des voix
humaines, mais pas techniques.

## 1. Tests unitaires du serveur — 63 tests, tous réussis

```bat
scripts\lancer-tests.bat
```

ou, sous Linux : `cd server && .venv/bin/python -m unittest discover -s tests -t .`

Couvrent : découpage en phrases (abréviations, décimaux, identifiants),
glossaire (validation, alias, casse, amorce, traductions imposées,
remplacements), détection et protection des termes techniques (jetons posés,
restaurés, perte détectée), rejet des traductions dégénérées, texte
prononçable, découpage de la parole (silence, phrases, micro-silences, coupe
forcée dans un creux, segments contigus sans recouvrement), configuration
(refus d'écouter hors boucle locale, options inconnues), validation des
réglages et des messages (JSON, tailles, trames audio).

## 2. Chaîne complète hors navigateur — réussie

```
python -m vt_server --self-test ../test/audio/tibco_demo_en.ogg
```

Alimente le pipeline **en temps réel** (blocs de 100 ms au rythme de
l'horloge) avec les vrais moteurs.

Résultat sur l'extrait TIBCO, profil `prudent`, glossaire par défaut :

| Anglais reconnu | Français produit |
| --- | --- |
| Welcome back. In this lecture, we are going to create our first process in TIBCO BusinessWorks. | Bienvenue. Dans cette leçon, nous allons créer notre premier processus dans TIBCO BusinessWorks. |
| Open TIBCO Business Studio and in the Project Explorer, right-click on the package and select New, then BusinessWorks process. | Ouvrez TIBCO Business Studio et dans l'Explorateur de projet, faites un clic droit sur le paquet et sélectionnez Nouveau, puis processus BusinessWorks. |
| Give it a name, for example get customer, and click Finish. | Donnez-lui un nom, par exemple obtenir client, et cliquez sur Terminer. |
| It uses a shared resource called JDBC connection, which you configure in the module properties. | Il utilise une ressource partagée appelée connexion JDBC, que vous configurez dans les propriétés de module. |
| Finally, save the process, build the eveyor file, and deploy it to the AppNode. | Enfin, sauvegardez le processus, construisez le fichier velyor et déployez-le sur l'AppNode. |

Défauts visibles, laissés tels quels pour être honnête :
« EAR file » mal reconnu (« eveyor ») — un alias de glossaire le corrige ;
« get customer » (nom d'un processus) traduit en « obtenir client » ;
« lecture » rendu par « conférence » par le modèle, corrigé en « leçon » par le
glossaire par défaut.

**Sans glossaire**, le même extrait donnait « tickle business works » →
« travaux d'affaires chatoyants ». C'est l'effet le plus net mesuré : le
glossaire n'est pas un gadget.

### Mesures par profil (extrait TIBCO, 70 s de parole)

| Profil | Charge de calcul | Retard moyen après la fin de phrase (max) | Pic mémoire du serveur |
| --- | --- | --- | --- |
| `prudent` | 0,19 × temps réel | 1,4 s (1,7 s) | ≈ 0,74 Go |
| `equilibre` | 0,36 × temps réel | 2,4 s (2,9 s) | ≈ 1,24 Go |
| `qualite` | 0,38 × temps réel | 2,6 s (3,1 s) | ≈ 1,42 Go |

`scripts\mesurer-pc.bat` (11 s de parole, médiane de 3 mesures) :
`prudent` 0,12 ×, `equilibre` 0,25 ×, `qualite` 0,30 ×.

Sur la voix humaine (JFK, `base.en`) : transcription exacte, retard ≈ 1,0 s.

## 3. Tests de bout en bout dans un vrai Chrome — 45 vérifications, toutes réussies

```
xvfb-run -a node test/browser/scenarios.mjs
```

Chaque scénario lance le **vrai serveur**, un **vrai Chrome** avec
l'extension, et une page de test (`test/page/`) contenant une balise
`<video>` **sans sous-titres**. L'extension est invoquée par un **vrai
raccourci clavier** (`Ctrl+Maj+Y`, envoyé au niveau du système de fenêtrage),
seul moyen pour que Chrome accorde l'autorisation `activeTab` — exactement
comme pour un utilisateur. On clique ensuite sur les vrais boutons de la
fenêtre de l'extension.

Aucun moteur n'est remplacé par une simulation. Les tests se contentent
d'**observer** (état exposé par le document de traitement, et écoute de ce
qu'il envoie aux haut-parleurs).

| Scénario | Ce qui est vérifié | Résultat |
| --- | --- | --- |
| **base** | Clic réel sur « Démarrer » ; capture ; transcription ; traduction ; **voix française réellement envoyée aux haut-parleurs** (26 s enregistrées en sortie) ; **langue de cette sortie re-détectée comme du français** par un modèle Whisper multilingue indépendant (confiance 0,994) ; capture à 16 kHz ; retard mesuré **1,6 à 2,5 s** selon les exécutions | ✅ 9/9 |
| **fermeture de la popup** (dans *base*) | La fenêtre de l'extension est fermée ; de nouvelles phrases continuent d'arriver | ✅ |
| **controles** | Pause (file vidée, plus aucune phrase), reprise, **arrêt** (capture libérée selon `tabCapture.getCapturedTabs()`, document de traitement fermé, pastille effacée), **redémarrage** | ✅ 8/8 |
| **navigation** | Lecteur détecté ; **retour arrière** → travail en cours annulé et file vidée ; **changement d'extrait + d'adresse** (simule un changement de leçon) → nouvelle époque ; vitesse 1,25 × transmise | ✅ 5/5 |
| **silence** | 75 s sans son : **aucune phrase inventée** ; le document de traitement **n'est pas fermé par Chrome** ; diagnostic « aucun son » affiché ; reprise immédiate au retour du son | ✅ 5/5 |
| **boucle** | Vidéo muette, la voix française est jouée six fois de suite : **rien n'est transcrit** | ✅ 1/1 |
| **serveur** | Démarrage sans serveur : message clair, capture maintenue ; serveur lancé ensuite : **reconnexion automatique** puis traduction | ✅ 4/4 |
| **routage** | Voix originale à **0 %** : la transcription continue normalement | ✅ 2/2 |
| **surcharge** | Serveur bridé (profil lourd, 1 cœur) et vidéo à 3 × : files **bornées** (max 4,8 s côté serveur, 11,3 s côté voix), passages sautés plutôt qu'accumulés, avertissement affiché, traduction continue | ✅ 4/4 |
| **pauseauto** | Option « pause pour rattraper » : la vidéo est **mise en pause** puis **relancée** automatiquement | ✅ 3/3 |
| **options** | Test de connexion au serveur, glossaire par défaut, glossaire invalide refusé, glossaire personnalisé conservé | ✅ 4/4 |

Journal complet : `test/out/run-final.log`
(non versionnés, régénérés à chaque exécution).

Mémoire du serveur pendant une vraie session Chrome (profil `prudent`) :
pic **≈ 560 Mo**.

## 3 bis. Étape 1 « latence » — mesures avant / après

Outil : `test/tools/mesure_latence.py` (vrais moteurs, audio injecté en temps
réel, file de lecture de l'extension simulée). « Délai » = temps entre le
**début** de la parole anglaise et le début de sa voix française.

| Scénario | Première voix | Délai médian | Délai max | Retard en fin d'extrait |
| --- | --- | --- | --- | --- |
| Formation avec pauses (prudent) | 9,0 → **3,4 s** | 8,9 → **4,7 s** | 14,9 → **9,0 s** | 6,5 → **3,6 s** |
| Narration continue (prudent) | 8,5 → **3,9 s** | 10,8 → **5,5 s** | 15,9 → **7,8 s** | 8,3 → **2,5 s** |
| Narration + musique de fond | 8,5 → **3,8 s** | 8,0 → **3,7 s** | 12,8 → **6,5 s** | 8,1 → **2,3 s** |
| Équilibré, 1 cœur | 11,6 → **6,0 s** | 13,2 → **9,2 s** | 18,4 → **13,7 s** | 10,5 → **8,1 s** |
| Équilibré, 1 cœur partagé (PC très lent) | 14,4 → **9,4 s** | 17,7 → **10,3 s** | 22,8 → **16,1 s** | 15,7 → **7,7 s** |

Sur le PC très lent, le serveur est passé seul de `small.en` à `base.en`
en cours d'extrait. La machine de test étant rapide, ces chiffres sont
optimistes pour un portable grand public.

Effet secondaire observé : avec des propositions courtes, un reste de 0,6 s
après une coupe forcée a été mal reconnu. Il a été rejeté (rien d'inventé),
mais quelques mots ont été perdus. C'est la raison du compromis 2,5 s / 5 s
plutôt que 2 s / 4 s (délai médian 4,6 s mesuré avec 2 s / 4 s).

## 4. Vérifications de sécurité

| Vérification | Méthode | Résultat |
| --- | --- | --- |
| Connexion WebSocket depuis une page web (`Origin: https://…`) | requête directe | **403**, refusée avant ouverture |
| Connexion depuis l'extension | tests de bout en bout | acceptée |
| Écoute sur une autre adresse que `127.0.0.1` | test unitaire | refusée par la configuration |
| En-tête CORS de `/health` | requête directe | accordé à l'extension seule |
| Permissions demandées | lecture du manifeste | pas de `tabs`, `cookies`, `<all_urls>`, `webRequest`, microphone |
| Analyse statique | ESLint (JS), pyflakes (Python) | aucune erreur |

## 5. Ce qui est supposé ou reste à vérifier

| Point | Statut |
| --- | --- |
| **Fonctionnement sur Udemy** | **À vérifier par vous** ([udemy.md](udemy.md)). Pas de compte disponible ici. |
| **Windows et les scripts `.bat`** | **À vérifier.** Écrits avec soin (fins de ligne CRLF, encodage, chemins), jamais exécutés sur Windows. Toutes les dépendances publient des roues Windows 64 bits pour Python 3.11 à 3.14 (vérifié sur PyPI). |
| Performances sur un portable grand public | **Supposées** 2 à 4 fois plus lentes que les mesures ci-dessus. Utilisez `mesurer-pc.bat`. |
| Sessions longues (une heure) | **Non testées.** Le plus long essai dure ≈ 2 min. Les files sont bornées et rien n'est conservé, mais ce n'est pas une mesure. |
| Voix d'un vrai formateur, accent, bruit | **Non testé** sur un vrai cours technique. Testé sur deux voix humaines non techniques. |
| GPU | **Non testé.** |
| Plein écran sur un vrai lecteur | **Non testé** (code écrit, non exercé). |

## Relancer les tests

| Quoi | Où | Commande |
| --- | --- | --- |
| Unitaires + chaîne complète | Windows | `scripts\lancer-tests.bat` |
| Unitaires | Linux | `cd server && .venv/bin/python -m unittest discover -s tests -t .` |
| Bout en bout dans Chrome | Linux avec Xvfb | `server/.venv/bin/pip install python-xlib` puis `xvfb-run -a node test/browser/scenarios.mjs` (ajoutez des noms de scénarios pour n'en lancer que certains) |

Les tests de bout en bout envoient un vrai raccourci clavier via l'extension
X11 XTEST : ils ne fonctionnent donc pas tels quels sous Windows. La procédure
manuelle de [udemy.md](udemy.md) en tient lieu.
