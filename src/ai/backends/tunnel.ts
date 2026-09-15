/**
 * A paired device as an aimatey backend: the phone's end of a turn that runs on
 * the user's own desktop, over a tunnel (S10 U3; refs #184, #185, #186, #188,
 * #190).
 *
 * The sibling of `llama-cpp.ts`. The engine, its tool loop and every call site
 * treat a paired desktop the way they treat any backend; what is particular to
 * the tunnel lives here and nowhere above it.
 *
 * WHAT IT IS HANDED, AND WHAT IT NEVER DOES. It is constructed with a device, a
 * `connect` and the Router it is registered on. It never calls
 * `createTunnelClient`, which cannot set its credential header in a webview and
 * throws there (packages/tunnel/src/client/index.ts); the phone's transport is
 * the native socket plugin #181 chose, and whoever builds this adapter hands
 * over the `TunnelClient` it opens. Its imports are the client's TYPE, the
 * wire, the stream checks, the codec and the IR types, and nothing from the
 * host half or from the app's state or features.
 *
 * DECISIONS SETTLED HERE, each inside a ruling or an explicit hand-off:
 *
 * - ONE ADAPTER PER PAIRED DEVICE, registered as `tunnel:<deviceId>`
 *   ({@link tunnelBackendId}). #186 rules that a revoked device is unregistered
 *   rather than left to a breaker, and #191 keeps a row per device, so a device
 *   is a registration.
 *
 * - A MINIMAL, STATIC CAPABILITY DECLARATION: streaming, no multimodal input
 *   (#190). Routing is explicit (engine.ts, `routingStrategy`), so nothing
 *   selects this backend by what it declares.
 *
 * - THE TAINT MARK STAYS STRIPPED FOR A PAIRED DESTINATION IN V1.
 *   `keepsTaintMark` in engine.ts leaves the choice to "the tunnel adapter that
 *   first produces a paired target". The mark would mean something to the far
 *   side, which is this same app, but nothing on the desktop reads it from a
 *   turn yet, and a mark whose only reader does not exist is one that will be
 *   wrong by the time a reader does. So the engine's predicate is left as it is:
 *   the mark is stripped, and keeping it is a change to make together with the
 *   desktop code that honours it.
 *
 * - THE TOOL LOOP STAYS ON THIS PHONE: every turn says `toolLoop: 'requester'`
 *   (#152). This is a backend under the engine's own tool loop, which runs the
 *   calls a reply contains; the desktop serves inference. Running the loop on
 *   the desktop, with its bash and its confirms relayed here, is ruled (#170)
 *   and needs relayed prompts (S10 U8), which are not built. So a `prompt` that
 *   arrives anyway is answered no: only a yes lets a call go.
 *
 * - ONE CONNECTION PER TURN. `connect` is called when a turn starts and the
 *   connection is closed when it ends. Collecting a result the desktop held for
 *   a dropped socket (`attach` and `ack`, #7 ruling 4) is S10 U9 and is not
 *   here.
 *
 * EVERY WAY A TURN ENDS YIELDS EXACTLY ONE TERMINAL CHUNK:
 *
 * - the desktop's `done`, passed through with the desktop's own copy of the
 *   reply as its message, which is #148's checksum. A `done` without one is a
 *   failure (#260), checked here as well as by the gate, for a client that
 *   does not run the gate;
 * - the desktop's `error` chunk, passed through;
 * - a refusal that ends the turn, as an `error` chunk carrying the refusal's
 *   code and a sentence of this build's own (the far side's text is another
 *   build's);
 * - a tunnel that ends without a terminal, as an `error` chunk carrying how it
 *   ended: PEER_GONE, SEQUENCE_BROKEN, TUNNEL_FULL, PAIRING_ONLY,
 *   PAIRING_WINDOW_CLOSED — never the engine's generic EMPTY_RESPONSE, which
 *   says only that something stopped;
 * - Stop, as ONE `cancel` frame and a `done` whose finish reason is
 *   `cancelled`. Not an `error`: see the breaker below, which would count it.
 *
 * A `waiting` frame goes to `onWaiting` and never into the stream, and `0` is
 * reported when the reply starts after one, as the local adapter does.
 *
 * ── THE BREAKER, AND WHY THIS ADAPTER IS HANDED THE ROUTER (#186) ─────────
 *
 * #186's ruling: "the tunnel adapter classifies its own transport failures
 * before the Router ever sees them", and a busy desktop is "not a failure at
 * all". The correction to this unit's brief adds a quitting and a sleeping
 * desktop: WAIT_LIST_FULL, DESKTOP_QUITTING and HOST_SUSPENDED leave the
 * circuit closed.
 *
 * A CHUNK CANNOT SAY THAT, measured against aimatey-core 0.4.0. The Router's
 * `trackStream` (dist/esm/router.js:1381-1411) records a failure for the first
 * `error` chunk an adapter yields and for a throw; it records a success for a
 * `done` or an iterator that ends without a terminal; and it counts neither
 * only when the CONSUMER walks away. The engine, meanwhile, shows the user a
 * refusal's own sentence only from an `error` chunk (engine.ts `#runTurn`); a
 * stream with no terminal becomes EMPTY_RESPONSE. So an adapter that ends a
 * refused turn the way the engine can show has already been counted, and three
 * of them pause the tunnel with a sentence saying it "failed 3 times in a row".
 *
 * So the classification is acted on where the count is kept. A refusal of kind
 * `busy`, `quitting` or `suspended` is the desktop ANSWERING: a coherent,
 * defined reply over a working tunnel, which is the evidence a success gives.
 * Once the Router has counted its `error` chunk — this adapter's `finally`
 * runs when the Router closes the stream, which is after it counted and before
 * the engine reports the turn — the consecutive-failure run for THIS adapter's
 * registration is reset, as a success would reset it. Only its own entry, and
 * only if the entry is this adapter. A refusal this build does not know, a cut,
 * a broken sequence and every other ending still count. The durable fix is an
 * outcome in aimatey-core that is neither success nor failure; until one
 * exists, this is the only place that knows the difference.
 *
 * `execute` (non-streaming, used by no caller in src/) throws on a failed turn,
 * and the Router counts that throw with nothing after it to settle it.
 *
 * NOT CARRIED FROM A METADATA CHUNK: the desktop's `metadata.warnings`. Its
 * category is a closed union this file would have to restate to check, and a
 * warning read without that check is a shape nobody verified. Usage and
 * `metadata.custom` are carried.
 */

import type { TunnelClient, TunnelClose } from '@chatterang/tunnel/client';
import { CodecRefusal, FIELD_POLICY, applyPolicy } from '@chatterang/tunnel/codec';
import { faultMessage, isMessage } from '@chatterang/tunnel/stream';
import { TUNNEL_WIRE_VERSION, refusalOf, type RefusalKind, type TunnelFrame } from '@chatterang/tunnel/wire';
import type {
  AdapterMetadata,
  BackendAdapter,
  FinishReason,
  IRChatRequest,
  IRChatResponse,
  IRChatStream,
  IRStreamChunk,
  IRUsage,
  Router,
} from '@johnhenry/aimatey-types';

/** The device a turn goes to. Structurally `PairedDevice` in `src/domain/chat.ts`. */
export interface TunnelDevice {
  /** The pairing id: stable across a rename. */
  readonly id: string;
  /** What the person calls it, for the sentences this adapter writes. */
  readonly name: string;
}

/** The two things this adapter asks of the Router it is registered on. See the header. */
export type TunnelBreaker = Pick<Router, 'getBackendInfo' | 'resetCircuitBreaker'>;

export interface TunnelBackendOptions {
  readonly device: TunnelDevice;
  /** Open a connection to the device. Called once per turn. */
  readonly connect: () => Promise<TunnelClient>;
  /** The Router this adapter is registered on, as {@link tunnelBackendId}. */
  readonly router: TunnelBreaker;
  /** The turn's place in the desktop's wait list, and `0` when its reply starts (#7). */
  readonly onWaiting?: (position: number) => void;
}

/** A `turn` frame: what `fromIR` produces. */
export type TunnelTurnFrame = Extract<TunnelFrame, { readonly kind: 'turn' }>;

/** A whole reply, as `execute` assembles it for `toIR`. */
export interface TunnelReply {
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly usage?: IRUsage;
}

/** The Router registration for a paired device. */
export function tunnelBackendId(deviceId: string): string {
  return `tunnel:${deviceId}`;
}

/**
 * Refusals that are the desktop answering, not failing (#186). A busy wait list,
 * a desktop quitting, a desktop going to sleep: each is a defined reply over a
 * tunnel that works.
 */
const ANSWERS: ReadonlySet<RefusalKind> = new Set<RefusalKind>(['busy', 'quitting', 'suspended']);

const CAPABILITIES = {
  streaming: true,
  multiModal: false,
  systemMessageStrategy: 'in-messages',
  supportsMultipleSystemMessages: true,
} as const;

const FINISH_REASONS: readonly FinishReason[] = ['stop', 'length', 'tool_calls', 'content_filter', 'error', 'cancelled'];

const STOPPED = Symbol('stopped');

/**
 * What the person reads when a turn to `device` ends without a reply.
 *
 * This build's sentences, not the far side's: an `error` frame's `message` is
 * written by another build, and a phone should say what IT knows the code means.
 * HOST_DOES_NOT_RUN_TURNS is #7's eighth ruling, verbatim.
 */
function sentence(code: string, device: string): string {
  switch (code) {
    case 'HOST_DOES_NOT_RUN_TURNS':
      return "this server doesn't run phone turns yet";
    case 'WAIT_LIST_FULL':
      return `${device} is busy with other replies and cannot take this one now. Try again in a moment.`;
    case 'DESKTOP_QUITTING':
      return `${device} is quitting, or has stopped taking turns from paired devices, so this reply ended.`;
    case 'HOST_SUSPENDED':
      return `${device} went to sleep, so this reply ended.`;
    case 'TOOL_LOOP_UNSUPPORTED':
      return `${device} does not answer turns whose tools run on this device.`;
    case 'FRAME_UNEXPECTED':
      return `${device} did not accept this turn.`;
    case 'PEER_GONE':
      return `The connection to ${device} was lost before this reply finished.`;
    case 'PEER_CLOSED':
      return `${device} closed the connection before this reply finished.`;
    case 'PEER_UNREACHABLE':
      return `${device} could not be reached.`;
    case 'TUNNEL_FULL':
      return `${device} is already holding as many connections as it allows. Try again in a moment.`;
    case 'PAIRING_ONLY':
    case 'PAIRING_WINDOW_CLOSED':
      return `${device} no longer accepts this device as paired. Pair them again.`;
    case 'FRAME_INVALID':
    case 'CHUNK_INVALID':
      return `${device} sent a reply this version of the app cannot read.`;
    case 'SEND_FAILED':
      return `This turn could not be sent to ${device}.`;
    default:
      return `${device} ended this reply for a reason this version of the app does not recognise.`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isFinishReason = (value: unknown): value is FinishReason => FINISH_REASONS.some((reason) => reason === value);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readUsage(value: unknown): IRUsage | undefined {
  if (!isRecord(value)) return undefined;
  const { promptTokens, completionTokens, totalTokens } = value;
  if (!finite(promptTokens) || !finite(completionTokens) || !finite(totalTokens)) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

function readPartialUsage(value: unknown): Partial<IRUsage> | undefined {
  if (!isRecord(value)) return undefined;
  const usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } = {};
  if (finite(value.promptTokens)) usage.promptTokens = value.promptTokens;
  if (finite(value.completionTokens)) usage.completionTokens = value.completionTokens;
  if (finite(value.totalTokens)) usage.totalTokens = value.totalTokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * The reply text of an IR message, read the way the engine's checksum reads one
 * (`streamedTextOf`): a string, or its text blocks joined. Built from what is
 * checked, so a block that is not an object is text-less rather than a crash.
 */
function replyText(message: unknown): string {
  if (!isRecord(message)) return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

/**
 * One chunk body from the desktop, as an IR chunk this build has checked, or
 * `null` for one it cannot read. `sequence` is left at 0: this adapter numbers
 * its own stream. `'no-message'` is a `done` without a message (#260).
 */
function readChunk(body: unknown): IRStreamChunk | 'no-message' | null {
  if (!isRecord(body)) return null;
  switch (body.type) {
    case 'start':
      return { type: 'start', sequence: 0, metadata: { requestId: '', timestamp: 0 } };
    case 'content':
      return typeof body.delta === 'string' ? { type: 'content', sequence: 0, delta: body.delta, role: 'assistant' } : null;
    case 'tool_use': {
      if (typeof body.id !== 'string' || typeof body.name !== 'string') return null;
      if (body.inputDelta !== undefined && typeof body.inputDelta !== 'string') return null;
      if (body.index !== undefined && !finite(body.index)) return null;
      return {
        type: 'tool_use',
        sequence: 0,
        id: body.id,
        name: body.name,
        ...(typeof body.inputDelta === 'string' ? { inputDelta: body.inputDelta } : {}),
        ...(finite(body.index) ? { index: body.index } : {}),
      };
    }
    case 'metadata': {
      const usage = readPartialUsage(body.usage);
      const custom = isRecord(body.metadata) && isRecord(body.metadata.custom) ? body.metadata.custom : undefined;
      return {
        type: 'metadata',
        sequence: 0,
        ...(usage ? { usage } : {}),
        ...(custom ? { metadata: { custom } } : {}),
      };
    }
    case 'done': {
      if (!isFinishReason(body.finishReason)) return null;
      if (!isMessage(body.message)) return 'no-message';
      const usage = readUsage(body.usage);
      return {
        type: 'done',
        sequence: 0,
        finishReason: body.finishReason,
        message: { role: 'assistant', content: replyText(body.message) },
        ...(usage ? { usage } : {}),
      };
    }
    case 'error': {
      const { error } = body;
      if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') return null;
      return { type: 'error', sequence: 0, error: { code: error.code, message: error.message } };
    }
    default:
      return null;
  }
}

/** A promise that settles when `signal` aborts, and a way to stop listening. */
function whenStopped(signal: AbortSignal | undefined): { readonly promise: Promise<typeof STOPPED>; dispose(): void } {
  if (!signal) return { promise: new Promise<typeof STOPPED>(() => undefined), dispose: () => undefined };
  let listener: (() => void) | null = null;
  const promise = new Promise<typeof STOPPED>((resolve) => {
    if (signal.aborted) {
      resolve(STOPPED);
      return;
    }
    listener = () => resolve(STOPPED);
    signal.addEventListener('abort', listener, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (listener) signal.removeEventListener('abort', listener);
    },
  };
}

/** A turn id: opaque, and well inside the wire's length limit. */
function mintTurnId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `turn_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Hand a frame to a tunnel that may already be gone. Nothing to do if it is. */
async function sendIfOpen(client: TunnelClient, frame: TunnelFrame): Promise<void> {
  try {
    await client.send(frame);
  } catch {
    // The tunnel ended, or its gate says the turn already did. Either way there
    // is nobody left to tell.
  }
}

export class TunnelBackendAdapter implements BackendAdapter<TunnelTurnFrame, TunnelReply> {
  readonly metadata: AdapterMetadata = {
    name: 'tunnel',
    version: '1.0.0',
    provider: 'paired device',
    capabilities: CAPABILITIES,
  };

  readonly #options: TunnelBackendOptions;

  constructor(options: TunnelBackendOptions) {
    this.#options = options;
  }

  /** The Router registration this adapter answers to, and the one it settles. */
  get backendId(): string {
    return tunnelBackendId(this.#options.device.id);
  }

  /* ── Conversion ───────────────────────────────────────────────────── */

  /**
   * The `turn` frame for a request, with a new turn id.
   *
   * The codec's outbound policy is applied to the three escape hatches this app
   * writes, and a value JSON would change is refused here, naming its path,
   * rather than arriving altered (packages/tunnel/src/codec).
   */
  fromIR(request: IRChatRequest): TunnelTurnFrame {
    applyPolicy('metadata.custom', request.metadata.custom, FIELD_POLICY['metadata.custom'] ?? 'refuse');
    request.messages.forEach((message, index) => {
      if (message.metadata === undefined) return;
      applyPolicy(`messages[${index}].metadata`, message.metadata, FIELD_POLICY['messages.metadata'] ?? 'refuse');
    });
    if (request.parameters?.custom !== undefined) {
      applyPolicy('parameters.custom', request.parameters.custom, FIELD_POLICY['parameters.custom'] ?? 'refuse');
    }
    return { v: TUNNEL_WIRE_VERSION, kind: 'turn', turn: mintTurnId(), toolLoop: 'requester', body: request };
  }

  toIR(reply: TunnelReply, originalRequest: IRChatRequest, latencyMs: number): IRChatResponse {
    return {
      message: { role: 'assistant', content: reply.text },
      finishReason: reply.finishReason,
      ...(reply.usage ? { usage: reply.usage } : {}),
      metadata: {
        ...originalRequest.metadata,
        provenance: { ...originalRequest.metadata.provenance, backend: this.metadata.name },
        custom: { ...originalRequest.metadata.custom, latencyMs },
      },
    };
  }

  /* ── Execution ────────────────────────────────────────────────────── */

  async execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse> {
    const started = performance.now();
    let text = '';
    let finishReason: FinishReason = 'stop';
    let usage: IRUsage | undefined;
    for await (const chunk of this.executeStream(request, signal)) {
      if (chunk.type === 'content') text += chunk.delta;
      if (chunk.type === 'done') {
        finishReason = chunk.finishReason;
        usage = chunk.usage;
      }
      if (chunk.type === 'error') throw Object.assign(new Error(chunk.error.message), { code: chunk.error.code });
    }
    return this.toIR({ text, finishReason, ...(usage ? { usage } : {}) }, request, Math.round(performance.now() - started));
  }

  executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    return this.#stream(request, signal);
  }

  async *#stream(request: IRChatRequest, signal?: AbortSignal): IRChatStream {
    const { device, onWaiting } = this.#options;
    let sequence = 0;
    let text = '';
    /** The turn ended in a refusal that is the desktop answering. See the header. */
    let answered = false;
    let client: TunnelClient | null = null;

    const failed =(code: string, message = sentence(code, device.name)): IRStreamChunk => ({
      type: 'error',
      sequence: sequence++,
      error: { code, message },
    });
    const cancelled = (): IRStreamChunk => ({
      type: 'done',
      sequence: sequence++,
      finishReason: 'cancelled',
      message: { role: 'assistant', content: text },
    });

    yield { type: 'start', sequence: sequence++, metadata: request.metadata };

    let frame: TunnelTurnFrame;
    try {
      frame = this.fromIR(request);
    } catch (error) {
      yield failed('CODEC_REFUSED', error instanceof CodecRefusal ? error.message : sentence('SEND_FAILED', device.name));
      return;
    }

    const stop = whenStopped(signal);
    try {
      // STOPPED BEFORE IT BEGAN: nothing is opened and nothing is sent.
      if (signal?.aborted === true) {
        yield cancelled();
        return;
      }

      const connecting = this.#options.connect();
      let opened: TunnelClient | typeof STOPPED;
      try {
        opened = await Promise.race([connecting, stop.promise]);
      } catch {
        yield failed('PEER_UNREACHABLE');
        return;
      }
      if (opened === STOPPED) {
        // Stopped while connecting. A connection that opens late is closed unused.
        void connecting.then(
          (late) => late.close().catch(() => undefined),
          () => undefined,
        );
        yield cancelled();
        return;
      }
      client = opened;

      try {
        await client.send(frame);
      } catch {
        const close = client.ended();
        yield failed(close?.kind === 'abnormal' ? close.code : 'SEND_FAILED');
        return;
      }

      const frames = client.receive()[Symbol.asyncIterator]();
      /** A place in line was reported, so the reply's start is reported too. */
      let waited = false;
      /** Anything came back for this turn, so a FRAME_UNEXPECTED is about a later frame. */
      let heard = false;

      for (;;) {
        const next = await Promise.race([frames.next(), stop.promise]);

        if (next === STOPPED) {
          // STOP: one cancel, and the turn ends here. The desktop still finishes
          // its side; what it sends after this is not read.
          await sendIfOpen(client, { v: TUNNEL_WIRE_VERSION, kind: 'cancel', turn: frame.turn });
          yield cancelled();
          return;
        }

        if (next.done === true) {
          yield this.#endedWithoutTerminal(client.ended(), failed);
          return;
        }

        const incoming = next.value;
        switch (incoming.kind) {
          case 'waiting':
            if (incoming.turn !== frame.turn) break;
            heard = true;
            // Never after Stop, and nothing here checks for it: once Stop has
            // landed, the race above settles on it before any frame still queued.
            waited = true;
            onWaiting?.(incoming.body.position);
            break;

          case 'prompt':
            if (incoming.turn !== frame.turn) break;
            heard = true;
            await sendIfOpen(client, {
              v: TUNNEL_WIRE_VERSION,
              kind: 'answer',
              turn: frame.turn,
              prompt: incoming.prompt,
              body: { approved: false },
            });
            break;

          case 'chunk': {
            if (incoming.turn !== frame.turn) break;
            heard = true;
            const chunk = readChunk(incoming.body);
            if (chunk === null) {
              yield failed('CHUNK_INVALID');
              return;
            }
            if (chunk === 'no-message') {
              yield failed('SEQUENCE_BROKEN', faultMessage({ kind: 'terminal-without-message' }));
              return;
            }
            if (waited) {
              waited = false;
              onWaiting?.(0);
            }
            if (chunk.type === 'start') break;
            if (chunk.type === 'content') text += chunk.delta;
            yield { ...chunk, sequence: sequence++ };
            if (chunk.type === 'done' || chunk.type === 'error') return;
            break;
          }

          case 'error': {
            if (incoming.turn !== undefined && incoming.turn !== frame.turn) break;
            const { code } = incoming.body;
            const refusal = refusalOf(code);
            if (refusal.kind === 'unexpected') {
              // A report about one frame. Before anything came back, the only
              // frame this turn had sent was the turn itself, so the turn was
              // not read and nothing will come: end it rather than wait forever.
              if (incoming.turn === frame.turn && !heard) {
                yield failed(code);
                return;
              }
              break;
            }
            // PROMPT_EXPIRED closes a prompt, not the turn.
            if (!refusal.endsTurn) break;
            answered = ANSWERS.has(refusal.kind);
            yield failed(code);
            return;
          }

          default:
            break;
        }
      }
    } finally {
      stop.dispose();
      if (answered) this.#settleBreaker();
      if (client) await client.close().catch(() => undefined);
    }
  }

  /** The terminal for a tunnel that ended with no terminal chunk. */
  #endedWithoutTerminal(close: TunnelClose | null, failed: (code: string, message?: string) => IRStreamChunk): IRStreamChunk {
    if (close?.kind !== 'abnormal') return failed('PEER_CLOSED');
    // SEQUENCE_BROKEN's message is the stream check's own sentence, written by
    // this build (`faultMessage`); every other ending gets this file's.
    if (close.code === 'SEQUENCE_BROKEN' && close.message !== '') return failed(close.code, close.message);
    return failed(close.code);
  }

  /**
   * The desktop answered, so this registration's failure run ends, as a success
   * would end it. Only this adapter's own entry. See the header on why here.
   */
  #settleBreaker(): void {
    const { router } = this.#options;
    const id = this.backendId;
    if (router.getBackendInfo(id)?.adapter !== this) return;
    router.resetCircuitBreaker(id);
  }
}
