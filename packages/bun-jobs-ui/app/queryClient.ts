import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./api/errors";

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
