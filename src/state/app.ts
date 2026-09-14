/**
 * App-wide state: device capabilities, theme, settings, toasts, and the
 * single `ChatterangEngine` instance every feature routes through.
 */

import { create } from 'zustand';

import { ChatterangEngine } from '@/ai/engine';
import type { FallbackEvent } from '@/ai/middleware/resilience';
import { LlamaCpp, type DeviceCapabilities, type ThermalState } from '@/plugins/llama-cpp';
import { db, readSetting, writeSetting } from '@/db';
import type { ProviderConnection } from '@/ai/providers';
import { DEFAULT_SAMPLER, type ModelManifest, type SamplerSettings } from '@/domain/manifest';
import { newId } from '@/domain/chat';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type VoiceMode = 'os' | 'neural' | 'off';

export interface Settings {
  theme: ThemeChoice;
  /** Hugging Face token for gated repositories. */
  hfToken: string;
  /** Read replies aloud, and with which strategy (PRD §3.3). */
  voiceMode: VoiceMode;
  /** Voice id for the chosen strategy. */
  voiceId: string;
  speechRate: number;
  /** Backend id used when the device cannot serve locally. Null disables it. */
  fallbackBackendId: string | null;
  /** Show reasoning traces by default. */
  showThinking: boolean;
  /** Opt-in benchmark publishing (PRD §3.6). Off unless explicitly enabled. */
  leaderboardOptIn: boolean;
  /** Whether the user has seen and answered the telemetry consent screen. */
  telemetryConsentSeen: boolean;
  /** Send anonymous crash reports. */
  crashReports: boolean;
  /** Render markdown in assistant replies. */
  renderMarkdown: boolean;
  /** Haptic feedback on send and completion. */
  haptics: boolean;
  /** Show the development-shim banner when running in a browser. */
  dismissedShimNotice: boolean;
  /** Set once the first-run sheet has been shown, whichever way it was dismissed. */
  onboardingSeen: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  hfToken: '',
  voiceMode: 'off',
  voiceId: '',
  speechRate: 1,
  fallbackBackendId: null,
  showThinking: true,
  leaderboardOptIn: false,
  telemetryConsentSeen: false,
  crashReports: false,
  renderMarkdown: true,
  haptics: true,
  dismissedShimNotice: false,
  onboardingSeen: false,
};

/**
 * Extra shape for an approval that is not a plain "the model wants to X".
 *
 * The egress sheet needs a heading of its own, a list of what would be sent,
 * and a second affirmative — "for this conversation" beside "this turn".
 * Everything is optional, so the shell's existing one-line confirmations are
 * unchanged.
 */
export interface ApprovalPrompt {
  readonly title?: string;
  readonly body?: string;
  readonly detail?: readonly string[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /**
   * Label for a broader yes. Choosing it resolves the approval `true` and
   * calls {@link onExtended} — so a caller that does not care about the
   * difference still gets a boolean.
   */
  readonly extendedLabel?: string;
  readonly onExtended?: () => void;
}

/** A confirmation the model has asked for and the user has not answered yet. */
export interface PendingApproval extends ApprovalPrompt {
  readonly id: string;
  readonly action: string;
  readonly resolve: (approved: boolean) => void;
}

export type ToastTone = 'info' | 'good' | 'warn' | 'crit';

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
  /** Optional inline action, e.g. "Undo". */
  action?: { label: string; run: () => void };
}

/** What the instrument rail is currently reporting. */
export type EngineActivity = 'idle' | 'loading' | 'running' | 'remote' | 'throttled';

interface AppState {
  ready: boolean;
  settings: Settings;
  device: DeviceCapabilities | null;
  thermal: ThermalState | null;
  connections: ProviderConnection[];
  toasts: Toast[];
  /** Queued confirmations from the model's shell tool. */
  approvals: PendingApproval[];
  activity: EngineActivity;
  /** Live tokens-per-second while generating, for the rail readout. */
  liveRate: number | null;
  engine: ChatterangEngine | null;

  initialize: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  setActivity: (activity: EngineActivity) => void;
  setLiveRate: (rate: number | null) => void;
  refreshThermal: () => Promise<void>;

  addConnection: (connection: ProviderConnection) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  toggleConnection: (id: string, enabled: boolean) => Promise<void>;

  toast: (message: string, tone?: ToastTone, action?: Toast['action']) => void;
  dismissToast: (id: string) => void;
  /** Ask the user to approve something the model wants to do. */
  requestApproval: (action: string, prompt?: ApprovalPrompt) => Promise<boolean>;
  answerApproval: (id: string, approved: boolean) => void;
}

/**
 * Resolver bridging the model store into the llama.cpp adapter. The indirection
 * keeps the adapter free of any store import, so it stays unit-testable.
 */
export interface ResolverHooks {
  getManifest: (id: string) => ModelManifest | null;
  getPath: (id: string, role?: 'model' | 'mmproj' | 'draft') => string | null;
  getSampler: (id: string) => SamplerSettings;
}

let resolverHooks: ResolverHooks = {
  getManifest: () => null,
  getPath: () => null,
  getSampler: () => DEFAULT_SAMPLER,
};

/** Called once by the model store so the engine can resolve installed models. */
export function installResolver(hooks: ResolverHooks): void {
  resolverHooks = hooks;
}

/**
 * Drop every conversation's tool-output grant for a connection.
 *
 * A no-op until the chat store installs the real one. Registered rather than
 * imported for the same reason `installResolver` is: the chat store already
 * depends on this module, and importing it back — even dynamically — is a
 * cycle `tests/layering.test.ts` rejects.
 *
 * It is wired to connection removal and to switching a connection off for the
 * same reason `fallbackBackendId` is cleared there: a permission that outlived
 * the connection it named would silently apply to whatever next claimed that
 * id.
 */
let revokeEgressGrants: (connectionId: string) => Promise<void> = async () => {};

export function installEgressRevoker(revoke: (connectionId: string) => Promise<void>): void {
  revokeEgressGrants = revoke;
}

/**
 * Take one MCP server name's tools out of every chat's enabled list.
 *
 * Registered rather than imported, for the reason given on
 * `installEgressRevoker` above: the chat store depends on this module, and
 * `state/mcp` reaches this module lazily already.
 *
 * An MCP tool's id is keyed on the server's NAME (`mcp:notes.search`, built in
 * `ai/mcp/tools.ts`), not on the server record. So an enable outlives the
 * server it was given to: remove `notes` at one URL, add `notes` at another,
 * and every chat that had turned `notes.search` on would send to the new host
 * without being asked again. `state/mcp` calls this on add and on remove.
 */
let pruneMcpTools: (serverName: string) => Promise<void> = async () => {};

export function installMcpToolPruner(prune: (serverName: string) => Promise<void>): void {
  pruneMcpTools = prune;
}

export async function pruneMcpToolsFor(serverName: string): Promise<void> {
  await pruneMcpTools(serverName);
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  settings: DEFAULT_SETTINGS,
  device: null,
  thermal: null,
  connections: [],
  toasts: [],
  approvals: [],
  activity: 'idle',
  liveRate: null,
  engine: null,

  async initialize() {
    if (get().ready) return;

    const [settings, connections] = await Promise.all([
      readSetting<Settings>('settings', DEFAULT_SETTINGS),
      db.connections.toArray(),
    ]);
    const merged = { ...DEFAULT_SETTINGS, ...settings };

    const device = await LlamaCpp.getCapabilities().catch(() => null);

    const engine = new ChatterangEngine({
      resolver: {
        getManifest: (id) => resolverHooks.getManifest(id),
        getPath: (id, role) => resolverHooks.getPath(id, role),
        getSampler: (id) => resolverHooks.getSampler(id),
      },
      fallbackBackendId: merged.fallbackBackendId,
      onWarning: (message) => get().toast(message, 'warn'),
      onFallback: (event: FallbackEvent) => {
        set({ activity: 'remote' });
        get().toast(
          `Switched to ${event.to} for this reply — ${event.reason.replace('-', ' ')}.`,
          'warn',
        );
      },
      debug: import.meta.env.DEV,
    });

    for (const connection of connections.filter((entry) => entry.enabled)) {
      await engine.connectProvider(connection).catch((error: unknown) => {
        get().toast(
          `Could not connect ${connection.label}: ${error instanceof Error ? error.message : 'unknown error'}`,
          'crit',
        );
      });
    }

    applyTheme(merged.theme);
    set({ ready: true, settings: merged, device, connections, engine });
  },

  async updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    await writeSetting('settings', settings);

    if (patch.theme) applyTheme(patch.theme);
    if (patch.fallbackBackendId !== undefined) {
      get().engine?.setFallbackBackend(patch.fallbackBackendId);
    }
  },

  setActivity(activity) {
    set({ activity });
    if (activity === 'idle') set({ liveRate: null });
  },

  setLiveRate(liveRate) {
    set({ liveRate });
  },

  async refreshThermal() {
    const thermal = await LlamaCpp.getThermalState().catch(() => null);
    set({ thermal });
    if (thermal?.throttled && get().activity === 'running') {
      set({ activity: 'throttled' });
    }
  },

  async addConnection(connection) {
    await db.connections.put(connection);
    set({ connections: [...get().connections, connection] });
    if (connection.enabled) {
      try {
        await get().engine?.connectProvider(connection);
        get().toast(`${connection.label} connected.`, 'good');
      } catch (error) {
        get().toast(
          error instanceof Error ? error.message : 'Could not connect that provider.',
          'crit',
        );
      }
    }
  },

  async removeConnection(id) {
    await db.connections.delete(id);
    get().engine?.disconnectProvider(id);
    set({ connections: get().connections.filter((connection) => connection.id !== id) });

    if (get().settings.fallbackBackendId === id) {
      await get().updateSettings({ fallbackBackendId: null });
    }
    await revokeEgressGrants(id);
  },

  async toggleConnection(id, enabled) {
    const connections = get().connections.map((connection) =>
      connection.id === id ? { ...connection, enabled } : connection,
    );
    const changed = connections.find((connection) => connection.id === id);
    if (!changed) return;

    await db.connections.put(changed);
    set({ connections });

    if (enabled) {
      await get()
        .engine?.connectProvider(changed)
        .catch((error: unknown) =>
          get().toast(error instanceof Error ? error.message : 'Connection failed.', 'crit'),
        );
    } else {
      get().engine?.disconnectProvider(id);
      if (get().settings.fallbackBackendId === id) {
        await get().updateSettings({ fallbackBackendId: null });
      }
      await revokeEgressGrants(id);
    }
  },

  toast(message, tone = 'info', action) {
    const id = newId('toast');
    set({ toasts: [...get().toasts, { id, message, tone, action }] });
    setTimeout(() => get().dismissToast(id), tone === 'crit' ? 8000 : 4500);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
  },

  requestApproval(action, prompt) {
    return new Promise<boolean>((resolve) => {
      const id = newId('ask');
      set({ approvals: [...get().approvals, { id, action, ...prompt, resolve }] });
    });
  },

  answerApproval(id, approved) {
    const approval = get().approvals.find((entry) => entry.id === id);
    approval?.resolve(approved);
    set({ approvals: get().approvals.filter((entry) => entry.id !== id) });
  },
}));


function applyTheme(theme: ThemeChoice): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
