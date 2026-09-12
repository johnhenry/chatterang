/**
 * Moved to `@chatterang/contracts`.
 *
 * Two implementations: the desktop bridge (`apps/desktop/src/fs/mounts.ts`)
 * and the web shim beside this file, which grants nothing. iOS and Android are
 * the third, when a document-picker grant is wired to it.
 *
 * Re-exported here so the shim and the plugin registration keep their imports.
 */
export type * from '@chatterang/contracts/mount-host';
