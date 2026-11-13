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
| **Accélérer légèrement la voix** | Jusqu'à × 1,25 automatiquement, uniquement en cas de retard. |

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

Rien ne reste en mémoire : aucun son ni aucune transcription n'est conservé.
