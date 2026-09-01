/**
 * The keyboard dispatch layer.
 *
 * THE DEFECT THIS CLOSES. Every keyboard behaviour in this app was a private
 * `onKeyDown` on the element that happened to have focus — three of them, in
 * `ui/primitives.tsx` (Escape closes a sheet), `features/chat/Composer.tsx`
 * (Enter sends), and `features/shell/ShellSheet.tsx` (arrows walk shell
 * history). That is fine for a phone, where the only keyboard is the one the
 * OS draws under the field it belongs to. It is not fine for a window:
 *
 *   - Nothing outside the focused element could trigger any of them. An
 *     Electron menu accelerator has no element to dispatch to, so "New Chat
 *     ⌘N" in a menu had nothing to call.
 *   - Which key does what was spread across three files, so there was no
 *     answer to "what are the shortcuts?" other than reading all three.
 *   - Escape was a `document` keydown listener installed once PER OPEN SHEET.
 *     `stopPropagation()` does not stop other listeners on the same node —
 *     only `stopImmediatePropagation` would — so opening a Confirm over a
 *     Sheet and pressing Escape closed both.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. It is a dispatch seam: a table of chords,
 * a registry of handlers, and one listener. It is NOT a command palette, a
 * user-remapping system, or a menu — none of which anything has asked for.
 *
 * THE TWO WAYS IN, which is the whole point:
 *
 *   1. `installKeyboard()` puts one listener on the document. A chord in the
 *      table resolves to a CommandId, and the topmost handler registered for
 *      it runs.
 *   2. `globalThis.__chatterangCommand(id)` — installed by the same call — is
 *      the door for anything that is not a key press in this page. An Electron
 *      menu accelerator fires in the MAIN process, where there is no DOM and
 *      no focus; it reaches the app by sending its command id down to the
 *      renderer, and this is what it lands on. The name matches the shell's
 *      existing `__chatterangDesktop` bridge global.
 *
 * WHY THE PAGE STILL BINDS CHORDS A BROWSER WILL EAT. `Mod+N` is "new window"
 * in every browser and there is nothing a page can do about that. It is in the
 * table anyway, because the table is the app's answer to "what is the shortcut
 * for a new chat?" and the answer should not be a different key depending on
 * which shell you are in. Where the browser wins, the browser wins; in the
 * desktop shell the accelerator takes the chord first and arrives through door
 * 2 at the same command. One table, two doors, one behaviour.
 *
 * NOT A PLATFORM QUESTION. Nothing here asks `capabilities().id`. `Mod` is
 * `metaKey || ctrlKey`, which is right on both without anyone naming an OS,
 * and whether a chord is even reachable is the shell's problem rather than
 * this layer's.
 */

/**
 * Everything that can be triggered by a key, a menu, or an accelerator.
 *
 * Deliberately short. These are the five a desktop user reaches for without
 * looking — new chat, focus the composer, move between chats, close what is on
 * top, send — plus the two the shell's terminal already had, which are in the
 * table so that "which key does what" has exactly one answer.
 */
export type CommandId =
  | 'chat.new'
  | 'chat.focusComposer'
  | 'chat.next'
  | 'chat.previous'
  | 'chat.send'
  | 'layer.close'
  | 'terminal.historyPrev'
  | 'terminal.historyNext';

/**
 * Where a chord is allowed to fire.
 *
 * `window` — the document listener dispatches it, wherever focus is.
 * `field`  — only the field that owns it may dispatch it, by asking
 *            {@link commandFor} what the event means. Enter and the bare
 *            arrows are ordinary typing everywhere else; a window-level
 *            listener that claimed them would break every other input.
 */
export type Scope = 'window' | 'field';

/** One key combination. `mod` is Cmd on macOS and Ctrl everywhere else. */
export interface Chord {
  readonly key: string;
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export interface CommandSpec {
  readonly scope: Scope;
  /** Human-readable, for a menu item or a hint. */
  readonly label: string;
  readonly chords: readonly Chord[];
}

/**
 * The table. One place that answers "what does this key do?".
 *
 * `Mod+Alt+Arrow` for chat switching rather than `Mod+Alt+Left/Right`, which
 * Chrome on macOS uses for tabs; up/down are free in every browser tested and
 * read as "up and down the list" against a vertical session column.
 */
export const COMMANDS: Readonly<Record<CommandId, CommandSpec>> = Object.freeze({
  'chat.new': {
    scope: 'window',
    label: 'New chat',
    chords: [{ key: 'n', mod: true }],
  },
  'chat.focusComposer': {
    scope: 'window',
    label: 'Focus the composer',
    chords: [{ key: 'l', mod: true }],
  },
  'chat.next': {
    scope: 'window',
    label: 'Next chat',
    chords: [{ key: 'ArrowDown', mod: true, alt: true }],
  },
  'chat.previous': {
    scope: 'window',
    label: 'Previous chat',
    chords: [{ key: 'ArrowUp', mod: true, alt: true }],
  },
  'layer.close': {
    scope: 'window',
    label: 'Close',
    chords: [{ key: 'Escape' }],
  },
  'chat.send': {
    // Bare Enter is the desktop convention and is gated on a fine pointer by
    // the composer itself: on a phone there is no comfortable Shift+Enter, so
    // Enter has to insert a newline. Mod+Enter is unconditional, which is what
    // a phone with a Bluetooth keyboard actually needs.
    scope: 'field',
    label: 'Send',
    chords: [{ key: 'Enter' }, { key: 'Enter', mod: true }],
  },
  'terminal.historyPrev': {
    scope: 'field',
    label: 'Previous command',
    chords: [{ key: 'ArrowUp' }],
  },
  'terminal.historyNext': {
    scope: 'field',
    label: 'Next command',
    chords: [{ key: 'ArrowDown' }],
  },
});

const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

/** Whether a string names a command. The external door validates with this. */
export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && Object.hasOwn(COMMANDS, value);
}

/**
 * What a handler may return.
 *
 * `false` means "not mine" and passes the command to the handler below it on
 * the stack; anything else (including `undefined`) means handled. That is what
 * lets a composer register `chat.send` unconditionally and still decline a
 * bare Enter on a touch device, without the dispatcher knowing why.
 */
export type CommandHandler = () => boolean | void;

/**
 * A stack per command, not a single slot.
 *
 * Two sheets can be open at once, and both register `layer.close`. The one
 * that opened LAST registered last and is the one Escape must close — which is
 * also why unregistering removes that specific handler rather than clearing
 * the entry.
 */
const handlers = new Map<CommandId, CommandHandler[]>();

/** Register a handler. Returns the unregister function; call it on unmount. */
export function registerCommand(id: CommandId, run: CommandHandler): () => void {
  let stack = handlers.get(id);
  if (!stack) {
    stack = [];
    handlers.set(id, stack);
  }
  stack.push(run);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const index = stack.lastIndexOf(run);
    if (index >= 0) stack.splice(index, 1);
  };
}

/**
 * Run the topmost handler that claims the command.
 *
 * Returns whether anything handled it, which is what the listener uses to
 * decide about `preventDefault` — a chord nothing is listening for must keep
 * its browser default rather than being swallowed by a dispatcher that exists.
 */
export function runCommand(id: CommandId): boolean {
  const stack = handlers.get(id);
  if (!stack) return false;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]!() !== false) return true;
  }
  return false;
}

/** The parts of a keyboard event a chord is matched against. */
export interface KeyLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}

function matches(chord: Chord, event: KeyLike): boolean {
  // Exact equality on every modifier, not "at least these": Shift+Escape is
  // not Escape, and a chord that ignored extra modifiers would fire on chords
  // meant for something else.
  const mod = Boolean(event.metaKey) || Boolean(event.ctrlKey);
  if (mod !== Boolean(chord.mod)) return false;
  if (Boolean(event.shiftKey) !== Boolean(chord.shift)) return false;
  if (Boolean(event.altKey) !== Boolean(chord.alt)) return false;
  // `key` is the produced character, so a letter arrives lowercase unless
  // Shift is down — and Shift is already matched above.
  return event.key.toLowerCase() === chord.key.toLowerCase();
}

/**
 * Which command this key press means, if any.
 *
 * Used by the window listener AND by the two fields that own field-scoped
 * chords, so a field never hard-codes a key: it asks what the event means and
 * compares to the command it implements.
 */
export function commandFor(event: KeyLike): CommandId | null {
  for (const id of COMMAND_IDS) {
    for (const chord of COMMANDS[id].chords) {
      if (matches(chord, event)) return id;
    }
  }
  return null;
}

let uninstall: (() => void) | null = null;

/**
 * Install the window listener and the external door. Idempotent.
 *
 * Returns a teardown. Calling it twice returns the same teardown rather than
 * stacking listeners, because React 19's StrictMode mounts effects twice in
 * development and a second listener would double every command.
 */
export function installKeyboard(target: EventTarget | undefined = globalThis.document): () => void {
  if (uninstall) return uninstall;
  if (!target) return () => undefined;

  const onKeyDown = (event: Event): void => {
    const key = event as unknown as KeyLike & { preventDefault(): void };
    if (typeof key.key !== 'string') return;
    const id = commandFor(key);
    // Field-scoped chords are ordinary typing at this level. Dispatching them
    // here would make Enter unable to insert a newline anywhere in the app.
    if (!id || COMMANDS[id].scope !== 'window') return;
    if (runCommand(id)) key.preventDefault();
  };

  target.addEventListener('keydown', onKeyDown);

  /*
   * The door for everything that is not a key press in this page.
   *
   * An Electron accelerator fires in the main process. It reaches the app the
   * same way every other desktop feature does — down the existing bridge — and
   * lands here. Returns whether a handler claimed it so the shell can grey out
   * a menu item that would do nothing.
   */
  const globals = globalThis as { __chatterangCommand?: (id: string) => boolean };
  globals.__chatterangCommand = (id: string): boolean => (isCommandId(id) ? runCommand(id) : false);

  uninstall = () => {
    target.removeEventListener('keydown', onKeyDown);
    delete globals.__chatterangCommand;
    uninstall = null;
  };
  return uninstall;
}

/** Test seam: forget every handler and listener. Not used by the app. */
export function resetKeyboardForTests(): void {
  handlers.clear();
  uninstall?.();
}
