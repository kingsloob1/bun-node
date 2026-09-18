import { useEffect, useState } from "react";
import { Button } from "./Button";
import { cx } from "./classNames";
import { COPY_FEEDBACK_MS, copyText } from "./copy";

/** Props of {@link CopyButton}. */
export interface CopyButtonProps {
  /** What to copy, or a function producing it on click (so a large payload is only serialised when asked). */
  text: string | (() => string);
  /** The button's visible text. Defaults to `"Copy"`. */
  label?: string;
  /** Accessible name when it differs from `label`, e.g. `"Copy job id"`. */
  ariaLabel?: string;
  /** Size. Defaults to `"sm"`. */
  size?: "sm" | "md";
  /** Extra class names. */
  className?: string;
  /** Called after each attempt with whether the clipboard write succeeded. */
  onCopied?: (ok: boolean) => void;
}

/**
 * Copies text to the clipboard and says so: the label turns into "Copied"
 * (or "Copy failed") for {@link COPY_FEEDBACK_MS}, announced politely.
 */
export function CopyButton({
  text,
  label = "Copy",
  ariaLabel,
  size = "sm",
  className,
  onCopied,
}: CopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (status === "idle") {
      return;
    }
    const timer = setTimeout(setStatus, COPY_FEEDBACK_MS, "idle");
    return () => clearTimeout(timer);
  }, [status]);

  const onClick = async () => {
    const ok = await copyText(typeof text === "function" ? text() : text);
    setStatus(ok ? "copied" : "failed");
    onCopied?.(ok);
  };

  return (
    <Button
      variant="ghost"
      size={size}
      className={cx("copy-button", className)}
      aria-label={ariaLabel}
      data-status={status}
      onClick={() => void onClick()}
    >
      <span aria-live="polite">
        {status === "copied"
          ? "Copied"
          : status === "failed"
            ? "Copy failed"
            : label}
      </span>
    </Button>
  );
}
