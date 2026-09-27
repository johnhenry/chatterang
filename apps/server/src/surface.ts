/**
 * THE FOUR PLUGINS THIS SERVER REGISTERS, AND THE TEN IT DOES NOT.
 *
 * `index.ts` says the reachable surface of this server is the manifest and
 * nothing else, and that "the shell is not exposed" is the absence of a row
 * rather than a promise about intent. That was true and it was not GUARDED:
 * the registration lived inline in `main.ts`, which is an entry point that
 * forks two children and requires a built bundle on disk, so no test has ever
 * executed it. `tests/server.test.ts` asserts the plugin list over a real
 * socket — against a `PluginHost` the TEST populated with one plugin. Adding a
 * fifth registration to `main.ts` therefore left the whole suite green, which
 * is the mutation this file exists to make impossible.
 *
 * So the decision moves here, where it is still readable in one place and is
 * additionally:
 *
 *   - a LIST, {@link SERVER_PLUGINS}, rather than four scattered calls;
 *   - a TYPE, {@link ServerImplementations}, with one field per plugin — so a
 *     fifth registration cannot be added without adding a field, and cannot be
 *     added quietly by adding a field either, because
 *   - an ASSERTION, {@link assertServerSurface}, which `startServer` runs on
 *     the manifest the router built. A plugin name this file does not declare
 *     is a BOOT FAILURE, not a test failure — the server refuses to answer at
 *     all rather than serving a surface nobody decided on.
 *
 * The assertion is a SUBSET check, deliberately, and the asymmetry is the
 * point: a plugin present that this file does not name is a security problem,
 * and a plugin missing is a functionality problem. Only the first one gets to
 * stop the process. (It also lets `tests/server.test.ts` keep standing up a
 * one-plugin server to test the wire, which is the right shape for those
 * tests and would otherwise have to grow four implementations it does not
 * use.)
 *
 * ── WHY FILESYSTEM IS ON, WHICH LOOKS LIKE THE WRONG WAY ROUND ──────────
 *
 * Leaving it out is not smaller. With NO Filesystem plugin registered,
 * `@capacitor/core` falls through to the npm package's WEB shim and a model
 * download lands in the connecting browser's IndexedDB, where the process with
 * the GPU can never read it — eb3a279's bug on a fifth platform. See
 * `index.ts` and `apps/desktop/src/fs/filesystem.ts`, which argue it at
 * length. It is registered confined to the data root, and every peer that
 * holds the operator token shares that directory; `index.ts` says so plainly
 * rather than calling it tenancy.
 */

import { relative } from 'node:path';

import {
  DSH_PLUGIN,
  FILESYSTEM_PLUGIN,
  LLAMA_PLUGIN,
  ONNX_PLUGIN,
} from '@chatterang/desktop/bridge';
import type { BootManifest, PluginDefinition, PluginHost, PluginImplementation } from '@chatterang/desktop/bridge';

/**
 * Every plugin this server may register, and the whole of it.
 *
 * Written as a list of the SAME frozen definitions the desktop shell uses, so
 * the two cannot drift into two spellings of one name. The server is not a
 * subset of the desktop by accident — it registers exactly what the desktop
 * shell registers, because both put the same two inference hosts and the same
 * confined filesystem behind the same bridge. What differs is everything that
 * is not a plugin, which is the list below.
 */
export const SERVER_PLUGINS: readonly PluginDefinition[] = Object.freeze([
  LLAMA_PLUGIN,
  ONNX_PLUGIN,
  FILESYSTEM_PLUGIN,
  DSH_PLUGIN,
]);

/** The three directories a served `Filesystem` answer can name. */
export interface ServedRoots {
  /** The host's model root. `<data>/models`, and what `load` resolves against. */
  readonly models: string;
  /** `Directory.Data`. */
  readonly data: string;
  /** `Directory.Cache`. */
  readonly cache: string;
}

/**
 * The `uri` a served peer gets back from `Filesystem`, and what it leaves out.
 *
 * THE FAILURE PATH WAS CAREFUL AND THE SUCCESS PATH WAS NOT.
 * `apps/desktop/src/fs/filesystem.ts` goes to real lengths never to echo a
 * path in an error — `refusePath` says "the path is not echoed back", and
 * `io()` strips the absolute path out of every errno message — and then
 * `writeFile` and `getUri` answered `{uri: '<root>/files/data/models/…'}` on
 * SUCCESS. Measured on 127.0.0.1: the full server realpath, which names the
 * operator's home directory and whatever they called their data root, handed
 * to a browser on another machine.
 *
 * On the DESKTOP that absolute path is the right answer and stays the default:
 * the page and the disk belong to the same person, `download.ts:218` stores
 * the string verbatim, and `tests/desktop-filesystem.test.ts` pins
 * `confineRealPath(modelRoot, uri) === uri`. Here the page is somewhere else.
 *
 * SO WHAT IS A PATH THE CALLER CAN USE? Exactly one thing is ever done with
 * this string on this platform: `src/lib/download.ts` stores it and hands it to
 * `LlamaCpp.load` / `OnnxRuntime.createSession`. Both resolve it against the
 * MODEL ROOT — `host/model-paths.ts` calls `confineModelPath`, which is
 * `resolve(root, candidate)` and therefore takes a relative path, and REPLACES
 * the field with the resolved absolute path before the loader sees it. So the
 * name the loader knows a model by — `<engine>/<id>`, relative to the model
 * root — is both usable and free of this machine's layout. That is the answer
 * for anything inside the model root.
 *
 * A PATH OUTSIDE IT has no such name, and gets the path relative to the root
 * it lives in instead. That is not a disclosure — it is the caller's own
 * argument, normalised — and it is not a model, so nothing will load it. In
 * practice nothing reaches that branch on this platform: `src/lib/export.ts`
 * is the only other `getUri` caller and the `server` row in
 * `src/lib/platform.ts` sends it down `browser-download` instead. The order of
 * the three roots matters and is asserted: `models` is INSIDE `data`, so a
 * model path matches both and the model root has to be tried first.
 */
export function servedUri(roots: ServedRoots): (real: string) => string {
  const order = [roots.models, roots.data, roots.cache];
  return (real) => {
    for (const root of order) {
      const inside = relative(root, real);
      if (inside !== '' && !inside.startsWith('..')) return inside;
    }
    // Not reachable through the plugin, which confines every path to one of
    // these roots before this is called. A path with no root is not a path
    // this server will describe.
    return '';
  };
}

/**
 * The ten surfaces that are OFF, named so a test can probe each one.
 *
 * These are not plugin names that exist anywhere — that is the point. Each is
 * a capability the app has on some platform and that this server does not put
 * on the wire, written down under the name a future registration would most
 * plausibly give it, so `tests/server-surface.test.ts` can send a call
 * addressed to each and watch the router's channel table refuse it before any
 * implementation is looked up.
 *
 * The ten, and where each lives when it is not here:
 *
 *   Shell        `src/shell/index.ts` — a live command surface over the VFS.
 *   Bash         `src/shell/tool.ts` — the `just-bash` tool the model can call.
 *   Mcp          `src/state/mcp.ts` — the MCP server registry and its clients.
 *   Chats        `src/state/chat.ts` — conversations, in the browser's Dexie.
 *   Personas     `src/state/personas.ts` — likewise.
 *   Providers    `src/db/index.ts:connections` — provider connections and keys.
 *   Leaderboard  `src/lib/leaderboard.ts` — an upload, off this machine.
 *   Billing      `src/lib/billing.ts` — a store that does not exist here.
 *   Cli          `apps/desktop/src/bridge/cli-turns.ts` — spawning a local
 *                agent CLI (#118). Desktop-only by #115's own ruling, and off
 *                here for the same reason `Shell`/`Bash` are: this server has
 *                no operator-confined sandbox around a subprocess it would
 *                spawn on someone else's request, and a CLI reaches a vendor
 *                (#112's `REACH_LOCAL_VIA_THIRD_PARTY`) on THIS machine's
 *                credentials — a peer who is merely served this bundle has
 *                no business spending them.
 *   Commands     `bridge/channels.ts:COMMAND_CHANNEL` — the menu accelerator
 *                channel, and the sharpest of the ten: on desktop it is the
 *                only INBOUND push to a page, so a server that could send on
 *                it would be a way for whoever holds the machine to drive
 *                somebody else's app. It is off by being absent from the wire
 *                entirely — `client-bootstrap.ts:onCommand` accepts the
 *                subscription the contract requires and the server never sends
 *                on it.
 *
 * The first nine are off because they are not registered. That is the whole
 * mechanism, and it is stronger than a filter: `createMainRouter` builds its
 * channel table from the manifest, so a name with no row has no channel, and
 * the call is refused before `PluginHost` is asked about it.
 */
export const OFF_SURFACES: readonly string[] = Object.freeze([
  'Shell',
  'Bash',
  'Mcp',
  'Chats',
  'Personas',
  'Providers',
  'Leaderboard',
  'Billing',
  'Cli',
  'Commands',
]);

/**
 * One implementation per declared plugin. Four fields, four registrations.
 *
 * A record rather than a list of pairs, so the type is what pairs a definition
 * with its implementation and a mismatch is a compile error rather than a
 * registration in the wrong order.
 */
export interface ServerImplementations {
  readonly llama: PluginImplementation;
  readonly onnx: PluginImplementation;
  readonly filesystem: PluginImplementation;
  readonly dsh: PluginImplementation;
}

/**
 * Register exactly {@link SERVER_PLUGINS} on `host`, and nothing else.
 *
 * The loop is over the list, not over the record, so the list is what decides.
 * `PluginHost.register` does the rest of the checking it already does — a
 * declared method with no implementation is refused there, at boot.
 */
export function registerServerSurface(host: PluginHost, implementations: ServerImplementations): void {
  const byName: Record<string, PluginImplementation> = {
    [LLAMA_PLUGIN.name]: implementations.llama,
    [ONNX_PLUGIN.name]: implementations.onnx,
    [FILESYSTEM_PLUGIN.name]: implementations.filesystem,
    [DSH_PLUGIN.name]: implementations.dsh,
  };
  for (const definition of SERVER_PLUGINS) {
    const implementation = byName[definition.name];
    if (implementation === undefined) {
      throw new Error(
        `chatterang server: no implementation for the declared plugin "${definition.name}". ` +
          'SERVER_PLUGINS and ServerImplementations are edited together or not at all.',
      );
    }
    host.register(definition, implementation);
  }
}

/**
 * Refuse to serve a manifest containing a plugin this file does not declare.
 *
 * Run by `startServer` on the manifest the router built, which is the value
 * the served bootstrap embeds and the value the channel table was built from —
 * so this checks the thing that is actually reachable rather than the thing
 * that was intended. A fifth plugin registered anywhere, by any path, stops
 * the process here with the name in the message.
 *
 * @throws Error naming every plugin that is on the wire and should not be.
 */
export function assertServerSurface(manifest: BootManifest): void {
  const declared = new Set(SERVER_PLUGINS.map((plugin) => plugin.name));
  const extra = manifest.plugins.map((plugin) => plugin.name).filter((name) => !declared.has(name));
  if (extra.length === 0) return;
  throw new Error(
    `chatterang server: refusing to serve a bridge that exposes ${extra.join(', ')}. ` +
      'This server registers ' +
      `${SERVER_PLUGINS.map((plugin) => plugin.name).join(', ')} and nothing else; a surface ` +
      'that is on has to be decided in apps/server/src/surface.ts, where the nine that are ' +
      'off are written down next to it.',
  );
}
