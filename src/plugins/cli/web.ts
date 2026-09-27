/**
 * Web implementation of `Cli`: a plain refusal, the same shape
 * `mount-host/web.ts` uses for a capability the web platform genuinely does
 * not have — never a simulated turn. #115's own ruling is desktop only,
 * so there is nothing here for a browser tab to fall back to.
 */

import { WebPlugin } from '@capacitor/core';
import type {
  CliCancelTurnRequest,
  CliDiscoverRequest,
  CliDiscoverResult,
  CliPlugin,
  CliStartTurnRequest,
} from './definitions';

function unavailable(method: string): Error {
  return new Error(`Cli: "${method}" is not available in a browser -- a local agent CLI is desktop-only (#115).`);
}

export class CliWeb extends WebPlugin implements CliPlugin {
  async discover(_request: CliDiscoverRequest): Promise<CliDiscoverResult> {
    throw unavailable('discover');
  }

  async startTurn(_request: CliStartTurnRequest): Promise<{ readonly requestId: string }> {
    throw unavailable('startTurn');
  }

  async cancelTurn(_request: CliCancelTurnRequest): Promise<void> {
    throw unavailable('cancelTurn');
  }
}
