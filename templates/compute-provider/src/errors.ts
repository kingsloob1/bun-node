import type { ProviderErrorKind } from "@kingsleyweb/bun-jobs/provider";
import { ProviderError } from "@kingsleyweb/bun-jobs/provider";

/**
 * Platform errors → `ProviderError`, in one table. The rule: a `SummonResult`
 * when the platform answered normally, a `ProviderError` when it did not. The
 * kind decides what the summon controller does:
 *
 * | Kind | Acme says | The controller |
 * |---|---|---|
 * | `throttled` | 429 `RateLimited` | `unavailable`, not counted toward the circuit, waits `Retry-After` |
 * | `quota` | 429 `QuotaExceeded` | `unavailable`, counted, waits `Retry-After` |
 * | `auth` | 401 `InvalidToken`, 403 `Forbidden` | `failed`, opens the circuit at once |
 * | `misconfigured` | 404 `PoolNotFound`, 400 `InvalidParameter` | as `auth` |
 * | `conflict` | 409 `TokenReused` | `failed`, logs an error: the request was not a pure function of its token |
 * | `transient` | 5xx, a network error, anything unknown | `failed`, counted, the normal backoff |
 */

/** Acme's error codes, by the kind each means. The code decides first: Acme sends 429 for two kinds. */
const BY_CODE: Readonly<Record<string, ProviderErrorKind>> = {
  RateLimited: "throttled",
  QuotaExceeded: "quota",
  InvalidToken: "auth",
  Forbidden: "auth",
  PoolNotFound: "misconfigured",
  InvalidParameter: "misconfigured",
  TokenReused: "conflict",
};

/** The kind a status means, for a body with no code the table knows. */
function byStatus(status: number): ProviderErrorKind {
  if (status === 429) {
    return "throttled";
  }
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 400 || status === 404) {
    return "misconfigured";
  }
  return status === 409 ? "conflict" : "transient";
}

/**
 * What the controller may show as the attempt's detail: a platform code is
 * shown to API clients, so only a code-shaped value from the table passes,
 * never free text from the body.
 */
function platformCodeOf(code: unknown): string | undefined {
  return typeof code === "string" && code in BY_CODE ? code : undefined;
}

/** `Retry-After` in ms: whole seconds, or an HTTP date. `undefined` when absent or unreadable. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null || header.trim() === "") {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * The `ProviderError` for a response that was not OK. The message says only
 * the status and the code: an error body can echo a request, token and all.
 */
export async function acmeError(
  response: Response,
  now: number,
): Promise<ProviderError> {
  const body = (await response.json().catch(() => undefined)) as
    | { error?: { code?: unknown } }
    | undefined;
  const platformCode = platformCodeOf(body?.error?.code);
  const kind =
    (platformCode === undefined ? undefined : BY_CODE[platformCode]) ??
    byStatus(response.status);
  const wait = retryAfterMs(response.headers.get("retry-after"), now);
  return new ProviderError(
    `Acme answered ${response.status}${platformCode === undefined ? "" : ` ${platformCode}`}`,
    kind,
    {
      ...(platformCode === undefined ? {} : { platformCode }),
      status: response.status,
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    },
  );
}

/** A request that never got an answer (DNS, a refused connection): `transient`, keeping the cause. */
export function unreachable(cause: unknown): ProviderError {
  return new ProviderError("Acme did not answer", "transient", { cause });
}
