/**
 * Electron's permission handlers, installed on the session the app's window uses.
 *
 * The decision lives in `security.ts`, which imports no Electron so tests can
 * drive it. This file is the wiring, and it imports no Electron either: it is
 * typed against the two session methods it calls, so `tests/desktop-
 * permissions.test.ts` can install it on a fake session and invoke the very
 * handlers `main.ts` installs — the wiring is tested, not re-described.
 *
 * BOTH handlers, because Electron consults both: most web APIs CHECK a
 * permission first and only REQUEST it if the check fails. A request handler
 * alone leaves the check answering Electron's default.
 */

import { isPermissionGranted, permissionRequestUrl } from './security.js';

interface WebContentsLike {
  getURL(): string;
}

interface PermissionDetailsLike {
  readonly requestingUrl?: string;
  readonly isMainFrame?: boolean;
}

/** The two methods of Electron's `Session` this needs, and nothing else. */
export interface PermissionSessionLike {
  setPermissionRequestHandler(
    handler: (
      webContents: WebContentsLike,
      permission: string,
      callback: (granted: boolean) => void,
      details: PermissionDetailsLike,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      webContents: WebContentsLike | null,
      permission: string,
      requestingOrigin: string,
      details: PermissionDetailsLike,
    ) => boolean,
  ): void;
}

/**
 * Install the desktop's permission policy on `session`.
 *
 * MUST run before the first window loads. A page that loads first can make a
 * request that reaches Electron's approve-everything default.
 */
export function installPermissionHandlers(session: PermissionSessionLike, devServerUrl: string): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = permissionRequestUrl(details, '', webContents.getURL());
    callback(isPermissionGranted({ permission, requestingUrl, isMainFrame: details.isMainFrame === true }, devServerUrl));
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const requestingUrl = permissionRequestUrl(details, requestingOrigin, webContents?.getURL() ?? '');
    return isPermissionGranted({ permission, requestingUrl, isMainFrame: details.isMainFrame === true }, devServerUrl);
  });
}
