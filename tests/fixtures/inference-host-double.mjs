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
 */

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
    data: { pid: process.pid, method: message.method },
  });
});

process.send({
  k: 'boot',
  status: {
    mounted: true,
    services: ['llm'],
    routes: ['llama'],
    treeAssertion: `walked by pid ${process.pid}`,
  },
});

// Nothing else keeps this alive; the IPC channel does.
setInterval(() => undefined, 1_000);
