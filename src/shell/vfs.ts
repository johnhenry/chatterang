/**
 * The shell's filesystem.
 *
 * A projection of app state into files, rebuilt on each mount. Read-only by
 * convention — writes land in the in-memory FS and are discarded, which is
 * the right default: a shell that could rewrite your conversations by
 * accident is not a feature.
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

  /* ── Device ────────────────────────────────────────────────────────── */
  const device = stores.device();
  if (device) {
    files['/device.json'] = `${JSON.stringify(device, null, 2)}\n`;
  }

  return files;
}
