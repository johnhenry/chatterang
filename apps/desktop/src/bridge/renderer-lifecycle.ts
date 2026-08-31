/**
 * When a renderer stops being a renderer, and what has to happen then.
 *
 * A window can go away in three different ways and only one of them is closing.
 * Each has to run the same cleanup, and the whole of defect [6] was that one of
 * the three ran none of it.
 *
 *   `did-start-navigation` — a reload or a link. The webContents SURVIVES, so
 *     nothing else will ever tell us the old page is gone. Missing this one
 *     leaks a page's worth of subscriptions per Cmd+R and leaves the previous
 *     page's generation decoding in the host for nobody.
 *
 *   `render-process-gone` — the renderer CRASHED, or was killed by the OS
 *     (an out-of-memory kill is the common one on a machine also holding a
 *     multi-gigabyte model in another process). This fires NEITHER of the other
 *     two: an instrumented build logged `render-process-gone reason=crashed
 *     destroyed=false`, and `did-start-navigation` does not fire for a crash.
 *     So the subscriptions stayed in the table and the generation kept running,
 *     with no page left to receive a single token of it.
 *
 *   `destroyed` — the window is closed for good. The only one of the three
 *     after which the sender can be forgotten entirely.
 *
 * The list and the dispatch live HERE, in a file with no Electron in it, for
 * the same reason everything else does: `main.ts` cannot be imported by a test,
 * so a fourth event added there would be as unverified as the third one was
 * missing. `tests/desktop-security.test.ts` checks this list against the text
 * of `main.ts`, so an event named here and not wired there is a test failure.
 */

/**
 * Every `webContents` event after which a renderer's resources must be
 * released.
 *
 * Adding a name here is only half the job — `main.ts` must register a handler
 * for it, and a test asserts that it does.
 */
export const RENDERER_TEARDOWN_EVENTS = Object.freeze([
  'did-start-navigation',
  'render-process-gone',
  'destroyed',
] as const);

export type RendererTeardownEvent = (typeof RENDERER_TEARDOWN_EVENTS)[number];

/** What the teardown acts on. `main.ts` supplies the Electron-shaped versions. */
export interface RendererTeardownTargets {
  /** Drop every event subscription this renderer holds. */
  releaseSender(senderId: number): void;
  /** End every generation this renderer started, with a reason it can be told. */
  releaseRenderer(senderId: number, reason: string): void;
  /** Stop holding the renderer for event delivery. Only after `destroyed`. */
  forget(senderId: number): void;
}

/**
 * Why each departure ended the generations it ended.
 *
 * The strings reach the page as the rejection message of its own `generate`
 * promise, so they say what happened to THAT window rather than describing the
 * bridge. A crash says crash: "the page navigated away" would be a lie the user
 * could act on.
 */
const REASONS: Readonly<Record<RendererTeardownEvent, string>> = {
  'did-start-navigation': 'The page that started this generation navigated away.',
  'render-process-gone': 'The window that started this generation stopped responding.',
  destroyed: 'The window that started this generation was closed.',
};

/**
 * Run the teardown for one renderer, for one kind of departure.
 *
 * Order matters and is the same in all three cases: subscriptions first, so a
 * terminal event synthesised by the second step has nowhere stale to be
 * delivered, then the generations, then — only when the renderer is gone for
 * good — the delivery entry itself.
 *
 * @param event which departure happened.
 * @param senderId the renderer that departed.
 * @param targets the plugin host, the supervisor, and the sender table.
 */
export function releaseRendererOn(
  event: RendererTeardownEvent,
  senderId: number,
  targets: RendererTeardownTargets,
): void {
  targets.releaseSender(senderId);
  targets.releaseRenderer(senderId, REASONS[event]);
  // A crashed renderer is NOT forgotten: Electron keeps the webContents alive
  // (`destroyed` is false) and it can be reloaded into. Forgetting it here
  // would leave a reloaded page unable to receive events until it navigated
  // again. `destroyed` is the only departure it is safe after.
  if (event === 'destroyed') targets.forget(senderId);
}

/** The reason string one departure produces. Exported so a test can name it. */
export function teardownReason(event: RendererTeardownEvent): string {
  return REASONS[event];
}
