import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { Confirm, Sheet } from '@/ui/primitives';
import { hasFinePointer } from '@/lib/platform';
import { commandFor } from '@/lib/keys';
import { ChatterangShell, type ShellResult } from '@/shell';
import { liveStores } from '@/shell/stores';

/**
 * The shell, for the person holding the phone.
 *
 * Same instance the model drives through the `bash` tool, so what you see here
 * is exactly what it can do — which is the point of having one surface rather
 * than two.
 */

interface Entry {
  readonly id: number;
  readonly command: string;
  readonly result: ShellResult | null;
}

const EXAMPLES = [
  'chatterang',
  'model list',
  'grep -ril "quantisation" /chats',
  'jq -r ".capabilities[]" /models/*.json | sort | uniq -c',
  'privacy',
];

export function ShellSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(false);
  const [pending, setPending] = useState<{ action: string; resolve: (ok: boolean) => void } | null>(
    null,
  );

  const shell = useRef<ChatterangShell | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const history = useRef<string[]>([]);
  const historyAt = useRef(-1);
  const nextId = useRef(0);
  // `run` is useCallback([]) so it cannot read `busy` from state. This is the
  // re-entrancy guard that `disabled` used to provide.
  const busyRef = useRef(false);

  // The shell — and the ~355 kB of `just-bash` behind it — is built on first
  // open, never at startup.
  useEffect(() => {
    if (!open || shell.current) return;

    shell.current = new ChatterangShell({
      stores: liveStores(),
      actor: 'user',
      confirm: (action) => new Promise<boolean>((resolve) => setPending({ action, resolve })),
    });

    setBooting(true);
    void shell.current
      .ready()
      .catch(() => undefined)
      .finally(() => setBooting(false));
  }, [open]);

  // Opening the terminal puts the caret in the prompt — every time, not only
  // the first. The boot effect above early-returns on reopen, so this cannot
  // live there. `Sheet` is a child, and React runs child effects first, so its
  // focus-the-first-button fallback lands and this overrides it in the same
  // commit. A readOnly field is still focusable, so `booting` does not block.
  useEffect(() => {
    if (!open) return;
    field.current?.focus();
  }, [open]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries, busy]);

  const run = useCallback(async (commandLine: string) => {
    const trimmed = commandLine.trim();
    if (!trimmed || !shell.current || busyRef.current) return;

    if (trimmed === 'clear') {
      setEntries([]);
      setInput('');
      return;
    }

    history.current = [trimmed, ...history.current.filter((h) => h !== trimmed)].slice(0, 50);
    historyAt.current = -1;

    const id = nextId.current++;
    setEntries((current) => [...current, { id, command: trimmed, result: null }]);
    setInput('');
    busyRef.current = true;
    setBusy(true);

    // Re-project app state before each command, so the filesystem reflects
    // anything that changed since the shell was opened.
    await shell.current.mount().catch(() => undefined);
    const result = await shell.current.exec(trimmed);

    setEntries((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, result } : entry)),
    );
    busyRef.current = false;
    setBusy(false);
  }, []);

  return (
    <>
      <Sheet open={open} title="Shell" onClose={onClose}>
        <p className="section__hint">
          A sandbox over this app’s own data — not your device, and with no network access. The
          model reaches the same commands through its <code>bash</code> tool.
        </p>

        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          className="term"
          ref={scroller}
          onMouseUp={() => {
            // Desktop convention only. On touch it inverts: tapping the
            // transcript is how you dismiss the keyboard, and WebKit
            // synthesises mouseup on tap, so this would re-summon it.
            if (!hasFinePointer()) return;
            // Do not steal focus mid-selection: a user dragging to copy output
            // is not asking to type.
            if ((window.getSelection()?.toString().length ?? 0) > 0) return;
            field.current?.focus();
          }}
        >
          {entries.length === 0 && !booting ? (
            <div className="term__hint">
              <span className="label">Try</span>
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="term__example"
                  onClick={() => void run(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          ) : null}

          {booting ? <div className="term__meta">starting shell…</div> : null}

          {entries.map((entry) => (
            <div className="term__entry" key={entry.id}>
              <div className="term__command">
                <span className="term__prompt">$</span>
                {entry.command}
              </div>

              {entry.result === null ? (
                <div className="term__meta">
                  <span className="spinner" /> running
                </div>
              ) : (
                <>
                  {entry.result.stdout ? (
                    <pre className="term__out">{entry.result.stdout.replace(/\n+$/, '')}</pre>
                  ) : null}
                  {entry.result.stderr ? (
                    <pre className="term__out term__out--err">
                      {entry.result.stderr.replace(/\n+$/, '')}
                    </pre>
                  ) : null}
                  <div className="term__meta">
                    {entry.result.exitCode === 0 ? (
                      <span style={{ color: 'var(--good)' }}>ok</span>
                    ) : (
                      <span style={{ color: 'var(--crit)' }}>exit {entry.result.exitCode}</span>
                    )}
                    <span>· {entry.result.durationMs}ms</span>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <form
          className="term__input"
          onSubmit={(event) => {
            event.preventDefault();
            void run(input);
          }}
        >
          <span className="term__prompt">$</span>
          <input
            ref={field}
            className="term__field"
            value={input}
            readOnly={busy || booting}
            aria-disabled={busy || booting}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            // A terminal is not a form field: stop the browser offering saved
            // values, and label the on-screen return key "go" rather than
            // "return" so the phone keyboard reads like a prompt.
            autoComplete="off"
            enterKeyHint="go"
            placeholder={booting ? 'starting…' : 'chatterang'}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // Shell history, because retyping a pipeline on a phone is
              // punishing. The chords are field-scoped entries in the same
              // table as everything else — a bare arrow key is ordinary
              // navigation in every other field, so the window listener must
              // not claim it, and this field asks what the event means rather
              // than naming the key itself.
              const command = commandFor(event);
              if (command === 'terminal.historyPrev') {
                event.preventDefault();
                const next = Math.min(historyAt.current + 1, history.current.length - 1);
                if (next >= 0) {
                  historyAt.current = next;
                  setInput(history.current[next] ?? '');
                }
              } else if (command === 'terminal.historyNext') {
                event.preventDefault();
                const next = historyAt.current - 1;
                historyAt.current = Math.max(next, -1);
                setInput(next >= 0 ? (history.current[next] ?? '') : '');
              }
            }}
          />
          <button
            type="submit"
            className="icon-btn"
            // Keep the caret in the prompt when Run is clicked with a mouse.
            onMouseDown={(event) => event.preventDefault()}
            disabled={busy || booting || !input.trim()}
            aria-label="Run"
          >
            <Icon name="send" size={16} />
          </button>
        </form>
      </Sheet>

      <Confirm
        open={pending !== null}
        title="Confirm"
        body={pending ? `This will ${pending.action}.` : ''}
        confirmLabel="Allow"
        onCancel={() => {
          pending?.resolve(false);
          setPending(null);
        }}
        onConfirm={() => {
          pending?.resolve(true);
          setPending(null);
        }}
      />
    </>
  );
}
