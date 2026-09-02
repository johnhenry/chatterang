/**
 * An inference host double that STREAMS, for the server's end-to-end test.
 *
 * `inference-host-double.mjs` next door answers calls; this one also emits the
 * progress and terminal events a generation is made of, because the property
 * the server test has to establish is not "a call came back" but "one peer's
 * tokens reached that peer and no other". Without real events on a real IPC
 * channel there is nothing to route and the ownership claim would be a claim
 * about a mock.
 *
 * Forked by `tests/server.test.ts` as a real OS process, over Node's IPC with
 * `serialization: 'advanced'` — the same transport `apps/server/src/main.ts`
 * uses, so the double's messages cross the same serializer the real host's do.
 *
 * It serves `LlamaCpp` only, and dispatches on `message.plugin`: a double that
 * answered every call regardless of the engine named would pass a call
 * addressed at an engine that does not exist.
 */

const METHODS = [
  'getCapabilities',
  'getThermalState',
  'load',
  'unload',
  'listLoaded',
  'generate',
  'cancel',
  'tokenize',
  'countTokens',
  'benchmark',
];

const fail = (id, message) => {
  process.send({ k: 'ret', id, ok: false, error: { message } });
};

process.on('message', (message) => {
  if (message === null || typeof message !== 'object') return;

  if (message.k === 'ping') {
    process.send({ k: 'pong', id: message.id });
    return;
  }
  if (message.k !== 'call') return;

  if (message.plugin !== 'LlamaCpp') {
    fail(message.id, `server host double: no plugin named "${String(message.plugin)}".`);
    return;
  }
  if (!METHODS.includes(message.method)) {
    fail(message.id, `server host double: "LlamaCpp" has no method "${String(message.method)}".`);
    return;
  }

  if (message.method === 'generate') {
    const requestId = message.args?.[0]?.requestId;
    // Two tokens then a terminal event, all tagged with the requestId — which
    // is what the supervisor routes ownership by. An event without it is
    // broadcast, so getting this wrong would make the isolation test pass for
    // the wrong reason.
    for (const text of ['one ', 'two']) {
      process.send({ k: 'ev', plugin: 'LlamaCpp', name: 'llamaToken', data: { requestId, text } });
    }
    process.send({
      k: 'ev',
      plugin: 'LlamaCpp',
      name: 'llamaEnd',
      data: {
        requestId,
        text: 'one two',
        promptTokens: 1,
        cachedTokens: 0,
        completionTokens: 2,
        ttftMs: 1,
        totalMs: 2,
        tokensPerSecond: 1,
        stopReason: 'stop',
      },
    });
    process.send({ k: 'ret', id: message.id, ok: true, data: { requestId } });
    return;
  }

  if (message.method === 'getThermalState') {
    // An event with NO requestId: it describes the machine, so the supervisor
    // broadcasts it. The test uses it to show the isolation is about ownership
    // rather than about the stream being broken.
    process.send({ k: 'ev', plugin: 'LlamaCpp', name: 'llamaThermal', data: { state: 'nominal' } });
    process.send({ k: 'ret', id: message.id, ok: true, data: { state: 'nominal' } });
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
    routes: ['llama-cpp-desktop'],
    entries: ['llm'],
    notChecked: `walked by pid ${process.pid}`,
  },
});

// Nothing else keeps this alive; the IPC channel does.
setInterval(() => undefined, 1_000);
