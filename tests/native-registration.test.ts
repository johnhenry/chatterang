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
    const foreign = tracked.filter(
      (path) => path.includes('llama.xcframework') || /\.(c|cpp|h|hpp|metal)$/.test(path),
    );
    expect(foreign).toEqual([]);
  });

  it('anchors the generated artefacts in .gitignore', () => {
    const ignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');
    // Anchored, in the style the rest of the file uses: an unanchored `models/`
    // once silently untracked four UI source files.
    expect(ignore).toMatch(/^\/\.cache\/$/m);
    expect(ignore).toMatch(/^\/native\/plugin-llama-cpp\/ios\/llama\.xcframework\/$/m);
  });
});
