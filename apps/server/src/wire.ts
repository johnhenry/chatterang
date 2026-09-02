/**
 * The server's wire: the four paths, the two header names, and the guard that
 * says what JSON is allowed to carry.
 *
 * ONE PREFIX, AND IT IS NOT A ROUTE PREFIX SOMEONE MIGHT WANT. Everything this
 * server serves that is not a file out of the bundle lives under
 * `/__chatterang/`. The bundle is a single-page app whose router owns every
 * other path, so the API cannot be at `/api` — `resolveBundleRequest` answers
 * an extensionless path with `index.html`, and a route the app might one day
 * add would shadow the API or be shadowed by it.
 *
 * WHY THE WIRE IS JSON AND WHAT THAT COSTS.
 *
 * The desktop bridge crosses two process boundaries with STRUCTURED CLONE, and
 * `bridge/clone.ts` guards it: a value that would arrive with its prototype
 * missing is refused before it is posted, because "a boundary that drops half
 * a value is worse than one that rejects it".
 *
 * This boundary is an http body, so it is JSON, and JSON carries strictly LESS
 * than structured clone. The same rule therefore has to be applied again with
 * a shorter allowlist — `assertJsonWireSafe` below — because the failures are
 * quiet in exactly the same way:
 *
 *   Uint8Array   -> `{"0":1,"1":2}`      an object with numeric keys
 *   Map / Set    -> `{}`                 empty, silently
 *   Date         -> a string             that never becomes a Date again
 *   NaN/Infinity -> `null`
 *   BigInt       -> a THROW from JSON.stringify, nested arbitrarily deep
 *   undefined    -> dropped in an object, `null` in an ARRAY
 *
 * The last one is the reason this guard is not simply "refuse `undefined`".
 * An absent optional property and an explicit `undefined` mean the same thing
 * to every declared method on this wire (`{language: undefined}` and `{}` are
 * the same call), and JSON.stringify already turns one into the other. Inside
 * an ARRAY it is not the same thing at all: the hole becomes `null`, and a
 * caller that gets `null` where it expected a missing element has been handed
 * a corrupted value rather than a refused one. So object properties may be
 * undefined and array elements may not.
 *
 * NOTHING ON THE DECLARED SURFACE NEEDS MORE THAN THIS. Checked against
 * `packages/contracts`: audio crosses as base64 (`TranscribeOptions.audio: string`),
 * images likewise, and model bytes go over `Filesystem.appendFile` as base64
 * because Capacitor's own bridge has always been base64-only. So the JSON wire
 * costs nothing that the contract actually asks for — but a future method that
 * took a `Float32Array` would be REFUSED here rather than silently receiving
 * `{"0":0.1,…}`, which is the entire point of writing this down.
 */

/** Everything this server serves that is not a file out of the bundle. */
export const API_PREFIX = '/__chatterang';

/** The generated script that seeds the page's platform and plugin headers. */
export const BOOTSTRAP_PATH = `${API_PREFIX}/bootstrap.js`;

/** One plugin call, one response. */
export const RPC_PATH = `${API_PREFIX}/rpc`;

/** The event stream, and the thing that creates a session. */
export const EVENTS_PATH = `${API_PREFIX}/events`;

/**
 * The session header, and it does more than name a session.
 *
 * A CUSTOM REQUEST HEADER IS THE CSRF GUARD. A cross-origin `fetch` that sets
 * one is not a "simple request": the browser must preflight it, and this
 * server answers no preflight with permissive CORS headers, so the real
 * request is never sent. Without it, a page on any website the operator has
 * open could POST a form-encoded body to `http://127.0.0.1:8973/__chatterang/rpc`
 * — no preflight, no permission, and the response body unreadable but the
 * SIDE EFFECT already done. On a loopback binding with no token that is the
 * whole attack, and it is why loopback-with-no-token is still not
 * "unauthenticated": the session id is unguessable and unreachable
 * cross-origin.
 */
export const SESSION_HEADER = 'x-chatterang-session';

/** The cookie the one-time `?token=` bootstrap sets. */
export const TOKEN_COOKIE = 'chatterang_token';

/** The query parameter that delivers the token exactly once. */
export const TOKEN_QUERY = 'token';

/**
 * What a client sends to `RPC_PATH`: one of four operations, discriminated.
 *
 * NOT A CHANNEL NAME. `createMainRouter` routes by channel string, and it is
 * emphatic that a table lookup beats a parse — "there is no parsing step in
 * which a crafted name could be pulled apart into a plugin and a method the
 * manifest never declared". Sending the channel over the wire would put the
 * CLIENT in charge of spelling it, so this wire carries the plugin and the
 * method as separate fields and the SERVER composes the channel with the same
 * `methodChannel` the table was built with. The composed string is then looked
 * up in that table and refused if it is not a key, so the property the router
 * relies on is unchanged and the client never names a channel at all.
 */
export type RpcRequest =
  | { readonly k: 'invoke'; readonly plugin: string; readonly method: string; readonly args: readonly unknown[] }
  | {
      readonly k: 'addListener';
      readonly plugin: string;
      readonly event: string;
      readonly subscriptionId: number;
    }
  | { readonly k: 'removeListener'; readonly subscriptionId: number }
  | { readonly k: 'removeAllListeners'; readonly plugin: string };

/**
 * The largest body this server will read.
 *
 * Sized by the one call that is genuinely large: `src/lib/download.ts` streams
 * model weights in 3 MiB pieces and hands each to `Filesystem.appendFile` as
 * base64, which is ~4 MiB of text plus JSON escaping. 32 MiB leaves room for
 * that and refuses anything an order of magnitude past it, so an unauthenticated
 * peer on a loopback binding cannot make this process hold a gigabyte by
 * announcing one.
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** The first frame of the event stream: which session this connection is. */
export interface SessionFrame {
  readonly k: 'session';
  readonly id: string;
}

/** Every later frame: one plugin event for one subscription. */
export interface EventFrame {
  readonly k: 'event';
  readonly pluginName: string;
  readonly subscriptionId: number;
  readonly eventName: string;
  readonly data: unknown;
}

export type StreamFrame = SessionFrame | EventFrame;

/** Thrown when a value cannot cross the JSON wire intact. */
export class NotJsonSafeError extends Error {
  override readonly name = 'NotJsonSafeError';
  readonly code = 'NOT_JSON_SAFE';
  /** Dotted path from the root of the checked value, e.g. `options.audio`. */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path} cannot cross the server wire: ${reason}`);
    this.path = path;
  }
}

const MAX_DEPTH = 64;

/**
 * Refuse anything JSON would mangle rather than carry.
 *
 * @param value the value about to be serialized.
 * @param path what to call it in the failure message.
 * @throws NotJsonSafeError naming the exact path and what was found there.
 */
export function assertJsonWireSafe(value: unknown, path: string, depth = 0): void {
  if (depth > MAX_DEPTH) {
    throw new NotJsonSafeError(path, `nested deeper than ${MAX_DEPTH} levels`);
  }
  if (value === null) return;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      // JSON has no NaN and no Infinity; `JSON.stringify` writes `null` for
      // both, so a wrong number arrives looking like a deliberate absence.
      if (!Number.isFinite(value)) {
        throw new NotJsonSafeError(path, `${String(value)} is not a JSON number`);
      }
      return;
    case 'undefined':
      // Legal only as an object PROPERTY, which the object branch permits by
      // not descending into it. Reaching here means it was an array element, a
      // top-level value, or the caller passed it directly.
      throw new NotJsonSafeError(
        path,
        'undefined is dropped from an object and becomes null in an array',
      );
    case 'bigint':
      throw new NotJsonSafeError(path, 'a bigint cannot be serialized as JSON');
    case 'function':
    case 'symbol':
      throw new NotJsonSafeError(path, `a ${typeof value} has no JSON representation`);
    default:
      break;
  }

  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      assertJsonWireSafe(element, `${path}[${index}]`, depth + 1);
    }
    return;
  }

  // A class instance survives as a plain object with its prototype gone —
  // structured clone's quiet failure, and JSON's too. `bridge/clone.ts` refuses
  // it on the other boundary for the same reason and with the same words.
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'an instance';
    throw new NotJsonSafeError(
      path,
      `${name} is not a plain object; JSON keeps its enumerable fields and loses everything else`,
    );
  }

  for (const [key, property] of Object.entries(value as Record<string, unknown>)) {
    // `undefined` here is the one legal hole: an explicit `undefined` property
    // and an absent one are the same call, and JSON.stringify already makes
    // them identical.
    if (property === undefined) continue;
    assertJsonWireSafe(property, `${path}.${key}`, depth + 1);
  }
}
