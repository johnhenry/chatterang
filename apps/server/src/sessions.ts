/**
 * One connected browser tab, and the identity every call is attributed to.
 *
 * WHAT A SESSION IS. It is exactly what a `webContents` is to the desktop
 * shell: an event-stream connection, a numeric `senderId`, and everything the
 * bridge scopes by that id. The mapping is deliberate rather than convenient —
 * `Supervisor` already scopes every generation to an `ownerId` so a second
 * window cannot receive the first window's tokens, and `PluginHost` already
 * namespaces subscription ids per sender so a reloaded page cannot shadow
 * another one's. Giving each connection its own `senderId` is what makes those
 * two existing guarantees apply to two people at two machines instead of two
 * windows on one desk.
 *
 * That is the ONLY tenancy claim this server makes, and it is a small one:
 * a peer cannot receive another peer's tokens, cannot cancel another peer's
 * generation, and cannot see another peer's subscriptions. It says nothing
 * about chats, personas, provider keys or egress grants — none of which exist
 * in this process at all; they live in each browser's own IndexedDB, exactly as
 * they do on the web target. See `apps/server/src/index.ts`.
 *
 * WHY THE ID IS RANDOM AND NOT A COUNTER. The session id is the CSRF token.
 * A cross-origin page can make the browser send cookies; it cannot read the
 * event stream (the browser refuses it a cross-origin `EventSource` body), so
 * it cannot learn the id, so it cannot form a request this server will act on.
 * A predictable `1`, `2`, `3` would hand that straight back.
 */

import { randomBytes } from 'node:crypto';

import type { EventPayload } from '@chatterang/desktop/bridge';

import type { EventFrame, SessionFrame } from './wire.js';

/**
 * Where a session's frames go.
 *
 * `write` returns false when the connection is gone — the same contract
 * `EventDelivery` has, so `PluginHost` prunes a dead subscription without this
 * layer needing to tell it anything.
 */
export interface SessionSink {
  write(chunk: string): boolean;
}

export interface Session {
  /** Unguessable, and the only proof a caller is on this page. */
  readonly id: string;
  /** What the bridge scopes by. Numeric because `PluginHost` keys on numbers. */
  readonly senderId: number;
}

/** One SSE frame, formatted. Kept here so both ends have one spelling. */
export function encodeFrame(frame: SessionFrame | EventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

export class SessionRegistry {
  readonly #byId = new Map<string, { session: Session; sink: SessionSink }>();
  readonly #bySender = new Map<number, string>();
  #nextSenderId = 1;

  /**
   * Start a session on an open event stream.
   *
   * The id is written to the stream immediately, as the first frame: that
   * write is the only way it ever reaches the client, which is what makes it
   * unavailable to a cross-origin caller.
   */
  open(sink: SessionSink): Session {
    const session: Session = { id: randomBytes(16).toString('hex'), senderId: this.#nextSenderId };
    this.#nextSenderId += 1;
    this.#byId.set(session.id, { session, sink });
    this.#bySender.set(session.senderId, session.id);
    sink.write(encodeFrame({ k: 'session', id: session.id }));
    return session;
  }

  /**
   * The session for an id presented by a caller.
   *
   * Returns undefined for anything else — an expired id, a guessed one, or a
   * request that sent none. The caller answers 401; it must NOT fall back to
   * a default session, which would be a way to act without ever having read
   * the stream.
   */
  find(id: string | undefined): Session | undefined {
    if (id === undefined) return undefined;
    return this.#byId.get(id)?.session;
  }

  /**
   * Deliver one event to one session. The {@link EventDelivery} shape.
   *
   * @returns false when the session is gone, which is how `PluginHost` learns
   *   to drop the subscription.
   */
  deliver(senderId: number, payload: EventPayload): boolean {
    const id = this.#bySender.get(senderId);
    if (id === undefined) return false;
    const entry = this.#byId.get(id);
    if (entry === undefined) return false;
    return entry.sink.write(
      encodeFrame({
        k: 'event',
        pluginName: payload.pluginName,
        subscriptionId: payload.subscriptionId,
        eventName: payload.eventName,
        data: payload.data,
      }),
    );
  }

  /**
   * The connection closed.
   *
   * @returns the senderId that is now gone, so the caller can tell the plugin
   *   host and the host fleet — a released renderer is what settles the
   *   sessions and in-flight turns that peer left behind. Missing that call is
   *   the silent leak `HostFleet.releaseRenderer` exists to make hard.
   */
  close(id: string): number | undefined {
    const entry = this.#byId.get(id);
    if (entry === undefined) return undefined;
    this.#byId.delete(id);
    this.#bySender.delete(entry.session.senderId);
    return entry.session.senderId;
  }

  /** Live sessions. Exists so a test can assert absence, not presence. */
  get size(): number {
    return this.#byId.size;
  }
}
