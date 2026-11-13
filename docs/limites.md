# Limites connues

## Limites de fond (inhérentes à l'approche)

* **Le doublage est décalé, pas instantané.** Il faut attendre la fin d'une
  phrase pour la traduire : c'est structurel. Compter **1,5 à 3 s** après la
  fin de chaque phrase anglaise sur un PC correct. Une traduction réellement
  simultanée demanderait des modèles « streaming » bien plus lourds.
* **Pas de voix d'origine conservée.** La voix française est une voix de
  synthèse unique ; elle ne reproduit ni la voix ni le ton du formateur, et ne
  distingue pas plusieurs intervenants.
* **La traduction peut se tromper.** Elle est faite phrase par phrase, avec un
  contexte volontairement court. Sur un passage ambigu, le français peut être
  inexact. Les sous-titres anglais (option) permettent de recouper.
* **Seule la paire anglais → français est installée.** Le serveur refuse
  explicitement toute autre paire plutôt que de faire semblant. En ajouter une
  demande un modèle OPUS-MT et une voix supplémentaires.
* **La reconnaissance n'est pas parfaite.** Les noms propres rares, les
  acronymes épelés et les accents marqués posent problème. Le glossaire
  corrige les cas récurrents ; il ne fait pas de miracle.
* **Quand la reconnaissance est trop incertaine, rien n'est dit.** C'est un
  choix : mieux vaut un silence qu'une phrase inventée. Vous verrez alors un
  compteur « passages incertains » dans la fenêtre de l'extension.

## Limites techniques actuelles

* **Un seul onglet à la fois.** Le serveur n'accepte qu'une session.
* **Chrome 116 minimum** (consommation d'un flux de capture dans un document
  offscreen).
* **Le démarrage exige un geste de votre part** sur l'onglet (icône ou
  `Ctrl+Maj+Y`). Imposé par Chrome, pas contournable.
* **La fenêtre du serveur doit rester ouverte.** Il n'est pas installé comme
  service Windows.
* **Pas de rattrapage après une pause.** « Reprendre » repart du son présent ;
  ce qui a été manqué est perdu.
* **Le premier démarrage est lent** : chargement des modèles en mémoire
  (quelques secondes à une minute selon le profil et le disque).
* **Les sous-titres existants ne sont pas exploités.** Ils pourraient servir à
  fiabiliser la reconnaissance ; ce n'est pas fait (et c'était une exigence :
  ne pas en dépendre).

## Ce qui n'a pas été vérifié

Par honnêteté, voici ce qui n'a **pas** été testé et ne doit donc pas être
présenté comme acquis :

| Point | État |
| --- | --- |
| **Fonctionnement sur Udemy** | **Non testé.** Pas de compte Udemy dans l'environnement de développement. L'adaptateur est écrit d'après la structure des adresses Udemy et testé sur une page qui reproduit le même comportement. Procédure de validation : [udemy.md](udemy.md). |
| **Windows** | **Non testé.** Le développement et les tests ont eu lieu sous Linux. Le code est multiplateforme (Python + extension Chrome) et les dépendances ont toutes des versions Windows 64 bits vérifiées, mais les scripts `.bat` n'ont pas été exécutés sur une vraie machine Windows. |
| **Accélération GPU** | **Non testée.** `"device": "cuda"` est accepté par la configuration, mais rien n'a été mesuré. |
| **Longues sessions (> 20 min)** | **Non testées.** Le plus long essai continu a duré environ 2 minutes. La mémoire est bornée par construction (files limitées, aucun historique conservé), mais ce n'est pas une mesure. |
| **Plein écran sur un vrai site** | Partiellement : le repositionnement des sous-titres en plein écran est écrit et lu, mais pas testé sur un lecteur réel. |
| **Autres navigateurs** (Edge, Brave) | Non testés. L'API utilisée existe chez eux, mais l'identifiant d'extension et donc l'autorisation côté serveur peuvent différer. |
| **Voix `upmc`** | Téléchargement et synthèse testés hors ligne ; pas essayée en session complète. |

Ce qui **a** été testé, et comment, est détaillé dans [tests.md](tests.md).

## Améliorations possibles après le MVP

Par ordre d'utilité estimée :

1. **Rattrapage intelligent après une pause** : reprendre là où la traduction
   s'était arrêtée plutôt qu'au son présent.
2. **Mémoire de traduction par cours** : réutiliser les traductions déjà
   faites d'une phrase identique (les formateurs se répètent beaucoup), ce qui
   réduit à la fois le retard et les incohérences.
3. **Glossaire par domaine**, avec des listes prêtes à l'emploi (TIBCO, AWS,
   Kubernetes, Java…) et import/export.
4. **Apprentissage du glossaire** : proposer d'ajouter un terme quand le même
   mot inconnu revient souvent.
5. **Utiliser les sous-titres quand ils existent** pour corriger la
   reconnaissance (en **option**, jamais comme dépendance).
6. **Installation du serveur en service Windows**, ou démarrage automatique au
   lancement de Chrome, pour ne plus avoir de fenêtre à garder ouverte.
7. **Prise en charge du GPU** documentée et mesurée (CTranslate2 CUDA).
8. **Autres paires de langues** (allemand, espagnol) : la structure est déjà
   prête, il ne manque que les modèles et les voix.
9. **Export des sous-titres** d'une leçon en `.srt` français, pour relire
   après coup — avec une option claire, puisque par défaut rien n'est
   conservé.
10. **Meilleure gestion des changements d'intervenant** (diarisation légère),
    pour alterner deux voix françaises.
11. **Un paquet d'installation unique** (`.exe`) embarquant Python, pour
    supprimer l'étape « installer Python ».
