import type { Logger } from "../shared/logger";
import type { ProviderApiVersions } from "./define";

/**
 * The contexts a provider is handed: once when it is configured
 * ({@link ProviderSetupContext}), and on every facet call
 * ({@link ProviderCallContext}).
 */

/** What every facet call receives. */
export interface ProviderCallContext {
  /** Aborted when the call's timeout (`summonTimeout`) passes. Honour it. */
  readonly signal: AbortSignal;
  /**
   * A logger bound to the controller's queue and the attempt, with the
   * provider's declared secrets and the usual credential shapes redacted.
   */
  readonly logger: Logger;
  /** The `fetch` to use for every platform call. The global one. */
  readonly fetch: typeof fetch;
  /** The host's clock, epoch ms. */
  readonly now: () => number;
}

/** What a facet factory receives once, when a provider is configured. */
export interface ProviderSetupContext {
  /**
   * The versions the host negotiated for this provider, per facet, as
   * `"major.minor"`: the lower of the provider's and the host's minor. A
   * provider written for a newer minor can degrade here.
   */
  readonly api: ProviderApiVersions;
  /** The host's bun-jobs version, for diagnostics only. Never branch on it; branch on `api`. */
  readonly hostVersion: string;
  /** A logger bound to the provider, with its declared secrets redacted. */
  readonly logger: Logger;
}

/**
 * Internal: a call context. The one place one is built, so every facet call
 * (the controller's, and `ConfiguredProvider.validate`) gets the same shape.
 */
export function providerCallContext(
  /** The call's abort signal. */
  signal: AbortSignal,
  /** The call's logger, already redacting. */
  logger: Logger,
): ProviderCallContext {
  return {
    signal,
    logger,
    fetch: globalThis.fetch,
    now: Date.now,
  };
}
