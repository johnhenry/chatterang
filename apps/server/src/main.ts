/**
 * The headless profile's entry point: roots, hosts, fleet, listen.
 *
 * Deliberately thin, for the same reason `apps/desktop/src/main.ts` is: every
 * decision it could hold lives somewhere a test can import — the binding in
 * `binding.ts`, the policy in `policy.ts`, the routing in `http.ts`, the
 * bridge in `apps/desktop/src/bridge`. What is left here is the wiring that
 * needs a real process: forking two children, creating four directories, and
 * printing one line.
 *
 * WHY THE MODEL ROOT IS NOT GUESSED. `--root` is required and there is no
 * default. The desktop shell derives its roots from `app.getPath('userData')`,
 * which is Electron telling it where this application's private storage is; a
 * headless process has no such authority and picking `~/.chatterang` would be
 * inventing one. `host/entry.ts` makes the same refusal about the same
 * directory and says why: "quietly picking a directory would be a confinement
 * to the wrong place — which reads as a working guard and is not one."
 *
 * THE DIRECTORY LAYOUT IS THE DESKTOP'S, ON PURPOSE:
 *
 *   <root>/files/data              Directory.Data
 *   <root>/files/data/models       the host's model root — INSIDE Data
 *   <root>/files/cache             Directory.Cache
 *   <root>/server-token            the operator token, 0600
 *
 * The containment — Data being the PARENT of the model root — is what makes a
 * downloaded model loadable: `src/lib/download.ts` writes to `models/<engine>/
 * <id>` under `Directory.Data` and stores what `getUri` answers, and the host
 * confines `LlamaCpp.load` to the model root. A server that broke that
 * invariant would download weights it could never open.
 */

import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  DSH_PLUGIN,
  FILESYSTEM_PLUGIN,
  HostFleet,
  LLAMA_ENGINE,
  LLAMA_PLUGIN,
  ONNX_ENGINE,
  ONNX_PLUGIN,
  PluginHost,
} from '@chatterang/desktop/bridge';
import type { DshStatus, FleetEntry, HostHandle } from '@chatterang/desktop/bridge';
import type { SessionRegistry } from './sessions.js';
import { createFilesystemPlugin } from '@chatterang/desktop/fs/filesystem';

import { asTlsMaterial, parseArgv, resolveBinding } from './binding.js';
import type { ServerBinding } from './binding.js';
import { startServer } from './index.js';
import { readOrCreateToken } from './token.js';
import { TOKEN_QUERY } from './wire.js';

/** Same subdirectory name `src/lib/download.ts` writes into. */
const MODEL_DIR = 'models';

interface Layout {
  readonly data: string;
  readonly cache: string;
  readonly models: string;
  readonly tokenFile: string;
}

/**
 * Create every directory before anything can ask for one.
 *
 * `confineRealPath` begins with `realpathSync(root)` and returns null when
 * that throws, so a root that does not exist refuses EVERY path under it —
 * including the `mkdir` that would have created it.
 */
function layout(root: string): Layout {
  const files = join(root, 'files');
  const data = join(files, 'data');
  const cache = join(files, 'cache');
  const models = join(data, MODEL_DIR);
  for (const directory of [data, cache, models]) mkdirSync(directory, { recursive: true });
  // Symlinks resolved once, here. `getUri` answers a realpath'd path and
  // `confineModelPath` compares lexically against whatever root string it was
  // handed; hand it an unresolved one and every path getUri returns is refused
  // at load. On macOS `/tmp` is a symlink to `/private/tmp`, so this is not
  // hypothetical for anyone who points `--root` at a temporary directory.
  return {
    data: realpathSync(data),
    cache: realpathSync(cache),
    models: realpathSync(models),
    tokenFile: join(root, 'server-token'),
  };
}

/**
 * Start one inference host as a Node child process.
 *
 * `serialization: 'advanced'` is not optional. Node's default IPC serializer is
 * JSON, which would silently turn a typed array into an object with numeric
 * keys somewhere inside a plugin payload; 'advanced' is the V8 structured
 * clone, which is what Electron's `utilityProcess` uses and what
 * `bridge/clone.ts` guards against. The two transports must agree, or the
 * desktop and the server disagree about what a call means.
 *
 * `stdio: 'pipe'` and a tag, so the host's output cannot land in a log the
 * operator did not ask for without saying which process it came from.
 */
function spawnInferenceHost(hostBundle: string, modelRoot: string, engineName: string): HostHandle {
  const child = fork(hostBundle, [modelRoot, engineName], {
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const tag = `[inference:${engineName}]`;
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`${tag} ${chunk.toString()}`));
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`${tag} ${chunk.toString()}`));

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  return {
    link: {
      postMessage: (message) => {
        child.send(message as object);
      },
      onMessage: (listener) => {
        child.on('message', (message: unknown) => listener(message));
      },
      onClose: (listener) => {
        child.once('exit', (code: number | null) => listener(`exit code ${String(code)}`));
      },
    },
    kill: () => {
      if (exited) return;
      child.kill();
    },
  };
}

/**
 * The session registry, once the server owns one.
 *
 * A forward reference, because `PluginHost` needs a delivery function at
 * construction and the registry is created by `startServer` — which needs the
 * plugin host. Until the first connection there is nothing to deliver to, and
 * `false` is the correct answer to "did that event reach a renderer?" then.
 */
let sessionsRef: SessionRegistry | undefined;

function describe(binding: ServerBinding, origin: string, tokenValue: string | null): string[] {
  const lines = [`serving ${origin}`];
  if (binding.kind === 'loopback') {
    lines.push(
      'bound to 127.0.0.1 with no token: only this machine can reach it. Binding anywhere ' +
        'else requires --tls-key/--tls-cert, and the token below.',
    );
  } else if (tokenValue !== null) {
    // Printed ONCE, on the run that created it. Every later start says where
    // the file is instead: a secret echoed at every boot ends up in the
    // scrollback of every terminal the operator has ever used.
    //
    // `0.0.0.0` and `::` are bind addresses, not places to browse to — the
    // origin printed above is the honest report of what was bound, and this
    // line has to be something an operator can paste. Only they know which of
    // this machine's names they reach it by.
    const wildcard = /^(https?:\/\/)(0\.0\.0\.0|\[::\])(:|$)/.exec(origin);
    const where =
      wildcard === null ? `${origin}/` : `${wildcard[1] ?? ''}<this-machine>${origin.slice((wildcard[1] ?? '').length + (wildcard[2] ?? '').length)}/`;
    lines.push(`open this once to authenticate: ${where}?${TOKEN_QUERY}=${tokenValue}`);
  } else {
    lines.push('authentication required; the token is in <root>/server-token (mode 0600).');
  }
  return lines;
}

async function main(): Promise<void> {
  const options = parseArgv(process.argv.slice(2));
  if (options.root === undefined) {
    throw new Error(
      'chatterang server: --root is required. It is where the model directory, the cache and ' +
        'the operator token live, and a server that guessed it would confine downloads to one ' +
        'directory while the inference host opened another.',
    );
  }
  const root = resolve(options.root);
  const paths = layout(root);

  const bundleRoot = resolve(options.bundle ?? join(process.cwd(), 'dist'));
  if (!existsSync(join(bundleRoot, 'index.html'))) {
    throw new Error(
      `chatterang server: no index.html under ${bundleRoot}. Build the bundle with ` +
        '`npm run build:web`, or point --bundle at a directory that has one.',
    );
  }

  const hostBundle = resolve(
    options.hosts ?? join(process.cwd(), 'apps/desktop/build/host.mjs'),
  );
  if (!existsSync(hostBundle)) {
    throw new Error(
      `chatterang server: no inference host bundle at ${hostBundle}. Build it with ` +
        '`npm run desktop:build`, or point --hosts at one. The server refuses to start ' +
        'without inference rather than serve a page whose plugin calls have nowhere to go.',
    );
  }

  let created = false;
  const binding = resolveBinding(options, {
    tls: (keyPath, certPath) =>
      asTlsMaterial(readFileSync(keyPath, 'utf8'), readFileSync(certPath, 'utf8')),
    token: () => {
      const answer = readOrCreateToken(paths.tokenFile);
      created = answer.created;
      return answer.token;
    },
  });

  const log = (line: string): void => console.log(`[chatterang-server] ${line}`);

  const pluginHost = new PluginHost(
    (senderId, payload) => sessionsRef?.deliver(senderId, payload) ?? false,
    // The platform id travels from here to `Capacitor.getPlatform()` in the
    // page and to the capability row `src/lib/platform.ts` looks up by it.
    'server',
  );

  const FLEET: readonly FleetEntry[] = [
    { engine: LLAMA_ENGINE, host: 'llama' },
    // Same relaxed liveness the desktop shell gives this host, and for the
    // same measured reason: `InferenceSession.run` blocks its process's event
    // loop, so a long ONNX run is indistinguishable from a wedged host on any
    // shorter budget.
    { engine: ONNX_ENGINE, host: 'onnx', policy: { pingTimeoutMs: 60_000 } },
  ];

  const fleet = new HostFleet({
    spawn: (hostName) => spawnInferenceHost(hostBundle, paths.models, hostName),
    entries: FLEET,
    notify: (pluginName, eventName, data, ownerId) =>
      pluginHost.notifyListeners(pluginName, eventName, data, ownerId),
    onBoot: (hostName, status) => {
      log(
        status.mounted
          ? `${hostName}: DSH tree mounted: services ${status.services.join(', ')}; routes ${status.routes.join(', ')}`
          : `${hostName}: DSH tree did NOT mount: ${status.error ?? 'unknown reason'}`,
      );
    },
    warn: (hostName, message) => console.warn(`[chatterang-server:${hostName}] ${message}`),
  });

  pluginHost.register(LLAMA_PLUGIN, fleet.plugin(LLAMA_PLUGIN.name));
  pluginHost.register(ONNX_PLUGIN, fleet.plugin(ONNX_PLUGIN.name));
  // See `index.ts`: leaving this out does not make the server smaller, it
  // makes model downloads land in the browser's IndexedDB where the process
  // with the GPU cannot read them.
  pluginHost.register(
    FILESYSTEM_PLUGIN,
    createFilesystemPlugin({
      roots: new Map([
        ['DATA', paths.data],
        ['CACHE', paths.cache],
      ]),
    }),
  );
  pluginHost.register(DSH_PLUGIN, {
    getStatus: async (): Promise<DshStatus> => fleet.statusOf(LLAMA_PLUGIN.name),
    listProviders: async (): Promise<{ providers: readonly string[] }> => ({
      providers: fleet.statusOf(LLAMA_PLUGIN.name).routes,
    }),
  });

  const running = await startServer({
    binding,
    bundleRoot,
    pluginHost,
    release: (senderId, reason) => fleet.releaseRenderer(senderId, reason),
    log,
  });
  sessionsRef = running.sessions;

  for (const line of describe(binding, running.origin, created && binding.kind === 'authenticated' ? binding.token.value : null)) {
    log(line);
  }

  const stop = (): void => {
    fleet.dispose();
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch((error: unknown) => {
  console.error(
    `[chatterang-server] refusing to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
