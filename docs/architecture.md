# Architecture et choix techniques

## 1. Contraintes de départ

1. Fonctionner **sans sous-titres** : la source est le **son de l'onglet**.
2. **Aucun abonnement, aucune clé d'API** : traitement local uniquement.
3. Ne pas dépendre d'une API non documentée ni d'un détournement de service.
4. Tourner sur un PC Windows ordinaire, **sans GPU**.
5. Baisser la voix originale **sans** couper le signal envoyé à la traduction.

## 2. Options comparées

### 2.1 Capture du son d'un onglet Chrome

| Option | Verdict |
| --- | --- |
| **`chrome.tabCapture.getMediaStreamId` + document offscreen** | **Retenu.** Seule voie documentée pour capter le son d'un onglet précis depuis une extension Manifest V3. |
| `getDisplayMedia` (partage d'écran) | Écarté : impose une boîte de dialogue de partage à chaque démarrage et expose la vidéo. |
| Lecture des sous-titres dans la page | Écarté comme base : beaucoup de vidéos n'en ont pas, et c'est exactement la dépendance que l'on veut éviter. Reste possible comme optimisation ultérieure. |
| Périphérique audio virtuel (VB-Cable…) | Écarté : installation d'un pilote, configuration système, hors du navigateur. |

**Points vérifiés dans la définition officielle de l'API Chromium**
(`chrome/common/extensions/api/tab_capture.idl`) :

* `getMediaStreamId({ targetTabId })` renvoie un identifiant **à usage
  unique**, qui « expire après quelques secondes s'il n'est pas utilisé » :
  l'extension le transmet donc immédiatement au document offscreen.
* « Capture can only be started on the currently active tab **after the
  extension has been invoked**, similar to the way that `activeTab` works. »
  → Le doublage ne peut donc démarrer qu'après un geste explicite de
  l'utilisateur (clic sur l'icône ou `Ctrl+Maj+Y`). C'est voulu.
* « Only tabs for which the extension has been granted the `activeTab`
  permission can be used as the target tab. »
* La capture **survit aux navigations** dans l'onglet et s'arrête à la
  fermeture de l'onglet ou du flux.
* Les contraintes à passer à `getUserMedia` sont
  `{ mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }`.
* Depuis **Chrome 116**, `tabCapture` est utilisable depuis le service worker
  et l'identifiant de flux peut être consommé dans un **document offscreen**
  (d'où `"minimum_chrome_version": "116"` dans le manifeste).
* **Capter un onglet coupe son son pour l'utilisateur.** La documentation
  indique de le rejouer via un `AudioContext` et `createMediaStreamSource`.
  C'est précisément ce qui permet de régler séparément le volume de la voix
  originale (voir §4).

Les valeurs acceptées par `offscreen.createDocument` ont été relevées dans
`extensions/common/api/offscreen.webidl` : `USER_MEDIA` et `AUDIO_PLAYBACK`
sont les deux motifs déclarés ici.

### 2.2 Reconnaissance vocale locale

| Option | Verdict |
| --- | --- |
| **`faster-whisper` (Whisper + CTranslate2), serveur local** | **Retenu.** Rapide sur processeur en `int8`, modèles anglais dédiés (`*.en`), licence MIT, maintenu (1.2.1, 2026). |
| `whisper.cpp` | Comparable en qualité. Écarté : il faut compiler ou distribuer un binaire par plateforme, alors que `faster-whisper` s'installe par `pip` avec des roues Windows prêtes à l'emploi. |
| Whisper dans le navigateur (`transformers.js` / WebGPU) | Séduisant (plus de serveur), mais : qualité limitée aux petits modèles, WebGPU inégal sur les PC sans GPU dédié, et un navigateur occupé à lire une vidéo. Écarté pour le MVP, noté comme piste. |
| `Web Speech API` de Chrome | Écarté : s'appuie sur un service en ligne non documenté pour cet usage, et ne reconnaît que le microphone, pas un flux audio arbitraire. |
| Vosk / Kaldi | Écarté : qualité nettement inférieure à Whisper sur de la parole technique spontanée. |

### 2.3 Traduction anglais → français

| Option | Verdict |
| --- | --- |
| **OPUS-MT (Helsinki-NLP) sous CTranslate2** | **Retenu.** 150–240 Mo, ≈ 0,4–0,7 s par phrase sur 4 cœurs, qualité suffisante pour comprendre un cours. |
| NLLB-200 (600 M) | Écarté : 2,5 Go et nettement plus lent, pour un gain faible sur une seule paire de langues. |
| Un grand modèle de langue local (Llama, Mistral…) | Meilleure traduction en théorie, mais plusieurs giga-octets et un temps de réponse incompatible avec le temps réel sur un PC sans GPU. |
| Whisper en mode « translate » | Écarté : Whisper ne traduit que **vers l'anglais**. |
| API en ligne (DeepL, Google) | Écarté : clé d'API et quotas. |

**Essai comparatif mené ici** sur des phrases de formation TIBCO : le modèle
`tc-big` rend des tournures un peu plus naturelles (« fondamentalement, ce qui
se passe… ») mais dégrade les chemins Windows (`C:\tibco\...` devient
`C: ⁇ tibco ⁇ ...`, le caractère `\` étant hors de son vocabulaire), là où le
modèle de base les recopie correctement. D'où le choix du modèle de base par
défaut, le `tc-big` restant disponible via le profil `qualite` (la protection
par jetons, §5, corrige ce défaut dans les deux cas).

### 2.4 Synthèse vocale française

| Option | Verdict |
| --- | --- |
| **Piper (ONNX)** | **Retenu.** 63 Mo, ≈ 0,03 × temps réel (30 fois plus rapide que la parole), voix françaises correctes, exécution par `onnxruntime`. |
| `speechSynthesis` du navigateur (voix Windows) | Tentant (zéro téléchargement), mais : voix françaises absentes sur certaines installations, pas de contrôle fin du débit par phrase, et impossible d'acheminer le résultat dans le graphe audio pour en régler le volume indépendamment. Conservé comme **piste de repli**, pas comme base. |
| Coqui TTS / XTTS | Écarté : plusieurs giga-octets, trop lent sans GPU, licence restrictive pour XTTS. |
| eSpeak-NG | Écarté : voix trop robotique pour écouter une heure de formation. |

**Essai comparatif des voix françaises** (phrase technique de 5,4 s) :

| Voix | Qualité | Temps de synthèse | Remarque |
| --- | --- | --- | --- |
| `siwis` (medium) | bonne | 0,17 s | **retenue par défaut** (CC-BY-4.0) |
| `upmc` (medium) | bonne, 2 locuteurs | 0,12 s | proposée (CC-BY-SA-4.0) |
| `tom` (medium) | bonne | 0,28 s | écartée : jeu de données AGPLv3 |
| `gilles` (low) | médiocre | 0,12 s | écartée : phonèmes nasaux manquants (`Missing phoneme from id map: ̃`) |

### 2.5 Pourquoi un serveur local plutôt que tout dans le navigateur

Un document offscreen pourrait exécuter Whisper via WebAssembly, mais :

* la mémoire d'une extension est bien plus contrainte que celle d'un
  processus Python ;
* le navigateur lit déjà une vidéo : lui ajouter la transcription dégrade les
  deux ;
* `ctranslate2` exploite AVX-512 / VNNI et plusieurs cœurs, ce que le
  WebAssembly d'un navigateur n'atteint pas.

Le serveur local est donc assumé — avec l'exigence qu'il soit **sûr** (§6) et
**facile à lancer** (un fichier `.bat`).

## 3. Vue d'ensemble

```
   ┌──────────────── Chrome ─────────────────┐        ┌─── Serveur local ───┐
   │                                         │        │   127.0.0.1 : 47831 │
   │  onglet vidéo                           │        │                     │
   │     │ son de l'onglet (tabCapture)      │        │  détection de       │
   │     ▼                                   │        │  parole (Silero)    │
   │  document offscreen                     │        │        │            │
   │     ├─ 16 kHz mono ──── WebSocket ──────┼───────►│        ▼            │
   │     │                   (PCM 16 bits)   │        │  Whisper (anglais)  │
   │     │                                   │        │        │            │
   │     ├─ gain « original » ─► haut-parleur│        │        ▼            │
   │     │                                   │        │  OPUS-MT (français) │
   │     └─ gain « français » ─► haut-parleur│        │        │            │
   │            ▲                            │        │        ▼            │
   │            └──── WebSocket ◄────────────┼────────│  Piper (voix)       │
   │                  (voix PCM)             │        └─────────────────────┘
   │                                         │
   │  popup (commandes)   service worker     │
   │  script de page (sous-titres, lecteur)  │
   └─────────────────────────────────────────┘
```

Rôles :

| Composant | Fichier | Rôle |
| --- | --- | --- |
| Service worker | `extension/background.js` | Obtient l'identifiant de capture, crée/ferme le document offscreen, relaie les messages. Peut être mis en veille par Chrome sans rien interrompre. |
| Document offscreen | `extension/offscreen.js` | **Tout le traitement audio.** Capture, routage, liaison au serveur, lecture de la voix. Vit indépendamment de la popup. |
| Worklet audio | `extension/capture-worklet.js` | Conversion en PCM 16 bits mono 16 kHz par blocs de 100 ms, dans le fil audio. |
| Popup | `extension/popup.js` | Commandes et réglages. **Aucun traitement** : la fermer n'arrête rien. |
| Script de page | `extension/content/adapter.js` | Événements du lecteur (lecture, pause, saut, vitesse, leçon) et affichage des sous-titres. Injecté seulement après « Démarrer ». |
| Serveur | `server/vt_server/` | Découpage, transcription, traduction, synthèse. |

## 4. Routage audio : baisser l'original sans couper la traduction

Le flux capté est branché sur **deux chaînes distinctes** :

```
flux capté ─┬─► AudioContext 16 kHz ─► worklet ─► serveur   (jamais atténué)
            └─► AudioContext sortie ─► gain « original » ─► haut-parleurs
```

Le curseur « volume de la voix originale » agit **uniquement** sur la seconde
chaîne. Le signal envoyé à la reconnaissance est pris **avant** ce gain : le
mettre à zéro ne change rien à la qualité de traduction. C'est vérifié par le
test automatique `routage`.

Quand la voix française parle, l'original est encore atténué (option
« baisser encore l'original ») par un simple facteur appliqué au même gain.

## 5. Pipeline audio

1. **Détection de parole** — Silero VAD, trames de 32 ms. Un segment démarre
   sur 2 trames de parole consécutives, avec 250 ms de pré-enregistrement pour
   ne pas tronquer l'attaque du premier mot.
2. **Découpage par propositions** — la parole n'est plus livrée par énoncés
   entiers mais par groupes de mots d'environ **2,5 s** : une respiration
   (≈ 0,25 s) suffit à clore un segment, puis la moindre micro-pause au-delà
   de la durée cible. Sans pause, coupe forcée à **5 s**, placée sur la trame
   la moins « parlée » de la seconde moitié du segment, pour ne pas trancher
   un mot. Sur un PC lent, le serveur **allonge automatiquement** les
   propositions (jusqu'à 8 s), car chaque appel à Whisper a un coût fixe.
3. **Aucun recouvrement** entre segments : aucun mot n'est transcrit deux fois,
   donc aucune répétition dans la voix française.
4. **Traduction immédiate** — une proposition est traduite même si la phrase
   n'est pas finie ; seul un fragment final de 1 à 3 mots, coupé en pleine
   phrase, est rattaché à la proposition suivante.
5. **Contexte limité** — les 200 derniers caractères transcrits servent
   d'amorce au moteur de reconnaissance (meilleure ponctuation et cohérence),
   mais `condition_on_previous_text` reste désactivé pour éviter que le modèle
   ne « parte en boucle » sur un passage difficile.
6. **Rejet de l'incertain** — un segment est **écarté sans être traduit** si
   la vraisemblance moyenne est trop basse, si le modèle signale « pas de
   parole », si le texte est trop répétitif, ou s'il correspond à une phrase
   parasite connue de Whisper (« Thank you. », « Thanks for watching! »…)
   sur un passage sans parole nette. **Rien n'est inventé.**
7. **Trois étages en parallèle** — reconnaissance, traduction et voix ont
   chacun leur fil : la reconnaissance du segment suivant n'attend plus la
   traduction du précédent.
8. **Synthèse** (blancs de début et de fin retirés) et mise en file de lecture.

### Rythme de la voix et retard

* **Vitesse calée sur l'original** : le serveur estime la durée de chaque
  phrase française (débit de la voix appris pendant la session) et l'accélère
  pour qu'elle tienne dans la durée de la parole anglaise correspondante ; il
  accélère aussi dès que le retard dépasse **2 s**. Plafond : × 1,4.
* Le serveur **estime lui-même** quand la voix sera libre (à chaque envoi) ;
  l'extension recale cette estimation toutes les 0,5 s.
* **PC trop lent** : si la reconnaissance dépasse durablement 0,7 × le temps
  réel, le serveur bascule tout seul vers un modèle plus rapide
  (`small.en` → `base.en` → `tiny.en`) et l'extension l'affiche.
* Attente côté serveur bornée à **8 s** (au-delà, les segments les plus
  anciens sont abandonnés et signalés) ; décodage rapide au-delà de 2,5 s.
* File de lecture bornée côté extension à **8 s** : au-delà, des passages sont
  sautés — ou, si l'option est active, **la vidéo est mise en pause** (dès 4 s)
  le temps que la traduction rattrape.

### Annulation du travail périmé

Chaque élément porte une **« époque »**. Un saut dans la timeline, un
changement de leçon, une nouvelle page, une pause ou une reconnexion
**incrémentent l'époque** : tout ce qui est en file ou en cours de calcul pour
une époque antérieure est jeté, côté serveur comme côté extension. On n'entend
donc jamais la traduction d'un passage que l'on vient de quitter.

### Pas de boucle audio

La voix française est jouée **par le document offscreen**, pas par l'onglet.
Elle ne fait donc pas partie du son capté et ne peut pas être re-transcrite.
C'est vérifié par le test automatique `boucle`.

## 6. Sécurité de la liaison locale

Le serveur n'est pas un service ouvert :

| Protection | Détail |
| --- | --- |
| Écoute | `127.0.0.1` uniquement ; la configuration **refuse** toute autre adresse. |
| En-tête `Origin` | Doit être `chrome-extension://hphdjdgoecdegmdanhnlgdihjclkmnjp`. Une page web (`https://…`) ou une autre extension est refusée **avant** l'ouverture du WebSocket. |
| En-tête `Host` | Doit désigner la boucle locale (protection contre le « DNS rebinding »). |
| Identifiant d'extension fixe | Obtenu par la clé publique inscrite dans `manifest.json` : il ne change pas d'un PC à l'autre. |
| Jeton partagé | Facultatif (`auth_token`), comparé en temps constant. |
| Validation des messages | Type, taille et champs vérifiés ; un message invalide ferme la connexion. Trames audio limitées à 2 s. |
| Session unique | Une seule session active ; une nouvelle connexion remplace proprement l'ancienne. |
| Endpoint `/health` | Répond `voice-translator: ok`, sans aucune information sur la machine ni sur l'activité. |

Côté extension :

* Permissions demandées : `activeTab`, `tabCapture`, `offscreen`, `scripting`,
  `storage`. **Pas** de `tabs`, **pas** de `<all_urls>`, **pas** de
  `webRequest`, **pas** de `cookies`, **pas** de microphone.
* L'accès à `udemy.com` est une **permission facultative**, demandée seulement
  si vous cliquez sur le bouton correspondant.
* Le script de page n'est injecté **qu'après** « Démarrer », et seulement dans
  l'onglet capturé.
* Les commandes de pilotage ne sont acceptées que des pages de l'extension.

## 7. Qualité de traduction pour une formation technique

**Glossaire** (modifiable dans les options), trois types d'entrées :

```
TIBCO | tipco, tibko, tico        → terme conservé ; formes mal reconnues corrigées
shared resource = ressource partagée  → traduction imposée
fr: conférence => leçon           → remplacement dans le texte français
```

Mécanismes :

1. **Amorce de reconnaissance.** Les noms propres du glossaire sont injectés
   dans une phrase d'amorce (« This course covers TIBCO, BusinessWorks… »).
   Essai mesuré sur l'extrait de test : sans amorce, Whisper `base.en` écrit
   *« tickle business works »* ; avec l'amorce, *« TIBCO BusinessWorks »*.
   Une simple liste de mots-clés (`hotwords`) s'est révélée moins bonne : elle
   introduit des virgules parasites (« TIBCO, BusinessWorks »).
2. **Correction d'après les alias** sur le texte transcrit (casse officielle
   restaurée).
3. **Traductions imposées insérées dans la phrase source** avant traduction :
   les modèles OPUS-MT les recopient et accordent la phrase autour.
4. **Protection par jetons** en second recours : chaque terme technique est
   remplacé par un jeton de la forme `ZX1Q`, que les deux modèles recopient
   fidèlement (vérifié expérimentalement ; les formes `<1>` ou `⟦1⟧` sont
   détruites par le modèle `tc-big`), puis réinséré après traduction.
5. **Détection automatique du « code »** : identifiants à points, `camelCase`,
   `PascalCase`, `snake_case`, chemins Windows et Unix, options de commande,
   URL, appels `machin()`. Inutile de les lister dans le glossaire.
6. **Rejet des traductions incohérentes** (répétitions, longueur aberrante) :
   la phrase n'est alors pas prononcée.
7. **Texte prononçable** : avant la synthèse, `getCustomerById` devient
   « get Customer By Id », `C:\tibco\bw\logs` devient « C tibco bw logs »,
   `->` devient « vers »… Le texte des sous-titres, lui, n'est pas modifié.

## 8. Synchronisation avec la vidéo

Deux niveaux, comme demandé :

* **Mode générique** — ne dépend d'aucune structure HTML : il suffit d'une
  balise `<video>` ou `<audio>`. Lecture, pause, saut (détecté même si le site
  n'émet pas l'événement), changement de source et vitesse sont suivis.
* **Adaptateur Udemy** — détecte en plus le **changement de leçon** à partir de
  l'adresse (`/learn/lecture/<id>`), ce que le mode générique ne peut pas
  distinguer d'un simple saut.

Si aucun lecteur contrôlable n'est trouvé (page protégée, lecteur dans un
cadre inaccessible), l'extension le **dit clairement** dans sa fenêtre et
continue en mode générique : seul le son de l'onglet est utilisé, et la pause
automatique est indisponible.

> **Non vérifié :** l'adaptateur Udemy n'a **pas** été testé sur le vrai site
> (pas de compte Udemy dans l'environnement de développement). Il est écrit à
> partir de la structure des adresses Udemy et testé sur une page qui
> reproduit le même comportement (changement de source + changement
> d'adresse). La procédure pour le valider sur votre compte est dans
> [udemy.md](udemy.md).
