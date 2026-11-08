import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./api/errors";

/** Most retries of a failed read. */
const MAX_RETRIES = 2;

/**
 * Retries network failures and 5xx, never a 4xx: a 401/403/404/400 will not
 * change by asking again, and retrying a 401 delays the sign-in message.
 * Nor a malformed response (kind `parse`): the host answered, and answering
 * the same again would only hold the error back for the retries' backoff.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (
    isApiError(error) &&
    (error.kind === "parse" || (error.status >= 400 && error.status < 500))
  ) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

/** Options of {@link createQueryClient}. */
export interface CreateQueryClientOptions {
  /** Retry failed reads (see {@link shouldRetry}). Defaults to `true`; tests pass `false`. */
  retry?: boolean;
}

/** The viewer's TanStack Query client. */
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
 * and crash again at once. Only inactive queries are reset; the crashed
 * screen's are inactive by then.
 */
export function resetScreenQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.resetQueries({ type: "inactive" });
}
