import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import {
  HOST_DESKTOP,
  HOST_SERVER,
  TypedEntryError,
  normalizeTypedCode,
  parseTypedEndpoint,
  type HostKind,
  type TypedEntryReason,
} from '@chatterang/tunnel/pairing';
import { Segmented, Sheet } from '@/ui/primitives';
import type { PairingController, PairingOutcome, PairingRequest } from '@/lib/pairing';
import {
  GENERIC_REFUSAL,
  HOST_KIND_PROMPT,
  REFUSAL_WORDING,
  TYPED_ENTRY_WORDING,
} from '@/features/pairing/wording';

/**
 * The pairing sheet: type a host and six digits, and hand one request to the
 * controller (#128, #130).
 *
 * REACHED ONLY THROUGH `PairingEntry`, which renders nothing while
 * `pairingController().available` is false — so on every build today this file
 * ships in a chunk nothing loads. It takes the controller as a prop rather than
 * asking the accessor, so the gate is read in exactly one place, and it imports
 * no store, so whatever it holds lives and dies with the sheet.
 *
 * NO `<form>`. A form around a host field and a code field is what password
 * managers offer to save, and a pairing code is a secret that is spent once.
 */

type HostChoice = 'desktop' | 'server';

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

  const [host, setHost] = useState('');
  const [code, setCode] = useState('');
  const [choice, setChoice] = useState<HostChoice | null>(null);
  const [problems, setProblems] = useState<Problems>(NO_PROBLEMS);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The request in flight, so closing can ask it to stop. */
  const inFlight = useRef<AbortController | null>(null);

  // Unmounting is closing too: navigating away from Settings must not leave a
  // request running that nobody asked to stop.
  useEffect(() => () => inFlight.current?.abort(), []);

  const close = (): void => {
    inFlight.current?.abort();
    onClose();
  };

  async function submit(): Promise<void> {
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
    const request: PairingRequest = {
      route: 'typed',
      address: endpoint.value.address,
      port: endpoint.value.port,
      code: digits.value,
      hostKind: HOST_KINDS[choice],
    };

    const abort = new AbortController();
    inFlight.current = abort;
    setBusy(true);
    let outcome: PairingOutcome | null;
    try {
      outcome = await controller.pair(request, abort.signal);
    } catch {
      outcome = null;
    }
    if (inFlight.current === abort) inFlight.current = null;

    if (outcome?.kind === 'paired') {
      // Surfaced whether or not the person already closed the sheet (D9).
      onOutcome(outcome);
      if (!abort.signal.aborted) onClose();
      return;
    }
    // A refusal after the person closed answers a question they withdrew.
    if (abort.signal.aborted) return;
    setBusy(false);
    // A reason the controller invents gets the generic sentence, not silence.
    setRefusal(outcome?.kind === 'refused' ? (REFUSAL_WORDING[outcome.reason] ?? GENERIC_REFUSAL) : GENERIC_REFUSAL);
  }

  const described = (hint: string, problem: unknown, error: string): string =>
    problem ? `${hint} ${error}` : hint;

  return (
    <Sheet open title="Pair with a computer" onClose={close}>
      <p className="section__hint">
        Typing a code is weaker than scanning one. A scanned code carries the computer's certificate
        fingerprint; six typed digits do not.
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

      {refusal ? (
        <p className="field__error" role="alert">
          {refusal}
        </p>
      ) : null}

      <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
        {busy ? 'Pairing…' : 'Pair'}
      </button>
    </Sheet>
  );
}
