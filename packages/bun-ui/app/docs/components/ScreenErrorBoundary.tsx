import type { QueryClient } from "@tanstack/react-query";
import type { ErrorInfo, ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { Component } from "react";
import { resetScreenQueries } from "../queryClient";
import { Button } from "./Button";

/** Props of {@link ScreenErrorBoundary}. */
export interface ScreenErrorBoundaryProps {
  /** The screen. */
  children: ReactNode;
  /** When this changes (the location), a failed screen is tried again: navigating away from a crash recovers without a click. */
  resetKey?: string;
  /** Called with each crash, e.g. to log it. Defaults to nothing (React already reports it in development). */
  onError?: (error: unknown, info: ErrorInfo) => void;
}

/** State of {@link ScreenErrorBoundary}. */
interface ScreenErrorBoundaryState {
  /** What the screen threw while rendering, or `null` while it renders fine. */
  error: unknown;
  /** Whether {@link ScreenErrorBoundaryState.error} is set (an error may be any value, `null` included). */
  failed: boolean;
  /** Bumped by "Reload this screen", remounting the screen with fresh state. */
  attempt: number;
  /** The `resetKey` the failure happened under. */
  failedKey: string | undefined;
}

/**
 * Catches a routed screen's render crash so the app around it survives: the
 * header, nav and live status stay, and the screen's place shows what
 * failed with a "Reload this screen" button that mounts it afresh and
 * re-reads its data: the cached answers it read are reset first (see
 * {@link resetScreenQueries}; `/meta` and the permissions are kept), so a
 * crash caused by a bad answer recovers once the host answers well. A lazy
 * screen whose chunk failed to load is retried the same way (see
 * `screens/lazy.tsx`).
 *
 * The app's queries do not throw into it (no `throwOnError`, no suspense
 * queries: a failed read renders the screen's own error view), so there is
 * no `QueryErrorResetBoundary` to reset.
 */
export class ScreenErrorBoundary extends Component<
  ScreenErrorBoundaryProps,
  ScreenErrorBoundaryState
> {
  static override contextType = QueryClientContext;

  /** The app's query client, when a `QueryClientProvider` is above (none in some tests). */
  declare context: QueryClient | undefined;

  override state: ScreenErrorBoundaryState = {
    error: null,
    failed: false,
    attempt: 0,
    failedKey: undefined,
  };

  static getDerivedStateFromError(
    error: unknown,
  ): Partial<ScreenErrorBoundaryState> {
    return { error, failed: true };
  }

  static getDerivedStateFromProps(
    props: ScreenErrorBoundaryProps,
    state: ScreenErrorBoundaryState,
  ): Partial<ScreenErrorBoundaryState> | null {
    // Remember where it failed; a new location clears the failure.
    if (state.failed && state.failedKey === undefined) {
      return { failedKey: props.resetKey ?? "" };
    }
    if (state.failed && state.failedKey !== (props.resetKey ?? "")) {
      return {
        error: null,
        failed: false,
        failedKey: undefined,
        attempt: state.attempt + 1,
      };
    }
    return null;
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  /** Resets the screen's cached answers, then mounts it again. */
  private readonly reload = () => {
    if (this.context) {
      void resetScreenQueries(this.context);
    }
    this.setState((state) => ({
      error: null,
      failed: false,
      failedKey: undefined,
      attempt: state.attempt + 1,
    }));
  };

  override render(): ReactNode {
    const { error, failed, attempt } = this.state;
    if (!failed) {
      return <ScreenAttempt key={attempt}>{this.props.children}</ScreenAttempt>;
    }
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    return (
      <div
        className="screen screen-error"
        data-testid="screen-error"
      >
        <div
          className="error-view"
          role="alert"
        >
          <h1 className="error-view-title">This screen failed to show</h1>
          <p className="error-view-detail">
            Something went wrong while drawing it. The rest of the app still
            works: reload the screen, or pick another one.
          </p>
          <p className="error-view-meta">
            <code>{message}</code>
          </p>
          <Button
            variant="primary"
            onClick={this.reload}
          >
            Reload this screen
          </Button>
        </div>
      </div>
    );
  }
}

/** A keyed wrapper: a new key remounts the screen with fresh state. */
function ScreenAttempt({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
