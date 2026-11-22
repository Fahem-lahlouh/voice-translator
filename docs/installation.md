# Installation

## 1. Ce qu'il faut avant de commencer

* **Windows 10 ou 11, 64 bits.**
* **Google Chrome 116 ou plus récent.** (Pour vérifier : menu ⋮ → Aide → À
  propos de Google Chrome.) Edge, Brave et Vivaldi, basés sur Chromium,
  fonctionnent aussi en principe, mais seul Chrome a été visé ici.
* **Python 3.11 à 3.14 (64 bits).** Python 3.14 convient (testé).
  À télécharger sur <https://www.python.org/downloads/windows/>.
  **Important :** pendant l'installation, cochez **« Add python.exe to PATH »**.
* **Environ 2 Go d'espace disque libre** (bibliothèques + modèles).
* Une connexion Internet **pour l'installation seulement**. Ensuite, tout
  fonctionne hors ligne.

## 2. Récupérer le projet

Décompressez l'archive (ou clonez le dépôt) dans un dossier **sans accent et
sans espace** si possible, par exemple `C:\doublage`.

Vous devez obtenir cette arborescence :

```
C:\doublage\
    extension\
    scripts\
    server\
    docs\
```

## 3. Installer le serveur local

Double-cliquez sur **`scripts\installer.bat`**.

Le script :

1. vérifie la présence de Python ;
2. crée un environnement Python isolé dans `server\.venv` (rien n'est installé
   dans votre Python système) ;
3. installe les bibliothèques (≈ 550 Mo installés) ;
4. vous demande un **profil** puis télécharge les modèles correspondants.

| Profil | Reconnaissance | Traduction | Téléchargement | Pour qui |
| --- | --- | --- | --- | --- |
| **prudent** (défaut) | Whisper `base.en` | OPUS-MT | ≈ 360 Mo | PC modeste, 4 cœurs, 8 Go de RAM |
| **equilibre** | Whisper `small.en` | OPUS-MT | ≈ 700 Mo | 6 cœurs et plus, 16 Go de RAM |
| **qualite** | Whisper `small.en` | OPUS-MT tc-big | ≈ 790 Mo | PC puissant, traduction plus soignée |

Commencez par **prudent**. Vous pourrez changer plus tard (section 7).

> Chaque fichier de modèle est vérifié par empreinte SHA-256 après
> téléchargement. Si la connexion est coupée, relancez simplement le script :
> les fichiers déjà reçus sont conservés et le téléchargement reprend.

## 4. Démarrer le serveur

Double-cliquez sur **`scripts\demarrer-serveur.bat`**.

Une fenêtre noire s'ouvre et affiche :

```
Voice Translator — serveur local 0.1.0
  Profil : prudent (ASR base.en, traduction opus-mt-en-fr, 3 fils de calcul, cpu)
  Écoute : ws://127.0.0.1:47831/ws — boucle locale uniquement
  Laissez cette fenêtre ouverte pendant la formation. Ctrl+C pour arrêter.
```

puis, après quelques secondes, `Moteurs prêts`.

**Laissez cette fenêtre ouverte** pendant toute la formation. La fermer arrête
la traduction.

## 5. Charger l'extension dans Chrome

1. Ouvrez Chrome.
2. Dans la barre d'adresse, tapez **`chrome://extensions`** puis Entrée.
3. En haut à droite, activez **« Mode développeur »**.
4. Cliquez sur **« Charger l'extension non empaquetée »**.
5. Choisissez le dossier **`extension`** du projet (celui qui contient
   `manifest.json`), puis validez.
6. L'extension « Doublage vocal local » apparaît dans la liste. Vérifiez
   que son identifiant est bien :

   ```
   hphdjdgoecdegmdanhnlgdihjclkmnjp
   ```

   Cet identifiant est fixe (il est dérivé de la clé publique inscrite dans
   `manifest.json`). C'est le **seul** identifiant que le serveur local
   accepte : une autre extension, ou une page web quelconque, ne peut pas s'y
   connecter.

7. Pour avoir l'icône toujours visible : cliquez sur la pièce de puzzle 🧩 à
   droite de la barre d'adresse, puis sur la punaise 📌 à côté de
   « Doublage vocal local ».

> Chrome affiche un bandeau « Désactivez le mode développeur… ». C'est normal
> pour une extension chargée localement, qui n'est pas publiée sur le Chrome
> Web Store. Vous pouvez fermer ce bandeau.

## 6. Premier essai

1. Ouvrez la page de test fournie, ou n'importe quelle vidéo en anglais.
   Pour la page de test, ouvrez une invite de commandes dans le dossier du
   projet et lancez :

   ```bat
   server\.venv\Scripts\python.exe test\serveur_test.py
   ```

   puis ouvrez <http://127.0.0.1:8777/page/> dans Chrome.

2. Cliquez sur l'icône de l'extension (ou appuyez sur **Ctrl+Maj+Y**).
3. Cliquez sur **Tester** à côté de la voix : vous devez entendre une phrase
   en français. Si oui, le serveur et l'audio fonctionnent.
4. Cliquez sur **Démarrer**, puis lancez la vidéo.
5. Au bout de quelques secondes, la voix française commence.

Si rien ne se passe, consultez **[depannage.md](depannage.md)**.

## 6 bis. Vérifier votre PC en un clic

Double-cliquez sur **`scripts\verifier-pc.bat`** (10 à 20 minutes, fermez
d'abord la fenêtre du serveur). Il enchaîne : caractéristiques du PC,
bibliothèques et modèles installés, tests automatiques, doublage d'un extrait
réel (le résultat est écrit dans `test\out\voix-francaise.wav`), mesure de
chaque profil avec une recommandation et, si un modèle de résumé est déjà
téléchargé, la durée d'un résumé.

Tout est écrit dans **`rapport-pc.txt`** à la racine du projet (il s'ouvre à
la fin). Ce rapport ne contient ni votre nom d'utilisateur ni vos dossiers :
vous pouvez le transmettre tel quel pour obtenir de l'aide.

## 7. Changer de profil plus tard

Modifiez `server\config.json` :

```json
{
  "profile": "equilibre"
}
```

puis relancez `scripts\demarrer-serveur.bat` (les modèles manquants sont
téléchargés automatiquement au démarrage, avec une barre de progression dans
la fenêtre de l'extension).

Pour savoir quel profil votre PC peut suivre, lancez
**`scripts\mesurer-pc.bat`** : il affiche les caractéristiques de la machine,
mesure le temps de calcul réel de chaque profil installé et recommande celui
qui convient.

## 8. Voix supplémentaires

**`scripts\telecharger-voix.bat`** télécharge toutes les voix françaises
disponibles (une féminine, une masculine). Elles apparaissent ensuite dans la
liste déroulante de l'extension.
