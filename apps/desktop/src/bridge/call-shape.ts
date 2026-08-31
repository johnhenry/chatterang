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
 *
 * IT IS LLAMA.CPP'S POLICY, NOT THE BOUNDARY'S. `host-runtime.ts` knows how to
 * serve any plugin and holds no method names; the required-field table below
 * and the opacity table beside it are what makes one of those plugins
 * llama.cpp. A second engine brings its own pair, under its own names, and a
 * shared table would silently apply `generate`'s llama fields to an ONNX
 * method that happens to be spelled the same way.
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

/**
 * Methods whose ENGINE failure message must not cross the boundary verbatim.
 *
 * DEFECT [8], the second half — see `ServeOptions.opaqueFailures` for the
 * reasoning. `load` is the only llama.cpp method that opens a file the renderer
 * named, so it is the only entry: blanketing every method would cost every
 * diagnostic in the app for nothing.
 *
 * The cost is real and is accepted rather than hidden: a genuine load failure
 * (a truncated download, a model too large for memory) now reads the same as a
 * wrong file. The engine's own words are one `warn` away for anyone debugging,
 * and a diagnostic that is also an oracle is not a diagnostic worth keeping.
 */
export const LLAMA_OPAQUE_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  load: 'The model could not be loaded. Check that the file is a complete GGUF model in the app’s model folder.',
});

/**
 * Everything `host-runtime.ts` needs to serve llama.cpp, as one value.
 *
 * Exported as a bundle so `host/entry.ts` and the tests register the plugin
 * with the SAME policy. Passing the two pieces separately at each call site is
 * how one of them ends up missing from the process that ships.
 */
export const LLAMA_HOST_POLICY: {
  readonly shape: (method: string, args: readonly unknown[]) => void;
  readonly opaqueFailures: Readonly<Record<string, string>>;
} = Object.freeze({
  shape: assertCallShape,
  opaqueFailures: LLAMA_OPAQUE_FAILURES,
});
