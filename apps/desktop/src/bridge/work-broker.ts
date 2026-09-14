/**
 * The work broker: who may use the one generation slot, in what order, and how
 * every piece of work that asked for it ends exactly once.
 *
 * `Supervisor` guarantees that a turn it STARTED ends exactly once. It cannot
 * say whether a turn should start, because it has no idea anyone else wants
 * the GPU. The broker answers that, for every kind of work, with the
 * guarantees the Supervisor already keeps restated for work that is not a
 * window's generation (#7, #49).
 *
 * THE RULINGS THIS FILE IMPLEMENTS, from the owner on #7:
 *
 *   3. ONE SHARED SLOT. The desktop user's own turns and a paired phone's turns
 *      share one slot and one first-come-first-served wait list, and whoever
 *      waits is told, including the person at the desktop (#169). The slot is
 *      `MAX_CONCURRENT_TURNS`, enforced here. It is the ONLY serialisation: a
 *      second `generate` on a loaded llama handle is neither refused nor queued
 *      by anything below the bridge (measured in
 *      `tests/desktop-background-measurements.test.ts`).
 *   4. A DROPPED PHONE SOCKET DOES NOT END THE TURN. The work runs to its end,
 *      and the result is HELD, bounded by `RETAIN_RESULT_MS`,
 *      `RETAIN_RESULT_PER_DEVICE` and `RETAIN_RESULT_COUNT`, until the phone
 *      attaches and acknowledges it, the hold expires, the device is revoked,
 *      or the desktop sleeps or quits. A device's new socket replaces its stale
 *      one.
 *   5. IN MEMORY. The wait list and held results end on quit and on sleep.
 *   7. NO KEEP-AWAKE. `suspend()` stops admitting, settles running and waiting
 *      work with `HOST_SUSPENDED`, tells whoever is connected, and drops held
 *      results (ruling 5's "end on sleep"). It closes nothing: the listening
 *      socket is not the broker's, and it stays bound. A phone that was not
 *      connected hears nothing about a unit the sleep ended: an attach replays
 *      only what is live or held, so a unit it does not mention has ended, and
 *      the phone's own record of the turn (S8) is what fails it visibly.
 *
 * And #170: a prompt relayed to the phone that is not answered within
 * `PROMPT_ANSWER_TIMEOUT_MS`, whose socket drops or is replaced, or whose unit
 * ends while it waits, is REFUSED. The outcome says `notSent: true`; the record
 * of that is the caller's (S4), and a late answer is never accepted.
 *
 * DEADLINES ARE ENFORCED WHERE THEY ARE USED, not only on the tick. The tick
 * runs every `BROKER_TICK_MS` at best; an interval lags behind a stalled event
 * loop, and across a sleep with no suspend event it can lag without limit. So
 * an answer, a progress report, a held result's replay or acknowledgement,
 * and a new prompt each check the deadline that governs them against the
 * clock first. A deadline that has passed is past, whether or not the tick
 * has noticed.
 *
 * ONE SETTLE, FOUR PATHS. Every unit ends through `#settle`, which is
 * idempotent, by exactly one of:
 *
 *   1. its work's TERMINAL REPORT: the promise `start` returned settling. A
 *      report arrives on a call, never on a pushed event, for the reason
 *      `supervisor.ts` gives: an invoke settles once by construction, and an
 *      event can be lost;
 *   2. WORKER LOSS: `workerLost(executor)`, for work whose executor died;
 *   3. OWNER LOSS: a window torn down (`releaseWindow`) or a device revoked
 *      (`revokeDevice`). A dropped socket is NOT owner loss (ruling 4);
 *   4. its DEADLINE: `UNIT_IDLE_TIMEOUT_MS` without progress.
 *
 * Plus the lifecycle ends that apply to everything at once (`suspend`,
 * `quit`) and a cancel from the owner while the unit is still waiting.
 *
 * THE SLOT IS RELEASED WHEN THE WORK HAS STOPPED, NOT WHEN ITS END IS DECIDED.
 * A deadline, a revocation or a suspend decides a unit's terminal at once and
 * aborts its work, but the slot stays taken until the work's promise settles
 * (or its executor is declared lost). Releasing on the decision would start
 * the next turn while the previous one may still be decoding on the same
 * sequence, which is the corruption the slot exists to prevent: one owner's
 * reply decoded over another owner's context. Work that ignores its abort for
 * `UNIT_DRAIN_TIMEOUT_MS` is handed to `condemnExecutor`; only an executor
 * that is confirmed dead frees the slot early. One that cannot be killed
 * keeps it until the work returns: a stuck slot is visible and ends at quit,
 * two decodes on one sequence are neither.
 *
 * OWNERS ARE REAL IDENTITIES, keyed by (kind, id): a paired device's credential
 * id (#135), or a window's `webContents.id`. Never a made-up sender id: the
 * server hands out sender ids from 1 (`apps/server/src/sessions.ts`), so a
 * number invented for something that is not a window can collide with one
 * that is. Only the owner is told about a unit, only the owner can cancel or
 * answer for it, and a call naming someone else's unit looks exactly like a
 * call naming no unit at all.
 *
 * PLATFORM-FREE. No Electron, no Node builtin (`tests/layering.test.ts`), timers
 * injected. It never logs a unit's value, error or prompt: the logging rule in
 * `main.ts` applies here too.
 */

import type { SupervisorTimers } from './supervisor.js';
import { systemTimers } from './supervisor.js';

/* ── The limits, named and enforced ───────────────────────────────────── */

/**
 * Generations that may hold the slot at once. One: one loaded model on one GPU
 * (#169, #7 ruling 3). Nothing below the broker serialises two turns.
 */
export const MAX_CONCURRENT_TURNS = 1;

/**
 * Units one paired device may have WAITING (not counting one it is running).
 *
 * Three: a phone sends one turn at a time, and a person typing ahead, or the
 * phone's own queue (#195) draining, rarely has more than a couple ready. Past
 * three, one phone is holding places everyone else would wait behind.
 */
export const MAX_WAITING_PER_DEVICE = 3;

/**
 * Units one window may have WAITING.
 *
 * Two. A window's chat store runs one turn at a time, so a legitimate window
 * almost never has even one waiting; two leaves room for a second caller in
 * the same page without letting a misbehaving renderer fill the list and
 * starve the phones.
 */
export const MAX_WAITING_PER_WINDOW = 2;

/**
 * Units waiting in total, across every owner.
 *
 * Eight. At a turn or two a minute on one GPU that is several minutes of
 * waiting. Beyond it, a place in the list is indistinguishable from a hang, and
 * a refusal the client can render is the more honest answer (#169).
 */
export const MAX_WAITING_TOTAL = 8;

/**
 * How long a prompt relayed to a phone may go unanswered before it is refused.
 *
 * Sixty seconds. The person has to read what would leave and to where (#170),
 * and that is quick; the unit keeps the slot while it waits, so every second
 * here is a second everyone behind it waits too. Refusing is the fail-closed
 * outcome: the call is not sent.
 */
export const PROMPT_ANSWER_TIMEOUT_MS = 60_000;

/**
 * How long a finished result is held for a phone that has not acknowledged it.
 *
 * Five minutes. Long enough to cover a screen lock or a Wi-Fi-to-cellular
 * switch; short, because what is held is the text of another device's
 * conversation, in this process's memory (#7 ruling 2 keeps it off disk, and
 * ruling 5 keeps it in memory only).
 */
export const RETAIN_RESULT_MS = 5 * 60_000;

/**
 * Held results for ONE device. Its oldest goes first.
 *
 * Four: the most units one device can have live at once, one running and
 * `MAX_WAITING_PER_DEVICE` waiting, so every unit live when its socket dropped
 * can finish and be held. It is also what stops one device's unacknowledged
 * backlog from evicting another device's only result: past four, the device
 * that did not acknowledge is the one that loses.
 */
export const RETAIN_RESULT_PER_DEVICE = 4;

/**
 * Held results in total, across every device.
 *
 * Eight, the size of the wait list: a hard memory bound regardless of how many
 * devices are paired. When it is exceeded, the oldest result of the device
 * holding the MOST goes first, so a device holding one result keeps it while
 * another holds several.
 */
export const RETAIN_RESULT_COUNT = 8;

/**
 * A running unit's INACTIVITY deadline. Progress resets it; a pending prompt
 * pauses it (a person reading is not a wedge).
 *
 * 150 s, deliberately LONGER than the Supervisor's `generateIdleTimeoutMs` and
 * `callTimeoutMs` (120 s each). For a desktop generation, or any other call the
 * Supervisor serves, the Supervisor's deadline is the one that can cancel
 * inside the host and synthesise the right terminal; this one is the backstop
 * for work that has no such deadline of its own. A test pins the ordering. Work that also ignores
 * the abort this deadline sends is `UNIT_DRAIN_TIMEOUT_MS`'s.
 */
export const UNIT_IDLE_TIMEOUT_MS = 150_000;

/**
 * How long work whose end has been DECIDED (a deadline, an owner's loss, a
 * revocation, a suspend, a quit) has to stop after its abort before its
 * executor is handed to `condemnExecutor`.
 *
 * Thirty seconds. A decode told to stop stops within a token; work still
 * running half a minute after its abort is not stopping, and everyone behind
 * it is waiting on it. What happens next is the executor's owner's call: a
 * condemned executor that is confirmed dead frees the slot; one that cannot be
 * killed from here keeps the slot until its work returns.
 */
export const UNIT_DRAIN_TIMEOUT_MS = 30_000;

/** How often deadlines and held-result expiry are looked at. */
export const BROKER_TICK_MS = 1_000;

/* ── Vocabulary ───────────────────────────────────────────────────────── */

/** Who a unit belongs to. Keyed by kind AND id, never by a number alone. */
export type Owner =
  | { readonly kind: 'device'; readonly id: string }
  | { readonly kind: 'window'; readonly id: number };

/** How a unit ended. Exactly one per unit. */
export type UnitEnd =
  /** Its work reported a result. */
  | 'COMPLETED'
  /** Its work reported a failure. */
  | 'FAILED'
  /** The executor running its work was lost. */
  | 'WORKER_LOST'
  /** Its window went away. Nothing is delivered: there is no page to receive it. */
  | 'OWNER_LOST'
  /** Its device was revoked. Nothing is delivered, and anything held is purged. */
  | 'OWNER_REVOKED'
  /** Its owner cancelled it before it started. */
  | 'CANCELLED'
  /** It made no progress for `UNIT_IDLE_TIMEOUT_MS`. */
  | 'DEADLINE'
  /** The machine is going to sleep (#7 ruling 7). */
  | 'HOST_SUSPENDED'
  /** The app is quitting. */
  | 'DESKTOP_QUITTING';

/** Why a unit was not admitted. */
export type AdmitRefusal =
  /**
   * The owner already has a live unit with this id, or, for a device, a result
   * held under it that it has not acknowledged. One acknowledgement must never
   * be able to purge two results.
   */
  | 'DUPLICATE_UNIT'
  /** The device was revoked. */
  | 'OWNER_REVOKED'
  /** The owner has its limit of units waiting. */
  | 'OWNER_WAIT_LIST_FULL'
  /** `MAX_WAITING_TOTAL` units are waiting. */
  | 'WAIT_LIST_FULL'
  /** The unit asked not to wait (`wait: false`), and it could not start now. */
  | 'SLOT_BUSY'
  /** The machine is suspending; nothing is admitted until `resume()`. */
  | 'HOST_SUSPENDED'
  /** The app is quitting; nothing is admitted again. */
  | 'DESKTOP_QUITTING';

/** Why a relayed prompt was refused. The call it guarded is not sent. */
export type PromptRefusal =
  | 'PROMPT_TIMEOUT'
  | 'OWNER_DETACHED'
  | 'UNIT_SETTLED'
  | 'PROMPT_PENDING'
  | 'NOT_RUNNING';

export type PromptOutcome =
  | { readonly answered: true; readonly answer: unknown }
  | { readonly answered: false; readonly refusal: PromptRefusal; readonly notSent: true };

export interface UnitTerminal {
  readonly owner: Owner;
  readonly unitId: string;
  readonly end: UnitEnd;
  /** Whether its work was ever started. */
  readonly started: boolean;
  /** The work's result, for `COMPLETED`. */
  readonly value?: unknown;
  /**
   * The work's rejection, for `FAILED`, kept as thrown so a caller in this
   * process keeps its `code`. Encoding it for a wire is the wire's job.
   */
  readonly error?: unknown;
}

/** What an owner is told. */
export type BrokerNotice =
  /** Still waiting; `position` 1 is next. Sent whenever it changes. */
  | { readonly kind: 'waiting'; readonly unitId: string; readonly position: number }
  /** The unit took the slot. */
  | { readonly kind: 'started'; readonly unitId: string }
  /** A prompt for the owner to answer with `answerPrompt`. */
  | { readonly kind: 'prompt'; readonly unitId: string; readonly promptId: string; readonly prompt: unknown }
  /** The unit's one terminal. For a device, re-sent on each attach until acknowledged. */
  | { readonly kind: 'terminal'; readonly terminal: UnitTerminal };

export type ChannelCloseReason = 'SOCKET_REPLACED' | 'OWNER_REVOKED';

/** One live connection from a paired device. The listener supplies it. */
export interface OwnerChannel {
  /** Deliver one notice; false if it did not go out. */
  send(notice: BrokerNotice): boolean;
  /** Close it. Called when a newer socket replaces it or the device is revoked. */
  close(reason: ChannelCloseReason): void;
}

export interface UnitRequest {
  readonly owner: Owner;
  /** Unique among the owner's live units. A phone's turn id, or a requestId. */
  readonly unitId: string;
  /** What runs the work. `workerLost(executor)` ends only units on it. */
  readonly executor: string;
  /**
   * Start the work. Called once, when the unit takes the slot. The promise it
   * returns settling is the terminal report; `signal` aborts when the unit's
   * end is decided another way.
   */
  readonly start: (signal: AbortSignal) => Promise<unknown>;
  /**
   * False for work that must start now or not at all, and has nobody to tell
   * that it is waiting: it is refused `SLOT_BUSY` instead of taking a place in
   * the list. Default true.
   */
  readonly wait?: boolean;
}

export type AdmitResult =
  | {
      readonly admitted: true;
      /** 0 when it started at once; otherwise its place in the wait list. */
      readonly position: number;
      /** Resolves exactly once, with the unit's terminal. Never rejects. */
      readonly settled: Promise<UnitTerminal>;
    }
  | { readonly admitted: false; readonly refusal: AdmitRefusal };

export interface WorkBrokerOptions {
  /** Tell a window about one of its units. False if it did not go out. */
  readonly notifyWindow: (windowId: number, notice: BrokerNotice) => boolean;
  /**
   * Kill an executor whose work did not stop within `UNIT_DRAIN_TIMEOUT_MS` of
   * its abort. Return true ONLY once it is dead, so nothing it was running can
   * still decode: the broker then ends every unit on it as `workerLost` does
   * and frees the slot. Return false, or leave this out, for an executor that
   * cannot be killed from here; its slot stays held until its work returns.
   * A throw counts as false.
   */
  readonly condemnExecutor?: (executor: string) => boolean;
  readonly timers?: SupervisorTimers;
  /** Anomalies. Never a payload. */
  readonly warn?: (message: string) => void;
}

/* ── Internals ────────────────────────────────────────────────────────── */

interface PendingPrompt {
  readonly promptId: string;
  readonly deadlineAt: number;
  resolve(outcome: PromptOutcome): void;
}

interface Unit {
  readonly owner: Owner;
  readonly key: string;
  readonly unitId: string;
  readonly executor: string;
  readonly start: (signal: AbortSignal) => Promise<unknown>;
  /**
   * `waiting`: in the list. `running`: holds the slot, end undecided.
   * `draining`: end decided, work not yet returned, STILL holds the slot.
   * `done`: gone from every table.
   */
  state: 'waiting' | 'running' | 'draining' | 'done';
  started: boolean;
  /** Set once the work's promise has settled or its executor was declared lost. */
  returned: boolean;
  /** The last position this unit's owner was told; 0 when never told. */
  told: number;
  deadlineAt: number;
  /** When a draining unit's work has had `UNIT_DRAIN_TIMEOUT_MS` to stop. */
  drainDeadlineAt: number;
  /** Its drain deadline has been acted on; it is acted on once. */
  drainExpired: boolean;
  prompt: PendingPrompt | null;
  controller: AbortController | null;
  terminal: UnitTerminal | null;
  resolve(terminal: UnitTerminal): void;
}

interface HeldResult {
  readonly deviceId: string;
  readonly unitId: string;
  readonly terminal: UnitTerminal;
  readonly expiresAt: number;
}

function ownerKey(owner: Owner): string {
  return `${owner.kind}:${String(owner.id)}`;
}

function assertOwner(owner: Owner): void {
  const valid =
    owner.kind === 'device'
      ? typeof owner.id === 'string' && owner.id.length > 0
      : owner.kind === 'window' && Number.isInteger(owner.id) && owner.id > 0;
  if (!valid) {
    throw new TypeError(
      'work broker: an owner is a device credential id (a non-empty string) or a window’s ' +
        'webContents id (a positive integer), and nothing else.',
    );
  }
}

function refused(refusal: PromptRefusal): PromptOutcome {
  return { answered: false, refusal, notSent: true };
}

export class WorkBroker {
  readonly #notifyWindow: (windowId: number, notice: BrokerNotice) => boolean;
  readonly #condemnExecutor: ((executor: string) => boolean) | undefined;
  readonly #timers: SupervisorTimers;
  readonly #warn: (message: string) => void;

  /** (kind, id) -> that owner's live units, by unit id. */
  readonly #owners = new Map<string, Map<string, Unit>>();
  /** The one wait list, first come first served. */
  readonly #queue: Unit[] = [];
  /** Units holding the slot: running, or draining until their work returns. */
  readonly #slot = new Set<Unit>();
  /** Device credential id -> its one live channel. */
  readonly #channels = new Map<string, OwnerChannel>();
  readonly #revoked = new Set<string>();
  /** Held results, oldest first. */
  #held: HeldResult[] = [];

  #mode: 'admitting' | 'suspended' | 'quit' = 'admitting';
  #nextPromptId = 1;
  #cancelTick: (() => void) | null;

  constructor(options: WorkBrokerOptions) {
    this.#notifyWindow = options.notifyWindow;
    this.#condemnExecutor = options.condemnExecutor;
    this.#timers = options.timers ?? systemTimers();
    this.#warn = options.warn ?? ((): void => undefined);
    this.#cancelTick = this.#timers.every(BROKER_TICK_MS, () => this.#tick());
  }

  /* ── Reading the state ─────────────────────────────────────────────── */

  /** False while suspended or after quit. */
  get admitting(): boolean {
    return this.#mode === 'admitting';
  }

  /** Units holding the slot, including one whose end is decided but whose work has not returned. */
  get slotCount(): number {
    return this.#slot.size;
  }

  get waitingCount(): number {
    return this.#queue.length;
  }

  /** Results held and not yet expired. */
  get heldCount(): number {
    this.#purgeExpired(this.#timers.now());
    return this.#held.length;
  }

  /** Owners with at least one live unit. */
  get ownerCount(): number {
    return this.#owners.size;
  }

  /** A unit's place: 0 holding the slot, 1.. waiting, undefined when not live. */
  positionOf(owner: Owner, unitId: string): number | undefined {
    const unit = this.#owners.get(ownerKey(owner))?.get(unitId);
    if (unit === undefined) return undefined;
    if (unit.state === 'waiting') return this.#queue.indexOf(unit) + 1;
    return 0;
  }

  /**
   * Whether the unit holds the slot with its end still undecided: the only
   * state in which work may be done under it.
   *
   * Its deadlines are enforced first, so a unit whose idle deadline has passed
   * is not running here even if the tick has not yet ended it; asking ends it.
   */
  isRunning(owner: Owner, unitId: string): boolean {
    const unit = this.#owners.get(ownerKey(owner))?.get(unitId);
    if (unit === undefined) return false;
    this.#enforceDeadlines(unit, this.#timers.now());
    return unit.state === 'running';
  }

  /** The unit ids a device has results held for, oldest first. Expired ones are gone. */
  heldFor(deviceId: string): readonly string[] {
    this.#purgeExpired(this.#timers.now());
    return this.#held.filter((held) => held.deviceId === deviceId).map((held) => held.unitId);
  }

  /* ── Admission ─────────────────────────────────────────────────────── */

  admit(request: UnitRequest): AdmitResult {
    assertOwner(request.owner);
    if (typeof request.unitId !== 'string' || request.unitId.length === 0) {
      throw new TypeError('work broker: a unit needs a non-empty id.');
    }
    if (this.#mode === 'quit') return { admitted: false, refusal: 'DESKTOP_QUITTING' };
    if (this.#mode === 'suspended') return { admitted: false, refusal: 'HOST_SUSPENDED' };
    const { owner } = request;
    if (owner.kind === 'device' && this.#revoked.has(owner.id)) {
      return { admitted: false, refusal: 'OWNER_REVOKED' };
    }

    const key = ownerKey(owner);
    const units = this.#owners.get(key);
    // A live id is refused rather than replaced: the work below keys by it too
    // (the llama host keys generations by requestId), so two live units sharing
    // one would be ambiguous all the way down. Same rule as the Supervisor's.
    if (units?.has(request.unitId) === true) return { admitted: false, refusal: 'DUPLICATE_UNIT' };
    // And a device's id is not reusable while a result is held under it: an
    // `ack` names a unit id, and one ack must never purge two results.
    if (owner.kind === 'device') {
      this.#purgeExpired(this.#timers.now());
      if (this.#held.some((held) => held.deviceId === owner.id && held.unitId === request.unitId)) {
        return { admitted: false, refusal: 'DUPLICATE_UNIT' };
      }
    }

    // FIFO: a new unit never starts ahead of one already waiting.
    const startsNow = this.#slot.size < MAX_CONCURRENT_TURNS && this.#queue.length === 0;
    if (!startsNow) {
      if (request.wait === false) return { admitted: false, refusal: 'SLOT_BUSY' };
      const cap = owner.kind === 'device' ? MAX_WAITING_PER_DEVICE : MAX_WAITING_PER_WINDOW;
      let waiting = 0;
      for (const unit of units?.values() ?? []) if (unit.state === 'waiting') waiting += 1;
      if (waiting >= cap) return { admitted: false, refusal: 'OWNER_WAIT_LIST_FULL' };
      if (this.#queue.length >= MAX_WAITING_TOTAL) return { admitted: false, refusal: 'WAIT_LIST_FULL' };
    }

    let resolve: (terminal: UnitTerminal) => void = () => undefined;
    const settled = new Promise<UnitTerminal>((done) => {
      resolve = done;
    });
    const unit: Unit = {
      owner,
      key,
      unitId: request.unitId,
      executor: request.executor,
      start: request.start,
      state: 'waiting',
      started: false,
      returned: false,
      told: 0,
      deadlineAt: 0,
      drainDeadlineAt: 0,
      drainExpired: false,
      prompt: null,
      controller: null,
      terminal: null,
      resolve,
    };
    if (units === undefined) this.#owners.set(key, new Map([[unit.unitId, unit]]));
    else units.set(unit.unitId, unit);

    if (startsNow) {
      this.#run(unit);
      return { admitted: true, position: 0, settled };
    }
    this.#queue.push(unit);
    this.#tellPositions();
    return { admitted: true, position: this.#queue.length, settled };
  }

  /**
   * The owner cancels its unit.
   *
   * Waiting: it ends `CANCELLED` and leaves the list. Running: its work is
   * aborted, and it ends when the work reports, which is how a cancelled
   * generation still delivers the partial result its engine produced. A unit
   * that is not the caller's is not found, deliberately.
   */
  cancel(owner: Owner, unitId: string): void {
    const unit = this.#owners.get(ownerKey(owner))?.get(unitId);
    if (unit === undefined) return;
    if (unit.state === 'waiting') this.#settle(unit, 'CANCELLED');
    else if (unit.state === 'running') unit.controller?.abort();
  }

  /**
   * Proof of progress: resets a running unit's idle deadline.
   *
   * Not after the deadline has passed. Progress that arrives late, before the
   * tick has looked, does not rescue a unit that missed its deadline; it ends
   * it, as the tick would have.
   */
  progress(owner: Owner, unitId: string): void {
    const unit = this.#owners.get(ownerKey(owner))?.get(unitId);
    if (unit === undefined || unit.state !== 'running') return;
    const now = this.#timers.now();
    this.#enforceDeadlines(unit, now);
    if (unit.state !== 'running' || unit.prompt !== null) return;
    unit.deadlineAt = now + UNIT_IDLE_TIMEOUT_MS;
  }

  /* ── Relayed prompts (#170) ─────────────────────────────────────────── */

  /**
   * Relay a prompt to a running unit's owner and wait for the answer.
   *
   * Never rejects. A refusal carries `notSent: true`: the call the prompt
   * guarded must not be sent, and must not be sent later on a late answer.
   */
  requestPrompt(owner: Owner, unitId: string, prompt: unknown): Promise<PromptOutcome> {
    const unit = this.#owners.get(ownerKey(owner))?.get(unitId);
    if (unit !== undefined) this.#enforceDeadlines(unit, this.#timers.now());
    if (unit === undefined || unit.state !== 'running') return Promise.resolve(refused('NOT_RUNNING'));
    if (unit.prompt !== null) return Promise.resolve(refused('PROMPT_PENDING'));
    if (owner.kind === 'device' && !this.#channels.has(owner.id)) {
      return Promise.resolve(refused('OWNER_DETACHED'));
    }

    const promptId = `${unitId}#${String(this.#nextPromptId++)}`;
    return new Promise<PromptOutcome>((resolve) => {
      unit.prompt = { promptId, deadlineAt: this.#timers.now() + PROMPT_ANSWER_TIMEOUT_MS, resolve };
      const sent = this.#deliver(unit, { kind: 'prompt', unitId, promptId, prompt });
      if (!sent && unit.prompt?.promptId === promptId) this.#refusePrompt(unit, 'OWNER_DETACHED');
    });
  }

  /**
   * The owner answers. False when nothing is waiting for this answer any more.
   *
   * An answer that arrives after `PROMPT_ANSWER_TIMEOUT_MS` is refused here,
   * at the moment it arrives, and the prompt is refused `PROMPT_TIMEOUT`: the
   * tick not having run yet does not make a late answer on time.
   */
  answerPrompt(owner: Owner, unitId: string, promptId: string, answer: unknown): boolean {
    const unit = this.#owners.get(ownerKey(owner))?.get(unitId);
    const pending = unit?.prompt;
    if (unit === undefined || pending === null || pending === undefined || pending.promptId !== promptId) {
      return false;
    }
    const now = this.#timers.now();
    if (pending.deadlineAt <= now) {
      this.#refusePrompt(unit, 'PROMPT_TIMEOUT');
      return false;
    }
    unit.prompt = null;
    unit.deadlineAt = now + UNIT_IDLE_TIMEOUT_MS;
    pending.resolve({ answered: true, answer });
    return true;
  }

  /* ── Devices (#7 ruling 4, #135) ────────────────────────────────────── */

  /**
   * A device's socket connected. A newer one REPLACES the stale one, which is
   * closed (#169: last writer wins, because the old socket is usually a corpse
   * after a network change).
   *
   * Replacement is the stale socket's tunnel dropping, so a prompt that was
   * sent on it is REFUSED `OWNER_DETACHED` (#170), exactly as a drop refuses
   * it: nobody can see it on the corpse, it is not re-sent on the new socket,
   * and its answer is never accepted. The caller asks again if it still needs
   * one, which the phone then sees on the new socket.
   *
   * Then the device is brought up to date: running units say started, waiting
   * units say where they are, and every held result that has not expired is
   * sent again until it is acknowledged. A unit it does not mention has ended
   * and holds nothing (a sleep, a quit, an expiry): S8's phone treats that as
   * lost.
   *
   * @returns false for a revoked device or a quitting app; the caller closes it.
   */
  attachDevice(deviceId: string, channel: OwnerChannel): boolean {
    assertOwner({ kind: 'device', id: deviceId });
    if (this.#mode === 'quit' || this.#revoked.has(deviceId)) return false;
    const stale = this.#channels.get(deviceId);
    this.#channels.set(deviceId, channel);
    const units = this.#owners.get(ownerKey({ kind: 'device', id: deviceId }));
    if (stale !== undefined && stale !== channel) {
      try {
        stale.close('SOCKET_REPLACED');
      } catch (error) {
        this.#warn(`work broker: closing a replaced socket threw (${errorKind(error)}).`);
      }
      for (const unit of units?.values() ?? []) {
        if (unit.prompt !== null) this.#refusePrompt(unit, 'OWNER_DETACHED');
      }
    }

    const now = this.#timers.now();
    for (const unit of [...(units?.values() ?? [])]) {
      this.#enforceDeadlines(unit, now);
      if (unit.state === 'running') this.#send(channel, { kind: 'started', unitId: unit.unitId });
      if (unit.state === 'waiting') {
        const position = this.#queue.indexOf(unit) + 1;
        if (this.#send(channel, { kind: 'waiting', unitId: unit.unitId, position })) unit.told = position;
      }
    }
    this.#purgeExpired(now);
    for (const held of this.#held) {
      if (held.deviceId === deviceId) this.#send(channel, { kind: 'terminal', terminal: held.terminal });
    }
    return true;
  }

  /**
   * A device's socket went away. Its units are NOT settled (ruling 4): they
   * run on, and their results are held. A prompt it was answering is refused,
   * because nobody can answer it (#170).
   *
   * A stale socket's late close is ignored, so it cannot detach its
   * replacement.
   */
  detachDevice(deviceId: string, channel: OwnerChannel): void {
    if (this.#channels.get(deviceId) !== channel) return;
    this.#channels.delete(deviceId);
    for (const unit of this.#owners.get(ownerKey({ kind: 'device', id: deviceId }))?.values() ?? []) {
      if (unit.prompt !== null) this.#refusePrompt(unit, 'OWNER_DETACHED');
    }
  }

  /** The device has its result; stop holding it. False for one not held, or held past its limit. */
  ack(deviceId: string, unitId: string): boolean {
    this.#purgeExpired(this.#timers.now());
    const before = this.#held.length;
    this.#held = this.#held.filter((held) => !(held.deviceId === deviceId && held.unitId === unitId));
    return this.#held.length !== before;
  }

  /**
   * The device's pairing was revoked (#135). Owner loss: every unit it has ends
   * `OWNER_REVOKED`, everything held for it is purged, its socket is closed,
   * and it is refused from now on.
   */
  revokeDevice(deviceId: string): void {
    assertOwner({ kind: 'device', id: deviceId });
    this.#revoked.add(deviceId);
    for (const unit of [...(this.#owners.get(ownerKey({ kind: 'device', id: deviceId }))?.values() ?? [])]) {
      this.#settle(unit, 'OWNER_REVOKED');
    }
    this.#held = this.#held.filter((held) => held.deviceId !== deviceId);
    const channel = this.#channels.get(deviceId);
    this.#channels.delete(deviceId);
    if (channel !== undefined) {
      try {
        channel.close('OWNER_REVOKED');
      } catch (error) {
        this.#warn(`work broker: closing a revoked device's socket threw (${errorKind(error)}).`);
      }
    }
  }

  /* ── Windows ────────────────────────────────────────────────────────── */

  /** A window went away. Owner loss for every unit it had; nothing is delivered. */
  releaseWindow(windowId: number): void {
    assertOwner({ kind: 'window', id: windowId });
    for (const unit of [...(this.#owners.get(ownerKey({ kind: 'window', id: windowId }))?.values() ?? [])]) {
      this.#settle(unit, 'OWNER_LOST');
    }
  }

  /* ── Executors ──────────────────────────────────────────────────────── */

  /**
   * An executor died. Its running units end `WORKER_LOST`, and the slot is
   * released now: the work is gone, not merely slow. Waiting units are
   * untouched; they run on whatever replaces it.
   */
  workerLost(executor: string): void {
    for (const unit of [...this.#slot]) {
      if (unit.executor !== executor) continue;
      this.#settle(unit, 'WORKER_LOST');
      this.#returned(unit);
    }
  }

  /* ── Lifecycle (#7 rulings 5 and 7) ─────────────────────────────────── */

  /**
   * The machine is suspending. Stop admitting; end what is running and what is
   * waiting with `HOST_SUSPENDED`, telling whoever is connected; drop held
   * results, which end on sleep (ruling 5). Running work is aborted and keeps
   * the slot until it returns.
   */
  suspend(): void {
    if (this.#mode !== 'admitting') return;
    this.#mode = 'suspended';
    this.#endEverything('HOST_SUSPENDED');
  }

  /** The machine woke. Admit again. */
  resume(): void {
    if (this.#mode !== 'suspended') return;
    this.#mode = 'admitting';
    this.#pump();
  }

  /** The app is quitting. Nothing is admitted again, and everything ends `DESKTOP_QUITTING`. */
  quit(): void {
    if (this.#mode === 'quit') return;
    this.#mode = 'quit';
    this.#endEverything('DESKTOP_QUITTING');
    this.#cancelTick?.();
    this.#cancelTick = null;
  }

  /* ── The one settle ─────────────────────────────────────────────────── */

  #endEverything(end: 'HOST_SUSPENDED' | 'DESKTOP_QUITTING'): void {
    for (const unit of [...this.#queue]) this.#settle(unit, end);
    for (const unit of [...this.#slot]) this.#settle(unit, end);
    this.#held = [];
  }

  /**
   * The single door every unit's end goes through.
   *
   * Idempotent: the first caller decides the terminal and every later path is
   * a no-op, so a report that arrives after a deadline, a revocation after a
   * suspend, or a worker loss after a quit cannot produce a second terminal.
   */
  #settle(unit: Unit, end: UnitEnd, report?: { value?: unknown; error?: unknown }): void {
    if (unit.terminal !== null) return;
    const terminal: UnitTerminal = {
      owner: unit.owner,
      unitId: unit.unitId,
      end,
      started: unit.started,
      ...(report !== undefined && 'value' in report ? { value: report.value } : {}),
      ...(report !== undefined && 'error' in report ? { error: report.error } : {}),
    };
    unit.terminal = terminal;

    if (unit.prompt !== null) this.#refusePrompt(unit, 'UNIT_SETTLED');

    if (unit.state === 'waiting') {
      const at = this.#queue.indexOf(unit);
      if (at >= 0) this.#queue.splice(at, 1);
      this.#forget(unit);
    } else if (unit.state === 'running') {
      unit.state = 'draining';
      unit.drainDeadlineAt = this.#timers.now() + UNIT_DRAIN_TIMEOUT_MS;
      if (!unit.returned) unit.controller?.abort();
    }

    unit.resolve(terminal);
    this.#deliverTerminal(unit, terminal);
    this.#tellPositions();
  }

  #deliverTerminal(unit: Unit, terminal: UnitTerminal): void {
    const { owner } = unit;
    if (owner.kind === 'window') {
      // A window that is gone has no page to tell.
      if (terminal.end !== 'OWNER_LOST') this.#deliver(unit, { kind: 'terminal', terminal });
      return;
    }
    // A revoked device is told nothing and keeps nothing.
    if (terminal.end === 'OWNER_REVOKED') return;
    // Held until acknowledged, whether or not it went out live: a frame sent
    // just before a socket died was never seen. Except on sleep and quit, where
    // held results end (ruling 5) and the phone is only told.
    if (terminal.end !== 'HOST_SUSPENDED' && terminal.end !== 'DESKTOP_QUITTING') {
      this.#hold(owner.id, unit.unitId, terminal);
    }
    this.#deliver(unit, { kind: 'terminal', terminal });
  }

  #hold(deviceId: string, unitId: string, terminal: UnitTerminal): void {
    const now = this.#timers.now();
    this.#purgeExpired(now);
    this.#held.push({ deviceId, unitId, terminal, expiresAt: now + RETAIN_RESULT_MS });

    // Per device first: one device's unacknowledged backlog costs that device
    // its oldest result, never another device its only one.
    let mine = this.#held.filter((held) => held.deviceId === deviceId).length;
    while (mine > RETAIN_RESULT_PER_DEVICE) {
      const oldest = this.#held.findIndex((held) => held.deviceId === deviceId);
      this.#held.splice(oldest, 1);
      mine -= 1;
      this.#warn('work broker: dropped a device’s oldest held result; it held more than RETAIN_RESULT_PER_DEVICE.');
    }

    // Then the total: the oldest result of whichever device holds the most.
    while (this.#held.length > RETAIN_RESULT_COUNT) {
      const counts = new Map<string, number>();
      for (const held of this.#held) counts.set(held.deviceId, (counts.get(held.deviceId) ?? 0) + 1);
      const most = Math.max(...counts.values());
      const victim = this.#held.findIndex((held) => counts.get(held.deviceId) === most);
      this.#held.splice(victim, 1);
      this.#warn('work broker: dropped the oldest held result of the device holding the most; more than RETAIN_RESULT_COUNT were held.');
    }
  }

  #purgeExpired(now: number): void {
    if (this.#held.some((held) => held.expiresAt <= now)) {
      this.#held = this.#held.filter((held) => held.expiresAt > now);
    }
  }

  #refusePrompt(unit: Unit, refusal: PromptRefusal): void {
    const pending = unit.prompt;
    if (pending === null) return;
    unit.prompt = null;
    unit.deadlineAt = this.#timers.now() + UNIT_IDLE_TIMEOUT_MS;
    pending.resolve(refused(refusal));
  }

  /**
   * A running unit's deadlines, checked against `now`: the prompt's if one is
   * pending (refused on expiry, which restarts the idle deadline), otherwise
   * the idle deadline (the unit ends `DEADLINE`).
   */
  #enforceDeadlines(unit: Unit, now: number): void {
    if (unit.state !== 'running') return;
    if (unit.prompt !== null) {
      if (unit.prompt.deadlineAt <= now) this.#refusePrompt(unit, 'PROMPT_TIMEOUT');
      return;
    }
    if (unit.deadlineAt <= now) this.#settle(unit, 'DEADLINE');
  }

  /* ── Running work ───────────────────────────────────────────────────── */

  #run(unit: Unit): void {
    unit.state = 'running';
    unit.started = true;
    unit.controller = new AbortController();
    unit.deadlineAt = this.#timers.now() + UNIT_IDLE_TIMEOUT_MS;
    this.#slot.add(unit);
    this.#deliver(unit, { kind: 'started', unitId: unit.unitId });

    let work: Promise<unknown>;
    try {
      work = Promise.resolve(unit.start(unit.controller.signal));
    } catch (error) {
      work = Promise.reject(error);
    }
    work.then(
      (value: unknown) => {
        this.#settle(unit, 'COMPLETED', { value });
        this.#returned(unit);
      },
      (error: unknown) => {
        this.#settle(unit, 'FAILED', { error });
        this.#returned(unit);
      },
    );
  }

  /** The work has stopped. Only now is the slot free. */
  #returned(unit: Unit): void {
    if (unit.returned) return;
    unit.returned = true;
    if (!this.#slot.delete(unit)) return;
    this.#forget(unit);
    this.#pump();
  }

  /**
   * A draining unit's work has not stopped within `UNIT_DRAIN_TIMEOUT_MS` of
   * its abort. Acted on once.
   */
  #drainExpired(unit: Unit): void {
    unit.drainExpired = true;
    let killed = false;
    if (this.#condemnExecutor !== undefined) {
      try {
        killed = this.#condemnExecutor(unit.executor) === true;
      } catch (error) {
        this.#warn(`work broker: condemning an executor threw (${errorKind(error)}).`);
      }
    }
    if (!killed) {
      // FAIL CLOSED. The work may still be decoding; freeing the slot would put
      // the next owner's turn on the same sequence.
      this.#warn(
        'work broker: a unit’s work has not stopped UNIT_DRAIN_TIMEOUT_MS after its end, and its executor ' +
          'was not condemned; the slot stays held until the work returns.',
      );
      return;
    }
    this.#warn('work broker: condemned an executor whose work did not stop within UNIT_DRAIN_TIMEOUT_MS of its end.');
    this.workerLost(unit.executor);
  }

  #forget(unit: Unit): void {
    unit.state = 'done';
    const units = this.#owners.get(unit.key);
    if (units?.get(unit.unitId) === unit) units.delete(unit.unitId);
    if (units?.size === 0) this.#owners.delete(unit.key);
  }

  #pump(): void {
    while (this.#mode === 'admitting' && this.#slot.size < MAX_CONCURRENT_TURNS && this.#queue.length > 0) {
      const next = this.#queue.shift();
      if (next !== undefined) this.#run(next);
    }
    this.#tellPositions();
  }

  /** Tell every waiting owner whose place changed. */
  #tellPositions(): void {
    this.#queue.forEach((unit, index) => {
      const position = index + 1;
      if (unit.told === position) return;
      if (this.#deliver(unit, { kind: 'waiting', unitId: unit.unitId, position })) unit.told = position;
    });
  }

  #tick(): void {
    const now = this.#timers.now();
    for (const unit of [...this.#slot]) {
      if (unit.state === 'draining') {
        if (!unit.returned && !unit.drainExpired && unit.drainDeadlineAt <= now) this.#drainExpired(unit);
        continue;
      }
      this.#enforceDeadlines(unit, now);
    }
    this.#purgeExpired(now);
  }

  /* ── Delivery ───────────────────────────────────────────────────────── */

  #deliver(unit: Unit, notice: BrokerNotice): boolean {
    const { owner } = unit;
    if (owner.kind === 'window') {
      try {
        return this.#notifyWindow(owner.id, notice);
      } catch (error) {
        this.#warn(`work broker: telling a window about a unit threw (${errorKind(error)}).`);
        return false;
      }
    }
    const channel = this.#channels.get(owner.id);
    return channel === undefined ? false : this.#send(channel, notice);
  }

  #send(channel: OwnerChannel, notice: BrokerNotice): boolean {
    try {
      return channel.send(notice);
    } catch (error) {
      this.#warn(`work broker: a device channel threw on send (${errorKind(error)}).`);
      return false;
    }
  }
}

/** An error's class name only. A message could carry a prompt. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
