/**
 * An analytics panel's frame (PR-U2): a card with its title, and its read's
 * state: a spinner while loading, the error (with a retry) when it failed,
 * "not recorded here" when the deployment does not keep it (a 404).
 */
import type { ReactNode } from "react";
import { Card } from "../../kit/components/Card";
import { Spinner } from "../../kit/components/Spinner";
import { isApiError } from "../api/errors";
import { ErrorView } from "../components/ErrorView";

/** A read's state, as `useQuery` reports it. */
export interface PanelState {
  /** Still loading. */
  readonly isPending: boolean;
  /** Its error, if it failed. */
  readonly error: unknown;
  /** Retries. */
  readonly refetch: () => unknown;
}

/** Props of {@link Panel}. */
export interface PanelProps {
  /** The panel's title. */
  title: string;
  /** A test id. */
  testId: string;
  /** Its reads: the panel waits for all of them. */
  states: readonly PanelState[];
  /** Controls beside the title (a selector). */
  actions?: ReactNode;
  /** The content, once every read answered. */
  children: () => ReactNode;
  /** Extra class names. */
  className?: string;
}

/** See the module's description. */
export function Panel({
  title,
  testId,
  states,
  actions,
  children,
  className,
}: PanelProps) {
  const failed = states.find(
    (state) => state.error !== null && state.error !== undefined,
  );
  let body: ReactNode;
  if (failed !== undefined) {
    body =
      isApiError(failed.error) && failed.error.status === 404 ? (
        <p className="panel-absent">Not recorded by this deployment.</p>
      ) : (
        <ErrorView
          error={failed.error}
          title={`${title} could not be read`}
          headingLevel={3}
          onRetry={() => {
            for (const state of states) void state.refetch();
          }}
        />
      );
  } else if (states.some((state) => state.isPending)) {
    body = <Spinner label={`Loading ${title.toLowerCase()}`} />;
  } else {
    body = children();
  }
  return (
    <div
      className={`analytics-panel ${className ?? ""}`}
      data-testid={testId}
    >
      <Card
        title={title}
        actions={actions}
      >
        {body}
      </Card>
    </div>
  );
}
