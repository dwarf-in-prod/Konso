# Konso — consignes de travail

- **Ne jamais committer directement sur `main`.** Chaque fonctionnalité ou correction se fait sur une nouvelle branche `feature/<nom-court>` ou `fix/<nom-court>`, créée depuis `main` à jour, puis poussée sur GitHub.
- Chaque push sur une branche compile un APK de test « Konso Test » (`app.konso.test`), publié dans la pré-release `test-<branche>` (les `/` deviennent des `-`), fichier `konso-test.apk`. Après un push, attendre la fin du workflow « Compiler l'APK » et donner à l'utilisateur le lien direct de l'APK : `https://github.com/<propriétaire>/Konso/releases/download/test-<branche>/konso-test.apk`.
- La fusion dans `main` se fait par pull request, seulement après validation de l'APK de test par l'utilisateur.
- Avant une vraie release : augmenter `versionCode` et `versionName` dans `app/build.gradle`. La release `latest` est publiée par un lancement manuel du workflow sur `main`, ou par un commit sur `main` dont le message contient `[release]`.
- Dépôt public : aucune information personnelle (nom, pseudo, e-mail, modèle de voiture…) dans le code, les commits, les messages ou les releases.
- Pas de SDK Android dans l'environnement cloud : la compilation se vérifie via GitHub Actions.
