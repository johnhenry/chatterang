/**
 * Run one async function at a time per key, in the order calls were made.
 *
 * `state/app.ts`'s `toggleConnection` and `state/mcp.ts`'s `toggle` each decide
 * what to do by reading the store — whether the connection or server is
 * currently on, what its record looks like — and then writing it. Without
 * this, two calls for the SAME id raced: a switch-on made while a switch-off's
 * own write for that id was still in flight read the store before the
 * switch-off's `set` had run, so it saw the connection as still on, skipped the
 * withdrawal a genuine off→on transition has to make, and kept a grant the
 * switch-off could not write away (#318).
 *
 * So calls for one key now queue behind each other: the next one starts only
 * once the one before has fully settled — its own writes and every side effect
 * it makes — however it settled. A call that threw still lets the next one run;
 * it does not wedge the queue.
 */
export function serializedByKey(
  queue: Map<string, Promise<void>>,
  key: string,
  run: () => Promise<void>,
): Promise<void> {
  const before = queue.get(key);
  // RUN AT ONCE WHEN NOTHING IS QUEUED, rather than always through `.then()`.
  // The two are equivalent once anything is actually queued behind — a `run`
  // reached through a resolved promise's `.then()` still starts one microtask
  // later than a synchronous call — but the common case has nothing queued at
  // all, and a caller may depend on its own synchronous prelude (the part
  // before its first real `await`) running in the same tick it was called, as
  // every caller of this function's un-serialized ancestor used to.
  const started = before ? before.then(run) : run();
  const settled = started.catch(() => {});
  queue.set(key, settled);
  void settled.then(() => {
    if (queue.get(key) === settled) queue.delete(key);
  });
  return started;
}

/** `list` with the first occurrence of `value` removed, or `list` itself if there is none. */
export function withoutOne<T>(list: readonly T[], value: T): T[] {
  const at = list.indexOf(value);
  if (at === -1) return [...list];
  return [...list.slice(0, at), ...list.slice(at + 1)];
}
