import { ConfigError, JobsError } from "../shared/errors";

/**
 * What a provider throws when the platform did not answer normally
 * (plugins §6.5), and how the summon controller treats each kind.
 *
 * The rule for authors: **a `SummonResult` when the platform answered
 * normally** (`started`, `deduped`, `already-running`, `unavailable`), **a
 * {@link ProviderError} when it did not.** Anything else a provider throws is
 * treated as `transient`, and logged once per provider as a plugin bug.
 */

/**
 * How a platform failure should be treated:
 *
 * - `"transient"`: a network error, a 5xx, a timeout the platform reported.
 *   Outcome `failed`, counted toward the circuit, the normal backoff.
 * - `"throttled"`: a 429 or a rate-limit code. Outcome `unavailable`, **not**
 *   counted toward the circuit, backoff at least `retryAfterMs`.
 * - `"quota"`: an account or regional limit (Fargate vCPU, Lambda
 *   concurrency, a plan cap). Outcome `unavailable`, counted, backoff at least
 *   `retryAfterMs`.
 * - `"auth"`: credentials missing, expired or rejected (401, 403, a failed
 *   token exchange). Outcome `failed`, and the circuit **opens at once**.
 * - `"misconfigured"`: the config names something that is not there or is
 *   invalid (a 404 cluster, a bad parameter). As `"auth"`.
 * - `"conflict"`: the platform refused a request as inconsistent with an
 *   earlier one under the same token, so the request was not a pure function
 *   of its dedupe key: a provider bug. Outcome `failed`, counted, and an
 *   `error` log saying so.
 */
export type ProviderErrorKind =
  | "transient"
  | "throttled"
  | "quota"
  | "auth"
  | "misconfigured"
  | "conflict";

/** Every {@link ProviderErrorKind}, for the constructor's check. */
const KINDS: ReadonlySet<string> = new Set<ProviderErrorKind>([
  "transient",
  "throttled",
  "quota",
  "auth",
  "misconfigured",
  "conflict",
]);

/** A kind's `code`: `"PROVIDER_"` and the kind in capitals, e.g. `"PROVIDER_THROTTLED"`. */
function codeOf(kind: ProviderErrorKind): string {
  return `PROVIDER_${kind.toUpperCase()}`;
}

/**
 * What a provider throws when the platform did not answer normally. Its
 * `code` is `PROVIDER_<KIND>` (`PROVIDER_AUTH`, `PROVIDER_THROTTLED`, …).
 *
 * ```ts
 * if (response.status === 429) {
 *   throw new ProviderError("the platform is throttling RunTask", "throttled", {
 *     platformCode: "ThrottlingException",
 *     status: 429,
 *     retryAfterMs: Number(response.headers.get("retry-after")) * 1000,
 *   });
 * }
 * ```
 *
 * The attempt's `last.detail` (and its `summon` event's `detail`) is the
 * `platformCode` when there is one, else the `code`.
 *
 * @throws {ConfigError} for a `kind` that is not a {@link ProviderErrorKind}.
 */
export class ProviderError extends JobsError {
  /** How the failure should be treated. See {@link ProviderErrorKind}. */
  readonly kind: ProviderErrorKind;
  /**
   * The platform's own error code, when known (`"ThrottlingException"`,
   * `"CannotPullContainerError"`): the attempt's detail, in logs and the UI.
   * The controller uses it only if it matches `[A-Za-z0-9_.:-]{1,64}`, and
   * falls back to the `code` otherwise.
   *
   * **It is shown to API clients, so it must never hold a credential.** A
   * code-shaped token (`sk_live_abc123`) passes that rule and matches no
   * redaction pattern, so it would be stored and served verbatim: only a
   * value at one of the provider's declared `secrets` is redacted from it.
   */
  readonly platformCode?: string;
  /** The platform's HTTP status, when there was one. */
  readonly status?: number;
  /**
   * Try no sooner than this many ms from now, when the platform said.
   * Honoured for `throttled` and `quota`: the backoff is at least this long,
   * up to the larger of the policy's `backoff.max` and `circuit.resetAfter`,
   * where the controller clamps it. A value that is not a finite number of 0
   * or more is dropped.
   */
  readonly retryAfterMs?: number;

  constructor(
    /** A short, secret-free description. */
    message: string,
    /** How the failure should be treated. */
    kind: ProviderErrorKind,
    /** What else the platform said. */
    options?: {
      /**
       * The platform's own error code, e.g. `"ThrottlingException"`, for logs
       * and the UI. Shown to API clients: never a credential (see
       * {@link ProviderError.platformCode}).
       */
      platformCode?: string;
      /** The HTTP status the platform answered, when there was one. */
      status?: number;
      /** Try no sooner than this many ms from now. Honoured for `throttled` and `quota`. */
      retryAfterMs?: number;
      /** The original error, kept as `cause`. Redacted before it is logged. */
      cause?: unknown;
    },
  ) {
    if (!KINDS.has(kind)) {
      throw new ConfigError(
        `A ProviderError's kind must be one of ${[...KINDS].join(", ")}`,
        { kind },
      );
    }
    const platformCode =
      typeof options?.platformCode === "string" &&
      options.platformCode.length > 0
        ? options.platformCode
        : undefined;
    const status =
      typeof options?.status === "number" && Number.isFinite(options.status)
        ? options.status
        : undefined;
    const retryAfterMs =
      typeof options?.retryAfterMs === "number" &&
      Number.isFinite(options.retryAfterMs) &&
      options.retryAfterMs >= 0
        ? Math.ceil(options.retryAfterMs)
        : undefined;
    super(
      message,
      codeOf(kind),
      {
        kind,
        ...(platformCode === undefined ? {} : { platformCode }),
        ...(status === undefined ? {} : { status }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
      options !== undefined && "cause" in options
        ? { cause: options.cause }
        : undefined,
    );
    this.kind = kind;
    this.platformCode = platformCode;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Internal: the facts of a {@link ProviderError}, or `undefined` for anything
 * else. Recognised by class, or by shape — an `Error` whose `kind` is a
 * {@link ProviderErrorKind} and whose `code` is that kind's — so one thrown
 * by another copy of this package (a plugin with its own install) still
 * counts.
 */
export function providerErrorFacts(
  value: unknown,
):
  | Pick<ProviderError, "kind" | "code" | "platformCode" | "retryAfterMs">
  | undefined {
  if (!(value instanceof Error)) {
    return undefined;
  }
  const { kind, code, platformCode, retryAfterMs } = value as Partial<
    Record<"kind" | "code" | "platformCode" | "retryAfterMs", unknown>
  >;
  if (
    typeof kind !== "string" ||
    !KINDS.has(kind) ||
    code !== codeOf(kind as ProviderErrorKind)
  ) {
    return undefined;
  }
  return {
    kind: kind as ProviderErrorKind,
    code,
    ...(typeof platformCode === "string" && platformCode.length > 0
      ? { platformCode }
      : {}),
    ...(typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0
      ? { retryAfterMs }
      : {}),
  };
}
