/**
 * A secret the API shows this once (an agent's key, a channel's signing
 * secret): shown with a copy button and a warning that it will not be
 * shown again; the caller forgets it when the operator dismisses it.
 */
import { Button } from "../../kit/components/Button";
import { CopyButton } from "../../kit/components/CopyButton";

/** Props of {@link SecretOnce}. */
export interface SecretOnceProps {
  /** What it is (“The agent's secret”). */
  label: string;
  /** The secret. */
  secret: string;
  /** Where it goes, for people (“Configure the agent with it”). */
  use: string;
  /** Forgets it. */
  onDone: () => void;
}

/** See the module's description. */
export function SecretOnce({ label, secret, use, onDone }: SecretOnceProps) {
  return (
    <section
      className="card"
      role="alert"
      aria-label={label}
      data-testid="secret-once"
    >
      <div className="card-body">
        <p>
          <strong>{label}</strong>: {use}. It is shown this once: copy it now.
        </p>
        <p className="secret-once">
          <code data-testid="secret-value">{secret}</code>
          <CopyButton
            text={secret}
            label="Copy"
            ariaLabel={`Copy ${label.toLowerCase()}`}
          />
        </p>
        <Button
          size="sm"
          data-testid="secret-done"
          onClick={onDone}
        >
          I have stored it
        </Button>
      </div>
    </section>
  );
}
