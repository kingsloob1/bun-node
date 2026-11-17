/**
 * What the app shows when it cannot load (ui.md §2: no login screen):
 * "Sign in required" for a `401`, with the host's sign-in page when
 * `unauthorized` is configured and, only when the API has the account, the
 * break-glass sign-in (the user's decision); "Access denied" for a `403`;
 * otherwise the failure.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../kit/components/Button";
import { isApiError } from "../api/errors";
import { ErrorView } from "../components/ErrorView";
import { useUiConfig } from "../context";
import { BreakGlassForm } from "./BreakGlassForm";

/** Props of {@link SignInRequired}. */
export interface SignInRequiredProps {
  /** Why loading failed. */
  error: unknown;
  /** Loads again. */
  onRetry: () => void;
}

/** See the module's description. */
export function SignInRequired({ error, onRetry }: SignInRequiredProps) {
  const config = useUiConfig();
  const queryClient = useQueryClient();
  const [breakGlass, setBreakGlass] = useState(false);
  const status = isApiError(error) ? error.status : 0;
  const title =
    status === 401
      ? "Sign in required"
      : status === 403
        ? "Access denied"
        : "The security API could not be loaded";
  return (
    <main
      className="bootstrap-screen"
      data-testid="bootstrap-error"
    >
      <h1 className="bootstrap-title">{config.title}</h1>
      <ErrorView
        error={error}
        title={title}
        onRetry={onRetry}
      />
      {status === 401 && config.unauthorized !== null ? (
        <p>
          <a
            href={config.unauthorized.redirectTo}
            data-testid="sign-in-link"
          >
            Sign in
          </a>
        </p>
      ) : null}
      {status === 401 && config.breakGlass ? (
        breakGlass ? (
          <BreakGlassForm
            onSignedIn={() => {
              void queryClient.resetQueries();
              onRetry();
            }}
          />
        ) : (
          <Button
            variant="ghost"
            data-testid="break-glass-link"
            onClick={() => setBreakGlass(true)}
          >
            Break-glass sign-in
          </Button>
        )
      ) : null}
    </main>
  );
}
