#!/usr/bin/env bash
# Rebuilds the map library shipped in app/src/main/assets/www/vendor/ from its source code, so that
# no pre-built code has to be trusted (needed for F-Droid):
#   - leaflet.js  : Leaflet, bundled with Rollup from src/ and minified with UglifyJS, exactly as its
#                   own "npm run build" does for a release
#   - leaflet.css : the library's style sheet (a source file, copied as is)
#   - LICENSE-leaflet.txt : its licence (BSD 2-Clause)
# The marker images of Leaflet are not used by Konso (its price labels are HTML), so they are not copied.
#
# Usage, from anywhere:
#   tools/build-leaflet.sh [--src DIR] [--work DIR] [--out DIR]
#   --src DIR   existing checkout of Leaflet at TAG (e.g. an F-Droid srclib)
#   --work DIR  where the source is cloned and built (default: build/leaflet)
#   --out DIR   where the files are written (default: the app's vendor folder)
# Without --src, the pinned tag is cloned from GitHub.
#
# Requires: git, Node.js 18+ with npm (npm downloads Leaflet's build tools: Rollup, UglifyJS).
set -euo pipefail

TAG=v1.9.4
RELEASE_YEAR=2023   # year of the v1.9.4 release, written in the copyright line of leaflet.js

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$ROOT/build/leaflet
OUT=$ROOT/app/src/main/assets/www/vendor
SRC=
while [ $# -gt 0 ]; do
  case $1 in
    --src) SRC=$(cd "$2" && pwd); shift 2 ;;
    --work) mkdir -p "$2"; WORK=$(cd "$2" && pwd); shift 2 ;;
    --out) mkdir -p "$2"; OUT=$(cd "$2" && pwd); shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$WORK" "$OUT"

step() { echo; echo "=== $* ==="; }

step "Checking tools"
for cmd in git node npm; do
  command -v "$cmd" >/dev/null || { echo "Missing tool: $cmd" >&2; exit 1; }
done
echo "node $(node --version), npm $(npm --version)"

step "Sources of Leaflet $TAG"
if [ -z "$SRC" ]; then
  SRC=$WORK/Leaflet
  [ -d "$SRC/.git" ] || git clone --depth 1 --branch "$TAG" https://github.com/Leaflet/Leaflet.git "$SRC"
fi
# Only built files are removed: dist/ also holds the style sheet and images, which are sources.
rm -f "$SRC"/dist/*.js "$SRC"/dist/*.js.map

step "Installing Leaflet's build tools (package-lock.json)"
# --ignore-scripts: the "prepare" script only installs git hooks for Leaflet's developers.
(cd "$SRC" && npm ci --ignore-scripts --no-audit --no-fund)

step "Building leaflet.js (npm run build: Rollup, then UglifyJS)"
# NODE_ENV=release: the banner gives the plain version ("1.9.4") instead of the git branch and
# commit, as for Leaflet's own releases (and the source then needs no .git folder).
(cd "$SRC" && NODE_ENV=release npm run build)
# The banner's copyright line ends with the year of the build; set it back to the release's year,
# so the file is byte-for-byte the one Leaflet published.
sed -i "3s/(c) 2010-[0-9]\{4\} /(c) 2010-$RELEASE_YEAR /" "$SRC/dist/leaflet.js"

step "Copying the files to $OUT"
cp "$SRC/dist/leaflet.js" "$OUT/leaflet.js"
cp "$SRC/dist/leaflet.css" "$OUT/leaflet.css"
cp "$SRC/LICENSE" "$OUT/LICENSE-leaflet.txt"
ls -l "$OUT/leaflet.js" "$OUT/leaflet.css" "$OUT/LICENSE-leaflet.txt"
sha256sum "$OUT/leaflet.js" "$OUT/leaflet.css"
