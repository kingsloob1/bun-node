import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./api/errors";
import { queryKeys } from "./api/queryKeys";

/** How often screens poll until the live socket lands (milestone 4). */
export const POLL_INTERVAL_MS = 5_000;

/** Most retries of a failed read. */
const MAX_RETRIES = 2;

/**
 * Retries network failures and 5xx, never a 4xx: a 401/403/404/400 will not
 * change by asking again, and retrying a 401 delays the sign-in message.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

/** Options of {@link createQueryClient}. */
export interface CreateQueryClientOptions {
  /** Retry failed reads (see {@link shouldRetry}). Defaults to `true`; tests pass `false`. */
  retry?: boolean;
}

/** The app's TanStack Query client. */
export function createQueryClient(
  options: CreateQueryClientOptions = {},
): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: options.retry === false ? false : shouldRetry,
        staleTime: 2_000,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Before "Reload this screen" (`ScreenErrorBoundary`) remounts a crashed
 * screen, drops the cached answers the screen read, so it reads them again:
 * a crash caused by the DATA would otherwise render the same cached answer
 * and crash again at once.
 *
 * Only inactive queries are reset, and never `/meta*`. The crashed screen's
 * queries are inactive by then (the screen is unmounted), so they come back
 * empty and refetch as the screen remounts; the frame's live queries (header,
 * nav, status) keep their data and are not re-requested; and the bootstrap
 * (`/meta`, `/meta/permissions`) is kept, since re-reading it would flash
 * the whole app.
 */
export function resetScreenQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.resetQueries({
    type: "inactive",
    predicate: (query) => query.queryKey[0] !== queryKeys.metaAll[0],
  });
}
