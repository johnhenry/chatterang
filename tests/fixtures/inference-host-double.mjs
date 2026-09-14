/**
 * A real inference host, minus the inference.
 *
 * Forked as an actual OS process by `tests/desktop-host-process.test.ts`, so
 * that "the host was SIGKILLed" is a claim about a process and not about a
 * fake that emitted an event. It speaks the same `HostMessage` protocol
 * `apps/desktop/src/bridge/host-runtime.ts` speaks, and it can do two things
 * the real one cannot be asked to do on demand:
 *
 *   - `wedge`: stop answering pings while staying alive and answering nothing
 *     else either. This is what a spinning decode or a hung Metal call looks
 *     like from main — no `exit`, no answer, a process still in `ps`.
 *   - `hang`: answer nothing for one call, but keep answering pings. A slow
 *     load looks like this, and it must NOT be treated as a wedge.
 *
 * IT SERVES TWO PLUGINS, and dispatches on `message.plugin`. A double that
 * answered every call regardless of which engine it named would pass whatever
 * the supervisor sent, including a call addressed at an engine that does not
 * exist — which is exactly the confusion the plugin dimension was added to
 * make impossible.
 *
 * AND IT CAN BE SLOW TO START, on request: with
 * `INFERENCE_HOST_DOUBLE_STARTUP_BLOCK_MS` set, it holds its event loop for
 * that long before it can read a message. That is what a fork on a loaded
 * machine looks like from main — the supervisor's ping clock starts at spawn,
 * and a process that has not been scheduled yet answers nothing — and it is
 * the only way to show that on demand rather than by hoping for load.
 */

const startupBlockMs = Number(process.env.INFERENCE_HOST_DOUBLE_STARTUP_BLOCK_MS ?? 0);
if (startupBlockMs > 0) {
  // Synchronous, so the IPC channel is not read until it ends, and idle, so
  // the double does not add the CPU load it is standing in for.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, startupBlockMs);
}

const PLUGINS = {
  LlamaCpp: ['getCapabilities', 'getThermalState', 'load', 'unload', 'listLoaded', 'generate', 'cancel', 'tokenize', 'countTokens', 'benchmark'],
  Sidecar: ['describe', 'run', 'halt'],
};

let wedged = false;

process.on('message', (message) => {
  if (message === null || typeof message !== 'object') return;

  if (message.k === 'ping') {
    if (wedged) return;
    process.send({ k: 'pong', id: message.id });
    return;
  }

  if (message.k !== 'call') return;

  if (wedged || message.method === 'benchmark') return;

  const methods = PLUGINS[message.plugin];
  if (methods === undefined) {
    process.send({
      k: 'ret',
      id: message.id,
      ok: false,
      error: { message: `inference host double: no plugin named "${String(message.plugin)}".` },
    });
    return;
  }
  if (!methods.includes(message.method)) {
    process.send({
      k: 'ret',
      id: message.id,
      ok: false,
      error: {
        message: `inference host double: "${message.plugin}" has no method "${String(message.method)}".`,
      },
    });
    return;
  }

  if (message.method === 'unload') {
    wedged = true;
    process.send({ k: 'ret', id: message.id, ok: true, data: { wedged: true } });
    return;
  }

  if (message.method === 'listLoaded') {
    // A call that never comes back, from a host that stays healthy otherwise.
    return;
  }

  process.send({
    k: 'ret',
    id: message.id,
    ok: true,
    data: { pid: process.pid, plugin: message.plugin, method: message.method },
  });
});

process.send({
  k: 'boot',
  status: {
    mounted: true,
    services: ['llm'],
    routes: ['llama'],
    entries: [],
    notChecked: `walked by pid ${process.pid}`,
  },
});

// Nothing else keeps this alive; the IPC channel does.
setInterval(() => undefined, 1_000);
