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
 */

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
