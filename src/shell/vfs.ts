/**
 * The shell's filesystem.
 *
 * A projection of app state into files, rebuilt on each mount and read-only
 * to everything inside the shell. "Read-only by convention" is what this said
 * before, and the convention was not true: writes reached the in-memory FS
 * and survived, so a model could plant `/chats/notes.md` and read it back as
 * a transcript. The convention is now a guard — see `shell/fs.ts` — and
 * {@link PROJECTED_PATHS} is the list it enforces.
 *
 * Everything here is data the user already owns and can already see in the
 * UI. Nothing is mounted that the app itself does not hold: no device
 * filesystem, no keychain, no other app's data. Notably absent are provider
 * API keys — they exist in the settings store and are deliberately not
 * projected, because a model with filesystem access should not be one `cat`
 * away from a credential.
 */

import type { ShellStores } from '@/shell/commands';
import { renderTranscript } from '@/shell/commands';

export type VfsSnapshot = Record<string, string>;

/**
 * Everything `buildVfs` writes lives at or under one of these.
 *
 * `/workspace` is deliberately absent: it is scratch space, the one part of
 * the tree the shell owns rather than borrows. Adding a projection means
 * adding it here too, or the guard will not know to protect it — which is why
 * `tests/shell.test.ts` checks the two lists against each other rather than
 * trusting them to stay in step.
 */
export const PROJECTED_PATHS = [
  '/chats',
  '/models',
  '/personas',
  // Added with the projection itself, not after: the test that guards this list
  // says the seam is 'where a projection added tomorrow would quietly land in
  // writable space', and that is exactly how /providers first arrived.
  '/providers',
  '/README.md',
  '/device.json',
] as const;

/**
 * Is this path part of the projection — or an ancestor of it?
 *
 * The ancestor half matters: `rm -rf /` names none of the projected paths and
 * would take all of them.
 */
export function isProjectedPath(path: string): boolean {
  return PROJECTED_PATHS.some(
    (projected) =>
      path === projected ||
      path.startsWith(`${projected}/`) ||
      projected.startsWith(path === '/' ? '/' : `${path}/`),
  );
}

/** Filesystem-safe slug, stable enough to be predictable between mounts. */
export function slug(text: string, fallback: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

export async function buildVfs(stores: ShellStores): Promise<VfsSnapshot> {
  const files: VfsSnapshot = {};

  files['/workspace/.keep'] = '';
  files['/README.md'] = [
    '# Chatterang shell',
    '',
    'This is a sandbox. The filesystem below is a view of the app’s own data,',
    'not your device — nothing outside Chatterang is reachable, and there is no',
    'network access.',
    '',
    '- `/workspace` — scratch space, yours to write in',
    '- `/chats` — conversations as Markdown, read-only',
    '- `/models` — installed model manifests, read-only',
    '- `/personas` — personas as JSON, read-only',
    '',
    'Read-only here means the filesystem refuses the write, not that writing is',
    'discouraged. A shell that could invent a conversation could quote it back.',
    '',
    'Run `chatterang` for the app commands, or use the standard tools:',
    '',
    '    grep -ril "quantisation" /chats',
    '    jq -r ".capabilities[]" /models/*.json | sort | uniq -c',
    '',
  ].join('\n');

  /* ── Conversations ─────────────────────────────────────────────────── */
  const chats = stores.chats();
  const seen = new Set<string>();

  for (const chat of chats.list) {
    let name = slug(chat.title, chat.id);
    // Two chats can share a title; the id disambiguates rather than one
    // silently overwriting the other.
    if (seen.has(name)) name = `${name}-${chat.id.slice(-6)}`;
    seen.add(name);

    try {
      const messages = await chats.messagesFor(chat.id);
      files[`/chats/${name}.md`] = renderTranscript(chat, messages);
    } catch {
      // A chat that cannot be read should not take the whole mount down.
      files[`/chats/${name}.md`] = `# ${chat.title}\n\n_This conversation could not be read._\n`;
    }
  }

  if (chats.list.length === 0) files['/chats/.keep'] = '';

  /* ── Models ────────────────────────────────────────────────────────── */
  const models = stores.models();
  const installed = Object.values(models.installed).filter((m) => m.state === 'installed');

  for (const model of installed) {
    files[`/models/${model.id}.json`] = `${JSON.stringify(
      {
        id: model.id,
        name: model.manifest.name,
        engine: model.manifest.engine,
        quantization: model.manifest.quantization,
        capabilities: model.manifest.capabilities,
        contextLength: model.manifest.contextLength,
        sizeBytes: model.manifest.sizeBytes,
        onDiskBytes: model.downloadedBytes,
        license: model.manifest.license,
        useCount: model.useCount,
        active: model.id === models.activeModelId,
      },
      null,
      2,
    )}\n`;
  }

  if (installed.length === 0) files['/models/.keep'] = '';

  /* ── Personas ──────────────────────────────────────────────────────── */
  const personas = stores.personas();
  for (const persona of personas) {
    files[`/personas/${slug(persona.name, persona.id)}.json`] = `${JSON.stringify(
      {
        id: persona.id,
        name: persona.name,
        kind: persona.kind,
        tagline: persona.tagline,
        builtin: persona.builtin ?? false,
      },
      null,
      2,
    )}\n`;
  }

  if (personas.length === 0) files['/personas/.keep'] = '';

  /*
   * ── Providers ──────────────────────────────────────────────────────
   *
   * A WHITELIST, not the stored object.
   *
   * `ProviderConnection.apiKey` lives beside these fields, so serialising the
   * record whole put a live credential in the VFS — where the model can read
   * it, and where the shell's whole premise is that it cannot. Caught by
   * `tests/shell.test.ts`'s canary, which greps the projection for key shapes
   * and has guarded this since before the desktop build existed.
   *
   * The projection is a whitelist by construction rather than a redaction on
   * the way past: a field added to the stored record does not appear here
   * until someone adds it deliberately, which is the failure mode that
   * matters — nobody re-reads this loop when they add a token to the store.
   */
  for (const provider of stores.providers().list) {
    files[`/providers/${slug(provider.label, provider.id)}.json`] = `${JSON.stringify(
      {
        id: provider.id,
        label: provider.label,
        enabled: provider.enabled,
        defaultModel: provider.defaultModel,
      },
      null,
      2,
    )}\n`;
  }

  /* ── Device ────────────────────────────────────────────────────────── */
  const device = stores.device();
  if (device) {
    files['/device.json'] = `${JSON.stringify(device, null, 2)}\n`;
  }

  return files;
}
