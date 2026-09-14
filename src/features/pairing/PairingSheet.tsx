import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import {
  HOST_DESKTOP,
  HOST_SERVER,
  TypedEntryError,
  normalizeTypedCode,
  parseTypedEndpoint,
  type HostKind,
  type PairingPayload,
  type TypedEntryReason,
} from '@chatterang/tunnel/pairing';
import { Confirm, Segmented, Sheet } from '@/ui/primitives';
import { capabilities } from '@/lib/platform';
import {
  validateScannedPayload,
  type PairingController,
  type PairingOutcome,
  type PairingRequest,
} from '@/lib/pairing';
import { ScanPane } from '@/features/pairing/ScanPane';
import {
  CAMERA_UNAVAILABLE,
  CONFIRM_BODY,
  CONFIRM_TITLE,
  GENERIC_REFUSAL,
  HOST_KIND_PROMPT,
  REFUSAL_WORDING,
  SCANNED_PROBLEM_WORDING,
  SCAN_END_WORDING,
  TYPED_ENTRY_WORDING,
  confirmDetail,
  hasDisguisingCharacter,
} from '@/features/pairing/wording';

/**
 * The pairing sheet: scan a code or type one, and hand one request to the
 * controller (#128, #130).
 *
 * REACHED ONLY THROUGH `PairingEntry`, which renders nothing while
 * `pairingController().available` is false — so on every build today this file
 * ships in a chunk nothing loads. It takes the controller as a prop rather than
 * asking the accessor, so the gate is read in exactly one place, and it imports
 * no store, so whatever it holds lives and dies with the sheet.
 *
 * TWO PANES, AND IT OPENS ON TYPE (D4, and the owner's ruling on #124 after
 * it). Scan is offered only where the platform row says a camera can scan, one
 * segment away, and it asks for the camera only when the person presses "Scan
 * with camera". The sheet opens on Type even then, so the admission that typing
 * is weaker is on screen from the start. Where no camera row exists there is
 * no Scan segment and no text about a camera.
 *
 * A SCANNED CODE IS CHECKED, THEN ATTRIBUTED (D11). `validateScannedPayload`
 * refuses it before any confirm step, and Confirm quotes the name as the one
 * the code gives, rather than stating who the machine is. The parser admits
 * any well-formed UTF-8, so a name that can disguise itself is refused as an
 * unreadable code.
 *
 * NO `<form>`. A form around a host field and a code field is what password
 * managers offer to save, and a pairing code is a secret that is spent once.
 */

type HostChoice = 'desktop' | 'server';
type Pane = 'scan' | 'type';

/** The person's choice, mapped to the byte the binding carries. There is no default. */
const HOST_KINDS: Readonly<Record<HostChoice, HostKind>> = Object.freeze({
  desktop: HOST_DESKTOP,
  server: HOST_SERVER,
});

export interface PairingSheetProps {
  readonly controller: PairingController;
  readonly onClose: () => void;
  /**
   * A pairing that COMPLETED, whether or not the sheet is still open.
   *
   * Called after close as well (D9): closing aborts the request, but abort is
   * a request and not a rollback, so a controller may still answer "paired".
   * Dropping that answer would leave the host holding a pairing the phone never
   * mentioned, which fails open.
   */
  readonly onOutcome: (outcome: Extract<PairingOutcome, { kind: 'paired' }>) => void;
}

interface Problems {
  readonly host: TypedEntryReason | null;
  readonly code: TypedEntryReason | null;
  readonly hostKind: boolean;
}

const NO_PROBLEMS: Problems = { host: null, code: null, hostKind: false };

/** Run a typed-route parser, naming its refusal. Anything else it throws still throws. */
function attempt<T>(read: () => T): { ok: true; value: T } | { ok: false; reason: TypedEntryReason } {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof TypedEntryError) return { ok: false, reason: error.reason };
    throw error;
  }
}

export function PairingSheet({ controller, onClose, onOutcome }: PairingSheetProps): ReactNode {
  const hostId = useId();
  const codeId = useId();
  const kindId = useId();

  // A platform row, read once: it does not change while the sheet is open.
  const [cameraScan] = useState(() => capabilities().cameraScan);
  // Type first, camera row or not (#124): the admission that typing is weaker
  // is read before the person picks a route, not only by someone who went
  // looking for Type.
  const [pane, setPane] = useState<Pane>('type');
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PairingPayload | null>(null);

  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [choice, setChoice] = useState<HostChoice | null>(null);
  const [problems, setProblems] = useState<Problems>(NO_PROBLEMS);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);

  /** The request in flight, so closing can ask it to stop. */
  const inFlight = useRef<AbortController | null>(null);

  // Unmounting is closing too: navigating away from Settings must not leave a
  // request running that nobody asked to stop.
  useEffect(() => () => inFlight.current?.abort(), []);

  /**
   * Closing is closing, whatever the parent does next: the request is asked to
   * stop, and the sheet — the camera with it — leaves the screen even if the
   * parent keeps this component mounted.
   */
  const close = (): void => {
    inFlight.current?.abort();
    setClosed(true);
    onClose();
  };

  async function run(request: PairingRequest): Promise<void> {
    const abort = new AbortController();
    inFlight.current = abort;
    setRefusal(null);
    setBusy(true);
    let outcome: PairingOutcome | null;
    try {
      outcome = await controller.pair(request, abort.signal);
    } catch {
      outcome = null;
    }
    if (inFlight.current === abort) inFlight.current = null;

    if (outcome?.kind === 'paired') {
      // Closed first, so nothing the parent does with the news can leave the
      // sheet on screen and busy.
      if (!abort.signal.aborted) {
        setClosed(true);
        onClose();
      }
      // Surfaced whether or not the person already closed the sheet (D9). A
      // name that is not text is handed up as no name: the controller says the
      // host holds a pairing, and that is reported either way.
      onOutcome({ kind: 'paired', deviceName: typeof outcome.deviceName === 'string' ? outcome.deviceName : '' });
      return;
    }
    // A refusal after the person closed answers a question they withdrew.
    if (abort.signal.aborted) return;
    setBusy(false);
    // A reason the controller invents gets the generic sentence, not silence.
    // Own keys only: `constructor` or `__proto__` would otherwise find what
    // every object inherits, which is not a sentence.
    const reason = outcome?.kind === 'refused' ? outcome.reason : null;
    setRefusal(reason !== null && Object.hasOwn(REFUSAL_WORDING, reason) ? REFUSAL_WORDING[reason] : GENERIC_REFUSAL);
  }

  async function submitTyped(): Promise<void> {
    // Every field is checked on every submit, so the person sees all of what
    // is wrong at once rather than one refusal per press.
    const endpoint = attempt(() => parseTypedEndpoint(host));
    const digits = attempt(() => normalizeTypedCode(code));
    setProblems({
      host: endpoint.ok ? null : endpoint.reason,
      code: digits.ok ? null : digits.reason,
      hostKind: choice === null,
    });
    setRefusal(null);
    if (!endpoint.ok || !digits.ok || choice === null) return;

    // Exactly the typed shape. No trust field exists to fill: six typed digits
    // carry no fingerprint, which is what the Type pane admits.
    await run({
      route: 'typed',
      address: endpoint.value.address,
      port: endpoint.value.port,
      code: digits.value,
      hostKind: HOST_KINDS[choice],
    });
  }

  /** A scanned payload, the camera already off: refuse it here, or ask the person. */
  function scanned(payload: PairingPayload): string | null {
    const checked = validateScannedPayload(payload, Math.floor(Date.now() / 1000));
    if (!checked.ok) return SCANNED_PROBLEM_WORDING[checked.problem];
    // A name that can reorder or hide what is drawn around it cannot be
    // attributed honestly, so the code is refused as unreadable (D11).
    if (hasDisguisingCharacter(payload.name)) return SCAN_END_WORDING['invalid-code'];
    setRefusal(null);
    setConfirming(payload);
    return null;
  }

  const described = (hint: string, problem: unknown, error: string): string =>
    problem ? `${hint} ${error}` : hint;

  if (closed) return null;

  return (
    <>
      <Sheet open title="Pair with a computer" onClose={close}>
        {cameraScan ? (
          <Segmented<Pane>
            label="How to pair"
            value={pane}
            options={[
              { value: 'scan', label: 'Scan' },
              { value: 'type', label: 'Type' },
            ]}
            onChange={(next) => {
              setNotice(null);
              setPane(next);
            }}
          />
        ) : null}

        {pane === 'scan' ? (
          <ScanPane
            busy={busy}
            onResult={scanned}
            onUnavailable={() => {
              setNotice(CAMERA_UNAVAILABLE);
              setPane('type');
            }}
          />
        ) : (
          <>
            {notice ? (
              <p className="section__hint" role="status">
                {notice}
              </p>
            ) : null}

            <p className="section__hint">
              Typing a code is weaker than scanning one. A scanned code carries the computer's
              certificate fingerprint; six typed digits do not.
            </p>

            <div className="field">
              <label className="field__label" htmlFor={hostId}>
                Computer address
              </label>
              <input
                id={hostId}
                className="input"
                value={host}
                placeholder="192.168.1.4:51234"
                inputMode="url"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                aria-invalid={problems.host !== null}
                aria-describedby={described(`${hostId}-hint`, problems.host, `${hostId}-error`)}
                onChange={(event) => setHost(event.target.value)}
              />
              <span className="field__hint" id={`${hostId}-hint`}>
                The address the other screen shows. For the desktop app, include the port after a colon.
              </span>
              {problems.host ? (
                <p className="field__error" id={`${hostId}-error`}>
                  {TYPED_ENTRY_WORDING[problems.host]}
                </p>
              ) : null}
            </div>

            <div className="field">
              <span className="field__label" id={kindId}>
                Pairing with
              </span>
              <Segmented<HostChoice | ''>
                label="Pairing with"
                value={choice ?? ''}
                options={[
                  { value: 'desktop', label: 'Chatterang desktop app' },
                  { value: 'server', label: 'Chatterang server' },
                ]}
                onChange={(next) => setChoice(next === '' ? null : next)}
              />
              {problems.hostKind ? (
                <p className="field__error" id={`${kindId}-error`}>
                  {HOST_KIND_PROMPT}
                </p>
              ) : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor={codeId}>
                Six-digit code
              </label>
              <input
                id={codeId}
                className="input"
                value={code}
                placeholder="123 456"
                inputMode="numeric"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                aria-invalid={problems.code !== null}
                aria-describedby={problems.code ? `${codeId}-error` : undefined}
                onChange={(event) => setCode(event.target.value)}
              />
              {problems.code ? (
                <p className="field__error" id={`${codeId}-error`}>
                  {TYPED_ENTRY_WORDING[problems.code]}
                </p>
              ) : null}
            </div>

            <button type="button" className="btn" disabled={busy} onClick={() => void submitTyped()}>
              {busy ? 'Pairing…' : 'Pair'}
            </button>
          </>
        )}

        {refusal ? (
          <p className="field__error" role="alert">
            {refusal}
          </p>
        ) : null}
      </Sheet>

      <Confirm
        open={confirming !== null}
        title={CONFIRM_TITLE}
        body={CONFIRM_BODY}
        detail={confirming ? confirmDetail(confirming.name) : undefined}
        confirmLabel="Pair"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const payload = confirming;
          setConfirming(null);
          // The payload exactly as it was read. Nothing from the camera rides along.
          if (payload !== null) void run({ route: 'scanned', payload });
        }}
      />
    </>
  );
}
