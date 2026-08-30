import { useEffect, useState, type ReactNode } from 'react';

import { Icon, type IconName } from '@/ui/Icon';
import { useApp } from '@/state/app';
import { useModels } from '@/state/models';
import { useChats } from '@/state/chat';
import { usePersonas } from '@/state/personas';
import { useBench } from '@/state/bench';
import { useImages } from '@/state/images';
import { useMcp } from '@/state/mcp';

import { ChatScreen } from '@/features/chat/ChatScreen';
import { ModelsScreen } from '@/features/models/ModelsScreen';
import { PersonasScreen } from '@/features/personas/PersonasScreen';
import { StudioScreen } from '@/features/studio/StudioScreen';
import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { Toasts } from '@/features/shell/Toasts';
import { ShimNotice } from '@/features/shell/ShimNotice';
import { ApprovalGate } from '@/features/shell/ApprovalGate';

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

  // The rail's thermal readout is only meaningful if it is actually sampled.
  useEffect(() => {
    if (!ready) return undefined;
    const timer = setInterval(() => void refreshThermal(), 6000);
    return () => clearInterval(timer);
  }, [ready, refreshThermal]);

  if (!ready) return <Splash />;

  return (
    <div className="app">
      <ShimNotice />
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
