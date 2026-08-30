/**
 * The instrument rail.
 *
 * A persistent, honest readout of what the device is doing: which model is
 * resident, which compute backend it landed on, whether this turn is local or
 * remote, and how fast tokens are actually arriving. The thermal strip
 * underneath encodes engine state as motion.
 *
 * This is the app's signature element, and it is load-bearing rather than
 * decorative: in an app whose whole claim is "this runs on your device", the
 * user is entitled to see that claim being kept.
 */

import { type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { useApp } from '@/state/app';
import { useModels } from '@/state/models';
import { useChats } from '@/state/chat';
import { usageTone } from '@/ai/context';

/** 12400 -> "12.4k". Keeps the readout to a fixed width as it grows. */
function compact(value: number): string {
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
}

const BACKEND_LABEL: Record<string, string> = {
  cpu: 'CPU',
  'gpu-metal': 'Metal',
  'gpu-opencl': 'OpenCL',
  'gpu-vulkan': 'Vulkan',
  'npu-hexagon': 'Hexagon',
};

export interface RailProps {
  title: string;
  actions?: ReactNode;
}

export function Rail({ title, actions }: RailProps): ReactNode {
  const activity = useApp((state) => state.activity);
  const liveRate = useApp((state) => state.liveRate);
  const device = useApp((state) => state.device);
  const activeChatId = useChats((state) => state.activeChatId);
  const chats = useChats((state) => state.chats);
  const context = useChats((state) => state.context);
  const installed = useModels((state) => state.installed);
  const activeModelId = useModels((state) => state.activeModelId);

  const chat = chats.find((entry) => entry.id === activeChatId);
  const modelId = chat?.modelId ?? activeModelId;
  const model = modelId ? installed[modelId] : undefined;

  const thermalState =
    activity === 'running' || activity === 'loading'
      ? 'running'
      : activity === 'remote'
        ? 'remote'
        : activity === 'throttled'
          ? 'throttled'
          : 'idle';

  return (
    <header className="rail">
      <div className="rail__inner">
        <div className="grow rail__meta">
          <h1 className="rail__title truncate">{title}</h1>
        </div>
        <div className="rail__actions">{actions}</div>
      </div>

      <div className="rail__inner" style={{ paddingTop: 0, paddingBottom: 6, minHeight: 0 }}>
        <div className="rail__meta grow" style={{ overflow: 'hidden' }}>
          {model ? (
            <span className="chip chip--local">
              <Icon name="flame" size={11} />
              {model.manifest.name}
            </span>
          ) : (
            <span className="chip">
              <Icon name="cloud" size={11} />
              No local model
            </span>
          )}

          {model?.lastBackend ? (
            <span className="readout">{BACKEND_LABEL[model.lastBackend] ?? model.lastBackend}</span>
          ) : device ? (
            <span className="readout">
              {BACKEND_LABEL[device.preferredBackend] ?? device.preferredBackend}
            </span>
          ) : null}

          {liveRate !== null ? (
            <span className="readout" style={{ color: 'var(--ember)' }}>
              {liveRate.toFixed(1)} tok/s
            </span>
          ) : null}

          {/* Context fill. Reads as an instrument, and turns warm then red as
              the window fills — the one number that silently ruins a long
              conversation if nobody is watching it. */}
          {context && context.contextLength > 0 ? (
            <span
              className="readout"
              title={
                context.measured
                  ? 'Prompt tokens reported by the engine for the last turn.'
                  : 'Estimated tokens for the next prompt.'
              }
              style={{ color: `var(--${usageTone(context.used, context.contextLength)})` }}
            >
              {context.measured ? '' : '~'}
              {compact(context.used)}/{compact(context.contextLength)} ctx
            </span>
          ) : null}

          {context && context.dropped > 0 ? (
            <span className="chip chip--warn" title="Older messages were dropped to fit the context window.">
              <Icon name="alert" size={11} />
              −{context.dropped}
            </span>
          ) : null}

          {activity === 'remote' ? (
            <span className="chip chip--remote">
              <Icon name="cloud" size={11} />
              Remote
            </span>
          ) : null}

          {activity === 'throttled' ? (
            <span className="chip chip--crit">
              <Icon name="alert" size={11} />
              Throttled
            </span>
          ) : null}
        </div>
      </div>

      <div className="thermal" data-state={thermalState} aria-hidden="true" />
    </header>
  );
}
