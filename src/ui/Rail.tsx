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
import { chatTarget } from '@/ui/target';
import { useApp } from '@/state/app';
import { useModels } from '@/state/models';
import { useChats } from '@/state/chat';
import { usageTone } from '@/ai/context';
import { getProvider } from '@/ai/providers';

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
  const turnWaiting = useApp((state) => state.turnWaiting);
  const device = useApp((state) => state.device);
  const activeChatId = useChats((state) => state.activeChatId);
  const chats = useChats((state) => state.chats);
  const context = useChats((state) => state.context);
  const installed = useModels((state) => state.installed);
  const activeModelId = useModels((state) => state.activeModelId);
  const connections = useApp((state) => state.connections);

  const chat = chats.find((entry) => entry.id === activeChatId);

  /*
   * THE SAME RESOLUTION THE CHAT SCREEN AND THE ENGINE USE, NOT A THIRD COPY.
   *
   * This was `chat?.modelId ?? activeModelId` followed by `installed[modelId]`,
   * and the presence of a record was taken as "a local model is loaded here".
   * Two states falsify that and both are reachable from a persisted chat:
   *
   *  - pinned to a model that cannot chat (the reported Whisper case). The rail
   *    painted the flame chip — the app's own mark for a local model being
   *    loaded — and Whisper's 448-token window as a filling context readout,
   *    one line above a screen reading "nothing is loaded and nothing will be
   *    sent". The rail is the app's honesty instrument; it was the last surface
   *    still telling the reported user the opposite of the truth.
   *  - pinned to a model that is still downloading. A `downloading` record
   *    carries a full manifest and no file, so the chip named a resident model
   *    and the readout printed a context window for a load that cannot happen.
   *
   * `chatTarget` answers both, and answers them the way `resolveTarget` will
   * when the turn is actually sent.
   */
  // `Providerish.cli` (#42, #115) is what lets `chatTarget` tell a local-cli
  // connection apart from an ordinary remote one, so this raw store selector
  // is not enough on its own -- computed fresh here, the same way
  // `ChatScreen.tsx` computes it, rather than stored on the connection.
  const connectionsForTarget = connections.map((connection) => ({
    ...connection,
    cli: getProvider(connection.providerId)?.kind === 'local-cli',
  }));
  const target = chatTarget(chat?.modelId ?? activeModelId, installed, connectionsForTarget);
  /**
   * The model that would really answer here.
   *
   * Every readout below that describes a model rather than the device hangs off
   * this, so there is one place that decides whether the rail is describing a
   * live target or a dead pin.
   */
  const model = target.kind === 'local' ? target.model : undefined;

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
          {/*
              The flame is the app's mark for "a local model answers here", so
              only the `local` branch may draw it. `refused` still NAMES the
              pin — a rail that silently fell back to "No local model" would
              hide the one fact that explains why the composer is dead — and
              borrows the engine's own refusal — "cannot answer a chat", the
              words `resolveTarget` toasts — without promising what it does
              instead: the rule `nonChatRole` states. `remote` and `none` share
              "No local model", which is exactly what both mean here.
          */}
          {target.kind === 'local' ? (
            <span className="chip chip--local">
              <Icon name="flame" size={11} />
              {target.model.manifest.name}
            </span>
          ) : target.kind === 'refused' ? (
            <span
              className="chip chip--warn"
              title="This chat is pinned to a model that cannot write text, so no turn will be sent."
            >
              <Icon name="alert" size={11} />
              {target.model.manifest.name} cannot answer a chat
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
              conversation if nobody is watching it.

              Gated on the target being local because `refreshContext` derives
              the window from `installed[modelId]?.manifest` — any record with a
              manifest, whether or not it will ever answer. So the reported chat
              printed "~0/448 ctx", Whisper's own window, as a live budget for a
              prompt that cannot be built; a pinned half-downloaded model prints
              its own the same way. Nothing true is hidden by this: in every
              non-local case `refreshContext` either finds no manifest and sets
              `context` to null, or found the one that is not going to be
              used. */}
          {model && context && context.contextLength > 0 ? (
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

          {model && context && context.dropped > 0 ? (
            <span className="chip chip--warn" title="Older messages were dropped to fit the context window.">
              <Icon name="alert" size={11} />
              −{context.dropped}
            </span>
          ) : null}

          {/* #7: the desktop's own turns and a paired phone's share one slot,
              and whoever waits is told, including the person here. A silent
              wait reads as a hung app. */}
          {turnWaiting !== null ? (
            <span
              className="chip chip--warn"
              title="Another turn is using the model on this computer. This one starts when its turn comes."
            >
              <Icon name="gauge" size={11} />
              Waiting · {turnWaiting === 1 ? 'next in line' : `#${String(turnWaiting)} in line`}
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
