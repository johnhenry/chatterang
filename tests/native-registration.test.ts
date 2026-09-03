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

/**
 * Source masked so that a brace, a keyword or a `LlamaBridge.` inside a
 * comment or a string literal cannot be mistaken for code.
 *
 * Same LENGTH as the input, on purpose: every index into the mask is an index
 * into the real file, so a finding can name the line it is really on.
 * `codeLines` above cannot do this job — it drops whole lines, which moves
 * every line number after the first comment.
 */
const maskCode = (source: string): string => {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const nl = source.indexOf('\n', i);
      const stop = nl < 0 ? source.length : nl;
      blank(i, stop);
      i = stop;
    } else if (two === '/*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close < 0 ? source.length : close + 2;
      blank(i, stop);
      i = stop;
    } else if (source[i] === '"') {
      const triple = source.startsWith('"""', i);
      const quote = triple ? '"""' : '"';
      let j = i + quote.length;
      while (j < source.length) {
        if (!triple && source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source.startsWith(quote, j)) break;
        if (!triple && source[j] === '\n') break;
        j += 1;
      }
      const stop = Math.min(source.length, j + quote.length);
      blank(i, stop);
      i = stop;
    } else if (source[i] === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== "'" && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1;
      }
      const stop = Math.min(source.length, j + 1);
      blank(i, stop);
      i = stop;
    } else {
      i += 1;
    }
  }
  return out.join('');
};

/** Index just past the `}` that closes the `{` at `open`. */
const blockEnd = (masked: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return masked.length;
};

type Catches = 'all' | 'rejected';
type Region = { start: number; end: number; catches: Catches };
type Audit = { methods: string[]; guards: string[]; findings: string[] };

/**
 * The things that throw out of a plugin method, and what it takes to survive
 * each one.
 *
 * Patterns, not a list of method names: a fence that knows the names of
 * today's five defects would go green the moment a sixth method is written.
 */
const RISKY: { re: string; needs: Catches; why: string }[] = [
  {
    re: 'LlamaBridge\\.\\w+',
    needs: 'all',
    why:
      'a native call, or the <clinit> that loads the library — the failures ' +
      'are `Error`s, so only `catch (Throwable)` sees them',
  },
  {
    re: 'executor\\.execute\\b',
    needs: 'rejected',
    why:
      '`RejectedExecutionException` on the CALLING thread once the executor ' +
      'is shut down — the throw happens before the runnable ever runs, so the ' +
      'guard inside the lambda is on the wrong side of it',
  },
  {
    re: 'as +[A-Z]\\w*',
    needs: 'all',
    why:
      'a Kotlin non-null cast — `NullPointerException` when the platform ' +
      'call returns null on a stripped or vendor ROM',
  },
];

/**
 * Reads a Capacitor plugin source and reports every place a `@PluginMethod`
 * can let something escape.
 *
 * Three things it does that the old `LlamaBridge`-only sweep did not:
 *
 *   1. CONTAINMENT, not ordering. The old sweep asked "is this use after the
 *      first guard token in the body". `generate` opens a `try`, CLOSES it,
 *      and then calls `executor.execute` — later than the guard, outside it.
 *      Braces are matched here, so a closed guard guards nothing after it.
 *   2. Every risky construct, not just `LlamaBridge.*`. Capacitor's
 *      `Bridge.callPluginMethod` rethrows ANYTHING out of a plugin method as
 *      an uncaught `RuntimeException` on a `HandlerThread`, so the native
 *      calls were never the whole surface.
 *   3. One thread-level hop into the private helpers a method calls before it
 *      hands off. `getThermalState`'s body is one line; the cast that kills
 *      the app is in `thermalPayload`.
 *
 * The guard vocabulary is DERIVED from the source, not hardcoded: a helper
 * counts as a guard when it takes a lambda and every call of that lambda in
 * its own body sits inside something that catches `Throwable`. That finds
 * `rejectOnThrow` (a literal `try`/`catch (Throwable)`) on the first pass and
 * `withHandle` (which defers to `rejectOnThrow`) on the second. Rename them
 * and the fence still works; delete the catch and they stop counting.
 */
const auditPlugin = (source: string, file = 'LlamaCppPlugin.kt'): Audit => {
  const mask = maskCode(source);
  const lineOf = (index: number): number => mask.slice(0, index).split('\n').length;

  const DECL = /^ {4}(?:(?:private|internal|protected|public|override|open) )*(?:inline )?fun (\w+)\s*\(/gm;
  const decls: { name: string; start: number; plugin: boolean }[] = [];
  for (const m of mask.matchAll(DECL)) {
    decls.push({
      name: m[1]!,
      start: m.index!,
      plugin: /@PluginMethod\s*$/.test(mask.slice(Math.max(0, m.index! - 60), m.index!)),
    });
  }

  // A declaration owns everything up to the next class-level declaration, so
  // `getThermalState` no longer silently absorbs `thermalPayload`'s body the
  // way an `@PluginMethod`-to-`@PluginMethod` slice does.
  const stops = [
    ...decls.map((d) => d.start),
    ...[...mask.matchAll(/^ {4}(?:private |internal )?companion object/gm)].map((m) => m.index!),
    mask.length,
  ].sort((a, b) => a - b);
  const spanOf = (start: number): { start: number; end: number } => ({
    start,
    end: stops.find((s) => s > start) ?? mask.length,
  });

  const regionsIn = (start: number, end: number, guards: string[]): Region[] => {
    const regions: Region[] = [];
    const span = mask.slice(start, end);

    for (const m of span.matchAll(/\btry\s*\{/g)) {
      const open = start + m.index! + m[0].length - 1;
      const close = blockEnd(mask, open);
      let cursor = close;
      let catches: Catches | null = null;
      for (;;) {
        const clause = /^\s*catch\s*\(\s*\w+\s*:\s*(\w+)\s*\)\s*\{/.exec(mask.slice(cursor, cursor + 160));
        if (!clause) break;
        if (clause[1] === 'Throwable') catches = 'all';
        else if (clause[1] === 'RejectedExecutionException' && catches === null) catches = 'rejected';
        cursor = blockEnd(mask, cursor + clause[0].length - 1);
      }
      if (catches) regions.push({ start: open, end: close, catches });
    }

    for (const name of guards) {
      // `[^(){}]*` matches a CALL — `rejectOnThrow(call) {` — and not the
      // declaration, whose parameter list contains its own parentheses.
      for (const m of span.matchAll(new RegExp(`\\b${name}\\s*\\([^(){}]*\\)\\s*\\{`, 'g'))) {
        const at = start + m.index!;
        if (/\bfun\s+$/.test(mask.slice(Math.max(0, at - 20), at))) continue;
        const open = at + m[0].length - 1;
        regions.push({ start: open, end: blockEnd(mask, open), catches: 'all' });
      }
    }
    return regions;
  };

  const covered = (at: number, regions: Region[], needs: Catches): boolean =>
    regions.some(
      (r) => at >= r.start && at < r.end && (needs === 'rejected' || r.catches === 'all'),
    );

  // The fixpoint that derives the guard vocabulary. Two passes are enough for
  // this file; the loop runs until it stops growing so a third layer would be
  // found too.
  let guards: string[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const found = decls
      .filter((d) => {
        const { start, end } = spanOf(d.start);
        const span = mask.slice(start, end);
        const signature = span.slice(0, span.indexOf('{') + 1 || 200);
        const lambdas = [...signature.matchAll(/\b(\w+)\s*:\s*\([^)]*\)\s*->/g)].map((m) => m[1]!);
        if (lambdas.length === 0) return false;
        const regions = regionsIn(start, end, guards);
        return lambdas.every((param) => {
          const calls = [...span.matchAll(new RegExp(`\\b${param}\\s*\\(`, 'g'))].map(
            (m) => start + m.index!,
          );
          return calls.length > 0 && calls.every((at) => covered(at, regions, 'all'));
        });
      })
      .map((d) => d.name)
      .sort();
    if (found.join() === guards.join()) break;
    guards = found;
  }

  const byName = new Map(decls.map((d) => [d.name, d]));
  const helpers = new Set(decls.filter((d) => !d.plugin).map((d) => d.name));
  const findings: string[] = [];

  for (const method of decls.filter((d) => d.plugin)) {
    const seen = new Set<string>();
    const walk = (decl: { name: string; start: number }, trail: string[]): void => {
      if (seen.has(decl.name)) return;
      seen.add(decl.name);
      const { start, end } = spanOf(decl.start);
      const span = mask.slice(start, end);
      const regions = regionsIn(start, end, guards);
      const where = trail.join(' -> ');

      for (const risk of RISKY) {
        for (const m of span.matchAll(new RegExp(risk.re, 'g'))) {
          const at = start + m.index!;
          if (covered(at, regions, risk.needs)) continue;
          findings.push(
            `${where} (${file}:${lineOf(at)}) runs \`${m[0].trim()}\` with nothing to catch it — ${risk.why}`,
          );
        }
      }

      // Whatever this body calls before it reaches a guard runs on the same
      // thread and can throw the same way.
      for (const m of span.matchAll(/\b(\w+)\s*\(/g)) {
        const name = m[1]!;
        const at = start + m.index!;
        if (name === decl.name || !helpers.has(name)) continue;
        if (covered(at, regions, 'all')) continue;
        if (/\bfun\s+$/.test(mask.slice(Math.max(0, at - 20), at))) continue;
        walk(byName.get(name)!, [...trail, name]);
      }
    };
    walk(method, [method.name]);
  }

  return { methods: decls.filter((d) => d.plugin).map((d) => d.name), guards, findings };
};

describe('the fence itself can see an unguarded plugin method', () => {
  /*
   * The instrument, measured on Kotlin written to be measured — because the
   * old fence passed a file with five fatal paths in it and a fence that has
   * never been shown failing is a guess.
   *
   * Nothing here is hardcoded to the real file's method names: the probe
   * defines its own `rejectOnThrow`, and the audit has to work out from the
   * `try`/`catch (Throwable)` inside it that calling it is a guard.
   */
  const PROBE = [
    '@CapacitorPlugin(name = "Probe")',
    'class Probe : Plugin() {',
    '',
    '    @PluginMethod',
    '    fun guarded(call: PluginCall) {',
    '        wrap(call) {',
    '            executor.execute {',
    '                wrap(call) { call.resolve(JSObject().put("v", LlamaBridge.engineVersion())) }',
    '            }',
    '        }',
    '    }',
    '',
    '    @PluginMethod',
    '    fun deferred(call: PluginCall) {',
    '        onWorker(call) { handle -> call.resolve(JSObject().put("n", LlamaBridge.tokenize(handle))) }',
    '    }',
    '',
    '    @PluginMethod',
    '    fun afterAClosedTry(call: PluginCall) {',
    '        val reason = try {',
    '            LlamaBridge.loadFailure',
    '        } catch (error: Throwable) {',
    '            null',
    '        }',
    '        executor.execute { call.resolve() }',
    '    }',
    '',
    '    @PluginMethod',
    '    fun viaHelper(call: PluginCall) {',
    '        call.resolve(payload())',
    '    }',
    '',
    '    private fun payload(): JSObject {',
    '        // LlamaBridge.engineVersion() in a comment is not a call.',
    '        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager',
    '        return JSObject().put("s", "as PowerManager in a string is not a cast")',
    '    }',
    '',
    '    private fun onWorker(call: PluginCall, body: (Long) -> Unit) {',
    '        wrap(call) { body(1L) }',
    '    }',
    '',
    '    private inline fun wrap(call: PluginCall, body: () -> Unit) {',
    '        try {',
    '            body()',
    '        } catch (error: Throwable) {',
    '            call.reject("no")',
    '        }',
    '    }',
    '}',
  ].join('\n');

  const probe = auditPlugin(PROBE, 'Probe.kt');

  it('derives the guard vocabulary from the source instead of knowing its names', () => {
    // `wrap` catches `Throwable` around its own lambda; `onWorker` defers to
    // `wrap`. Neither is named in the audit — both are worked out.
    expect(probe.guards).toEqual(['onWorker', 'wrap']);
  });

  it('says nothing about a method whose body is inside a guard', () => {
    expect(probe.findings.filter((f) => f.startsWith('guarded'))).toEqual([]);
    expect(probe.findings.filter((f) => f.startsWith('deferred'))).toEqual([]);
  });

  it('sees the call that a CLOSED try does not guard', () => {
    // The bug the old ordering test could not see: the guard is earlier in
    // the body and the call is still outside it.
    expect(probe.findings.filter((f) => f.startsWith('afterAClosedTry'))).toEqual([
      expect.stringContaining('runs `executor.execute`'),
    ]);
  });

  it('follows one hop into a private helper called before any guard', () => {
    expect(probe.findings.filter((f) => f.startsWith('viaHelper'))).toEqual([
      expect.stringContaining('viaHelper -> payload (Probe.kt:35) runs `as PowerManager`'),
    ]);
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
   *
   * The sweep is wider than that one crash, because the mechanism is wider.
   * `Bridge.callPluginMethod` posts the method into a `Runnable` whose handler
   * is `catch (Exception ex) { throw new RuntimeException(ex); }`, and
   * `PluginHandle.invoke` is reflective — so an `Error` arrives wrapped in an
   * `InvocationTargetException` and comes back out uncaught on a
   * `HandlerThread`. ANY throw out of a `@PluginMethod` is a process kill, not
   * only the ones that went through `LlamaBridge`.
   */
  const audit = auditPlugin(PLUGIN_KT);

  it('finds all ten plugin methods, so the sweep below cannot pass by finding none', () => {
    expect([...audit.methods].sort()).toEqual([
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

  it('recognises the guards this file actually defines', () => {
    // Derived, not asserted into existence: `rejectOnThrow` is a
    // `try`/`catch (Throwable)` around its lambda, and `withHandle` is
    // `executor.execute { rejectOnThrow(call) { … } }`. If either stopped
    // catching `Throwable` it would drop out of this list and every body it
    // wraps would be reported instead.
    expect(audit.guards).toEqual(['rejectOnThrow', 'withHandle']);
  });

  it('lets nothing in a @PluginMethod body run outside a guard', () => {
    expect(audit.findings).toEqual([]);
  });

  it('does not fire on the methods that are already guarded', () => {
    // The false-positive control. `getCapabilities` is one `rejectOnThrow`
    // over its whole body, and `listLoaded` and `cancel` touch nothing that
    // can throw — none of them may ever appear above.
    const named = new Set(audit.findings.map((f) => f.split(' ')[0]));
    expect(named).not.toContain('getCapabilities');
    expect(named).not.toContain('listLoaded');
    expect(named).not.toContain('cancel');
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

describe('the JNI exports exactly the symbols LlamaBridge declares', () => {
  /*
   * The cheapest check in this file, standing over the most expensive
   * failure.
   *
   * A `.so` that builds and dlopens while missing ONE symbol is
   * indistinguishable from a healthy one until the method is called —
   * `loadFailure` is null, `getCapabilities` is happy, and the crash arrives
   * later as an `UnsatisfiedLinkError` at the call site. That is the exact
   * shape of the injection documented above, and finding it took an emulator,
   * a rebuild and a device run. Comparing two lists of names finds a typo'd
   * or dropped export in milliseconds, before anything is built.
   *
   * Both sides are read from source and neither list is written down here, so
   * adding an `external fun` and its `Java_…` definition together keeps this
   * green and adding either one alone does not.
   *
   * Names only, not signatures: JNI resolves by name plus descriptor, and a
   * changed descriptor is a different failure this cannot see. (No name here
   * needs JNI's `_1` escaping — none of them contains an underscore — and no
   * method is overloaded, so no `__`-suffixed long form exists to match.)
   */
  const declared = [
    ...new Set([...maskCode(BRIDGE_KT).matchAll(/\bexternal fun (\w+)/g)].map((m) => m[1]!)),
  ].sort();
  const exported = [
    ...new Set(
      [...maskCode(JNI).matchAll(/\bJava_app_chatterang_llama_LlamaBridge_(\w+)\s*\(/g)].map(
        (m) => m[1]!,
      ),
    ),
  ].sort();

  it('finds symbols on both sides, so the comparison cannot pass on two empty lists', () => {
    expect(declared.length).toBeGreaterThan(10);
    expect(exported.length).toBeGreaterThan(10);
  });

  it('has a C++ definition for every external fun, and no export nothing declares', () => {
    expect(exported).toEqual(declared);
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


/* ── Three reported values that did not mean what their names said ───────
 *
 * `getCapabilities`, `generate` and `benchmark` hand the UI numbers, and a
 * number with the wrong name is worse than a missing one: it is read, plotted
 * and compared. Each block below is a value that was measured but mislabelled,
 * or asserted where it could have been asked.
 */

const HARNESS = readFileSync(resolve(PLUGIN_DIR, 'tools/prove-android.js'), 'utf8');
const CMAKE = readFileSync(resolve(ANDROID, 'src/main/cpp/CMakeLists.txt'), 'utf8');

describe('peakMemoryBytes is a high-water mark, not a sample', () => {
  /**
   * `footprint()` read `/proc/self/statm` field 2 — the resident page count
   * RIGHT NOW — and the plugin put it in a field the contract calls
   * `peakMemoryBytes`. Sampled, not fabricated, and still a mislabel: a peak
   * cannot fall, and this one could. `unload` munmaps ~400 MB of GGUF, so the
   * reading taken after it came back SMALLER than the reading before it.
   *
   * `VmHWM` in `/proc/self/status` is the kernel's own watermark for the
   * process and never falls. It is process-wide and process-lifetime, so it is
   * an upper bound on any one request rather than that request's own peak —
   * documented as exactly that, in the JNI, in `LlamaBridge` and in the README.
   */
  it('reads the kernel watermark, not the current resident size', () => {
    expect(JNI_CODE).toMatch(/\/proc\/self\/status/);
    expect(JNI_CODE).toMatch(/VmHWM:/);
    expect(JNI_CODE).not.toMatch(/statm/);
  });

  it('names the exported symbol after the thing it returns', () => {
    // The rename is load-bearing, not cosmetic: `footprint()` is what the old
    // reading honestly was, so leaving the name would leave the next caller
    // free to reintroduce the mislabel by using it for `peakMemoryBytes`.
    expect(JNI_CODE).toMatch(/Java_app_chatterang_llama_LlamaBridge_peakFootprint/);
    expect(JNI_CODE).not.toMatch(/Java_app_chatterang_llama_LlamaBridge_footprint\b/);
    expect(BRIDGE_CODE).toMatch(/external fun peakFootprint\(\): Long/);
    expect(BRIDGE_CODE).not.toMatch(/external fun footprint\(\)/);
  });

  it('fills every peakMemoryBytes the plugin reports from it', () => {
    const lines = PLUGIN_CODE.split('\n').filter((line) => line.includes('"peakMemoryBytes"'));
    // `generate` and `benchmark`. Asserting the count as well as the shape so
    // a third reporter cannot be added with the old reading.
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/LlamaBridge\.peakFootprint\(\)/);
  });

  it('keeps its own maximum, because Android resets the kernel watermark', () => {
    // Found by the harness, not by reading the kernel docs. `VmHWM` alone
    // still failed `memory.peakNeverFalls` on emulator-5554 — 1338576896 bytes
    // with both models resident, 946122752 after unloading one — and sampling
    // `/proc/<pid>/status` alongside the run showed the watermark itself being
    // reset three times inside one process, each time down to the resident
    // size of that moment. So the monotonicity this field promises has to be
    // maintained here; the kernel does not maintain it for us.
    expect(JNI_CODE).toMatch(/std::atomic<long> observed_peak_kb/);
    expect(JNI_CODE).toMatch(/compare_exchange_weak\(seen, kilobytes/);
    const start = JNI_CODE.indexOf('Java_app_chatterang_llama_LlamaBridge_peakFootprint');
    const body = JNI_CODE.slice(start, JNI_CODE.indexOf('JNIEXPORT', start + 1));
    // The returned value is the running maximum, never the fresh reading.
    expect(body).toMatch(/return static_cast<jlong>\(observed_peak_kb\.load/);
    expect(body).not.toMatch(/return static_cast<jlong>\(kilobytes\)/);
  });

  it('is proven on the device across the unload, where a sample must fall', () => {
    // The source shape above cannot tell a peak from a sample; only the device
    // can. The harness collects every `peakMemoryBytes` the run reports — one
    // while BOTH models are resident, one after 400 MB has gone back to the
    // kernel — and fails if the sequence ever falls.
    expect(HARNESS).toMatch(/memory\.peakNeverFalls/);
    expect(HARNESS).toMatch(/peaks\.push\(\{ at: 'generate\.bothLoaded'/);
    expect(HARNESS).toMatch(/peaks\.push\(\{ at: 'generate\.afterUnloadOfOtherHandle'/);
  });
});

describe('tokensPerSecond is decode throughput, not tokens over wall time', () => {
  /**
   * `completionTokens * 1000.0 / totalMs` divides the tokens by the WHOLE wall
   * clock, prefill included. Measured on emulator-5554: `generate` reported
   * 0.0867 tok/s while `benchmark` reported 0.3051 tok/s of decode for the
   * same model in the same run — a 3.5x gap produced entirely by the divisor.
   *
   * Both numbers reach the user as "tok/s" (the chat rail's readout and the
   * bench screen's "Generation" stat), so the disagreement reads as a
   * regression in the engine rather than a difference in arithmetic.
   */
  it('divides by the decode window, not by the whole wall clock', () => {
    expect(PLUGIN_CODE).toMatch(/val decodeMs = max\(1L, totalMs - ttftMs\)/);
    expect(PLUGIN_CODE).toMatch(/decodedTokens \* 1000\.0 \/ decodeMs/);
    expect(PLUGIN_CODE).not.toMatch(/completionTokens \* 1000\.0 \/ totalMs/);
  });

  it('excludes the token that prefill produced', () => {
    // The first token arrives AT `ttftMs` and is the output of prefill, so the
    // window after it carries `completionTokens - 1` tokens. Counting all of
    // them over the decode window would overstate the rate on short answers,
    // which is most answers.
    expect(PLUGIN_CODE).toMatch(/val decodedTokens = result\.completionTokens - 1/);
  });

  it('reports 0 rather than inventing a rate out of one prefill', () => {
    expect(PLUGIN_CODE).toMatch(
      /if \(decodedTokens > 0\) decodedTokens \* 1000\.0 \/ decodeMs else 0\.0/,
    );
  });

  it('is checked on the device as a definition, not as a plausibility bound', () => {
    // The device carries `completionTokens`, `ttftMs` and `totalMs`, so the
    // harness recomputes BOTH readings and says which one the reported number
    // is. A bound like "within 4x of benchmark" would have passed the bug.
    expect(HARNESS).toMatch(/generate\.throughputDefinition/);
    expect(HARNESS).toMatch(/const decodeOnly =/);
    expect(HARNESS).toMatch(/const endToEnd =/);
  });
});

describe('the implementations Android cannot fix from here stay named', () => {
  /**
   * Three implementations satisfy one contract, and on both of these fields
   * the other two — plus the web shim — still do what Android used to. Fixing
   * them means editing `src/` and `packages/`, which this workflow does not
   * own, so what ships here is a handoff.
   *
   * A handoff rots. This pairs each claim in the README against the source it
   * describes: the entry must be there while the source still has the old
   * shape, and gone once it does not. It goes red both ways — when someone
   * fixes an implementation and leaves the note, and when someone deletes the
   * note without fixing anything.
   */
  const README = readFileSync(resolve(ROOT, 'native/README.md'), 'utf8');
  const IOS_PLUGIN = readFileSync(
    resolve(PLUGIN_DIR, 'ios/Sources/LlamaCppPlugin/LlamaCppPlugin.swift'),
    'utf8',
  );
  const NODE = readFileSync(resolve(ROOT, 'packages/inference-node/src/llama-cpp.ts'), 'utf8');
  const WEB = readFileSync(resolve(ROOT, 'src/plugins/llama-cpp/web.ts'), 'utf8');

  /** The README block under one `####` heading, so the two lists cannot cover
   *  for each other — the same three files appear in both. */
  const section = (heading: string): string => {
    const start = README.indexOf(heading);
    expect(start, `native/README.md has no "${heading}" heading`).toBeGreaterThan(-1);
    const rest = README.slice(start + heading.length);
    const end = rest.search(/\n#### |\n## /);
    return end === -1 ? rest : rest.slice(0, end);
  };

  const check = (heading: string, rows: [string, boolean][]): void => {
    const block = section(heading);
    for (const [path, unfixed] of rows) {
      expect(
        block.includes(path),
        unfixed
          ? `${path} still has the old shape but "${heading}" does not name it`
          : `${path} no longer has the old shape — delete it from "${heading}"`,
      ).toBe(unfixed);
    }
  };

  it('lists exactly the implementations still reporting end-to-end throughput', () => {
    check('#### `tokensPerSecond`', [
      [
        'native/plugin-llama-cpp/ios/Sources/LlamaCppPlugin/LlamaCppPlugin.swift',
        /Double\(completionTokens\) \/ \(Double\(totalMs\) \/ 1000\.0\)/.test(IOS_PLUGIN),
      ],
      [
        'packages/inference-node/src/llama-cpp.ts',
        /\(\(completionTokens \/ totalMs\) \* 1000\)/.test(NODE),
      ],
      ['src/plugins/llama-cpp/web.ts', /\(\(completionTokens \/ totalMs\) \* 1000\)/.test(WEB)],
    ]);
  });

  it('lists exactly the implementations still sampling current memory', () => {
    check('#### `peakMemoryBytes`', [
      [
        'native/plugin-llama-cpp/ios/Sources/LlamaCppPlugin/LlamaCppPlugin.swift',
        /info\.phys_footprint/.test(
          readFileSync(resolve(PLUGIN_DIR, 'ios/Sources/LlamaCppPlugin/LlamaContext.swift'), 'utf8'),
        ),
      ],
      ['packages/inference-node/src/llama-cpp.ts', /process\.memoryUsage\.rss\(\)/.test(NODE)],
      // Not a sample at all: a hardcoded 512 MB. Named here because the shim
      // is what the adapter tests run against.
      ['src/plugins/llama-cpp/web.ts', /peakMemoryBytes: 512 \* 1024 \* 1024/.test(WEB)],
    ]);
  });
});

describe('every backend in the list is a question, not a literal', () => {
  /**
   * `availableBackends()` opened with an unconditional `add("cpu")`. The other
   * three entries ask the ggml registry, so they carry information; "cpu" was
   * the one element of that list a stub with no engine at all produced
   * identically to a working build.
   */
  it('gates all four entries on a registry query', () => {
    const start = PLUGIN_CODE.indexOf('private fun availableBackends');
    expect(start).toBeGreaterThan(-1);
    const body = PLUGIN_CODE.slice(start, PLUGIN_CODE.indexOf('\n    }', start));
    const adds = body.split('\n').filter((line) => /\badd\(/.test(line));
    expect(adds).toHaveLength(4);
    for (const line of adds) {
      expect(line.trim()).toMatch(/^if \(LlamaBridge\.has\w+\(\)\) add\("[\w-]+"\)$/);
    }
  });

  it('asks ggml for the CPU backend by name, like the other three', () => {
    const start = JNI_CODE.indexOf('Java_app_chatterang_llama_LlamaBridge_nativeHasCpu');
    expect(start).toBeGreaterThan(-1);
    const body = JNI_CODE.slice(start, JNI_CODE.indexOf('JNIEXPORT', start + 1));
    expect(body).toMatch(/ensure_backend\(\);/);
    expect(body).toMatch(/backend_registered\("CPU"\)/);
    expect(BRIDGE_CODE).toMatch(/fun hasCpu\(\): Boolean = isAvailable && nativeHasCpu\(\)/);
  });
});

describe('supportsVision cannot outlive the build it is true for', () => {
  /**
   * It returns `JNI_FALSE` and ignores its handle. That is correct — and only
   * correct while `LLAMA_BUILD_MTMD` is OFF, which is a fact in a different
   * file that nothing connected it to. A constant that is right today and
   * silently wrong after a build-flag change is the shape this whole audit is
   * about, so the flag now reaches the C++ and breaks the build instead.
   */
  it('turns a multimodal build into a compile error, not a false', () => {
    const start = JNI.indexOf('Java_app_chatterang_llama_LlamaBridge_supportsVision');
    expect(start).toBeGreaterThan(-1);
    const body = JNI.slice(start, JNI.indexOf('JNIEXPORT', start + 1));
    expect(body).toMatch(/#if CHATTERANG_MTMD/);
    expect(body).toMatch(/#error/);
    expect(body).toMatch(/return JNI_FALSE;/);
  });

  it('derives the flag from the option instead of writing it down twice', () => {
    expect(CMAKE).toMatch(/set\(LLAMA_BUILD_MTMD\s+OFF/);
    expect(CMAKE).toMatch(/CHATTERANG_MTMD=\$<BOOL:\$\{LLAMA_BUILD_MTMD\}>/);
  });
});

describe('the thermal level stays a faithful mapping of a measured ordinal', () => {
  /**
   * `PowerManager.currentThermalStatus` is measured. The float is not: it is a
   * fixed table mapping seven OS statuses onto the contract's 0..1, on the same
   * scale points iOS's four-value `ProcessInfo.thermalState` uses. There is no
   * temperature behind 0.88.
   *
   * That is defensible — the contract asks for a normalised number and the
   * platform gives an ordinal — as long as it stays an order-preserving
   * mapping of the measurement. What it must never become is a constant, or a
   * table that ranks two different statuses the same.
   */
  it('gives every status its own strictly increasing level', () => {
    const start = PLUGIN_CODE.indexOf('val (level, name) = when (status)');
    expect(start).toBeGreaterThan(-1);
    const body = PLUGIN_CODE.slice(start, PLUGIN_CODE.indexOf('\n        }', start));
    const levels = [...body.matchAll(/->\s*(\d\.\d+) to "/g)].map((m) => Number(m[1]!));
    expect(levels).toHaveLength(6);
    expect(new Set(levels).size).toBe(levels.length);
    expect([...levels].sort((a, b) => a - b)).toEqual(levels);
    expect(Math.min(...levels)).toBeGreaterThan(0);
    expect(Math.max(...levels)).toBeLessThanOrEqual(1);
  });

  it('says in the source that the float is a mapping and not a measurement', () => {
    // Read from the file WITH its comments: the claim being fenced is the
    // disclosure itself. A number this arbitrary is honest only if it says so
    // where the next reader will look.
    expect(PLUGIN_KT).toMatch(/The STATUS is measured\. The FLOAT IS NOT\./);
  });

  it('derives throttled from the status rather than from the float', () => {
    expect(PLUGIN_CODE).toMatch(/"throttled", status >= PowerManager\.THERMAL_STATUS_SEVERE/);
  });
});
