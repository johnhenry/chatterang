import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { Confirm, Sheet } from '@/ui/primitives';
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
      .finally(() => {
        setBooting(false);
        field.current?.focus();
      });
  }, [open]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [entries, busy]);

  const run = useCallback(async (commandLine: string) => {
    const trimmed = commandLine.trim();
    if (!trimmed || !shell.current) return;

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
    setBusy(true);

    // Re-project app state before each command, so the filesystem reflects
    // anything that changed since the shell was opened.
    await shell.current.mount().catch(() => undefined);
    const result = await shell.current.exec(trimmed);

    setEntries((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, result } : entry)),
    );
    setBusy(false);
  }, []);

  return (
    <>
      <Sheet open={open} title="Shell" onClose={onClose}>
        <p className="section__hint">
          A sandbox over this app’s own data — not your device, and with no network access. The
          model reaches the same commands through its <code>bash</code> tool.
        </p>

        <div className="term" ref={scroller}>
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
            disabled={busy || booting}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder={booting ? 'starting…' : 'chatterang'}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // Shell history, because retyping a pipeline on a phone is
              // punishing.
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                const next = Math.min(historyAt.current + 1, history.current.length - 1);
                if (next >= 0) {
                  historyAt.current = next;
                  setInput(history.current[next] ?? '');
                }
              } else if (event.key === 'ArrowDown') {
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
