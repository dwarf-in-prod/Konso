# Konso — consignes de travail

- **Ne jamais committer directement sur `main`.** Chaque fonctionnalité ou correction se fait sur une nouvelle branche `feature/<nom-court>` ou `fix/<nom-court>`, créée depuis `main` à jour, puis poussée sur GitHub.
- Chaque push sur une branche compile un APK de test « Konso Test » (`app.konso.test`), publié dans la pré-release `test-<branche>` (les `/` deviennent des `-`), fichier `konso-test.apk`. Après un push, attendre la fin du workflow « Compiler l'APK » et donner à l'utilisateur le lien direct de l'APK : `https://github.com/<propriétaire>/Konso/releases/download/test-<branche>/konso-test.apk`.
- La fusion dans `main` se fait par pull request, seulement après validation de l'APK de test par l'utilisateur.
- Avant une vraie release : augmenter `versionCode` et `versionName` dans `app/build.gradle`. La release `latest` est publiée par un lancement manuel du workflow sur `main`, ou par un commit sur `main` dont le message contient `[release]`.
- Dépôt public : aucune information personnelle (nom, pseudo, e-mail, modèle de voiture…) dans le code, les commits, les messages ou les releases.
- Pas de SDK Android dans l'environnement cloud : la compilation se vérifie via GitHub Actions.

## Conventions d'interface (préférences de l'utilisateur)
- **Choisir dans une liste : la roue.** Pour choisir une valeur dans une liste (langue, kilométrage…), utiliser la roue plein écran `picker()` (basée sur `makeWheel()` dans `index.html`), avec le même effet que le choix de la langue au premier lancement, plutôt qu'un menu déroulant natif `<select>`. Le champ qui ouvre la roue a la classe `fieldbtn`.
- **Couleurs des champs** : vert (classe `todo`) = champ à remplir ; rouge (classe `need`) = champ manquant après un essai d'enregistrement. Pas de rouge d'emblée.
- **Textes** : tout texte affiché passe par `i18n.js`, dans les 10 langues (tutoiement en français). Les petits détails de fonctionnement s'expliquent dans Réglages → « Comment ça marche ? ».
