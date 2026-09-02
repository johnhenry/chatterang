import { type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/primitives';
import { CATALOG } from '@/data/catalog';
import { canChat, formatBytes, type ModelManifest } from '@/domain/manifest';
import { recommendModel, type DeviceFit } from '@/domain/onboarding';

import { useApp } from '@/state/app';
import { useModels } from '@/state/models';

/**
 * First run.
 *
 * Deliberately one screen, not a carousel. The app does nothing until a
 * multi-gigabyte file has been downloaded, so every panel of feature marketing
 * placed before that is friction charged to someone who has not had any value
 * yet.
 *
 * It does the one thing a generic onboarding cannot: it knows the device, so it
 * names a specific model, states what the download costs, and says why that
 * one. The alternative that needs no download at all is given equal weight
 * rather than buried — for someone evaluating the app, "try it without
 * downloading anything" is the honest first step.
 */
export function Onboarding({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const device = useApp((state) => state.device);
  const install = useModels((state) => state.install);

  const pick = recommendModel(CATALOG, device?.totalMemory);

  return (
    <Sheet open={open} title="Welcome" onClose={onClose}>
      {/*
        WHAT THIS SCREEN IS ALLOWED TO PROMISE ABOUT WHERE A TURN GOES.

        It read: "Conversations stay in local storage, and nothing is sent
        anywhere unless you connect a remote provider — in which case every
        message that leaves is marked in the thread." Two claims, both
        completeness claims, and the app's own `privacy` command contradicts
        both from the configuration this screen is looking at — first run, no
        provider, no MCP server:

          - "what you type into the model search, and the model files you
            download, to huggingface.co". That is not an edge case here. It is
            the button directly below this paragraph: `resolveSourceUrl` builds
            every download URL on huggingface.co, so the one action this screen
            asks for is a request that leaves.
          - "the arguments of an MCP tool, to the server that tool comes from"
            — sent from a chat with no provider in it at all.
          - a published benchmark run.

        And "every message that leaves is marked" claims completeness about the
        marking. `privacy` prints the case where it fails, measured: flipping
        between regenerated answers moves older text out of the turn whose tool
        produced it, "from then on it is sent as ordinary text: nothing
        withheld, nothing asked."

        `privacy` is the surface a careful person runs, and it was rewritten to
        make NO completeness claim — `tests/privacy-copy.test.ts` fails it on
        /nothing else/i and /nothing but/i. The first screen every user sees was
        making the claim that command refuses to. So this paragraph names what
        stays, names what leaves, says plainly that its list is not the whole
        one, and sends anyone who wants the whole one to the command that has
        it. The marking claim is narrowed to the reply — the same scope
        `SettingsScreen` and `startProse` already use, and the scope
        `MessageView` actually renders from `provenance`.

        AND THEN NARROWED AGAIN, IN TIME. "every reply from one marked in the
        thread" was a claim about every reply a thread can show, and one kind
        of reply falsifies it: a generation recovered by the v4 upgrade from a
        chat an older build saved. That build stored a variant as a bare
        string, so its origin was never written down; `upgradeVariants` marks
        it `unrecorded` and `MessageView` renders it with no chip, because the
        only guess available — the row's own provenance — is the confident
        falsehood the whole variant-record change exists to prevent. Measured
        in `tests/selection-copy.test.ts` ("the mark on a reply, measured by
        driving a real thread"): after regenerate and `‹`, a remote reply
        reads `Remote` and a recovered one reads the empty string.

        So the sentence is scoped to what the code guarantees rather than to
        every row a thread can hold: FROM NOW ON — from a reply this build
        records — a reply from a provider is marked, and the mark follows its
        own text through regenerate, cycle and export. Nothing is claimed
        about a reply that came back before the origin was recorded, and
        nothing needs to be: that one renders unlabelled rather than wrongly
        labelled.

        The clause is word-for-word the one `startProse` uses in both its
        branches. Three rounds of this repair produced three false sentences
        from two surfaces saying the same fact differently, so the fact now
        has one wording and `tests/selection-copy.test.ts` fails any sentence
        that marks a reply in words its ledger does not carry.
      */}
      <p className="section__hint">
        Chatterang runs language models on this device: conversations, personas and settings
        are stored here, with no account and nothing syncing. Some things do leave — a model
        download comes from huggingface.co, and a remote provider you connect gets what you
        send it. From now on, every reply that comes back from a provider is marked Remote in
        the thread. For the rest, Settings › Shell has a <code>privacy</code> command.
      </p>

      {pick ? (
        <div className="section">
          <div className="section__head">
            <h2 className="grow">Start with {pick.manifest.name}</h2>
            <span className="chip chip--local">
              <Icon name="flame" size={11} />
              {formatBytes(pick.manifest.sizeBytes, 1)}
            </span>
          </div>
          <p className="section__hint">
            {pick.manifest.bestFor}. {fitNote(pick, CATALOG, device)} It downloads once and then
            works offline.
          </p>
          <button
            type="button"
            className="btn btn--block"
            onClick={() => {
              void install(pick.manifest);
              onClose();
            }}
          >
            <Icon name="download" size={16} />
            Download {formatBytes(pick.manifest.sizeBytes, 1)}
          </button>
        </div>
      ) : null}

      <div className="section">
        <div className="section__head">
          <h2>Not ready to download?</h2>
        </div>
        {/*
          "…and the app says so on every one of them" was the same overclaim as
          the paragraph at the top, about the same thing, four lines later —
          "them" is the messages the user SENDS, and nothing marks those. What
          `MessageView` renders a chip on is the reply: `message.provenance` is
          set when an answer arrives, and the user's own row has no chip at all.
          So the claim is stated as the label the user will actually see.

          It is now stated in the SAME WORDS as the paragraph at the top of
          this screen and as both branches of `startProse` — "every reply that
          comes back from a provider is marked Remote in the thread", under
          the same "from now on". This paragraph said the same thing with
          "labelled" where the others said "marked", which is how two surfaces
          drift into disagreeing about a fact neither of them measures.
        */}
        <p className="section__hint">
          Connect a remote provider in Settings and use Chatterang straight away. What you
          send goes to that provider, and from now on every reply that comes back from a
          provider is marked Remote in the thread.
        </p>
        <button type="button" className="btn btn--secondary btn--block" onClick={onClose}>
          Look around first
        </button>
      </div>
    </Sheet>
  );
}

/** Just enough of `DeviceCapabilities` to say something true about the fit. */
interface DeviceMemory {
  readonly totalMemory: number;
  readonly chipset: string;
}

/**
 * Why THIS model, said in terms of what was actually measured.
 *
 * THE SENTENCE THIS REPLACES WAS FALSE ON THE FIRST SCREEN OF THE REPORTED
 * JOURNEY. Every non-comfortable fit read "This is the smallest model
 * available — it will be slow on this device, but it will run", and all three
 * of its claims could be wrong at once:
 *
 *   1. "the smallest model available" — `recommendModel` now ranks only
 *      `canChat` entries, so on the shipped catalogue the unknown-memory
 *      branch returns `qwen2.5-0.5b-instruct-q4km` (379.4 MB) while
 *      `piper-en-us-amy-medium` (63.2 MB) is still the smallest thing in the
 *      catalogue. That branch is the one `recommendModel`'s own comment calls
 *      THE EMULATOR CASE — the device in the report.
 *   2. ...and it is not even the smallest of the ranked ones in every case: a
 *      device reporting 1 GB gets `smolvlm-500m-q8` (545.6 MB), the LARGEST
 *      whose minRAM fits, with a 397.8 MB entry sitting below it.
 *   3. "it will run" — `fit: 'tight'` also covers the branch where NOTHING
 *      fits, which is a device whose memory is below the model's own minimum.
 *      `ModelDetail` tells that same user, about that same model, that
 *      "Loading it would be killed by the operating system". Two screens, one
 *      device, opposite promises.
 *
 * So nothing here is written down as a constant. The "smallest" clause is
 * derived from the same catalogue the pick came out of, and the run/slow
 * clause is derived from this device's memory against this model's own
 * minimum — the identical comparison `ModelDetail` makes, so the two screens
 * cannot disagree again. A device that has reported nothing gets no promise
 * about speed at all, because nothing was measured to support one.
 */
export function fitNote(
  pick: DeviceFit,
  catalog: readonly ModelManifest[],
  device: DeviceMemory | null,
): string {
  if (pick.fit === 'comfortable') {
    return device?.chipset ? `Comfortable on ${device.chipset}.` : 'Comfortable on this device.';
  }

  // Derived, never asserted: whether this pick really is the floor depends on
  // both the catalogue and the filter `recommendModel` applies to it.
  const smallestChat = catalog
    .filter(canChat)
    .reduce<ModelManifest | null>(
      (best, entry) => (!best || entry.sizeBytes < best.sizeBytes ? entry : best),
      null,
    );
  const floor =
    smallestChat?.id === pick.manifest.id
      ? ' Nothing in the catalogue that can hold a conversation is smaller.'
      : '';

  const memory = device && device.totalMemory > 0 ? device.totalMemory : null;
  if (memory === null) {
    return `This device has not reported how much memory it has, so this is the cautious guess rather than a measured fit.${floor}`;
  }

  const needs = formatBytes(pick.manifest.minRAM, 0);
  const has = formatBytes(memory, 0);
  return memory >= pick.manifest.minRAM
    ? `It needs ${needs} and this device has ${has}, so it will run, slowly.${floor}`
    : `It needs ${needs} and this device has ${has}, so the operating system may kill it while it loads.${floor}`;
}
