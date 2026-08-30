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

import type { BackendAdapter, BackendAdapterConfig } from '@johnhenry/aimatey-types';

export type ProviderKind = 'cloud' | 'self-hosted' | 'aggregator';

export interface ProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  /** One honest line about what connecting this means. */
  readonly note: string;
  /** Whether an API key is required to connect. */
  readonly needsKey: boolean;
  /** Whether the user supplies the endpoint (self-hosted servers). */
  readonly needsBaseUrl: boolean;
  readonly defaultBaseUrl?: string;
  readonly defaultModel?: string;
  /** Direct browser calls need an explicit opt-in header on some providers. */
  readonly browserMode?: boolean;
  load(config: BackendAdapterConfig): Promise<BackendAdapter>;
}

/** Providers surfaced in Settings, ordered by how people actually reach for them. */
export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'self-hosted',
    note: 'A model server on your own machine or network. Requests stay inside your network.',
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
    note: 'LM Studio’s local server. Requests stay inside your network.',
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

export function connectionConfig(connection: ProviderConnection): BackendAdapterConfig {
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
