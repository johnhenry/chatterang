/**
 * BroadcastChannel, held in memory, with a window per constructor.
 *
 * `tests/setup.ts` installs a fresh set for every file, so what `src/` reads as
 * `BroadcastChannel` is this file's first window, and no message crosses from
 * one file's windows to another's. `anotherWindow` (web-locks.ts) loads a module
 * graph with a constructor of a window of its own, and closing that window
 * closes every channel made in it.
 *
 * Modelled on what Chromium 152 did in Electron 44, on two windows of one
 * origin, and held to it by `tests/broadcast-channel-fake.test.ts`: a message
 * reaches every other open object bound to the same name, in any window,
 * another object in the posting page included, and never the object that
 * posted it. It is delivered as a task, so nothing hears it in the step it is
 * posted, and nothing closed before then hears it at all.
 */

export interface Channels {
  /** A constructor whose objects belong to a new window, and what closes them all. */
  window(): { BroadcastChannel: typeof BroadcastChannel; close: () => void };
}

interface Bound {
  readonly name: string;
  closed: boolean;
  readonly receive: (data: unknown) => void;
}

export function broadcastChannels(): Channels {
  const bound = new Set<Bound>();

  return {
    window() {
      const made = new Set<{ close: () => void }>();

      class InMemoryBroadcastChannel extends EventTarget {
        readonly name: string;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onmessageerror: ((event: MessageEvent) => void) | null = null;
        private readonly entry: Bound;

        constructor(name: string) {
          super();
          this.name = String(name);
          this.entry = { name: this.name, closed: false, receive: (data) => this.receive(data) };
          bound.add(this.entry);
          made.add(this);
        }

        postMessage(message: unknown): void {
          if (this.entry.closed) throw new DOMException('The channel is closed.', 'InvalidStateError');
          const data = structuredClone(message);
          for (const other of [...bound]) {
            if (other === this.entry || other.closed || other.name !== this.name) continue;
            setTimeout(() => {
              if (!other.closed) other.receive(data);
            }, 0);
          }
        }

        close(): void {
          this.entry.closed = true;
          bound.delete(this.entry);
        }

        private receive(data: unknown): void {
          const event = new MessageEvent('message', { data });
          this.onmessage?.(event);
          this.dispatchEvent(event);
        }
      }

      return {
        BroadcastChannel: InMemoryBroadcastChannel as unknown as typeof BroadcastChannel,
        close: () => {
          for (const channel of made) channel.close();
        },
      };
    },
  };
}

/** The channels `tests/setup.ts` installed for this file. */
export function installedChannels(): Channels {
  const channels = (globalThis as { __broadcastChannels?: Channels }).__broadcastChannels;
  if (!channels) throw new Error('tests/setup.ts installs BroadcastChannel; it has not run');
  return channels;
}

/** Make `BroadcastChannel` read as `constructor`. */
export function setBroadcastChannel(constructor: typeof BroadcastChannel | undefined): void {
  Object.defineProperty(globalThis, 'BroadcastChannel', { value: constructor, configurable: true, writable: true });
}
