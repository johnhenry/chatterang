/**
 * AN `IRChatRequest` MUST STILL MEAN THE SAME THING AFTER IT CROSSES A WIRE.
 *
 * Track B puts a JSON hop in the middle of the IR: the phone builds an
 * `IRChatRequest`, the desktop parses one, and both sides must agree on what
 * it says. Nothing in the tree checked that until this file. `JSON.stringify`
 * is not an identity function on the IR's own type surface, and the places it
 * is not are exactly the places nobody thought to look.
 *
 * MEASURED, on the pinned `@johnhenry/aimatey-types@0.4.0`:
 *
 *   typed surface     — every documented field of a fully-populated request
 *                       survives byte-for-byte. That is the good news, and it
 *                       is the reason the rest of this file is worth writing:
 *                       the losses are not spread out, they are concentrated.
 *   escape hatches    — the six `Record<string, unknown>` holes. Nothing types
 *                       these as JSON, so `custom: { seenAt: new Date() }`
 *                       compiles, ships, and arrives as a string.
 *   numbers           — `temperature: NaN`, `maxTokens: Infinity`, `seed: -0`
 *                       arrive as `null`, `null`, `0`. The first two are not
 *                       even `number`, so the type is a lie on the far side.
 *   `undefined`       — dropped. Harmless on typed optionals (every reader in
 *                       the library, `resolveServedModel` included, tests for
 *                       `undefined`); NOT harmless inside a record, whose only
 *                       contract is which keys it has.
 *   `__proto__`       — survives a parse as an own data property. Spreading it
 *                       is safe; `Object.assign`ing it pollutes the target.
 *   depth             — `JSON.parse` accepts an `upstream` chain ~80x deeper
 *                       than `JSON.stringify` can emit. A peer can hand this
 *                       process a provenance it can read but never forward.
 *
 * The comparator here is hand-written on purpose. `expect(a).toEqual(b)` elides
 * undefined-valued keys — it passes on the very first trap — and `toStrictEqual`
 * cannot tell a typed optional (where dropping is fine) from a record key
 * (where it is not). That distinction IS the semantics, so it has to be spelt.
 *
 * Where a value genuinely cannot round-trip, the test asserts the loss rather
 * than papering over it. A red test here would mean the loss changed shape.
 */

import { describe, expect, it } from 'vitest';

import { resolveServedModel, withUpstreamProvenance } from '@johnhenry/aimatey-types';
import type {
  IRChatRequest,
  IRMessage,
  IRMetadata,
  IRParameters,
  IRProvenance,
  IRTool,
  IRWarning,
  JSONSchema,
  MessageContent,
} from '@johnhenry/aimatey-types';

/* ── The transport ──────────────────────────────────────────────────────
 *
 * Exactly what a tunnel does and nothing else: no reviver, no replacer, no
 * normalisation pass. Anything a real hop would add is a fix for something
 * found below, and adding it here would hide the thing being measured.
 */

const wire = <T>(value: T): string => JSON.stringify(value);
const roundTrip = <T>(value: T): T => JSON.parse(wire(value)) as T;

/* ── Semantic equality ──────────────────────────────────────────────────
 *
 * Two rules that a structural deep-equal does not encode:
 *
 * 1. A key that was present-and-undefined and is now absent is EQUIVALENT on
 *    the IR's typed optionals, because every reader in the library asks
 *    `=== undefined` rather than `in`. `resolveServedModel` skips a hop whose
 *    `servedModel` is undefined; `withUpstreamProvenance` calls a provenance
 *    of all-undefined values empty. Neither can tell the two apart, so neither
 *    can a consumer.
 *
 * 2. The same disappearance inside a `Record<string, unknown>` is a LOSS,
 *    because a record has no fields — enumerating its keys is the only thing
 *    a consumer can do with it, and the key set changed.
 *
 * Numbers compare with `Object.is`, so `-0` -> `0` and `NaN` -> `null` are
 * divergences rather than rounding.
 */

/** Every `Record<string, unknown>` reachable from an `IRChatRequest`. */
const ESCAPE_HATCHES: readonly RegExp[] = [
  /^metadata\.custom(\.|$)/, //                      IRMetadata.custom
  /^parameters\.custom(\.|$)/, //                    IRParameters.custom
  /^messages\[\d+\]\.metadata(\.|$)/, //             IRMessage.metadata
  /^tools\[\d+\]\.metadata(\.|$)/, //                IRTool.metadata
  /^messages\[\d+\]\.content\[\d+\]\.input(\.|$)/, // ToolUseContent.input
  /^metadata\.warnings\[\d+\]\.details(\.|$)/, //    IRWarning.details
];

const isUntypedRecord = (path: string): boolean =>
  ESCAPE_HATCHES.some((pattern) => pattern.test(path));

interface Divergence {
  readonly path: string;
  readonly reason: string;
  readonly before: string;
  readonly after: string;
}

/** Stable rendering that keeps the distinctions `JSON.stringify` throws away. */
function render(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return '-0';
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return String(value);
    return String(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return 'function';
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object') {
    const name = Object.getPrototypeOf(value) === null ? 'null-prototype' : value.constructor?.name;
    return name === 'Object' || name === undefined ? 'object' : String(name);
  }
  return String(value);
}

/**
 * What an object *is*, not merely what shape it has.
 *
 * Without this the comparator sleeps through the worst losses in the file: a
 * `Map` and a `Set` both serialise to `{}`, and `Object.keys` says the two are
 * identical. A `Uint8Array` serialises to `{"0":1,"1":2}`, which is key-for-key
 * equal to itself. Structural equality is not semantic equality.
 */
function kindOf(value: object): string {
  if (Array.isArray(value)) return 'array';
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === null) return 'null-prototype';
  if (proto === Object.prototype) return 'plain';
  return value.constructor?.name ?? 'unknown';
}

function compare(before: unknown, after: unknown, path: string, out: Divergence[]): void {
  const bothObjects =
    typeof before === 'object' && before !== null && typeof after === 'object' && after !== null;

  if (!bothObjects) {
    if (typeof before !== typeof after) {
      out.push({ path, reason: 'type changed', before: render(before), after: render(after) });
      return;
    }
    if (!Object.is(before, after)) {
      out.push({ path, reason: 'value changed', before: render(before), after: render(after) });
    }
    return;
  }

  if (kindOf(before) !== kindOf(after)) {
    out.push({ path, reason: 'kind changed', before: render(before), after: render(after) });
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      out.push({
        path,
        reason: 'length changed',
        before: String(before.length),
        after: String(after.length),
      });
      return;
    }
    for (let i = 0; i < before.length; i += 1) {
      compare(before[i], after[i], `${path}[${i}]`, out);
    }
    return;
  }

  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);

  for (const key of keys) {
    const child = path === '' ? key : `${path}.${key}`;
    const hadKey = Object.prototype.hasOwnProperty.call(b, key);
    const hasKey = Object.prototype.hasOwnProperty.call(a, key);

    if (hadKey && !hasKey) {
      // Rule 1 vs rule 2: dropping `undefined` is only a loss where key
      // presence is the contract.
      if (b[key] === undefined && !isUntypedRecord(child)) continue;
      out.push({
        path: child,
        reason: b[key] === undefined ? 'undefined key dropped from record' : 'key dropped',
        before: render(b[key]),
        after: 'absent',
      });
      continue;
    }
    if (!hadKey && hasKey) {
      out.push({ path: child, reason: 'key appeared', before: 'absent', after: render(a[key]) });
      continue;
    }
    compare(b[key], a[key], child, out);
  }
}

/** The divergences a JSON hop introduces, deepest-path-first for readability. */
function divergences(value: unknown): Divergence[] {
  const out: Divergence[] = [];
  compare(value, roundTrip(value), '', out);
  return out;
}

const paths = (found: readonly Divergence[]): string[] => found.map((d) => d.path).sort();

/* ── A representative request ───────────────────────────────────────────
 *
 * Every documented field of `IRChatRequest`, every `MessageContent` variant,
 * both `source` shapes, both `ToolResultContent.content` shapes, the object
 * form of `toolChoice`, a `JSONSchema` deep enough to nest, a warning, and a
 * three-hop provenance chain. Built by a factory so a case can perturb one
 * field without restating the rest.
 */

const SCHEMA: JSONSchema = {
  type: 'object',
  description: 'Look up the weather.',
  properties: {
    location: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[\\w ,.-]+$' },
    unit: { type: 'string', enum: ['celsius', 'fahrenheit'], default: 'celsius' },
    days: { type: 'integer', minimum: 1, maximum: 14 },
    tags: { type: 'array', items: { type: ['string', 'null'] } },
  },
  required: ['location'],
  additionalProperties: false,
  examples: [{ location: 'Reykjavik', unit: 'celsius' }],
};

const CONTENT: readonly MessageContent[] = [
  { type: 'text', text: 'What is on this receipt? Amount: 1€ — café 🧋' },
  { type: 'image', source: { type: 'url', url: 'https://example.invalid/receipt.png' } },
  { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' } },
  { type: 'audio', source: { type: 'url', url: 'https://example.invalid/note.m4a' }, transcript: 'hi' },
  {
    type: 'document',
    source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' },
    filename: 'receipt.pdf',
  },
  {
    type: 'video',
    source: { type: 'url', url: 'https://example.invalid/clip.mp4' },
    poster: 'https://example.invalid/clip.jpg',
  },
  { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'Oslo', days: 3 } },
  { type: 'tool_result', toolUseId: 'call_1', content: '4°C', isError: false },
  {
    type: 'tool_result',
    toolUseId: 'call_2',
    content: [{ type: 'text', text: 'partial' }],
    isError: true,
  },
];

const MESSAGES: readonly IRMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: CONTENT, name: 'ada', metadata: { clientTurn: 7, retry: false } },
  { role: 'assistant', content: 'It is 4 degrees.' },
  { role: 'tool', content: '{"ok":true}', name: 'get_weather' },
];

const TOOLS: readonly IRTool[] = [
  {
    name: 'get_weather',
    description: 'Current conditions for a place.',
    parameters: SCHEMA,
    metadata: { source: 'mcp', server: 'weather', readOnly: true },
  },
];

const PARAMETERS: IRParameters = {
  model: 'qwen2.5-7b-instruct',
  temperature: 0.7,
  maxTokens: 2048,
  topP: 0.95,
  topK: 40,
  frequencyPenalty: 0.1,
  presencePenalty: -0.2,
  stopSequences: ['\n\nUser:', '</done>'],
  seed: 12345,
  user: 'local',
  custom: { mirostat: 2, repeatPenalty: 1.05, grammar: null },
};

const WARNING: IRWarning = {
  category: 'parameter-clamped',
  severity: 'warning',
  message: 'temperature clamped to backend maximum',
  field: 'parameters.temperature',
  originalValue: 3.5,
  transformedValue: 2,
  source: 'llama-cpp',
  details: { max: 2, min: 0 },
};

/** phone -> desktop -> llama-cpp: only the far hop served. */
const CHAIN: IRProvenance = {
  frontend: 'openai',
  backend: 'tunnel',
  router: 'phone-router',
  middleware: ['taint', 'resilience'],
  upstream: {
    frontend: 'openai',
    backend: 'desktop-bridge',
    router: 'desktop-router',
    upstream: {
      backend: 'llama-cpp',
      servedModel: 'qwen2.5-7b-instruct-q4_k_m',
    },
  },
};

const METADATA: IRMetadata = {
  requestId: '01J8Z9K3Q7X5V2N4M6P8R0T1W3',
  providerResponseId: 'chatcmpl-abc123',
  timestamp: 1_757_000_000_000,
  provenance: CHAIN,
  warnings: [WARNING],
  principal: 'device:local',
  custom: { appVersion: '1.4.2', surface: 'mobile' },
};

const makeRequest = (overrides: Partial<IRChatRequest> = {}): IRChatRequest => ({
  messages: MESSAGES,
  tools: TOOLS,
  toolChoice: { name: 'get_weather' },
  responseFormat: { type: 'json_schema', schema: SCHEMA, strict: true },
  parameters: PARAMETERS,
  metadata: METADATA,
  stream: true,
  streamMode: 'delta',
  ...overrides,
});

/* ── 0. The comparator itself ───────────────────────────────────────────
 *
 * If the tool is blind, everything it reports is worthless. These two cases
 * are the fault injection that stays in the file: they prove the comparator
 * sees a loss that `toEqual` sleeps through, and that it does not invent one.
 */

describe('semantic comparator', () => {
  it('reports nothing for a value that truly survives', () => {
    expect(divergences({ a: 1, b: 'x', c: [true, null], d: { e: 0.5 } })).toEqual([]);
  });

  it('sees the losses, one per trap', () => {
    const found = divergences({
      metadata: { custom: { gone: undefined, kept: 1 } },
      parameters: { temperature: NaN, seed: -0, topK: Infinity },
    });
    expect(paths(found)).toEqual([
      'metadata.custom.gone',
      'parameters.seed',
      'parameters.temperature',
      'parameters.topK',
    ]);

    // The rendering is part of the tool: a report that says `0 -> 0` is worse
    // than no report, because it reads as a comparator bug rather than a loss.
    const byPath = new Map(found.map((d) => [d.path, d]));
    expect(byPath.get('parameters.seed')).toMatchObject({ before: '-0', after: '0' });
    expect(byPath.get('parameters.temperature')).toMatchObject({ before: 'NaN', after: 'null' });
    expect(byPath.get('parameters.topK')).toMatchObject({ before: 'Infinity', after: 'null' });
    expect(byPath.get('metadata.custom.gone')).toMatchObject({
      before: 'undefined',
      after: 'absent',
    });
  });

  it('sees a class erased into a plain object, which shape alone cannot', () => {
    // `new Map([['a', 1]])` and `{}` have the same keys and the same values —
    // namely none. Only the kind check separates them.
    const found = divergences({ metadata: { custom: { m: new Map([['a', 1]]) } } });
    expect(paths(found)).toEqual(['metadata.custom.m']);
    expect(found[0]?.before).toBe('Map');
    expect(found[0]?.after).toBe('object');
  });

  it("catches what vitest's own toEqual elides", () => {
    // The naive assertion. It passes, which is why it is not the assertion
    // this file uses anywhere else.
    expect({ custom: { k: undefined } }).toEqual({ custom: {} });
    expect(paths(divergences({ metadata: { custom: { k: undefined } } }))).toEqual([
      'metadata.custom.k',
    ]);
  });
});

/* ── 1. The typed surface ───────────────────────────────────────────────*/

describe('IRChatRequest over a JSON hop', () => {
  it('round-trips a fully populated request with no loss of meaning', () => {
    expect(divergences(makeRequest())).toEqual([]);
  });

  it('is byte-stable: re-serialising the parsed request reproduces the wire form', () => {
    // Not implied by the above. A hop that parses and forwards must emit the
    // same bytes, or a signature or content hash over the payload breaks.
    const sent = wire(makeRequest());
    expect(wire(JSON.parse(sent) as IRChatRequest)).toBe(sent);
  });

  it('keeps every MessageContent variant discriminable', () => {
    const back = roundTrip(makeRequest());
    const user = back.messages[1];
    expect(user).toBeDefined();
    const content = user?.content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as readonly MessageContent[]).map((c) => c.type)).toEqual(
      CONTENT.map((c) => c.type),
    );
  });

  it('keeps astral and combining characters intact', () => {
    const text = 'café 🧋 नमस्ते ‍';
    expect(divergences(makeRequest({ messages: [{ role: 'user', content: text }] }))).toEqual([]);
  });

  it('keeps a lone surrogate intact, because JSON.stringify escapes it', () => {
    // ES2019 well-formed stringify. Worth locking: an unpaired surrogate is
    // exactly what a truncated streaming delta produces, and a transport that
    // replaced it with U+FFFD would corrupt the resumed text.
    const lone = `head\uD800tail`;
    const back = roundTrip({ metadata: { custom: { lone } } });
    expect(back.metadata.custom.lone).toBe(lone);
    expect(wire({ lone })).toContain('\\ud800');
  });
});

/* ── 2. Provenance, the privacy surface ─────────────────────────────────*/

describe('provenance survives the hop it exists to describe', () => {
  it('carries a three-hop chain across unchanged', () => {
    expect(divergences(CHAIN)).toEqual([]);
  });

  it('does not flatten the chain: each hop keeps its own backend', () => {
    const back = roundTrip(CHAIN);
    expect(back.backend).toBe('tunnel');
    expect(back.upstream?.backend).toBe('desktop-bridge');
    expect(back.upstream?.upstream?.backend).toBe('llama-cpp');
    expect(back.upstream?.upstream?.upstream).toBeUndefined();
  });

  it('resolveServedModel gives the same answer on both sides', () => {
    const chains: ReadonlyArray<readonly [string, IRProvenance | undefined, string | undefined]> = [
      ['single serving hop', { backend: 'openai', servedModel: 'gpt-4-0613' }, 'gpt-4-0613'],
      ['proxy over server', CHAIN, 'qwen2.5-7b-instruct-q4_k_m'],
      ['nobody reported', { backend: 'cohere' }, undefined],
      ['explicit undefined', { backend: 'cohere', servedModel: undefined }, undefined],
      ['empty string is not a report', { backend: 'x', servedModel: '' }, undefined],
      ['nearest wins over far', { backend: 'p', servedModel: 'near', upstream: { servedModel: 'far' } }, 'near'],
      ['skips a silent near hop', { backend: 'p', upstream: { backend: 'q', servedModel: 'far' } }, 'far'],
      ['empty link stops nothing', { backend: 'p', upstream: { upstream: { servedModel: 'far' } } }, 'far'],
    ];

    for (const [label, chain, expected] of chains) {
      expect(resolveServedModel(chain), `${label} before`).toBe(expected);
      expect(resolveServedModel(roundTrip(chain)), `${label} after`).toBe(expected);
    }
  });

  it('agrees with withUpstreamProvenance about an empty far side', () => {
    // A hop that normalises with the helper drops an all-undefined upstream;
    // a hop that spreads by hand ships `upstream: {}`. JSON preserves the
    // difference, so the two hops must still read the same.
    const normalised = withUpstreamProvenance({ backend: 'tunnel' }, { servedModel: undefined });
    const naive: IRProvenance = { backend: 'tunnel', upstream: {} };

    expect(normalised.upstream).toBeUndefined();
    expect(roundTrip(naive).upstream).toEqual({});
    expect(resolveServedModel(roundTrip(normalised))).toBe(resolveServedModel(roundTrip(naive)));
  });

  it('leaves servedModel absent rather than substituting the requested model', () => {
    // The distinction the field exists for. A provider that reports nothing
    // must stay distinguishable from one that reported the requested model,
    // and `undefined` -> absent does not blur that.
    const request = makeRequest({
      parameters: { model: 'gpt-4' },
      metadata: { ...METADATA, provenance: { backend: 'bedrock', servedModel: undefined } },
    });
    const back = roundTrip(request);
    expect(back.metadata.provenance).toBeDefined();
    expect('servedModel' in (back.metadata.provenance as object)).toBe(false);
    expect(resolveServedModel(back.metadata.provenance)).toBeUndefined();
    expect(back.parameters?.model).toBe('gpt-4');
  });
});

/* ── 3. `undefined` versus absent ───────────────────────────────────────*/

describe('undefined versus absent', () => {
  it('is not a loss on a typed optional', () => {
    const request = makeRequest({
      tools: undefined,
      toolChoice: undefined,
      responseFormat: undefined,
      stream: undefined,
      streamMode: undefined,
    });
    expect(divergences(request)).toEqual([]);
    const back = roundTrip(request);
    expect('tools' in back).toBe(false);
    expect(back.tools).toBeUndefined();
  });

  it('IS a loss inside a record, where the key set is the whole contract', () => {
    const request = makeRequest({
      metadata: { ...METADATA, custom: { surface: 'mobile', experiment: undefined } },
    });
    expect(paths(divergences(request))).toEqual(['metadata.custom.experiment']);

    const back = roundTrip(request);
    expect(Object.keys(METADATA.custom ?? {}).length).toBe(2);
    expect(Object.keys(back.metadata.custom ?? {})).toEqual(['surface']);
    // Both read `undefined`; only enumeration can tell them apart, and that is
    // the one thing a consumer of an untyped record has.
    expect(back.metadata.custom?.experiment).toBeUndefined();
  });
});

/* ── 4. Numbers the IR types as `number` and JSON does not have ─────────*/

describe('non-finite and signed-zero numbers', () => {
  it('turns NaN and Infinity into null, so the far side is not even a number', () => {
    const request = makeRequest({
      parameters: {
        temperature: NaN,
        maxTokens: Infinity,
        topP: -Infinity,
        frequencyPenalty: -0,
      },
    });

    expect(paths(divergences(request))).toEqual([
      'parameters.frequencyPenalty',
      'parameters.maxTokens',
      'parameters.temperature',
      'parameters.topP',
    ]);

    const back = roundTrip(request);
    // The type says `number | undefined`. It is neither.
    expect(back.parameters?.temperature).toBeNull();
    expect(typeof back.parameters?.temperature).toBe('object');
    expect(back.parameters?.maxTokens).toBeNull();
    expect(back.parameters?.topP).toBeNull();
    // -0 is quietly normalised. Harmless for a penalty; not harmless for a
    // `seed`, where a caller may be checking `Object.is(seed, -0)` to mean
    // "unset" the way some samplers do.
    expect(Object.is(back.parameters?.frequencyPenalty, -0)).toBe(false);
    expect(back.parameters?.frequencyPenalty).toBe(0);
  });

  it('destroys the very value a parameter-clamped warning exists to record', () => {
    // `IRWarning.originalValue` is `unknown` and holds the pre-clamp value.
    // The values that get clamped are the out-of-range ones, and out-of-range
    // is exactly what JSON cannot carry.
    const warning: IRWarning = {
      category: 'parameter-clamped',
      severity: 'warning',
      message: 'temperature was not finite',
      field: 'parameters.temperature',
      originalValue: Infinity,
      transformedValue: 2,
    };
    const back = roundTrip({ metadata: { warnings: [warning] } });
    expect(back.metadata.warnings[0]?.originalValue).toBeNull();
    // The far side is told a clamp happened and cannot learn from what.
    expect(back.metadata.warnings[0]?.transformedValue).toBe(2);
  });

  it("loses a peer's integer identity above 2^53, which a seed can reach", () => {
    // Driven from wire TEXT on purpose. Written as a JS numeric literal,
    // `9_007_199_254_740_993` is ALREADY 9007199254740992 before JSON is
    // reached — the source parser clamped it — so the literal-driven version of
    // this test passes against `roundTrip = (x) => x` and measures nothing.
    // Only a peer's bytes can carry the value that gets lost.
    const text = '{"seed":9007199254740993}';
    const parsed = JSON.parse(text) as { seed: number };

    expect(parsed.seed).toBe(9_007_199_254_740_992);
    // The tell for Track B: a hop that parses and forwards is NOT byte-stable
    // here, so a signature or content hash taken over the peer's payload and
    // re-checked after a forward disagrees, with nothing in the IR to say why.
    expect(wire(parsed)).toBe('{"seed":9007199254740992}');
    expect(wire(parsed)).not.toBe(text);
  });
});

/* ── 5. The six escape hatches ──────────────────────────────────────────
 *
 * `Record<string, unknown>` is not `Record<string, JsonValue>`, so each of
 * these compiles today with a value that cannot survive the trip. Driven as a
 * table because the answer must be the same at all six sites: it is one hole
 * with six openings, not six separate bugs.
 */

describe('the Record<string, unknown> escape hatches', () => {
  const hatches: ReadonlyArray<readonly [string, (v: unknown) => IRChatRequest, string]> = [
    [
      'metadata.custom',
      (v) => makeRequest({ metadata: { ...METADATA, custom: { probe: v } } }),
      'metadata.custom.probe',
    ],
    [
      'parameters.custom',
      (v) => makeRequest({ parameters: { ...PARAMETERS, custom: { probe: v } } }),
      'parameters.custom.probe',
    ],
    [
      'messages[].metadata',
      (v) => makeRequest({ messages: [{ role: 'user', content: 'hi', metadata: { probe: v } }] }),
      'messages[0].metadata.probe',
    ],
    [
      'tools[].metadata',
      (v) =>
        makeRequest({
          tools: [{ name: 't', description: 'd', parameters: SCHEMA, metadata: { probe: v } }],
        }),
      'tools[0].metadata.probe',
    ],
    [
      'tool_use input',
      (v) =>
        makeRequest({
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'c1', name: 't', input: { probe: v } }],
            },
          ],
        }),
      'messages[0].content[0].input.probe',
    ],
    [
      'warnings[].details',
      (v) =>
        makeRequest({
          metadata: { ...METADATA, warnings: [{ ...WARNING, details: { probe: v } }] },
        }),
      'metadata.warnings[0].details.probe',
    ],
  ];

  it('there are exactly six of them, and this table covers each once', () => {
    expect(hatches).toHaveLength(ESCAPE_HATCHES.length);
    expect(new Set(hatches.map(([name]) => name)).size).toBe(6);
    for (const [, , path] of hatches) expect(isUntypedRecord(path)).toBe(true);
  });

  // `probe` goes into the hatch; the loss lands at `<hatch path><suffix>`.
  const lossy: ReadonlyArray<readonly [string, unknown, string, string]> = [
    ['a Date', new Date('2026-09-03T00:00:00.000Z'), '', 'type changed'],
    ['a Map', new Map([['a', 1]]), '', 'kind changed'],
    ['a Set', new Set([1, 2]), '', 'kind changed'],
    ['a Uint8Array', new Uint8Array([1, 2, 3]), '', 'kind changed'],
    ['a null-prototype object', Object.assign(Object.create(null), { a: 1 }), '', 'kind changed'],
    ['undefined', undefined, '', 'undefined key dropped from record'],
    ['NaN', NaN, '', 'type changed'],
    ['-0', -0, '', 'value changed'],
    // A genuine hole, not an undefined element: `[1, , 3]`. It arrives as null.
    ['a sparse array hole', [1, , 3], '[1]', 'type changed'],
  ];

  for (const [name, probe, suffix, reason] of lossy) {
    it(`loses ${name} at every one of the six`, () => {
      for (const [hatch, build, base] of hatches) {
        const path = `${base}${suffix}`;
        const found = divergences(build(probe));
        expect(paths(found), `${hatch} should lose ${name}`).toContain(path);
        expect(found.find((d) => d.path === path)?.reason, `${hatch} / ${name}`).toBe(reason);
      }
    });
  }

  it('throws outright on a BigInt, at every one of the six', () => {
    for (const [hatch, build] of hatches) {
      expect(() => wire(build(10n)), hatch).toThrow(TypeError);
    }
  });

  it('lets a value rewrite itself through toJSON', () => {
    // Not exotic: any class instance with a `toJSON` — a Temporal-alike, a
    // Decimal, a wrapped model handle — silently becomes something else.
    const probe = { real: 1, toJSON: () => 'REPLACED' };
    const back = roundTrip(makeRequest({ parameters: { ...PARAMETERS, custom: { probe } } }));
    expect(back.parameters?.custom?.probe).toBe('REPLACED');
  });

  it('drops a function and a symbol-keyed entry without a word', () => {
    const probe = { kept: 1, dropped: () => 1, [Symbol('hidden')]: 2 };
    const back = roundTrip(makeRequest({ metadata: { ...METADATA, custom: { probe } } }));
    expect(Object.keys(back.metadata.custom?.probe as object)).toEqual(['kept']);
  });
});

/* ── 6. `__proto__` ─────────────────────────────────────────────────────*/

describe('__proto__ arriving inside an escape hatch', () => {
  const hostile = '{"requestId":"r","timestamp":0,"custom":{"__proto__":{"principal":"admin"}}}';

  it('parses to an own data property, not a prototype swap', () => {
    const parsed = JSON.parse(hostile) as IRMetadata;
    const custom = parsed.custom as Record<string, unknown>;
    expect(Object.getPrototypeOf(custom)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(custom, '__proto__')).toBe(true);
    expect(Object.keys(custom)).toEqual(['__proto__']);
    // Nothing global moved.
    expect(({} as Record<string, unknown>).principal).toBeUndefined();
  });

  it('is safe to spread and unsafe to Object.assign', () => {
    const custom = (JSON.parse(hostile) as IRMetadata).custom as Record<string, unknown>;

    const spread = { ...custom };
    expect(Object.getPrototypeOf(spread)).toBe(Object.prototype);
    expect(spread.principal).toBeUndefined();

    // The same merge written the other common way invokes the __proto__ setter.
    const assigned: Record<string, unknown> = {};
    Object.assign(assigned, custom);
    expect(Object.getPrototypeOf(assigned)).not.toBe(Object.prototype);
    expect(assigned.principal).toBe('admin');
    // A field the IR does carry, now answered by an attacker-supplied prototype
    // on an object that never had it.
    expect('principal' in assigned).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(assigned, 'principal')).toBe(false);

    // And interposing a spread does NOT sanitise it. The spread's *result* is
    // safe, but it still carries an own `__proto__` key, and Object.assign
    // writes with [[Set]] either way. Only the destination's write mechanism
    // matters — which is why "we spread the payload first" is not a defence.
    const laundered: Record<string, unknown> = {};
    Object.assign(laundered, { ...custom });
    expect(laundered.principal).toBe('admin');
  });

  it('survives a re-serialisation, so a middle hop forwards it intact', () => {
    expect(wire(JSON.parse(hostile))).toBe(hostile);
  });

  it('can forge a servedModel that no hop ever claimed, and that no wire shows', () => {
    // The privacy-relevant instance of the case above, on the one field the
    // provenance copy reads to decide whether a reply was served on-device.
    const forged = '{"backend":"tunnel","__proto__":{"servedModel":"gpt-4-turbo"}}';
    const parsed = JSON.parse(forged) as IRProvenance;

    // Reading the peer's provenance as it arrived is safe: own data property.
    expect(resolveServedModel(parsed)).toBeUndefined();

    // A hop that folds the peer's provenance into its own the common way is not.
    const merged: IRProvenance = Object.assign({ backend: 'desktop-bridge' }, parsed);
    expect(resolveServedModel(merged)).toBe('gpt-4-turbo');
    expect(Object.prototype.hasOwnProperty.call(merged, 'servedModel')).toBe(false);

    // And the forgery is INVISIBLE downstream: the merged provenance serialises
    // without it, so the next hop, a log, and an audit all see a chain that
    // never mentions `gpt-4-turbo` while this process attributes the reply to
    // it. `withUpstreamProvenance` is the merge that does not do this.
    expect(wire(merged)).toBe('{"backend":"tunnel"}');
    expect(resolveServedModel(roundTrip(merged))).toBeUndefined();
    expect(resolveServedModel(withUpstreamProvenance({ backend: 'desktop-bridge' }, parsed)))
      .toBeUndefined();
  });
});

/* ── 7. Depth ───────────────────────────────────────────────────────────
 *
 * `IRProvenance.upstream` is recursive with no documented bound, and the two
 * halves of the round trip do not have the same bound.
 */

describe('provenance chain depth', () => {
  const chainOfDepth = (n: number): IRProvenance => {
    const root: Record<string, unknown> = { backend: 'hop' };
    let tip = root;
    for (let i = 0; i < n; i += 1) {
      const next: Record<string, unknown> = { backend: 'hop' };
      tip.upstream = next;
      tip = next;
    }
    tip.servedModel = 'far-end';
    return root as IRProvenance;
  };

  const textOfDepth = (n: number): string =>
    `{"upstream":`.repeat(n) + '{"servedModel":"far-end"}' + '}'.repeat(n);

  /** Deepest chain `JSON.stringify` will emit here. Stack-dependent, so probed. */
  const maxEmittableDepth = ((): number => {
    let lo = 1;
    // 16384 is comfortably past the ~6k this engine manages; searching to
    // 65536 instead only quadruples the peak allocation, and this file already
    // allocates more than anything else in the suite. `tests/desktop-host-*`
    // supervises real subprocesses on a 126ms liveness budget in the same
    // worker pool, and a GC pause here is a failed ping there.
    let hi = 1 << 14;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      try {
        wire(chainOfDepth(mid));
        lo = mid;
      } catch {
        hi = mid - 1;
      }
    }
    return lo;
  })();

  it('handles a realistically deep chain without complaint', () => {
    expect(divergences(chainOfDepth(64))).toEqual([]);
    expect(resolveServedModel(roundTrip(chainOfDepth(64)))).toBe('far-end');
  });

  it('cannot serialise a chain past a few thousand hops', () => {
    expect(maxEmittableDepth).toBeGreaterThan(1000);
    expect(maxEmittableDepth).toBeLessThan(1 << 14);
    // Deliberately `* 4` and not `+ 1`. The bound is the JS stack, so it moves
    // with how deep the caller already is: the depth probed from the module
    // frame above is NOT reproducible from inside this test callback, and an
    // assertion on the exact edge passes on both sides of it. The practical
    // consequence for Track B is the finding: a hop cannot decide "will this
    // serialise?" by comparing depth against a constant, because there is no
    // constant. It has to try, and catch.
    expect(() => wire(chainOfDepth(maxEmittableDepth * 4))).toThrow(RangeError);
    // ...while a chain comfortably inside the bound always makes it out.
    expect(() => wire(chainOfDepth(maxEmittableDepth >> 2))).not.toThrow();
  });

  it('accepts far deeper than it can emit, so a peer can send an unforwardable chain', () => {
    // This is the asymmetry. A malicious or merely buggy peer sends a chain of
    // 100k hops; this process parses it, reads it, and then throws the moment
    // it tries to pass it on or persist it.
    const hostile = JSON.parse(textOfDepth(100_000)) as IRProvenance;
    expect(100_000).toBeGreaterThan(maxEmittableDepth * 4);
    expect(resolveServedModel(hostile)).toBe('far-end');
    expect(() => wire(hostile)).toThrow(RangeError);
  });

  it('resolveServedModel itself is iterative, so reading the hostile chain is safe', () => {
    // Worth pinning: the loop in resolveServedModel walks with a for, not a
    // recursion. A recursive rewrite would turn the case above into a crash,
    // and 100k hops is already ~16x deeper than this engine can serialise.
    const walked = resolveServedModel(JSON.parse(textOfDepth(100_000)) as IRProvenance);
    expect(walked).toBe('far-end');
  });
});

/* ── 8. Cycles ──────────────────────────────────────────────────────────*/

describe('a cyclic provenance chain', () => {
  it('cannot be serialised at all, so it fails at send rather than on the wire', () => {
    // Constructible today: `upstream` is recursive and nothing forbids a hop
    // from nesting itself. A proxying adapter that mutates rather than copies
    // — `local.upstream = far` where `far` already reaches `local` — builds one.
    const hop: Record<string, unknown> = { backend: 'tunnel' };
    hop.upstream = hop;
    expect(() => wire(hop)).toThrow(TypeError);
  });

  it('is unreachable from the parse side, so a peer cannot hand one over', () => {
    // The reassurance that makes the above a local-construction bug only:
    // JSON has no back-reference, so no parsed provenance is ever cyclic.
    const parsed = JSON.parse('{"backend":"a","upstream":{"backend":"b"}}') as IRProvenance;
    const seen = new Set<unknown>();
    for (let hop: IRProvenance | undefined = parsed; hop !== undefined; hop = hop.upstream) {
      expect(seen.has(hop)).toBe(false);
      seen.add(hop);
    }
    expect(seen.size).toBe(2);
  });
});
