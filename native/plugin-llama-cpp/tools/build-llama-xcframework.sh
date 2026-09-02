#!/usr/bin/env bash
#
# Builds the llama.cpp XCFramework that `Package.swift`'s `llama` binaryTarget
# points at. llama.cpp is NOT vendored into this repository: this script clones
# a pinned tag into a gitignored cache and builds from it, so the tree carries
# a pin (one line, below) rather than 168 MB of someone else's source.
#
#   ./native/plugin-llama-cpp/tools/build-llama-xcframework.sh [slice ...]
#
# Default slice is `ios-sim`, because the simulator is the only target that can
# be proven on a machine with no code-signing identity. Pass `ios-sim ios-device`
# for a build that also runs on hardware.
#
# WHY NOT THE PUBLISHED XCFRAMEWORK: llama.cpp ships `llama-<tag>-xcframework.zip`
# as a release asset, which would make this a `.binaryTarget(url:checksum:)` and
# no script at all. Its Info.plist lists exactly two slices — `macos-arm64_x86_64`
# and `ios-arm64`. There is no simulator slice, and `.binaryTarget(url:)` cannot
# be mixed per-slice. Measured against b10760.
#
# Cost, measured on an M-series Mac: ~1 m 30 s and ~1.8 GB of intermediates per
# slice. The shipped framework inside App.app is ~16 MB fat; dSYMs never ship.

set -euo pipefail

# The pin. Move this deliberately: LlamaContext.swift is written against this
# tag's llama.h, and that header drifts (b10760 removed `llama_model_params`'s
# `use_mmap`/`use_mlock` in favour of `load_mode`, and grew a leading `n_vocab`
# argument on `llama_sampler_init_penalties`).
LLAMA_TAG="b10760"
LLAMA_REPO="https://github.com/ggml-org/llama.cpp.git"

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${PLUGIN_DIR}/../.." && pwd)"
CACHE_DIR="${REPO_ROOT}/.cache/llama.cpp-${LLAMA_TAG}"
DEST="${PLUGIN_DIR}/ios/llama.xcframework"

SLICES=("$@")
if [ ${#SLICES[@]} -eq 0 ]; then
  SLICES=(ios-sim)
fi

if [ ! -d "${CACHE_DIR}" ]; then
  echo "==> cloning llama.cpp ${LLAMA_TAG} (shallow) into ${CACHE_DIR}"
  mkdir -p "$(dirname "${CACHE_DIR}")"
  git clone --depth 1 --branch "${LLAMA_TAG}" "${LLAMA_REPO}" "${CACHE_DIR}"
else
  echo "==> reusing cached clone at ${CACHE_DIR}"
fi

# Refuse rather than guess: a cache directory left at some other revision would
# build a framework whose headers do not match what LlamaContext.swift compiles
# against, and the mismatch would surface as a confusing link error much later.
ACTUAL_TAG="$(git -C "${CACHE_DIR}" describe --tags --exact-match 2>/dev/null || echo "<none>")"
if [ "${ACTUAL_TAG}" != "${LLAMA_TAG}" ]; then
  echo "error: ${CACHE_DIR} is at '${ACTUAL_TAG}', not the pinned '${LLAMA_TAG}'." >&2
  echo "       Delete it and re-run, or move the pin in this script." >&2
  exit 1
fi

echo "==> building slices: ${SLICES[*]}"
( cd "${CACHE_DIR}" && ./build-xcframework.sh "${SLICES[@]}" )

BUILT="${CACHE_DIR}/build-apple/llama.xcframework"
if [ ! -d "${BUILT}" ]; then
  echo "error: expected ${BUILT} to exist after the build; it does not." >&2
  exit 1
fi

echo "==> installing into ${DEST}"
rm -rf "${DEST}"
mkdir -p "$(dirname "${DEST}")"
cp -R "${BUILT}" "${DEST}"

# dSYMs are ~90% of the on-disk size and are never needed to build or run the
# app from this checkout.
find "${DEST}" -name '*.dSYM' -type d -prune -exec rm -rf {} +

echo "==> done. Slices present:"
/usr/libexec/PlistBuddy -c 'Print :AvailableLibraries' "${DEST}/Info.plist" 2>/dev/null \
  | grep -i 'LibraryIdentifier' || ls -1 "${DEST}"
