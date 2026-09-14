import { describe, expect, it, vi } from 'vitest';

import { createMcpTool } from '@/ai/mcp/tools';
import {
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_NODES,
  checkToolSchema,
  validateToolSchema,
} from '@/ai/mcp/schema';

/**
 * The schema on an MCP tool is written by a third party and, once a turn can
 * be tunnelled, is relayed by this device to another one. Until #143 it
 * reached the IR on a bare `as JSONSchema`, which checks nothing at runtime.
 *
 * Every rejection below is paired with an acceptance of the same shape just
 * inside the bound, so none of these tests can pass by rejecting everything —
 * which is the failure mode a validator like this actually has.
 */

/** A schema nested `depth` levels deep, counting the root. */
function nested(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: 'string' };
  // Each `properties` wrapper adds two levels: the map, then the child.
  for (let i = 0; i < Math.floor((depth - 1) / 2); i += 1) {
    node = { type: 'object', properties: { child: node } };
  }
  return node;
}

describe('checkToolSchema', () => {
  it('accepts an ordinary tool schema', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        limit: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    };
    expect(checkToolSchema(schema)).toEqual({ ok: true });
    expect(validateToolSchema(schema)).toBe(schema);
  });

  it('refuses anything that is not a plain object', () => {
    for (const value of [null, undefined, 42, 'schema', true, [], () => {}]) {
      expect(checkToolSchema(value).ok, `accepted ${String(value)}`).toBe(false);
      expect(checkToolSchema(value).reason).toBe('not-an-object');
    }
  });

  it('refuses a schema deeper than the bound, and accepts one at it', () => {
    // The paired acceptance is the point: a validator that rejects everything
    // would pass the rejection half alone.
    expect(checkToolSchema(nested(MAX_SCHEMA_DEPTH - 2)).ok).toBe(true);

    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < MAX_SCHEMA_DEPTH; i += 1) {
      deep = { type: 'object', properties: { child: deep } };
    }
    const check = checkToolSchema(deep);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('too-deep');
    expect(check.at).toContain('properties');
  });

  it('refuses a schema with more nodes than the bound, and accepts one under it', () => {
    const wide = (count: number) => ({
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`p${i}`, { type: 'string' }]),
      ),
    });

    // Each property contributes its own node plus its `{type:'string'}` body.
    expect(checkToolSchema(wide(100)).ok).toBe(true);

    const check = checkToolSchema(wide(MAX_SCHEMA_NODES));
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('too-many-nodes');
  });

  it('refuses keys that are dangerous for a decoder to walk', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      // Built with defineProperty: a `__proto__` literal would set the
      // prototype rather than create an own property, so the naive fixture
      // would test nothing.
      const properties: Record<string, unknown> = {};
      Object.defineProperty(properties, key, {
        value: { type: 'string' },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const check = checkToolSchema({ type: 'object', properties });
      expect(check.ok, `accepted a ${key} key`).toBe(false);
      expect(check.reason).toBe('unwalkable-key');
      expect(check.at).toContain(key);
    }
  });

  it('refuses a cyclic schema before JSON.stringify can throw on it', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.properties = { self: cyclic };

    // The control: this is what would happen at send time without the check.
    expect(() => JSON.stringify(cyclic)).toThrow(TypeError);

    const check = checkToolSchema(cyclic);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('cyclic');
  });

  it('accepts a repeated sibling, which is shared structure and not a cycle', () => {
    const shared = { type: 'string' };
    const schema = { type: 'object', properties: { a: shared, b: shared } };
    expect(() => JSON.stringify(schema)).not.toThrow();
    expect(checkToolSchema(schema).ok).toBe(true);
  });

  it('refuses values that JSON would silently change or drop', () => {
    // NaN and Infinity stringify to `null`, so the schema the desktop decodes
    // is not the schema the server sent.
    expect(checkToolSchema({ type: 'number', maximum: Number.NaN }).reason).toBe('non-json-value');
    expect(checkToolSchema({ type: 'number', maximum: Infinity }).reason).toBe('non-json-value');
    // `undefined` and functions vanish entirely.
    expect(checkToolSchema({ type: 'object', properties: undefined }).reason).toBe(
      'non-json-value',
    );
    expect(checkToolSchema({ type: 'object', title: () => 'x' }).reason).toBe('non-json-value');
    // A finite number is fine, so this is not just rejecting `maximum`.
    expect(checkToolSchema({ type: 'number', maximum: 10 }).ok).toBe(true);
  });
});

describe('createMcpTool with a schema it will not vouch for', () => {
  const options = {
    serverId: 'mcp_1',
    serverUrl: 'https://api.acme.com/mcp',
    confirm: vi.fn(async () => true),
    call: vi.fn(async () => 'ok'),
  };

  const descriptor = (inputSchema: unknown) => ({
    server: 'acme',
    name: 'search',
    description: 'Search things',
    readOnly: true,
    destructive: false,
    inputSchema: inputSchema as Record<string, unknown>,
  });

  it('returns null rather than a tool with a trimmed schema', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.properties = { self: cyclic };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(createMcpTool(descriptor(cyclic), options)).toBeNull();

    // Refusing silently would look identical to a server offering no tools.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing tool acme.search'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cyclic'));
    warn.mockRestore();
  });

  it('still builds the tool when the schema is fine', () => {
    const tool = createMcpTool(descriptor({ type: 'object', properties: {} }), options);
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe('acme.search');
    // And the parameters that reach the IR are the server's own object.
    expect(tool?.parameters).toEqual({ type: 'object', properties: {} });
  });
});
