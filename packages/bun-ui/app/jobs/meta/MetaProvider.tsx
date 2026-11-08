import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { isApiError } from "../api/errors";
import { queryKeys } from "../api/queryKeys";
import { ErrorView } from "../components/ErrorView";
import { Spinner } from "../components/Spinner";
import { useApiClient, useUiConfig } from "../context";
import { MetaContext } from "./hooks";

/** Props of {@link BootstrapError}. */
export interface BootstrapErrorProps {
  /** Why the bootstrap failed. */
  error: unknown;
  /** Reloads meta and permissions. */
  onRetry: () => void;
}

/** The full-page screen when `/meta` or `/meta/permissions` failed. */
export function BootstrapError({ error, onRetry }: BootstrapErrorProps) {
  const config = useUiConfig();
  const status = isApiError(error) ? error.status : 0;
  const title =
    status === 401
      ? "Sign in required"
      : status === 403
        ? "Access denied"
        : "The jobs API could not be loaded";
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
    </main>
  );
}

/** Props of {@link MetaProvider}. */
export interface MetaProviderProps {
  /** Rendered once meta and permissions have loaded. */
  children: ReactNode;
}

/**
 * Loads `/meta` and `/meta/permissions` before anything else renders. Every
 * screen, nav entry and button is gated on what they say; while they load a
 * spinner shows, and a failure (401/403 included) shows {@link BootstrapError}.
 */
export function MetaProvider({ children }: MetaProviderProps) {
  const api = useApiClient();
  const meta = useQuery({
    queryKey: queryKeys.meta(),
    queryFn: ({ signal }) => api.getMeta(signal),
    staleTime: 60_000,
  });
  const permissions = useQuery({
    queryKey: queryKeys.permissions(),
    queryFn: ({ signal }) => api.getPermissions(undefined, signal),
    staleTime: 60_000,
  });

  const value = useMemo(
    () =>
      meta.data && permissions.data
        ? { meta: meta.data, permissions: permissions.data }
        : null,
    [meta.data, permissions.data],
  );

  const error = meta.error ?? permissions.error;
  if (error && !value) {
    return (
      <BootstrapError
        error={error}
        onRetry={() => {
          void meta.refetch();
          void permissions.refetch();
        }}
      />
    );
  }
  if (!value) {
    return (
      <main
        className="bootstrap-screen"
        data-testid="bootstrap-loading"
      >
        <Spinner
          label="Loading the jobs API"
          showLabel
        />
      </main>
    );
  }
  return <MetaContext value={value}>{children}</MetaContext>;
}
