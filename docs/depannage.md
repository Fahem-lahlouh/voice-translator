# Dépannage

## L'extension affiche « Serveur local injoignable »

1. La fenêtre `demarrer-serveur.bat` est-elle **ouverte** et affiche-t-elle
   `Moteurs prêts` ?
2. Le **port** est-il le même des deux côtés ? Options de l'extension →
   « Port d'écoute » ; côté serveur, c'est la valeur affichée au démarrage
   (47831 par défaut). Le bouton **« Tester la connexion au serveur »** dans
   les options le vérifie immédiatement.
3. Un pare-feu peut bloquer même une connexion locale. Autorisez
   `server\.venv\Scripts\python.exe` dans le pare-feu Windows, pour les
   **réseaux privés**.
4. Un autre programme occupe peut-être le port. Changez-le des deux côtés :

   ```bat
   scripts\demarrer-serveur.bat --port 47832
   ```

L'extension se reconnecte **toute seule** dès que le serveur revient : il n'y
a pas besoin de redémarrer la traduction.

## « Chrome n'a pas autorisé la capture de cet onglet »

Chrome exige un geste de votre part sur l'onglet concerné. Affichez l'onglet
de la vidéo, cliquez sur l'icône de l'extension (ou `Ctrl+Maj+Y`), puis sur
**Démarrer**. Ne démarrez pas depuis un autre onglet.

## « Chrome interdit la capture de cette page »

Les pages internes (`chrome://`, nouvel onglet, Chrome Web Store) ne peuvent
pas être capturées. Ouvrez la vidéo dans un onglet normal.

## Aucun son n'est capté (l'indicateur reste à zéro)

* La vidéo est-elle réellement en **lecture** ?
* Le volume **dans le lecteur de la page** n'est-il pas à zéro ? La capture
  prend le son tel que l'onglet le produit : un lecteur muet ne donne rien.
  (Le curseur « volume de la voix originale » de l'extension, lui, n'a aucun
  effet sur la capture.)
* Le bon onglet est-il capturé ? L'extension indique « La traduction est en
  cours sur un autre onglet » le cas échéant.
* Une autre extension capture-t-elle déjà cet onglet ? Un seul programme à la
  fois peut le faire.

## « Du son est capté mais aucune parole n'est détectée »

Le son arrive mais le détecteur de parole ne trouve rien : musique
d'introduction, volume très faible, ou voix noyée dans le bruit. Montez le
volume dans le lecteur de la page.

## Je n'entends pas la voix française

* Le bouton **Tester** à côté de la voix produit-il du son ? Si non, le
  problème est entre le serveur et la sortie audio de Windows.
* Le **volume de la voix française** n'est-il pas à zéro ?
* Le volume de Chrome dans le **mélangeur de volume de Windows** (clic droit
  sur l'icône de volume) n'est-il pas coupé ?

## La traduction a trop de retard

Dans l'ordre :

1. Augmentez la **vitesse de la voix** (1,2 × par exemple).
2. Activez **« Mettre la vidéo en pause quand la voix prend du retard »**.
3. Passez à un profil plus léger : `server\config.json` → `"profile": "prudent"`,
   voire `{"profile": "prudent", "asr_model": "tiny.en"}`.
4. Fermez les autres applications lourdes.

`scripts\mesurer-pc.bat` indique quel profil votre PC peut suivre.

## Les noms techniques sont mal traduits

Ajoutez-les au **glossaire** (options de l'extension). Voir
[utilisation.md](utilisation.md#le-glossaire).

## La voix prononce du charabia sur du code

Signalez le cas : la préparation du texte à prononcer (`speakable_fr`) couvre
les formes courantes, mais pas toutes. En attendant, une entrée de glossaire
`fr: <forme> => <texte à dire>` règle le cas.

## L'installation échoue

| Message | Cause et solution |
| --- | --- |
| `aucun Python 3.11, 3.12 ou 3.13 n'a été trouvé` | Installez Python en cochant **« Add python.exe to PATH »**, puis relancez. |
| `l'installation des bibliothèques a échoué` | Pas d'accès Internet, ou proxy d'entreprise. Essayez depuis une autre connexion, ou configurez `pip` (`%APPDATA%\pip\pip.ini`). |
| `Empreinte SHA-256 incorrecte` | Téléchargement corrompu. Le fichier a été supprimé : relancez `installer.bat`. |
| `Taille inattendue` | Idem : relancez, la reprise est automatique. |
| Antivirus qui bloque | Certains antivirus analysent longuement les gros `.bin`. Ajoutez le dossier du projet aux exclusions. |

## Le serveur refuse la connexion de l'extension

Message côté serveur : `Connexion refusée : origine non autorisée`.

L'identifiant de votre extension n'est pas celui attendu. Vérifiez dans
`chrome://extensions` qu'il vaut bien
`hphdjdgoecdegmdanhnlgdihjclkmnjp`. S'il diffère (manifeste modifié),
ajoutez le vôtre dans `server\config.json` :

```json
{
  "profile": "prudent",
  "allowed_extension_ids": ["hphdjdgoecdegmdanhnlgdihjclkmnjp", "votre_identifiant"]
}
```

## Les sous-titres ne s'affichent pas

* L'option est-elle cochée ?
* Sur certains sites, le lecteur est dans un cadre interne : les sous-titres
  s'affichent alors sur la page principale, ou dans le cadre en plein écran.
* Le script est injecté au démarrage. Si vous avez rechargé la page, il est
  réinjecté automatiquement ; sinon, arrêtez et redémarrez.

## Tout remettre à zéro

* **Réglages de l'extension** : options → « Effacer tous les réglages
  enregistrés ».
* **Serveur** : supprimez `server\.venv` et `server\models`, puis relancez
  `scripts\installer.bat`.

## Obtenir plus de détails

Dans `server\config.json` :

```json
{ "profile": "prudent", "log_level": "DEBUG" }
```

Côté extension : `chrome://extensions` → « Doublage vocal local » → **« Inspecter
les vues : service worker »** et, pendant une session, **« offscreen.html »**.
