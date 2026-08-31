/**
 * What each ONNX Runtime method needs before the engine is allowed to see it.
 *
 * A SEPARATE FILE FROM `call-shape.ts`, ON PURPOSE. That file's header says
 * why: "A second engine brings its own pair, under its own names, and a shared
 * table would silently apply `generate`'s llama fields to an ONNX method that
 * happens to be spelled the same way." This is that second pair. Both engines
 * declare `cancel`, and both happen to require only `requestId` — but that
 * agreement is a coincidence, not a shared definition, and writing it twice is
 * what keeps it from becoming one.
 *
 * The check is deliberately NARROW: required fields and their type, nothing
 * else. The whole value is in the message — naming the method and the field
 * turns a stack trace from two process boundaries away into a sentence a
 * caller can act on — and a full schema validator would be a second definition
 * of the contract, able to disagree with `@chatterang/contracts`.
 *
 * This file imports nothing, the same as its sibling. It runs in the utility
 * process next to the native addon, and it is exercised directly by
 * `tests/desktop-bridge.test.ts`.
 */

/** One field a method cannot run without. */
interface RequiredField {
  readonly name: string;
  /**
   * Whether the empty string is a legitimate value.
   *
   * `prompt` and `text` may be empty — unusual but meaningful. `audio` may NOT:
   * the web shim ignores the field entirely and listens to the microphone, and
   * `src/lib/voice.ts` sends `''` because of that. There is no microphone in
   * the inference host, so an empty payload here is a caller that has not been
   * updated, and it should be told rather than handed a transcript of silence.
   */
  readonly mayBeEmpty?: boolean;
}

/**
 * Required fields per method, for EVERY method the host serves.
 *
 * Methods that need nothing are listed with an empty array rather than
 * omitted, so the table is a statement about all eight rather than about the
 * ones someone remembered. A test asserts the key set equals `ONNX_METHODS`.
 */
export const ONNX_REQUIRED_ARGUMENTS: Readonly<Record<string, readonly RequiredField[]>> =
  Object.freeze({
    getExecutionProviders: [],
    createSession: [{ name: 'task' }, { name: 'modelPath' }],
    releaseSession: [{ name: 'handle' }],
    releaseTask: [{ name: 'task' }],
    transcribe: [{ name: 'handle' }, { name: 'audio' }, { name: 'mediaType' }, { name: 'requestId' }],
    synthesize: [{ name: 'handle' }, { name: 'text', mayBeEmpty: true }, { name: 'requestId' }],
    diffuse: [{ name: 'handle' }, { name: 'prompt', mayBeEmpty: true }, { name: 'requestId' }],
    cancel: [{ name: 'requestId' }],
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
export function assertOnnxCallShape(method: string, args: readonly unknown[]): void {
  const required = ONNX_REQUIRED_ARGUMENTS[method];
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
 * The type and the emptiness, never the content. One of the fields described
 * here is `audio` — a recording of the user — and another is `prompt`. Echoing
 * a value back would put it into a log by way of an error message that crosses
 * two boundaries, which is what the logging rule in `main.ts` forbids.
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
 * DEFECT [8], the second half, under a new method name. `createSession` is the
 * only ONNX method that opens a file the renderer named, and onnxruntime's own
 * load failure is `Load model from <path> failed:Protobuf parsing failed.` —
 * which, forwarded to the page that named the path, is a read primitive: the
 * caller learns from which error it gets whether a file exists and whether it
 * parses as protobuf.
 *
 * The cost is real and accepted rather than hidden: a genuine load failure — a
 * truncated download, a model too large for memory — now reads the same as a
 * wrong file. The engine's own words go to the host's `warn`, which stays
 * inside the utility process.
 */
export const ONNX_OPAQUE_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  createSession:
    'The model could not be loaded. Check that the files are a complete ONNX model in the app’s model folder.',
});

/**
 * Everything `host-runtime.ts` needs to serve ONNX Runtime, as one value.
 *
 * Exported as a bundle so `host/entry.ts` and the tests register the plugin
 * with the SAME policy. Passing the two pieces separately at each call site is
 * how one of them ends up missing from the process that ships.
 */
export const ONNX_HOST_POLICY: {
  readonly shape: (method: string, args: readonly unknown[]) => void;
  readonly opaqueFailures: Readonly<Record<string, string>>;
} = Object.freeze({
  shape: assertOnnxCallShape,
  opaqueFailures: ONNX_OPAQUE_FAILURES,
});
