/**
 * Remote provider catalog (PRD §3.5).
 *
 * Every remote provider is an aimatey backend adapter, loaded on demand. No
 * connectivity code is reimplemented here — which is precisely the point:
 * covering this provider list through aimatey rather than by adapting
 * AGPL-licensed source is what keeps the codebase permissively licensed
 * (PRD §5, §6).
 *
 * Adapters are dynamically imported from per-provider subpaths so a user who
 * only ever runs models locally never downloads any of this code.
 */

import type { ApiKeyBackendAdapterConfig, BackendAdapter } from '@johnhenry/aimatey-types';

export type ProviderKind = 'cloud' | 'self-hosted' | 'aggregator';

/** Part of a note: plain words, or a value to type exactly, shown as code. */
export type NotePart = string | { readonly code: string };

export interface ProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  /** One honest line about what connecting this means. */
  readonly note: string;
  /**
   * The rest of the note, when it depends on the origin this page runs at. The
   * panel passes `window.location.origin`, read when the note renders, because
   * that origin differs by platform. Null when there is nothing to add for that
   * origin. Only Ollama sets it (#284).
   */
  readonly originNote?: (origin: string) => readonly NotePart[] | null;
  /** Whether an API key is required to connect. */
  readonly needsKey: boolean;
  /** Whether the user supplies the endpoint (self-hosted servers). */
  readonly needsBaseUrl: boolean;
  readonly defaultBaseUrl?: string;
  readonly defaultModel?: string;
  /** Direct browser calls need an explicit opt-in header on some providers. */
  readonly browserMode?: boolean;
  /**
   * Every adapter here is constructed from a connection the user configured, and
   * `ProviderConnection.apiKey` is a `string` — empty for the self-hosted ones,
   * never absent. So the narrower config is always what we actually have.
   *
   * aimatey 0.3.0 (ai.matey#104) made `apiKey` optional on the base config and
   * required on the adapters that authenticate with one. Declaring the loose
   * type here made those eight call sites unassignable while claiming less than
   * we know: `needsKey` already says which providers need a key, and the type
   * said nothing.
   */
  load(config: ApiKeyBackendAdapterConfig): Promise<BackendAdapter>;
}

/** Providers surfaced in Settings, ordered by how people actually reach for them. */
export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'self-hosted',
    note: 'A model server on your own machine or network. Requests go to the address you give. Nothing here checks that it is on your network.',
    originNote(origin) {
      const setting = ollamaOriginsSetting(origin);
      if (setting.kind === 'none-needed') return null;
      if (setting.kind === 'unknown') {
        return [
          'This app cannot tell which origin it sends, so it cannot say what, if anything, Ollama’s ',
          { code: 'OLLAMA_ORIGINS' },
          ' setting needs.',
        ];
      }
      return [
        'Ollama refuses this app until its ',
        { code: 'OLLAMA_ORIGINS' },
        ' setting allows it. Add ',
        { code: setting.value },
        ' to that setting.',
        // Ruled on #284: iOS shows the value and says it is shared. Every
        // default-configured Capacitor iOS app sends this same origin, so no
        // value admits this app there alone. Only that exact origin says so.
        ...(origin === CAPACITOR_IOS_DEFAULT_ORIGIN ? [` ${OLLAMA_SHARED_ORIGIN_SENTENCE}`] : []),
        ' If it already has a value, put a comma between them, with no spaces.',
        // Ruled on #284: every shown value says to quote it. A value holding `*`,
        // typed unquoted as a command argument in zsh (Ollama's FAQ sets its
        // variables on macOS with `launchctl setenv`), stops the command with "no
        // matches found". A zsh assignment, `export NAME=value` included, keeps it.
        ` ${OLLAMA_QUOTE_SENTENCE}`,
        ' Restart Ollama for the change to take effect.',
      ];
    },
    needsKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434',
    defaultModel: 'llama3.2',
    async load(config) {
      const { OllamaBackendAdapter } = await import('@johnhenry/aimatey-backend/ollama');
      return new OllamaBackendAdapter(config);
    },
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'self-hosted',
    note: 'LM Studio’s local server. Requests go to the address you give. Nothing here checks that it is on your network.',
    needsKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: 'http://localhost:1234/v1',
    async load(config) {
      const { LMStudioBackendAdapter } = await import('@johnhenry/aimatey-backend/lmstudio');
      return new LMStudioBackendAdapter(config);
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'cloud',
    note: 'Conversations you send here leave your device and reach OpenAI’s servers.',
    needsKey: true,
    needsBaseUrl: false,
    defaultModel: 'gpt-4o-mini',
    browserMode: true,
    async load(config) {
      const { OpenAIBackendAdapter } = await import('@johnhenry/aimatey-backend/openai');
      return new OpenAIBackendAdapter(config);
    },
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'cloud',
    note: 'Conversations you send here leave your device and reach Anthropic’s servers.',
    needsKey: true,
    needsBaseUrl: false,
    defaultModel: 'claude-sonnet-4-5',
    browserMode: true,
    async load(config) {
      const { AnthropicBackendAdapter } = await import('@johnhenry/aimatey-backend/anthropic');
      return new AnthropicBackendAdapter(config);
    },
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'cloud',
    note: 'Conversations you send here leave your device and reach Google’s servers.',
    needsKey: true,
    needsBaseUrl: false,
    async load(config) {
      const { GeminiBackendAdapter } = await import('@johnhenry/aimatey-backend/gemini');
      return new GeminiBackendAdapter(config);
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'aggregator',
    note: 'Routes your request on to whichever provider serves the model you pick.',
    needsKey: true,
    needsBaseUrl: false,
    browserMode: true,
    async load(config) {
      const { OpenRouterBackendAdapter } = await import('@johnhenry/aimatey-backend/openrouter');
      return new OpenRouterBackendAdapter(config);
    },
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'cloud',
    note: 'Very fast hosted inference for open models. Requests leave your device.',
    needsKey: true,
    needsBaseUrl: false,
    async load(config) {
      const { GroqBackendAdapter } = await import('@johnhenry/aimatey-backend/groq');
      return new GroqBackendAdapter(config);
    },
  },
  {
    id: 'cohere',
    label: 'Cohere',
    kind: 'cloud',
    note: 'Conversations you send here leave your device and reach Cohere’s servers.',
    needsKey: true,
    needsBaseUrl: false,
    async load(config) {
      const { CohereBackendAdapter } = await import('@johnhenry/aimatey-backend/cohere');
      return new CohereBackendAdapter(config);
    },
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'cloud',
    note: 'Conversations you send here leave your device and reach Mistral’s servers.',
    needsKey: true,
    needsBaseUrl: false,
    async load(config) {
      const { MistralBackendAdapter } = await import('@johnhenry/aimatey-backend/mistral');
      return new MistralBackendAdapter(config);
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'cloud',
    note: 'Conversations you send here leave your device and reach DeepSeek’s servers.',
    needsKey: true,
    needsBaseUrl: false,
    async load(config) {
      const { DeepSeekBackendAdapter } = await import('@johnhenry/aimatey-backend/deepseek');
      return new DeepSeekBackendAdapter(config);
    },
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    kind: 'cloud',
    note: 'Hosted inference for open models. Requests leave your device.',
    needsKey: true,
    needsBaseUrl: false,
    async load(config) {
      const { HuggingFaceBackendAdapter } = await import('@johnhenry/aimatey-backend/huggingface');
      return new HuggingFaceBackendAdapter(config);
    },
  },
  {
    id: 'together-ai',
    label: 'Together AI',
    kind: 'cloud',
    note: 'Hosted open models. Requests leave your device.',
    needsKey: true,
    needsBaseUrl: false,
    async load(config) {
      const { TogetherAIBackendAdapter } = await import('@johnhenry/aimatey-backend/together-ai');
      return new TogetherAIBackendAdapter(config);
    },
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    kind: 'cloud',
    note: 'Your question leaves your device, reaches Perplexity, and is also used to run web searches.',
    needsKey: true,
    needsBaseUrl: false,
    async load(config) {
      const { PerplexityBackendAdapter } = await import('@johnhenry/aimatey-backend/perplexity');
      return new PerplexityBackendAdapter(config);
    },
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    kind: 'self-hosted',
    note: 'Any server that speaks the OpenAI chat API — koboldcpp, text-generation-webui, a proxy of your own.',
    needsKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: 'http://localhost:5001/v1',
    async load(config) {
      const { OpenAIBackendAdapter } = await import('@johnhenry/aimatey-backend/openai');
      return new OpenAIBackendAdapter(config, {
        name: 'custom',
        provider: 'Custom endpoint',
      });
    },
  },
];

/**
 * What Ollama's `OLLAMA_ORIGINS` has to hold before it answers a page at `origin`.
 *
 * The owner's ruling on #284: the Ollama note shows the narrowest value that
 * still lets Ollama start, and only where one is needed. Measured against a
 * throwaway `ollama serve` 0.34.0, one process per value
 * (`dev/probe-electron-csp-http/README.md`):
 *
 * - Ollama already answers its default origins with nothing set, so for those
 *   the note asks for nothing.
 * - A value starting `http://` or `https://` starts, and an exact one admits
 *   that origin alone, so an http(s) origin is its own value.
 * - An exact value makes Ollama panic before it listens unless it starts with
 *   one of the schemes its startup check lists: `http://`, `https://` and four
 *   browser-extension schemes. `chatterang-desktop://app`,
 *   `capacitor://localhost` and `httpx://host` all panic. A value with one `*`
 *   starts, and where the `*` sits decides what else it admits:
 *   - a leading `*` (`*chatterang-desktop://app`) matches a suffix, so it also
 *     admits `xchatterang-desktop://app` and `evil.chatterang-desktop://app`;
 *   - a trailing `*` matches a prefix, so it also admits
 *     `chatterang-desktop://app-evil`;
 *   - a `*` right after the scheme's colon (`chatterang-desktop:`, then `*`, then
 *     `//app`, written as one word) needs the origin to start with
 *     `chatterang-desktop:` and end with `//app`. A host
 *     cannot contain `/`, so that fixes the scheme, the host and the port, and of
 *     the origins a browser sends only this app's own matches. The look-alikes
 *     above were all refused.
 *   So every origin outside http(s) gets the middle form. For the extension
 *   schemes an exact value would also start, but it admits no other origin a
 *   browser sends either, so one rule covers them.
 * - Anything that is not exactly a serialized origin (opaque `null`, a path, a
 *   comma, a `*`, a non-canonical form) gets no value. A comma would split into
 *   two entries, and a `*` would widen the match, so printing a guess could
 *   stop Ollama starting or admit more than this app. It fails closed.
 */
export type OllamaOriginsSetting =
  | { readonly kind: 'none-needed' }
  | { readonly kind: 'add'; readonly value: string }
  | { readonly kind: 'unknown' };

/**
 * The origin every Capacitor iOS app is served from unless it sets its own
 * `server.iosScheme` or `server.hostname`, and this app sets neither
 * (`capacitor.config.ts`). The value it needs is the middle form (`capacitor:`,
 * then `*`, then `//localhost`, written as one word). It admits this app and
 * refused every look-alike measured, but it cannot tell this app from another
 * default-configured Capacitor iOS app.
 */
const CAPACITOR_IOS_DEFAULT_ORIGIN = 'capacitor://localhost';

/** Said beside the value only at `CAPACITOR_IOS_DEFAULT_ORIGIN` (#284). */
const OLLAMA_SHARED_ORIGIN_SENTENCE =
  'Other iOS apps built on the same framework send the same origin as this app by default, so this value also lets them reach Ollama if they can reach the machine it runs on.';

/**
 * Said with every value shown (#284). Platform-neutral: the value contains `*`
 * wherever the origin is not http(s). zsh, macOS's default shell, expands an
 * unquoted `*` in a command argument, such as `launchctl setenv`, the form
 * Ollama's FAQ gives for macOS, and fails with "no matches found". A zsh
 * assignment, `export NAME=value` included, does not expand it.
 */
const OLLAMA_QUOTE_SENTENCE = 'If you set it from a shell, put the value in quotes.';

/**
 * Ollama 0.34.0's defaults, as its `server config` log line lists them with
 * `OLLAMA_ORIGINS` unset. A value the user sets is added ahead of these, not in
 * place of them.
 */
const OLLAMA_DEFAULT_ORIGINS: readonly string[] = [
  ...['localhost', '127.0.0.1', '0.0.0.0'].flatMap((host) => [
    `http://${host}`,
    `https://${host}`,
    `http://${host}:*`,
    `https://${host}:*`,
  ]),
  'app://*',
  'file://*',
  'tauri://*',
  'vscode-webview://*',
  'vscode-file://*',
];

/** Scheme, host (a name or a bracketed IPv6 address) and optional port; nothing else. */
const SERIALIZED_ORIGIN = /^([a-z][a-z0-9+.-]*):\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

/** How Ollama's CORS middleware matches one entry: exact, or around one `*`. */
function ollamaEntryAdmits(entry: string, origin: string): boolean {
  const star = entry.indexOf('*');
  if (star === -1) return entry === origin;
  const head = entry.slice(0, star);
  const tail = entry.slice(star + 1);
  return (
    origin.length >= head.length + tail.length && origin.startsWith(head) && origin.endsWith(tail)
  );
}

export function ollamaOriginsSetting(origin: string): OllamaOriginsSetting {
  const shape = SERIALIZED_ORIGIN.exec(origin);
  if (!shape) return { kind: 'unknown' };
  // Canonical or nothing: `http://localhost:80` or `http://0x7f.1` is not what a
  // browser sends, so an exact value built from it would match nothing.
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { kind: 'unknown' };
  }
  if (`${url.protocol}//${url.host}` !== origin) return { kind: 'unknown' };

  if (OLLAMA_DEFAULT_ORIGINS.some((entry) => ollamaEntryAdmits(entry, origin))) {
    return { kind: 'none-needed' };
  }
  const scheme = shape[1];
  if (scheme === 'http' || scheme === 'https') return { kind: 'add', value: origin };
  // `scheme:`, then the `*`, then `//host[:port]`: see the rule above. The
  // canonical check made `${url.protocol}//${url.host}` the origin itself.
  return { kind: 'add', value: `${url.protocol}*//${url.host}` };
}

export function getProvider(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** A provider the user has configured and enabled. */
export interface ProviderConnection {
  readonly id: string;
  readonly providerId: string;
  readonly label: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly enabled: boolean;
  /** Models the user has pinned for quick selection. */
  readonly models: readonly string[];
  readonly createdAt: number;
}

export function connectionConfig(connection: ProviderConnection): ApiKeyBackendAdapterConfig {
  const descriptor = getProvider(connection.providerId);
  return {
    apiKey: connection.apiKey,
    baseURL: connection.baseUrl || descriptor?.defaultBaseUrl,
    defaultModel: connection.defaultModel || descriptor?.defaultModel,
    browserMode: descriptor?.browserMode ?? false,
    timeout: 120_000,
    models: connection.models.length > 0 ? [...connection.models] : undefined,
  };
}
