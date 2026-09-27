/**
 * Persona schema (PRD §3.2).
 *
 * A single schema that is a superset of two prior art formats:
 *
 *  - "Pals"-style assistants: a role, a task, a preferred model, and a set of
 *    generation defaults, aimed at getting useful work done.
 *  - Character Card v2: `description` / `personality` / `scenario` /
 *    `first_mes` / `mes_example` / `system_prompt` /
 *    `post_history_instructions` / `alternate_greetings` / `character_book`,
 *    aimed at sustained roleplay.
 *
 * Both are re-implemented here from the published format description. No
 * source was copied from any AGPL-licensed project (PRD §5, §6).
 */

import type { Capability, SamplerSettings } from './manifest';

export type PersonaKind = 'assistant' | 'character';

/* ══ Agent configuration (#7: personas become configurable on everything) ══
 *
 * Owner ruling, 2026-09-27: one `Persona` type, not a second "agent persona"
 * shape. `agentConfig` is an optional block on top of the thin fields above
 * (`preferredModelId`, `sampler`, `tools`, `requires`, `showThinking`), which
 * keep working unchanged — a persona written before this field existed reads
 * back with `agentConfig` absent, and nothing here requires it to be present.
 *
 * Everything this block can ask for narrows what the app already allows; it
 * can never widen it. That is enforced in two places, deliberately not here:
 *  - `state/chat.ts`'s `narrowToolPolicy` (built on the existing
 *    `unsensitive`) intersects `toolPolicy.toolIds` with what the chat
 *    already allows and drops sensitive tools regardless of what a card asks
 *    for, and clamps `maxToolRounds` to the engine's own per-turn limit.
 *  - `mcpServerIds` only ever selects among MCP servers the user has already
 *    added and enabled; a persona carries no server definition, URL or
 *    token, so importing one can never add a new egress path.
 * This module's job is narrower: hold the type, and refuse to let anything
 * outside its known shape survive an import (`sanitizeAgentConfig`).
 */

/** How this persona reaches a model. `cli-agent` is a placeholder: it is a
 * recognised string so a persona can name it and round-trip it, but nothing
 * in this pass resolves it to a backend — another track owns that target
 * kind. */
export type PersonaProviderKind = 'local' | 'remote-connection' | 'cli-agent';

export interface PersonaProviderPreference {
  readonly kind: PersonaProviderKind;
  /** A `ProviderConnection` id, for `remote-connection` (and, later, `cli-agent`). */
  readonly connectionId?: string;
  /** A specific model id on that provider; absent falls back like a missing `preferredModelId`. */
  readonly modelId?: string;
}

/** Confirmation strictness a persona may ask for. Deliberately closed: there
 * is no value here that skips a confirmation the app would otherwise ask
 * for, because a card is not the place that decision gets made. */
export type PersonaToolConfirmPolicy = 'always-ask' | 'app-default';

export interface PersonaToolPolicy {
  /** Tool ids this persona prefers; narrowed against what the chat allows. */
  readonly toolIds?: readonly string[];
  /** MCP server ids this persona prefers, among the ones the user added. */
  readonly mcpServerIds?: readonly string[];
  readonly confirmPolicy?: PersonaToolConfirmPolicy;
  /** Per-turn tool-round cap this persona prefers; clamped to the engine's own limit. */
  readonly maxToolRounds?: number;
}

/** Where this persona (or its agent preferences) came from, for the one-time
 * consent an imported remote/cli provider needs before anything is sent —
 * built in a later pass; this just carries the provenance it will need. */
export interface PersonaSource {
  readonly author?: string;
  readonly url?: string;
  readonly publishedAt?: number;
  /** Which surface this was published for, e.g. `'marketplace'`. */
  readonly forSurface?: string;
}

export interface PersonaAgentConfig {
  readonly provider?: PersonaProviderPreference;
  readonly toolPolicy?: PersonaToolPolicy;
  readonly source?: PersonaSource;
}

const PERSONA_PROVIDER_KINDS: ReadonlySet<string> = new Set<PersonaProviderKind>([
  'local',
  'remote-connection',
  'cli-agent',
]);

const PERSONA_CONFIRM_POLICIES: ReadonlySet<string> = new Set<PersonaToolConfirmPolicy>([
  'always-ask',
  'app-default',
]);

/**
 * Validate and strip an `agentConfig` that arrived from outside this app — a
 * Character Card extension, or later a marketplace listing.
 *
 * Anything not in the shape above is dropped, not coerced: an unknown
 * `provider.kind` loses the whole `provider` rather than being guessed at, a
 * `confirmPolicy` outside the two known values is dropped rather than
 * defaulted (a wrong default here would be a silent widening), and
 * `maxToolRounds` must be a plain non-negative integer or it is dropped. This
 * function only knows the SHAPE is valid; it has no registry to check tool or
 * connection ids against, so `toolIds` / `mcpServerIds` / `connectionId` are
 * kept as given and narrowed later, where the app's actual allow-lists live.
 */
export function sanitizeAgentConfig(raw: unknown): PersonaAgentConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const result: { -readonly [K in keyof PersonaAgentConfig]?: PersonaAgentConfig[K] } = {};

  const provider = value.provider;
  if (provider && typeof provider === 'object') {
    const p = provider as Record<string, unknown>;
    if (typeof p.kind === 'string' && PERSONA_PROVIDER_KINDS.has(p.kind)) {
      result.provider = {
        kind: p.kind as PersonaProviderKind,
        connectionId: typeof p.connectionId === 'string' ? p.connectionId : undefined,
        modelId: typeof p.modelId === 'string' ? p.modelId : undefined,
      };
    }
  }

  const toolPolicy = value.toolPolicy;
  if (toolPolicy && typeof toolPolicy === 'object') {
    const t = toolPolicy as Record<string, unknown>;
    const policy: { -readonly [K in keyof PersonaToolPolicy]?: PersonaToolPolicy[K] } = {};

    if (Array.isArray(t.toolIds)) {
      policy.toolIds = t.toolIds.filter((id): id is string => typeof id === 'string');
    }
    if (Array.isArray(t.mcpServerIds)) {
      policy.mcpServerIds = t.mcpServerIds.filter((id): id is string => typeof id === 'string');
    }
    if (typeof t.confirmPolicy === 'string' && PERSONA_CONFIRM_POLICIES.has(t.confirmPolicy)) {
      policy.confirmPolicy = t.confirmPolicy as PersonaToolConfirmPolicy;
    }
    if (typeof t.maxToolRounds === 'number' && Number.isInteger(t.maxToolRounds) && t.maxToolRounds >= 0) {
      policy.maxToolRounds = t.maxToolRounds;
    }

    if (Object.keys(policy).length > 0) result.toolPolicy = policy;
  }

  const source = value.source;
  if (source && typeof source === 'object') {
    const s = source as Record<string, unknown>;
    const src: { -readonly [K in keyof PersonaSource]?: PersonaSource[K] } = {};
    if (typeof s.author === 'string') src.author = s.author;
    if (typeof s.url === 'string') src.url = s.url;
    if (typeof s.publishedAt === 'number') src.publishedAt = s.publishedAt;
    if (typeof s.forSurface === 'string') src.forSurface = s.forSurface;
    if (Object.keys(src).length > 0) result.source = src;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Namespaced Character Card v2 extension this app writes and reads back. */
interface ChatterangCardExtension {
  readonly schemaVersion: 1;
  readonly agentConfig?: unknown;
}

/** Character Book — retrieval entries injected when their keys match. */
export interface LoreEntry {
  readonly id: string;
  readonly keys: readonly string[];
  readonly content: string;
  /** Always inject, regardless of key match. */
  readonly constant?: boolean;
  /** Higher wins when the budget is tight. */
  readonly priority?: number;
  readonly enabled: boolean;
  readonly caseSensitive?: boolean;
}

export interface CharacterBook {
  readonly name?: string;
  readonly entries: readonly LoreEntry[];
  /** Token budget for injected lore. */
  readonly tokenBudget?: number;
  /** How many recent messages are scanned for keys. */
  readonly scanDepth?: number;
}

export interface Persona {
  readonly id: string;
  readonly kind: PersonaKind;
  readonly name: string;
  /** Short line shown in lists and the marketplace. */
  readonly tagline: string;
  /** Data URI or object URL for the avatar. */
  readonly avatar?: string;
  /** Deterministic fallback avatar seed when no image is set. */
  readonly avatarSeed: string;

  /* ── Character Card v2 fields ─────────────────────────────────────── */
  readonly description: string;
  readonly personality?: string;
  readonly scenario?: string;
  readonly firstMessage?: string;
  readonly alternateGreetings?: readonly string[];
  readonly exampleDialogue?: string;
  readonly systemPrompt?: string;
  /** Injected after the conversation history, just before generation. */
  readonly postHistoryInstructions?: string;
  readonly characterBook?: CharacterBook;

  /* ── Assistant-style fields ───────────────────────────────────────── */
  /** Preferred model id; the router falls back if it is not installed. */
  readonly preferredModelId?: string;
  /** Sampler overrides applied on top of the model's saved settings. */
  readonly sampler?: Partial<SamplerSettings>;
  /** Tool ids this persona is allowed to call. */
  readonly tools?: readonly string[];
  /** Capabilities the persona needs; used to filter the model picker. */
  readonly requires?: readonly Capability[];
  /** Whether reasoning traces should be shown by default in this persona. */
  readonly showThinking?: boolean;
  /** Provider, tool-policy and provenance preferences (#7). Optional and
   * additive: everything above still works with this absent. */
  readonly agentConfig?: PersonaAgentConfig;

  /* ── Provenance ───────────────────────────────────────────────────── */
  readonly creator?: string;
  readonly version: number;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Set for personas obtained from the marketplace. */
  readonly listingId?: string;
  /** Built-in personas cannot be deleted, only duplicated. */
  readonly builtin?: boolean;
}

export type PersonaDraft = Omit<Persona, 'id' | 'createdAt' | 'updatedAt' | 'version'> &
  Partial<Pick<Persona, 'id' | 'createdAt' | 'updatedAt' | 'version'>>;

/**
 * Compose a persona into the system prompt actually sent to the model.
 * Placeholders follow the Character Card convention: {{char}} and {{user}}.
 */
export function renderSystemPrompt(persona: Persona, userName = 'User'): string {
  const substitute = (text: string): string =>
    text.replaceAll('{{char}}', persona.name).replaceAll('{{user}}', userName);

  const parts: string[] = [];

  if (persona.systemPrompt?.trim()) {
    parts.push(substitute(persona.systemPrompt.trim()));
  } else if (persona.kind === 'character') {
    parts.push(
      `You are ${persona.name}. Stay in character. Never break the fourth wall or mention that you are an AI model.`,
    );
  }

  if (persona.description.trim()) {
    parts.push(
      persona.kind === 'character'
        ? `## ${persona.name}\n${substitute(persona.description.trim())}`
        : substitute(persona.description.trim()),
    );
  }

  if (persona.personality?.trim()) {
    parts.push(`## Personality\n${substitute(persona.personality.trim())}`);
  }

  if (persona.scenario?.trim()) {
    parts.push(`## Scenario\n${substitute(persona.scenario.trim())}`);
  }

  if (persona.exampleDialogue?.trim()) {
    parts.push(`## Example dialogue\n${substitute(persona.exampleDialogue.trim())}`);
  }

  return parts.join('\n\n');
}

/**
 * Select lore entries to inject for the current conversation tail.
 * Constant entries always apply; keyed entries apply when a key appears in
 * the scanned text. Selection is priority-ordered and budget-bounded.
 */
export function selectLore(
  book: CharacterBook | undefined,
  recentText: string,
  budgetChars = 2000,
): LoreEntry[] {
  if (!book || book.entries.length === 0) return [];

  const haystackLower = recentText.toLowerCase();
  const matched = book.entries.filter((entry) => {
    if (!entry.enabled) return false;
    if (entry.constant) return true;
    return entry.keys.some((key) => {
      const needle = key.trim();
      if (!needle) return false;
      return entry.caseSensitive
        ? recentText.includes(needle)
        : haystackLower.includes(needle.toLowerCase());
    });
  });

  matched.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const chosen: LoreEntry[] = [];
  let used = 0;
  for (const entry of matched) {
    const cost = entry.content.length;
    if (used + cost > budgetChars) continue;
    chosen.push(entry);
    used += cost;
  }
  return chosen;
}

/** Render selected lore as a single system-message addendum. */
export function renderLore(entries: readonly LoreEntry[]): string {
  if (entries.length === 0) return '';
  return `## Relevant background\n${entries.map((entry) => entry.content.trim()).join('\n\n')}`;
}

/* ══ Character Card v2 interchange ═════════════════════════════════════ */

interface CharacterCardV2Data {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  alternate_greetings?: string[];
  tags?: string[];
  creator?: string;
  character_version?: string;
  character_book?: {
    name?: string;
    entries?: {
      keys?: string[];
      content?: string;
      constant?: boolean;
      enabled?: boolean;
      insertion_order?: number;
      case_sensitive?: boolean;
    }[];
    token_budget?: number;
    scan_depth?: number;
  };
  /** Third-party extensions, namespaced by app. Unknown keys pass through
   * untouched on export; only `chatterang` is ever read on import, and only
   * once it passes {@link sanitizeAgentConfig}. */
  extensions?: {
    chatterang?: ChatterangCardExtension;
    [namespace: string]: unknown;
  };
}

export interface CharacterCardV2 {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: CharacterCardV2Data;
}

/** Import a Character Card v2 object into a persona draft. */
export function fromCharacterCard(card: CharacterCardV2): PersonaDraft {
  const data = card.data ?? {};
  const name = data.name?.trim() || 'Unnamed character';

  const book = data.character_book;
  const characterBook: CharacterBook | undefined = book?.entries?.length
    ? {
        name: book.name,
        tokenBudget: book.token_budget,
        scanDepth: book.scan_depth,
        entries: book.entries.map((entry, index) => ({
          id: `lore_${index}`,
          keys: entry.keys ?? [],
          content: entry.content ?? '',
          constant: entry.constant ?? false,
          priority: entry.insertion_order ?? 0,
          enabled: entry.enabled ?? true,
          caseSensitive: entry.case_sensitive ?? false,
        })),
      }
    : undefined;

  // Only OUR namespace is ever read, and only once it passes sanitization —
  // a card from another app that has its own `extensions.someOtherApp` (or
  // no `extensions` at all) must import with `agentConfig` absent, not
  // invented from whatever else happens to be in that block.
  const agentConfig = sanitizeAgentConfig(data.extensions?.chatterang?.agentConfig);

  return {
    kind: 'character',
    name,
    tagline: (data.creator_notes ?? data.personality ?? '').slice(0, 120),
    avatarSeed: name,
    description: data.description ?? '',
    personality: data.personality,
    scenario: data.scenario,
    firstMessage: data.first_mes,
    alternateGreetings: data.alternate_greetings ?? [],
    exampleDialogue: data.mes_example,
    systemPrompt: data.system_prompt,
    postHistoryInstructions: data.post_history_instructions,
    characterBook,
    creator: data.creator,
    tags: data.tags ?? [],
    showThinking: false,
    agentConfig,
  };
}

/** Export a persona back to Character Card v2 for sharing. */
export function toCharacterCard(persona: Persona): CharacterCardV2 {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: persona.name,
      description: persona.description,
      personality: persona.personality,
      scenario: persona.scenario,
      first_mes: persona.firstMessage,
      mes_example: persona.exampleDialogue,
      system_prompt: persona.systemPrompt,
      post_history_instructions: persona.postHistoryInstructions,
      alternate_greetings: [...(persona.alternateGreetings ?? [])],
      creator_notes: persona.tagline,
      tags: [...persona.tags],
      creator: persona.creator,
      character_version: String(persona.version),
      character_book: persona.characterBook
        ? {
            name: persona.characterBook.name,
            token_budget: persona.characterBook.tokenBudget,
            scan_depth: persona.characterBook.scanDepth,
            entries: persona.characterBook.entries.map((entry) => ({
              keys: [...entry.keys],
              content: entry.content,
              constant: entry.constant ?? false,
              enabled: entry.enabled,
              insertion_order: entry.priority ?? 0,
              case_sensitive: entry.caseSensitive ?? false,
            })),
          }
        : undefined,
      // Namespaced and schema-tagged, so a future schema change to this
      // extension can tell its own shape apart from whatever v1 wrote, and so
      // this app never reads or overwrites another app's extension block.
      extensions: persona.agentConfig
        ? { chatterang: { schemaVersion: 1, agentConfig: persona.agentConfig } }
        : undefined,
    },
  };
}
