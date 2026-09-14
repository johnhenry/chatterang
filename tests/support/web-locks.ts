/**
 * The Web Locks API, held in memory, with a window per `LockManager`.
 *
 * jsdom has no `navigator.locks`, and Node's is per thread and outlives a test
 * file. `tests/setup.ts` installs a fresh one of these for every file, so what
 * `src/` reads as `navigator.locks` is this file's first window.
 *
 * Every window of an origin shares one set of locks, as two browser tabs do. A
 * test opens another window with `anotherWindow`, loads a module there, and
 * closes it, which lets go of every lock it held as closing a tab does.
 *
 * What is modelled is what `src/lib/blobs.ts` relies on: exclusive and shared
 * modes, `ifAvailable`, a queue granted in order, a lock released when its
 * callback's promise settles, and `query`. A query's answer is taken when it is
 * asked for; `holdQueries` keeps it from being returned, so a test can act
 * between the question and what is done with the answer.
 */

import { vi } from 'vitest';

type Mode = 'exclusive' | 'shared';

interface Entry {
  readonly name: string;
  readonly mode: Mode;
  readonly clientId: string;
}

interface Waiting extends Entry {
  readonly start: () => void;
}

export interface Locks {
  /** Open a window: a `LockManager` whose locks are its own. */
  window(): LockManager;
  /** Close a window: every lock it holds is let go, and nothing it waits for is granted. */
  close(window: LockManager): void;
  /** Answer no `query` until `releaseQueries`. Each answer is still taken when it is asked for. */
  holdQueries(): void;
  releaseQueries(): void;
  /** How many queries are waiting on `holdQueries`. */
  pendingQueries(): number;
}

export function webLocks(): Locks {
  const held: Entry[] = [];
  const queue: Waiting[] = [];
  const clients = new WeakMap<LockManager, string>();
  const closed = new Set<string>();
  let holdingQueries = false;
  const answers: (() => void)[] = [];
  let windows = 0;

  const grantable = (request: Entry, ahead: readonly Entry[]): boolean => {
    const on = held.filter((entry) => entry.name === request.name);
    const before = ahead.filter((entry) => entry.name === request.name);
    return request.mode === 'exclusive'
      ? on.length === 0 && before.length === 0
      : on.every((entry) => entry.mode === 'shared') && before.every((entry) => entry.mode === 'shared');
  };

  const pump = (): void => {
    for (let at = 0; at < queue.length; ) {
      const request = queue[at]!;
      if (grantable(request, queue.slice(0, at))) {
        queue.splice(at, 1);
        request.start();
      } else {
        at += 1;
      }
    }
  };

  const release = (entry: Entry): void => {
    const at = held.indexOf(entry);
    if (at !== -1) held.splice(at, 1);
    pump();
  };

  const window = (): LockManager => {
    windows += 1;
    const clientId = `window-${windows}`;
    const manager = {
      request(name: string, second: unknown, third?: unknown): Promise<unknown> {
        const options = (typeof second === 'function' ? {} : second) as LockOptions;
        const callback = (typeof second === 'function' ? second : third) as (lock: Lock | null) => unknown;
        const mode: Mode = options.mode ?? 'exclusive';
        return new Promise((resolve, reject) => {
          if (closed.has(clientId)) return;
          const run = (lock: Lock | null, entry: Entry | null): void => {
            queueMicrotask(() => {
              let result: Promise<unknown>;
              try {
                result = Promise.resolve(callback(lock));
              } catch (error) {
                result = Promise.reject(error);
              }
              result.then(
                (value) => {
                  if (entry) release(entry);
                  resolve(value);
                },
                (error: unknown) => {
                  if (entry) release(entry);
                  reject(error);
                },
              );
            });
          };
          const request: Waiting = {
            name,
            mode,
            clientId,
            start: () => {
              const entry: Entry = { name, mode, clientId };
              held.push(entry);
              run({ name, mode } as Lock, entry);
            },
          };
          if (options.ifAvailable && !grantable(request, queue)) {
            run(null, null);
            return;
          }
          queue.push(request);
          pump();
        });
      },
      async query(): Promise<LockManagerSnapshot> {
        const snapshot: LockManagerSnapshot = {
          held: held.map(({ name, mode, clientId: id }) => ({ name, mode, clientId: id })),
          pending: queue.map(({ name, mode, clientId: id }) => ({ name, mode, clientId: id })),
        };
        if (holdingQueries) await new Promise<void>((answer) => answers.push(answer));
        return snapshot;
      },
    } as unknown as LockManager;
    clients.set(manager, clientId);
    return manager;
  };

  return {
    window,
    close(manager) {
      const clientId = clients.get(manager);
      if (clientId === undefined) throw new Error('not a window of these locks');
      closed.add(clientId);
      for (let at = queue.length - 1; at >= 0; at -= 1) if (queue[at]!.clientId === clientId) queue.splice(at, 1);
      for (let at = held.length - 1; at >= 0; at -= 1) if (held[at]!.clientId === clientId) held.splice(at, 1);
      pump();
    },
    holdQueries() {
      holdingQueries = true;
    },
    releaseQueries() {
      holdingQueries = false;
      for (const answer of answers.splice(0)) answer();
    },
    pendingQueries: () => answers.length,
  };
}

/** The locks `tests/setup.ts` installed for this file. */
export function installedLocks(): Locks {
  const locks = (globalThis as { __webLocks?: Locks }).__webLocks;
  if (!locks) throw new Error('tests/setup.ts installs Web Locks; it has not run');
  return locks;
}

/** Make `navigator.locks` read as `manager`, or as missing. */
export function setNavigatorLocks(manager: LockManager | undefined): void {
  Object.defineProperty(globalThis.navigator, 'locks', { value: manager, configurable: true, writable: true });
}

/**
 * Load modules as a second window of this origin loads them: its own module
 * graph, the same database, and locks of its own. `load` runs with a fresh
 * module registry, while `navigator.locks` reads as the new window's.
 * `close` shuts the window. Pass `{ locks: false }` for a window on an origin
 * with no Web Locks at all.
 */
export async function anotherWindow<T>(
  load: () => Promise<T>,
  { locks = true }: { locks?: boolean } = {},
): Promise<{ loaded: T; close: () => void }> {
  const all = installedLocks();
  const own = globalThis.navigator.locks;
  const manager = locks ? all.window() : undefined;
  setNavigatorLocks(manager);
  try {
    vi.resetModules();
    const loaded = await load();
    return { loaded, close: () => (manager ? all.close(manager) : undefined) };
  } finally {
    setNavigatorLocks(own);
  }
}
