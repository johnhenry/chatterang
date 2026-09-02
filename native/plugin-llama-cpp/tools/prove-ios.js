/*
 * Proof harness for the iOS llama.cpp plugin. NOT part of the app.
 *
 * `prove-ios.sh` copies this beside the built `dist/` and appends a <script>
 * tag for it, so it runs inside the real app, against the real registered
 * plugin, on the simulator — and never ships in a normal build. Every line it
 * prints is prefixed `[PROVE]` so the driver can pull it out of a device log
 * that is otherwise full of UIKit noise.
 *
 * It exists because "no error was thrown" is not evidence that a native method
 * ran. Each step below either reports a value only llama.cpp could produce (a
 * token id from a 6.5 GB vocabulary, a cache-reuse count, a coherent
 * completion) or asserts an invariant that the code under test could plausibly
 * get wrong (exactly one terminal event, on every path).
 */
(async () => {
  const out = (step, data) => console.log(`[PROVE] ${JSON.stringify({ step, ...data })}`);
  const fail = (step, error) => out(step, { ok: false, error: String(error && error.message || error) });

  // Give the app's own bootstrap a moment to register the plugin.
  for (let i = 0; i < 100 && !(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LlamaCpp); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const Llama = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LlamaCpp;
  if (!Llama) return out('bootstrap', { ok: false, error: 'LlamaCpp plugin never appeared on window.Capacitor.Plugins' });

  const CONFIG = window.__PROVE__ || {};

  /* Terminal-event accounting. The contract is that `generate` emits EXACTLY
   * one `llamaEnd` per requestId — on success, on error, and on cancel. These
   * two maps are the only way to see a zero or a double from the outside. */
  const endsByRequest = new Map();
  const tokensByRequest = new Map();
  await Llama.addListener('llamaEnd', (e) => {
    endsByRequest.set(e.requestId, (endsByRequest.get(e.requestId) || 0).valueOf() + 1);
    out('event.llamaEnd', {
      requestId: e.requestId,
      stopReason: e.stopReason,
      promptTokens: e.promptTokens,
      cachedTokens: e.cachedTokens,
      completionTokens: e.completionTokens,
      hasCachedTokensField: Object.prototype.hasOwnProperty.call(e, 'cachedTokens'),
      error: e.error,
    });
  });
  await Llama.addListener('llamaToken', (e) => {
    const seen = tokensByRequest.get(e.requestId) || [];
    seen.push(e.token);
    tokensByRequest.set(e.requestId, seen);
  });

  const settle = async (requestId) => {
    // Events cross the bridge asynchronously; wait for the terminal one rather
    // than assuming the promise resolving means it has landed.
    for (let i = 0; i < 100 && !endsByRequest.has(requestId); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // A second window, deliberately: a DOUBLE llamaEnd is as much a bug as a
    // missing one, and only shows up if we keep listening after the first.
    await new Promise((r) => setTimeout(r, 400));
    return endsByRequest.get(requestId) || 0;
  };

  let handle = null;
  let handleB = null;

  try {
    out('capabilities', { ok: true, ...(await Llama.getCapabilities()) });

    out('listLoaded.before', { ok: true, ...(await Llama.listLoaded()) });

    /* ── load ─────────────────────────────────────────────────────────── */
    const loadStarted = Date.now();
    const loaded = await Llama.load({
      modelPath: CONFIG.modelPath,
      contextLength: CONFIG.contextLength || 1024,
      backend: 'cpu',
      gpuLayers: 0,
      useMmap: true,
      chatTemplate: CONFIG.templateName || 'gemma',
      templateMarkers: CONFIG.templateMarkers || [],
    });
    handle = loaded.handle;
    out('load', { ok: true, ...loaded, wallMs: Date.now() - loadStarted });

    out('listLoaded.after', { ok: true, ...(await Llama.listLoaded()) });

    /* ── tokenize ─────────────────────────────────────────────────────────
     * The strongest cheap proof in the whole harness. `<start_of_turn>` is a
     * control token in Gemma's vocabulary and NOTHING in the Swift knows its
     * id; a single-token result carrying a specific id can only have come out
     * of the 6.5 GB file's tokenizer. With the old `parse_special: false` this
     * came back as a handful of ordinary text tokens instead. */
    for (const text of [...(CONFIG.templateMarkers || []), ...(CONFIG.wrongMarkers || []), 'The capital of Australia is']) {
      const { tokens } = await Llama.tokenize({ handle, text });
      const { count } = await Llama.countTokens({ handle, text });
      out('tokenize', { ok: true, text, tokens, count, agrees: count === tokens.length });
    }

    /* ── template A/B ─────────────────────────────────────────────────────
     * The same question, asked twice, differing only in which family's turn
     * markers wrap it. If the engine is real, the one whose markers exist in
     * this model's vocabulary answers the question and the one whose markers
     * do not answers noise — and `load` warned about exactly that in advance.
     * A stub cannot tell the two prompts apart. */
    if (CONFIG.wrongPrompt) {
      const rW = 'prove-wrong-template';
      const gW = await Llama.generate({
        handle, prompt: CONFIG.wrongPrompt, requestId: rW,
        sampler: { temperature: 0, topK: 1, maxTokens: 20, seed: 1234 },
      });
      out('generate.wrongTemplate', {
        ok: true, text: gW.text, stopReason: gW.stopReason, llamaEndCount: await settle(rW),
      });
    }

    /* ── generate, greedy ─────────────────────────────────────────────────
     * temperature 0 with a fixed seed makes this reproducible, so the same
     * build asked twice must answer identically — and a change to the sampler
     * must change the answer. */
    const prompt = CONFIG.prompt;
    const sampler = { temperature: 0, topK: 1, maxTokens: CONFIG.maxTokens || 24, seed: 1234, stopSequences: CONFIG.stopSequences || [] };

    const r1 = 'prove-greedy-1';
    const g1 = await Llama.generate({ handle, prompt, requestId: r1, sampler });
    out('generate.greedy', {
      ok: true, text: g1.text, promptTokens: g1.promptTokens, cachedTokens: g1.cachedTokens,
      completionTokens: g1.completionTokens, stopReason: g1.stopReason,
      tokensPerSecond: g1.tokensPerSecond, ttftMs: g1.ttftMs,
      streamed: (tokensByRequest.get(r1) || []).join(''),
      llamaEndCount: await settle(r1),
    });

    /* ── cache reuse ──────────────────────────────────────────────────────
     * Same prompt again. `cachedTokens` must be promptTokens - 1: the whole
     * prefix is resident, but one token has to be re-evaluated to produce
     * logits to sample from. That off-by-one IS the semantics, and it is why
     * a naive "it matched N tokens" would be wrong. */
    const r2 = 'prove-greedy-2';
    const g2 = await Llama.generate({ handle, prompt, requestId: r2, sampler });
    out('generate.cachereuse', {
      ok: true, text: g2.text, promptTokens: g2.promptTokens, cachedTokens: g2.cachedTokens,
      expectedCachedTokens: g2.promptTokens - 1,
      cacheReuseCorrect: g2.cachedTokens === g2.promptTokens - 1,
      deterministic: g2.text === g1.text,
      llamaEndCount: await settle(r2),
    });

    /* ── the sampler is live ──────────────────────────────────────────────
     * Same prompt, hot temperature, two different seeds. If these differ, the
     * sampler chain built by `makeSamplerChain` is really being consulted —
     * which is also the first execution the b10760 `n_vocab`-first
     * `llama_sampler_init_penalties` drift has ever had. */
    const hot = (seed) => ({ temperature: 1.4, topK: 100, topP: 0.99, minP: 0, maxTokens: 20, seed, stopSequences: CONFIG.stopSequences || [] });
    const rA = 'prove-seed-a';
    const rB = 'prove-seed-b';
    // A high-entropy question, deliberately: the factual one above is answered
    // so confidently that every seed picks the same token, which would make
    // this check pass vacuously.
    const creative = CONFIG.creativePrompt || prompt;
    const sA = await Llama.generate({ handle, prompt: creative, requestId: rA, sampler: hot(11) });
    const sB = await Llama.generate({ handle, prompt: creative, requestId: rB, sampler: hot(22) });
    out('generate.seeds', {
      ok: true, seed11: sA.text, seed22: sB.text, differ: sA.text !== sB.text,
      llamaEndCounts: [await settle(rA), await settle(rB)],
    });

    /* ── cancel ───────────────────────────────────────────────────────────
     * The terminal-event rule's second hard case. */
    const r3 = 'prove-cancel';
    const pending = Llama.generate({ handle, prompt, requestId: r3, sampler: { ...sampler, maxTokens: 400 } });
    setTimeout(() => { Llama.cancel({ requestId: r3 }).catch(() => {}); }, 1500);
    const g3 = await pending.catch((e) => ({ stopReason: 'threw', text: '', error: String(e && e.message || e) }));
    out('generate.cancel', {
      ok: true, stopReason: g3.stopReason, completionTokens: g3.completionTokens,
      cappedBelowMax: (g3.completionTokens || 0) < 400,
      llamaEndCount: await settle(r3),
    });

    /* ── the bug this task named ──────────────────────────────────────────
     * `generate` on a handle that does not exist. It used to `call.reject`
     * and return, before any listener heard a terminal event, so the adapter
     * waited forever. The count below is the whole point of the fix. */
    const r4 = 'prove-bad-handle';
    let rejected = null;
    await Llama.generate({ handle: 'no-such-handle', prompt, requestId: r4, sampler })
      .catch((e) => { rejected = String(e && e.message || e); });
    out('generate.badhandle', {
      ok: true, rejected, llamaEndCount: await settle(r4),
    });

    /* ── benchmark ────────────────────────────────────────────────────── */
    try {
      const bench = await Llama.benchmark({ handle, promptTokens: 64, generateTokens: 16, repetitions: 1 });
      out('benchmark', { ok: true, ...bench });
    } catch (e) { fail('benchmark', e); }

    /* ── the lifetime bug ─────────────────────────────────────────────────
     * Two handles at once; unload the first; then generate on the second.
     * With `free()` calling the process-global `llama_backend_free()`, this is
     * where the second handle's backend was torn out from under it. */
    const loadedB = await Llama.load({
      modelPath: CONFIG.modelPath,
      contextLength: 512,
      backend: 'cpu',
      gpuLayers: 0,
      useMmap: true,
      chatTemplate: 'gemma',
    });
    handleB = loadedB.handle;
    out('load.second', { ok: true, handle: handleB, ...(await Llama.listLoaded()) });

    await Llama.unload({ handle });
    out('unload.first', { ok: true, ...(await Llama.listLoaded()) });
    handle = null;

    const r5 = 'prove-after-unload';
    const g5 = await Llama.generate({ handle: handleB, prompt, requestId: r5, sampler: { ...sampler, maxTokens: 12 } });
    out('generate.afterUnloadOfOtherHandle', {
      ok: true, text: g5.text, completionTokens: g5.completionTokens,
      survived: (g5.completionTokens || 0) > 0,
      llamaEndCount: await settle(r5),
    });

    await Llama.unload({ handle: handleB });
    handleB = null;
    out('unload.second', { ok: true, ...(await Llama.listLoaded()) });

    out('done', { ok: true });
  } catch (error) {
    fail('fatal', error);
    try { if (handle) await Llama.unload({ handle }); } catch (_) { /* already gone */ }
    try { if (handleB) await Llama.unload({ handle: handleB }); } catch (_) { /* already gone */ }
    out('done', { ok: false });
  }
})();
