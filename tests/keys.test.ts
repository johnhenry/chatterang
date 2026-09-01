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
  commandAllowed,
  commandFor,
  installKeyboard,
  isCommandId,
  modalLayerOpen,
  pushModalLayer,
  registerCommand,
  resetKeyboardForTests,
  runCommand,
  type CommandId,
} from '@/lib/keys';

/** The preload bridge's global, spelled the way `apps/desktop` spells it. */
type CommandListener = (id: string) => void;
interface FakeBridge {
  onCommand: (listener: CommandListener) => () => void;
  /** Test-only: fire an accelerator the way `main.ts` would. */
  fire: (id: string) => void;
}

/** Install a stand-in for the preload bridge on the global the page reads. */
function installFakeBridge(): FakeBridge {
  const listeners = new Set<CommandListener>();
  const bridge: FakeBridge = {
    onCommand: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire: (id) => {
      for (const listener of listeners) listener(id);
    },
  };
  (globalThis as { __chatterangDesktop?: FakeBridge }).__chatterangDesktop = bridge;
  return bridge;
}

afterEach(() => {
  resetKeyboardForTests();
  delete (globalThis as { __chatterangDesktop?: FakeBridge }).__chatterangDesktop;
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
  /*
   * THE DOOR MOVED, AND THAT IS THE POINT OF THIS BLOCK.
   *
   * It used to be `globalThis.__chatterangCommand(id)` — a function published
   * into the MAIN world, callable by any script running in the renderer, and
   * installed on the web build too where nothing could legitimately call it.
   * It is now a SUBSCRIPTION on the preload bridge: the main process sends a
   * command id down an inbound-only channel and this page listens. Nothing
   * page-reachable dispatches a command any more.
   */
  const mainWorldSeam = (): unknown =>
    (globalThis as { __chatterangCommand?: unknown }).__chatterangCommand;

  it('publishes NO command dispatcher into the main world', () => {
    // The security defect, asserted as an absence. If this ever comes back,
    // every script in the renderer can drive the app again.
    installKeyboard(document);
    expect(mainWorldSeam()).toBeUndefined();
  });

  it('publishes no dispatcher even when there is no desktop bridge at all', () => {
    // The web build. `installKeyboard` must not invent a door for a shell
    // that is not there.
    installKeyboard(document);
    expect(mainWorldSeam()).toBeUndefined();
  });

  it('runs a command with no key press and no focus', () => {
    // The accelerator fires in the main process: there is no DOM event to
    // dispatch and no element focused. This is the whole reason the dispatch
    // layer is not three onKeyDown handlers.
    const bridge = installFakeBridge();
    const run = vi.fn();
    registerCommand('chat.new', run);
    installKeyboard(document);

    bridge.fire('chat.new');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('ignores an id that is not a command', () => {
    const bridge = installFakeBridge();
    const run = vi.fn();
    registerCommand('chat.new', run);
    installKeyboard(document);

    expect(() => {
      bridge.fire('rm -rf');
      bridge.fire('constructor');
      bridge.fire('__proto__');
    }).not.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('reaches field-scoped commands the window listener will not', () => {
    // "Send" as a menu item is legitimate; "Enter sends from anywhere" is not.
    const bridge = installFakeBridge();
    const send = vi.fn();
    registerCommand('chat.send', send);
    installKeyboard(document);

    bridge.fire('chat.send');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on teardown', () => {
    const bridge = installFakeBridge();
    const run = vi.fn();
    registerCommand('chat.new', run);
    const teardown = installKeyboard(document);

    bridge.fire('chat.new');
    expect(run).toHaveBeenCalledTimes(1);

    teardown();
    bridge.fire('chat.new');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('names the bridge global the desktop shell actually publishes on', () => {
    // Two files spell this string and neither may import the other; the check
    // is that they agree.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    const shell = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/desktop/src/bridge/renderer.ts'),
      'utf8',
    );
    const declared = /export const BRIDGE_GLOBAL = '([^']+)'/.exec(shell)?.[1];
    const page = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/keys.ts'), 'utf8');
    expect(declared).toBe('__chatterangDesktop');
    expect(page).toContain(`const BRIDGE_GLOBAL = '${declared}'`);
  });
});

/**
 * The modal rule.
 *
 * `aria-modal="true"` says everything behind the dialog is inert. Before this,
 * every window-scoped command reached straight past it: with a sheet open,
 * Mod+N created a chat behind it, Mod+L moved focus into a composer the user
 * could not see, and Mod+Alt+Down switched the conversation under the panel.
 * A menu accelerator did the same, through the other door.
 */
describe('an open modal makes the page behind it inert', () => {
  it('reports no layer until one is pushed', () => {
    expect(modalLayerOpen()).toBe(false);
  });

  it('refuses every window command while a layer is open', () => {
    const run = vi.fn();
    registerCommand('chat.new', run);
    const release = pushModalLayer();

    expect(runCommand('chat.new')).toBe(false);
    expect(run).not.toHaveBeenCalled();

    release();
    expect(runCommand('chat.new')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses it through the key listener as well as the call', () => {
    const run = vi.fn();
    registerCommand('chat.new', run);
    installKeyboard(document);
    pushModalLayer();

    const event = press({ key: 'n', metaKey: true });
    expect(run).not.toHaveBeenCalled();
    // And the browser default is left alone, because nothing handled it.
    expect(event.defaultPrevented).toBe(false);
  });

  it('refuses it through the accelerator door as well', () => {
    const bridge = installFakeBridge();
    const run = vi.fn();
    registerCommand('chat.new', run);
    installKeyboard(document);
    pushModalLayer();

    bridge.fire('chat.new');
    expect(run).not.toHaveBeenCalled();
  });

  it('still lets Escape close the layer, which is what it is for', () => {
    const close = vi.fn();
    registerCommand('layer.close', close);
    pushModalLayer();

    expect(runCommand('layer.close')).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still lets a field-scoped command run, because focus is inside', () => {
    // The shell's terminal lives in a sheet and walks its history with the
    // bare arrows. Gating those would break the panel rather than protect the
    // page behind it.
    const history = vi.fn();
    registerCommand('terminal.historyPrev', history);
    const send = vi.fn();
    registerCommand('chat.send', send);
    pushModalLayer();

    expect(runCommand('terminal.historyPrev')).toBe(true);
    expect(runCommand('chat.send')).toBe(true);
    expect(commandAllowed('chat.send')).toBe(true);
    expect(commandAllowed('chat.new')).toBe(false);
    expect(history).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('counts layers, so closing an inner dialog does not wake the page', () => {
    // A Confirm opens over a Sheet. Dismissing the Confirm must not make
    // Mod+N live again while the Sheet is still up.
    const run = vi.fn();
    registerCommand('chat.new', run);
    pushModalLayer();
    const releaseInner = pushModalLayer();

    releaseInner();
    expect(modalLayerOpen()).toBe(true);
    expect(runCommand('chat.new')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('does not double-release when a release is called twice', () => {
    const outer = pushModalLayer();
    const inner = pushModalLayer();
    inner();
    inner();
    expect(modalLayerOpen()).toBe(true);
    outer();
    expect(modalLayerOpen()).toBe(false);
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

  it('declares a modal layer from the component that renders the dialog', () => {
    // The dispatcher must not have to ask the DOM what is open; whoever
    // renders `aria-modal` says so.
    expect(source('src/ui/primitives.tsx')).toContain('pushModalLayer()');
  });

  it('keeps the chat commands reachable from every tab', () => {
    // `App.tsx` renders the chat screen only on the chat tab, so its four
    // commands unregister on the other four. A menu item that silently does
    // nothing on four screens out of five is worse than a greyed-out one.
    const app = source('src/App.tsx');
    for (const id of ['chat.new', 'chat.focusComposer', 'chat.next', 'chat.previous']) {
      expect(app, `App.tsx does not forward ${id}`).toContain(`'${id}'`);
    }
    expect(app).toContain('registerCommand(id, forward(id))');
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
