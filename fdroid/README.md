# F-Droid recipe

`app.konso.yml` is Konso's build recipe for [F-Droid](https://f-droid.org). It is the file to add to
[fdroiddata](https://gitlab.com/fdroid/fdroiddata) as `metadata/app.konso.yml`.

The **F-Droid check** workflow (`.github/workflows/fdroid-check.yml`, script `tools/fdroid-check.py`)
replays this recipe the way F-Droid's build server does, with F-Droid's own tool (fdroidserver):
`fdroid lint`, the Debian packages, the deleted files, the signing keys removed, the source scanner,
the build commands, `gradle assembleRelease`, then the APK scanner. If it is green, the recipe works.

## What the recipe does

F-Droid only ships what it builds from source. The recipe deletes the files of
`app/src/main/assets/www/vendor/` that are not source code, then gets them back from their source:

| File | How it is rebuilt |
|---|---|
| `tesseract-core-simd-lstm.wasm.js` | `tools/build-tesseract.sh`: Tesseract and its libraries compiled to WebAssembly (tesseract.js-core 7.0.0, Emscripten 4.0.15) |
| `tesseract.min.js`, `worker.min.js` | `tools/build-tesseract.sh`: tesseract.js 7.0.0 bundled with webpack |
| `leaflet.js` | `tools/build-leaflet.sh`: Leaflet 1.9.4 bundled with its own release build |
| `lang/fra.traineddata.gz.bin` | Downloaded and checked (SHA-256): the French language model, file `4.0.0_best_int/fra.traineddata.gz` of the npm package `@tesseract.js-data/fra` 1.0.0 (Tesseract's `tessdata_best` model converted to integers by the tesseract.js authors, Apache 2.0). It is data, not code. |

## New versions

Each release creates a `v<versionName>` tag. With `UpdateCheckMode: Tags ^v[0-9.]+$` and
`AutoUpdateMode: Version`, F-Droid finds the new tag, copies the last build entry and builds it:
nothing to do, as long as the build steps do not change. If they change (a new vendored library,
another tool), update this recipe here first, check that the F-Droid check workflow is green, then
send the same change to fdroiddata.

## Submitting

1. Fork [fdroiddata](https://gitlab.com/fdroid/fdroiddata) on GitLab.
2. Add `metadata/app.konso.yml` (a copy of this file) in a new branch.
3. Open a merge request ("New app: Konso"). F-Droid's CI builds the app; the reviewers check it.

Points to mention in the merge request: the vendored files are deleted and rebuilt (table above);
the network is off by default and, when the user turns it on in the Stations tab, only reaches
data.economie.gouv.fr (official open data on fuel prices) and tile.openstreetmap.org.

---

# Recette F-Droid

`app.konso.yml` est la recette de compilation de Konso pour [F-Droid](https://f-droid.org). C'est le
fichier à ajouter à [fdroiddata](https://gitlab.com/fdroid/fdroiddata), sous le nom
`metadata/app.konso.yml`.

Le workflow **F-Droid check** (`.github/workflows/fdroid-check.yml`, script `tools/fdroid-check.py`)
rejoue cette recette comme le serveur de compilation de F-Droid, avec l'outil de F-Droid lui-même
(fdroidserver) : `fdroid lint`, paquets Debian, fichiers supprimés, clés de signature retirées,
analyse du code source, commandes de compilation, `gradle assembleRelease`, puis analyse de l'APK.
S'il est vert, la recette fonctionne.

**Ce que fait la recette.** F-Droid ne distribue que ce qu'il compile depuis les sources. La recette
supprime les fichiers de `vendor/` qui ne sont pas du code source et les récupère depuis leurs
sources (voir le tableau ci-dessus). Le modèle de langue français est téléchargé et vérifié par son
empreinte SHA-256 : ce sont des données, pas du code (licence Apache 2.0).

**Nouvelles versions.** Chaque release crée un tag `v<versionName>` ; F-Droid le détecte et compile
la nouvelle version tout seul. Si les étapes de compilation changent (nouvelle bibliothèque
embarquée…), modifier d'abord cette recette ici, vérifier que le workflow F-Droid check est vert,
puis envoyer la même modification à fdroiddata.

**Déposer la demande.** Copier (fork) fdroiddata sur GitLab, ajouter `metadata/app.konso.yml` sur une
nouvelle branche, puis ouvrir une merge request « New app: Konso ».
