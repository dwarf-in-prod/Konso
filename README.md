# Konso

**Suivi de consommation de carburant et de dépenses d'entretien, pour Android.**
Simple, hors ligne, sans compte et sans publicité.

*English version below.*

---

## Fonctionnalités

| | |
|---|---|
| ⛽ **Pleins** | Distance, litres, montant → L/100 km, coût aux 100 km, prix au litre. |
| 📷 **Lecture de ticket** | Photo d'un ticket de caisse lue directement sur le téléphone (OCR Tesseract embarqué). Modèle optimisé pour les tickets français ; les valeurs lues restent à vérifier. |
| 🔧 **Achats** | Huile, pièces, pneus, entretien… classés par catégorie. |
| 📊 **Bilan** | Moyennes, courbe de consommation, dépenses par mois. |
| 🚗 **Plusieurs voitures** | Ajout, renommage, suppression, sélecteur rapide. |
| 💾 **Sauvegarde automatique** | Un fichier `konso.json` dans le dossier de votre choix (téléphone, ou Google Drive via le sélecteur de fichiers Android). |
| 🌍 **10 langues** | Français, anglais, espagnol, allemand, italien, portugais, néerlandais, polonais, turc, roumain. |
| 🎨 **Material Design 3** | Thème clair ou sombre selon le téléphone. |

## Vie privée

- Aucun compte, aucune publicité, aucune statistique d'usage.
- L'appli n'envoie rien sur internet. La permission réseau sert uniquement au serveur local interne (`127.0.0.1`) ; toute requête vers un autre hôte est bloquée.
- Vos données restent sur votre téléphone et dans le dossier de sauvegarde que vous choisissez.

## Installation

1. Téléchargez `konso.apk` depuis la page **Releases** du dépôt.
2. Ouvrez-le sur votre téléphone et autorisez l'installation d'applications de source inconnue.

Android 10 ou plus récent.

## Compilation

- **Android Studio** : ouvrir le dossier, puis *Build → Build APK(s)*.
- **Ligne de commande** (JDK 17 + SDK Android) :
  ```sh
  ./gradlew assembleDebug
  ```
- **GitHub Actions** : chaque push sur `main` compile l'APK (artefact `konso-apk`). Un lancement manuel du workflow, ou un commit dont le message contient `[release]`, publie l'APK dans la release `latest`.

## Développement

`main` ne reçoit que des fonctionnalités terminées et testées.

1. Chaque fonctionnalité ou correction se fait sur sa propre branche : `feature/<nom>` ou `fix/<nom>`.
2. Chaque push sur la branche compile un **APK de test**, publié dans la pré-release `test-<branche>` (les `/` deviennent des `-`), fichier `konso-test.apk`.
3. L'APK de test s'installe **à côté** de la vraie appli, sous le nom **Konso Test** (identifiant `app.konso.test`). Il utilise son propre fichier de sauvegarde, `konso-test.json` : les vraies données ne sont jamais touchées. Pour tester avec ses vraies données, copier `konso.json` en `konso-test.json` dans le dossier choisi.
4. Une fois validée, la branche est fusionnée dans `main` par pull request, puis supprimée. Sa pré-release de test est alors supprimée automatiquement.

En local : `./gradlew assembleDebug -PkonsoTest=essai` produit le même APK de test.

## Signature

L'APK est signé avec `app/debug.keystore`, une clé de test **publique** incluse dans le dépôt pour que les mises à jour s'installent par-dessus la version précédente. N'importe qui peut signer un APK avec cette clé : n'installez que des APK provenant d'une source de confiance, et utilisez votre propre clé secrète si vous redistribuez l'appli.

## Structure du projet

```
app/src/main/
├── assets/www/
│   ├── index.html      Interface
│   ├── i18n.js         Traductions
│   ├── parse.js        Analyse des tickets
│   └── vendor/         Tesseract.js et modèle de langue français
└── java/app/konso/
    └── MainActivity.java   WebView, serveur local, appareil photo, sauvegarde
```

## Licence

Konso est distribué sous licence **GNU GPL v3.0** — voir [`LICENSE`](LICENSE).

Composants tiers : [Tesseract.js](https://github.com/naptha/tesseract.js) et ses données de langue, sous licence Apache 2.0 (voir `app/src/main/assets/www/vendor/`).

---

## English

**Konso** is an Android app to track fuel consumption and car maintenance spending. Works fully offline, no account, no ads, no analytics.

**Features**
- **Fill-ups**: distance, litres, price → L/100 km, cost per 100 km, price per litre.
- **Receipt scanning**: on-device OCR (embedded Tesseract). Tuned for French receipts; always double-check the values.
- **Purchases**: oil, parts, tyres, servicing… sorted by category.
- **Overview**: averages, consumption chart, monthly spending.
- **Multiple cars.**
- **Automatic backup** to a `konso.json` file in a folder you pick (local storage, or Google Drive through the Android file picker).
- **10 languages**, Material Design 3, light/dark theme.

**Privacy** — Nothing is sent over the internet. The network permission is only used for the app's internal local server (`127.0.0.1`); any other host is blocked.

**Install** — Download `konso.apk` from the **Releases** page and allow installing apps from unknown sources. Requires Android 10+.

**Build** — JDK 17 + Android SDK: `./gradlew assembleDebug`, or open the folder in Android Studio.

**Development** — Every feature lives on its own branch (`feature/<name>`); `main` only gets finished work, merged through pull requests. Each push to a branch builds a test APK published in the `test-<branch>` pre-release. It installs side by side with the real app as "Konso Test" (`app.konso.test`) and uses its own `konso-test.json` backup file, so real data is never touched.

**Signing** — The APK is signed with a **public** test key (`app/debug.keystore`) so updates install over each other. Only install APKs from a trusted source, and use your own private key if you redistribute the app.

**License** — GNU GPL v3.0. Third-party: Tesseract.js and language data (Apache 2.0).
