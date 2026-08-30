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
    },
  };
}
