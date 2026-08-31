/**
 * What each inference-host method needs before the engine is allowed to see it.
 *
 * DEFECT [16]. There was no argument validation at this boundary at all, so a
 * caller that passed `modelId` where the contract says `modelPath` got
 * `Cannot read properties of undefined (reading 'toLowerCase')` — an error
 * raised inside node-llama-cpp, flattened onto the host link, flattened again
 * onto the plugin bridge, and delivered to the page with no mention of which
 * method was called or which field was missing. Two process boundaries between
 * the mistake and the message.
 *
 * The check is deliberately NARROW: required fields, and their type. It is not
 * a schema validator and should not become one. The whole value is in the
 * message — naming the method and the field turns a stack-trace artefact into a
 * sentence a caller can act on — and a full validator would add a second
 * definition of the contract that can disagree with `@chatterang/contracts`.
 * Optional fields are left entirely alone; the engine's own defaults are the
 * authority on those.
 *
 * This file imports nothing. It runs in the utility process next to the native
 * addon, and it is exercised directly by `tests/desktop-bridge.test.ts`.
 */

/** One field a method cannot run without. */
interface RequiredField {
  readonly name: string;
  /**
   * Whether the empty string is a legitimate value.
   *
   * True for `prompt` and `text`, where empty is unusual but meaningful.
   * False for every identifier — an empty `handle` or `requestId` names
   * nothing, and letting one through only moves the failure further in.
   */
  readonly mayBeEmpty?: boolean;
}

/**
 * Required fields per method, for EVERY method the host serves.
 *
 * Methods that need nothing are listed with an empty array rather than omitted,
 * so the table is a statement about all ten rather than about the ones someone
 * remembered. A test asserts the key set equals `LLAMA_METHODS`.
 */
export const REQUIRED_ARGUMENTS: Readonly<Record<string, readonly RequiredField[]>> =
  Object.freeze({
    getCapabilities: [],
    getThermalState: [],
    listLoaded: [],
    load: [{ name: 'modelPath' }],
    unload: [{ name: 'handle' }],
    generate: [{ name: 'handle' }, { name: 'prompt', mayBeEmpty: true }, { name: 'requestId' }],
    cancel: [{ name: 'requestId' }],
    tokenize: [{ name: 'handle' }, { name: 'text', mayBeEmpty: true }],
    countTokens: [{ name: 'handle' }, { name: 'text', mayBeEmpty: true }],
    benchmark: [{ name: 'handle' }],
  });

/**
 * Check one call's arguments, or throw a message that says what is wrong.
 *
 * A method with no required fields is not checked at all — including one this
 * table has never heard of, which is the method allowlist's job and not this
 * one's. Two guards in a row disagreeing about which methods exist is how a
 * legitimate call starts being refused for the wrong reason.
 *
 * @param method the method name, already checked against the allowlist.
 * @param args the renderer's arguments, verbatim.
 * @throws Error naming the method and the first field that is wrong.
 */
export function assertCallShape(method: string, args: readonly unknown[]): void {
  const required = REQUIRED_ARGUMENTS[method];
  if (required === undefined || required.length === 0) return;

  const options = args[0];
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error(
      `inference host: "${method}" needs an options object with ` +
        `${required.map((field) => field.name).join(', ')}, but it was ` +
        `${describe(options)}.`,
    );
  }

  const record = options as Record<string, unknown>;
  for (const field of required) {
    const value = record[field.name];
    if (typeof value !== 'string' || (value === '' && field.mayBeEmpty !== true)) {
      throw new Error(
        `inference host: "${method}" needs a ${field.mayBeEmpty === true ? '' : 'non-empty '}` +
          `string "${field.name}", but it was ${describe(value)}. ` +
          `It requires: ${required.map((f) => f.name).join(', ')}.`,
      );
    }
  }
}

/**
 * Name a bad value without quoting it.
 *
 * The type and the emptiness, never the content: this message crosses two
 * boundaries and ends up wherever the renderer logs errors, and one of the
 * fields it describes is `prompt`. Echoing the value back would put a
 * conversation into a log by way of an error message, which is exactly what the
 * logging rule in `main.ts` forbids.
 */
function describe(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (value === '') return 'the empty string';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
