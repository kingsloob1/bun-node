import type {
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  SyntheticEvent,
} from "react";
import { useEffect, useId, useRef } from "react";
import { Button } from "./Button";
import { cx } from "./classNames";

/** What counts as focusable inside a dialog, for the trap and the initial focus. */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** The focusable elements inside `root`, in DOM order. */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hasAttribute("inert") && !element.closest("[inert]"),
  );
}

/** Props of {@link Dialog}. */
export interface DialogProps {
  /** Whether the dialog is showing. The content only mounts while open, so its state resets on each opening. */
  open: boolean;
  /** Asks to close: Escape, a backdrop click or the close button. The caller sets `open` to `false`. */
  onClose: () => void;
  /** The heading; it labels the dialog (`aria-labelledby`). */
  title: ReactNode;
  /** A sentence under the title; it describes the dialog (`aria-describedby`). */
  description?: ReactNode;
  /** The body. */
  children?: ReactNode;
  /** Actions along the bottom, usually {@link Button}s; the primary one last. */
  footer?: ReactNode;
  /** Close on Escape. Defaults to `true`; turn off while something is pending. */
  closeOnEscape?: boolean;
  /** Close on a click outside the panel. Defaults to `true`. */
  closeOnBackdrop?: boolean;
  /** Show the × button in the header. Defaults to `true`. */
  showCloseButton?: boolean;
  /** Width. Defaults to `"md"` (`sm` 400px, `md` 560px, `lg` 800px, each capped at the viewport). */
  size?: "sm" | "md" | "lg";
  /** What to focus on open. Defaults to the first focusable element in the body, then the footer, then the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** `"alertdialog"` for a confirmation that interrupts. Defaults to `"dialog"`. */
  role?: "dialog" | "alertdialog";
  /** Extra class names on the panel. */
  className?: string;
}

/**
 * A modal on the native `<dialog>` element (`showModal()`, so the page
 * behind is inert and it sits in the top layer; no portal needed).
 *
 * Tab and Shift+Tab cycle inside it; Escape and a backdrop click call
 * `onClose` when allowed; on close, focus returns to whatever had it when
 * the dialog opened.
 */
export function Dialog(props: DialogProps) {
  return props.open ? <OpenDialog {...props} /> : null;
}

/** The mounted dialog: mount is "open", unmount is "close". */
function OpenDialog({
  onClose,
  title,
  description,
  children,
  footer,
  closeOnEscape = true,
  closeOnBackdrop = true,
  showCloseButton = true,
  size = "md",
  initialFocusRef,
  role = "dialog",
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }
    const target =
      initialFocusRef?.current ??
      (bodyRef.current && focusableIn(bodyRef.current)[0]) ??
      focusableIn(dialog).find((element) => !element.dataset.dialogClose) ??
      dialog;
    target.focus();
    return () => {
      if (dialog.open && typeof dialog.close === "function") {
        dialog.close();
      }
      if (opener?.isConnected) {
        opener.focus();
      }
    };
    // Runs once per opening (the ref objects are stable).
  }, [initialFocusRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape") {
      // Stop the native `cancel` so the element's open state stays ours.
      event.preventDefault();
      event.stopPropagation();
      if (closeOnEscape) {
        onClose();
      }
      return;
    }
    if (event.key !== "Tab" || !ref.current) {
      return;
    }
    const focusable = focusableIn(ref.current);
    if (focusable.length === 0) {
      event.preventDefault();
      ref.current.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    const inside = active instanceof Node && ref.current.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  };

  // Escape in a real browser can arrive as `cancel` without a keydown we saw.
  const onCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    if (closeOnEscape) {
      onClose();
    }
  };

  // The panel fills the element, so a click whose target is the element
  // itself landed on the backdrop.
  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (closeOnBackdrop && event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    // The keyboard handling lives on the dialog element (Escape and the
    // focus trap); a backdrop click is a pointer-only convenience.
    <dialog
      ref={ref}
      role={role === "alertdialog" ? "alertdialog" : undefined}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cx("dialog", `dialog-${size}`, className)}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onCancel={onCancel}
      onClick={onClick}
    >
      <div className="dialog-panel">
        <div className="dialog-header">
          <h2
            id={titleId}
            className="dialog-title"
          >
            {title}
          </h2>
          {showCloseButton && (
            <Button
              variant="ghost"
              size="sm"
              className="dialog-close"
              aria-label="Close"
              data-dialog-close="true"
              onClick={onClose}
            >
              <span aria-hidden="true">×</span>
            </Button>
          )}
        </div>
        {description && (
          <p
            id={descriptionId}
            className="dialog-description"
          >
            {description}
          </p>
        )}
        {children !== undefined && (
          <div
            ref={bodyRef}
            className="dialog-body"
          >
            {children}
          </div>
        )}
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </dialog>
  );
}
