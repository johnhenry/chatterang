import { describe, expect, it } from 'vitest';

import {
  CodecRefusal,
  FIELD_POLICY,
  QUARANTINED,
  applyPolicy,
  findUnserializable,
} from '@chatterang/tunnel/codec';

/**
 * #142. Six IR fields are `unknown`, and nothing said what happens when one
 * holds a value JSON would change. The ruling is asymmetric on purpose —
 * outbound refuses because we wrote it, inbound is quarantined because
 * refusing fails someone else's turn for someone else's mistake — so these
 * check both halves and the asymmetry itself.
 */
describe('what the codec refuses to send', () => {
  it('passes a value that is already plain JSON', () => {
    // The control. A codec that refuses everything would pass every rejection
    // test below and be useless.
    const clean = { a: 1, b: 'two', c: [3, { d: true }], e: null };
    expect(findUnserializable(clean)).toEqual([]);
    expect(applyPolicy('metadata.custom', clean, 'refuse')).toEqual({ value: clean, warnings: [] });
  });

  it('catches a BigInt, which throws at the socket rather than degrading', () => {
    const findings = findUnserializable({ n: 10n }, 'metadata.custom');
    expect(findings).toEqual([{ path: 'metadata.custom.n', reason: 'bigint' }]);
    // The control for the claim: this is what happens without the check.
    expect(() => JSON.stringify({ n: 10n })).toThrow(TypeError);
  });

  it('catches the values JSON changes silently rather than loudly', () => {
    // A Date becomes a string, a Map becomes {}, a function vanishes. None of
    // them throws, so none would ever be noticed.
    const reasons = (v: unknown) => findUnserializable(v, 'x').map((f) => f.reason);
    expect(reasons({ at: new Date(0) })).toEqual(['not-json']);
    expect(reasons({ m: new Map() })).toEqual(['not-json']);
    expect(reasons({ f: () => 1 })).toEqual(['not-json']);
    expect(reasons({ u: undefined })).toEqual(['not-json']);
    expect(reasons({ n: Number.NaN })).toEqual(['not-json']);
    expect(reasons({ i: Infinity })).toEqual(['not-json']);
  });

  it('catches a cycle before JSON.stringify throws on it', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => JSON.stringify(cyclic)).toThrow(TypeError);
    expect(findUnserializable(cyclic, 'metadata.custom')[0]?.reason).toBe('cyclic');
  });

  it('allows shared structure, which is not a cycle', () => {
    const shared = { v: 1 };
    expect(findUnserializable({ a: shared, b: shared })).toEqual([]);
  });

  it('catches keys unsafe for the far side to walk', () => {
    const bag: Record<string, unknown> = {};
    Object.defineProperty(bag, '__proto__', { value: { x: 1 }, enumerable: true, configurable: true });
    expect(findUnserializable(bag, 'metadata.custom')[0]?.reason).toBe('unwalkable-key');
  });

  it('reports every finding, not just the first', () => {
    // One refusal per round trip is three round trips to fix three keys.
    expect(findUnserializable({ a: 10n, b: new Date(0) })).toHaveLength(2);
  });
});

describe('the asymmetry between outbound and inbound', () => {
  const bad = { when: new Date(0) };

  it('refuses outbound, naming the key', () => {
    expect(() => applyPolicy('metadata.custom', bad, 'refuse')).toThrow(CodecRefusal);
    try {
      applyPolicy('metadata.custom', bad, 'refuse');
    } catch (error) {
      // The message has to name the field. "serialisation error" sends the
      // reader to a stack trace instead.
      expect((error as CodecRefusal).message).toContain('metadata.custom.when');
      expect((error as CodecRefusal).path).toBe('metadata.custom.when');
    }
  });

  it('quarantines inbound instead of failing the turn', () => {
    const result = applyPolicy('content.tool_use.input', bad, 'quarantine');
    expect(result.value).toBe(QUARANTINED);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.severity).toBe('warning');
  });

  it('drops raw and says so, rather than forwarding a payload nothing reads', () => {
    const result = applyPolicy('raw', { huge: 'provider payload' }, 'drop');
    expect(result.value).toBeUndefined();
    expect(result.warnings[0]?.severity).toBe('info');
    // Dropped even though it was perfectly serializable — the policy is about
    // size and it being the provider's unredacted payload, not about JSON.
    expect(findUnserializable({ huge: 'provider payload' })).toEqual([]);
  });
});

describe('the policy table', () => {
  it('states a policy for every field the issue enumerates', () => {
    // Policy as data so the whole of it reads at once. A branch buried in a
    // function is how a seventh field gets added with no policy at all.
    expect(FIELD_POLICY['metadata.custom']).toBe('refuse');
    expect(FIELD_POLICY['messages.metadata']).toBe('refuse');
    expect(FIELD_POLICY['parameters.custom']).toBe('refuse');
    expect(FIELD_POLICY['content.tool_use.input']).toBe('quarantine');
    expect(FIELD_POLICY.raw).toBe('drop');
  });

  it('refuses everything we write and never refuses what arrives', () => {
    // The asymmetry, asserted directly rather than left to be inferred from
    // five separate rows that happen to line up.
    const outbound = ['metadata.custom', 'messages.metadata', 'parameters.custom'];
    const inbound = ['content.tool_use.input', 'raw'];
    for (const field of outbound) expect(FIELD_POLICY[field], field).toBe('refuse');
    for (const field of inbound) expect(FIELD_POLICY[field], field).not.toBe('refuse');
  });
});
