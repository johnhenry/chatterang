import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The tunnel socket plugin's PACKAGING, not its code (#295, refs #181).
 *
 * `tests/native-registration.test.ts` guards `plugin-llama-cpp`'s packaging
 * because a Capacitor plugin is registered by being a DISCOVERED PACKAGE —
 * compiling the native class does nothing on its own, and the registration is
 * facts spread across files none of which is imported by anything, so every
 * one of them can be deleted without breaking typecheck or the web build. The
 * measured failure there (a dropped `capacitor` key, `cap sync` silently
 * reporting one fewer plugin) is exactly as available to this plugin, so the
 * same shape of guard applies here — cheaper, since this plugin vendors no
 * native library and needs no compiled-artefact check.
 */
const ROOT = resolve(process.cwd());
const PLUGIN_DIR = resolve(ROOT, 'native/plugin-tunnel-socket');

describe('the tunnel socket native plugin is a discoverable Capacitor package', () => {
  it('is a dependency of the root package.json, as a file: reference into native/', () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['@chatterang/plugin-tunnel-socket']).toBe('file:./native/plugin-tunnel-socket');
  });

  it("declares the 'capacitor' key cap sync reads to find the native sources", () => {
    const manifest = JSON.parse(readFileSync(resolve(PLUGIN_DIR, 'package.json'), 'utf8')) as {
      name: string;
      capacitor?: { ios?: { src?: string }; android?: { src?: string } };
    };
    expect(manifest.name).toBe('@chatterang/plugin-tunnel-socket');
    expect(manifest.capacitor?.ios?.src).toBe('ios');
    expect(manifest.capacitor?.android?.src).toBe('android');
  });

  it('has real iOS and Android sources under the paths the capacitor key names', () => {
    expect(existsSync(resolve(PLUGIN_DIR, 'ios/Sources/TunnelSocketPlugin/TunnelSocketPlugin.swift'))).toBe(true);
    expect(existsSync(resolve(PLUGIN_DIR, 'Package.swift'))).toBe(true);
    expect(
      existsSync(
        resolve(PLUGIN_DIR, 'android/src/main/java/app/chatterang/tunnelsocket/TunnelSocketPlugin.kt'),
      ),
    ).toBe(true);
    expect(existsSync(resolve(PLUGIN_DIR, 'android/build.gradle'))).toBe(true);
    expect(existsSync(resolve(PLUGIN_DIR, 'android/src/main/AndroidManifest.xml'))).toBe(true);
  });

  it('the iOS and Android sources declare the same four methods the contract and the web/desktop legs implement', () => {
    const swift = readFileSync(resolve(PLUGIN_DIR, 'ios/Sources/TunnelSocketPlugin/TunnelSocketPlugin.swift'), 'utf8');
    const kotlin = readFileSync(
      resolve(PLUGIN_DIR, 'android/src/main/java/app/chatterang/tunnelsocket/TunnelSocketPlugin.kt'),
      'utf8',
    );
    for (const method of ['connect', 'send', 'close', 'negotiatedPeer']) {
      expect(swift, `iOS: ${method}`).toMatch(new RegExp(`func ${method}\\b`));
      expect(kotlin, `Android: ${method}`).toMatch(new RegExp(`fun ${method}\\b`));
    }
    // The plugin's own jsName, both platforms — cross-checked so a rename on
    // one side without the other is a silent "not implemented" at runtime,
    // exactly as `tests/native-registration.test.ts`'s header describes for
    // a dropped `capacitor` key.
    expect(swift).toMatch(/jsName = "TunnelSocket"/);
    expect(kotlin).toMatch(/@CapacitorPlugin\(name = "TunnelSocket"\)/);
  });
});
