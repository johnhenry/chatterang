import { type ReactNode } from 'react';

import { Icon } from '@/ui/Icon';
import { useApp } from '@/state/app';

export function Toasts(): ReactNode {
  const toasts = useApp((state) => state.toasts);
  const dismiss = useApp((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-tone={toast.tone}>
          <span className="grow">{toast.message}</span>
          {toast.action ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                toast.action?.run();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="icon-btn"
            style={{ width: 24, height: 24 }}
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
