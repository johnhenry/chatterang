/**
 * WHERE A CHAT'S NEXT TURN WOULD GO — resolved once, for every surface.
 *
 * This lived inside `features/chat/ChatScreen.tsx`, which was fine while the
 * chat screen was the only thing that answered the question. It is not: the
 * rail across the top of every screen answers it too, and answered it with its
 * own copy of `chat?.modelId ?? activeModelId` plus `installed[modelId]` — no
 * capability check, no install-state check. So a chat pinned to Whisper got a
 * flame chip and a context readout in the rail one line above a screen saying
 * "nothing is loaded and nothing will be sent".
 *
 * It cannot live in `ChatScreen` and be imported by `ui/Rail`: `ChatScreen`
 * imports `Rail`, and `tests/layering.test.ts` walks the whole `@/` graph for
 * cycles. It cannot live in `domain/` either — that layer is banned from
 * importing `@/db`, and this rule is stated over the persisted record. So it
 * sits in `ui/`, the layer both callers already depend on, in the direction
 * features → ui that the rest of the app is written in.
 */

import { canChat } from '@/domain/manifest';
import {
  REACH_DEVICE,
  REACH_LOCAL_VIA_THIRD_PARTY,
  REACH_REMOTE,
  reachPaired,
  type PairedDevice,
  type Reach,
} from '@/domain/chat';
import type { InstalledModel } from '@/db';

/**
 * A local agent CLI, chosen as a chat target (#39, #115).
 *
 * Structural, like {@link Providerish}: the picker and the rail need an `id`
 * to key on and a `label` to print, not the whole binary-discovery record
 * (#116) — the same reason `Providerish` does not demand a full
 * `ProviderConnection`. Exported so a later persona track (#5) can reference
 * this shape without reaching into `target.ts`'s private union.
 */
export interface CliSource {
  readonly id: string;
  readonly label: string;
}

/**
 * A provider connection, structurally — id, label, and whether it is on.
 *
 * Structural rather than `ProviderConnection` for the same reason
 * `CapabilityBearing` is structural in the manifest module: the question
 * "would a turn leave this device?" needs three fields, and demanding the
 * whole record would couple this screen's copy to the provider schema.
 */
export interface Providerish {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
}

/**
 * The four things that can be true of a chat that has not been sent yet.
 *
 * `refused` is the one that did not exist, and it is the case the bug report
 * is in: a chat pinned to a model that cannot answer. It is NOT `none` — the
 * user has a target, it just will not run — and it is NOT `remote`, because
 * `resolveTarget` refuses before it looks at connections.
 */
export type ChatTarget =
  | { readonly kind: 'local'; readonly model: InstalledModel }
  /**
   * A device the user paired (#191). Neither `local` nor `remote`: the bytes
   * leave this phone, and no third party receives them. Filing it under either
   * existing arm makes that arm's label false for at least one row in the list.
   */
  | { readonly kind: 'paired'; readonly device: PairedDevice }
  | { readonly kind: 'remote'; readonly provider: Providerish }
  /**
   * A local agent CLI (#39, #115): `claude`, `codex`, `gemini`, run as a
   * subprocess on THIS device. Neither `local` (it is not on-device
   * inference — the reply comes from whatever vendor the CLI is signed in
   * to) nor `remote` (there is no provider connection, no base URL, no key
   * this app holds). `reachOf` labels it {@link REACH_LOCAL_VIA_THIRD_PARTY}
   * (#112) rather than either existing arm, for the same reason `paired`
   * got its own arm in #191: folding it into `local` or `remote` makes that
   * arm's label false for at least one row in the list.
   */
  | { readonly kind: 'cli'; readonly cli: CliSource }
  | { readonly kind: 'refused'; readonly model: InstalledModel }
  | { readonly kind: 'none' };

/**
 * The {@link Reach} a target will produce, or undefined if it will produce none.
 *
 * This is what stops the picker and the provenance becoming two taxonomies of
 * the same thing (#112, #191). The chat screen groups its `<optgroup>`s by the
 * DESTINATION axis of this rather than by `kind`, so "what the user is
 * choosing between" and "what the reply will be labelled" cannot drift — and
 * a fifth destination is a row here rather than a new group everywhere.
 *
 * `refused` and `none` produce nothing because no turn runs.
 */
export function reachOf(target: ChatTarget): Reach | undefined {
  switch (target.kind) {
    case 'local':
      return REACH_DEVICE;
    case 'paired':
      return reachPaired(target.device);
    case 'remote':
      return REACH_REMOTE;
    case 'cli':
      return REACH_LOCAL_VIA_THIRD_PARTY;
    case 'refused':
    case 'none':
      return undefined;
  }
}

/**
 * WHERE THE TURN GOES, DECIDED THE SAME WAY THE ENGINE DECIDES IT.
 *
 * This is a mirror of `resolveTarget` in `state/chat.ts`, and every branch of
 * it is load-bearing for a sentence on the chat screen and a chip in the rail:
 *
 *  - It was `model?.state === 'installed' || someConnectionEnabled`, a boolean
 *    that answered "is something plugged in" and got asked "will this chat
 *    answer". A chat pinned to Whisper is `installed`, so the composer was
 *    live, the start state promised a model was running, and the refusal only
 *    arrived as a toast AFTER the user typed and sent — on exactly the
 *    persisted path the reported user is on, where every new sentence written
 *    to warn them is bypassed.
 *  - A model that cannot chat does NOT fall through to a remote provider here,
 *    because it does not fall through there either: `resolveTarget` returns
 *    `refused` before it reaches the connection list. Falling through would be
 *    worse than the toast — the turn a user pinned to a local model would
 *    leave the device.
 *  - And `local` is separated from `remote` because ONE of them may say
 *    "everything here stays here" and the other must not.
 *
 * Note `state === 'installed'`, not "there is a record": a model that is still
 * downloading has a record and a manifest — including a `contextLength` the
 * rail was happy to print as a live context window — and no file behind it.
 */
export function chatTarget(
  modelId: string | null,
  installed: Record<string, InstalledModel>,
  connections: readonly Providerish[],
): ChatTarget {
  const model = modelId ? installed[modelId] : undefined;
  if (model?.state === 'installed') {
    return canChat(model.manifest) ? { kind: 'local', model } : { kind: 'refused', model };
  }
  const provider = connections.find((connection) => connection.enabled);
  return provider ? { kind: 'remote', provider } : { kind: 'none' };
}
