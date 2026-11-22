# Doublage vocal local — anglais vers français

Extension Chrome + petit serveur local qui écoutent le son d'un onglet, le
transcrivent, le traduisent et le **lisent à voix haute en français**, pendant
que la vidéo continue.

Conçu pour suivre une formation technique en anglais (TIBCO, Java, etc.) sans
lire de sous-titres.

* **Fonctionne sans sous-titres.** Rien n'est lu dans la page : c'est le son de
  l'onglet qui est analysé. Une vidéo sans sous-titres fonctionne donc
  exactement comme les autres.
* **100 % local, gratuit.** Aucun abonnement, aucune clé d'API, aucun quota.
  Les modèles sont téléchargés une fois (≈ 360 Mo pour le profil par défaut)
  puis exécutés sur votre PC.
* **Rien ne sort de votre machine.** Le son va uniquement au serveur local
  (`127.0.0.1`). Les phrases traduites sont gardées dans une bibliothèque
  locale (désactivable). L'extension ne lit ni cookies, ni identifiants, ni
  jetons de session, et ne demande jamais le microphone.

> Ce projet est une réalisation personnelle. Il ne reprend ni le code, ni la
> marque, ni l'interface d'un produit existant.

## Mise en route (Windows)

```bat
scripts\installer.bat
```

```bat
scripts\demarrer-serveur.bat
```

Puis chargez l'extension dans Chrome : **[docs/installation.md](docs/installation.md)**.

Ensuite, sur la page de la vidéo : cliquez sur l'icône de l'extension (ou
`Ctrl+Maj+Y`), puis sur **Démarrer**.

## Documentation

| Document | Contenu |
| --- | --- |
| [docs/installation.md](docs/installation.md) | Installation pas à pas, chargement de l'extension dans Chrome |
| [docs/utilisation.md](docs/utilisation.md) | Réglages, glossaire, synchronisation avec la vidéo |
| [docs/modeles.md](docs/modeles.md) | Modèles téléchargés, tailles, **licences**, besoins RAM / CPU / disque |
| [docs/architecture.md](docs/architecture.md) | Choix techniques, options comparées, fonctionnement interne |
| [docs/tests.md](docs/tests.md) | Ce qui a été réellement testé, et les mesures obtenues |
| [docs/udemy.md](docs/udemy.md) | Procédure pour valider le fonctionnement sur **votre** compte Udemy |
| [docs/depannage.md](docs/depannage.md) | Problèmes courants et solutions |
| [docs/limites.md](docs/limites.md) | Limites connues et pistes d'amélioration |

## Ce que ça donne

Extrait réel produit par le système (reconnaissance → traduction) :

| Anglais entendu | Français prononcé |
| --- | --- |
| *Open TIBCO Business Studio and in the Project Explorer, right-click on the package and select New, then BusinessWorks process.* | « Ouvrez TIBCO Business Studio et dans l'Explorateur de projet, faites un clic droit sur le paquet et sélectionnez Nouveau, puis processus BusinessWorks. » |
| *It uses a shared resource called JDBC connection, which you configure in the module properties.* | « Il utilise une ressource partagée appelée connexion JDBC, que vous configurez dans les propriétés de module. » |

Retard mesuré entre la fin d'une phrase anglaise et le début de sa version
française : **≈ 1,5 à 2,5 s** sur la machine de test (4 cœurs, sans GPU).
Voir [docs/tests.md](docs/tests.md) pour les conditions exactes.

## Licence

Code de ce projet : MIT (voir [LICENSE](LICENSE)).

Les modèles et les voix téléchargés ont **leurs propres licences**, détaillées
dans [docs/modeles.md](docs/modeles.md). En particulier, la bibliothèque de
synthèse vocale Piper est sous GPL-3.0-or-later et la voix française par
défaut (SIWIS) sous CC-BY-4.0 : une diffusion publique de vos enregistrements
demanderait de respecter ces conditions.
