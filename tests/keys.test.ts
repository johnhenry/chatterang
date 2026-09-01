/**
 * The keyboard dispatch layer.
 *
 * Behaviour, not shape. Every assertion here drives a real `KeyboardEvent`
 * through a real listener on a real (jsdom) document and observes what
 * happened — because the thing that would silently break is not "does the
 * table have an entry for Escape" but "does pressing Escape reach the sheet on
 * top, once, and leave the browser default alone when nothing is listening".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMMANDS,
  commandFor,
  installKeyboard,
  isCommandId,
  registerCommand,
  resetKeyboardForTests,
  runCommand,
  type CommandId,
} from '@/lib/keys';

afterEach(() => {
  resetKeyboardForTests();
});

function press(init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

describe('the chord table', () => {
  it('gives every command at least one chord', () => {
    for (const [id, spec] of Object.entries(COMMANDS)) {
      expect(spec.chords.length, id).toBeGreaterThan(0);
    }
  });

  it('does not bind one chord to two commands', () => {
    // A collision is silent: `commandFor` returns whichever key is first in
    // the object, and the other command becomes unreachable by keyboard.
    const seen = new Map<string, string>();
    for (const [id, spec] of Object.entries(COMMANDS)) {
      for (const chord of spec.chords) {
        const key = `${chord.mod ? 'mod+' : ''}${chord.alt ? 'alt+' : ''}${chord.shift ? 'shift+' : ''}${chord.key.toLowerCase()}`;
        expect(seen.get(key), `${key} is bound to both ${seen.get(key)} and ${id}`).toBeUndefined();
        seen.set(key, id);
      }
    }
  });

  it('covers the five a desktop user reaches for blindly', () => {
    for (const id of [
      'chat.new',
      'chat.focusComposer',
      'chat.next',
      'chat.previous',
      'chat.send',
      'layer.close',
    ] as const) {
      expect(Object.hasOwn(COMMANDS, id), id).toBe(true);
    }
  });

  it('treats Ctrl and Cmd as the same modifier', () => {
    expect(commandFor({ key: 'n', metaKey: true })).toBe('chat.new');
    expect(commandFor({ key: 'n', ctrlKey: true })).toBe('chat.new');
  });

  it('matches modifiers exactly, so a near miss is not a hit', () => {
    expect(commandFor({ key: 'Escape' })).toBe('layer.close');
    // Shift+Escape is a different chord and must not close a sheet.
    expect(commandFor({ key: 'Escape', shiftKey: true })).toBeNull();
    // Enter sends; Shift+Enter is a newline and must resolve to nothing.
    expect(commandFor({ key: 'Enter' })).toBe('chat.send');
    expect(commandFor({ key: 'Enter', shiftKey: true })).toBeNull();
    // The chat-switch chords need BOTH modifiers.
    expect(commandFor({ key: 'ArrowDown', metaKey: true, altKey: true })).toBe('chat.next');
    expect(commandFor({ key: 'ArrowDown', metaKey: true })).toBeNull();
    // A bare arrow is the terminal's, and nothing else's.
    expect(commandFor({ key: 'ArrowDown' })).toBe('terminal.historyNext');
  });

  it('is case-insensitive on the letter, which arrives lowercase anyway', () => {
    expect(commandFor({ key: 'N', metaKey: true, shiftKey: true })).toBeNull();
    expect(commandFor({ key: 'N', metaKey: true })).toBe('chat.new');
  });

  it('names its own ids and refuses anything else', () => {
    expect(isCommandId('chat.new')).toBe(true);
    expect(isCommandId('chat.explode')).toBe(false);
    expect(isCommandId('toString')).toBe(false);
    expect(isCommandId(7)).toBe(false);
  });
});

describe('the handler stack', () => {
  it('runs the handler registered last', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerCommand('chat.new', first);
    registerCommand('chat.new', second);

    expect(runCommand('chat.new')).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('falls back to the one below when the top declines', () => {
    // A composer that is disabled returns false rather than pretending it sent.
    const below = vi.fn();
    registerCommand('chat.send', below);
    registerCommand('chat.send', () => false);

    expect(runCommand('chat.send')).toBe(true);
    expect(below).toHaveBeenCalledTimes(1);
  });

  it('reports nothing handled when every handler declines', () => {
    registerCommand('chat.next', () => false);
    expect(runCommand('chat.next')).toBe(false);
  });

  it('reports nothing handled when nothing is registered', () => {
    expect(runCommand('chat.previous')).toBe(false);
  });

  it('unregisters the exact handler, restoring the one beneath', () => {
    // This is the sheet-stack case: a Confirm opens over a Sheet, then closes.
    const sheet = vi.fn();
    const confirm = vi.fn();
    registerCommand('layer.close', sheet);
    const closeConfirm = registerCommand('layer.close', confirm);

    runCommand('layer.close');
    expect(confirm).toHaveBeenCalledTimes(1);

    closeConfirm();
    runCommand('layer.close');
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('is idempotent to unregister twice', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    registerCommand('layer.close', outer);
    const off = registerCommand('layer.close', inner);
    off();
    off();
    // A second call must not pop the handler BELOW the one it owns — which is
    // exactly what `splice(lastIndexOf(run))` would do if `run` were gone and
    // `lastIndexOf` returned -1 without the guard.
    runCommand('layer.close');
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('closes only the topmost sheet, which the old per-sheet listener did not', () => {
    // The defect: each open Sheet installed its own `document` keydown handler
    // and called stopPropagation(), which does not stop sibling listeners on
    // the same node. Escape closed every open sheet at once.
    const sheet = vi.fn();
    const confirm = vi.fn();
    registerCommand('layer.close', sheet);
    registerCommand('layer.close', confirm);
    installKeyboard(document);

    press({ key: 'Escape' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sheet).not.toHaveBeenCalled();
  });
});

describe('the window listener', () => {
  it('dispatches a window-scoped chord and swallows its default', () => {
    const run = vi.fn();
    registerCommand('chat.new', run);
    installKeyboard(document);

    const event = press({ key: 'n', metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves the browser default alone when nothing is listening', () => {
    installKeyboard(document);
    const event = press({ key: 'n', metaKey: true });
    expect(event.defaultPrevented).toBe(false);
  });

  it('never dispatches a field-scoped chord', () => {
    // Enter and the bare arrows are ordinary typing everywhere but the one
    // field that owns them. A window listener that claimed Enter would break
    // every textarea in the app.
    const send = vi.fn();
    const history = vi.fn();
    registerCommand('chat.send', send);
    registerCommand('terminal.historyPrev', history);
    installKeyboard(document);

    const enter = press({ key: 'Enter' });
    const up = press({ key: 'ArrowUp' });

    expect(send).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    expect(COMMANDS['chat.send'].scope).toBe('field');
  });

  it('installs once however many times it is called', () => {
    // React 19 StrictMode mounts effects twice in development. Two listeners
    // would fire every command twice, which for `chat.new` means two chats.
    const run = vi.fn();
    registerCommand('chat.new', run);
    installKeyboard(document);
    installKeyboard(document);

    press({ key: 'n', metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops dispatching after teardown', () => {
    const run = vi.fn();
    registerCommand('chat.new', run);
    const teardown = installKeyboard(document);
    teardown();

    press({ key: 'n', metaKey: true });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('the door an Electron accelerator arrives through', () => {
  const seam = (): ((id: string) => boolean) | undefined =>
    (globalThis as { __chatterangCommand?: (id: string) => boolean }).__chatterangCommand;

  it('is absent until the app installs it', () => {
    expect(seam()).toBeUndefined();
  });

  it('runs a command with no key press and no focus', () => {
    // The accelerator fires in the main process: there is no DOM event to
    // dispatch and no element focused. This is the whole reason the dispatch
    // layer is not three onKeyDown handlers.
    const run = vi.fn();
    registerCommand('chat.new', run);
    installKeyboard(document);

    expect(seam()?.('chat.new')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports back whether anything handled it', () => {
    // So a menu item for a command nothing is listening for can be greyed out
    // rather than silently doing nothing.
    installKeyboard(document);
    expect(seam()?.('chat.next')).toBe(false);
  });

  it('refuses an id that is not a command', () => {
    installKeyboard(document);
    expect(seam()?.('rm -rf')).toBe(false);
    expect(seam()?.('constructor')).toBe(false);
  });

  it('reaches field-scoped commands the window listener will not', () => {
    // "Send" as a menu item is legitimate; "Enter sends from anywhere" is not.
    const send = vi.fn();
    registerCommand('chat.send', send);
    installKeyboard(document);

    expect(seam()?.('chat.send')).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('is removed on teardown', () => {
    const teardown = installKeyboard(document);
    expect(seam()).toBeTypeOf('function');
    teardown();
    expect(seam()).toBeUndefined();
  });
});

describe('the three local handlers now go through the table', () => {
  const source = (path: string): string =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('node:fs') as typeof import('node:fs')).readFileSync(
      (require('node:path') as typeof import('node:path')).resolve(process.cwd(), path),
      'utf8',
    );

  it('leaves no key name hard-coded in the three files that had them', () => {
    // The point of the seam is that "which key does what" has one answer. A
    // file that still compares `event.key` to a literal is a second answer.
    for (const path of [
      'src/ui/primitives.tsx',
      'src/features/chat/Composer.tsx',
      'src/features/shell/ShellSheet.tsx',
    ]) {
      const text = source(path);
      for (const key of ["'Escape'", "'Enter'", "'ArrowUp'", "'ArrowDown'"]) {
        expect(text.includes(`event.key === ${key}`), `${path} still names ${key}`).toBe(false);
      }
    }
    // Tab is NOT in the table on purpose: it is focus containment inside a
    // dialog, which is a property of the dialog and not a user-facing command.
    expect(source('src/ui/primitives.tsx')).toContain("event.key !== 'Tab'");
  });

  it('registers each command from the component that can perform it', () => {
    expect(source('src/features/chat/ChatScreen.tsx')).toContain("registerCommand('chat.new'");
    expect(source('src/features/chat/ChatScreen.tsx')).toContain("registerCommand('chat.next'");
    expect(source('src/features/chat/Composer.tsx')).toContain(
      "registerCommand('chat.focusComposer'",
    );
    expect(source('src/ui/primitives.tsx')).toContain("registerCommand('layer.close'");
  });

  it('installs the listener exactly once, at the app root', () => {
    const app = source('src/App.tsx');
    expect(app).toContain('installKeyboard()');
    expect(app.match(/installKeyboard/g)?.length).toBe(2); // the import and the call
  });
});

/** Exhaustiveness: a command added without a chord would be unreachable. */
it('every CommandId in the type is in the table', () => {
  const ids: CommandId[] = [
    'chat.new',
    'chat.focusComposer',
    'chat.next',
    'chat.previous',
    'chat.send',
    'layer.close',
    'terminal.historyPrev',
    'terminal.historyNext',
  ];
  expect(Object.keys(COMMANDS).sort()).toEqual([...ids].sort());
});
