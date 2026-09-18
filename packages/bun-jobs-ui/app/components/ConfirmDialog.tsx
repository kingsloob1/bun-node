import type { FormEvent, ReactNode } from "react";
import { useRef, useState } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field } from "./Field";
import { TextInput } from "./inputs";
import { ProblemBanner } from "./ProblemBanner";

/** Props of {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  /** Whether it is showing. State (typed text, error) resets on each opening. */
  open: boolean;
  /** Asks to close (Cancel, Escape, backdrop, or after a successful confirm). Ignored while pending. */
  onClose: () => void;
  /** The question, e.g. "Drain queue emails?". */
  title: ReactNode;
  /** What will happen, in a sentence. */
  description?: ReactNode;
  /** Extra body content, e.g. options such as a "include delayed" checkbox. */
  children?: ReactNode;
  /**
   * The action. May be async: the dialog shows a pending state until it
   * settles, closes on success, and on a throw stays open with the error
   * shown inline (an `ApiError` as a {@link ProblemBanner}).
   */
  onConfirm: () => unknown;
  /** The confirm button's text. Defaults to `"Confirm"`. */
  confirmLabel?: string;
  /** The confirm button's text while pending. Defaults to `confirmLabel` + "…". */
  pendingLabel?: string;
  /** The cancel button's text. Defaults to `"Cancel"`. */
  cancelLabel?: string;
  /** `"danger"` for destructive actions: a red button, `alertdialog`, and Cancel focused first. Defaults to `"default"`. */
  variant?: "default" | "danger";
  /** When set, the user must type exactly this (e.g. the queue name) before Confirm enables. */
  confirmText?: string;
  /** The typed-confirmation label. Defaults to "Type <confirmText> to confirm". */
  confirmTextLabel?: ReactNode;
  /** Close after a successful `onConfirm`. Defaults to `true`. */
  closeOnSuccess?: boolean;
  /** Keeps Confirm disabled, e.g. while the body's options are invalid. */
  confirmDisabled?: boolean;
}

/**
 * A yes/no dialog for an action, built on {@link Dialog}: an optional typed
 * confirmation for destructive ones, an async `onConfirm` with a pending
 * state, and the failure shown in place so the user can retry or cancel.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return props.open ? <OpenConfirmDialog {...props} /> : null;
}

/** The mounted dialog; its state lives exactly as long as one opening. */
function OpenConfirmDialog({
  onClose,
  title,
  description,
  children,
  onConfirm,
  confirmLabel = "Confirm",
  pendingLabel,
  cancelLabel = "Cancel",
  variant = "default",
  confirmText,
  confirmTextLabel,
  closeOnSuccess = true,
  confirmDisabled = false,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = confirmText === undefined || typed === confirmText;
  const canConfirm = matches && !pending && !confirmDisabled;
  const danger = variant === "danger";

  const confirm = async () => {
    if (!canConfirm) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setPending(false);
      if (closeOnSuccess) {
        onClose();
      }
    } catch (caught) {
      setPending(false);
      setError(caught);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void confirm();
  };

  const close = () => {
    if (!pending) {
      onClose();
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      description={description}
      role={danger ? "alertdialog" : "dialog"}
      size="sm"
      closeOnEscape={!pending}
      closeOnBackdrop={!pending}
      initialFocusRef={
        confirmText !== undefined ? inputRef : danger ? cancelRef : confirmRef
      }
      footer={
        <>
          <Button
            ref={cancelRef}
            onClick={close}
            disabled={pending}
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={danger ? "danger" : "primary"}
            disabled={!canConfirm}
            aria-busy={pending || undefined}
            onClick={() => void confirm()}
          >
            {pending ? (pendingLabel ?? `${confirmLabel}…`) : confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="confirm-dialog-body"
        onSubmit={onSubmit}
      >
        {children}
        {confirmText !== undefined && (
          <Field
            label={
              confirmTextLabel ?? (
                <>
                  Type <code>{confirmText}</code> to confirm
                </>
              )
            }
          >
            <TextInput
              ref={inputRef}
              value={typed}
              onChange={setTyped}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
            />
          </Field>
        )}
        {error !== null && <ProblemBanner error={error} />}
      </form>
    </Dialog>
  );
}
