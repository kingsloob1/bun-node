/** The security app's query cache. */
import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./api/errors";

/** How often a screen re-reads while the live stream is down, ms. */
export const POLL_INTERVAL_MS = 15_000;

/** The meta queries' first key: kept when a screen resets its own. */
export const META_KEY = "meta";

/** Retries a read that failed for a reason a retry can fix (no 4xx). */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500)
    return false;
  return failureCount < 2;
}

/** Options of {@link createQueryClient}. */
export interface CreateQueryClientOptions {
  /** Retry failed reads. Default `true`; tests pass `false`. */
  retry?: boolean;
}

/** A new query cache. */
export function createQueryClient(
  options: CreateQueryClientOptions = {},
): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: options.retry === false ? false : shouldRetry,
        refetchOnWindowFocus: false,
        staleTime: 5_000,
      },
      mutations: { retry: false },
    },
  });
}

/** Resets a screen's inactive queries ("Reload this screen"), keeping meta. */
export function resetScreenQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.resetQueries({
    type: "inactive",
    predicate: (query) => query.queryKey[0] !== META_KEY,
  });
}
