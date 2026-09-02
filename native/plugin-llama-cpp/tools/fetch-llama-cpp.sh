#!/usr/bin/env bash
#
# Ensures the pinned llama.cpp source tree exists in the gitignored cache that
# BOTH platforms build from.
#
#   ./native/plugin-llama-cpp/tools/fetch-llama-cpp.sh
#
# llama.cpp is neither vendored nor submoduled: the repository carries a tag
# (one line, below) and this script materialises it. `src/main/cpp/
# CMakeLists.txt` `add_subdirectory`s the result, and
# `build-llama-xcframework.sh` builds the iOS XCFramework from the same clone.
#
# Prints the directory on stdout so a caller can capture it.
set -euo pipefail

# The pin. Keep it identical to `build-llama-xcframework.sh`'s `LLAMA_TAG`:
# `llama-jni.cpp` and `LlamaContext.swift` are written against this tag's
# `llama.h`, and that header drifts (b10760 replaced `llama_model_params`'s
# `use_mmap`/`use_mlock` with `load_mode`, and grew a leading `n_vocab`
# argument on `llama_sampler_init_penalties`).
LLAMA_TAG="b10760"
LLAMA_REPO="https://github.com/ggml-org/llama.cpp.git"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CACHE_DIR="${REPO_ROOT}/.cache/llama.cpp-${LLAMA_TAG}"

if [ ! -d "${CACHE_DIR}" ]; then
  echo "==> cloning llama.cpp ${LLAMA_TAG} (shallow) into ${CACHE_DIR}" >&2
  mkdir -p "$(dirname "${CACHE_DIR}")"
  git clone --depth 1 --branch "${LLAMA_TAG}" "${LLAMA_REPO}" "${CACHE_DIR}" >&2
fi

# Refuse rather than guess: a cache left at some other revision would build
# against headers the sources here were not written for, and the mismatch
# surfaces much later as a confusing link error.
ACTUAL_TAG="$(git -C "${CACHE_DIR}" describe --tags --exact-match 2>/dev/null || echo "<none>")"
if [ "${ACTUAL_TAG}" != "${LLAMA_TAG}" ]; then
  echo "error: ${CACHE_DIR} is at '${ACTUAL_TAG}', not the pinned '${LLAMA_TAG}'." >&2
  echo "       Delete it and re-run, or move the pin in this script." >&2
  exit 1
fi

echo "${CACHE_DIR}"
