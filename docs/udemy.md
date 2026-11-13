# Valider le fonctionnement sur votre compte Udemy

> **À lire d'abord.** L'adaptateur Udemy n'a **pas** été testé sur le vrai
> site : l'environnement de développement n'a pas de compte Udemy, et il
> n'était pas question d'utiliser le vôtre. Ce qui suit est la procédure pour
> le vérifier vous-même, étape par étape, avec ce qu'il faut observer à chaque
> fois.
>
> Le **mode générique** (son de l'onglet) a, lui, été testé de bout en bout et
> ne dépend d'aucune particularité d'Udemy : il doit fonctionner même si
> l'adaptateur échoue.

L'extension ne lit **jamais** vos identifiants, cookies ou jetons de session
Udemy : elle n'a pas la permission d'y accéder. Elle écoute le son de l'onglet
et, si vous l'y autorisez, observe les événements du lecteur vidéo.

## Avant de commencer

* Serveur lancé (`scripts\demarrer-serveur.bat`), `Moteurs prêts` affiché.
* Extension chargée dans Chrome.
* Connectez-vous à Udemy **normalement**, comme d'habitude.

## Test 1 — Doublage de base (mode générique)

1. Ouvrez une leçon en anglais, **mettez-la en pause** au début.
2. `Ctrl+Maj+Y` → **Démarrer**.
3. Lancez la lecture.

**Attendu :** au bout de 5 à 10 s, la voix française commence. L'indicateur
« Son capté » bouge, « Retard estimé » s'affiche.

**Si rien ne vient :** vérifiez que le volume **du lecteur Udemy** n'est pas à
zéro, puis voir [depannage.md](depannage.md).

## Test 2 — Détection du lecteur

Dans la fenêtre de l'extension, lisez la ligne sous les sous-titres :

* « **Lecteur Udemy détecté** : pause, reprise, sauts et changements de leçon
  sont suivis. » → l'adaptateur fonctionne.
* « Lecteur vidéo détecté » (sans mention d'Udemy) → le lecteur est contrôlé,
  mais la détection du site n'a pas abouti (lecteur dans un cadre interne,
  par exemple). Le reste fonctionne.
* « **Aucun lecteur vidéo contrôlable** » → mode générique seul. Cliquez sur
  « Autoriser l'extension sur udemy.com », **rechargez la page**, puis
  redémarrez. Si le message persiste, notez-le : c'est une information utile.

## Test 3 — Pause et reprise de la vidéo

1. Pendant la lecture, mettez la **vidéo** en pause (barre d'espace).
2. Attendez 10 s.
3. Reprenez.

**Attendu :** la voix française finit la phrase en cours, puis se tait.
Aucune phrase inventée pendant la pause. À la reprise, la traduction repart.

## Test 4 — Retour arrière

Reculez de 30 s (touche ←, ou la barre de progression).

**Attendu :** la voix française s'interrompt **immédiatement** et repart sur
le nouveau passage. Vous ne devez **pas** entendre la fin de la traduction du
passage quitté.

C'est le point le plus important à vérifier : si vous entendez la traduction
de l'ancien passage, notez-le.

## Test 5 — Changement de leçon

Passez à la leçon suivante (bouton suivant, ou le panneau de droite).

**Attendu :** même comportement qu'au test 4. La traduction reprend sur la
nouvelle leçon sans qu'il faille toucher à l'extension.

## Test 6 — Vitesse de lecture

Passez le lecteur Udemy à **1,25 ×** puis **1,5 ×**.

**Attendu :** la voix française accélère en proportion ; le retard reste
stable. À 2 ×, il est normal que le retard augmente sur un PC modeste.

## Test 7 — Plein écran

Passez en plein écran.

**Attendu :** si les sous-titres sont activés, ils restent visibles. La voix
continue.

## Test 8 — Fermeture de la fenêtre de l'extension

Fermez la fenêtre de l'extension (clic ailleurs).

**Attendu :** la voix française continue sans interruption ; la pastille `FR`
reste sur l'icône.

## Test 9 — Arrêt

Cliquez sur **Arrêter**.

**Attendu :** la voix s'arrête, le son d'origine revient à plein volume, la
pastille disparaît. Dans le gestionnaire des tâches, Chrome doit cesser
d'afficher l'indicateur d'enregistrement de l'onglet.

## Test 10 — Une leçon entière

Suivez une leçon complète (10 à 20 minutes) en conditions réelles.

À surveiller :

* le **retard** reste-t-il stable, ou augmente-t-il sans redescendre ?
* des messages « passages ignorés » apparaissent-ils ?
* la **mémoire** du serveur reste-t-elle stable (gestionnaire des tâches →
  `python.exe`) ?

## Quoi noter

Si quelque chose ne va pas, les informations utiles sont :

1. le message exact affiché par l'extension ;
2. les dernières lignes de la fenêtre du serveur ;
3. la console du traitement audio : `chrome://extensions` → « Doublage vocal
   local » → « Inspecter les vues : offscreen.html » → onglet « Console » ;
4. ce que disait l'indicateur « Son capté » à ce moment-là.

## Rappel sur les conditions d'utilisation

Ce doublage est à usage **personnel**, pour suivre une formation que vous avez
achetée. N'enregistrez pas et ne rediffusez pas le contenu : les conditions
d'Udemy et le droit d'auteur de l'auteur du cours s'appliquent.
