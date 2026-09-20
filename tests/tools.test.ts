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
    expect(extractFrom(`<think>I will check.\n${call}`, OFFERED, [], { ended: 'stopped' })).toEqual([]);
  });

  it('reads no call in reasoning still open in a round cut short, as in one Stop cut', () => {
    const call = '<tool_call>{"name": "calculate", "arguments": {"expression": "2+2"}}</tool_call>';
    expect(extractFrom(`<think>I could check with ${call} but I do not need`, OFFERED, [], { ended: 'cut' })).toEqual([]);
    // A round the model ended with its reasoning open wrote its call there.
    expect(extractFrom(`<think>I will check.\n${call}`, OFFERED, [], { ended: 'model' })).toHaveLength(1);
  });

  it('reads a call in reasoning the round closed when the model ended the round with nothing outside it', () => {
    const call = '<tool_call>{"name": "calculate", "arguments": {"expression": "2+2"}}</tool_call>';
    const made = `<think>I need to add them.\n${call}\n</think>\n`;
    expect(extractTextualToolCalls(made).map((found) => found.input)).toEqual([{ expression: '2+2' }]);
    // Cut short or stopped there, an answer could still have followed it.
    expect(extractFrom(made, OFFERED, [], { ended: 'cut' })).toEqual([]);
    expect(extractFrom(made, OFFERED, [], { ended: 'stopped' })).toEqual([]);
    // Words, or a call, outside the reasoning: it only named the call.
    expect(extractTextualToolCalls(`${made}It is 4.`)).toEqual([]);
    expect(extractTextualToolCalls(`${made}${call}`)).toHaveLength(1);
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
  const cut = (text: string, stopped = false) =>
    cutUnfinishedCall(text, { ended: stopped ? 'stopped' : 'cut', offered: OFFERED });

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
      expect(cut(`Ok.\n${call}`), `${call} (cut short)`).toBe('Ok.\n');
    }
  });

  it('cuts a single-quoted tag call the text ends inside that holds Python’s True, False or None', () => {
    for (const literal of ['True', 'False', 'None']) {
      const call = `<tool_call>{'name': 'calculate', 'arguments': {'exact': ${literal}, 'expression': 'one plus`;
      expect(cut(`Ok.\n${call}`, true), call).toBe('Ok.\n');
      expect(cut(`Ok.\n${call}`), `${call} (cut short)`).toBe('Ok.\n');
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
    expect(cutUnfinishedCall('Ok.\n<tool_call>{"name": "My No', { ended: 'stopped', offered })).toBe('Ok.\n');
  });
});

describe('a <tool_call> whose body is calls, but not one JSON object', () => {
  const cut = (text: string, stopped = false) =>
    cutUnfinishedCall(text, { ended: stopped ? 'stopped' : 'cut', offered: OFFERED });

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
  const cut = (text: string, stopped = false) =>
    cutUnfinishedCall(text, { ended: stopped ? 'stopped' : 'cut', offered: OFFERED });

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

  it('runs when a list or dict argument is a closing bracket short, and keeps the words below it', () => {
    // `valueEnd` opened depth on the `[`, never saw a `]`, and ran off the end
    // of the text, which is the call's structure — where nothing but the call
    // can stand — so the call was one still being written however the reply
    // ended: the round was cut at its opening and every word after it went,
    // while nothing was read as a call, so no tool ran and no receipt said one
    // had not gone. The call's own `)` ends it, the missing bracket supplied,
    // as `shortCall` reads a JSON body a bracket short.
    for (const [form, call] of [
      ['[TOOL_CALLS]', '[TOOL_CALLS] calculate(expression="6*7", tags=["sums")'],
      ['a tag', '<tool_call>calculate(expression="6*7", tags=["sums")</tool_call>'],
      ['a dict', '[TOOL_CALLS] calculate(expression="6*7", meta={"kind": "sum")'],
    ] as const) {
      const text = `Working it out.\n${call}\nAll done — the sum is filed.`;
      expect(extractTextualToolCalls(text).map((found) => found.name), form).toEqual(['calculate']);
      expect(stripToolSyntax(cutUnfinishedCall(text, { ended: 'model', offered: OFFERED })), form).toBe(
        'Working it out.\n\nAll done — the sum is filed.',
      );
    }
    expect(
      extractTextualToolCalls('[TOOL_CALLS] calculate(expression="6*7", tags=["sums")').map((call) => call.input),
      'the arguments the model wrote, the missing bracket supplied',
    ).toEqual([{ expression: '6*7', tags: ['sums'] }]);
  });

  it('keeps every word when a list’s bracket never closes and no paren ends it either', () => {
    // Nothing but the value's own tokens stands in it, as `writesJson` asks of
    // a tag or JSON form's body: a sentence below an unclosed bracket is the
    // reply going on, not the value's words.
    const text = 'Working it out.\n[TOOL_CALLS] calculate(tags=["sums"\nAll done.';
    expect(extractTextualToolCalls(text)).toEqual([]);
    expect(stripToolSyntax(cutUnfinishedCall(text, { ended: 'model', offered: OFFERED }))).toBe(text);
  });
});

describe('a call written as this app writes one in a text prompt’s history: [tool name({…})]', () => {
  const cut = (text: string, stopped = false) =>
    cutUnfinishedCall(text, { ended: stopped ? 'stopped' : 'cut', offered: OFFERED });

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
  const cut = (text: string, stopped = false) =>
    cutUnfinishedCall(text, { ended: stopped ? 'stopped' : 'cut', offered: MCP });

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
  const cut = (text: string, stopped = false) =>
    cutUnfinishedCall(text, { ended: stopped ? 'stopped' : 'cut', offered: OFFERED });
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

  it('reads an apostrophe inside a word as one, not as a string’s opening, so a malformed call holding one is still stripped whole', () => {
    // A single quote opens a string where a token starts. Read as one inside
    // a word too, `it's` in a malformed body opened a string that never
    // closed: the call was neither stripped nor cut, and its arguments were
    // stored and sent back, where they had been stripped.
    for (const call of [
      "<tool_call>{name: calculate, arguments: {note: it's}}</tool_call>",
      '<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"}, don\'t}</tool_call>',
      "[TOOL_CALLS] calculate({expression: 6*7, note: it's})",
      "<tool_call>{'name': 'calculate', 'arguments': {'note': 'it's'}}</tool_call>",
    ]) {
      expect(stripToolSyntax(`Ok.\n${call}\nDone.`), call).toBe('Ok.\n\nDone.');
    }
    // A single-quoted string still opens after a bracket, a comma or a colon.
    expect(extractTextualToolCalls(`<tool_call>${calc("it's :-}")}</tool_call>`)).toEqual([]);
    expect(extractTextualToolCalls(`<tool_call>${calc('a :-}')}</tool_call>`).map((call) => call.input['note'])).toEqual([
      'a :-}',
    ]);
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

describe('an unfinished call, by how the text ended', () => {
  // A value's words — a string, or a Qwen3-Coder parameter's value — can be
  // anything, so an opening named in prose with no closing quote or tag after
  // it reads as a call still being written to the end of the text. Only a text
  // cut short can end inside a call: the model ends its reply outside one.
  const cut = (text: string, ended: 'stopped' | 'cut' | 'model') => cutUnfinishedCall(text, { ended, offered: OFFERED });

  it('keeps every word of a text the model ended that runs on from inside a value, and cuts one cut short there', () => {
    for (const words of [
      'Qwen3-Coder opens a call like this:\n\n```\n<tool_call>\n<function=get_weather>\n<parameter=city>\n```\n\nThe city goes next.',
      '<tool_call>\n<function=search>\n<parameter=query>\nis how Qwen3-Coder begins a call; the value follows, then the closing tags.',
      'A Python-style call looks like <tool_call>search(query=" and then the words.',
      "Mistral's would be [TOOL_CALLS] search(query=' and then the words.",
      "It can hold a list, [TOOL_CALLS] search(tags=['a', ' and so on.",
      'Qwen writes <tool_call>{"name": "search", "arguments": {"query": " and then the words.',
      'An array: <tool_call>[{"name": "search", "arguments": {"query": " and so on.',
      'Its history writes [tool calculate({"expression": " and then the sum.',
      'Its arguments are an object, <tool_call>{"name": "search", "arguments": {" and then each key.',
      'Mistral writes [TOOL_CALLS] search({" and then each key.',
    ]) {
      expect(cut(words, 'model'), words).toBe(words);
      for (const ended of ['cut', 'stopped'] as const) {
        expect(cut(words, ended), `${words} (${ended})`).not.toBe(words);
      }
    }
  });

  it('cuts a text the model ended inside a call’s structure, or on its opening', () => {
    for (const call of [
      '<tool_call>{"name": "calc',
      '<tool_call>{"name": "calculate", "arguments": {"expr',
      '<tool_call>{"name": "calculate", "arguments": {"expression": 1.5e',
      '<tool_call>{"name": "calculate", "arguments": {}}',
      '<tool_call>{"name": "calculate", "arguments": {}}</tool_',
      '<tool_call>calculate(expr',
      '[TOOL_CALLS] calculate(exact=Tr',
      '[TOOL_CALLS] calculate(tags=[1, 2',
      '<tool_call>\n<function=calculate>\n<parameter=expr',
      '<tool_call>\n<function=calcul',
      '<tool_call>\n<function=calculate>\n<parameter=expression>\n6*7\n</param',
      '<tool_call>\n<function=calculate>\n<parameter=expression>\n6*7\n</parameter>\n</func',
      '<tool_call>{',
      '[TOOL_CALLS] calculate(',
    ]) {
      expect(cut(`Ok.\n${call}`, 'model'), call).toBe('Ok.\n');
    }
  });

  it('cuts a stopped or cut-short text on a bare marker, and keeps a model-ended one’s', () => {
    // A text cut short ended wherever it was, as one Stop landed in did: a
    // bare marker there may be a call begun. The model ends its reply outside
    // one, so a marker it ended on is a word naming it.
    for (const marker of [
      '<tool_call>',
      '<tool_call>\n',
      '<tool_call>\n```json\n',
      '<tool_call>\n<function',
      '[TOOL_CALLS]',
      '[TOOL_CALLS] calculate',
    ]) {
      for (const ended of ['stopped', 'cut'] as const) {
        expect(cut(`Ok.\n${marker}`, ended), `${JSON.stringify(marker)} (${ended})`).toBe('Ok.\n');
      }
      expect(cut(`Ok.\n${marker}`, 'model'), `${JSON.stringify(marker)} (model)`).toBe(`Ok.\n${marker}`);
    }
  });

  it('cuts a stopped or cut-short text ending partway into the close of a call with a closing bracket too few', () => {
    // Its JSON never closes, so it is not JSON being written once the close
    // begins, and the close is not whole, so it is not a finished call either:
    // the same call with its brace was cut here, and this one kept, arguments
    // and all. Its close may arrive in pieces, a fence and a line break before
    // `</tool_call>` whatever the tokenizer makes of the tag.
    const short = '{"name": "calculate", "arguments": {"expression": "6*7"}';
    for (const call of [
      `<tool_call>${short}</tool_`,
      `<tool_call>${short}\n</tool_call`,
      `<tool_call>\n\`\`\`json\n${short}\n\`\`\`\n`,
      `<tool_call>\n\`\`\`json\n${short}\n\`\``,
      `<tool_call>\n\`\`\`json\n${short}\n\`\`\`\n</tool`,
      '[tool calculate({"expression": "6*7")',
      '[TOOL_CALLS] calculate({"expression": "6*7", "exact": {"digits": 2}',
      // After a call written without its close, which only this one's opening
      // ends: cut with it, or it is left with nothing after it to end it.
      `<tool_call>{"name": "calculate", "arguments": {"expression": "6*8"}}\n<tool_call>${short}</tool_`,
    ]) {
      for (const ended of ['stopped', 'cut'] as const) {
        expect(cut(`Ok.\n${call}`, ended), `${call} (${ended})`).toBe('Ok.\n');
      }
    }
  });

  it('keeps prose after a call’s opening that names its closing tag, stopped or cut short', () => {
    for (const words of [
      'Qwen writes <tool_call>{"name": "calculate", "arguments": {} and then the tag </tool_',
      'Write <tool_call>{"name": "calculate"} then close it with </tool_',
    ]) {
      for (const ended of ['stopped', 'cut'] as const) expect(cut(words, ended), `${words} (${ended})`).toBe(words);
    }
  });
});

describe('two calls, the first written without its closing tag or paren', () => {
  // A small model writing two calls can leave out the first one's close. Read
  // by a close that must follow its JSON, the first was neither read nor
  // stripped nor cut: only the second ran, and the first, arguments and all,
  // was stored and sent back in every later request. The lazy match main
  // stripped with took both out. The next call's opening ends the first.
  const calc = (expression: string): string => `{"name": "calculate", "arguments": {"expression": "${expression}"}}`;
  const FORMS = [
    ['tags', `Let me work both out.\n<tool_call>\n${calc('6*7')}\n<tool_call>\n${calc('6*8')}\n</tool_call>`],
    [
      '[TOOL_CALLS]',
      'Let me work both out.\n[TOOL_CALLS] calculate({"expression": "6*7"}\n[TOOL_CALLS] calculate({"expression": "6*8"})',
    ],
  ] as const;

  /** A round's words as the engine and the store read them: cut where it ended, then stripped. */
  const words = (text: string, ended: 'model' | 'cut' | 'stopped'): string =>
    stripToolSyntax(cutUnfinishedCall(text, { ended, offered: OFFERED }));

  it('reads both, and leaves none of either in the words, however the text ended', () => {
    for (const [form, text] of FORMS) {
      expect(extractTextualToolCalls(text).map((found) => found.input), form).toEqual([
        { expression: '6*7' },
        { expression: '6*8' },
      ]);
      expect(stripToolSyntax(text), form).toBe('Let me work both out.');
      for (const ended of ['model', 'cut', 'stopped'] as const) {
        expect(words(`${text}\nBoth are done.`, ended), `${form}, ${ended}`).toBe(
          'Let me work both out.\n\nBoth are done.',
        );
        expect(words(text, ended), `${form}, ${ended}, at the end`).toBe('Let me work both out.');
      }
    }
  });

  it('reads the first, and cuts the second, when the text ends inside the second or on its opening', () => {
    for (const second of [
      '<tool_call>{"name": "calculate", "arguments": {"expression": "6*',
      '<tool_call>',
      '[TOOL_CALLS] calculate(',
      '[TOOL_CALLS] calculate',
    ]) {
      const text = `Both.\n<tool_call>${calc('6*7')}\n${second}`;
      expect(extractFrom(text, OFFERED, [], { ended: 'stopped' }).map((found) => found.input), second).toEqual([
        { expression: '6*7' },
      ]);
      expect(words(text, 'stopped'), second).toBe('Both.');
    }
    const mistral = 'Both.\n[TOOL_CALLS] calculate({"expression": "6*7"}\n[TOOL_CALLS] calculate({"expression": "6*';
    expect(words(mistral, 'stopped')).toBe('Both.');
  });

  it('cuts the first, unread, when the text ends partway into the opening after it', () => {
    for (const [first, opening] of [
      [`<tool_call>${calc('6*7')}`, '<tool_c'],
      [`<tool_call>${calc('6*7')}`, '[TOOL_CA'],
      ['[TOOL_CALLS] calculate({"expression": "6*7"}', '[TOOL_CALLS'],
      ['[TOOL_CALLS] calculate({"expression": "6*7"}', '<tool'],
    ] as const) {
      const text = `Both.\n${first}\n${opening}`;
      for (const ended of ['stopped', 'cut', 'model'] as const) {
        expect(words(text, ended), `${text}, ${ended}`).toBe('Both.');
      }
      expect(extractFrom(text, OFFERED, [], { ended: 'stopped' }), text).toEqual([]);
    }
  });

  it('is ended by the other form’s opening too', () => {
    for (const text of [
      `Both.\n<tool_call>${calc('6*7')}\n[TOOL_CALLS] calculate({"expression": "6*8"})`,
      `Both.\n[TOOL_CALLS] calculate({"expression": "6*7"}\n<tool_call>${calc('6*8')}</tool_call>`,
    ]) {
      expect(extractTextualToolCalls(text).map((found) => found.input['expression']), text).toEqual(['6*7', '6*8']);
      for (const ended of ['stopped', 'cut', 'model'] as const) {
        expect(words(`${text}\nDone.`, ended), `${text}, ${ended}`).toBe('Both.\n\nDone.');
      }
    }
  });

  it('keeps prose between a call’s JSON and a later opening', () => {
    const prose = `Write <tool_call>${calc('6*7')} and then another <tool_call> tag after it.`;
    expect(stripToolSyntax(prose)).toBe(prose);
    expect(extractTextualToolCalls(prose)).toEqual([]);
  });
});

describe('a call whose string argument names a reasoning tag', () => {
  // A `<think>` inside a finished call's string is the argument's words. Read
  // as reasoning opening there, it ran to the end of the round: a call after it
  // was taken for one drafted in reasoning, and a round cut short was cut from
  // the call's opening, every word after it with it.
  const noted = (expression: string): string =>
    `<tool_call>{"name": "calculate", "arguments": {"expression": "${expression}", "note": "<think> is where I reason"}}</tool_call>`;
  const words = (text: string, ended: 'model' | 'cut' | 'stopped'): string =>
    stripToolSyntax(cutUnfinishedCall(text, { ended, offered: OFFERED }));

  it('is read as a call, and so is a call after it, however the round ended', () => {
    const text = `${noted('6*7')}\n<tool_call>{"name": "calculate", "arguments": {"expression": "6*8"}}</tool_call>`;
    for (const ended of ['model', 'cut', 'stopped'] as const) {
      expect(extractFrom(text, OFFERED, [], { ended }).map((found) => found.input['expression']), ended).toEqual([
        '6*7',
        '6*8',
      ]);
    }
  });

  it('takes none of the words after it with it, however the round ended', () => {
    for (const ended of ['model', 'cut', 'stopped'] as const) {
      expect(words(`Ok.\n${noted('6*7')}\nDone.`, ended), ended).toBe('Ok.\n\nDone.');
    }
  });

  it('still cuts a call the round ended inside, whose string names one', () => {
    const text = 'Ok.\n<tool_call>{"name": "calculate", "arguments": {"expression": "6*7", "note": "<think> is where';
    for (const ended of ['cut', 'stopped'] as const) expect(words(text, ended), ended).toBe('Ok.');
  });
});

describe('a call the model ended its reply on, written without its close', () => {
  // A model that ends its reply has ended any call it wrote, as the next
  // call's opening ends one written without its close. Read as a call still
  // being written, it was cut from the reply and never ran: no follow-up, no
  // record, and a reply saying it was doing something that never happened. A
  // text Stop landed in, or one cut short, could have gone on to its close.
  const calc = '{"name": "calculate", "arguments": {"expression": "6*7"}}';
  const FORMS = [
    ['a tag', `<tool_call>${calc}`],
    ['a tag, a line break after it', `<tool_call>\n${calc}\n`],
    ['a tag, partway into its closing tag', `<tool_call>${calc}</tool_`],
    ['a tag, a closing brace too few', '<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"}'],
    [
      'a tag, a closing brace too few, partway into its closing tag',
      '<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"}</tool_',
    ],
    ['this app’s history form, a closing brace too few', '[tool calculate({"expression": "6*7")'],
    ['a fenced call in a tag', `<tool_call>\n\`\`\`json\n${calc}\n\`\`\``],
    ['[TOOL_CALLS]', '[TOOL_CALLS] calculate({"expression": "6*7"}'],
    ['[TOOL_CALLS], Python’s keyword arguments', '[TOOL_CALLS] calculate(expression="6*7"'],
    ['a name and its JSON in a tag', '<tool_call>calculate({"expression": "6*7"})'],
    ['this app’s history form', '[tool calculate({"expression": "6*7"})'],
    ['Qwen3-Coder’s XML', '<tool_call>\n<function=calculate>\n<parameter=expression>\n6*7\n</parameter>\n</function>\n'],
    ['Qwen3-Coder’s XML, partway into </function>', '<tool_call>\n<function=calculate>\n<parameter=expression>\n6*7\n</parameter>\n</func'],
  ] as const;
  /** A round's words as the engine and the store read them: cut where it ended, then stripped. */
  const words = (text: string, ended: 'model' | 'cut' | 'stopped'): string =>
    stripToolSyntax(cutUnfinishedCall(text, { ended, offered: OFFERED }));
  const read = (text: string, ended: 'model' | 'cut' | 'stopped') =>
    extractFrom(text, OFFERED, [], { ended }).map((call) => [call.name, call.input['expression']]);

  it('is read as the call it is, and none of it is left in the words', () => {
    for (const [form, call] of FORMS) {
      const text = `Working it out. ${call}`;
      expect(read(text, 'model'), form).toEqual([['calculate', '6*7']]);
      expect(words(text, 'model'), form).toBe('Working it out.');
    }
  });

  it('is not read as a call when the text was stopped or cut short there, and none of it is left', () => {
    for (const [form, call] of FORMS) {
      const text = `Working it out. ${call}`;
      for (const ended of ['stopped', 'cut'] as const) {
        // Its closing fence written, the fenced block inside the tag is a whole
        // fenced call, and is read as one however the text ended.
        const whole = form === 'a fenced call in a tag' ? [['calculate', '6*7']] : [];
        expect(read(text, ended), `${form} (${ended})`).toEqual(whole);
        expect(words(text, ended), `${form} (${ended})`).toBe('Working it out.');
      }
    }
  });

  it('reads a call the text ends partway, or wholly, into the opening after', () => {
    // Nothing follows that opening, so it ends nothing: the call before it
    // ends where the text does. Both are cut from the words, as 5cef541 cuts
    // them however the text ended.
    for (const opening of ['<tool_c', '<tool_call>', '[TOOL_CA', '[TOOL_CALLS]']) {
      const text = `Ok.\n<tool_call>${calc}\n${opening}`;
      expect(read(text, 'model'), opening).toEqual([['calculate', '6*7']]);
      expect(words(text, 'model'), opening).toBe('Ok.');
    }
  });

  it('reads both of two calls written without their close, however far into the second’s close the text ends', () => {
    for (const end of ['', '\n', '</tool_call']) {
      const text = `Both.\n<tool_call>${calc}\n<tool_call>{"name": "calculate", "arguments": {"expression": "6*8"}}${end}`;
      expect(read(text, 'model'), JSON.stringify(end)).toEqual([
        ['calculate', '6*7'],
        ['calculate', '6*8'],
      ]);
      expect(words(text, 'model'), JSON.stringify(end)).toBe('Both.');
    }
  });

  it('is read and cut whole when its string names a reasoning tag, or it stands in reasoning the model left open', () => {
    // A reasoning tag in its string is its words, as in a call closed by its
    // tag; and a round the model ended with its reasoning open wrote its call
    // there. Read as reasoning, it ran and kept its markup, arguments and all,
    // in the words or the stored reasoning.
    const noted = '<tool_call>{"name": "calculate", "arguments": {"expression": "6*7", "note": "<think> is where I reason"}}';
    expect(read(`Ok. ${noted}`, 'model')).toEqual([['calculate', '6*7']]);
    expect(words(`Ok. ${noted}`, 'model')).toBe('Ok.');
    const open = `Ok. <think>I will work it out.\n<tool_call>${calc}`;
    expect(read(open, 'model')).toEqual([['calculate', '6*7']]);
    expect(words(open, 'model')).toBe('Ok. <think>I will work it out.');
    // Stopped there, reasoning left open is still reasoning, and keeps its words.
    expect(read(open, 'stopped')).toEqual([]);
    expect(words(open, 'stopped')).toBe(open);
  });

  it('keeps an example the reply ends on that names no tool the request offered, and reads no call from it', () => {
    // The end of the text is not the model's markup as a closing tag is: a call
    // it closes is ambiguous with an example the reply ends on, and is read as
    // a fenced block is, a call when it names an offered tool.
    for (const example of [
      'Qwen’s format:\n<tool_call>{"name": "get_weather", "arguments": {"city": "Paris"}}',
      'Qwen’s format, a brace short:\n<tool_call>{"name": "get_weather", "arguments": {"city": "Paris"}',
      'Mistral’s: [TOOL_CALLS] get_weather({"city": "Paris"}',
      'Qwen3-Coder’s: <tool_call>\n<function=get_weather>\n<parameter=city>\nParis\n</parameter>\n</function>',
    ]) {
      expect(read(example, 'model'), example).toEqual([]);
      expect(words(example, 'model'), example).toBe(example);
    }
  });

  it('is still cut, and not read, when the model ended it on an opening with nothing written inside', () => {
    for (const opening of [
      '<tool_call>{',
      '<tool_call>\n```json\n{',
      '[TOOL_CALLS] calculate(',
      '[TOOL_CALLS] calculate({',
      '[TOOL_CALLS] get_weather({',
      '[tool calculate({',
      '<tool_call>calculate(',
      '<tool_call>calculate({',
    ]) {
      expect(read(`Ok.\n${opening}`, 'model'), opening).toEqual([]);
      expect(words(`Ok.\n${opening}`, 'model'), opening).toBe('Ok.');
    }
  });
});

describe('a fenced <tool_call> whose body is an ARRAY of calls', () => {
  // The tag around a fence is markup whatever its JSON holds, and `CALL_SHAPES`
  // reads that JSON opening on `{` or `[`. The CUT's own opening read `{`
  // alone, so a fenced tag holding an array was markup to the stripper and the
  // reader and invisible to the cut: its whole block, name and arguments, was
  // stored as the reply's words and sent back in every later request — after
  // the arguments had reached the server, when the model ended its reply on it
  // and the follow-up wrote nothing, and with no record at all when Stop or a
  // limit on tokens landed inside it. The same array in a plain tag, and the
  // same fenced tag around an object, were both cut.
  const batch = '[{"name": "calculate", "arguments": {"expression": "6*7"}}]';
  const fenced = (body: string): string => `Working it out.\n<tool_call>\`\`\`json\n${body}`;
  /** A round's words as the engine and the store read them: cut where it ended, then stripped. */
  const words = (text: string, ended: 'model' | 'cut' | 'stopped'): string =>
    stripToolSyntax(cutUnfinishedCall(text, { ended, offered: OFFERED }));
  const read = (text: string, ended: 'model' | 'cut' | 'stopped') =>
    extractFrom(text, OFFERED, [], { ended }).map((call) => [call.name, call.input['expression']]);

  it('is read as the call it is, and none of it is left in the words, when the model ended its reply on it', () => {
    const text = fenced(`${batch}\n\`\`\``);
    expect(read(text, 'model')).toEqual([['calculate', '6*7']]);
    expect(words(text, 'model')).toBe('Working it out.');
  });

  it('leaves none of itself in the words wherever the turn was stopped or cut short inside it', () => {
    for (const [where, body] of [
      ['on its opening bracket', '['],
      ['inside its arguments', '[{"name": "calculate", "arguments": {"expression": "6*'],
      ['with its calls whole, before its fence', batch],
      ['with its fence written, before the closing tag', `${batch}\n\`\`\``],
    ] as const) {
      for (const ended of ['stopped', 'cut'] as const) {
        expect(read(fenced(body), ended), `${where} (${ended})`).toEqual([]);
        expect(words(fenced(body), ended), `${where} (${ended})`).toBe('Working it out.');
      }
    }
  });

  it('is read and cut whole when its closing tag is written, as the same array in a plain tag is', () => {
    for (const [form, text] of [
      ['a fenced tag', fenced(`${batch}\n\`\`\`</tool_call>`)],
      ['a plain tag', `Working it out.\n<tool_call>${batch}</tool_call>`],
    ] as const) {
      expect(read(text, 'model'), form).toEqual([['calculate', '6*7']]);
      expect(words(text, 'model'), form).toBe('Working it out.');
    }
  });

  it('keeps a fenced array in a tag that names no tool the request offered, and reads no call from it', () => {
    // As `callsOnlyTo` keeps any other example the reply ends on: the end of
    // the text is where an example ends too.
    const example = fenced('[{"name": "get_weather", "arguments": {"city": "Paris"}}]\n```');
    expect(read(example, 'model')).toEqual([]);
    expect(words(example, 'model')).toBe(example);
  });
});

describe('a call with a closing bracket too few, written without its close, the reply going on below it', () => {
  // `shortCall` ends such a call at the token that closes its form, and
  // `endOfJson` at the bracket that closes its JSON. A call with NEITHER was
  // read by nothing at all: it never ran, no receipt said it had not gone, and
  // its whole markup, arguments and all, was stored as the reply's words and
  // rode in every later request while the reply said it had filed a note that
  // never went. The same call with its close, the same call ending the reply,
  // and the well-formed call without its close were all handled: 231a841 wrote
  // the rule this one should have fallen under and could not reach it.
  const FORMS = [
    ['a tag', '<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"}'],
    ['a tag, over several lines', '<tool_call>{\n  "name": "calculate",\n  "arguments": {"expression": "6*7"}'],
    ['a tag, single-quoted', "<tool_call>{'name': 'calculate', 'arguments': {'expression': '6*7'}"],
    ['[TOOL_CALLS]', '[TOOL_CALLS] calculate({"expression": {"inner": "6*7"}'],
    ['this app’s history form', '[tool calculate({"expression": {"inner": "6*7"}'],
    [
      'Qwen3-Coder’s XML, no </function>',
      '<tool_call>\n<function=calculate>\n<parameter=expression>\n6*7\n</parameter>',
    ],
  ] as const;
  /** A round's words as the engine and the store read them: cut where it ended, then stripped. */
  const words = (text: string, ended: 'model' | 'cut' | 'stopped'): string =>
    stripToolSyntax(cutUnfinishedCall(text, { ended, offered: OFFERED }));
  const read = (text: string, ended: 'model' | 'cut' | 'stopped') =>
    extractFrom(text, OFFERED, [], { ended }).map((call) => call.name);

  it('is read as the call it is, and none of it is left in the words', () => {
    for (const [form, call] of FORMS) {
      const text = `Working it out.\n${call}\nAll done — the sum is filed.`;
      for (const ended of ['model', 'cut'] as const) {
        expect(read(text, ended), `${form} (${ended})`).toEqual(['calculate']);
        expect(words(text, ended), `${form} (${ended})`).toBe('Working it out.\n\nAll done — the sum is filed.');
      }
    }
  });

  it('carries the arguments the model wrote, the missing bracket supplied', () => {
    const text =
      'Working it out.\n<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"}\nAll done.';
    expect(extractFrom(text, OFFERED, [], { ended: 'model' }).map((call) => call.input)).toEqual([
      { expression: '6*7' },
    ]);
  });

  it('ends at the last line its JSON reaches, however many lines of words follow', () => {
    // Its brackets never balance, so every line break after it ends a JSON
    // prefix as well: only the ones its own tokens reach parse, and the
    // furthest of those is where the call stops and the words begin.
    const text =
      'Working it out.\n<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"}\nAll done.\nAnything else?';
    expect(read(text, 'model')).toEqual(['calculate']);
    expect(words(text, 'model')).toBe('Working it out.\n\nAll done.\nAnything else?');
  });

  it('is kept whole when it names no tool the request offered', () => {
    // `callsOnlyTo`, as for every other call written without its close: a
    // call-shaped example is words, and stays in them.
    const example =
      'Qwen’s format, a brace short:\n<tool_call>{"name": "get_weather", "arguments": {"city": "Paris"}\nand then the closing tag.';
    expect(read(example, 'model')).toEqual([]);
    expect(words(example, 'model')).toBe(example);
  });

  it('is kept whole when its shape is named inside a sentence that goes on on the same line', () => {
    // `wordsAfterCall`'s line rule: a call the model left ends the line it
    // stands on, and a sentence that goes on past it is words whatever it names.
    const sentence =
      'Write <tool_call>{"name": "calculate", "arguments": {"expression": "6*7"} and then another <tool_call> tag after it.\nOk?';
    expect(read(sentence, 'model')).toEqual([]);
    expect(words(sentence, 'model')).toBe(sentence);
  });

  it('is kept whole when it is a sentence whose JSON never parses, over two lines', () => {
    // `looseJson` reads the order of a call's tokens, so a line of prose inside
    // the candidate is not a call's JSON however far the brackets stay open.
    const doc =
      'Look for <tool_call>{"name": "…" in the output\nand read the JSON until its brackets balance.';
    expect(read(doc, 'model')).toEqual([]);
    expect(words(doc, 'model')).toBe(doc);
  });
});

describe('the calls in one tag, separated as an array’s elements are', () => {
  // A trailing comma is the commonest JSON malformation there is. Read as
  // neither a next call nor the tag's close, the tag ended at its last call
  // and `wordsAfterCall` refused what followed as the rest of a close: the
  // block was markup to no reader at all, so the tool never ran, nothing
  // recorded that it had not gone, and the whole tag with the model's
  // arguments was stored as the reply's words and sent back in every later
  // request — the opposite of `stripToolSyntax`'s own contract, that in a turn
  // which offered a tool the tag forms are markup whatever their body,
  // malformed ones included.
  const one = '{"name": "calculate", "arguments": {"expression": "6*7"}}';
  const two = '{"name": "calculate", "arguments": {"expression": "6*8"}}';
  const read = (text: string) => extractTextualToolCalls(text).map((call) => call.input['expression']);

  it('runs every call in a tag whose calls a comma or a semicolon separates, and leaves none of it in the words', () => {
    for (const [form, body, expected] of [
      ['a trailing comma, then the closing tag', `\n${one},\n`, ['6*7']],
      ['a trailing semicolon', `${one};`, ['6*7']],
      ['two calls, comma separated', `${one}, ${two}`, ['6*7', '6*8']],
      ['two calls, comma separated over lines', `\n${one},\n${two}\n`, ['6*7', '6*8']],
      ['two calls, whitespace separated', `\n${one}\n${two}\n`, ['6*7', '6*8']],
    ] as const) {
      const text = `<tool_call>${body}</tool_call>`;
      expect(read(text), form).toEqual([...expected]);
      expect(stripToolSyntax(text), form).toBe('');
    }
  });

  it('runs the call a trailing comma follows when the reply goes on below it, and keeps those words', () => {
    const text = `Working it out.\n<tool_call>${one},\nAll done.`;
    expect(read(text)).toEqual(['6*7']);
    expect(stripToolSyntax(text)).toBe('Working it out.\n\nAll done.');
  });

  it('keeps a call’s shape named inside a sentence that goes on past its comma on the same line', () => {
    // `wordsAfterCall`'s line rule, unchanged: the separators a call ends with
    // are the ones on its own line, and a sentence that runs on is words.
    const sentence = `Write <tool_call>${one}, and then the closing tag after it.`;
    expect(read(sentence)).toEqual([]);
    expect(stripToolSyntax(sentence)).toBe(sentence);
  });

  it('keeps a sentence that names both tags, on one line or on lines of their own', () => {
    for (const prose of [
      'Qwen wraps each call in a <tool_call> tag and ends it with </tool_call> after the JSON.',
      'Qwen opens with\n<tool_call>\nand ends with\n</tool_call>\nafter the JSON.',
    ]) {
      expect(read(prose), prose).toEqual([]);
      expect(stripToolSyntax(prose), prose).toBe(prose);
    }
  });

  it('takes out the closing tag a reply left behind after going on past its call', () => {
    // The opening it closes went with the call, so what is left is a call's
    // markup with nothing in it: markup the person reads and the model is sent
    // back. The words between it and the call are the person's, and stay.
    const text = `Ok.\n<tool_call>\n${one}\n\nFiled it.\n</tool_call>\n\nAnything else?`;
    expect(read(text)).toEqual(['6*7']);
    expect(stripToolSyntax(text)).toBe('Ok.\n\n\nFiled it.\n\n\nAnything else?');
  });

  it('keeps a closing tag the reply wrote below a call that closed its own tag', () => {
    // Only an opening left unclosed leaves a close behind. A reply that made a
    // call and then answered a question about the format — the closing marker
    // on a line of its own, in a code block or in a sentence — had that line
    // taken out, so the code block the person asked for was stored empty.
    const closed = `<tool_call>${one}</tool_call>`;
    for (const [shape, after] of [
      ['in a code block', '\x60\x60\x60\n</tool_call>\n\x60\x60\x60'],
      ['in a sentence', 'You close it like this:\n\n</tool_call>\n\nand that is the whole format.'],
    ] as const) {
      const text = `Filed.\n${closed}\n${after}`;
      expect(read(text), shape).toEqual(['6*7']);
      expect(stripToolSyntax(text), shape).toBe(`Filed.\n\n${after}`);
    }
  });
});

describe('a call a bracket short whose brackets a later closer balances', () => {
  // `shortCall` needs the form's close token and finds none; `endOfJson` runs
  // past the words below the call and closes on the first spare bracket it
  // meets — a second call's, or a `}` the reply wrote in a sentence. The span
  // it covers parses as nothing and reads no call, and was markup all the
  // same: both calls were lost inside it, so neither ran and nothing recorded
  // that they had not gone, while `stripToolSyntax` took the sentence between
  // them out of the words the person had watched arrive.
  //
  // The call ends where its own JSON's tokens end, as one with no closer after
  // it already does (`shortCallWithoutClose`), which is a line break: a call
  // the reply goes on past ends the line it stands on.
  const SHORT = '<tool_call>{"name": "calculate", "arguments": {"expression": "6*7"}';
  const words = (text: string): string =>
    stripToolSyntax(cutUnfinishedCall(text, { ended: 'model', offered: OFFERED }));
  const read = (text: string) => extractTextualToolCalls(text).map((call) => call.input['expression']);

  it('reads both calls, and keeps the sentence the reply wrote between them', () => {
    const text = `Filing both.\n${SHORT}\nAnd the second:\n<tool_call>{"name": "calculate", "arguments": {"expression": "6*8"}}}</tool_call>\nBoth queued.`;
    expect(read(text)).toEqual(['6*7', '6*8']);
    expect(words(text)).toBe('Filing both.\n\nAnd the second:\n\nBoth queued.');
  });

  it('reads the call a stray closer in a later sentence balanced, and keeps that sentence', () => {
    const text = `Filing it.\n${SHORT}\nThe set is {1, 2, 3}, which ends in }.\nAll done.`;
    expect(read(text)).toEqual(['6*7']);
    expect(words(text)).toBe('Filing it.\n\nThe set is {1, 2, 3}, which ends in }.\nAll done.');
  });

  it('keeps a call-shaped example naming no offered tool, and the stray closer below it', () => {
    // `callsOnlyTo`, as for every other call written without its close.
    const example =
      'Qwen’s format, a brace short:\n<tool_call>{"name": "get_weather", "arguments": {"city": "Paris"}\nand a spare } ends the object.';
    expect(read(example)).toEqual([]);
    expect(words(example)).toBe(example);
  });

  it('keeps a call’s shape named inside a sentence that goes on on the same line', () => {
    // `wordsAfterCall`'s line rule: only a call that ends the line it stands on
    // is one the reply went on past.
    const sentence = `Write ${SHORT} and then a spare } after it.\nOk?`;
    expect(read(sentence)).toEqual([]);
    expect(words(sentence)).toBe(sentence);
  });

  it('leaves a tag nested in another’s JSON the one malformed markup it is', () => {
    // All on one line, so no line break ends a JSON prefix: the outer tag is
    // the markup it has always been, and nothing runs from the tag inside it.
    const malformed =
      '<tool_call>{"name":"calculate","arguments":{}, "then": <tool_call>{"name":"calculate","arguments":{}}</tool_call>}</tool_call>';
    expect(extractTextualToolCalls(malformed), malformed).toEqual([]);
    expect(stripToolSyntax(`Ok.${malformed}Done.`), malformed).toBe('Ok.Done.');
  });
});
