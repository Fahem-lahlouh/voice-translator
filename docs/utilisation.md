# Utilisation

## Démarrer le doublage

1. Le serveur doit tourner (`scripts\demarrer-serveur.bat`, fenêtre ouverte).
2. Affichez l'onglet de la vidéo.
3. Cliquez sur l'icône de l'extension, ou appuyez sur **`Ctrl+Maj+Y`**.
4. Cliquez sur **Démarrer**.
5. Lancez la vidéo.

> Chrome n'autorise la capture d'un onglet **qu'après** un geste de votre part
> sur cet onglet. Il faut donc toujours passer par l'icône ou le raccourci —
> le doublage ne peut pas démarrer tout seul. C'est une protection de Chrome,
> pas une limitation du projet.

Une fois démarré, **vous pouvez fermer la fenêtre de l'extension** : le
traitement continue. La pastille sur l'icône indique l'état : `FR` (en cours),
`II` (en pause), `!` (erreur).

## Les commandes

| Commande | Effet |
| --- | --- |
| **Démarrer** | Commence la capture de l'onglet affiché. |
| **Pause** | Suspend la traduction, vide la file et **rend le volume d'origine**. La vidéo n'est pas touchée. |
| **Reprendre** | Repart à partir du son actuel (rien n'est rattrapé). |
| **Arrêter** | Libère la capture, ferme la liaison et le traitement audio. Plus rien ne tourne côté navigateur. |

## Les réglages

| Réglage | Détail |
| --- | --- |
| **Voix française** | `siwis` (féminine) par défaut ; `upmc` ajoute Jessica et Pierre (`scripts\telecharger-voix.bat`). Le bouton **Tester** lit une phrase. |
| **Vitesse de la voix** | 0,8 × à 1,5 ×. Une voix un peu plus rapide réduit le retard. |
| **Volume de la voix originale** | 0 à 100 %. **N'affecte pas la traduction** (voir ci-dessous). 20 % est un bon compromis : on garde l'intonation et les bruits de l'écran sans gêner. |
| **Volume de la voix française** | 0 à 150 %. |
| **Baisser encore l'original pendant que la voix française parle** | Atténuation supplémentaire pendant chaque phrase française. |
| **Sous-titres français sur la page** | Affiche la phrase en cours en bas de la vidéo (fonctionne aussi en plein écran). |
| **Afficher aussi le texte anglais reconnu** | Utile pour repérer un mot mal reconnu à ajouter au glossaire. |
| **Mettre la vidéo en pause quand la voix prend du retard** | La vidéo est mise en pause automatiquement, puis relancée quand la traduction a rattrapé. Demande un lecteur contrôlable. |
| **Accélérer légèrement la voix** | Jusqu'à × 1,4 automatiquement, pour que chaque phrase française tienne dans la durée de l'original et que le retard ne s'accumule pas. |

### Pourquoi baisser l'original ne dégrade pas la traduction

Le son capté part dans deux directions **indépendantes** : une vers vos
haut-parleurs (c'est là qu'agit le curseur), une vers la reconnaissance
vocale, **prise avant tout réglage de volume**. Mettre l'original à zéro ne
change donc rien à ce qui est transcrit.

## Les indicateurs

| Indicateur | Signification |
| --- | --- |
| **Retard estimé** | Temps entre la **fin** d'une phrase anglaise et le **début** de sa version française. 1,5 à 3 s est normal. |
| **Voix en attente** | Durée de français déjà prêt mais pas encore prononcé. S'il monte sans redescendre, le PC ne suit pas. |
| **Charge de calcul** | Part du temps réel consommée par les moteurs. Au-delà de ~70 %, prenez un profil plus léger. |
| **Son capté** | Niveau du son arrivant de l'onglet. S'il reste à zéro alors que la vidéo joue, voir [depannage.md](depannage.md). |

Des messages apparaissent aussi quand des passages ont été ignorés (PC trop
lent), sautés (voix trop en retard) ou jugés trop incertains pour être
traduits.

## Ma bibliothèque (écran)

Lien **« Ma bibliothèque »** en bas de la fenêtre de l'extension (ou dans les
options). On y trouve :

* **la liste de vos vidéos** : recherche par titre, tri (date, titre,
  plateforme, progression), filtres par plateforme et par langue, progression,
  suppression ;
* **la transcription bilingue** de chaque vidéo, horodatée : recherche avec
  surlignage (accents et majuscules ignorés), **cliquer sur une heure** pour
  aller à ce moment de la vidéo, copier une phrase ou une sélection,
  **corriger une traduction** (c'est la version corrigée qui sera lue
  ensuite) et **ajouter une note** ;
* **les exports** : texte, Markdown, PDF (via l'impression de Chrome :
  « Enregistrer au format PDF »), sous-titres SRT français ou bilingues, JSON ;
* **la recherche d'une phrase dans toute la bibliothèque**.

« Aller à ce moment » : si la vidéo est en cours de doublage dans un onglet,
elle s'y positionne directement ; sinon elle est ouverte dans un nouvel
onglet, au bon moment sur YouTube, au début sur les autres sites (Udemy ne
permet pas d'ouvrir une leçon à une position précise : l'heure est rappelée).

## Résumés (onglet « Résumé » d'une vidéo)

Deux résumés, tous deux **gratuits et calculés sur ce PC** :

* **Résumé express**, instantané, sans le serveur : il ne rédige rien, il
  **choisit des phrases réelles** de la vidéo (les plus représentatives), les
  termes clés et, pour une vidéo longue, un découpage par chapitre. Chaque
  extrait a son heure : cliquez pour y aller. Il ne peut pas inventer.
* **Résumé rédigé par l'IA locale** (bouton « Générer le résumé », serveur
  local démarré) : résumé court, points essentiels (concepts pour une
  formation, événements pour un film), résumé par chapitre pour les vidéos
  longues et, en option, une **fiche de révision** (définitions et questions
  sous forme de cartes à retourner). Le type de contenu est deviné
  d'après le site ; vous pouvez le changer.

Le modèle d'IA (≈ 3,2 Go, ou ≈ 1,7 Go pour le modèle léger) est téléchargé
**une fois**, après confirmation, la première fois que vous lancez un résumé.
Le premier résumé après le démarrage du serveur attend en plus le chargement
du modèle (jusqu'à 1 à 2 minutes). Comptez **quelques minutes** de calcul
pour 10 minutes de vidéo sur un portable (voir [tests.md](tests.md)) ; le doublage en cours n'est pas
interrompu, mais il peut ralentir pendant ce temps. « Annuler » arrête le
calcul.

**Fiabilité.** Un petit modèle local peut se tromper, mélanger des
personnages ou inventer un détail. Pour vous aider à repérer ces erreurs,
chaque point est relié au passage de la vidéo qui lui ressemble le plus :

* « appuyé » : un passage proche existe (cliquez sur l'heure pour vérifier) ;
* « à vérifier » : appui faible, ou un nom cité par le résumé est introuvable
  dans la vidéo.

C'est un **indice, pas une preuve** : un point « appuyé » peut contenir une
erreur, un point « à vérifier » peut être juste. Le résumé ne décrit jamais
ce qui se voit à l'image : il ne connaît que ce qui est dit.

Le résumé est enregistré avec la vidéo et peut être exporté en Markdown.

## Bibliothèque (enregistrement des sessions)

Activée par défaut. Pendant le doublage, chaque phrase traduite est
enregistrée **sur ce PC, dans le navigateur**, au fil de la lecture, avec son
moment exact dans la vidéo (anglais + français). Fermer Chrome ne fait perdre
que la phrase en cours. Revenir en arrière sur un passage déjà traduit ne crée
pas de doublon. La vidéo est reconnue par son adresse, débarrassée des
paramètres temporaires (« ?t=42s », etc.).

Ce qui est enregistré : titre et adresse de la page, durée de la vidéo,
phrases anglaises et françaises horodatées. Jamais le son ni l'image.

Options → **Bibliothèque** : désactiver l'enregistrement ou tout effacer.

## Lecture synchronisée (façon film)

Quand un passage a **déjà été traduit** (vous revenez en arrière, ou vous
revoyez une leçon), la voix française n'est plus produite en direct : elle est
préparée quelques secondes à l'avance et démarre **au moment même où
l'anglais commence** (écart mesuré : 0,02 s en médiane). Sa vitesse est
ajustée pour finir avant la phrase suivante (× 1,4 au plus). Pause, retour
arrière et changement de vitesse restent calés sur la vidéo.

Au premier visionnage, c'est le doublage en direct (quelques secondes de
décalage) qui s'applique. Option dans la fenêtre de l'extension : « Lecture
synchronisée ». Elle demande que la bibliothèque soit activée.

## Préparer le doublage (doublage calé dès le premier visionnage)

Bouton **« Préparer le doublage de cette vidéo »** dans la fenêtre de
l'extension (il démarre aussi la capture si besoin) :

1. la vidéo est lue **en accéléré (× 1,5), son coupé**, sans voix française ;
   un bandeau indique la progression et le temps restant ;
2. chaque phrase est traduite et enregistrée dans la bibliothèque ;
3. à la fin, la vidéo revient à son point de départ, en pause, vitesse
   normale : lancez la lecture, chaque phrase est doublée **au moment où
   l'anglais commence**.

Compter environ les deux tiers de la durée de la vidéo (mesuré : 53 s pour
76 s). Sur un PC lent, la lecture est automatiquement ralentie (× 1,25, × 1)
voire mise en pause, plutôt que de perdre des phrases. Les passages déjà
traduits sont sautés. « Annuler la préparation » garde ce qui est déjà fait.

Ne marche que sur une vidéo à la demande avec un lecteur contrôlable (pas
sur un direct). Rien n'est téléchargé : seul le son est capté, comme pour le
doublage en direct.

## Type de contenu

Par défaut **automatique** : d'après le site (Udemy, Coursera… → formation ;
Netflix, Prime Video… → film ; TED, Arte… → documentaire), sinon un réglage
général valable pour tout contenu. Vous pouvez le forcer dans la fenêtre de
l'extension. Il règle la finesse du découpage (dialogues plus réactifs pour
un film ou une conversation) et les règles de prononciation propres à un
domaine.

## Expressions et sigles

* Une centaine d'**expressions courantes** sont traduites par leur
  équivalent français (« It's raining cats and dogs » → « Il pleut des
  cordes », « Let's call it a day » → « On s'arrête là pour aujourd'hui »).
  Vous pouvez en ajouter dans le glossaire :
  `expr: hit the road => prendre la route`.
* Les **sigles** sont prononcés à la française : épelés quand c'est l'usage
  (SAP, ERP, API, FBI, y compris après « l' »), lus comme un mot sinon
  (NASA, OTAN). Une section **Prononciation** des options permet de corriger
  un cas : `SAP = épeler`, `NASA = mot`, `Kubernetes = kou beur né tisse`.
  Seule la voix change : les sous-titres gardent l'orthographe d'origine.

## Le glossaire

Options de l'extension (lien en bas de la fenêtre, ou
`chrome://extensions` → Détails → Options extension).

Trois formes d'entrées, une par ligne :

```
# Conserver un terme tel quel, et corriger ses formes mal reconnues
TIBCO | tipco, tibko, tico, tickle
BusinessWorks | business works

# Imposer une traduction
shared resource = ressource partagée
module properties = propriétés de module

# Remplacer un mot dans le texte français produit
fr: conférence => leçon
```

Inutile d'y mettre les identifiants, chemins, commandes ou noms de méthodes :
`getCustomerById`, `C:\tibco\bw\logs`, `--debug`, `org.apache.Foo` sont
reconnus et préservés automatiquement.

**Méthode conseillée :** activez « Afficher aussi le texte anglais reconnu »,
regardez quelques minutes de cours, notez les mots systématiquement mal
reconnus et ajoutez-les comme alias. Un glossaire par domaine prend cinq
minutes à constituer et change nettement le résultat.

Le glossaire par défaut fourni couvre le vocabulaire TIBCO de base.

## Changement de leçon, pause, retour arrière

* **Pause de la vidéo** → la traduction s'arrête d'elle-même (plus de son).
* **Retour arrière / avance** → tout ce qui était en attente est **jeté** :
  vous n'entendez pas la traduction du passage que vous venez de quitter.
* **Changement de leçon** → idem, détecté automatiquement.
* **Changement de vitesse** → transmis au serveur, qui adapte le débit de la
  voix française.

## Raccourci clavier

`Ctrl+Maj+Y` ouvre la fenêtre de l'extension pour l'onglet affiché.
Modifiable dans `chrome://extensions/shortcuts`.

## Arrêter proprement

1. **Arrêter** dans la fenêtre de l'extension (libère la capture).
2. Fermez la fenêtre du serveur, ou `Ctrl+C` dedans.

Aucun son n'est conservé. Les phrases traduites restent dans la **bibliothèque
locale** (sur ce PC uniquement), sauf si vous l'avez désactivée dans les options.
