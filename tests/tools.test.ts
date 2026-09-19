import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_TOOLS,
  ToolRegistry,
  evaluateExpression,
  toolRegistry,
} from '@/ai/tools/registry';
import {
  cutUnfinishedCall,
  extractTextualToolCalls as extractFrom,
  stripToolSyntax as stripFrom,
} from '@/ai/middleware/tools';
import { messageText } from '@/ai/prompt';

/** What a chat with the calculator on offers, as `callNames` gives it. */
const OFFERED = ['calculator', 'calculate'];

/** Read as a turn offering the calculator, with no call in its history, reads it, unless `offered` says otherwise. */
const extractTextualToolCalls = (text: string, offered: readonly string[] = OFFERED) => extractFrom(text, offered, []);
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

  it('reads a real <tool_call> when earlier words, in reasoning or prose, name the tag', () => {
    const call = '<tool_call>{"name": "calculate", "arguments": {"expression": "2+2"}}</tool_call>';
    for (const before of [
      '<think>I should answer with a <tool_call> here.</think>\n',
      'Qwen wraps each call in a <tool_call> tag, so here is mine.\n',
      'It opens <tool_call> and closes </tool_call>. Now:\n',
    ]) {
      const text = before + call;
      expect(extractTextualToolCalls(text).map((found) => [found.name, found.input]), text).toEqual([
        ['calculate', { expression: '2+2' }],
      ]);
    }
  });

  it('reads a <tool_call> through its JSON, so a closing tag in a string argument does not end it', () => {
    const text = '<tool_call>{"name":"calculate","arguments":{"expression":"1","note":"a </tool_call> b"}}</tool_call>';
    expect(extractTextualToolCalls(text).map((found) => found.input)).toEqual([
      { expression: '1', note: 'a </tool_call> b' },
    ]);
    // What the stripper takes out is what was read.
    expect(stripToolSyntax(`Ok.${text}Done.`)).toBe('Ok.Done.');
    // Two calls in one tag are two calls, read as the stripper takes them out.
    const two = '<tool_call>{"name":"calculate","arguments":{}} {"name":"calculate","arguments":{}}</tool_call>';
    expect(extractTextualToolCalls(two), two).toHaveLength(2);
    expect(stripToolSyntax(`Ok.${two}Done.`), two).toBe('Ok.Done.');
    // An object that is not JSON is not a call, and nothing runs from a tag
    // inside it either. The stripper takes the whole out as one malformed call.
    const malformed =
      '<tool_call>{"name":"calculate","arguments":{}, "then": <tool_call>{"name":"calculate","arguments":{}}</tool_call>}</tool_call>';
    expect(extractTextualToolCalls(malformed), malformed).toEqual([]);
    expect(stripToolSyntax(`Ok.${malformed}Done.`), malformed).toBe('Ok.Done.');
  });

  it('reads no call in reasoning the round closed, nor, when stopped, in reasoning still open', () => {
    const call = '<tool_call>{"name": "calculate", "arguments": {"expression": "2+2"}}</tool_call>';
    expect(extractTextualToolCalls(`<think>I could write ${call}.</think>It is 4.`)).toEqual([]);
    expect(extractTextualToolCalls(`<think>First ${call}.</think>\n${call}`)).toHaveLength(1);
    // A round that finished with its reasoning open wrote its call there.
    expect(extractTextualToolCalls(`<think>I will check.\n${call}`)).toHaveLength(1);
    expect(extractFrom(`<think>I will check.\n${call}`, OFFERED, [], { stopped: true })).toEqual([]);
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

  it('strips a malformed call, which is still plumbing, and reads the call it names', () => {
    expect(stripToolSyntax('<tool_call>{"name": "leaky", "arguments": {"path": "x",}}</tool_call>')).toBe('');
    expect(stripToolSyntax('Ok [TOOL_CALLS] calculate({expression: 2}) end')).toBe('Ok  end');
    expect(stripToolSyntax('Ok <tool_call></tool_call> [TOOL_CALLS] now() end')).toBe('Ok   end');
    expect(
      extractTextualToolCalls(
        'A <tool_call>{"name": "leaky", "arguments": {"path": "x",}}</tool_call> [TOOL_CALLS] calculate({expression: 2}) <tool_call></tool_call> [TOOL_CALLS] now()',
      ).map((call) => [call.name, call.input]),
    ).toEqual([
      ['leaky', { path: 'x' }],
      ['calculate', { expression: 2 }],
      ['now', {}],
    ]);
  });

  it('reads every call it strips, in every shape, so a call the words lose is a call', () => {
    const calc = (expression: string): string => `{"name": "calculate", "arguments": {"expression": "${expression}"}}`;
    for (const [text, inputs] of [
      [`<tool_call>${calc('1')}</tool_call>`, [{ expression: '1' }]],
      [`<tool_call>\n${calc('1')}\n${calc('2')}\n</tool_call>`, [{ expression: '1' }, { expression: '2' }]],
      [`<tool_call>[${calc('1')}, ${calc('2')}]</tool_call>`, [{ expression: '1' }, { expression: '2' }]],
      [`<tool_call>${calc('1')}}</tool_call>`, [{ expression: '1' }]],
      ['<tool_call>{"name": "calculate", "arguments": {"expression": "1"}</tool_call>', [{ expression: '1' }]],
      ["<tool_call>{'name': 'calculate', 'arguments': {'expression': '1', 'exact': True}}</tool_call>", [{ expression: '1', exact: true }]],
      ['<tool_call>{name: "calculate", arguments: {expression: "1", note: None,},}</tool_call>', [{ expression: '1', note: null }]],
      ['<tool_call>calculate({"expression": "1"})</tool_call>', [{ expression: '1' }]],
      ['<tool_call>\ncalculate\n{"expression": "1"}\n</tool_call>', [{ expression: '1' }]],
      ['<tool_call>\n<function=calculate>\n<parameter=expression>\n1 + 2\n</parameter>\n</function>\n</tool_call>', [{ expression: '1 + 2' }]],
      [`<tool_call>\n\`\`\`json\n${calc('1')}\n\`\`\`\n</tool_call>`, [{ expression: '1' }]],
      ['[TOOL_CALLS] calculate({"expression": "1"}})', [{ expression: '1' }]],
      ['[TOOL_CALLS] calculate({"expression": "a })"})', [{ expression: 'a })' }]],
      ['[tool calculate({"expression": "1"}})]', [{ expression: '1' }]],
    ] as const) {
      expect(stripToolSyntax(`Ok.\n${text}\nDone.`), text).toBe('Ok.\n\nDone.');
      expect(extractTextualToolCalls(text).map((call) => call.input), text).toEqual(inputs);
    }
    // Markup that names no tool is still stripped, and holds no call to read.
    for (const text of ['<tool_call></tool_call>', '<tool_call>{not json}</tool_call>', '<tool_call>{"arguments": {}}</tool_call>']) {
      expect(stripToolSyntax(`Ok.\n${text}\nDone.`), text).toBe('Ok.\n\nDone.');
      expect(extractTextualToolCalls(text), text).toEqual([]);
    }
  });

  it('strips a call written with a closing bracket too many, in each tag form', () => {
    expect(stripToolSyntax('Look.\n<tool_call>{"name": "calculate", "arguments": {"expression": "1"}}}</tool_call>')).toBe('Look.');
    expect(stripToolSyntax('Look. [TOOL_CALLS] calculate({"expression": "1"}}) Done.')).toBe('Look.  Done.');
    const prose = 'Close it with `}` and then `</tool_call>`: <tool_call>{"a": 1} is how it opens.';
    expect(stripToolSyntax(prose)).toBe(prose);
  });

  it('strips a call written with a closing bracket too few through the tag or paren that ends it, in each tag form', () => {
    expect(
      stripToolSyntax('Look.\n<tool_call>{"name": "calculate", "arguments": {"expression": "1"}</tool_call>\nDone.'),
    ).toBe('Look.\n\nDone.');
    expect(stripToolSyntax('Look. [TOOL_CALLS] calculate({"expression": {"a": "1"}) Done.')).toBe('Look.  Done.');
    expect(
      stripToolSyntax('Look.\n<tool_call>\n```json\n{"name":"calculate","arguments":{"expression":"1"}\n```\n</tool_call>\nDone.'),
    ).toBe('Look.\n\nDone.');
    const prose = 'Write `<tool_call>{"name": "x"` and end it with `</tool_call>`, and the app reads it.';
    expect(stripToolSyntax(prose), 'prose between the opening and the tag is not JSON').toBe(prose);
    const unfinished = 'Look.\n<tool_call>{"name": "calculate", "arguments": {"expression": "1"}';
    expect(stripToolSyntax(unfinished), 'with no tag after it, it is the caller’s to cut').toBe(unfinished);
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

  it('reads a fenced call to an offered tool as a call when it carries keys beyond a name and its arguments, and strips it', () => {
    const withId = 'Here.\n```json\n{"id": "call_0", "name": "calculate", "arguments": {"expression": "2+2"}}\n```';
    expect(extractTextualToolCalls(withId).map(({ name, input }) => ({ name, input }))).toEqual([
      { name: 'calculate', input: { expression: '2+2' } },
    ]);
    expect(stripToolSyntax(withId)).toBe('Here.');
    const byIdWithType = '```json\n{"type": "tool_use", "id": "t1", "tool": "calculator", "input": {"expression": "1"}}\n```';
    expect(extractTextualToolCalls(byIdWithType).map((found) => found.name)).toEqual(['calculator']);
    expect(stripToolSyntax(byIdWithType)).toBe('');
  });

  it('keeps a JSON record whose "name" is no offered tool, whatever keys it holds, and reads no call from it', () => {
    const record = '```json\n{"name": "Alice Chen", "email": "alice@example.com", "age": 34}\n```';
    expect(extractTextualToolCalls(record)).toEqual([]);
    expect(stripToolSyntax(record)).toBe(record);
    // Shaped like a call in every key, and still words: its name is no tool the turn offered.
    const shaped = '```json\n{"id": 7, "name": "Alice Chen", "arguments": {"team": "sales"}}\n```';
    expect(extractTextualToolCalls(shaped)).toEqual([]);
    expect(stripToolSyntax(shaped)).toBe(shaped);
  });

  it('keeps a JSON record whose "name" is an offered tool’s id or name when it carries no arguments, and reads no call from it', () => {
    for (const record of [
      // A package.json for a project named after the calculator tool's id.
      '```json\n{"name": "calculator", "version": "1.0.0", "private": true}\n```',
      // A column definition named after the date tool's id, and one after a tool's name.
      '```json\n{"name": "datetime", "type": "timestamp", "nullable": false}\n```',
      '```json\n{"name": "calculate", "type": "string"}\n```',
    ]) {
      expect(extractTextualToolCalls(record, [...OFFERED, 'datetime', 'get_datetime']), record).toEqual([]);
      expect(stripToolSyntax(record, { offered: [...OFFERED, 'datetime', 'get_datetime'] }), record).toBe(record);
    }
    // A call to a tool that takes no arguments may be written as its name alone.
    const bare = 'Now.\n```json\n{"name": "get_datetime"}\n```';
    expect(extractTextualToolCalls(bare, ['datetime', 'get_datetime']).map((call) => call.name)).toEqual([
      'get_datetime',
    ]);
    expect(stripToolSyntax(bare, { offered: ['datetime', 'get_datetime'] })).toBe('Now.');
  });

  it('reads a flat tool definition naming an offered tool as a call to it, and a nested one as words', () => {
    // A CALL. The extractor reads a string `name` as the tool and `parameters` as
    // its arguments, and a block is a call when that name is a tool the turn
    // offered, whatever other keys (here `description`) sit beside it. Only a
    // definition with no string tool, name or function — the nested form, whose
    // `function` is an object — is not one.
    const flat =
      '```json\n{"name": "calculate", "description": "Evaluate arithmetic", "parameters": {"type": "object"}}\n```';
    expect(extractTextualToolCalls(flat).map(({ name, input }) => ({ name, input }))).toEqual([
      { name: 'calculate', input: { type: 'object' } },
    ]);
    expect(stripToolSyntax(flat)).toBe('');
    const nested =
      '```json\n{"type": "function", "function": {"name": "calculate", "description": "Evaluate arithmetic"}}\n```';
    expect(extractTextualToolCalls(nested)).toEqual([]);
    expect(stripToolSyntax(nested)).toBe(nested);
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

describe('cutUnfinishedCall', () => {
  const cut = (text: string, stopped = false) => cutUnfinishedCall(text, { stopped, offered: OFFERED });

  it('keeps words that name a call’s opening and go on past it in prose', () => {
    for (const text of [
      'Look for `[TOOL_CALLS] calculate({` in the output, then read the JSON.',
      'Qwen starts each call with `<tool_call>{"name": "` and the tool name follows.',
      'A call opens <tool_call>{" and then its name.',
    ]) {
      expect(cut(text), text).toBe(text);
      expect(cut(text, true), `${text} (stopped)`).toBe(text);
    }
  });

  it('cuts a call the text ends inside, whatever its arguments’ strings hold', () => {
    expect(cut('Ok.\n<tool_call>{"name": "calculate", "arguments": {"expression": "one plus one')).toBe('Ok.\n');
    expect(cut('Ok.\n[TOOL_CALLS] calculate({"expression": "one plus one')).toBe('Ok.\n');
    expect(cut('Ok.\n[TOOL_CALLS] calculate({expression: 2')).toBe('Ok.\n');
    expect(cut('Ok.\n<tool_call>{"name": "calc')).toBe('Ok.\n');
    expect(cut('Ok.\n<tool_call>{"name": "calculate", "arguments": {"expression": 1.5e')).toBe('Ok.\n');
  });

  it('cuts a tag call the text ends inside whose body is single-quoted, has unquoted keys, or is an array', () => {
    for (const call of [
      "<tool_call>{'name': 'calculate', 'arguments': {'expression': 'one plus",
      '<tool_call>{name: "calculate", arguments: {expression: "one plus',
      '<tool_call>[{"name": "calculate", "arguments": {"expression": "one plus',
      "<tool_call>[{'name': 'calculate', 'arguments': {'expression': 'one plus",
      "<tool_call>\n```json\n{'name': 'calculate', 'arguments': {'expression': 'one plus",
    ]) {
      expect(cut(`Ok.\n${call}`, true), call).toBe('Ok.\n');
      expect(cut(`Ok.\n${call}`), `${call} (finished)`).toBe('Ok.\n');
    }
  });

  it('cuts a single-quoted tag call the text ends inside that holds Python’s True, False or None', () => {
    for (const literal of ['True', 'False', 'None']) {
      const call = `<tool_call>{'name': 'calculate', 'arguments': {'exact': ${literal}, 'expression': 'one plus`;
      expect(cut(`Ok.\n${call}`, true), call).toBe('Ok.\n');
      expect(cut(`Ok.\n${call}`), `${call} (finished)`).toBe('Ok.\n');
    }
    const prose = "Qwen's <tool_call>{ None of this is JSON, and the app reads on.";
    expect(cut(prose, true), prose).toBe(prose);
  });

  it('keeps prose after a tag whose words are not such a body being written', () => {
    for (const prose of [
      "Qwen's <tool_call>{ isn't how it's done here.",
      'Its body is <tool_call>{name} with the name filled in.',
      "It can be <tool_call>['a', 'b'] or an object.",
      "A call opens <tool_call>{' and then its name.",
      'Some models start each call with <tool_call>{name: " and the tool name follows.',
      'Some models start each call with <tool_call>[{"name": " and the tool name follows.',
    ]) {
      expect(cut(prose), prose).toBe(prose);
      expect(cut(prose, true), `${prose} (stopped)`).toBe(prose);
    }
  });

  it('cuts a call cut off in a name with a space in it that a tool offered has', () => {
    const offered = ['mcp:My Notes.note', 'My Notes.note'];
    expect(cutUnfinishedCall('Ok.\n<tool_call>{"name": "My No', { stopped: true, offered })).toBe('Ok.\n');
  });
});

describe('a <tool_call> whose body is calls, but not one JSON object', () => {
  const cut = (text: string, stopped = false) => cutUnfinishedCall(text, { stopped, offered: OFFERED });

  it('is stripped whole: two call objects, a name and its arguments in parens, a name and its JSON', () => {
    for (const call of [
      '<tool_call>\n{"name":"calculate","arguments":{"expression":"1"}}\n{"name":"calculate","arguments":{"expression":"2"}}\n</tool_call>',
      '<tool_call>calculate({"expression": "(1+2)"})</tool_call>',
      '<tool_call>\ncalculate\n{"expression": "1"}\n</tool_call>',
      '<tool_call> calculate {"expression": "1"} calculate({"expression": "2"}) </tool_call>',
    ]) {
      expect(stripToolSyntax(`Ok.\n${call}\nDone.`), call).toBe('Ok.\n\nDone.');
    }
  });

  it('is stripped through its closing tag when a later call in it has a closing brace too few', () => {
    const call = '<tool_call>\n{"name":"calculate","arguments":{}}\n{"name":"calculate","arguments":{"expression":"1"}\n</tool_call>';
    expect(stripToolSyntax(`Ok.\n${call}\nDone.`)).toBe('Ok.\n\nDone.');
  });

  it('keeps prose between the tags', () => {
    for (const prose of [
      'Qwen puts <tool_call> first, then a name, then {"a": 1}, and </tool_call> last.',
      'It opens <tool_call>{"a": 1} and it ends </tool_call>.',
      'Qwen writes <tool_call>get_weather(city) </tool_call> for it.',
      'It opens <tool_call>{"a": 1} {"b": then its words, {"c": 2}} </tool_call> and ends.',
    ]) {
      expect(stripToolSyntax(prose), prose).toBe(prose);
      expect(cut(prose), prose).toBe(prose);
    }
  });

  it('is cut where it starts when the text ends inside a later call in it, or inside a name’s parens', () => {
    expect(
      cut('Ok.\n<tool_call>\n{"name":"calculate","arguments":{}}\n{"name":"calculate","arguments":{"expression":"1'),
    ).toBe('Ok.\n');
    expect(cut('Ok.\n<tool_call>calculate({"expression": "1')).toBe('Ok.\n');
    expect(cut('Ok.\n<tool_call>calculate(', true)).toBe('Ok.\n');
    expect(cut('Ok.\n<tool_call>{"name":"calculate","arguments":{}}\ncalculate({"expression": "1"})\n</tool_')).toBe('Ok.\n');
  });

  it('is not cut at a word after a closed object that the text ends on', () => {
    const text = 'It opens <tool_call>{"a": 1} and';
    expect(cut(text, true)).toBe(text);
  });
});

describe('a call written as Python writes one: name(key=value, …)', () => {
  const cut = (text: string, stopped = false) => cutUnfinishedCall(text, { stopped, offered: OFFERED });

  it('is read and stripped in a tag and after [TOOL_CALLS], each value read as Python writes it', () => {
    for (const [text, input] of [
      ['<tool_call>calculate(expression="6*7")</tool_call>', { expression: '6*7' }],
      [
        "<tool_call>calculate(expression='6*7', exact=True, note=None, tags=['a', 'b'], scale=-1.5, extra={'k': False},)</tool_call>",
        { expression: '6*7', exact: true, note: null, tags: ['a', 'b'], scale: -1.5, extra: { k: false } },
      ],
      ['[TOOL_CALLS] calculate(expression="(1+2) * 3")', { expression: '(1+2) * 3' }],
      ['<tool_call>now()</tool_call>', {}],
    ] as const) {
      expect(stripToolSyntax(`Ok.\n${text}\nDone.`), text).toBe('Ok.\n\nDone.');
      expect(extractTextualToolCalls(text).map((call) => call.input), text).toEqual([input]);
    }
  });

  it('keeps prose, and a call whose arguments name no parameter', () => {
    for (const words of [
      'Qwen writes <tool_call>get_weather(city) </tool_call> for it.',
      'Mistral emits [TOOL_CALLS] before (not after) the function name.',
      'Ok <tool_call>calculate("6*7")</tool_call> end',
      'Ok [TOOL_CALLS] calculate(expression = two) end',
    ]) {
      expect(stripToolSyntax(words), words).toBe(words);
      expect(extractTextualToolCalls(words), words).toEqual([]);
      expect(cut(words), words).toBe(words);
      expect(cut(words, true), `${words} (stopped)`).toBe(words);
    }
  });

  it('is cut where it starts when the text ends inside it', () => {
    for (const call of [
      '<tool_call>calculate(expression="one plus',
      '[TOOL_CALLS] calculate(expression="one plus',
      '[TOOL_CALLS] calculate(exact=True, expression=[1, 2',
      '<tool_call>calculate(expr',
      '[TOOL_CALLS] calculate(expr',
    ]) {
      expect(cut(`Ok.\n${call}`), call).toBe('Ok.\n');
      expect(cut(`Ok.\n${call}`, true), `${call} (stopped)`).toBe('Ok.\n');
    }
  });
});

describe('a call written as this app writes one in a text prompt’s history: [tool name({…})]', () => {
  const cut = (text: string, stopped = false) => cutUnfinishedCall(text, { stopped, offered: OFFERED });

  it('is read and stripped, whatever its string arguments hold, as `messageText` writes it', () => {
    const text = 'Ok.\n[tool calculate({"expression": "(1+2)]"})]\nDone.';
    expect(extractTextualToolCalls(text).map((call) => [call.name, call.input])).toEqual([
      ['calculate', { expression: '(1+2)]' }],
    ]);
    expect(stripToolSyntax(text)).toBe('Ok.\n\nDone.');
    const rendered = messageText({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'calculate', input: { expression: '2' } }],
    });
    expect(extractTextualToolCalls(rendered).map((call) => call.input), rendered).toEqual([{ expression: '2' }]);
    expect(stripToolSyntax(rendered), rendered).toBe('');
  });

  it('is stripped when malformed, or written with a closing bracket too many or too few', () => {
    expect(stripToolSyntax('Ok [tool calculate({expression: 2})] end')).toBe('Ok  end');
    expect(stripToolSyntax('Ok [tool calculate({"expression": "2"}})] end')).toBe('Ok  end');
    expect(stripToolSyntax('Ok [tool calculate({"expression": {"a": "2"})] end')).toBe('Ok  end');
  });

  it('keeps prose naming the form, and is left alone in a turn that offered nothing and ran nothing', () => {
    for (const prose of [
      'The transcript shows a call as [tool name(arguments)], with the arguments as JSON.',
      'Write [tool calculate({ and then the JSON.',
    ]) {
      expect(stripToolSyntax(prose), prose).toBe(prose);
      expect(cut(prose), prose).toBe(prose);
      expect(cut(prose, true), `${prose} (stopped)`).toBe(prose);
    }
    const call = '[tool calculate({"expression": "2"})]';
    expect(stripToolSyntax(call, { offered: [] })).toBe(call);
  });

  it('is not read as a call when it recounts one the history showed, as the history showed it', () => {
    // `messageText` writes a call that ran into a text template's history in this
    // form, its strings encoded as `sanitiseMessages` encodes a tool block's. A
    // follow-up that recounts it is not calling the tool again.
    const shown = [
      { type: 'tool_use' as const, id: 'call_1', name: 'calculate', input: { expression: '6*7', note: 'at 10:30' } },
    ];
    const recounts = [
      'I worked it out with [tool calculate({"expression":"6*7","note":"at 10∶30"})] and it is 42.',
      'I worked it out with [tool calculate({"note": "at 10:30", "expression": "6*7"})] and it is 42.',
    ];
    for (const text of recounts) {
      expect(extractFrom(text, OFFERED, shown), text).toEqual([]);
      expect(stripToolSyntax(text), text).toBe('I worked it out with  and it is 42.');
    }
    // A call in that form with other arguments is a call.
    expect(
      extractFrom('Now [tool calculate({"expression":"6*8","note":"at 10:30"})].', OFFERED, shown).map(
        (call) => call.input,
      ),
    ).toEqual([{ expression: '6*8', note: 'at 10:30' }]);
    // Only this app's form is a recount: a model's own call markup is its call.
    expect(
      extractFrom('<tool_call>{"name":"calculate","arguments":{"expression":"6*7","note":"at 10:30"}}</tool_call>', OFFERED, shown),
    ).toHaveLength(1);
  });

  it('is read once when the same reply makes the same call again, in its own markup or in this form', () => {
    const app = '[tool calculate({"expression": "6*7"})]';
    const tag = '<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"}}</tool_call>';
    for (const text of [`Next, ${app}:\n${tag}`, `${tag}\nThat was ${app}.`, `Working: ${app}\n${app}`]) {
      expect(extractTextualToolCalls(text).map((call) => call.input), text).toEqual([{ expression: '6*7' }]);
    }
    // Two different calls in this form are two calls, and two of a model's own are its calls.
    expect(extractTextualToolCalls('[tool calculate({"expression": "1"})] [tool calculate({"expression": "2"})]')).toHaveLength(2);
    expect(extractTextualToolCalls(`${tag}${tag}`)).toHaveLength(2);
  });

  it('is cut where it starts when the text ends inside it, or on its opening', () => {
    expect(cut('Ok.\n[tool calculate({"expression": "one plus')).toBe('Ok.\n');
    expect(cut('Ok.\n[tool calculate({"expression": "2"})')).toBe('Ok.\n');
    expect(cut('Ok.\n[tool calculate(', true)).toBe('Ok.\n');
    expect(cut('Ok.\n[tool calculate(')).toBe('Ok.\n');
    expect(cut('See the [tool', true), 'a bare opening word').toBe('See the [tool');
  });
});

describe('a [TOOL_CALLS] call to a tool whose name or id holds a dot, a colon or a hyphen, as every MCP tool’s does', () => {
  // An MCP tool is named `server.tool`, with the id `mcp:server.tool`. Each
  // `[TOOL_CALLS]` form read its name as a word alone, so a call to one was
  // neither read, run, stripped nor cut: finished, the server was never called
  // and the call's arguments were stored and sent back; stopped, the same.
  const MCP = ['mcp:notes.note', 'notes.note', 'mcp:my-notes.add-note', 'my-notes.add-note'];
  const cut = (text: string, stopped = false) => cutUnfinishedCall(text, { stopped, offered: MCP });

  it('is read, and stripped, by name and by id, with JSON or Python’s keyword arguments, or none', () => {
    for (const [text, name, input] of [
      ['[TOOL_CALLS] notes.note({"text": "x"})', 'notes.note', { text: 'x' }],
      ['[TOOL_CALLS] mcp:notes.note({"text": "x"})', 'mcp:notes.note', { text: 'x' }],
      ['[TOOL_CALLS] my-notes.add-note(text="x")', 'my-notes.add-note', { text: 'x' }],
      ["[TOOL_CALLS]\nnotes.note(text='x', pinned=True)", 'notes.note', { text: 'x', pinned: true }],
      ['[TOOL_CALLS] notes.note()', 'notes.note', {}],
    ] as const) {
      expect(extractFrom(text, MCP, []).map((call) => [call.name, call.input]), text).toEqual([[name, input]]);
      expect(stripFrom(`Ok.\n${text}\nDone.`, { offered: MCP, ran: false }), text).toBe('Ok.\n\nDone.');
    }
  });

  it('is cut where it starts when the text ends inside it, or, stopped, on its name', () => {
    for (const call of [
      '[TOOL_CALLS] notes.note({"text": "one plus',
      '[TOOL_CALLS] mcp:notes.note(text="one plus',
      '[TOOL_CALLS] notes.note(',
    ]) {
      expect(cut(`Ok.\n${call}`), call).toBe('Ok.\n');
      expect(cut(`Ok.\n${call}`, true), `${call} (stopped)`).toBe('Ok.\n');
    }
    expect(cut('Ok.\n[TOOL_CALLS] mcp:notes.no', true)).toBe('Ok.\n');
  });

  it('keeps prose that names the marker before a dotted word', () => {
    for (const prose of ['See [TOOL_CALLS] notes.md (the file) for more.', 'Mistral emits [TOOL_CALLS] v1.2 (and later) first.']) {
      expect(stripFrom(prose, { offered: MCP, ran: false }), prose).toBe(prose);
      expect(extractFrom(prose, MCP, []), prose).toEqual([]);
      expect(cut(prose), prose).toBe(prose);
      expect(cut(prose, true), `${prose} (stopped)`).toBe(prose);
    }
  });
});

describe('a call whose single-quoted strings hold a bracket or a double quote', () => {
  // A call's end was found by scanners that knew only JSON's double quote,
  // while its body is read as a small model writes it, single quotes and all.
  // A `}` or `]` inside a single-quoted string closed the call's JSON early:
  // the stripper took the call out and the reader read nothing from the cut
  // body, so it never ran, and stopped, no record said it had not gone. A `"`
  // inside one opened a string that never closed: the call was neither read
  // nor stripped, and its arguments were stored and sent back.
  const cut = (text: string, stopped = false) => cutUnfinishedCall(text, { stopped, offered: OFFERED });
  const calc = (note: string): string => `{'name': 'calculate', 'arguments': {'expression': '6*7', 'note': '${note}'}}`;

  it('is read, and stripped whole, in each form', () => {
    for (const [text, notes] of [
      [`<tool_call>${calc('smile :-}')}</tool_call>`, ['smile :-}']],
      [`<tool_call>${calc('item 3]')}</tool_call>`, ['item 3]']],
      [`<tool_call>${calc('a 5" board')}</tool_call>`, ['a 5" board']],
      [`<tool_call>${calc('a { brace')}</tool_call>`, ['a { brace']],
      [`<tool_call>[${calc('x]')}]</tool_call>`, ['x]']],
      [`<tool_call>\n${calc('a "b')}\n${calc('c}')}\n</tool_call>`, ['a "b', 'c}']],
      [`<tool_call>calculate({'expression': '6*7', 'note': 'a 5" board'})</tool_call>`, ['a 5" board']],
      [`[TOOL_CALLS] calculate({'expression': '6*7', 'note': 'a 5" board'})`, ['a 5" board']],
      [`[TOOL_CALLS] calculate({'expression': '6*7', 'note': 'x})'})`, ['x})']],
      [`[tool calculate({'expression': '6*7', 'note': 'x}'})]`, ['x}']],
      // A closing brace too few, ended by its tag or paren, read as a call's JSON is.
      [`<tool_call>{'name': 'calculate', 'arguments': {'expression': '6*7', 'note': 'a 5" board'}</tool_call>`, ['a 5" board']],
      [`[TOOL_CALLS] calculate({'expression': '6*7', 'note': 'b}', 'more': {'a': 1})`, ['b}']],
    ] as const) {
      expect(stripToolSyntax(`Ok.\n${text}\nDone.`), text).toBe('Ok.\n\nDone.');
      const calls = extractTextualToolCalls(text);
      expect(calls.map((call) => [call.name, call.input['note']]), text).toEqual(notes.map((note) => ['calculate', note]));
    }
  });

  it('is cut where it starts when the text ends inside it or in its end, and not once it has ended', () => {
    for (const unfinished of [
      `<tool_call>${calc('a 5" board')}</tool_`,
      `<tool_call>${calc('smile :-}')}</tool_`,
      `<tool_call>${calc('smile :-}')}`,
      `[TOOL_CALLS] calculate({'expression': '6*7', 'note': 'x}'}`,
    ]) {
      expect(cut(`Ok.\n${unfinished}`), unfinished).toBe('Ok.\n');
      expect(cut(`Ok.\n${unfinished}`, true), `${unfinished} (stopped)`).toBe('Ok.\n');
    }
    const whole = `Ok.\n<tool_call>${calc('a 5" board')}</tool_call>\nDone.`;
    expect(cut(whole), whole).toBe(whole);
  });

  it('keeps prose with an apostrophe after a call’s opening', () => {
    for (const prose of [
      "Qwen's <tool_call>{ isn't JSON, and </tool_call> ends it.",
      "It opens <tool_call>{'a': 1} and that's the call's body.",
    ]) {
      expect(stripToolSyntax(prose), prose).toBe(prose);
      expect(extractTextualToolCalls(prose), prose).toEqual([]);
      expect(cut(prose), prose).toBe(prose);
    }
  });
});
