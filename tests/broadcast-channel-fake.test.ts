/**
 * THE IN-MEMORY BROADCASTCHANNEL IS HELD TO WHAT A BROWSER DID.
 *
 * `tests/support/broadcast-channel.ts` stands in for BroadcastChannel in every
 * file, and the delete of every conversation relies on it to reach another
 * tab. These pin it to what Chromium 152 did in Electron 44, on two windows of
 * one origin: a message reached the other window and another object bound to
 * the name in the posting page, never the object that posted it, and nothing
 * in the step it was posted.
 */

import { describe, expect, it } from 'vitest';

import { broadcastChannels } from './support/broadcast-channel';

const aTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the in-memory BroadcastChannel', () => {
  it('reaches every other object bound to the name, in any window, and never the one that posted', async () => {
    const channels = broadcastChannels();
    const one = channels.window();
    const two = channels.window();
    const got = {
      posting: [] as unknown[],
      samePage: [] as unknown[],
      otherWindow: [] as unknown[],
      otherName: [] as unknown[],
    };

    const posting = new one.BroadcastChannel('chatterang:windows');
    posting.onmessage = (event) => got.posting.push(event.data);
    new one.BroadcastChannel('chatterang:windows').addEventListener('message', (event) =>
      got.samePage.push((event as MessageEvent).data),
    );
    new two.BroadcastChannel('chatterang:windows').onmessage = (event) => got.otherWindow.push(event.data);
    new two.BroadcastChannel('something else').onmessage = (event) => got.otherName.push(event.data);

    posting.postMessage('conversations-cleared');
    expect(got.otherWindow, 'in the step it is posted').toEqual([]);
    await aTask();

    expect(got).toEqual({
      posting: [],
      samePage: ['conversations-cleared'],
      otherWindow: ['conversations-cleared'],
      otherName: [],
    });
  });

  it('reaches nothing in a window closed before the message is delivered', async () => {
    const channels = broadcastChannels();
    const one = channels.window();
    const two = channels.window();
    const got: unknown[] = [];
    const posting = new one.BroadcastChannel('chatterang:windows');
    new two.BroadcastChannel('chatterang:windows').onmessage = (event) => got.push(event.data);

    posting.postMessage('conversations-cleared');
    two.close();
    await aTask();

    expect(got).toEqual([]);
  });
});
