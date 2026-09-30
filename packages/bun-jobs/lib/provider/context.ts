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
  /**
   * The `fetch` to use for every platform call. The global one, except under
   * the conformance kit (`./provider/testing`), which replaces it to route
   * and record platform requests: a provider calling the global `fetch`
   * directly fails the kit's routing check.
   */
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
 * Internal: the property a `SummonController`'s options carry the conformance
 * kit's `fetch` under, so its calls' `ctx.fetch` is the kit's (summon-compute
 * §13.10 Q-p7). A `Symbol.for` key, so a kit from another copy of the package
 * still reaches it; exported from no entry, so it adds nothing to the public
 * surface. Nothing but the kit sets it.
 */
export const PROVIDER_FETCH_PROBE: unique symbol = Symbol.for(
  "@kingsleyweb/bun-jobs:provider-fetch-probe",
);

/**
 * Internal: a call context. The one place one is built, so every facet call
 * (the controller's, and `ConfiguredProvider.validate`) gets the same shape.
 */
export function providerCallContext(
  /** The call's abort signal. */
  signal: AbortSignal,
  /** The call's logger, already redacting. */
  logger: Logger,
  /** The `fetch` to hand the provider. Defaults to the global one. */
  fetchFn: typeof fetch = globalThis.fetch,
): ProviderCallContext {
  return {
    signal,
    logger,
    fetch: fetchFn,
    now: Date.now,
  };
}
