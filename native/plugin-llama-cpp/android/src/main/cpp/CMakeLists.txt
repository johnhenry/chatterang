#
# Builds the single `.so` that `LlamaBridge` loads.
#
# llama.cpp is NOT vendored here. `tools/fetch-llama-cpp.sh` clones a pinned
# tag into a gitignored `.cache/` directory and `build.gradle` passes its path
# in as `LLAMA_CPP_DIR`, so this tree carries a pin rather than 168 MB of
# someone else's source. The same pin, the same clone and the same cache
# directory as `tools/build-llama-xcframework.sh` uses for iOS.
#
# ONLY THE CPU VARIANT IS BUILT. `LlamaBridge` names three — vulkan, opencl,
# cpu — and tries them in that order, which is the right runtime shape: a
# Vulkan-linked library on a device with a non-conformant driver crashes at
# `dlopen`, so each backend has to be its own file. But `-DGGML_VULKAN=ON`
# does not configure against this NDK:
#
#   CMake Error: Could not find a package configuration file provided by
#   "SPIRV-Headers" ... and glslangValidator is not on PATH
#
# That is a dependency chain (SPIRV-Headers, SPIRV-Tools, glslang) nobody has
# priced. Rather than ship a variant that has never been built, this file
# builds `chatterang-llama-cpu` alone and the runtime falls through to it —
# and `nativeHasVulkan` / `nativeHasOpenCl` / `nativeHasHexagon` ask the ggml
# backend registry what is actually present rather than answering from a
# constant, so they report false here without anyone having to assert it.

cmake_minimum_required(VERSION 3.22.1)
project(chatterang-llama CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED LLAMA_CPP_DIR OR NOT EXISTS "${LLAMA_CPP_DIR}/CMakeLists.txt")
    # Refuse rather than guess. A missing source tree caught here names the
    # one command that fixes it; caught later it is a wall of missing headers.
    message(FATAL_ERROR
        "llama.cpp sources not found at '${LLAMA_CPP_DIR}'.\n"
        "Run: ./native/plugin-llama-cpp/tools/fetch-llama-cpp.sh")
endif()

# Static llama/ggml linked into our one shared object, so the app ships a
# single self-contained `.so` per ABI and `System.loadLibrary` has nothing
# else to find.
set(BUILD_SHARED_LIBS      OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS      OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS      OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER     OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON     OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_MTMD       OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL             OFF CACHE BOOL "" FORCE)

# The NDK ships libomp, but ggml's OpenMP path has repeatedly mis-detected
# thread counts on Android and llama.cpp's own Android guidance turns it off.
# `n_threads` is set explicitly from Kotlin anyway.
set(GGML_OPENMP           OFF CACHE BOOL "" FORCE)

# Static libraries linked into a shared one must be position-independent.
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

add_subdirectory(${LLAMA_CPP_DIR} ${CMAKE_CURRENT_BINARY_DIR}/llama.cpp EXCLUDE_FROM_ALL)

add_library(chatterang-llama-cpu SHARED llama-jni.cpp)

target_compile_definitions(chatterang-llama-cpu PRIVATE
    # What this was BUILT AGAINST, reported alongside — never instead of —
    # the engine's own `llama_print_system_info()`. See `engineVersion`.
    CHATTERANG_LLAMA_TAG="${CHATTERANG_LLAMA_TAG}"

    # Whether multimodal is linked in, derived from the option set above rather
    # than written down twice. `supportsVision` in `llama-jni.cpp` answers from
    # a constant, which is correct only while this is 0; the JNI turns a 1 into
    # a compile error so that turning mtmd on cannot leave a vision-capable
    # build reporting `supportsVision: false` forever.
    CHATTERANG_MTMD=$<BOOL:${LLAMA_BUILD_MTMD}>)

target_link_libraries(chatterang-llama-cpu PRIVATE llama ggml android log)
