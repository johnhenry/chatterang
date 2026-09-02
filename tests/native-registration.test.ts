import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards on the iOS llama.cpp plugin's PACKAGING, not on its code.
 *
 * These exist because of a measured failure that no compiler catches and no
 * other test in this suite can see.
 *
 * A Capacitor plugin is registered by being a discovered PACKAGE. Compiling
 * the plugin class into the app does nothing on its own. The registration is
 * three facts that live in three different files, none of which is imported by
 * anything, so every one of them can be deleted without breaking typecheck,
 * the web build, or any other test here.
 *
 * The failure mode was measured on the iPhone 17 Pro simulator by deleting the
 * `capacitor` key below and rebuilding. What happened is worse than an error:
 *
 *   - `cap sync ios` reported "Found 6 Capacitor plugins" instead of 7,
 *     without naming what it dropped.
 *   - `llama.framework` silently left `App.app/Frameworks`.
 *   - `LlamaCpp.getCapabilities()` then threw `Unimplemented` — NOT a fall back
 *     to the web shim. `@capacitor/core`'s `registerPlugin` only reaches its
 *     `web` implementation when the platform is `web` or when a custom
 *     platform is registered; on a real native platform with no plugin header
 *     it throws `"LlamaCpp.getCapabilities()" is not implemented on ios`
 *     (node_modules/@capacitor/core/dist/index.cjs.js, the throw at the end of
 *     `createPluginMethodWrapper`).
 *   - `src/state/app.ts` catches that with `.catch(() => null)`, so `device`
 *     became null, the backend chip vanished from the rail, and the onboarding
 *     recommendation quietly dropped from a 3.1 GB vision model to the 60.3 MB
 *     "smallest model available".
 *
 * So the app kept running, showed no banner, reported no warning, and simply
 * became a less capable app. That is the whole reason these assertions are
 * worth their weight: the thing they protect fails silently and plausibly.
 */

const ROOT = resolve(process.cwd());
const PLUGIN_DIR = resolve(ROOT, 'native/plugin-llama-cpp');

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

const PLUGIN_PACKAGE = readJson(resolve(PLUGIN_DIR, 'package.json'));
const ROOT_PACKAGE = readJson(resolve(ROOT, 'package.json'));
const PACKAGE_SWIFT = readFileSync(resolve(PLUGIN_DIR, 'Package.swift'), 'utf8');
const PLUGIN_NAME = '@chatterang/plugin-llama-cpp';

/**
 * The Capacitor CLI derives the SPM package name and the library PRODUCT name
 * from the npm name, and writes the derived name into the generated
 * `ios/App/CapApp-SPM/Package.swift`. Stated as the rule rather than as a
 * magic string, so this test explains the constraint instead of restating it:
 *
 *   `@capacitor/haptics`            -> CapacitorHaptics
 *   `@chatterang/plugin-llama-cpp`  -> ChatterangPluginLlamaCpp
 */
const spmNameFor = (npmName: string): string =>
  npmName
    .replace(/^@/, '')
    .split(/[/-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

describe('the llama.cpp plugin is discoverable by `cap sync`', () => {
  it('derives ChatterangPluginLlamaCpp from the npm name', () => {
    // Guards the derivation itself, so the two assertions below cannot both
    // drift together into agreeing on a wrong name.
    expect(spmNameFor('@capacitor/haptics')).toBe('CapacitorHaptics');
    expect(spmNameFor(PLUGIN_NAME)).toBe('ChatterangPluginLlamaCpp');
  });

  it('declares the capacitor key that makes cap sync see it at all', () => {
    // Deleting this key is the exact fault that produced `device: null`.
    expect(PLUGIN_PACKAGE.capacitor).toEqual({
      ios: { src: 'ios' },
      android: { src: 'android' },
    });
  });

  it('is a dependency of the app, by path', () => {
    const deps = ROOT_PACKAGE.dependencies as Record<string, string>;
    // `cap sync` enumerates plugins from the app's own dependencies. A plugin
    // package that exists in the tree but is not depended upon is not found.
    expect(deps[PLUGIN_NAME]).toBe('file:./native/plugin-llama-cpp');
  });

  it('names its SPM package and library product exactly as the CLI expects', () => {
    const expected = spmNameFor(PLUGIN_NAME);
    // Measured: naming the product anything else makes SPM refuse to resolve —
    // "product 'ChatterangPluginLlamaCpp' required by package 'capapp-spm'
    // target 'CapApp-SPM' not found in package 'ChatterangPluginLlamaCpp'".
    expect(PACKAGE_SWIFT).toMatch(new RegExp(`name:\\s*"${expected}"[\\s\\S]*products:`));
    expect(PACKAGE_SWIFT).toMatch(new RegExp(`\\.library\\(\\s*name:\\s*"${expected}"`));
  });

  it('pins iOS 15, which is the deployment target Capacitor generates', () => {
    // Capacitor's generated CapApp-SPM/Package.swift pins `.iOS(.v15)` and is
    // headed "DO NOT MODIFY THIS FILE - managed by Capacitor CLI". Declaring
    // `.iOS(.v16)` here is rejected outright: "requires minimum platform
    // version 16.0 ... but this target supports 15.0".
    expect(PACKAGE_SWIFT).toMatch(/platforms:\s*\[\.iOS\(\.v15\)\]/);
  });
});

describe('engineVersion can still carry evidence', () => {
  const SOURCE = readFileSync(
    resolve(PLUGIN_DIR, 'ios/Sources/LlamaCppPlugin/LlamaContext.swift'),
    'utf8',
  );

  it('does not truncate llama_print_system_info() away', () => {
    // The shipped source read:
    //
    //   "llama.cpp \(String(cString: llama_print_system_info()).prefix(0))b-chatterang"
    //
    // `.prefix(0)` is the empty string, so the ONLY engine-identifying field in
    // getCapabilities collapsed to the compile-time constant
    // "llama.cpp b-chatterang" — a value a plugin that loaded no library at all
    // would report just as readily.
    //
    // This matters more than it looks. `simulated: false` cannot serve as
    // proof: it is a boolean an implementation sets. Neither can `chipset`,
    // `cpuCores` or `totalMemory` — on a simulator those read the host Mac's
    // values (measured: chipset "arm64", 10 cores, 32 GB). The system-info
    // string is the one field the ENGINE produces.
    expect(SOURCE).toContain('llama_print_system_info()');
    expect(SOURCE).not.toMatch(/llama_print_system_info\(\)\s*\)?\s*\.prefix\(\s*0\s*\)/);
  });

  it('keeps the pinned tag distinct from what the engine reports', () => {
    // The tag is a source constant and is documented as proving nothing. The
    // guard is that it never becomes the WHOLE of engineVersion.
    expect(SOURCE).toMatch(/static let pinnedTag = "b\d+"/);
  });
});

describe('llama.cpp is pinned, not copied into the tree', () => {
  it('tracks only our own sources under native/', () => {
    const tracked = execFileSync('git', ['ls-files', 'native'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

    // The build script clones a pinned tag into a gitignored `.cache/` and
    // builds the XCFramework from it. Neither the clone nor the 16 MB artefact
    // may ever become tracked content.
    //
    // Our OWN native sources are the exception, and they are listed by exact
    // path rather than by pattern. The Android JNI shim is a C++ file we wrote
    // and must track; a blanket `.cpp` ban rejected it, which is how this guard
    // read a legitimate 1-file shim as vendored llama.cpp. Naming the
    // allowance keeps the guard's real job intact: anything else with these
    // extensions still fails, so a future `git add` of the clone is caught.
    const OURS = ['native/plugin-llama-cpp/android/src/main/cpp/llama-jni.cpp'];

    const foreign = tracked.filter(
      (path) =>
        !OURS.includes(path) &&
        (path.includes('llama.xcframework') || /\.(c|cpp|h|hpp|metal)$/.test(path)),
    );
    expect(foreign).toEqual([]);

    // The allowance is not a hole: every path in it must actually exist, or a
    // renamed file would silently widen the guard.
    for (const path of OURS) expect(tracked).toContain(path);
  });

  it('anchors the generated artefacts in .gitignore', () => {
    const ignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');
    // Anchored, in the style the rest of the file uses: an unanchored `models/`
    // once silently untracked four UI source files.
    expect(ignore).toMatch(/^\/\.cache\/$/m);
    expect(ignore).toMatch(/^\/native\/plugin-llama-cpp\/ios\/llama\.xcframework\/$/m);
  });
});

/**
 * Guards on the two Swift invariants that a compiler cannot see and that the
 * only real check for — running a model on a simulator — is not something
 * `npm test` can do.
 *
 * Both were measured on the iPhone 17 Pro simulator against
 * gemma-4-12B-it-QAT-Q4_0 via `native/plugin-llama-cpp/tools/prove-ios.sh`,
 * which is the actual proof; these are the regression fence around it. They
 * are string assertions on source, so they can only catch the specific shape
 * coming back — which is precisely the value, because both bugs were
 * *plausible* code that read fine.
 */
describe('the engine wrapper does not tear down process-global state', () => {
  const SOURCE = readFileSync(
    resolve(PLUGIN_DIR, 'ios/Sources/LlamaCppPlugin/LlamaContext.swift'),
    'utf8',
  );

  it('never calls llama_backend_free()', () => {
    // `llama_backend_free()` frees the ggml backend registry for the WHOLE
    // PROCESS and is not reference-counted, so calling it from a per-handle
    // `free()` — which `deinit` also calls — tore the backend out from under
    // every other loaded handle. `packages/inference-node` has the shape to
    // copy: dispose sequence -> context -> model per handle, touch nothing
    // global.
    //
    // Measured by `prove-ios.sh`: two handles loaded, the first unloaded, then
    // a generate on the second, which now answers instead of dying.
    const calls = SOURCE.split('\n').filter(
      (line) => /llama_backend_free\s*\(/.test(line) && !line.trimStart().startsWith('///'),
    );
    expect(calls).toEqual([]);
  });

  it('initialises the backend once for the process, not once per handle', () => {
    expect(SOURCE).toMatch(/static let backendReady[\s\S]{0,200}llama_backend_init\(\)/);
  });

  it('makes free() idempotent, because deinit calls it after unload does', () => {
    // Without the guard `llama_batch_free` runs twice on one allocation.
    expect(SOURCE).toMatch(/guard !released else \{ return \}/);
  });

  it('tokenizes the prompt with parse_special on', () => {
    // With parse_special off, a prompt already rendered by `src/ai/prompt.ts`
    // reaches the model with its turn markers as ordinary text. Measured:
    // `<|turn>` tokenized to 1 token (id 105) with it on, and
    // `<start_of_turn>` to 7 with it off — and the 7-token version made the
    // model answer "Australia's capital city of Australia's capital city of"
    // instead of "Canberra".
    expect(SOURCE).toMatch(/tokenize\(prompt, addSpecial: true, parseSpecial: true\)/);
  });
});

describe('generate always emits exactly one terminal event', () => {
  const SOURCE = readFileSync(
    resolve(PLUGIN_DIR, 'ios/Sources/LlamaCppPlugin/LlamaCppPlugin.swift'),
    'utf8',
  );
  const GENERATE = SOURCE.slice(
    SOURCE.indexOf('@objc func generate'),
    SOURCE.indexOf('@objc func cancel'),
  );

  it('has the idempotent finish() that packages/inference-node has', () => {
    expect(GENERATE).toMatch(/var settled = false/);
    expect(GENERATE).toMatch(/if !settled \{[\s\S]{0,120}notifyListeners\("llamaEnd"/);
  });

  it('backstops the guarantee in a defer, so a new early return cannot break it', () => {
    expect(GENERATE).toMatch(/defer \{[\s\S]{0,400}finish\("error"/);
  });

  it('finishes before rejecting an unknown handle', () => {
    // This was the measured hang: the guard called `call.reject` and returned
    // while `src/ai/backends/llama-cpp.ts` was still awaiting `llamaEnd`.
    // Fault-injected back in and re-run: the harness reported 0 llamaEnd
    // events for that request and exited 1.
    const guard = GENERATE.slice(GENERATE.indexOf('guard let context else'));
    const finishAt = guard.indexOf('finish("error"');
    const rejectAt = guard.indexOf('call.reject');
    expect(finishAt).toBeGreaterThanOrEqual(0);
    expect(rejectAt).toBeGreaterThan(finishAt);
  });

  it('reports cachedTokens, which the Kotlin plugin already did', () => {
    // The number that makes a cache-reuse regression visible rather than
    // merely slow. `LlamaContext.Result` always computed it; iOS dropped it.
    // Measured: 21 of 22 prompt tokens served from cache on an identical
    // re-ask — one short of the match, because a token must be re-evaluated
    // to produce logits to sample from.
    expect(GENERATE).toMatch(/"cachedTokens": cachedTokens/);
  });

  it('passes templateMarkers through to the engine', () => {
    // `src/ai/backends/llama-cpp.ts` has always sent these; iOS dropped them,
    // so the one layer that can tokenize a marker never got to say the
    // template was wrong. Measured: the warning fires on this model for
    // `<start_of_turn>` and is silent for `<|turn>`.
    expect(SOURCE).toMatch(/templateMarkers: \(call\.getArray\("templateMarkers"\)/);
  });
});

/**
 * ── The Android half ──────────────────────────────────────────────────────
 *
 * Everything above reads Swift. Until now nothing read the Kotlin or the JNI,
 * so the crash fix that defines this milestone — a plugin that refuses instead
 * of killing the app — had no regression test of any kind. A refactor putting
 * `throw UnsatisfiedLinkError` back into `LlamaBridge`'s init would be caught
 * only by someone with an emulator.
 *
 * Every fence below stands over a bug that has ALREADY been made once, here or
 * on iOS. They are string assertions on source, which is a weak instrument —
 * but it is the only one `npm test` has for a file it cannot compile, and the
 * measurement that actually matters is `tools/prove-android.sh` on a device.
 * These keep its result from silently expiring.
 *
 * Each one was fault-injected — the guarded thing broken, the test watched go
 * red, the source restored — because a fence that has never failed is a guess.
 */

const ANDROID = resolve(PLUGIN_DIR, 'android');
const BRIDGE_KT = readFileSync(
  resolve(ANDROID, 'src/main/java/app/chatterang/llama/LlamaBridge.kt'),
  'utf8',
);
const PLUGIN_KT = readFileSync(
  resolve(ANDROID, 'src/main/java/app/chatterang/llama/LlamaCppPlugin.kt'),
  'utf8',
);
const JNI = readFileSync(resolve(ANDROID, 'src/main/cpp/llama-jni.cpp'), 'utf8');

/**
 * Lines with the comment markers stripped out.
 *
 * Every "this must not appear" assertion below needs this: each of these
 * sources DOCUMENTS the mistake it avoids, by name, in prose. A raw
 * `.not.toContain('llama_backend_free')` would fail on the comment explaining
 * why `llama_backend_free` is never called — and "fix" it by deleting the
 * explanation.
 */
const codeLines = (source: string): string[] => {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    out.push(raw);
  }
  return out;
};

const BRIDGE_CODE = codeLines(BRIDGE_KT).join('\n');
const PLUGIN_CODE = codeLines(PLUGIN_KT).join('\n');
const JNI_CODE = codeLines(JNI).join('\n');

describe('the Android bridge never throws where nothing can catch it', () => {
  it('has no throw at all in LlamaBridge, because its init is a <clinit>', () => {
    // `LlamaBridge` is a Kotlin `object`: the first touch of ANY member runs
    // `<clinit>`, and that used to load the backend and throw
    // `UnsatisfiedLinkError` when no variant was present. Capacitor's
    // `Bridge.callPluginMethod` wraps whatever escapes a plugin method in a
    // `RuntimeException` and rethrows it on a `HandlerThread`, so the very
    // first `getCapabilities` killed the process (f5c7c24).
    //
    // The load result is data now — `loadFailure` — and the whole file's
    // contract is that nothing in it throws. Asserting that as "no `throw`
    // anywhere" rather than "no `throw` in `init`" is deliberate: a helper
    // that throws is just as fatal once `init` calls it.
    const throws = BRIDGE_CODE.split('\n').filter((line) => /\bthrow\b/.test(line));
    expect(throws).toEqual([]);
  });

  it('records the load failure as a string instead of raising it', () => {
    expect(BRIDGE_CODE).toMatch(/val loadFailure: String\?/);
    expect(BRIDGE_CODE).toMatch(/catch \(error: UnsatisfiedLinkError\)/);
  });
});

describe('no plugin method reaches the native library unguarded', () => {
  /**
   * The residual crash the verify phase found, and the reason this block
   * exists.
   *
   * `LlamaBridge.loadFailure` answers one question — did any `.so` dlopen —
   * and f5c7c24 made every method check it. But a library that LOADS while
   * missing a symbol passes that gate and then throws `UnsatisfiedLinkError`
   * at the call site. `getCapabilities` was the one method calling into
   * native on Capacitor's own handler thread with nothing around it.
   *
   * Measured, by renaming `Java_app_chatterang_llama_LlamaBridge_engineVersion`
   * in `llama-jni.cpp` and rebuilding: the `.so` still built and still loaded,
   * `loadFailure` was still null, and `prove-android.sh` exited 1 with zero
   * `[PROVE]` lines, `adb shell pidof` empty, and
   *
   *   FATAL EXCEPTION: CapacitorPlugins
   *   Caused by: java.lang.UnsatisfiedLinkError: No implementation found for
   *     java.lang.String app.chatterang.llama.LlamaBridge.engineVersion()
   *     at app.chatterang.llama.LlamaCppPlugin.getCapabilities(LlamaCppPlugin.kt:86)
   *
   * With the guard, the identical injection exits 0, the app is still running,
   * and `getCapabilities` refuses with the message this test names below.
   */
  const methods = (): { name: string; body: string }[] => {
    const out: { name: string; body: string }[] = [];
    const marker = /@PluginMethod\s+fun (\w+)\(call: PluginCall\) \{/g;
    for (let m = marker.exec(PLUGIN_CODE); m; m = marker.exec(PLUGIN_CODE)) {
      const start = m.index + m[0].length;
      const next = PLUGIN_CODE.indexOf('@PluginMethod', start);
      out.push({ name: m[1]!, body: PLUGIN_CODE.slice(start, next < 0 ? undefined : next) });
    }
    return out;
  };

  it('finds all ten plugin methods, so the sweep below cannot pass by finding none', () => {
    expect(methods().map((m) => m.name).sort()).toEqual([
      'benchmark',
      'cancel',
      'countTokens',
      'generate',
      'getCapabilities',
      'getThermalState',
      'listLoaded',
      'load',
      'tokenize',
      'unload',
    ]);
  });

  it('touches LlamaBridge only after a guard, in every one of them', () => {
    // The things that make a native call survivable, and the only things: the
    // worker thread's `executor.execute` (whose body is always wrapped),
    // `withHandle`, which is `executor.execute { rejectOnThrow(call) { … } }`,
    // `rejectOnThrow` itself for a call that must stay on this thread, and a
    // hand-written `try` — but only one that catches `Throwable`, because the
    // failures worth catching here are all `Error`s and `catch (Exception)`
    // lets every one of them through.
    const TOKENS = ['executor.execute {', 'withHandle(call)', 'rejectOnThrow(call)'];
    const guardsIn = (body: string): number[] => {
      const found = TOKENS.map((g) => body.indexOf(g)).filter((i) => i >= 0);
      for (const t of body.matchAll(/try \{/g)) {
        if (body.slice(t.index!, t.index! + 400).includes('catch (error: Throwable)')) {
          found.push(t.index!);
        }
      }
      return found.sort((a, b) => a - b);
    };

    for (const method of methods()) {
      const guardAt = guardsIn(method.body)[0];

      const uses = [...method.body.matchAll(/LlamaBridge\.\w+/g)];
      for (const use of uses) {
        expect(
          guardAt !== undefined && use.index! > guardAt,
          `${method.name} reaches ${use[0]} outside a guard — that is a process kill, ` +
            `not a rejected promise`,
        ).toBe(true);
      }
    }
  });

  it('turns a broken native surface into ENGINE_UNAVAILABLE, not a crash', () => {
    // `Throwable`, not `Exception`: the whole family worth catching here —
    // `UnsatisfiedLinkError`, `NoSuchMethodError`, `NoSuchFieldError`,
    // `ExceptionInInitializerError` — are `Error`s, and `catch (Exception)`
    // lets every one of them through.
    expect(PLUGIN_CODE).toMatch(
      /inline fun rejectOnThrow\(call: PluginCall, body: \(\) -> Unit\) \{[\s\S]{0,200}catch \(error: Throwable\)/,
    );
    expect(PLUGIN_CODE).toMatch(
      /fun rejectThrown\([\s\S]{0,200}if \(error is LinkageError\)[\s\S]{0,120}ENGINE_UNAVAILABLE/,
    );
  });

  it('guards the <clinit> read itself, not just the calls after it', () => {
    // Reading `LlamaBridge.loadFailure` is what RUNS `<clinit>`. Doing it
    // outside the guard puts the one failure f5c7c24 was about back on the
    // unprotected side of the line.
    expect(PLUGIN_CODE).toMatch(
      /fun rejectIfUnavailable\(call: PluginCall\): Boolean \{[\s\S]{0,400}try \{\s*LlamaBridge\.loadFailure/,
    );
  });

  it('does not let teardown kill the app either', () => {
    const destroy = PLUGIN_CODE.slice(PLUGIN_CODE.indexOf('override fun handleOnDestroy()'));
    // Two escape routes, neither with a `PluginCall` to reject to. Anything
    // thrown inside a plain `Executor`'s runnable goes to the thread's default
    // uncaught handler, which is a process kill; and `execute` on an executor
    // that is already shut down throws `RejectedExecutionException` on the
    // MAIN thread, inside `onDestroy`.
    expect(destroy).toMatch(/catch \(error: Throwable\)/);
    expect(destroy).toMatch(/catch \(error: RejectedExecutionException\)/);
    // The handles are dropped whether or not freeing them worked.
    expect(destroy).toMatch(/finally \{[\s\S]{0,120}contexts\.clear\(\)/);
  });
});

describe('Android generate always emits exactly one terminal event', () => {
  const GENERATE = PLUGIN_CODE.slice(
    PLUGIN_CODE.indexOf('fun generate(call: PluginCall)'),
    PLUGIN_CODE.indexOf('fun cancel(call: PluginCall)'),
  );

  it('has the idempotent finish() that packages/inference-node and iOS have', () => {
    expect(GENERATE).toMatch(/var settled = false/);
    expect(GENERATE).toMatch(/if \(!settled\) \{[\s\S]{0,120}notifyListeners\("llamaEnd"/);
  });

  it('backstops the guarantee in a finally, so a new early return cannot break it', () => {
    expect(GENERATE).toMatch(/finally \{[\s\S]{0,400}finish\(/);
  });

  it('emits the terminal event BEFORE rejecting, in refuse()', () => {
    // The zero-terminal-event bug, found during Prove and identical in shape
    // to the iOS one above: `src/ai/backends/llama-cpp.ts` resolves its stream
    // on `llamaEnd`, so a rejection without one leaves the promise rejected
    // and the stream open forever — a spinner with no way back.
    const refuse = GENERATE.slice(GENERATE.indexOf('fun refuse(message: String)'));
    const notifyAt = refuse.indexOf('notifyListeners("llamaEnd"');
    const rejectAt = refuse.indexOf('call.reject');
    expect(notifyAt).toBeGreaterThanOrEqual(0);
    expect(rejectAt).toBeGreaterThan(notifyAt);
  });

  it('routes every early exit after refuse() exists through refuse(), never call.reject', () => {
    // The ordering above is worthless if an early return skips `refuse`
    // entirely. Once a requestId exists, EVERY exit owes it one `llamaEnd`,
    // and the prologue — everything between `refuse`'s definition and the
    // handoff to the worker — is where that is easiest to break.
    const prologue = GENERATE.slice(
      GENERATE.indexOf('fun refuse(message: String)'),
      GENERATE.indexOf('executor.execute {'),
    );
    expect(prologue.length).toBeGreaterThan(0);
    // `refuse`'s own body ends with the one legitimate `call.reject`. After
    // it, every exit belongs to the contract and must go through `refuse`.
    const own = prologue.indexOf('call.reject(message, payload)');
    expect(own).toBeGreaterThanOrEqual(0);
    const afterRefuse = prologue.slice(own + 'call.reject(message, payload)'.length);
    expect(afterRefuse).not.toContain('call.reject');
    // The three refusals a requestId can hit before the worker starts:
    // no engine, missing arguments, unknown handle.
    expect([...afterRefuse.matchAll(/^\s+refuse\(/gm)].length).toBeGreaterThanOrEqual(3);
  });
});

describe('the JNI tokenizes and tears down the way the reference does', () => {
  it('passes parse_special through to llama_tokenize rather than hardcoding it', () => {
    expect(JNI_CODE).toMatch(/capacity, add_special, parse_special\)/);
  });

  it('renders an already-templated prompt with add_special AND parse_special on', () => {
    // The bug iOS shipped. With `parse_special` off, a prompt already rendered
    // by `src/ai/prompt.ts` reaches the model with its turn markers as
    // ordinary text: measured on iOS, `<start_of_turn>` became 7 tokens and
    // the model answered "Australia's capital city of Australia's capital city
    // of" instead of "Canberra". `packages/inference-node` passes `true`
    // (`model.tokenize(prompt, true)`), and the Android tokenizer was diffed
    // against it id-for-id on emulator-5554: 6/6 strings, 0 mismatches, both
    // ChatML markers single ids 151644/151645.
    expect(JNI_CODE).toMatch(/tokenize\(session, to_string\(env, prompt_\), true, true\)/);
  });

  it('exposes the contract tokenize as add_special OFF, parse_special ON', () => {
    // Different from the prompt path on purpose: this one feeds the context
    // meter and the template-marker check, so a marker must come back as the
    // ONE token it is and no BOS may be prepended behind the caller.
    expect(JNI_CODE).toMatch(/tokenize\(session, to_string\(env, text_\), false, true\)/);
  });

  it('never calls llama_backend_free()', () => {
    // Process-global and not reference-counted: calling it from a per-handle
    // teardown tears the ggml registry out from under every other loaded
    // handle. iOS shipped exactly that and it is fenced above; this is the
    // same fence on the C++, where the only mention is in a comment saying so.
    const calls = JNI_CODE.split('\n').filter((line) => /llama_backend_free\s*\(/.test(line));
    expect(calls).toEqual([]);
  });

  it('initialises the backend once per process, not once per handle', () => {
    expect(JNI_CODE).toMatch(/std::call_once\(once, \[\] \{ llama_backend_init\(\); \}\)/);
  });

  it('clears the pending exception after every failed by-name lookup', () => {
    /*
     * A second process kill, one layer below the Kotlin one, found by the R8
     * injection below and fixed with it.
     *
     * `FindClass` and `GetMethodID` do not merely return null — they leave a
     * PENDING EXCEPTION, and the next JNI call with one pending is a fatal
     * `JNI DETECTED ERROR IN APPLICATION`. The old code did
     * `if (result_class == nullptr) return nullptr;` for two of them and did
     * not check `on_token` at all. Measured, with `proguard-rules.pro`
     * emptied and `minifyEnabled true`:
     *
     *   Abort message: 'JNI DETECTED ERROR IN APPLICATION: JNI GetStringLength
     *     called with pending exception java.lang.NoSuchMethodError: … onToken'
     *   Fatal signal 6 (SIGABRT) in tid 11312 (chatterang-llam)
     *
     * `missing()` clears it and throws a readable `IllegalStateException`
     * instead, which `LlamaCppPlugin.generate`'s `catch (Throwable)` turns
     * into a rejection with its terminal event.
     */
    expect(JNI_CODE).toMatch(/bool missing\(JNIEnv \*env[\s\S]{0,200}env->ExceptionClear\(\)/);

    const lines = JNI_CODE.split('\n');
    const lookups = lines
      .map((line, i) => ({ line, i }))
      // `throw_java`'s own `FindClass("java/lang/IllegalStateException")` is
      // the platform's and cannot be renamed; everything else is ours.
      .filter(
        ({ line }) =>
          (/env->FindClass\(/.test(line) && !line.includes('"java/lang/')) ||
          /env->GetMethodID\(/.test(line),
      );
    // Guards the sweep against passing by finding nothing.
    expect(lookups.length).toBeGreaterThanOrEqual(5);
    for (let k = 0; k < lookups.length; k += 1) {
      const { line, i } = lookups[k]!;
      // Stop at the NEXT lookup, not at a fixed offset. Fault-injected with a
      // fixed 5-line window and it passed: reverting one guard to
      // `if (x == nullptr) return nullptr;` still found the FOLLOWING
      // lookup's `missing(` inside the window. Each guard must belong to its
      // own lookup.
      const end = Math.min(lookups[k + 1]?.i ?? lines.length, i + 6);
      const window = lines.slice(i, end).join('\n');
      expect(window, `unchecked by-name lookup: ${line.trim()}`).toContain('missing(env,');
    }
  });
});

describe('Android engineVersion can still carry evidence', () => {
  const BODY = JNI.slice(
    JNI.indexOf('Java_app_chatterang_llama_LlamaBridge_engineVersion'),
    JNI.indexOf('Java_app_chatterang_llama_LlamaBridge_loadModel'),
  );

  it('returns what the engine reported, not a compile-time constant', () => {
    // The exact guard that existed for Swift and not for C++. iOS shipped
    // `...llama_print_system_info()).prefix(0)` — the empty string — which
    // collapsed the one engine-identifying field in `getCapabilities` to
    // "llama.cpp b-chatterang", a value a plugin that loaded no library at all
    // would report just as readily. `simulated: false` cannot serve as proof;
    // neither can `chipset` or `cpuCores`.
    expect(BODY).toMatch(/std::string reported = llama_print_system_info\(\);/);
    expect(BODY).toMatch(/to_jstring\(env, "llama\.cpp " \+ reported \+/);
    // `pop_back` in the trailing-whitespace trim is fine. Emptying it is not.
    expect(BODY).not.toMatch(/reported\s*\.\s*(substr|resize|clear|assign)\s*\(/);
  });

  it('keeps the pinned tag labelled as intent, distinct from the measurement', () => {
    // The tag records what the build INTENDED; a library swapped underneath
    // would keep reporting it. So it is appended, never substituted.
    expect(BODY).toMatch(/\[built against " \+\s*CHATTERANG_LLAMA_TAG/);
    // And it comes from the build, which reads it from the fetch script, so
    // the pin cannot drift into two copies.
    const gradle = readFileSync(resolve(ANDROID, 'build.gradle'), 'utf8');
    expect(gradle).toMatch(/LLAMA_TAG="\(\[\^"\]\+\)"/);
    expect(gradle).toMatch(/-DCHATTERANG_LLAMA_TAG=\$\{llamaCppTag\}/);
  });
});

describe('R8 cannot rename the Java the JNI looks up by name', () => {
  /**
   * Nothing has exercised this: the generated `android/app/build.gradle` sets
   * `minifyEnabled false`. Turning minification on for a release build is an
   * ordinary step, and it would break `generate` at RUNTIME with no build
   * error — `FindClass` returns null, `generate` returns nullptr, and the
   * model produces nothing.
   *
   * The rules cannot live in `android/app/proguard-rules.pro`: that whole tree
   * is generated by `cap add android` and gitignored, so an edit there is lost
   * on the next `cap sync`. `consumerProguardFiles` ships them inside the
   * module's AAR instead, which is what `@capacitor/android` does for its own
   * reflective plugin discovery (capacitor/build.gradle:50).
   */
  /**
   * Comments stripped, and that is not fussiness. Both assertions below were
   * fault-injected and both PASSED the injection: `proguard-rules.pro`
   * documents each name it keeps by quoting the `FindClass` / `GetMethodID`
   * call it came from, so deleting the actual keep rule left the name behind
   * in the prose, and commenting `consumerProguardFiles` out still matched.
   * The fences were reading the explanation instead of the rule.
   */
  const RULES = codeLines(
    readFileSync(resolve(ANDROID, 'proguard-rules.pro'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n'),
  ).join('\n');
  const GRADLE = codeLines(readFileSync(resolve(ANDROID, 'build.gradle'), 'utf8')).join('\n');

  it('ships the rules from the module, where cap sync cannot erase them', () => {
    expect(GRADLE).toMatch(/^\s*consumerProguardFiles 'proguard-rules\.pro'$/m);
  });

  it('keeps every class the JNI resolves by string', () => {
    const found = [...JNI_CODE.matchAll(/FindClass\("([^"]+)"\)/g)].map((m) =>
      m[1]!.replace(/\//g, '.'),
    );
    // Guards the sweep: if the extraction ever finds nothing, this fails
    // rather than passing vacuously.
    expect(found).toContain('app.chatterang.llama.LlamaBridge$GenerateResult');
    expect(found).toContain('app.chatterang.llama.LlamaBridge$BenchmarkResult');

    for (const name of found) {
      // `java.lang.IllegalStateException` and friends are the platform's, and
      // R8 never renames those.
      if (name.startsWith('java.')) continue;
      expect(RULES, `${name} is looked up by name from C++ with no keep rule`).toContain(name);
    }
  });

  it('keeps every method the JNI resolves by name', () => {
    const found = [...JNI_CODE.matchAll(/GetMethodID\([^,]+, "([^"]+)"/g)].map((m) => m[1]);
    expect(found).toContain('onToken');
    for (const name of found) {
      // `<init>` is a constructor; the `<init>(...)` keep rules cover it and
      // R8 never renames constructors anyway.
      if (name === '<init>') continue;
      expect(RULES, `${name} is looked up by name from C++ with no keep rule`).toContain(name);
    }
  });

  it('keeps the class and native method names the exported symbols embed', () => {
    // `Java_app_chatterang_llama_LlamaBridge_generate` is found only because
    // the class is still called `LlamaBridge` and the method is still called
    // `generate`.
    expect(RULES).toMatch(
      /-keepclasseswithmembernames[^\n]*class app\.chatterang\.llama\.LlamaBridge \{\s*native <methods>;/,
    );
  });
});
