import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Icon, type IconName } from '@/ui/Icon';
import { useApp } from '@/state/app';
import { useModels } from '@/state/models';
import { useChats } from '@/state/chat';
import { usePersonas } from '@/state/personas';
import { useBench } from '@/state/bench';
import { useImages } from '@/state/images';
import { useMcp } from '@/state/mcp';
import { Onboarding } from '@/features/onboarding/Onboarding';

import { ChatScreen } from '@/features/chat/ChatScreen';
import { ModelsScreen } from '@/features/models/ModelsScreen';
import { PersonasScreen } from '@/features/personas/PersonasScreen';
import { StudioScreen } from '@/features/studio/StudioScreen';
import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { Toasts } from '@/features/shell/Toasts';
import { ShimNotice } from '@/features/shell/ShimNotice';
import { ApprovalGate } from '@/features/shell/ApprovalGate';
import { installKeyboard, registerCommand, runCommand, type CommandId } from '@/lib/keys';

export type Tab = 'chat' | 'models' | 'personas' | 'studio' | 'settings';

const TABS: readonly { id: Tab; label: string; icon: IconName }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'models', label: 'Models', icon: 'models' },
  { id: 'personas', label: 'Personas', icon: 'personas' },
  { id: 'studio', label: 'Studio', icon: 'studio' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function App(): ReactNode {
  const [tab, setTab] = useState<Tab>('chat');
  const ready = useApp((state) => state.ready);
  const initialize = useApp((state) => state.initialize);
  const refreshThermal = useApp((state) => state.refreshThermal);
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  const installedModels = useModels((state) => state.installed);

  useEffect(() => {
    void (async () => {
      await initialize();
      await Promise.all([
        useModels.getState().load(),
        usePersonas.getState().load(),
        useChats.getState().load(),
        useBench.getState().load(),
        useImages.getState().load(),
        // Connects any enabled MCP servers and registers their tools. Failures
        // are contained in the store's own state — an unreachable server must
        // not stop the app booting.
        useMcp.getState().load(),
      ]);
    })();
  }, [initialize]);

  /*
   * One keydown listener for the whole app, and the door an out-of-page
   * accelerator arrives through. Idempotent, so StrictMode's double mount in
   * development does not stack two listeners and fire every command twice.
   */
  useEffect(() => installKeyboard(), []);

  /*
   * THE CHAT COMMANDS, MADE TRUE ON EVERY TAB.
   *
   * `ChatScreen` is the only registrant of `chat.new`, `chat.next` and
   * `chat.previous`, and `Composer` the only registrant of
   * `chat.focusComposer` — and `App` renders `{tab === 'chat' ? <ChatScreen />
   * : null}`, so all four UNREGISTER the moment the user opens Models,
   * Personas, Studio or Settings. A "New Chat ⌘N" menu item was therefore
   * inert on four of the app's five tabs: the accelerator fired, the command
   * reached the dispatcher, no handler claimed it, and nothing happened. A
   * menu item that silently does nothing four times out of five is worse than
   * one that is greyed out.
   *
   * So this registers a FALLBACK for each of them, at the app level, where the
   * lifetime is the app's. What a menu item means from the Models screen is
   * now decided rather than left to whichever component happens to be mounted:
   * it MOVES YOU TO THE CHAT and then does the thing. That is what a user
   * asking for a new chat from a settings screen means, and it is the only
   * answer that is the same on all five tabs.
   *
   * `tabRef` rather than `tab` in the deps, on purpose: re-registering on
   * every tab change would move these to the TOP of each handler stack, above
   * the screens' own. They must stay a fallback.
   *
   * The re-dispatch is a bounded retry rather than a single `requestAnimation
   * Frame`, because the screen that will claim the command mounts on React's
   * schedule and not the compositor's — one frame is usually enough and is not
   * a guarantee. Each attempt calls back into `runCommand`, where THIS handler
   * declines (the tab is now 'chat') and the real one below it answers; when
   * nothing ever mounts, the retries run out and the command is simply
   * unhandled, which is where it started.
   */
  const tabRef = useRef<Tab>(tab);
  useEffect(() => {
    tabRef.current = tab;
  });

  useEffect(() => {
    const FORWARDED: readonly CommandId[] = [
      'chat.new',
      'chat.focusComposer',
      'chat.next',
      'chat.previous',
    ];
    const forward = (id: CommandId) => (): boolean => {
      // On the chat tab the screen's own handler owns this outright.
      if (tabRef.current === 'chat') return false;
      setTab('chat');
      const retry = (attempts: number): void => {
        if (attempts <= 0 || runCommand(id)) return;
        requestAnimationFrame(() => retry(attempts - 1));
      };
      requestAnimationFrame(() => retry(10));
      return true;
    };
    const offs = FORWARDED.map((id) => registerCommand(id, forward(id)));
    return () => {
      for (const off of offs) off();
    };
  }, []);

  // The rail's thermal readout is only meaningful if it is actually sampled.
  useEffect(() => {
    if (!ready) return undefined;
    const timer = setInterval(() => void refreshThermal(), 6000);
    return () => clearInterval(timer);
  }, [ready, refreshThermal]);

  const showOnboarding =
    ready && !settings.onboardingSeen && Object.keys(installedModels).length === 0;

  if (!ready) return <Splash />;

  return (
    <div className="app">
      <ShimNotice />
      {/*
        Shown once, and only to someone who has nothing installed — a user who
        already has a model does not need to be told how to get one. Dismissing
        it any way sets the flag, so it never reappears and never blocks.
      */}
      <Onboarding
        open={showOnboarding}
        onClose={() => void updateSettings({ onboardingSeen: true })}
      />
      {tab === 'chat' ? <ChatScreen /> : null}
      {tab === 'models' ? <ModelsScreen /> : null}
      {tab === 'personas' ? <PersonasScreen onOpenChat={() => setTab('chat')} /> : null}
      {tab === 'studio' ? <StudioScreen /> : null}
      {tab === 'settings' ? <SettingsScreen /> : null}

      <nav className="tabbar" aria-label="Sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="tabbar__item"
            aria-current={tab === entry.id ? 'page' : undefined}
            onClick={() => setTab(entry.id)}
          >
            <Icon name={entry.icon} size={21} />
            <span className="tabbar__label">{entry.label}</span>
          </button>
        ))}
      </nav>

      <ApprovalGate />
      <Toasts />
    </div>
  );
}

function Splash(): ReactNode {
  return (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        height: '100dvh',
        background: 'var(--ground)',
        gap: 'var(--s-4)',
      }}
    >
      <div style={{ display: 'grid', placeItems: 'center', gap: 'var(--s-3)' }}>
        <div style={{ color: 'var(--ember)' }}>
          <Icon name="flame" size={38} />
        </div>
        <span className="readout">Warming up</span>
      </div>
    </div>
  );
}
