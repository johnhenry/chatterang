import { type ReactNode } from 'react';

import { Confirm } from '@/ui/primitives';
import { useApp } from '@/state/app';

/**
 * Surfaces confirmations the model has asked for.
 *
 * The shell tool is only safe to hand a model because this exists: every
 * state-changing command it runs stops here until a person reads what it
 * wants and says yes. Rendered at the app root so it appears on whatever
 * screen the user happens to be on when the model asks.
 */
export function ApprovalGate(): ReactNode {
  const approvals = useApp((state) => state.approvals);
  const answer = useApp((state) => state.answerApproval);

  const next = approvals[0];
  if (!next) return null;

  return (
    <Confirm
      open
      title="The model wants to do something"
      body={`It is asking to ${next.action}. Nothing happens unless you allow it.`}
      confirmLabel="Allow"
      onCancel={() => answer(next.id, false)}
      onConfirm={() => answer(next.id, true)}
    />
  );
}
