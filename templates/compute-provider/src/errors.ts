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
  // `Object.hasOwn`, not `in`: `in` also finds `constructor`, `toString` and
  // `__proto__` on the prototype, and a body naming one would then map to a
  // function instead of a kind.
  return typeof code === "string" && Object.hasOwn(BY_CODE, code)
    ? code
    : undefined;
}

/** RFC 9110 delay-seconds: digits only, so `0x10`, `1e3`, `1.5` and `-3` are not. */
const DELAY_SECONDS = /^\d+$/;

/**
 * The start of an RFC 9110 HTTP-date, in each of its three forms
 * (`Sun, 06 Nov 1994 …`, `Sunday, 06-Nov-94 …`, `Sun Nov  6 …`). Checked
 * before `Date.parse`, which also reads `1.5` and `-3` as dates.
 */
const HTTP_DATE = /^[A-Z][a-z]{2,8},? /;

/**
 * `Retry-After` in ms: delay-seconds, or an HTTP-date (the time left, 0 once
 * it has passed). `undefined` when absent or in any other form, so the
 * controller's own backoff applies.
 */
function retryAfterMs(header: string | null, now: number): number | undefined {
  const value = header?.trim() ?? "";
  if (DELAY_SECONDS.test(value)) {
    return Number(value) * 1_000;
  }
  const date = HTTP_DATE.test(value) ? Date.parse(value) : Number.NaN;
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
