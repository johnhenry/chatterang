// @vitest-environment node
/**
 * The application menu — the caller that makes the dispatch seam real.
 *
 * THE DEFECT THIS FILE GUARDS. `src/lib/keys.ts` shipped a command dispatcher
 * documented as having two doors, and nothing in `apps/desktop` registered a
 * menu item, an accelerator or a global shortcut. Door 2 opened onto nobody.
 * Every assertion here is about the wiring being present and pointing at real
 * commands, because "the menu exists" is exactly the kind of thing that is
 * true in a template and false in the shipped app.
 *
 * It reads `src/lib/keys.ts` as TEXT for the cross-file checks. That is
 * deliberate: `tests/layering.test.ts` forbids `apps/desktop` importing `src`
 * and vice versa — the renderer bundle also ships as a web app and two
 * Capacitor apps, none of which have a main process — so the two tables are
 * necessarily duplicated, and the thing worth testing is that they agree.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MENU_COMMANDS,
  buildMenuTemplate,
  commandsInTemplate,
  type MenuTemplateItem,
} from '@chatterang/desktop/menu';

const read = (relative: string): string =>
  readFileSync(resolve(process.cwd(), relative), 'utf8');

const mac = buildMenuTemplate({ appName: 'Chatterang', isMac: true });
const other = buildMenuTemplate({ appName: 'Chatterang', isMac: false });

/** Every item in a template, at any depth. */
function flatten(template: readonly MenuTemplateItem[]): MenuTemplateItem[] {
  const found: MenuTemplateItem[] = [];
  const walk = (items: readonly MenuTemplateItem[]): void => {
    for (const entry of items) {
      found.push(entry);
      if (entry.submenu) walk(entry.submenu);
    }
  };
  walk(template);
  return found;
}

/** Every `role` the template uses. */
const roles = (template: readonly MenuTemplateItem[]): string[] =>
  flatten(template)
    .map((entry) => entry.role)
    .filter((role): role is string => role !== undefined);

describe('the menu wires the dispatch layer to real accelerators', () => {
  it('sends the three the milestone asked for, and the two that complete them', () => {
    expect(commandsInTemplate(mac)).toEqual(
      expect.arrayContaining(['chat.new', 'chat.focusComposer', 'layer.close']),
    );
    // next/previous are in the chord table already; leaving them out of the
    // menu would mean the app's answer to "what are the shortcuts?" depends
    // on which shell you are in, which is the thing the table exists to stop.
    expect(commandsInTemplate(mac)).toEqual(
      expect.arrayContaining(['chat.next', 'chat.previous']),
    );
  });

  it('gives every command it sends an accelerator and a label', () => {
    for (const entry of flatten(mac)) {
      if (!entry.command) continue;
      expect(entry.accelerator, `${entry.command} has no accelerator`).toBeTruthy();
      expect(entry.label, `${entry.command} has no label`).toBeTruthy();
    }
    expect(flatten(mac).filter((entry) => entry.command).length).toBe(MENU_COMMANDS.length);
  });

  it('names only commands the renderer will actually accept', () => {
    // A menu item sending an id `isCommandId` rejects is a menu item that does
    // nothing, and nothing in either process would say so.
    const keys = read('src/lib/keys.ts');
    const declared = keys.slice(
      keys.indexOf('export type CommandId'),
      keys.indexOf(';', keys.indexOf('export type CommandId')),
    );
    for (const { command } of MENU_COMMANDS) {
      expect(declared, `CommandId has no ${command}`).toContain(`'${command}'`);
    }
  });

  it('advertises the same chord the page binds, in Electron spelling', () => {
    /*
     * The two tables are written twice and must not drift. `Mod` in the page's
     * table is `metaKey || ctrlKey`, which Electron spells `CmdOrCtrl`; the
     * page's `alt` is Electron's `Alt`; a bare key is a bare key.
     */
    const keys = read('src/lib/keys.ts');
    const chordOf = (command: string): string => {
      const at = keys.indexOf(`'${command}': {`);
      expect(at, `${command} is not in COMMANDS`).toBeGreaterThan(-1);
      const block = keys.slice(at, keys.indexOf('},', at));
      const chords = /chords:\s*\[([^\]]*)\]/.exec(block)?.[1] ?? '';
      const first = /\{([^}]*)\}/.exec(chords)?.[1] ?? '';
      const key = /key:\s*'([^']+)'/.exec(first)?.[1] ?? '';
      const parts: string[] = [];
      if (/mod:\s*true/.test(first)) parts.push('CmdOrCtrl');
      if (/alt:\s*true/.test(first)) parts.push('Alt');
      if (/shift:\s*true/.test(first)) parts.push('Shift');
      parts.push(key.length === 1 ? key.toUpperCase() : key.replace(/^Arrow/, ''));
      return parts.join('+');
    };

    for (const { command, accelerator } of MENU_COMMANDS) {
      expect(accelerator, `${command} advertises a chord the page does not bind`).toBe(
        chordOf(command),
      );
    }
  });

  it('leaves Escape bound to exactly one thing in the page', () => {
    // A menu accelerator is taken by MAIN before the renderer sees the key, so
    // listing Escape here removes it from the page. That is only safe while
    // `layer.close` is the sole meaning Escape has.
    const keys = read('src/lib/keys.ts');
    const escapeChords = keys.match(/key:\s*'Escape'/g) ?? [];
    expect(escapeChords.length).toBe(1);
    expect(MENU_COMMANDS.find((entry) => entry.accelerator === 'Escape')?.command).toBe(
      'layer.close',
    );
  });
});

describe('the menu does not remove what the default menu was providing', () => {
  it('keeps the clipboard and undo roles, which macOS has no other source for', () => {
    // `Menu.setApplicationMenu` REPLACES the default. Without these roles,
    // Cmd+C and Cmd+V do nothing at all in a sandboxed renderer on macOS —
    // which is the regression a menu of three items would have shipped.
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
      expect(roles(mac), `macOS menu lost the ${role} role`).toContain(role);
      expect(roles(other), `non-macOS menu lost the ${role} role`).toContain(role);
    }
  });

  it('keeps a way to quit, on both platform shapes', () => {
    expect(roles(mac)).toContain('quit');
    expect(roles(other)).toContain('quit');
  });

  it('keeps window and view roles', () => {
    for (const role of ['minimize', 'reload', 'togglefullscreen', 'resetZoom']) {
      expect(roles(mac), role).toContain(role);
    }
  });

  it('gives macOS an application menu and gives nobody else one', () => {
    expect(mac[0]?.label).toBe('Chatterang');
    expect(roles(mac)).toContain('services');
    expect(other[0]?.label).toBe('&File');
    expect(roles(other)).not.toContain('services');
  });

  it('names no item both a role and a command', () => {
    // A role has Electron's own behaviour; a command has ours. An item with
    // both would do one of them and quietly drop the other.
    for (const entry of [...flatten(mac), ...flatten(other)]) {
      expect(entry.role !== undefined && entry.command !== undefined).toBe(false);
    }
  });
});

describe('the main process actually installs it, down the bridge', () => {
  const main = read('apps/desktop/src/main.ts');

  it('sets the application menu before the first window', () => {
    // THE CALL, NOT THE DEFINITION. `main.indexOf('installMenu()')` found
    // `function installMenu(): void` and passed with the call deleted — a
    // fault injection caught that, which is the only reason this is a regex.
    const call = main.search(/^\s*installMenu\(\);$/m);
    expect(call, 'main.ts defines installMenu but never calls it').toBeGreaterThan(-1);
    expect(main).toContain('Menu.setApplicationMenu');
    // The first window is created by this call. #7 S6 renamed its middle
    // argument (the teardown now reaches the work broker as well as the fleet),
    // and #118 added a fourth (the CLI plugin's own teardown methods); the old
    // literal's -1 turned this into "expected N to be less than -1", so the
    // call is now asserted to exist before it is compared against.
    const firstWindow = main.indexOf('createWindow(pluginHost, localTurns, senders, cliPlugin)');
    expect(firstWindow, 'main.ts no longer creates its first window with this call').toBeGreaterThan(-1);
    expect(call).toBeLessThan(firstWindow);
  });

  it('sends the command down the preload bridge, not into the main world', () => {
    // `webContents.executeJavaScript` would have been one line and would have
    // reached for exactly the main-world global this milestone removed.
    expect(main).toContain('webContents.send(COMMAND_CHANNEL, command)');
    // The CALL, not the word: the comment beside the send names the road not
    // taken, and a test that banned the word would ban explaining the choice.
    expect(main).not.toContain('.executeJavaScript(');
    expect(main).not.toContain('__chatterangCommand');
  });

  it('targets the focused window rather than one captured at boot', () => {
    // On macOS the app outlives its windows and `activate` makes another.
    expect(main).toContain('BrowserWindow.getFocusedWindow()');
  });

  it('strips our marker so no `command` reaches Electron as an option', () => {
    expect(main).toContain('const { command, submenu, ...rest } = entry');
  });
});
