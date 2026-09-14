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
  /**
   * Where this window's generation stands in the desktop's shared wait list
   * (#7): 1 is next, null when it is not waiting. Only the desktop reports it.
   */
  turnWaiting: number | null;
  engine: ChatterangEngine | null;

  initialize: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  setActivity: (activity: EngineActivity) => void;
  setLiveRate: (rate: number | null) => void;
  setTurnWaiting: (position: number | null) => void;
  refreshThermal: () => Promise<void>;

  addConnection: (connection: ProviderConnection) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  toggleConnection: (id: string, enabled: boolean) => Promise<void>;

  toast: (message: string, tone?: ToastTone, action?: Toast['action']) => void;
  dismissToast: (id: string) => void;
  /**
   * Ask the user to approve something the model wants to do.
   *
   * `signal` is the asking turn's. Once it aborts the sheet is taken down and
   * the answer is no; a caller that must tell that no from a person's reads
   * `signal.aborted`.
   */
  requestApproval: (action: string, prompt?: ApprovalPrompt, signal?: AbortSignal) => Promise<boolean>;
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
 *
 * UNLIKE THE REVOKER, THE UNINSTALLED DEFAULT THROWS. `state/mcp` does not
 * import the chat store, so a surface that loaded MCP settings without it
 * would otherwise add and remove servers with a prune that did nothing — the
 * bypass above, reopened while the remove sheet still says the tools left
 * every chat. Refusing makes `add` fail before the server is stored, and
 * `remove` say so.
 */
let pruneMcpTools: (serverName: string) => Promise<void> = async () => {
  throw new Error('MCP tools cannot be switched off in chats: the chat store is not loaded.');
};

export function installMcpToolPruner(prune: (serverName: string) => Promise<void>): void {
  pruneMcpTools = prune;
}

export async function pruneMcpToolsFor(serverName: string): Promise<void> {
  await pruneMcpTools(serverName);
}

/**
 * Drop every conversation's grant to send to one MCP server (#6).
 *
 * Registered for the reason the two hooks above are, and called when a server
 * is removed or switched off, as `revokeEgressGrants` is for a connection: a
 * permission that outlived its server being switched off would apply again the
 * moment it came back on, without being asked for.
 *
 * The uninstalled default THROWS, as the pruner's does. A removal that silently
 * kept every grant would leave the remove sheet's promise false.
 */
let revokeMcpGrants: (serverId: string) => Promise<void> = async () => {
  throw new Error('MCP grants cannot be withdrawn: the chat store is not loaded.');
};

export function installMcpGrantRevoker(revoke: (serverId: string) => Promise<void>): void {
  revokeMcpGrants = revoke;
}

export async function revokeMcpGrantsFor(serverId: string): Promise<void> {
  await revokeMcpGrants(serverId);
}

/**
 * Tell the chat store a connection, or an MCP server, has been switched on.
 *
 * Registered for the reason the hooks above are. At launch the chat store
 * withdraws every grant on disk that names a connection or server that was
 * missing or off — left there by a withdrawal the app was killed in — and
 * counts that withdrawal as under way until its writes have landed, so a yes
 * given meanwhile to one of those goes with it (`launchWithdrawals` in
 * state/chat.ts). A person who switched it back on in that time and was then
 * asked said yes to something that is there, and that yes was withdrawn too.
 *
 * The uninstalled defaults do nothing: without the chat store there is no
 * launch withdrawal to end.
 */
let connectionSwitchedOn: (connectionId: string) => void = () => {};

export function installConnectionSwitchedOn(notice: (connectionId: string) => void): void {
  connectionSwitchedOn = notice;
}

let mcpServerSwitchedOn: (serverId: string) => void = () => {};

export function installMcpServerSwitchedOn(notice: (serverId: string) => void): void {
  mcpServerSwitchedOn = notice;
}

export function noticeMcpServerSwitchedOn(serverId: string): void {
  mcpServerSwitchedOn(serverId);
}

/**
 * What follows disconnecting a connection that was removed or switched off: its
 * grants withdrawn, and the fallback cleared if it was the fallback.
 *
 * THE WITHDRAWAL STARTS FIRST, before the settings write is awaited. It used to
 * wait for it, and until a withdrawal starts nothing says an answer a running
 * turn holds for this connection is stale (`withdrawals` in state/chat.ts).
 * Switching the connection back on during that write registers the same id,
 * and the next request carried tool output to it under that answer, unasked —
 * measured through the real store and engine, for a "this turn" answer and a
 * conversation one. Starting it here counts it at once; the settings write and
 * the withdrawal's own writes then finish in either order.
 */
async function afterDisconnecting(get: () => AppState, id: string): Promise<void> {
  const withdrawn = revokeEgressGrants(id);
  // Awaited below whatever the settings write does. Marked handled now, so a
  // withdrawal that fails while that write is still running is not reported as
  // unhandled before it is awaited.
  void withdrawn.catch(() => {});
  try {
    if (get().settings.fallbackBackendId === id) {
      await get().updateSettings({ fallbackBackendId: null });
    }
  } finally {
    await withdrawn;
  }
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
  turnWaiting: null,
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
      onWaiting: (event) => get().setTurnWaiting(event.position > 0 ? event.position : null),
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

  setTurnWaiting(turnWaiting) {
    set({ turnWaiting });
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
    await afterDisconnecting(get, id);
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
      connectionSwitchedOn(id);
      await get()
        .engine?.connectProvider(changed)
        .catch((error: unknown) =>
          get().toast(error instanceof Error ? error.message : 'Connection failed.', 'crit'),
        );
    } else {
      get().engine?.disconnectProvider(id);
      await afterDisconnecting(get, id);
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

  requestApproval(action, prompt, signal) {
    return new Promise<boolean>((resolve) => {
      // A turn already stopped raises nothing.
      if (signal?.aborted) {
        resolve(false);
        return;
      }
      const id = newId('ask');
      // STOP TAKES THE SHEET DOWN (#92, owner ruling OD7). The turn that asked
      // is over: a sheet left on screen would ask about something that can no
      // longer happen, and until someone answered it the turn could not end.
      // Only this approval goes; another turn's stays where it is.
      const dismiss = (): void => {
        set({ approvals: get().approvals.filter((entry) => entry.id !== id) });
        resolve(false);
      };
      signal?.addEventListener('abort', dismiss, { once: true });
      const answered = (approved: boolean): void => {
        signal?.removeEventListener('abort', dismiss);
        resolve(approved);
      };
      set({ approvals: [...get().approvals, { id, action, ...prompt, resolve: answered }] });
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
