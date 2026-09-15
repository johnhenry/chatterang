// The hidden worker's page, for the BN3 probe.
//
// The REAL host runtime (apps/desktop/src/bridge/host-runtime.ts, types
// stripped, served by main as /bridge/host-runtime.mjs) answers the
// Supervisor's liveness pings here, on the page's main thread: the same thread
// a turn runner's tool loop runs on. A turn runner double serves
// PEER_TURN_PLUGIN the way tests/desktop-worker-host.test.ts's FakeWorker does.
//
// Main drives it with `{ k: 'probe', op }` messages on the same port. The host
// runtime never sees those. A frame carries only sequence numbers and clock
// readings: no prompt, no text.
import { createHostRuntime } from './bridge/host-runtime.mjs';
import * as protocol from './bridge/protocol.mjs';

// The bridge before BN4 has no PEER_TURN_PLUGIN. The port and window scenarios
// do not need it, so they fall back to the same names and say so in 'hello'.
// The worker scenarios load a bridge that has it (main.cjs refuses otherwise).
const peerTurnFromBridge = protocol.PEER_TURN_PLUGIN !== undefined;
const PEER_TURN_PLUGIN = protocol.PEER_TURN_PLUGIN ?? {
  name: 'PeerTurn',
  methods: ['peerTurnStart', 'peerTurnCancel'],
  events: ['peerTurnFrame', 'peerTurnEnd'],
};

const docId = crypto.randomUUID();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let port = null;
const runtimeListeners = [];
const eventListeners = new Map();
const answers = new Map();
const holds = new Set();
let relayId = null;
/** One armed block: `{ phase: 'before-pong' | 'after-pong', ms }`, taken by the next Supervisor ping. */
let armed = null;

/** Probe pings carry ids at or above this; the Supervisor's never do. */
const PROBE_PING_BASE = 1_000_000_000;

function post(message) {
  try {
    port?.postMessage(message);
  } catch {
    /* a closed port: nothing to tell */
  }
}

/** Block this thread, as a synchronous tool call would. */
function busy(ms) {
  const startWall = Date.now();
  const end = performance.now() + ms;
  let spins = 0;
  while (performance.now() < end) spins += 1;
  return { startWall, endWall: Date.now(), spins };
}

function emit(name, data) {
  for (const listener of eventListeners.get(name) ?? []) listener(data);
}

function frame(requestId, body) {
  emit('peerTurnFrame', { requestId, frame: encoder.encode(JSON.stringify(body)) });
}

function end(requestId, body) {
  if (!answers.has(requestId)) return;
  const payload = { requestId, frame: encoder.encode(JSON.stringify(body)) };
  emit('peerTurnEnd', payload);
  answers.get(requestId)(payload);
  answers.delete(requestId);
  holds.delete(requestId);
  if (relayId === requestId) relayId = null;
}

function start(requestId, config) {
  if (config.mode === 'timer') {
    // Frames paced by the page's own timer: what background throttling acts on.
    const startedAt = performance.now();
    let seq = 0;
    const step = () => {
      if (!answers.has(requestId)) return;
      if (seq >= config.count || performance.now() - startedAt >= config.durationMs) {
        end(requestId, { mode: 'timer', frames: seq });
        return;
      }
      frame(requestId, { seq, pageWall: Date.now(), pagePerf: performance.now() });
      seq += 1;
      setTimeout(step, config.intervalMs);
    };
    setTimeout(step, config.intervalMs);
    return;
  }
  if (config.mode === 'relay') {
    // Frames paced by main: one per token message, as a worker relaying a decode would.
    relayId = requestId;
    frame(requestId, { seq: -1, ready: true, pageWall: Date.now() });
    return;
  }
  // 'hold': one frame, then nothing until main says finish.
  holds.add(requestId);
  frame(requestId, { seq: 0, ready: true, pageWall: Date.now() });
}

const runner = {
  addListener: async (name, listener) => {
    const set = eventListeners.get(name) ?? new Set();
    set.add(listener);
    eventListeners.set(name, set);
    return { remove: async () => void set.delete(listener) };
  },
  peerTurnStart: (payload) =>
    new Promise((resolve) => {
      answers.set(payload.requestId, resolve);
      start(payload.requestId, JSON.parse(decoder.decode(payload.frame)));
    }),
  peerTurnCancel: async (payload) => {
    end(payload.requestId, { cancelled: true });
  },
};

const runtime = createHostRuntime({
  link: {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => runtimeListeners.push(listener),
    onClose: () => undefined,
  },
});
runtime.serve(PEER_TURN_PLUGIN, runner);

function deliver(message) {
  for (const listener of runtimeListeners) listener(message);
}

function onProbe(message) {
  switch (message.op) {
    case 'hello':
      post({ k: 'probe', op: 'hello', docId, peerTurnFromBridge, visibility: document.visibilityState, hidden: document.hidden });
      return;
    case 'arm':
      armed = { phase: message.phase, ms: message.ms };
      post({ k: 'probe', op: 'armed', phase: message.phase, ms: message.ms });
      return;
    case 'block': {
      post({ k: 'probe', op: 'block-begin', wall: Date.now() });
      const result = busy(message.ms);
      post({ k: 'probe', op: 'block-done', ...result });
      return;
    }
    case 'token':
      if (relayId !== null) frame(relayId, { seq: message.seq, pageWall: Date.now() });
      return;
    case 'token-end':
      if (relayId !== null) end(relayId, { mode: 'relay' });
      return;
    case 'finish':
      for (const requestId of [...holds]) end(requestId, { mode: 'hold' });
      return;
    case 'close-port':
      port.close();
      return;
    default:
  }
}

function onMessage(event) {
  const message = event.data;
  if (message === null || typeof message !== 'object') return;
  if (message.k === 'probe') {
    onProbe(message);
    return;
  }
  if (message.k === 'ping' && armed !== null && message.id < PROBE_PING_BASE) {
    const { phase, ms } = armed;
    armed = null;
    if (phase === 'after-pong') deliver(message);
    post({ k: 'probe', op: 'block-begin', wall: Date.now(), phase, pingId: message.id });
    const result = busy(ms);
    if (phase === 'before-pong') deliver(message);
    post({ k: 'probe', op: 'block-done', phase, pingId: message.id, ...result });
    return;
  }
  deliver(message);
}

window.addEventListener('message', (event) => {
  if (event.data !== 'probe-port' || event.ports.length === 0) return;
  port = event.ports[0];
  port.onmessage = onMessage;
  post({ k: 'probe', op: 'hello', docId, peerTurnFromBridge, visibility: document.visibilityState, hidden: document.hidden });
});
window.postMessage('probe-want-port', '*');
