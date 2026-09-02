/*
 * Proof harness for the Android llama.cpp plugin. NOT part of the app.
 *
 * `prove-android.sh` copies this beside the built `dist/` and appends a
 * <script> tag for it, so it runs inside the real app, against the real
 * registered plugin, on a real device or emulator — and never ships in a
 * normal build. Every line is prefixed `[PROVE]` so the driver can pull it out
 * of a logcat that is otherwise full of system noise.
 *
 * It is the sibling of `prove-ios.js` and asks the same questions, because the
 * whole point of the two platforms is that one adapter above them sees
 * identical behaviour.
 *
 * TWO MODES, chosen by what `getCapabilities` does:
 *
 *   - REFUSAL. No `.so` for this ABI, so `System.loadLibrary` found nothing.
 *     The contract then is that every method REJECTS with a readable reason
 *     and the app stays alive. This mode exists because the plugin used to
 *     kill the process here (`UnsatisfiedLinkError` out of `LlamaBridge`'s
 *     `<clinit>`), which is a worse failure than any wrong answer.
 *
 *   - ENGINE. The library loaded, so the full sequence runs and each step
 *     either reports a value only llama.cpp could produce or asserts an
 *     invariant the code under test could plausibly get wrong.
 */
(async () => {
  const out = (step, data) => console.log(`[PROVE] ${JSON.stringify({ step, ...data })}`);
  const fail = (step, error) =>
    out(step, { ok: false, error: String((error && error.message) || error) });

  for (
    let i = 0;
    i < 100 && !(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LlamaCpp);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const Llama = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LlamaCpp;
  if (!Llama) {
    return out('bootstrap', {
      ok: false,
      error: 'LlamaCpp plugin never appeared on window.Capacitor.Plugins',
    });
  }

  const CONFIG = window.__PROVE__ || {};

  /* Terminal-event accounting. The contract is that `generate` emits EXACTLY
   * one `llamaEnd` per requestId — on success, on error, and on cancel. These
   * two maps are the only way to see a zero or a double from the outside. */
  const endsByRequest = new Map();
  const tokensByRequest = new Map();
  await Llama.addListener('llamaEnd', (e) => {
    endsByRequest.set(e.requestId, (endsByRequest.get(e.requestId) || 0) + 1);
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
    for (let i = 0; i < 100 && !endsByRequest.has(requestId); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // A second window, deliberately: a DOUBLE llamaEnd is as much a bug as a
    // missing one, and only shows up if we keep listening after the first.
    await new Promise((r) => setTimeout(r, 400));
    return endsByRequest.get(requestId) || 0;
  };

  /* ── capabilities, and the fork ───────────────────────────────────────── */
  let capabilities = null;
  let refusal = null;
  try {
    capabilities = await Llama.getCapabilities();
    out('capabilities', { ok: true, ...capabilities });
  } catch (error) {
    refusal = String((error && error.message) || error);
    out('capabilities', { ok: true, engineAvailable: false, refusedWith: refusal });
  }

  if (!capabilities) {
    /* ── REFUSAL MODE ───────────────────────────────────────────────────
     * Each call below must come back as a rejected promise carrying a
     * sentence a person can read. The measurement that matters is not the
     * wording, though — it is that the harness reaches `done` at all. A
     * process killed by `UnsatisfiedLinkError` prints nothing after this
     * point, so `done` IS the proof that the app survived. */
    const probes = [
      ['load', () => Llama.load({ modelPath: '/data/local/tmp/does-not-exist.gguf' })],
      ['tokenize', () => Llama.tokenize({ handle: 'no-such-handle', text: 'hello' })],
      ['countTokens', () => Llama.countTokens({ handle: 'no-such-handle', text: 'hello' })],
      ['benchmark', () => Llama.benchmark({ handle: 'no-such-handle' })],
      [
        'generate',
        () =>
          Llama.generate({
            handle: 'no-such-handle',
            prompt: 'hello',
            requestId: 'prove-refusal-generate',
          }),
      ],
    ];
    for (const [name, run] of probes) {
      let rejected = null;
      let resolved = null;
      try {
        resolved = await run();
      } catch (error) {
        rejected = String((error && error.message) || error);
      }
      out(`refused.${name}`, {
        ok: rejected !== null,
        rejected,
        resolved: resolved === null ? undefined : JSON.stringify(resolved),
        error: rejected === null ? `${name} resolved instead of refusing` : undefined,
      });
    }

    /* Even a refusal owes the stream its one terminal event. A `generate` that
     * rejects without emitting `llamaEnd` leaves the adapter in
     * `src/ai/backends/llama-cpp.ts` waiting on a stream that will never end —
     * the promise rejects, the spinner stays. */
    out('refused.generate.terminalEvent', {
      ok: (await settle('prove-refusal-generate')) === 1,
      llamaEndCount: await settle('prove-refusal-generate'),
    });

    // Methods that need no engine must still work: a device without llama.cpp
    // is a degraded app, not a dead one.
    try {
      out('thermal', { ok: true, ...(await Llama.getThermalState()) });
    } catch (error) {
      fail('thermal', error);
    }
    try {
      out('listLoaded', { ok: true, ...(await Llama.listLoaded()) });
    } catch (error) {
      fail('listLoaded', error);
    }
    try {
      await Llama.cancel({ requestId: 'prove-refusal-generate' });
      out('cancel', { ok: true });
    } catch (error) {
      fail('cancel', error);
    }

    return out('done', { ok: true, mode: 'refusal' });
  }

  /* ── ENGINE MODE ─────────────────────────────────────────────────────── */
  let handle = null;
  let handleB = null;

  try {
    out('thermal', { ok: true, ...(await Llama.getThermalState()) });
    out('listLoaded.before', { ok: true, ...(await Llama.listLoaded()) });

    if (!CONFIG.modelPath) {
      /* No model to load, but the engine is present — so assert the one thing
       * that can be asserted without one: `engineVersion` is llama.cpp's own
       * `llama_print_system_info()`, which no stub produces and which cannot
       * be reached without the `.so` having loaded, linked and run. */
      const version = capabilities.engineVersion || '';
      out('engineVersion', {
        ok: /llama\.cpp .*=\s*1/.test(version),
        engineVersion: version,
        error: /llama\.cpp .*=\s*1/.test(version)
          ? undefined
          : 'engineVersion does not look like llama_print_system_info() output',
      });
      let refused = null;
      await Llama.load({ modelPath: '/data/local/tmp/definitely-not-here.gguf' }).catch((e) => {
        refused = String((e && e.message) || e);
      });
      out('load.missingFile', { ok: refused !== null, refused });
      return out('done', { ok: true, mode: 'engine-no-model' });
    }

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
     * The strongest cheap proof in the harness. A turn marker is a control
     * token in the model's vocabulary and NOTHING in the Kotlin or the C++
     * knows its id; a single-token result carrying a specific id can only
     * have come out of the GGUF's own tokenizer. With `parse_special: false`
     * it comes back as a handful of ordinary text tokens instead — the exact
     * bug iOS shipped and only found by diffing against Node. */
    const reference = CONFIG.tokenizerReference || {};
    const texts = Object.keys(reference).length
      ? Object.keys(reference)
      : [
          ...(CONFIG.templateMarkers || []),
          ...(CONFIG.wrongMarkers || []),
          'The capital of Australia is',
        ];
    for (const text of texts) {
      const { tokens } = await Llama.tokenize({ handle, text });
      const { count } = await Llama.countTokens({ handle, text });
      const expected = reference[text];
      // The device's ids, diffed against the ids the SAME model produces
      // through `packages/inference-node`. Nothing in the Kotlin or the C++
      // knows these numbers; they can only have come out of the GGUF.
      const matchesNode =
        expected === undefined ? undefined : JSON.stringify(tokens) === JSON.stringify(expected);
      out('tokenize', {
        ok: matchesNode !== false && count === tokens.length,
        text,
        tokens,
        expected,
        matchesNode,
        count,
        agrees: count === tokens.length,
        error:
          matchesNode === false
            ? `device ${JSON.stringify(tokens)} != node ${JSON.stringify(expected)}`
            : count === tokens.length
              ? undefined
              : 'countTokens disagrees with tokenize',
      });
    }

    /* ── template A/B ───────────────────────────────────────────────────── */
    if (CONFIG.wrongPrompt) {
      const rW = 'prove-wrong-template';
      const gW = await Llama.generate({
        handle,
        prompt: CONFIG.wrongPrompt,
        requestId: rW,
        sampler: { temperature: 0, topK: 1, maxTokens: 20, seed: 1234 },
      });
      out('generate.wrongTemplate', {
        ok: true,
        text: gW.text,
        stopReason: gW.stopReason,
        llamaEndCount: await settle(rW),
      });
    }

    /* ── generate, greedy ───────────────────────────────────────────────── */
    const prompt = CONFIG.prompt;
    const sampler = {
      temperature: 0,
      topK: 1,
      maxTokens: CONFIG.maxTokens || 24,
      seed: 1234,
      stopSequences: CONFIG.stopSequences || [],
    };

    const r1 = 'prove-greedy-1';
    const g1 = await Llama.generate({ handle, prompt, requestId: r1, sampler });
    out('generate.greedy', {
      ok: true,
      text: g1.text,
      promptTokens: g1.promptTokens,
      cachedTokens: g1.cachedTokens,
      completionTokens: g1.completionTokens,
      stopReason: g1.stopReason,
      tokensPerSecond: g1.tokensPerSecond,
      ttftMs: g1.ttftMs,
      streamed: (tokensByRequest.get(r1) || []).join(''),
      streamMatchesText: (tokensByRequest.get(r1) || []).join('') === g1.text,
      llamaEndCount: await settle(r1),
    });

    /* ── cache reuse ──────────────────────────────────────────────────────
     * Same prompt again. `cachedTokens` must be promptTokens - 1: the whole
     * prefix is resident, but one token has to be re-evaluated to produce
     * logits to sample from. That off-by-one IS the semantics. */
    const r2 = 'prove-greedy-2';
    const g2 = await Llama.generate({ handle, prompt, requestId: r2, sampler });
    out('generate.cachereuse', {
      ok: g2.cachedTokens === g2.promptTokens - 1,
      error:
        g2.cachedTokens === g2.promptTokens - 1
          ? undefined
          : `cachedTokens ${g2.cachedTokens}, expected ${g2.promptTokens - 1}`,
      text: g2.text,
      promptTokens: g2.promptTokens,
      cachedTokens: g2.cachedTokens,
      expectedCachedTokens: g2.promptTokens - 1,
      cacheReuseCorrect: g2.cachedTokens === g2.promptTokens - 1,
      deterministic: g2.text === g1.text,
      llamaEndCount: await settle(r2),
    });

    /* ── the sampler is live ────────────────────────────────────────────── */
    const hot = (seed) => ({
      temperature: 1.4,
      topK: 100,
      topP: 0.99,
      minP: 0,
      maxTokens: 20,
      seed,
      stopSequences: CONFIG.stopSequences || [],
    });
    const rA = 'prove-seed-a';
    const rB = 'prove-seed-b';
    const creative = CONFIG.creativePrompt || prompt;
    const sA = await Llama.generate({ handle, prompt: creative, requestId: rA, sampler: hot(11) });
    const sB = await Llama.generate({ handle, prompt: creative, requestId: rB, sampler: hot(22) });
    out('generate.seeds', {
      ok: true,
      seed11: sA.text,
      seed22: sB.text,
      differ: sA.text !== sB.text,
      llamaEndCounts: [await settle(rA), await settle(rB)],
    });

    /* ── cancel ───────────────────────────────────────────────────────────
     * The terminal-event rule's second hard case. */
    const r3 = 'prove-cancel';
    const pending = Llama.generate({
      handle,
      prompt,
      requestId: r3,
      sampler: { ...sampler, maxTokens: 400 },
    });
    setTimeout(() => {
      Llama.cancel({ requestId: r3 }).catch(() => {});
    }, 3000);
    const g3 = await pending.catch((e) => ({
      stopReason: 'threw',
      text: '',
      error: String((e && e.message) || e),
    }));
    out('generate.cancel', {
      ok: true,
      stopReason: g3.stopReason,
      completionTokens: g3.completionTokens,
      cappedBelowMax: (g3.completionTokens || 0) < 400,
      llamaEndCount: await settle(r3),
    });

    /* ── a handle that does not exist ─────────────────────────────────────
     * Must reject AND emit its one terminal event, or the adapter above waits
     * forever for a stream that will never end. */
    const r4 = 'prove-bad-handle';
    let rejected = null;
    await Llama.generate({
      handle: 'no-such-handle',
      prompt,
      requestId: r4,
      sampler,
    }).catch((e) => {
      rejected = String((e && e.message) || e);
    });
    out('generate.badhandle', { ok: true, rejected, llamaEndCount: await settle(r4) });

    /* ── benchmark ──────────────────────────────────────────────────────── */
    try {
      const bench = await Llama.benchmark({
        handle,
        promptTokens: 64,
        generateTokens: 16,
        repetitions: 1,
      });
      out('benchmark', { ok: true, ...bench });
    } catch (e) {
      fail('benchmark', e);
    }

    /* ── the lifetime bug ─────────────────────────────────────────────────
     * Two handles at once; unload the first; then generate on the second.
     * With a per-handle `llama_backend_free()`, this is where the second
     * handle's backend is torn out from under it. */
    const loadedB = await Llama.load({
      modelPath: CONFIG.modelPath,
      contextLength: 512,
      backend: 'cpu',
      gpuLayers: 0,
      useMmap: true,
      chatTemplate: CONFIG.templateName || 'gemma',
    });
    handleB = loadedB.handle;
    out('load.second', { ok: true, handle: handleB, ...(await Llama.listLoaded()) });

    await Llama.unload({ handle });
    out('unload.first', { ok: true, ...(await Llama.listLoaded()) });
    handle = null;

    const r5 = 'prove-after-unload';
    const g5 = await Llama.generate({
      handle: handleB,
      prompt,
      requestId: r5,
      sampler: { ...sampler, maxTokens: 12 },
    });
    out('generate.afterUnloadOfOtherHandle', {
      ok: true,
      text: g5.text,
      completionTokens: g5.completionTokens,
      survived: (g5.completionTokens || 0) > 0,
      llamaEndCount: await settle(r5),
    });

    await Llama.unload({ handle: handleB });
    handleB = null;
    out('unload.second', { ok: true, ...(await Llama.listLoaded()) });

    out('done', { ok: true, mode: 'engine' });
  } catch (error) {
    fail('fatal', error);
    try {
      if (handle) await Llama.unload({ handle });
    } catch (_) {
      /* already gone */
    }
    try {
      if (handleB) await Llama.unload({ handle: handleB });
    } catch (_) {
      /* already gone */
    }
    out('done', { ok: false });
  }
})();
