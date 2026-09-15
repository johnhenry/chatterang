import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_TOOLS,
  ToolRegistry,
  evaluateExpression,
  toolRegistry,
} from '@/ai/tools/registry';
import { extractTextualToolCalls as extractFrom, stripToolSyntax as stripFrom } from '@/ai/middleware/tools';

/** What a chat with the calculator on offers, as `callNames` gives it. */
const OFFERED = ['calculator', 'calculate'];

/** Read as a turn offering the calculator reads it, unless `offered` says otherwise. */
const extractTextualToolCalls = (text: string, offered: readonly string[] = OFFERED) => extractFrom(text, offered);
const stripToolSyntax = (
  text: string,
  reading: { offered: readonly string[]; ran?: boolean } = { offered: OFFERED },
) => stripFrom(text, { ran: false, ...reading });

describe('evaluateExpression', () => {
  it('evaluates arithmetic with correct precedence', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512); // right-associative
    expect(evaluateExpression('-4 + 10')).toBe(6);
    expect(evaluateExpression('7 % 3')).toBe(1);
  });

  it('supports constants and functions', () => {
    expect(evaluateExpression('sqrt(16)')).toBe(4);
    expect(evaluateExpression('max(3, 9, 2)')).toBe(9);
    expect(evaluateExpression('round(pi)')).toBe(3);
    expect(evaluateExpression('ln(e)')).toBe(1);
  });

  it('gets the answer the model would get wrong', () => {
    expect(evaluateExpression('4096 * 12')).toBe(49152);
    expect(evaluateExpression('(1920 * 1080)')).toBe(2073600);
  });

  it('rejects division by zero rather than returning Infinity', () => {
    expect(() => evaluateExpression('1 / 0')).toThrow(/zero/i);
  });

  it('rejects unbalanced parentheses', () => {
    expect(() => evaluateExpression('(1 + 2')).toThrow();
  });

  it('refuses anything that is not arithmetic', () => {
    // The point of a hand-written parser is that a model cannot smuggle code
    // through the calculator.
    expect(() => evaluateExpression('process.exit(1)')).toThrow();
    expect(() => evaluateExpression('alert("hi")')).toThrow();
    expect(() => evaluateExpression('globalThis')).toThrow();
    expect(() => evaluateExpression('')).toThrow();
  });

  it('rejects trailing junk after a valid expression', () => {
    expect(() => evaluateExpression('1 + 1 2')).toThrow();
  });
});

describe('built-in tools', () => {
  const context = { now: () => new Date('2026-03-04T15:30:00Z') };

  it('calculator returns the expression and its value', async () => {
    const tool = BUILT_IN_TOOLS.find((entry) => entry.id === 'calculator');
    const result = await tool!.execute({ expression: '12 * 12' }, context);
    expect(result.output).toContain('144');
    expect(result.isError).toBeFalsy();
  });

  it('calculator reports a bad expression instead of throwing', async () => {
    const tool = BUILT_IN_TOOLS.find((entry) => entry.id === 'calculator');
    const result = await tool!.execute({ expression: 'not maths' }, context);
    expect(result.isError).toBe(true);
  });

  it('datetime formats in the requested timezone', async () => {
    const tool = BUILT_IN_TOOLS.find((entry) => entry.id === 'datetime');
    const result = await tool!.execute({ timezone: 'UTC' }, context);
    expect(result.output).toContain('2026');
    expect(result.output).toContain('UTC');
  });

  it('datetime rejects an unknown timezone', async () => {
    const tool = BUILT_IN_TOOLS.find((entry) => entry.id === 'datetime');
    const result = await tool!.execute({ timezone: 'Mars/Olympus' }, context);
    expect(result.isError).toBe(true);
  });

  it('render_html returns the markup as display payload, not as model text', async () => {
    const tool = BUILT_IN_TOOLS.find((entry) => entry.id === 'render_html');
    const result = await tool!.execute({ html: '<p>hi</p>' }, context);
    expect(result.display?.kind).toBe('html');
    expect(result.display?.value).toBe('<p>hi</p>');
    expect(result.output).not.toContain('<p>');
  });
});

describe('ToolRegistry', () => {
  it('registers the built-ins by default', () => {
    expect(toolRegistry.list().length).toBe(BUILT_IN_TOOLS.length);
  });

  it('looks tools up by id and by the name the model calls', () => {
    expect(toolRegistry.get('calculator')?.name).toBe('calculate');
    expect(toolRegistry.getByName('calculate')?.id).toBe('calculator');
    expect(toolRegistry.getByName('calculator')?.id).toBe('calculator');
    expect(toolRegistry.getByName('nope')).toBeUndefined();
  });

  it('projects only the enabled subset into IR tools', () => {
    const irTools = toolRegistry.toIRTools(['calculator', 'does-not-exist']);
    expect(irTools).toHaveLength(1);
    expect(irTools[0]?.name).toBe('calculate');
    expect(irTools[0]?.parameters.required).toEqual(['expression']);
  });

  it('supports registration and removal', () => {
    const registry = new ToolRegistry([]);
    expect(registry.list()).toHaveLength(0);
    registry.register({
      id: 'x',
      name: 'x',
      summary: 's',
      description: 'd',
      parameters: { type: 'object' },
      execute: async () => ({ output: 'ok' }),
    });
    expect(registry.list()).toHaveLength(1);
    registry.unregister('x');
    expect(registry.list()).toHaveLength(0);
  });
});

describe('extractTextualToolCalls', () => {
  it('reads the <tool_call> form used by Qwen and Hermes', () => {
    const calls = extractTextualToolCalls(
      'Sure.\n<tool_call>{"name": "calculate", "arguments": {"expression": "2+2"}}</tool_call>',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('calculate');
    expect(calls[0]?.input).toEqual({ expression: '2+2' });
  });

  it('reads a fenced JSON block', () => {
    const calls = extractTextualToolCalls(
      '```json\n{"tool": "get_datetime", "arguments": {"timezone": "UTC"}}\n```',
      ['datetime', 'get_datetime'],
    );
    expect(calls[0]?.name).toBe('get_datetime');
    expect(calls[0]?.input).toEqual({ timezone: 'UTC' });
  });

  it('reads the Mistral bracket form', () => {
    const calls = extractTextualToolCalls('[TOOL_CALLS] calculate({"expression": "9*9"})');
    expect(calls[0]?.name).toBe('calculate');
    expect(calls[0]?.input).toEqual({ expression: '9*9' });
  });

  it('ignores malformed JSON rather than throwing', () => {
    expect(extractTextualToolCalls('<tool_call>{not json}</tool_call>')).toEqual([]);
  });

  it('finds nothing in ordinary prose', () => {
    expect(extractTextualToolCalls('I think the answer is four.')).toEqual([]);
  });

  it('assigns each call a distinct id', () => {
    const calls = extractTextualToolCalls(
      '<tool_call>{"name":"a","arguments":{}}</tool_call><tool_call>{"name":"b","arguments":{}}</tool_call>',
    );
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
  });
});

describe('stripToolSyntax', () => {
  it('removes the plumbing and keeps the prose', () => {
    const text = 'Let me check.\n<tool_call>{"name":"calculate","arguments":{}}</tool_call>\nDone.';
    expect(stripToolSyntax(text)).toBe('Let me check.\n\nDone.');
  });

  it('removes the Mistral form', () => {
    expect(stripToolSyntax('Ok [TOOL_CALLS] calculate({"a":1}) end')).toBe('Ok  end');
  });

  it('leaves an ordinary fenced code block alone', () => {
    const text = 'Here:\n```js\nconst a = 1;\n```';
    expect(stripToolSyntax(text)).toContain('const a = 1;');
  });

  it('keeps prose naming both tags, and an answer naming the tag its reasoning named the other of', () => {
    const prose = 'Qwen wraps each call in a `<tool_call>` tag and ends it with `</tool_call>`, and the app reads JSON.';
    expect(stripToolSyntax(prose)).toBe(prose);
    const split = '<think>About the <tool_call> tag.</think>Every call ends with </tool_call>, and the app reads it.';
    expect(stripToolSyntax(split)).toBe(split);
  });

  it('keeps a parenthetical aside after [TOOL_CALLS] named in prose', () => {
    const prose = 'Mistral emits [TOOL_CALLS] before (not after) the function name.';
    expect(stripToolSyntax(prose)).toBe(prose);
  });

  it('strips the whole of a call whose string argument holds a ")" or a closing tag', () => {
    expect(stripToolSyntax('Ok [TOOL_CALLS] calculate({"expression": "(1920 * 1080) / 1e6"}) end')).toBe('Ok  end');
    expect(
      stripToolSyntax('A<tool_call>{"name":"note","arguments":{"text":"a </tool_call> b"}}</tool_call>B'),
    ).toBe('AB');
  });

  it('strips a malformed call, which runs nothing and is still plumbing', () => {
    expect(stripToolSyntax('<tool_call>{"name": "leaky", "arguments": {"path": "x",}}</tool_call>')).toBe('');
    expect(stripToolSyntax('Ok [TOOL_CALLS] calculate({expression: 2}) end')).toBe('Ok  end');
    expect(stripToolSyntax('Ok <tool_call></tool_call> [TOOL_CALLS] now() end')).toBe('Ok   end');
  });

  it('strips a call written with a closing bracket too many, in each tag form', () => {
    expect(stripToolSyntax('Look.\n<tool_call>{"name": "calculate", "arguments": {"expression": "1"}}}</tool_call>')).toBe('Look.');
    expect(stripToolSyntax('Look. [TOOL_CALLS] calculate({"expression": "1"}}) Done.')).toBe('Look.  Done.');
    const prose = 'Close it with `}` and then `</tool_call>`: <tool_call>{"a": 1} is how it opens.';
    expect(stripToolSyntax(prose)).toBe(prose);
  });

  it('strips a Qwen3-Coder call whose body is XML, and keeps prose naming its tags', () => {
    const call = '<tool_call>\n<function=calculate>\n<parameter=expression>\n2+2\n</parameter>\n</function>\n</tool_call>';
    expect(stripToolSyntax(`Checking.\n${call}\nDone.`)).toBe('Checking.\n\nDone.');
    expect(stripToolSyntax('<tool_call><function=now></function></tool_call>')).toBe('');
    const prose = 'It opens with `<tool_call><function=name>` and ends with `</function></tool_call>`, and the app reads it.';
    expect(stripToolSyntax(prose)).toBe(prose);
    const unfinished = 'Checking.\n<tool_call>\n<function=calculate>\n<parameter=expression>\n2+';
    expect(stripToolSyntax(unfinished), 'an unfinished one is the caller’s to cut').toBe(unfinished);
    expect(stripToolSyntax(`Qwen3-Coder writes ${call}`, { offered: [] }), 'in a turn that offered nothing').toBe(
      `Qwen3-Coder writes ${call}`,
    );
  });

  it('strips a fenced call wrapped in <tool_call> tags whole, in one pass', () => {
    const wrapped = 'Checking.\n<tool_call>\n```json\n{"name":"calculate","arguments":{"expression":"2+2"}}\n```\n</tool_call>\nDone.';
    expect(stripToolSyntax(wrapped)).toBe('Checking.\n\nDone.');
    const malformed = 'Checking.\n<tool_call>\n```json\n{"name":"calculate","arguments":{"expression":"2+2",}}\n```\n</tool_call>';
    expect(stripToolSyntax(malformed), 'markup whatever its JSON holds').toBe('Checking.');
  });

  it('leaves an unfinished call alone, for the caller to cut', () => {
    const text = 'Reading.\n<tool_call>{"name":"leaky","arguments":{"path":"x';
    expect(stripToolSyntax(text)).toBe(text);
  });

  it('keeps a fenced tool definition, and strips a fenced block that reads as a call', () => {
    const definition = '```json\n{"type": "function", "function": {"name": "get_weather"}}\n```';
    expect(extractTextualToolCalls(definition)).toEqual([]);
    expect(stripToolSyntax(definition)).toBe(definition);
    const call = 'Here.\n```json\n{"tool": "calculate", "arguments": {"expression": "2+2"}}\n```';
    expect(stripToolSyntax(call)).toBe('Here.');
  });

  it('reads a fenced block as a call only when it holds a name and its arguments, and nothing else', () => {
    const record = '```json\n{"name": "Alice Chen", "email": "alice@example.com", "age": 34}\n```';
    expect(extractTextualToolCalls(record)).toEqual([]);
    expect(stripToolSyntax(record)).toBe(record);
    const definition =
      '```json\n{"name": "calculate", "description": "Evaluate arithmetic", "parameters": {"type": "object"}}\n```';
    expect(extractTextualToolCalls(definition)).toEqual([]);
    expect(stripToolSyntax(definition)).toBe(definition);
    const call = '```json\n{"name": "calculate", "parameters": {"expression": "2+2"}}\n```';
    expect(extractTextualToolCalls(call).map((found) => found.name)).toEqual(['calculate']);
    expect(stripToolSyntax(call)).toBe('');
  });

  it('keeps two JSON blocks and the prose between them when a quoted "tool" sits there', () => {
    const text = '```json\n{"model": "qwen3"}\n```\n\nSet the "tool" key:\n\n```json\n{"enabled": true}\n```';
    expect(stripToolSyntax(text)).toBe(text);
  });

  it('strips nothing from a turn that offered no tool and ran none, and only tagged calls from one in which a tool ran', () => {
    const fenced = '```json\n{"tool": "calculate", "arguments": {}}\n```';
    const tagged = 'Qwen writes <tool_call>{"name":"a","arguments":{}}</tool_call> and Mistral [TOOL_CALLS] a({"b": 1}).';
    expect(stripToolSyntax(fenced, { offered: [] })).toBe(fenced);
    expect(stripToolSyntax(tagged, { offered: [] })).toBe(tagged);
    expect(stripToolSyntax(fenced, { offered: [], ran: true })).toBe(fenced);
    expect(stripToolSyntax(tagged, { offered: [], ran: true })).toBe('Qwen writes  and Mistral .');
  });

  it('reads a fenced block as a call only when it names a tool the turn offered, by name or by id', () => {
    const example = '```json\n{"tool": "search", "arguments": {"query": "weather"}}\n```';
    expect(extractTextualToolCalls(example)).toEqual([]);
    expect(stripToolSyntax(example)).toBe(example);
    expect(extractTextualToolCalls(example, ['web', 'search']).map((call) => call.name)).toEqual(['search']);
    expect(stripToolSyntax(example, { offered: ['web', 'search'] })).toBe('');
    const byId = '```json\n{"tool": "calculator", "arguments": {"expression": "2+2"}}\n```';
    expect(extractTextualToolCalls(byId).map((call) => call.name)).toEqual(['calculator']);
  });

  it('strips every call extractTextualToolCalls reads, in each form', () => {
    for (const text of [
      '<tool_call>{"name":"calculate","arguments":{"expression":"(1+2)"}}</tool_call>',
      '```json\n{"name": "calculate", "arguments": {"expression": "(1+2)"}}\n```',
      '[TOOL_CALLS] calculate({"expression": "(1+2)"})',
      '[TOOL_CALLS]\ncalculate({"expression": "9*9"})',
    ]) {
      expect(extractTextualToolCalls(text), text).toHaveLength(1);
      expect(stripToolSyntax(text), text).toBe('');
    }
  });
});
