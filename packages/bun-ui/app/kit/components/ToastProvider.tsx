import type { ReactNode } from "react";
import type { ToastApi, ToastKind, ToastOptions, ToastRecord } from "./toast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./Button";
import { cx } from "./classNames";
import { MAX_TOASTS, TOAST_DURATION_MS, ToastContext } from "./toast";

/** Props of {@link ToastProvider}. */
export interface ToastProviderProps {
  /** The app. */
  children: ReactNode;
  /** Most toasts on screen at once. Defaults to {@link MAX_TOASTS}. */
  max?: number;
}

/**
 * Hosts toasts: provides {@link useToast} and renders the stack in two live
 * regions that exist from the first render (a region added together with
 * its content is not announced): `aria-live="polite"` for success/info and
 * `aria-live="assertive"` for errors. They carry no `status`/`alert` role
 * on purpose, so they never collide with a screen's own `getByRole("alert")`.
 */
export function ToastProvider({
  children,
  max = MAX_TOASTS,
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const counterRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const api = useMemo<ToastApi>(() => {
    const show =
      (kind: ToastKind) =>
      (message: ReactNode, options: ToastOptions = {}): string => {
        counterRef.current += 1;
        const id = `toast-${counterRef.current}`;
        setToasts((current) =>
          [...current, { ...options, id, kind, message }].slice(-max),
        );
        return id;
      };
    return {
      success: show("success"),
      error: show("error"),
      info: show("info"),
      dismiss,
    };
  }, [dismiss, max]);

  const polite = toasts.filter((toast) => toast.kind !== "error");
  const assertive = toasts.filter((toast) => toast.kind === "error");

  return (
    <ToastContext value={api}>
      {children}
      <div className="toast-viewport">
        <ol
          className="toast-list"
          aria-label="Notifications"
          aria-live="polite"
          aria-atomic="false"
        >
          {polite.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              onDismiss={dismiss}
            />
          ))}
        </ol>
        <ol
          className="toast-list"
          aria-label="Errors"
          aria-live="assertive"
          aria-atomic="false"
        >
          {assertive.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              onDismiss={dismiss}
            />
          ))}
        </ol>
      </div>
    </ToastContext>
  );
}

/** Props of {@link ToastItem}. */
interface ToastItemProps {
  /** The toast. */
  toast: ToastRecord;
  /** Removes it. */
  onDismiss: (id: string) => void;
}

/** One toast; its timer pauses while hovered or focused, so it is not pulled from under the reader. */
function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [paused, setPaused] = useState(false);
  const duration = toast.duration ?? TOAST_DURATION_MS[toast.kind];

  useEffect(() => {
    if (duration <= 0 || paused) {
      return;
    }
    const timer = setTimeout(onDismiss, duration, toast.id);
    return () => clearTimeout(timer);
  }, [duration, paused, onDismiss, toast.id]);

  return (
    <li
      className={cx("toast", `toast-${toast.kind}`)}
      data-toast-kind={toast.kind}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="toast-text">
        <p className="toast-message">{toast.message}</p>
        {toast.description && (
          <p className="toast-description">{toast.description}</p>
        )}
      </div>
      {toast.action && (
        <Button
          size="sm"
          className="toast-action"
          onClick={() => {
            toast.action!.onClick();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="toast-dismiss"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        <span aria-hidden="true">×</span>
      </Button>
    </li>
  );
}
