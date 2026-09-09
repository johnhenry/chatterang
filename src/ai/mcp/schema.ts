/**
 * Validating a tool schema that a third-party MCP server authored.
 *
 * `McpToolDescriptor.inputSchema` is whatever a remote server sent. It reaches
 * `IRTool.parameters` and from there the request body, so until this module
 * existed it travelled the whole way on one `as JSONSchema` — an assertion
 * that checks nothing at runtime.
 *
 * In-process that is a correctness problem with your own tools. Once a turn
 * can be tunnelled to a paired desktop it stops being that: the object is a
 * remote server's JSON, relayed by the phone, decoded by the desktop. The
 * phone is the only place that can decide it is safe to relay.
 *
 * **Rejects, never truncates.** A schema trimmed to fit a bound describes a
 * tool the model will then call wrongly — with arguments the server did not
 * ask for, or missing ones it did. A tool whose schema cannot be vouched for
 * is not offered at all, which is a visible absence rather than a silent
 * misfire.
 *
 * What this is not: a JSON Schema validator. It does not check that the schema
 * is *meaningful*, only that it is safe to hold, serialise and hand onward.
 * A server can still describe its own tool badly; that is between the model
 * and the server.
 */

import type { JSONSchema } from '@johnhenry/aimatey-types';

/**
 * Deepest nesting accepted, counting the root as depth 1.
 *
 * Hand-written schemas sit around 3-4 (`object` → `properties` → a property →
 * `items`). Sixteen leaves generous headroom for a generated one while keeping
 * every walk of the structure trivially bounded.
 */
export const MAX_SCHEMA_DEPTH = 16;

/**
 * Most values — objects, arrays, primitives — in the whole structure.
 *
 * A schema with 100k properties is valid JSON and passes an `as` cast happily.
 * It is also a denial of service against every consumer downstream, including
 * `JSON.stringify` on the send path.
 */
export const MAX_SCHEMA_NODES = 2_000;

/**
 * Keys that are dangerous to walk onto an object.
 *
 * These are legal JSON and legal as a property *name* inside a `properties`
 * map, so a server may send them innocently. The danger is not here — it is in
 * whoever decodes this later, on a runtime we do not control, with code that
 * may assign rather than define. Refusing them at the boundary means no
 * decoder downstream has to be careful.
 */
const UNWALKABLE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type SchemaRejection =
  | 'not-an-object'
  | 'too-deep'
  | 'too-many-nodes'
  | 'unwalkable-key'
  | 'cyclic'
  | 'non-json-value';

export interface SchemaCheck {
  readonly ok: boolean;
  /** Why it was refused. Absent when `ok`. */
  readonly reason?: SchemaRejection;
  /** Where, in dotted path form, for a log line that can be acted on. */
  readonly at?: string;
}

/**
 * Check a server-supplied schema without modifying it.
 *
 * Separate from {@link validateToolSchema} so the reason can be logged; the
 * common path only needs the schema or nothing.
 */
export function checkToolSchema(value: unknown): SchemaCheck {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not-an-object', at: '' };
  }

  let nodes = 0;
  // Identity, not value: a repeated sibling object is fine, an ancestor is a
  // cycle. `JSON.stringify` throws on one of those at send time, which would
  // surface as a failed turn far from its cause.
  const ancestors = new Set<object>();

  function walk(node: unknown, depth: number, path: string): SchemaCheck | null {
    if (++nodes > MAX_SCHEMA_NODES) return { ok: false, reason: 'too-many-nodes', at: path };
    if (depth > MAX_SCHEMA_DEPTH) return { ok: false, reason: 'too-deep', at: path };

    if (node === null) return null;

    switch (typeof node) {
      case 'string':
      case 'boolean':
        return null;
      case 'number':
        // NaN and Infinity are not JSON. `JSON.stringify` turns them into
        // `null` silently, which changes the schema in transit.
        return Number.isFinite(node) ? null : { ok: false, reason: 'non-json-value', at: path };
      case 'object':
        break;
      default:
        // undefined, function, symbol, bigint — all either vanish or throw in
        // JSON, none belong in a schema.
        return { ok: false, reason: 'non-json-value', at: path };
    }

    const object = node as object;
    if (ancestors.has(object)) return { ok: false, reason: 'cyclic', at: path };
    ancestors.add(object);
    try {
      if (Array.isArray(object)) {
        for (const [index, item] of object.entries()) {
          const bad = walk(item, depth + 1, `${path}[${index}]`);
          if (bad) return bad;
        }
        return null;
      }

      // `Reflect.ownKeys` rather than `Object.keys`, so a `__proto__` sent as
      // an own property is seen rather than silently treated as the prototype.
      for (const key of Reflect.ownKeys(object)) {
        if (typeof key === 'symbol') {
          return { ok: false, reason: 'non-json-value', at: `${path}.<symbol>` };
        }
        if (UNWALKABLE_KEYS.has(key)) {
          return { ok: false, reason: 'unwalkable-key', at: path ? `${path}.${key}` : key };
        }
        const bad = walk(
          (object as Record<string, unknown>)[key],
          depth + 1,
          path ? `${path}.${key}` : key,
        );
        if (bad) return bad;
      }
      return null;
    } finally {
      ancestors.delete(object);
    }
  }

  return walk(value, 1, '') ?? { ok: true };
}

/**
 * The schema if it can be relayed safely, otherwise `null`.
 *
 * Replaces the `as JSONSchema` at the MCP tool boundary. A `null` here means
 * the tool is not offered — see the module note on rejecting over truncating.
 */
export function validateToolSchema(value: unknown): JSONSchema | null {
  return checkToolSchema(value).ok ? (value as JSONSchema) : null;
}
