/**
 * THE CODEC: deciding what may cross, per field, before anything is serialized.
 *
 * Six fields in the IR are `Record<string, unknown>` or `unknown`, with nothing
 * constraining them to values that survive JSON (#142). `unknown` means "any
 * JavaScript value": a `Date` round-trips to a string, a `Map` to `{}`, a
 * function to absent, and a `BigInt` **throws** inside `JSON.stringify` — an
 * uncaught `TypeError` at the moment of send, which for a queued request fails
 * the queue rather than the turn.
 *
 * Today every value this app puts in those bags is JSON-safe. That is a
 * property of the current code, not of the type, and nothing would notice it
 * changing. This module is what makes it a property of the type.
 *
 * ## The policy, and why it is asymmetric
 *
 * **Outbound refuses. Inbound is quarantined.** Not one rule, on purpose:
 *
 * - Outbound fields are ones *we* write. A payload that changed in transit is
 *   our bug, and a message that cannot be sent faithfully should fail loudly
 *   rather than arrive altered. Same reasoning as `src/ai/mcp/schema.ts`,
 *   which rejects a third-party tool schema rather than truncating it.
 * - Inbound fields arrive from a model or a backend adapter. Refusing those
 *   fails someone else's turn for someone else's mistake, and the turn's text
 *   may be perfectly good. A model emitting odd tool-call JSON should degrade
 *   that turn, not kill it.
 *
 * The asymmetry is stated here rather than left for a reader to infer from two
 * branches that look inconsistent.
 *
 * ## Policy as data
 *
 * {@link FIELD_POLICY} is a table, not a chain of `if`s, so adding a field is a
 * row and the whole policy can be read at once. A branch buried in a function
 * is how a seventh field gets added with no policy at all.
 */

import type { IRWarning } from '@johnhenry/aimatey-types';

/** What may happen to one escape-hatch field. */
export type FieldPolicy =
  /** Fail the whole message. For values this app writes. */
  | 'refuse'
  /** Replace the offending value with something safe and report it. */
  | 'quarantine'
  /** Remove the field entirely and report it. */
  | 'drop';

/**
 * Per-field policy for the IR's six escape hatches, plus `raw`.
 *
 * Paths are dotted from the root of the request or response.
 */
export const FIELD_POLICY: Readonly<Record<string, FieldPolicy>> = Object.freeze({
  // ── Outbound: this app writes these, so a change in transit is our bug ──
  'metadata.custom': 'refuse',
  'messages.metadata': 'refuse',
  // Nothing writes this today. The moment a tunnelled turn reaches a desktop
  // provider this app does not have, it will — and a silently dropped sampler
  // parameter changes the output with nothing downstream able to tell.
  'parameters.custom': 'refuse',

  // ── Inbound: written by a model or an adapter ──
  // A dropped key here is a TOOL ARGUMENT. Dropping it would call the tool
  // wrongly, which is worse than not calling it, so the value is replaced
  // wholesale and the turn is marked rather than silently altered.
  'content.tool_use.input': 'quarantine',

  // `IRChatResponse.raw` is a whole provider payload with no bound, read by
  // nothing in this app. Forwarding it doubles the response for no reader, and
  // it is the provider's own payload unredacted — a privacy surface as well as
  // a size one. It does not cross.
  raw: 'drop',
});

/** Why a value was refused, quarantined or dropped. */
export type CodecReason =
  | 'bigint'
  | 'not-json'
  | 'cyclic'
  | 'unwalkable-key'
  | 'dropped-by-policy';

export class CodecRefusal extends Error {
  constructor(
    readonly path: string,
    readonly reason: CodecReason,
  ) {
    // Names the key. "serialisation error" sends someone reading a stack trace
    // rather than a field name, which is the difference between a five-minute
    // fix and an afternoon.
    super(`Cannot send this message: ${path} is ${describeReason(reason)}`);
    this.name = 'CodecRefusal';
  }
}

function describeReason(reason: CodecReason): string {
  switch (reason) {
    case 'bigint':
      return 'a BigInt, which cannot be serialized';
    case 'not-json':
      return 'a value JSON would change or drop';
    case 'cyclic':
      return 'part of a cycle';
    case 'unwalkable-key':
      return 'using a key that is unsafe for a decoder to walk';
    case 'dropped-by-policy':
      return 'not carried across the tunnel';
  }
}

/** Keys that are dangerous for whoever decodes this to assign onto an object. */
const UNWALKABLE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface Finding {
  readonly path: string;
  readonly reason: CodecReason;
}

/**
 * Find every value under `node` that would not survive JSON unchanged.
 *
 * Reports rather than throwing, so one pass can list all of them — a caller
 * fixing three bad keys one refusal at a time is three round trips.
 */
export function findUnserializable(node: unknown, path = ''): Finding[] {
  const found: Finding[] = [];
  const ancestors = new Set<object>();

  function walk(value: unknown, at: string): void {
    if (value === null) return;

    switch (typeof value) {
      case 'string':
      case 'boolean':
        return;
      case 'bigint':
        // Called out separately because it THROWS rather than degrading, and
        // at the socket rather than here if this module does not catch it.
        found.push({ path: at, reason: 'bigint' });
        return;
      case 'number':
        // NaN and Infinity stringify to `null`, silently.
        if (!Number.isFinite(value)) found.push({ path: at, reason: 'not-json' });
        return;
      case 'object':
        break;
      default:
        // undefined, function, symbol — each vanishes or throws.
        found.push({ path: at, reason: 'not-json' });
        return;
    }

    const object = value as object;
    if (ancestors.has(object)) {
      found.push({ path: at, reason: 'cyclic' });
      return;
    }
    ancestors.add(object);
    try {
      if (Array.isArray(object)) {
        object.forEach((item, index) => walk(item, `${at}[${index}]`));
        return;
      }
      // A Date, Map or Set is an object with no own enumerable keys, so a
      // naive walk finds nothing wrong and JSON quietly changes it.
      const tag = Object.prototype.toString.call(object);
      if (tag !== '[object Object]') {
        found.push({ path: at, reason: 'not-json' });
        return;
      }
      // `Reflect.ownKeys`, so a `__proto__` sent as an own property is seen
      // rather than treated as the prototype.
      for (const key of Reflect.ownKeys(object)) {
        if (typeof key === 'symbol') {
          found.push({ path: `${at}.<symbol>`, reason: 'not-json' });
          continue;
        }
        const child = at ? `${at}.${key}` : key;
        if (UNWALKABLE_KEYS.has(key)) {
          found.push({ path: child, reason: 'unwalkable-key' });
          continue;
        }
        walk((object as Record<string, unknown>)[key], child);
      }
    } finally {
      ancestors.delete(object);
    }
  }

  walk(node, path);
  return found;
}

/** What a quarantined value is replaced with, so the far side sees a marker. */
export const QUARANTINED = Object.freeze({ __chatterang_quarantined: true });

export interface CodecResult<T> {
  readonly value: T;
  /** Non-fatal changes made on the way. Empty when nothing was touched. */
  readonly warnings: readonly IRWarning[];
}

/**
 * Apply a field's policy to a value.
 *
 * Throws {@link CodecRefusal} for `refuse`. Returns a replacement and a warning
 * for `quarantine` and `drop`, so the caller can record what it did.
 */
export function applyPolicy(
  path: string,
  value: unknown,
  policy: FieldPolicy,
): CodecResult<unknown> {
  if (policy === 'drop') {
    return {
      value: undefined,
      warnings: [
        {
          category: 'content-redacted',
          severity: 'info',
          message: `${path} was not carried across the link.`,
          source: 'tunnel-codec',
        },
      ],
    };
  }

  const findings = findUnserializable(value, path);
  if (findings.length === 0) return { value, warnings: [] };

  if (policy === 'refuse') {
    // The first is enough to act on, and every one is in `findings` for a
    // caller that wants to report them together.
    throw new CodecRefusal(findings[0]!.path, findings[0]!.reason);
  }

  return {
    value: QUARANTINED,
    warnings: [
      {
        category: 'content-redacted',
        severity: 'warning',
        message: `${path} could not be sent as written (${describeReason(findings[0]!.reason)}) and was replaced.`,
        source: 'tunnel-codec',
      },
    ],
  };
}
