/**
 * A persona's narrowed tool policy, actually enforced by the engine — not
 * computed by `narrowToolPolicy` and then dropped (adversarial review,
 * MEDIUM, refs #23, #122). Two fields, wired here at the engine boundary
 * `state/chat.ts` calls through: `maxToolRounds` (clamped, never widened)
 * and `confirmEachCall` (the enforcement for `confirmPolicy: 'always-ask'`
 * on a tool with no destination — a destination-bearing call already asks
 * through the egress/MCP sheets, covered separately in
 * tests/privacy.test.ts and tests/middleware.test.ts).
 *
 * Driven directly against `ChatterangEngine.stream`, the same rig
 * tests/privacy.test.ts's #293 round-limit test uses (`mcpProbe`,
 * `recordingBackend`, `GRANTED_PROBE`) — this file is the same shape of
 * test, for a persona-supplied round cap instead of the engine's own fixed
 * one.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ChatterangEngine, targetFor, type GenerationEvent } from '@/ai/engine';
import { toolRegistry } from '@/ai/tools/registry';
import {
  GRANTED_PROBE,
  MCP_CALL,
  drainEvents,
  leakyTool,
  mcpProbe,
  probeManifest,
  probeResolver,
  recordingBackend,
} from './support/egress-probe';

const local = () => targetFor('llama-cpp', probeManifest.id, probeManifest.name, 'scripted');

describe('GenerationRequest.maxToolRounds', () => {
  afterEach(() => {
    toolRegistry.unregister('mcp:notes.note');
  });

  it('stops the loop after one round when the persona asked for 1, well under the engine limit', async () => {
    const probe = mcpProbe();
    toolRegistry.register(probe.tool);
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    // Five turns worth of calls queued; only the first should ever run.
    engine.router.register('scripted', recordingBackend([MCP_CALL, MCP_CALL, MCP_CALL, MCP_CALL, MCP_CALL]).adapter);

    const events = await drainEvents(
      engine.stream({
        messages: [{ role: 'user', content: 'file my note' }],
        target: local(),
        toolIds: [probe.tool.id],
        mcpEgress: GRANTED_PROBE,
        maxToolRounds: 1,
      }),
    );

    expect(probe.call, 'only the first round actually ran').toHaveBeenCalledTimes(1);

    const toolEvents = events.filter(
      (event): event is Extract<GenerationEvent, { type: 'tool' }> => event.type === 'tool',
    );
    // The first call sent; the second is read (the model did write it) but
    // never dispatched, recorded as round-limit — one round short of what
    // the engine's own TOOL_ITERATIONS would have allowed.
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]?.tool.receipt?.outcome).toBe('sent');
    expect(toolEvents[1]?.tool.receipt).toMatchObject({ outcome: 'withheld', why: 'round-limit' });
  });

  it('clamps a value ABOVE the engine limit down to it — never widens the round cap', async () => {
    const { TOOL_ITERATIONS } = await import('@/ai/engine');
    const probe = mcpProbe();
    toolRegistry.register(probe.tool);
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    const turns = Array.from({ length: TOOL_ITERATIONS + 3 }, () => MCP_CALL);
    engine.router.register('scripted', recordingBackend(turns).adapter);

    await drainEvents(
      engine.stream({
        messages: [{ role: 'user', content: 'file my note' }],
        target: local(),
        toolIds: [probe.tool.id],
        mcpEgress: GRANTED_PROBE,
        // Absurdly high — must behave exactly as `undefined` (the engine's
        // own TOOL_ITERATIONS), not as a widened cap.
        maxToolRounds: TOOL_ITERATIONS + 1000,
      }),
    );

    // Same count #293's baseline test pins for the unclamped engine default.
    expect(probe.call).toHaveBeenCalledTimes(TOOL_ITERATIONS);
  });

  it('(paired) absent maxToolRounds behaves exactly as the engine default always has', async () => {
    const { TOOL_ITERATIONS } = await import('@/ai/engine');
    const probe = mcpProbe();
    toolRegistry.register(probe.tool);
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    const turns = Array.from({ length: TOOL_ITERATIONS + 1 }, () => MCP_CALL);
    engine.router.register('scripted', recordingBackend(turns).adapter);

    await drainEvents(
      engine.stream({
        messages: [{ role: 'user', content: 'file my note' }],
        target: local(),
        toolIds: [probe.tool.id],
        mcpEgress: GRANTED_PROBE,
      }),
    );

    expect(probe.call).toHaveBeenCalledTimes(TOOL_ITERATIONS);
  });
});

describe('GenerationRequest.confirmEachCall — always-ask for a non-destination tool', () => {
  afterEach(() => {
    toolRegistry.unregister('leaky');
  });

  it('a decline reaches the engine loop and the tool never runs', async () => {
    toolRegistry.register(leakyTool);
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    engine.router.register(
      'scripted',
      recordingBackend(['<tool_call>{"name":"leaky","arguments":{}}</tool_call>', 'Done.']).adapter,
    );

    let confirmCalls = 0;

    const events = await drainEvents(
      engine.stream({
        messages: [{ role: 'user', content: 'what is in my chats?' }],
        target: local(),
        toolIds: ['leaky'],
        confirmEachCall: async () => {
          confirmCalls += 1;
          return false;
        },
      }),
    );

    expect(confirmCalls).toBe(1);
    const toolEvent = events.find(
      (event): event is Extract<GenerationEvent, { type: 'tool' }> => event.type === 'tool',
    );
    expect(toolEvent?.tool.isError).toBe(true);
    expect(toolEvent?.tool.output).toContain('Declined');
  });

  it('approval lets the same call run exactly as it would with no confirmEachCall at all', async () => {
    toolRegistry.register(leakyTool);
    const engine = new ChatterangEngine({ resolver: probeResolver, fallbackBackendId: null });
    engine.router.register(
      'scripted',
      recordingBackend(['<tool_call>{"name":"leaky","arguments":{}}</tool_call>', 'Done.']).adapter,
    );

    const events = await drainEvents(
      engine.stream({
        messages: [{ role: 'user', content: 'what is in my chats?' }],
        target: local(),
        toolIds: ['leaky'],
        confirmEachCall: async () => true,
      }),
    );

    const toolEvent = events.find(
      (event): event is Extract<GenerationEvent, { type: 'tool' }> => event.type === 'tool',
    );
    expect(toolEvent?.tool.isError).toBeFalsy();
  });
});
