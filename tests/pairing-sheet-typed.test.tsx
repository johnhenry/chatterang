/**
 * THE TYPE PANE, DRIVEN THROUGH A REAL DOM (#128, #130).
 *
 * The sheet is unreachable on every build — `PairingEntry` renders nothing
 * while `pairingController().available` is false — so these tests render it
 * directly against fake controllers. That is the only place its conduct can
 * be measured before a controller exists, and it is what the owner accepted
 * for building it now (D1).
 *
 * What is measured: the exact request a typed pairing sends, that nothing is
 * sent until every field is right and the host kind was CHOSEN, the words for
 * every refusal, that closing aborts without dropping a pairing that completed
 * anyway (D9), and that the typed secret goes nowhere but `pair()`.
 */

import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const persistence = vi.hoisted(() => ({
  blobsPut: vi.fn(async () => {}),
  putBlob: vi.fn(async () => {}),
  preferencesSet: vi.fn(async () => {}),
}));

// Every store a typed pairing could be written to, replaced by a spy. Nothing
// in the sheet imports them; the test proves that stays true in behaviour, and
// the paired control proves each spy would have seen a call.
vi.mock('@/db', () => ({ db: { blobs: { put: persistence.blobsPut } } }));
vi.mock('@/lib/blobs', () => ({ putBlob: persistence.putBlob }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { set: persistence.preferencesSet } }));

import {
  ADDRESS_DNS,
  ADDRESS_IPV4,
  HOST_DESKTOP,
  HOST_SERVER,
  TypedEntryError,
  normalizeTypedCode,
  parseTypedEndpoint,
  type TypedEntryReason,
} from '@chatterang/tunnel/pairing';
import type { PairingController, PairingOutcome, PairingRefusal, PairingRequest } from '@/lib/pairing';
import { PairingSheet } from '@/features/pairing/PairingSheet';
import {
  GENERIC_REFUSAL,
  HOST_KIND_PROMPT,
  REFUSAL_WORDING,
  TYPED_ENTRY_WORDING,
  hasDisguisingCharacter,
  pairedMessage,
} from '@/features/pairing/wording';

import {
  button,
  byLabel,
  click,
  dialog,
  errorFor,
  mustButton,
  reads,
  render,
  settle,
  typeInto,
  type Mounted,
} from './support/pairing-dom';

/* ── Fixtures ───────────────────────────────────────────────────────── */

type Paired = Extract<PairingOutcome, { kind: 'paired' }>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeController(answer: (request: PairingRequest, signal?: AbortSignal) => Promise<PairingOutcome>) {
  const pair = vi.fn(answer);
  const controller: PairingController = { available: true, pair };
  return { controller, pair };
}

/** The sheet as `PairingEntry` mounts it: gone from the tree once closed. */
function Harness(props: {
  controller: PairingController;
  onOutcome: (outcome: Paired) => void;
  onClose: () => void;
}): ReactNode {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <PairingSheet
      controller={props.controller}
      onOutcome={props.onOutcome}
      onClose={() => {
        props.onClose();
        setOpen(false);
      }}
    />
  );
}

const mounted: Mounted[] = [];

async function open(controller: PairingController) {
  const onOutcome = vi.fn<(outcome: Paired) => void>();
  const onClose = vi.fn();
  mounted.push(await render(<Harness controller={controller} onOutcome={onOutcome} onClose={onClose} />));
  expect(dialog(), 'the sheet opened').not.toBeNull();
  return { onOutcome, onClose, mount: mounted[mounted.length - 1]! };
}

const DESKTOP = 'Chatterang desktop app';
const SERVER = 'Chatterang server';

async function fill(fields: { host: string; code: string; kind?: typeof DESKTOP | typeof SERVER }) {
  await typeInto(byLabel('Computer address'), fields.host);
  await typeInto(byLabel('Six-digit code'), fields.code);
  if (fields.kind) await click(mustButton(fields.kind));
}

async function submit() {
  await click(mustButton('Pair'));
  await settle();
}

/** Which typed-route reason, if any, a parser gives for this text. */
function reasonOf(read: () => unknown): TypedEntryReason | null {
  try {
    read();
    return null;
  } catch (error) {
    if (error instanceof TypedEntryError) return error.reason;
    throw error;
  }
}

afterEach(async () => {
  for (const mount of mounted.splice(0)) await mount.unmount();
  vi.restoreAllMocks();
  persistence.blobsPut.mockClear();
  persistence.putBlob.mockClear();
  persistence.preferencesSet.mockClear();
});

/* ── The request ────────────────────────────────────────────────────── */

describe('the Type pane sends exactly what was typed', () => {
  it('builds the typed request byte for byte, with the code kept as text', async () => {
    const { controller, pair } = fakeController(async () => ({ kind: 'refused', reason: 'unreachable' }));
    await open(controller);
    await fill({ host: '192.168.1.4:51234', code: '012 345', kind: DESKTOP });
    await submit();

    expect(pair).toHaveBeenCalledTimes(1);
    const [request, signal] = pair.mock.calls[0]!;
    // A Number() anywhere on the path would make this '12345', a different secret.
    expect(request).toStrictEqual({
      route: 'typed',
      address: { kind: ADDRESS_IPV4, value: Uint8Array.of(192, 168, 1, 4) },
      port: 51234,
      code: '012345',
      hostKind: HOST_DESKTOP,
    });
    expect(Object.keys(request).sort()).toEqual(['address', 'code', 'hostKind', 'port', 'route']);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it('sends the server byte for a server, and dials the default port when none is typed', async () => {
    const { controller, pair } = fakeController(async () => ({ kind: 'refused', reason: 'unreachable' }));
    await open(controller);
    await fill({ host: 'chat.example.com', code: '999999', kind: SERVER });
    await submit();

    expect(pair).toHaveBeenCalledTimes(1);
    const request = pair.mock.calls[0]![0] as Extract<PairingRequest, { route: 'typed' }>;
    expect(request.hostKind).toBe(HOST_SERVER);
    expect(request.port).toBe(8973);
    expect(request.address.kind).toBe(ADDRESS_DNS);
    expect(String.fromCharCode(...request.address.value)).toBe('chat.example.com');
  });
});

/* ── Refusing before anything is sent ───────────────────────────────── */

describe('nothing is sent until every field is right', () => {
  it('has no host kind until the person chooses one, and will not guess', async () => {
    const { controller, pair } = fakeController(async () => ({ kind: 'refused', reason: 'unreachable' }));
    await open(controller);

    const kinds = [mustButton(DESKTOP), mustButton(SERVER)];
    expect(kinds.map((kind) => kind.getAttribute('aria-pressed'))).toEqual(['false', 'false']);

    await fill({ host: '192.168.1.4:51234', code: '123456' });
    await submit();
    expect(pair).not.toHaveBeenCalled();
    const prompts = [...document.querySelectorAll('.field__error')].map((node) => reads(node));
    expect(prompts).toEqual([HOST_KIND_PROMPT]);

    // The paired control: the same fields with a choice made are sent.
    await click(mustButton(DESKTOP));
    expect(mustButton(DESKTOP).getAttribute('aria-pressed')).toBe('true');
    await submit();
    expect(pair).toHaveBeenCalledTimes(1);
    const after = [...document.querySelectorAll('.field__error')].map((node) => reads(node));
    expect(after).not.toContain(HOST_KIND_PROMPT);
  });

  it('keeps the code out of form autofill and keyboard learning', async () => {
    const { controller } = fakeController(async () => ({ kind: 'refused', reason: 'unreachable' }));
    await open(controller);
    const host = byLabel('Computer address');
    const code = byLabel('Six-digit code');
    // No <form>: a host field beside a secret field is what password managers offer to save.
    expect(host.closest('form')).toBeNull();
    expect(document.querySelector('[role="dialog"] form')).toBeNull();
    for (const input of [host, code]) {
      expect(input.getAttribute('autocomplete'), input.id).toBe('off');
      expect(input.getAttribute('autocorrect'), input.id).toBe('off');
      expect(input.getAttribute('autocapitalize'), input.id).toBe('none');
      expect(input.getAttribute('spellcheck'), input.id).toBe('false');
      expect(input.type, input.id).toBe('text');
    }
    expect(host.getAttribute('inputmode')).toBe('url');
    expect(code.getAttribute('inputmode')).toBe('numeric');
  });

  it('names every reason a typed address or code is refused, each in its own words, and sends nothing', async () => {
    const hosts: readonly (readonly [string, TypedEntryReason])[] = [
      ['', 'empty'],
      ['999.1.1.1', 'bad-ipv4'],
      ['[fe80::zz]', 'bad-ipv6'],
      ['bad_name!', 'bad-dns-name'],
      ['host:99999', 'bad-port'],
      ['desk.local', 'local-name-unreachable'],
      ['fe80::1%en0', 'zone-index-unsupported'],
    ];
    const codes: readonly (readonly [string, TypedEntryReason])[] = [['12a456', 'bad-code']];

    // Each input really yields its reason, so a wording failure below is the
    // sheet's and not a fixture that stopped meaning what it says.
    for (const [text, reason] of hosts) expect(reasonOf(() => parseTypedEndpoint(text)), text).toBe(reason);
    for (const [text, reason] of codes) expect(reasonOf(() => normalizeTypedCode(text)), text).toBe(reason);

    const covered = [...hosts, ...codes].map(([, reason]) => reason).sort();
    expect(covered).toEqual(Object.keys(TYPED_ENTRY_WORDING).sort());
    const wordings = Object.values(TYPED_ENTRY_WORDING);
    expect(new Set(wordings).size, 'two reasons share a sentence').toBe(wordings.length);

    for (const [text, reason] of hosts) {
      const { controller, pair } = fakeController(async () => ({ kind: 'refused', reason: 'unreachable' }));
      const { mount } = await open(controller);
      await fill({ host: text, code: '123456', kind: DESKTOP });
      expect(errorFor(byLabel('Computer address')), 'shown before submit').toBeNull();
      await submit();
      expect(errorFor(byLabel('Computer address')), text).toBe(TYPED_ENTRY_WORDING[reason]);
      expect(byLabel('Computer address').getAttribute('aria-invalid')).toBe('true');
      expect(errorFor(byLabel('Six-digit code')), text).toBeNull();
      expect(pair, text).not.toHaveBeenCalled();
      await mount.unmount();
    }

    for (const [text, reason] of codes) {
      const { controller, pair } = fakeController(async () => ({ kind: 'refused', reason: 'unreachable' }));
      const { mount } = await open(controller);
      await fill({ host: '192.168.1.4:51234', code: text, kind: DESKTOP });
      await submit();
      expect(errorFor(byLabel('Six-digit code')), text).toBe(TYPED_ENTRY_WORDING[reason]);
      expect(errorFor(byLabel('Computer address')), text).toBeNull();
      expect(pair, text).not.toHaveBeenCalled();
      await mount.unmount();
    }
  });
});

/* ── What the controller answers ────────────────────────────────────── */

describe('what the controller answers', () => {
  const REFUSALS = {
    'pin-mismatch': true,
    'confirmation-failed': true,
    expired: true,
    unreachable: true,
    exhausted: true,
    'unsupported-trust-mode': true,
    'transport-unavailable': true,
  } satisfies Record<PairingRefusal, true>;

  it('says each refusal in its own words, keeps the sheet open, and never says paired', async () => {
    const reasons = Object.keys(REFUSALS) as PairingRefusal[];
    const wordings = reasons.map((reason) => REFUSAL_WORDING[reason]);
    expect(new Set(wordings).size, 'two refusals share a sentence').toBe(reasons.length);

    for (const reason of reasons) {
      const { controller } = fakeController(async () => ({ kind: 'refused', reason }));
      const { mount, onOutcome, onClose } = await open(controller);
      await fill({ host: '192.168.1.4:51234', code: '123456', kind: DESKTOP });
      await submit();
      expect(reads(document.querySelector('[role="alert"]')), reason).toBe(REFUSAL_WORDING[reason]);
      expect(dialog(), reason).not.toBeNull();
      expect(reads(document.body), reason).not.toMatch(/\bpaired\b/i);
      expect(onOutcome).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      // Pressable again: a refusal is an answer, not a stuck request.
      expect(mustButton('Pair').disabled).toBe(false);
      await mount.unmount();
    }
  });

  it('treats a pair() that throws as a refusal with no reason, never as success', async () => {
    const { controller } = fakeController(async () => {
      throw new Error('socket closed');
    });
    const { onOutcome, onClose } = await open(controller);
    await fill({ host: '192.168.1.4:51234', code: '123456', kind: DESKTOP });
    await submit();
    expect(reads(document.querySelector('[role="alert"]'))).toBe(GENERIC_REFUSAL);
    expect(onOutcome).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it('refuses an answer that is not an outcome, and a refusal reason it has no words for', async () => {
    for (const answer of [
      { kind: 'bogus' },
      { kind: 'refused', reason: 'made-up' },
      // Names every object inherits. A lookup that reads the prototype finds a
      // function or an object there, not words, and React cannot render either.
      { kind: 'refused', reason: 'constructor' },
      { kind: 'refused', reason: '__proto__' },
      { kind: 'refused', reason: 'toString' },
      undefined,
    ]) {
      const { controller } = fakeController(async () => answer as unknown as PairingOutcome);
      const { mount, onOutcome } = await open(controller);
      await fill({ host: '192.168.1.4:51234', code: '123456', kind: DESKTOP });
      await submit();
      expect(reads(document.querySelector('[role="alert"]')), JSON.stringify(answer)).toBe(GENERIC_REFUSAL);
      expect(onOutcome).not.toHaveBeenCalled();
      await mount.unmount();
    }
  });

  it('hands a completed pairing up once and closes', async () => {
    const { controller } = fakeController(async () => ({ kind: 'paired', deviceName: 'Desk' }));
    const { onOutcome, onClose } = await open(controller);
    await fill({ host: '192.168.1.4:51234', code: '123456', kind: DESKTOP });
    await submit();
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith({ kind: 'paired', deviceName: 'Desk' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('closes before handing the pairing up, so nothing done with the news can leave the sheet up and busy', async () => {
    const { controller } = fakeController(async () => ({ kind: 'paired', deviceName: 'Desk' }));
    const { onOutcome, onClose } = await open(controller);
    await fill({ host: '192.168.1.4:51234', code: '123456', kind: DESKTOP });
    await submit();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]!).toBeLessThan(onOutcome.mock.invocationCallOrder[0]!);
  });

  it('reports a paired answer whose name is not text as paired, with no name', async () => {
    // Treating it as a refusal would say "did not finish" about a pairing the
    // controller says the host holds, which is the failure D9 exists to avoid.
    for (const answer of [{ kind: 'paired' }, { kind: 'paired', deviceName: 42 }, { kind: 'paired', deviceName: null }]) {
      const { controller } = fakeController(async () => answer as unknown as PairingOutcome);
      const { mount, onOutcome, onClose } = await open(controller);
      await fill({ host: '192.168.1.4:51234', code: '123456', kind: DESKTOP });
      await submit();
      expect(onOutcome, JSON.stringify(answer)).toHaveBeenCalledTimes(1);
      expect(onOutcome, JSON.stringify(answer)).toHaveBeenCalledWith({ kind: 'paired', deviceName: '' });
      expect(onClose, JSON.stringify(answer)).toHaveBeenCalledTimes(1);
      expect(dialog(), JSON.stringify(answer)).toBeNull();
      await mount.unmount();
    }
  });

  it('does not send twice while a pairing is in flight', async () => {
    const pending = deferred<PairingOutcome>();
    const { controller, pair } = fakeController(() => pending.promise);
    await open(controller);
    await fill({ host: '192.168.1.4:51234', code: '123456', kind: DESKTOP });
    await click(mustButton('Pair'));
    expect(button('Pair')).toBeNull();
    const busy = mustButton('Pairing…');
    expect(busy.disabled).toBe(true);
    await click(busy);
    expect(pair).toHaveBeenCalledTimes(1);
    pending.resolve({ kind: 'refused', reason: 'unreachable' });
    await settle();
  });
});

/* ── Closing mid-pairing (D9) ───────────────────────────────────────── */

describe('closing is a request to stop, not a rollback (D9)', () => {
  async function pendingPairing() {
    const pending = deferred<PairingOutcome>();
    const { controller, pair } = fakeController(() => pending.promise);
    const sheet = await open(controller);
    await fill({ host: '192.168.1.4:51234', code: '123456', kind: DESKTOP });
    await click(mustButton('Pair'));
    expect(pair).toHaveBeenCalledTimes(1);
    const signal = pair.mock.calls[0]![1]!;
    expect(signal.aborted).toBe(false);
    return { ...sheet, pending, signal };
  }

  it('aborts the signal pair() was given when the person closes the sheet', async () => {
    const { pending, signal, onClose } = await pendingPairing();
    await click(mustButton('Close'));
    expect(signal.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    pending.resolve({ kind: 'refused', reason: 'unreachable' });
    await settle();
  });

  it('aborts it when the sheet is unmounted without closing, too', async () => {
    const { pending, signal, mount, onClose } = await pendingPairing();
    await mount.unmount();
    expect(signal.aborted).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    pending.resolve({ kind: 'refused', reason: 'unreachable' });
    await settle();
  });

  it('still hands up a pairing that completes after the sheet closed, exactly once', async () => {
    const { pending, onOutcome, onClose } = await pendingPairing();
    await click(mustButton('Close'));
    expect(dialog()).toBeNull();
    expect(onOutcome).not.toHaveBeenCalled();

    pending.resolve({ kind: 'paired', deviceName: 'Desk' });
    await settle();
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith({ kind: 'paired', deviceName: 'Desk' });
    expect(onClose, 'closed once, by the person — not again by the late answer').toHaveBeenCalledTimes(1);
  });

  it('aborts on close even when the parent keeps the sheet mounted, and then shows no late refusal', async () => {
    // Not how PairingEntry mounts it, and that is the point: the sheet's own
    // close must ask the request to stop, rather than relying on a parent that
    // happens to unmount it.
    const pending = deferred<PairingOutcome>();
    const { controller, pair } = fakeController(() => pending.promise);
    const onClose = vi.fn();
    const onOutcome = vi.fn();
    mounted.push(await render(<PairingSheet controller={controller} onClose={onClose} onOutcome={onOutcome} />));
    await fill({ host: '192.168.1.4:51234', code: '123456', kind: DESKTOP });
    await click(mustButton('Pair'));
    const signal = pair.mock.calls[0]![1]!;

    await click(mustButton('Close'));
    expect(signal.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);

    pending.resolve({ kind: 'refused', reason: 'unreachable' });
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(onOutcome).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says nothing and calls nothing for a refusal that arrives after the person closed', async () => {
    const { pending, onOutcome, onClose } = await pendingPairing();
    await click(mustButton('Close'));
    pending.resolve({ kind: 'refused', reason: 'confirmation-failed' });
    await settle();
    expect(onOutcome).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

/* ── The secret ─────────────────────────────────────────────────────── */

describe('a typed pairing persists nothing', () => {
  it('writes the code and host to no store, no request and no log — only pair()', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    const { controller, pair } = fakeController(async () => ({ kind: 'paired', deviceName: 'Desk' }));
    await open(controller);
    await fill({ host: '192.168.1.4:51234', code: '012 345', kind: DESKTOP });
    await submit();

    expect(pair).toHaveBeenCalledTimes(1);
    expect((pair.mock.calls[0]![0] as { code: string }).code).toBe('012345');
    expect(setItem).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(persistence.blobsPut).not.toHaveBeenCalled();
    expect(persistence.putBlob).not.toHaveBeenCalled();
    expect(persistence.preferencesSet).not.toHaveBeenCalled();
    const logged = consoles.flatMap((spy) => spy.mock.calls.flat()).map((arg) => {
      try {
        return typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    });
    for (const secret of ['012345', '012 345', '192.168.1.4']) {
      expect(logged.filter((line) => line.includes(secret)), secret).toEqual([]);
    }

    // The paired control: every spy above sees a call made directly, so each
    // zero is a measurement and not a spy that was never wired.
    localStorage.setItem('control', '1');
    sessionStorage.setItem('control', '1');
    expect(setItem).toHaveBeenCalledTimes(2);
    localStorage.removeItem('control');
    sessionStorage.removeItem('control');
    fetchSpy.mockResolvedValueOnce(new Response(''));
    await fetch('https://example.com/control');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const { db } = (await import('@/db')) as unknown as { db: { blobs: { put: (row: unknown) => Promise<void> } } };
    await db.blobs.put({});
    expect(persistence.blobsPut).toHaveBeenCalledTimes(1);
    const { putBlob } = await import('@/lib/blobs');
    await putBlob('control', new Blob());
    expect(persistence.putBlob).toHaveBeenCalledTimes(1);
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: 'control', value: '1' });
    expect(persistence.preferencesSet).toHaveBeenCalledTimes(1);
    console.log('control 012345');
    expect(consoles[0]!.mock.calls.flat()).toContain('control 012345');
  });
});

/* ── The host's name (D5, D11) ──────────────────────────────────────── */

describe('a name the host wrote', () => {
  it('is quoted as the name the machine gave, not asserted', () => {
    expect(pairedMessage('Desk')).toBe('Paired with “Desk”.');
    for (const plain of ['John’s MacBook', 'Büro', '桌面', 'desk\u00a0one', 'a\u200db']) {
      expect(hasDisguisingCharacter(plain), JSON.stringify(plain)).toBe(false);
      expect(pairedMessage(plain)).toBe(`Paired with “${plain}”.`);
    }
  });

  it('is not shown when it holds a control or bidi-reordering character, and the pairing is still reported', () => {
    const disguising = [
      '\u0000', '\u0007', '\u001b', '\u001f', '\u007f', '\u0080', '\u0085', '\u009f',
      '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069',
    ];
    for (const ch of disguising) {
      const name = `koob${ch}cam`;
      expect(hasDisguisingCharacter(name), `U+${ch.codePointAt(0)!.toString(16)}`).toBe(true);
      const message = pairedMessage(name);
      expect(message.startsWith('Paired.'), message).toBe(true);
      expect(message).not.toContain('koob');
    }
    // The edges of each range are outside it.
    for (const ch of ['\u0020', '\u00a0', '\u2029', '\u202f', '\u2065', '\u206a']) {
      expect(hasDisguisingCharacter(`a${ch}b`), `U+${ch.codePointAt(0)!.toString(16)}`).toBe(false);
    }
    expect(pairedMessage(`koob${String.fromCharCode(0x202e)}cam`)).toBe(
      'Paired. The other machine’s name is not shown, because it contains characters that can disguise text.',
    );
    // A tab is blank AND a control character; the sentence about controls is the true one.
    expect(pairedMessage(String.fromCharCode(9))).toBe(
      'Paired. The other machine’s name is not shown, because it contains characters that can disguise text.',
    );
  });

  it('says a blank name is blank, not that it hides something', () => {
    // Nothing in '' or a run of spaces can disguise text, so the reason given
    // for showing no name is that there is none.
    for (const blank of ['', ' ', '   ', String.fromCharCode(0xa0)]) {
      expect(hasDisguisingCharacter(blank), JSON.stringify(blank)).toBe(false);
      expect(pairedMessage(blank), JSON.stringify(blank)).toBe('Paired. The other machine gave no name.');
    }
  });
});
