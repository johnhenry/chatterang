/*
 * JNI implementation of `LlamaBridge`'s `external fun`s.
 *
 * The Swift in `ios/Sources/LlamaCppPlugin/LlamaContext.swift` is the
 * reference for behaviour and `packages/inference-node/src/llama-cpp.ts` for
 * semantics; where this file departs from either, the comment says why. The
 * whole architecture depends on one adapter above these two platforms seeing
 * identical behaviour, so "the same, deliberately" is the default and every
 * difference is a decision.
 *
 * Written against llama.cpp b10760 — the tag `tools/fetch-llama-cpp.sh` pins.
 */

#include <jni.h>
#include <android/log.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "ggml-backend.h"
#include "llama.h"

#define LOG_TAG "chatterang-llama"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

/* ── Strings ───────────────────────────────────────────────────────────────
 *
 * NOT `GetStringUTFChars` / `NewStringUTF`. Those speak MODIFIED UTF-8, which
 * agrees with real UTF-8 only up to U+FFFF: a character outside the BMP — any
 * emoji, and plenty of CJK extensions — is one 4-byte sequence in UTF-8 and
 * two 3-byte surrogate halves in modified UTF-8. Handing `NewStringUTF` a real
 * UTF-8 emoji is undefined behaviour on ART, and `GetStringUTFChars` would
 * hand llama.cpp's tokenizer a byte sequence no vocabulary contains.
 *
 * So both directions go through UTF-16, which is what a `jstring` actually
 * holds, and the conversion is done here where it can be got right once.
 */

std::string utf16_to_utf8(const jchar *units, jsize count) {
    std::string out;
    out.reserve(static_cast<size_t>(count) * 3 / 2);
    for (jsize i = 0; i < count; ++i) {
        uint32_t code = units[i];
        if (code >= 0xD800 && code <= 0xDBFF && i + 1 < count) {
            const uint32_t low = units[i + 1];
            if (low >= 0xDC00 && low <= 0xDFFF) {
                code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                ++i;
            }
        }
        if (code < 0x80) {
            out.push_back(static_cast<char>(code));
        } else if (code < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (code >> 6)));
            out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
        } else if (code < 0x10000) {
            out.push_back(static_cast<char>(0xE0 | (code >> 12)));
            out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (code >> 18)));
            out.push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
        }
    }
    return out;
}

std::string to_string(JNIEnv *env, jstring value) {
    if (value == nullptr) return {};
    const jsize count = env->GetStringLength(value);
    const jchar *units = env->GetStringChars(value, nullptr);
    if (units == nullptr) return {};
    std::string out = utf16_to_utf8(units, count);
    env->ReleaseStringChars(value, units);
    return out;
}

jstring to_jstring(JNIEnv *env, const std::string &value) {
    std::vector<jchar> units;
    units.reserve(value.size());
    size_t i = 0;
    while (i < value.size()) {
        const auto lead = static_cast<unsigned char>(value[i]);
        uint32_t code;
        size_t width;
        if (lead < 0x80) {
            code = lead;
            width = 1;
        } else if ((lead & 0xE0) == 0xC0) {
            code = lead & 0x1Fu;
            width = 2;
        } else if ((lead & 0xF0) == 0xE0) {
            code = lead & 0x0Fu;
            width = 3;
        } else if ((lead & 0xF8) == 0xF0) {
            code = lead & 0x07u;
            width = 4;
        } else {
            // Not a lead byte. The bytes came from a tokenizer, not a person,
            // so a malformed one is a bug somewhere else — render it as
            // U+FFFD rather than dropping it silently.
            units.push_back(0xFFFD);
            ++i;
            continue;
        }
        if (i + width > value.size()) {
            units.push_back(0xFFFD);
            break;
        }
        for (size_t k = 1; k < width; ++k) {
            code = (code << 6) | (static_cast<unsigned char>(value[i + k]) & 0x3Fu);
        }
        i += width;
        if (code >= 0x10000) {
            code -= 0x10000;
            units.push_back(static_cast<jchar>(0xD800 + (code >> 10)));
            units.push_back(static_cast<jchar>(0xDC00 + (code & 0x3FF)));
        } else {
            units.push_back(static_cast<jchar>(code));
        }
    }
    return env->NewString(units.data(), static_cast<jsize>(units.size()));
}

void throw_java(JNIEnv *env, const char *message) {
    if (env->ExceptionCheck()) return;
    jclass clazz = env->FindClass("java/lang/IllegalStateException");
    if (clazz != nullptr) env->ThrowNew(clazz, message);
}

/*
 * Turns a failed by-name lookup into a rejection the Kotlin side can catch.
 *
 * `FindClass` and `GetMethodID` do not merely return null — they LEAVE A
 * PENDING EXCEPTION. Carrying on with one pending is not a survivable state:
 * the next JNI call is a fatal `JNI DETECTED ERROR IN APPLICATION` and ART
 * aborts the process, which is the same "kills the app instead of saying it
 * could not run" failure this plugin exists not to have.
 *
 * Measured, by emptying `android/proguard-rules.pro` and building the app with
 * `minifyEnabled true`: R8 renamed `TokenCallback.onToken`, the `GetMethodID`
 * for it returned null, and four lines later `to_string`'s `GetStringLength`
 * hit the pending `NoSuchMethodError` —
 *
 *   Abort message: 'JNI DETECTED ERROR IN APPLICATION: JNI GetStringLength
 *     called with pending exception java.lang.NoSuchMethodError: no non-static
 *     method "…LlamaCppPlugin$generate$1$result$2;.onToken(Ljava/lang/String;)Z"'
 *   Fatal signal 6 (SIGABRT) … pid 11221 (erang.inference)
 *
 * — with the harness dying mid-run and `adb shell pidof` empty. Clearing it
 * and throwing our own turns that into `LlamaCppPlugin.generate`'s
 * `catch (Throwable)`, which rejects and emits the terminal event.
 *
 * The rules make this unreachable. It is here because "unreachable" is a
 * property of a build-time config file that no build in this repo currently
 * exercises, and the cost of being wrong about it is a process abort.
 */
bool missing(JNIEnv *env, const void *resolved, const char *name) {
    if (resolved != nullptr) return false;
    env->ExceptionClear();
    LOGE("JNI could not resolve %s", name);
    const std::string message =
        std::string("On-device inference is unavailable in this build: the engine could not "
                    "find \"") +
        name +
        "\". Minification renamed it; see native/plugin-llama-cpp/android/proguard-rules.pro.";
    throw_java(env, message.c_str());
    return true;
}

/* ── Process-global backend ────────────────────────────────────────────────
 *
 * `llama_backend_init()` sets up the ggml backend registry shared by every
 * model in the process and is NOT reference-counted, so it is initialised
 * exactly once and never freed. The mistake this avoids is the one
 * `LlamaContext.swift` documents: calling `llama_backend_free()` from a
 * per-handle teardown tears the registry out from under every other handle
 * that is still loaded. `packages/inference-node` has the same shape.
 */
void ensure_backend() {
    static std::once_flag once;
    std::call_once(once, [] { llama_backend_init(); });
}

/* ── One loaded model ─────────────────────────────────────────────────── */

struct Session {
    llama_model *model = nullptr;
    llama_context *ctx = nullptr;
    const llama_vocab *vocab = nullptr;
    llama_batch batch{};
    int32_t threads = 4;
    int32_t context_length = 0;

    /* Tokens currently resident in the KV cache, in order. Compared against
     * the next prompt to find how much prefill can be skipped. */
    std::vector<llama_token> cached_tokens;

    /* Bytes of a multi-byte UTF-8 sequence that arrived split across tokens.
     * See `decode_piece`. */
    std::vector<uint8_t> pending;

    ~Session() {
        llama_batch_free(batch);
        if (ctx) llama_free(ctx);
        if (model) llama_model_free(model);
    }
};

Session *as_session(jlong handle) { return reinterpret_cast<Session *>(handle); }

/* ── Tokenisation ─────────────────────────────────────────────────────────
 *
 * `parse_special` is the load-bearing argument and it must be TRUE for a
 * prompt: `src/ai/prompt.ts` has already rendered the turn markers, and with
 * `false` every `<start_of_turn>` reaches the model as ordinary text. iOS
 * shipped `false` here and the bug was invisible until someone diffed the
 * token ids against `packages/inference-node`, which passes `true`
 * (`model.tokenize(prompt, true)`, llama-cpp.ts:573).
 */
std::vector<llama_token> tokenize(const Session *session, const std::string &text,
                                  bool add_special, bool parse_special) {
    if (session->vocab == nullptr || text.empty()) return {};
    // One token per byte is the floor; the slack covers BOS/EOS.
    const int32_t capacity = static_cast<int32_t>(text.size()) + 8;
    std::vector<llama_token> tokens(static_cast<size_t>(capacity));
    const int32_t count = llama_tokenize(session->vocab, text.data(),
                                         static_cast<int32_t>(text.size()), tokens.data(),
                                         capacity, add_special, parse_special);
    if (count <= 0) return {};
    tokens.resize(static_cast<size_t>(count));
    return tokens;
}

/** Raw bytes of one token. Deliberately NOT a string: see `decode_piece`. */
std::vector<uint8_t> bytes_of(const Session *session, llama_token token) {
    std::vector<char> buffer(64);
    int32_t length = llama_token_to_piece(session->vocab, token, buffer.data(),
                                          static_cast<int32_t>(buffer.size()), 0, false);
    if (length < 0) {
        // Negative is "buffer too small, and this is how much you need".
        // Treating it as an error silently swallows any token over 63 bytes.
        buffer.resize(static_cast<size_t>(-length));
        length = llama_token_to_piece(session->vocab, token, buffer.data(),
                                      static_cast<int32_t>(buffer.size()), 0, false);
    }
    if (length <= 0) return {};
    return {buffer.begin(), buffer.begin() + length};
}

/*
 * Token bytes → text, holding back a trailing partial UTF-8 sequence.
 *
 * A token is a byte sequence, not a character: BPE splits "é" (or an emoji, or
 * any CJK glyph) across two or three tokens. Converting each token
 * independently turns every one of those into U+FFFD, so the stream the user
 * watches is corrupt even though the final text would not be. Incomplete
 * trailing bytes are carried into the next call; `flush_decoder` drains
 * whatever is left when generation ends.
 */
std::string decode_piece(Session *session, const std::vector<uint8_t> &incoming) {
    session->pending.insert(session->pending.end(), incoming.begin(), incoming.end());

    // Walk back at most 3 bytes looking for the start of a sequence that is
    // not yet complete; UTF-8 continuation bytes are 0b10xxxxxx.
    size_t boundary = session->pending.size();
    int back = 0;
    while (back < 4 && boundary > 0) {
        const uint8_t lead = session->pending[boundary - 1];
        if ((lead & 0xC0) == 0x80) {
            boundary -= 1;
            back += 1;
            continue;
        }
        size_t expected;
        if ((lead & 0x80) == 0) expected = 1;
        else if ((lead & 0xE0) == 0xC0) expected = 2;
        else if ((lead & 0xF0) == 0xE0) expected = 3;
        else if ((lead & 0xF8) == 0xF0) expected = 4;
        else expected = 1; // Invalid lead; let the converter replace it.

        if (boundary - 1 + expected > session->pending.size()) {
            boundary -= 1; // The last sequence is short. Emit everything before it.
        } else {
            boundary = session->pending.size();
        }
        break;
    }

    if (boundary == 0) return {};
    std::string ready(session->pending.begin(), session->pending.begin() + boundary);
    session->pending.erase(session->pending.begin(),
                           session->pending.begin() + static_cast<long>(boundary));
    return ready;
}

std::string flush_decoder(Session *session) {
    if (session->pending.empty()) return {};
    std::string remainder(session->pending.begin(), session->pending.end());
    session->pending.clear();
    return remainder;
}

/* ── Batch helpers ────────────────────────────────────────────────────── */

void batch_clear(llama_batch &batch) { batch.n_tokens = 0; }

void batch_add(llama_batch &batch, llama_token token, llama_pos position, bool wants_logits) {
    const int index = batch.n_tokens;
    batch.token[index] = token;
    batch.pos[index] = position;
    batch.n_seq_id[index] = 1;
    batch.seq_id[index][0] = 0;
    batch.logits[index] = wants_logits ? 1 : 0;
    batch.n_tokens += 1;
}

constexpr int kBatchSize = 512;

/* ── Sampler ──────────────────────────────────────────────────────────── */

struct SamplerOptions {
    float temperature = 0.7f;
    float top_p = 0.95f;
    int32_t top_k = 40;
    float min_p = 0.05f;
    float repeat_penalty = 1.1f;
    int32_t repeat_last_n = 64;
    float frequency_penalty = 0.0f;
    float presence_penalty = 0.0f;
    int32_t max_tokens = 1024;
    uint32_t seed = LLAMA_DEFAULT_SEED;
};

/*
 * Returns nullptr on allocation failure. Passing a null chain on to
 * `llama_sampler_sample` dereferences it inside C — a crash with no message —
 * so callers turn this into a Java exception instead.
 *
 * API drift, b10760: `llama_sampler_init_penalties` grew a leading
 * `int32_t n_vocab`.
 */
llama_sampler *make_sampler_chain(const Session *session, const SamplerOptions &options) {
    llama_sampler_chain_params params = llama_sampler_chain_default_params();
    params.no_perf = true;
    llama_sampler *chain = llama_sampler_chain_init(params);
    if (chain == nullptr) return nullptr;

    llama_sampler_chain_add(chain, llama_sampler_init_penalties(
                                       llama_vocab_n_tokens(session->vocab),
                                       options.repeat_last_n, options.repeat_penalty,
                                       options.frequency_penalty, options.presence_penalty));
    llama_sampler_chain_add(chain, llama_sampler_init_top_k(options.top_k));
    llama_sampler_chain_add(chain, llama_sampler_init_top_p(options.top_p, 1));
    llama_sampler_chain_add(chain, llama_sampler_init_min_p(options.min_p, 1));
    llama_sampler_chain_add(chain, llama_sampler_init_temp(options.temperature));
    llama_sampler_chain_add(chain, llama_sampler_init_dist(options.seed));
    return chain;
}

size_t common_prefix_length(const std::vector<llama_token> &a, const std::vector<llama_token> &b) {
    const size_t limit = std::min(a.size(), b.size());
    size_t index = 0;
    while (index < limit && a[index] == b[index]) ++index;
    return index;
}

double seconds_since(const std::chrono::steady_clock::time_point &start) {
    const std::chrono::duration<double> elapsed = std::chrono::steady_clock::now() - start;
    return elapsed.count() < 0.001 ? 0.001 : elapsed.count();
}

/** True when the ggml backend registry actually carries a backend by name. */
bool backend_registered(const char *name) {
    for (size_t i = 0; i < ggml_backend_reg_count(); ++i) {
        ggml_backend_reg_t reg = ggml_backend_reg_get(i);
        if (reg == nullptr) continue;
        const char *registered = ggml_backend_reg_name(reg);
        if (registered != nullptr && std::strcmp(registered, name) == 0) return true;
    }
    return false;
}

/** `VmHWM` in kilobytes, or -1. The kernel's high-water mark for this process. */
long current_hwm_kb() {
    FILE *file = std::fopen("/proc/self/status", "r");
    if (file == nullptr) return -1;
    char line[256];
    long kilobytes = -1;
    while (std::fgets(line, sizeof(line), file) != nullptr) {
        if (std::strncmp(line, "VmHWM:", 6) == 0 &&
            std::sscanf(line + 6, "%ld", &kilobytes) == 1) {
            break;
        }
        kilobytes = -1;
    }
    std::fclose(file);
    return kilobytes;
}

/**
 * The largest `VmHWM` this process has ever been SEEN holding.
 *
 * A running maximum is not paranoia. `VmHWM` is documented as a high-water
 * mark, and on Android it is one only until the platform resets it — measured
 * on emulator-5554, sampling `/proc/<pid>/status` every two seconds through one
 * `prove-android.sh` run, the watermark fell three times inside a single
 * process, each time to whatever the resident size was at that moment:
 *
 *     14:28:45  VmHWM 671640 -> 664232 kB
 *     14:35:20  VmHWM 1200832 -> 920160 kB
 *     14:36:50  VmHWM 1307204 -> 923948 kB
 *
 * AOSP resets it after sampling RSS itself, which is exactly the write to
 * `/proc/<pid>/clear_refs` this file declines to make. So `VmHWM` alone is a
 * high-water mark since some other process last cleared it — better than the
 * instantaneous sample this used to report, and still not what
 * `peakMemoryBytes` promises. Keeping the maximum across every reading is what
 * makes the reported number monotone, and `memory.peakNeverFalls` in the
 * harness is what proves it on the device rather than here.
 *
 * What it can still miss: a spike that both rises and is cleared between two
 * readings. Readings happen at the end of every `generate` and every
 * `benchmark`, so what is covered is every interval the engine was working in.
 */
std::atomic<long> observed_peak_kb{0};

} // namespace

/* ── Exported ─────────────────────────────────────────────────────────────
 *
 * `LlamaBridge` is a Kotlin `object`, so its `external fun`s compile to
 * INSTANCE methods on the class — hence the `jobject` second parameter rather
 * than the `jclass` a `@JvmStatic` would produce.
 */

extern "C" {

JNIEXPORT jstring JNICALL
Java_app_chatterang_llama_LlamaBridge_engineVersion(JNIEnv *env, jobject) {
    ensure_backend();
    /*
     * The one field in `getCapabilities` that can serve as evidence the real
     * engine is present. `simulated: false` cannot: it is a boolean an
     * implementation sets, and a stub returning a plausible object sets it the
     * same way. Nor can `chipset` or `cpuCores`.
     *
     * `llama_print_system_info()` is different in kind — it is produced by the
     * engine, it enumerates the feature flags the binary was actually compiled
     * with (NEON, ARM_FMA, ...), and reaching it at all requires the `.so` to
     * have loaded and linked.
     *
     * The pinned tag is NOT part of the identity: it records what the build
     * intended, and a library swapped underneath would keep reporting it. So
     * the engine's own line stands alone and the intent is labelled as intent.
     */
    std::string reported = llama_print_system_info();
    while (!reported.empty() && (reported.back() == '\n' || reported.back() == ' ')) {
        reported.pop_back();
    }
    return to_jstring(env, "llama.cpp " + reported + " [built against " +
                               CHATTERANG_LLAMA_TAG + "]");
}

JNIEXPORT jlong JNICALL
Java_app_chatterang_llama_LlamaBridge_loadModel(JNIEnv *env, jobject, jstring model_path_,
                                                jstring mmproj_path_, jstring draft_model_path_,
                                                jint context_length, jint gpu_layers,
                                                jstring backend_, jint threads, jboolean use_mmap) {
    ensure_backend();

    // Unused, deliberately, and NOT silently: this build compiles neither
    // `mtmd` (vision) nor a draft path (speculative decoding), so accepting
    // these and behaving as if they worked would be exactly the kind of
    // fabricated capability this plugin is not allowed to ship.
    // `LlamaCppPlugin.load` warns the caller when either is supplied.
    (void) mmproj_path_;
    (void) draft_model_path_;
    // No GPU backend is compiled in either; `getCapabilities` reports `cpu`
    // alone and `LlamaCppPlugin.load` clamps the request before it gets here.
    (void) gpu_layers;
    (void) backend_;

    const std::string model_path = to_string(env, model_path_);

    llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = 0;
    // API drift, b10760: `use_mmap`/`use_mlock` were replaced by a single
    // `load_mode`. `NONE` is the honest translation of `use_mmap = false` —
    // not `AUTO`, which lets llama.cpp re-enable mmap behind a caller that
    // asked for it off.
    model_params.load_mode = use_mmap ? LLAMA_LOAD_MODE_MMAP : LLAMA_LOAD_MODE_NONE;

    llama_model *model = llama_model_load_from_file(model_path.c_str(), model_params);
    if (model == nullptr) {
        LOGE("llama_model_load_from_file failed for %s", model_path.c_str());
        return 0; // The Kotlin side turns 0 into a readable rejection.
    }

    auto *session = new Session();
    session->model = model;
    session->vocab = llama_model_get_vocab(model);
    session->threads = threads > 0 ? threads : 4;

    llama_context_params context_params = llama_context_default_params();
    context_params.n_ctx = static_cast<uint32_t>(context_length > 0 ? context_length : 4096);
    context_params.n_batch = kBatchSize;
    context_params.n_threads = session->threads;
    context_params.n_threads_batch = session->threads;

    session->ctx = llama_init_from_model(model, context_params);
    if (session->ctx == nullptr) {
        LOGE("llama_init_from_model failed (n_ctx=%u)", context_params.n_ctx);
        delete session; // Frees the model too.
        return 0;
    }

    // A shorter context is better than no model at all; `contextLength` below
    // reports what was actually granted so the caller can say so.
    session->context_length = static_cast<int32_t>(llama_n_ctx(session->ctx));
    session->batch = llama_batch_init(kBatchSize, 0, 1);

    return reinterpret_cast<jlong>(session);
}

JNIEXPORT void JNICALL
Java_app_chatterang_llama_LlamaBridge_freeModel(JNIEnv *, jobject, jlong handle) {
    // Innermost first, and nothing process-global — see `ensure_backend`.
    delete as_session(handle);
}

JNIEXPORT jint JNICALL
Java_app_chatterang_llama_LlamaBridge_contextLength(JNIEnv *, jobject, jlong handle) {
    Session *session = as_session(handle);
    return session == nullptr ? 0 : session->context_length;
}

JNIEXPORT jboolean JNICALL
Java_app_chatterang_llama_LlamaBridge_supportsVision(JNIEnv *, jobject, jlong) {
#if CHATTERANG_MTMD
#error "LLAMA_BUILD_MTMD is ON now, so supportsVision must ask the session whether it holds a projector instead of returning this constant."
#endif
    // A CONSTANT, and it ignores the handle it is given. That is the honest
    // answer for this build and only for this build: `LLAMA_BUILD_MTMD` is OFF
    // in `CMakeLists.txt`, so there is no projector to load, no session can
    // hold one, and reporting true would be a lie the UI repeats to the user.
    //
    // What it must not do is keep saying false after someone links mtmd in.
    // `CMakeLists.txt` passes the value of that option through as
    // `CHATTERANG_MTMD`, so the day the build gains multimodal support this
    // file stops compiling with the message above, rather than shipping a
    // vision-capable engine that swears it has no vision.
    return JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_app_chatterang_llama_LlamaBridge_chatTemplate(JNIEnv *env, jobject, jlong handle) {
    /*
     * A template NAME sniffed from the GGUF's embedded Jinja body.
     *
     * `llama_model_chat_template` hands back the template SOURCE, not a name,
     * and the contract's `chatTemplate` field is a name — so this matches on
     * the control markers that identify a family. It is a heuristic and says
     * nothing when it does not recognise one, which is why the caller's own
     * value stays the fallback in Kotlin.
     */
    Session *session = as_session(handle);
    if (session == nullptr || session->model == nullptr) return to_jstring(env, "");
    const char *raw = llama_model_chat_template(session->model, nullptr);
    if (raw == nullptr) return to_jstring(env, "");
    const std::string body = raw;
    if (body.empty()) return to_jstring(env, "");

    // Order matters: the more specific marker first. Gemma 4's canonical
    // template uses `<|turn>role` / `<turn|>`, NOT Gemma 2/3's
    // `<start_of_turn>` / `<end_of_turn>` pair.
    const std::pair<const char *, const char *> families[] = {
        {"<|turn>", "gemma4"},        {"<start_of_turn>", "gemma"},
        {"<|im_start|>", "chatml"},   {"<|start_header_id|>", "llama3"},
        {"[INST]", "mistral"},        {"<|user|>", "zephyr"},
        {"<|User|>", "deepseek"},
    };
    for (const auto &family : families) {
        if (body.find(family.first) != std::string::npos) return to_jstring(env, family.second);
    }
    return to_jstring(env, "");
}

JNIEXPORT jintArray JNICALL
Java_app_chatterang_llama_LlamaBridge_tokenize(JNIEnv *env, jobject, jlong handle, jstring text_) {
    Session *session = as_session(handle);
    if (session == nullptr) {
        throw_java(env, "No model is loaded for that handle.");
        return nullptr;
    }
    // `add_special` false and `parse_special` true: this is the contract's
    // `tokenize`, used for the context meter and for the template-marker
    // check, so a control marker must come back as the ONE token it is and
    // the vocabulary must not silently prepend a BOS the caller did not ask
    // for. `packages/inference-node` does the same.
    const std::vector<llama_token> tokens = tokenize(session, to_string(env, text_), false, true);

    jintArray out = env->NewIntArray(static_cast<jsize>(tokens.size()));
    if (out == nullptr) return nullptr;
    if (!tokens.empty()) {
        static_assert(sizeof(jint) == sizeof(llama_token), "llama_token must be a 32-bit int");
        env->SetIntArrayRegion(out, 0, static_cast<jsize>(tokens.size()),
                               reinterpret_cast<const jint *>(tokens.data()));
    }
    return out;
}

JNIEXPORT jobject JNICALL
Java_app_chatterang_llama_LlamaBridge_generate(JNIEnv *env, jobject, jlong handle, jstring prompt_,
                                               jobjectArray images, jfloat temperature, jfloat top_p,
                                               jint top_k, jfloat min_p, jfloat repeat_penalty,
                                               jint repeat_last_n, jfloat frequency_penalty,
                                               jfloat presence_penalty, jint max_tokens, jint seed,
                                               jobjectArray stop_sequences, jint draft_tokens,
                                               jobject callback) {
    Session *session = as_session(handle);
    if (session == nullptr) {
        throw_java(env, "No model is loaded for that handle.");
        return nullptr;
    }
    (void) draft_tokens; // No draft model is loaded; see `loadModel`.

    SamplerOptions options;
    options.temperature = temperature;
    options.top_p = top_p;
    options.top_k = top_k;
    options.min_p = min_p;
    options.repeat_penalty = repeat_penalty;
    options.repeat_last_n = repeat_last_n;
    options.frequency_penalty = frequency_penalty;
    options.presence_penalty = presence_penalty;
    options.max_tokens = max_tokens;
    if (seed >= 0) options.seed = static_cast<uint32_t>(seed);

    std::vector<std::string> stops;
    if (stop_sequences != nullptr) {
        const jsize count = env->GetArrayLength(stop_sequences);
        for (jsize i = 0; i < count; ++i) {
            auto item = static_cast<jstring>(env->GetObjectArrayElement(stop_sequences, i));
            std::string value = to_string(env, item);
            if (!value.empty()) stops.push_back(std::move(value));
            env->DeleteLocalRef(item);
        }
    }
    const jsize image_count = images == nullptr ? 0 : env->GetArrayLength(images);

    jclass callback_class = callback == nullptr ? nullptr : env->GetObjectClass(callback);
    jmethodID on_token = callback_class == nullptr
                             ? nullptr
                             : env->GetMethodID(callback_class, "onToken", "(Ljava/lang/String;)Z");
    // A null callback is legal — it just means nobody wants the stream. A
    // callback whose `onToken` cannot be resolved is not: see `missing`.
    if (callback != nullptr && missing(env, on_token, "LlamaBridge$TokenCallback.onToken")) {
        return nullptr;
    }

    /* `add_special: true` lets the vocabulary prepend its own BOS — none of
     * the templates in `src/ai/prompt.ts` emit one, and a Gemma-family model
     * that never sees BOS degrades quietly. `parse_special: true` because the
     * prompt is already rendered and its markers must become control tokens. */
    const std::vector<llama_token> prompt_tokens =
        tokenize(session, to_string(env, prompt_), true, true);
    // Each generation decodes its own stream; nothing carries over from the
    // last one's trailing bytes.
    session->pending.clear();

    jclass result_class = env->FindClass("app/chatterang/llama/LlamaBridge$GenerateResult");
    if (missing(env, result_class, "app/chatterang/llama/LlamaBridge$GenerateResult")) {
        return nullptr;
    }
    jmethodID result_init =
        env->GetMethodID(result_class, "<init>", "(Ljava/lang/String;IIILjava/lang/String;D)V");
    if (missing(env, result_init, "LlamaBridge$GenerateResult.<init>")) return nullptr;
    // Negative means "not measured", which is different from 0% and must not
    // be reported as it. Nothing here measures speculative decoding.
    constexpr jdouble kDraftNotMeasured = -1.0;

    if (prompt_tokens.empty()) {
        return env->NewObject(result_class, result_init, to_jstring(env, ""), 0, 0, 0,
                              to_jstring(env, "stop"), kDraftNotMeasured);
    }

    llama_memory_t memory = llama_get_memory(session->ctx);

    /*
     * Reuse the KV cache across turns.
     *
     * A conversation's prompt grows by append: turn N's prompt is turn N-1's
     * plus two more messages. Re-processing the shared prefix every turn makes
     * prefill grow quadratically — the single largest avoidable cost here.
     *
     * The correctness condition is that the cache must be truncated to
     * EXACTLY the matching prefix; keeping one token too many produces subtly
     * wrong output, which is far worse than being slow.
     */
    size_t reused = common_prefix_length(session->cached_tokens, prompt_tokens);
    // Never reuse the entire prompt: at least one token must be decoded to
    // produce logits to sample from.
    if (reused == prompt_tokens.size()) reused -= 1;
    // An image is evaluated into the cache as opaque embeddings the token
    // comparison cannot see, so a prompt carrying images starts clean.
    if (image_count > 0) reused = 0;

    if (reused > 0) {
        llama_memory_seq_rm(memory, 0, static_cast<llama_pos>(reused), -1);
    } else {
        llama_memory_clear(memory, true);
    }

    auto cursor = static_cast<llama_pos>(reused);
    for (size_t chunk = reused; chunk < prompt_tokens.size(); chunk += kBatchSize) {
        const size_t end = std::min(chunk + kBatchSize, prompt_tokens.size());
        batch_clear(session->batch);
        for (size_t index = chunk; index < end; ++index) {
            batch_add(session->batch, prompt_tokens[index], cursor,
                      index == prompt_tokens.size() - 1);
            cursor += 1;
        }
        if (llama_decode(session->ctx, session->batch) != 0) {
            // A failed decode leaves the cache in an unknown state. Forget it
            // rather than reuse something inconsistent.
            session->cached_tokens.clear();
            llama_memory_clear(memory, true);
            throw_java(env, "The device ran out of memory while reading the prompt.");
            return nullptr;
        }
    }

    session->cached_tokens = prompt_tokens;

    llama_sampler *chain = make_sampler_chain(session, options);
    if (chain == nullptr) {
        throw_java(env, "The device ran out of memory while preparing to generate.");
        return nullptr;
    }

    std::string text;
    int completion_tokens = 0;
    std::string stop_reason = "stop";
    bool stop_requested = false;

    while (completion_tokens < options.max_tokens) {
        if (stop_requested) {
            stop_reason = "cancelled";
            break;
        }

        const llama_token token = llama_sampler_sample(chain, session->ctx, -1);
        if (llama_vocab_is_eog(session->vocab, token)) {
            stop_reason = "stop";
            break;
        }
        llama_sampler_accept(chain, token);

        const std::string chunk = decode_piece(session, bytes_of(session, token));
        text += chunk;
        completion_tokens += 1;
        // The sampled token is now part of the cache's contents, so the next
        // turn's prefix match can include the model's own reply.
        session->cached_tokens.push_back(token);

        // A token whose bytes are still held back for the next one produces no
        // text; emitting an empty event would make the stream's `index` count
        // steps rather than pieces.
        if (!chunk.empty() && on_token != nullptr) {
            jstring piece = to_jstring(env, chunk);
            const jboolean keep_going = env->CallBooleanMethod(callback, on_token, piece);
            env->DeleteLocalRef(piece);
            if (env->ExceptionCheck()) {
                llama_sampler_free(chain);
                return nullptr;
            }
            // Returning false asks this loop to stop — cheaper than polling a
            // flag from C++, and it is how `cancel` reaches here.
            if (keep_going == JNI_FALSE) stop_requested = true;
        }

        // Stop sequences are checked on the accumulated text rather than per
        // token, because a sequence can straddle a token boundary.
        bool matched_stop = false;
        for (const std::string &stop : stops) {
            if (text.size() >= stop.size() &&
                text.compare(text.size() - stop.size(), stop.size(), stop) == 0) {
                text.resize(text.size() - stop.size());
                stop_reason = "stop-sequence";
                matched_stop = true;
                break;
            }
        }
        if (matched_stop) break;

        // Checked BEFORE the next decode: reaching the cap means no further
        // token will be sampled, so evaluating this one is work thrown away.
        if (completion_tokens >= options.max_tokens) {
            stop_reason = "length";
            break;
        }

        batch_clear(session->batch);
        batch_add(session->batch, token, cursor, true);
        cursor += 1;
        if (llama_decode(session->ctx, session->batch) != 0) {
            llama_sampler_free(chain);
            throw_java(env, "The device ran out of memory while generating.");
            return nullptr;
        }
    }

    llama_sampler_free(chain);

    // Bytes of a character the model stopped in the middle of.
    const std::string tail = flush_decoder(session);
    if (!tail.empty()) {
        text += tail;
        if (on_token != nullptr) {
            jstring piece = to_jstring(env, tail);
            env->CallBooleanMethod(callback, on_token, piece);
            env->DeleteLocalRef(piece);
            if (env->ExceptionCheck()) return nullptr;
        }
    }

    return env->NewObject(result_class, result_init, to_jstring(env, text),
                          static_cast<jint>(prompt_tokens.size()), static_cast<jint>(reused),
                          static_cast<jint>(completion_tokens), to_jstring(env, stop_reason),
                          kDraftNotMeasured);
}

JNIEXPORT jobject JNICALL
Java_app_chatterang_llama_LlamaBridge_benchmark(JNIEnv *env, jobject, jlong handle,
                                                jint prompt_tokens, jint generate_tokens) {
    Session *session = as_session(handle);
    if (session == nullptr) {
        throw_java(env, "No model is loaded for that handle.");
        return nullptr;
    }

    // Benchmarks measure COLD prefill. A warm cache would report a throughput
    // this device cannot sustain on a fresh prompt.
    llama_memory_clear(llama_get_memory(session->ctx), true);
    session->cached_tokens.clear();
    session->pending.clear();

    // A synthetic prompt of the requested length: the point is to measure this
    // device, not this prompt. Plain filler, so no BOS and no control markers
    // to parse — matching `packages/inference-node`'s `model.tokenize(filler, false)`.
    std::string filler;
    const int repeats = std::max(1, prompt_tokens / 9);
    for (int i = 0; i < repeats; ++i) filler += "the quick brown fox jumps over the lazy dog. ";
    std::vector<llama_token> tokens = tokenize(session, filler, false, false);
    const auto wanted = static_cast<size_t>(std::max(2, prompt_tokens));
    if (tokens.size() > wanted) tokens.resize(wanted);
    if (tokens.empty()) {
        throw_java(env, "The benchmark prompt could not be tokenized.");
        return nullptr;
    }

    const auto prefill_start = std::chrono::steady_clock::now();
    llama_pos cursor = 0;
    for (size_t chunk = 0; chunk < tokens.size(); chunk += kBatchSize) {
        const size_t end = std::min(chunk + kBatchSize, tokens.size());
        batch_clear(session->batch);
        for (size_t index = chunk; index < end; ++index) {
            batch_add(session->batch, tokens[index], cursor, index == tokens.size() - 1);
            cursor += 1;
        }
        if (llama_decode(session->ctx, session->batch) != 0) {
            throw_java(env, "The device ran out of memory during the benchmark.");
            return nullptr;
        }
    }
    const double prefill_seconds = seconds_since(prefill_start);

    SamplerOptions options;
    options.max_tokens = generate_tokens;
    llama_sampler *chain = make_sampler_chain(session, options);
    if (chain == nullptr) {
        throw_java(env, "The device ran out of memory while preparing the benchmark.");
        return nullptr;
    }

    const auto decode_start = std::chrono::steady_clock::now();
    int produced = 0;
    while (produced < generate_tokens) {
        const llama_token token = llama_sampler_sample(chain, session->ctx, -1);
        llama_sampler_accept(chain, token);
        batch_clear(session->batch);
        batch_add(session->batch, token, cursor, true);
        cursor += 1;
        if (llama_decode(session->ctx, session->batch) != 0) break;
        produced += 1;
    }
    const double decode_seconds = seconds_since(decode_start);
    llama_sampler_free(chain);

    // The benchmark left the cache full of filler. Leaving it would make the
    // NEXT generate's prefix match against text nobody asked for.
    llama_memory_clear(llama_get_memory(session->ctx), true);
    session->cached_tokens.clear();

    jclass clazz = env->FindClass("app/chatterang/llama/LlamaBridge$BenchmarkResult");
    if (missing(env, clazz, "app/chatterang/llama/LlamaBridge$BenchmarkResult")) return nullptr;
    jmethodID init = env->GetMethodID(clazz, "<init>", "(DD)V");
    if (missing(env, init, "LlamaBridge$BenchmarkResult.<init>")) return nullptr;
    return env->NewObject(clazz, init, static_cast<jdouble>(tokens.size()) / prefill_seconds,
                          static_cast<jdouble>(produced) / decode_seconds);
}

JNIEXPORT jlong JNICALL
Java_app_chatterang_llama_LlamaBridge_peakFootprint(JNIEnv *, jobject) {
    // The largest resident set this process has been observed holding, which
    // is what the contract field `peakMemoryBytes` is named for.
    //
    // Two things had to be true for that name to be earned, and only the
    // second one is obvious.
    //
    // 1. Read a watermark, not a sample. This used to read `/proc/self/statm`
    //    field 2 — the resident page count RIGHT NOW. `unload` hands ~400 MB
    //    of mapped GGUF straight back to the kernel, so the reading after it
    //    came back BELOW the reading before it, under a name that promises it
    //    cannot. `VmHWM` in `/proc/self/status` is the kernel's own watermark.
    //
    // 2. Keep our own maximum over those watermarks, because on Android
    //    `VmHWM` gets RESET — see `observed_peak_kb` above for the three
    //    resets measured inside one run. Reading `VmHWM` alone still failed
    //    `memory.peakNeverFalls` on the device: 1338576896 bytes while both
    //    models were resident, then 946122752 after unloading one.
    //
    // Process-wide and process-LIFETIME, deliberately and documented as such:
    // it covers the WebView and everything else in this app, and it is not
    // scoped to one request, so it is an upper bound on any single request
    // rather than that request's own peak. Scoping it would mean writing to
    // `/proc/self/clear_refs`, the same process-global side effect that makes
    // the kernel's own number unreliable here.
    //
    // `Runtime.totalMemory()` would have been the easy answer and the wrong
    // one: it measures the Java heap, and every byte of a GGUF is mapped
    // outside it.
    const long kilobytes = current_hwm_kb();
    long seen = observed_peak_kb.load(std::memory_order_relaxed);
    while (kilobytes > seen &&
           !observed_peak_kb.compare_exchange_weak(seen, kilobytes, std::memory_order_relaxed)) {
        // `compare_exchange_weak` reloads `seen` on failure; the condition is
        // rechecked because another thread may have raised it past ours.
    }
    return static_cast<jlong>(observed_peak_kb.load(std::memory_order_relaxed)) * 1024;
}

JNIEXPORT jboolean JNICALL
Java_app_chatterang_llama_LlamaBridge_nativeHasCpu(JNIEnv *, jobject) {
    // The one entry of `backends` that used to be a literal. Kotlin opened the
    // list with an unconditional `add("cpu")`, so a stub that had loaded no
    // engine at all produced the same first element as a working one — the
    // single element of that list carrying no information. It is now the same
    // registry question as the other three, and it is a question this build
    // can actually answer wrong: nothing else in the process registers a
    // backend called "CPU".
    ensure_backend();
    return backend_registered("CPU") ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_app_chatterang_llama_LlamaBridge_nativeHasVulkan(JNIEnv *, jobject) {
    // Asked of the ggml backend registry, not answered from a constant: this
    // build compiles no Vulkan backend, so the registry has none and this is
    // false — but it is false because it was MEASURED, and it becomes true on
    // its own the day `CMakeLists.txt` grows a Vulkan variant.
    ensure_backend();
    return backend_registered("Vulkan") ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_app_chatterang_llama_LlamaBridge_nativeHasOpenCl(JNIEnv *, jobject) {
    ensure_backend();
    return backend_registered("OpenCL") ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_app_chatterang_llama_LlamaBridge_nativeHasHexagon(JNIEnv *, jobject) {
    ensure_backend();
    return backend_registered("HTP") || backend_registered("Hexagon") ? JNI_TRUE : JNI_FALSE;
}

} // extern "C"
