/**
 * The structured-clone guard.
 *
 * Every value crossing either boundary is serialized by the structured clone
 * algorithm, which has two failure modes and they are not equally visible:
 *
 *   LOUD  — a function, a Proxy, an `AbortSignal` (any `EventTarget`) throws
 *           `DataCloneError`. Annoying, but it tells you.
 *   QUIET — a class instance is cloned as a PLAIN OBJECT. The data survives,
 *           the prototype does not. `new AbortController().signal` would throw,
 *           but `new LoadedHandle(...)` arrives looking right and behaving
 *           like a record, and the method call that used to work is now
 *           `undefined is not a function` three frames away.
 *
 * The quiet one is the reason this file exists. `assertCloneable` walks the
 * value before it is posted and refuses BOTH, naming the path and what it
 * found. A boundary that drops half a value is worse than one that rejects it.
 *
 * The allowlist below is the set of things structured clone genuinely
 * round-trips with identity intact. Everything else is refused, including
 * types clone happens to support but that have no business in this protocol.
 */

/** Thrown when a value cannot cross a boundary intact. */
export class NotCloneableError extends Error {
  override readonly name = 'NotCloneableError';
  readonly code = 'NOT_CLONEABLE';
  /** Dotted path from the root of the checked value, e.g. `options.sampler`. */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path} cannot cross the process boundary: ${reason}`);
    this.path = path;
  }
}

/** Constructors structured clone round-trips with identity intact. */
const CLONEABLE_CLASSES: readonly string[] = [
  'Date',
  'RegExp',
  'Map',
  'Set',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
];

function describeValue(value: object): string {
  const name = value.constructor?.name;
  return typeof name === 'string' && name.length > 0 ? name : 'an object with a custom prototype';
}

/**
 * Refuse anything that would not survive the boundary as itself.
 *
 * @param value - the value about to be posted.
 * @param path - label for the root, used to build the reported path.
 * @throws NotCloneableError naming the exact path and the reason.
 */
export function assertCloneable(value: unknown, path = 'value'): void {
  walk(value, path, new Set());
}

function walk(value: unknown, path: string, seen: Set<object>): void {
  switch (typeof value) {
    case 'undefined':
    case 'boolean':
    case 'number':
    case 'string':
    case 'bigint':
      return;
    case 'function':
      throw new NotCloneableError(
        path,
        'functions are not cloneable. A callback cannot cross a process boundary; ' +
          'send a correlation id and subscribe to an event instead.',
      );
    case 'symbol':
      throw new NotCloneableError(path, 'symbols are not cloneable.');
    default:
      break;
  }
  if (value === null) return;

  const object = value as object;
  // A cycle is legal for structured clone; visiting it twice is not our
  // problem, and refusing it would reject a legitimate payload.
  if (seen.has(object)) return;
  seen.add(object);

  if (Array.isArray(object)) {
    for (const [index, item] of object.entries()) walk(item, `${path}[${index}]`, seen);
    return;
  }

  const prototype: unknown = Object.getPrototypeOf(object);
  if (prototype === Object.prototype || prototype === null) {
    for (const [key, item] of Object.entries(object)) walk(item, `${path}.${key}`, seen);
    return;
  }

  const name = object.constructor?.name;
  if (typeof name === 'string' && CLONEABLE_CLASSES.includes(name)) {
    // Errors carry a `message`/`code` we do not need to walk; the typed arrays
    // and buffers hold no references. Neither can hide an uncloneable child.
    return;
  }

  throw new NotCloneableError(
    path,
    `${describeValue(object)} is a class instance. Structured clone would strip its ` +
      'prototype and deliver a plain object, so the far side would receive something ' +
      'that looks right and is not. Convert it to a plain record before sending.',
  );
}
