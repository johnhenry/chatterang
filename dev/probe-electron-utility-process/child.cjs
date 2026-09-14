// The utility process side of probe-electron-utility-process. See main.cjs.
//
// It speaks the inference host's wire shape: `boot` on start, `pong` for a
// `ping`, and a `ret` for any `call`. A few call methods make it die in the
// ways a real host can: on its own, by abort, by an unhandled throw, by a V8
// heap-limit out-of-memory, by a V8 API fatal error (the one Electron reports
// as 'error'), or by wedging its event loop so only a kill can end it.
const port = process.parentPort;
if (port === undefined) {
  console.error('probe child: no parentPort; run it through main.cjs');
  process.exit(1);
}

function die(method, options) {
  switch (method) {
    case 'exitSelf':
      setImmediate(() => process.exit(3));
      return true;
    case 'abort':
      setImmediate(() => process.abort());
      return true;
    case 'throw':
      setImmediate(() => {
        throw new Error('probe child: unhandled throw');
      });
      return true;
    case 'wedge': {
      // Hold the loop until something kills the process. A kill() arriving
      // here is the supervisor condemning a host that stopped answering pings.
      setImmediate(() => {
        const until = Date.now() + 60_000;
        while (Date.now() < until) {
          /* busy */
        }
      });
      return true;
    }
    case 'fatal': {
      setImmediate(() => {
        // Electron's own test hook, if this build carries it; otherwise a V8
        // heap-limit fatal error under the tiny --max-old-space-size main.cjs
        // forks this scenario with.
        try {
          process._linkedBinding('electron_common_testing').triggerFatalErrorForTesting();
        } catch {
          /* not in a release build */
        }
        const hoard = [];
        for (;;) hoard.push(new Array(100_000).fill({ probe: 'oom' }));
      });
      return true;
    }
    case 'v8ApiFatal': {
      // A failed V8 API check, from fatal-api.c's load-time constructor. V8
      // hands it to the embedder's fatal error handler, which in Electron's
      // utility process reports it to main as UtilityProcess 'error' and then
      // crashes this process. dlopen never returns. If it throws instead (no
      // such file, a symbol that did not resolve), that is an unhandled throw,
      // and the scenario shows an exit with no 'error'.
      setImmediate(() => process.dlopen({ exports: {} }, options.addon));
      return true;
    }
    default:
      return false;
  }
}

port.on('message', (event) => {
  const message = event.data;
  if (message === null || typeof message !== 'object') return;
  if (message.k === 'ping') {
    port.postMessage({ k: 'pong', id: message.id });
    return;
  }
  if (message.k === 'call') {
    if (die(message.method, message.args?.[0] ?? {})) {
      port.postMessage({ k: 'ret', id: message.id, ok: true, data: { dying: message.method } });
      return;
    }
    port.postMessage({ k: 'ret', id: message.id, ok: true, data: { method: message.method } });
  }
});

port.postMessage({
  k: 'boot',
  status: { mounted: false, services: [], routes: [], entries: [], notChecked: 'probe child' },
});
