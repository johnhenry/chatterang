/**
 * Shared UI primitives. Thin wrappers over the classes in components.css —
 * their job is to make the right markup and ARIA the path of least
 * resistance, not to add a second styling system.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { Icon, type IconName } from '@/ui/Icon';
import { registerCommand } from '@/lib/keys';

/* ── Sheet ──────────────────────────────────────────────────────────── */

export interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Sheet({ open, title, onClose, children, footer }: SheetProps): ReactNode {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  /*
   * The effect below does open/close-only work — attach a key handler, focus
   * the first control, restore focus on unmount. Keeping `onClose` in its deps
   * made it re-run whenever the *parent* re-rendered with a new inline arrow,
   * which tore down and re-ran the whole thing: focus jumped back to the first
   * button. SettingsScreen passes inline arrows and subscribes to `storage`,
   * so a background model download ticking progress moved the caret out of
   * whatever the user was typing in — and on iOS collapsed the keyboard.
   *
   * Latest-ref, assigned in an effect rather than during render, so the
   * handler always calls the current onClose without being a dependency.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  /*
   * Escape goes through the dispatch layer, not through a listener per sheet.
   *
   * Each open sheet used to install its own `document` keydown handler and call
   * `stopPropagation()`. That does not stop other listeners on the same node —
   * only `stopImmediatePropagation` would — so a Confirm opened over a Sheet
   * and then dismissed with Escape closed BOTH. `registerCommand` is a stack:
   * the sheet that opened last registered last, and it is the only one Escape
   * reaches.
   */
  useEffect(() => {
    if (!open) return undefined;
    return registerCommand('layer.close', () => {
      onCloseRef.current();
    });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !panel.current) return;

      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('button, input, textarea')?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panel}
      >
        <div className="sheet__grip" />
        <div className="sheet__head">
          <h2 className="sheet__title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {footer ? <div className="sheet__foot">{footer}</div> : null}
      </div>
    </>,
    document.body,
  );
}

/* ── Switch ─────────────────────────────────────────────────────────── */

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

/* ── Setting row ────────────────────────────────────────────────────── */

export interface SettingRowProps {
  title: string;
  hint?: string;
  children?: ReactNode;
  onClick?: () => void;
}

export function SettingRow({ title, hint, children, onClick }: SettingRowProps): ReactNode {
  const content = (
    <>
      <div className="list__main">
        <span className="list__title">{title}</span>
        {hint ? <span className="list__sub">{hint}</span> : null}
      </div>
      {children}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="list__item" data-interactive="true" onClick={onClick}>
        {content}
      </button>
    );
  }
  return <div className="list__item">{content}</div>;
}

/* ── Segmented control ──────────────────────────────────────────────── */

export interface SegmentedProps<T extends string> {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: SegmentedProps<T>): ReactNode {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__item"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ── Slider with a live numeric readout ─────────────────────────────── */

export interface SliderProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  disabled?: boolean;
}

export function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
  format,
  disabled,
}: SliderProps): ReactNode {
  const id = useId();
  return (
    <div className="field">
      <div className="meter__head">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        <span className="num" style={{ fontSize: 'var(--t-sm)', color: 'var(--ink-2)' }}>
          {format ? format(value) : value}
        </span>
      </div>
      <input
        id={id}
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

/* ── Meter ──────────────────────────────────────────────────────────── */

export interface MeterProps {
  label: string;
  value: number;
  max: number;
  detail?: string;
  tone?: 'ember' | 'good' | 'warn' | 'crit' | 'remote';
}

export function Meter({ label, value, max, detail, tone = 'ember' }: MeterProps): ReactNode {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="meter">
      <div className="meter__head">
        <span className="label">{label}</span>
        {detail ? (
          <span className="num" style={{ fontSize: 'var(--t-xs)', color: 'var(--ink-2)' }}>
            {detail}
          </span>
        ) : null}
      </div>
      <div
        className="meter__track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="meter__fill"
          data-tone={tone === 'ember' ? undefined : tone}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ── Empty state ────────────────────────────────────────────────────── */

export interface EmptyProps {
  icon: IconName;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}

export function Empty({ icon, title, body, action }: EmptyProps): ReactNode {
  return (
    <div className="empty">
      <Icon name={icon} size={30} />
      <span className="empty__title">{title}</span>
      <p className="empty__body">{body}</p>
      {action ? (
        <button type="button" className="btn btn--secondary" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/* ── Copy button ────────────────────────────────────────────────────── */

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  }, [text]);

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      <Icon name={copied ? 'check' : 'copy'} size={16} />
    </button>
  );
}

/* ── Confirm dialog ─────────────────────────────────────────────────── */

export interface ConfirmProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirm({
  open,
  title,
  body,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel,
}: ConfirmProps): ReactNode {
  return (
    <Sheet
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn--secondary grow" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn grow ${destructive ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--ink-2)', fontSize: 'var(--t-sm)' }}>{body}</p>
    </Sheet>
  );
}
