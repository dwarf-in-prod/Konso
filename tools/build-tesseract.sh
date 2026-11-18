#!/usr/bin/env bash
# Rebuilds the OCR engine shipped in app/src/main/assets/www/vendor/ from its source code,
# so that no pre-compiled code has to be trusted (needed for F-Droid):
#   - tesseract-core-simd-lstm.wasm.js : Tesseract + Leptonica compiled to WebAssembly (tesseract.js-core)
#   - tesseract.min.js, worker.min.js  : the JavaScript wrapper (tesseract.js), bundled with webpack
# The language model (vendor/lang/fra.traineddata.gz.bin) is data, not code: it is not rebuilt.
#
# Usage, from anywhere:
#   tools/build-tesseract.sh [--core-src DIR] [--js-src DIR] [--work DIR] [--out DIR]
#   --core-src DIR  existing checkout of tesseract.js-core at CORE_TAG (e.g. an F-Droid srclib)
#   --js-src DIR    existing checkout of tesseract.js at JS_TAG
#   --work DIR      where sources are cloned and built (default: build/tesseract)
#   --out DIR       where the three files are written (default: the app's vendor folder)
# Without --core-src / --js-src, the pinned tags are cloned from GitHub.
#
# Requires: git, cmake, make, autoconf, automake, libtool, pkg-config, Node.js 18+ with npm,
# and Emscripten (emcc) in PATH, ideally version EM_VERSION (the one upstream used for this release).
set -euo pipefail

CORE_TAG=v7.0.0
JS_TAG=v7.0.0
EM_VERSION=4.0.15
CORE_FILE=tesseract-core-simd-lstm.wasm.js   # SIMD build, LSTM engine only (oem 1, as used by app.js)

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$ROOT/build/tesseract
OUT=$ROOT/app/src/main/assets/www/vendor
CORE=
JS=
while [ $# -gt 0 ]; do
  case $1 in
    --core-src) CORE=$(cd "$2" && pwd); shift 2 ;;
    --js-src) JS=$(cd "$2" && pwd); shift 2 ;;
    --work) mkdir -p "$2"; WORK=$(cd "$2" && pwd); shift 2 ;;
    --out) mkdir -p "$2"; OUT=$(cd "$2" && pwd); shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$WORK"

step() { echo; echo "=== $* ==="; }

step "Checking tools"
for cmd in git cmake make autoconf automake libtoolize pkg-config node npm emcc; do
  command -v "$cmd" >/dev/null || { echo "Missing tool: $cmd" >&2; exit 1; }
done
EM_FOUND=$(emcc --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
echo "emcc $EM_FOUND (upstream used $EM_VERSION)"
[ "$EM_FOUND" = "$EM_VERSION" ] || echo "WARNING: different Emscripten version, the output will differ from upstream."

# The upstream build scripts expect an emsdk layout ($EMSDK/upstream/emscripten).
# With a system Emscripten (e.g. the Debian package), point a small shim at it.
if [ -z "${EMSDK:-}" ]; then
  EM_ROOT=$(dirname "$(readlink -f "$(command -v emcc)")")
  mkdir -p "$WORK/emsdk-shim/upstream/bin"
  ln -sfn "$EM_ROOT" "$WORK/emsdk-shim/upstream/emscripten"
  export EMSDK=$WORK/emsdk-shim
fi
echo "EMSDK=$EMSDK"
# CMake 4 refuses projects declaring cmake_minimum_required < 3.5 (zlib, libpng… at these commits).
export CMAKE_POLICY_VERSION_MINIMUM=3.5

# ---------------------------------------------------------------- tesseract.js-core
step "Sources of tesseract.js-core $CORE_TAG"
if [ -z "$CORE" ]; then
  CORE=$WORK/tesseract.js-core
  [ -d "$CORE/.git" ] || git clone --depth 1 --branch "$CORE_TAG" https://github.com/naptha/tesseract.js-core.git "$CORE"
fi
git -C "$CORE" submodule update --init --depth 1
# The upstream repository also contains its own pre-built files: remove them, they are rebuilt below.
rm -f "$CORE"/tesseract-core*.js "$CORE"/tesseract-core*.wasm

step "Building the libraries (zlib, libtiff, openlibm, giflib, libpng, libjpeg, libwebp, leptonica)"
for lib in zlib libtiff openlibm giflib libpng libjpeg libwebp leptonica; do
  echo "--- $lib"
  (cd "$CORE" && bash "build-scripts/build-$lib.sh")
done

step "Building Tesseract ($CORE_FILE)"
(
  cd "$CORE"
  # shellcheck disable=SC1091
  source build-scripts/var.sh
  [ "$PROC" -ge 1 ] || PROC=1
  cd third_party/tesseract
  rm -rf build && mkdir build && cd build
  # Same options as upstream build-tesseract.sh, for the single variant the app uses.
  $CMAKE_CMD .. -DCMAKE_CXX_FLAGS="$OPTIM_FLAGS" \
    -DCMAKE_PREFIX_PATH="$BUILD_DIR" -DLeptonica_DIR=../leptonica/build \
    -DOPENMP_BUILD=OFF -DBUILD_TRAINING_TOOLS=OFF -DGRAPHICS_DISABLED=ON \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN_FILE" -DWASM_BUILD=ON \
    -DHAVE_SSE4_1=1 -DHAVE_AVX=0 -DHAVE_AVX2=0 -DDISABLED_LEGACY_ENGINE=1
  $MAKE_CMD -j"$PROC"
)
cp "$CORE/third_party/tesseract/build/bin/$CORE_FILE" "$OUT/$CORE_FILE"

# ---------------------------------------------------------------- tesseract.js
step "Sources of tesseract.js $JS_TAG"
if [ -z "$JS" ]; then
  JS=$WORK/tesseract.js
  [ -d "$JS/.git" ] || git clone --depth 1 --branch "$JS_TAG" https://github.com/naptha/tesseract.js.git "$JS"
fi

step "Bundling tesseract.min.js and worker.min.js"
(
  cd "$JS"
  npm ci --ignore-scripts --no-audit --no-fund
  # The npm package of tesseract.js-core holds pre-built WebAssembly. The browser bundles never
  # include it (the core is loaded at run time from corePath), so remove it to prove it is unused.
  rm -rf node_modules/tesseract.js-core
  rm -rf dist
  npx webpack --config scripts/webpack.config.prod.js
)
cp "$JS/dist/tesseract.min.js" "$JS/dist/worker.min.js" "$OUT/"

step "Done"
(cd "$OUT" && sha256sum "$CORE_FILE" tesseract.min.js worker.min.js)
