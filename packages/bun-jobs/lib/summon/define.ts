import type {
  ProviderCallContext,
  SummonCapabilities,
  SummonDedupe,
  Summoner,
  SummonerFunction,
  SummonFacet,
  SummonReleaseRequest,
  SummonRequest,
  SummonResult,
} from "./types";
import { facetReadiness } from "../provider/configure";
import {
  COMPUTE_PROVIDER,
  CONFIGURED_PROVIDER,
  defineProvider,
  PROVIDER_KIND,
} from "../provider/define";
import { COMPUTE_PROVIDER_API } from "../provider/version";
import { ConfigError } from "../shared/errors";

/** `defineSummoner`'s in-flight TTL when none is given: a conservative guess, nothing was measured. */
export const DEFAULT_BOOT_BUDGET = 180_000;

/** The stop signal and grace `defineSummoner` declares when none is given. */
const DEFAULT_SHUTDOWN = Object.freeze({
  signal: "SIGTERM",
  graceMs: 10_000,
} as const);

/** What {@link defineSummoner} takes. */
export interface DefineSummonerOptions {
  /** The kind shown in logs and the UI: lowercase, `[a-z0-9-]{1,24}`. Defaults to `"custom"`. */
  kind?: string;
  /** `"launch"` (default), `"scale"` or `"wake"`. A scale summoner must also give `release`. */
  style?: "launch" | "scale" | "wake";
  /** The in-flight TTL in ms. Defaults to `180_000`: a conservative guess, since nothing was measured. */
  bootBudget?: number;
  /**
   * How the platform passes per-attempt values: `"argv"` (default), or
   * `"none"` when the unit's command line is fixed (attempts are then released
   * by start time rather than by id).
   */
  passes?: "argv" | "none";
  /** How the platform dedupes. Defaults to `{ kind: "none" }`: the marker is the whole guard. */
  dedupe?: SummonDedupe;
  /** The stop signal and grace. Defaults to `{ signal: "SIGTERM", graceMs: 10_000 }`. */
  shutdown?: SummonCapabilities["shutdown"];
  /**
   * Starts compute. Returning nothing counts as `{ status: "started",
   * handles: [] }`; a throw is recorded as `failed`.
   */
  invoke: SummonerFunction;
  /** Scale-style only, and then required: sets the count. */
  release?: (
    request: SummonReleaseRequest,
    context: ProviderCallContext,
  ) => Promise<void>;
  /** Secret-free description for the UI. Defaults to `{ kind }`. */
  describe?: () => Record<string, string>;
}

/** A positive whole number of ms, or a `ConfigError` naming the option. */
function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(
      `${name} must be a positive whole number of milliseconds`,
      { [name]: value },
    );
  }
  return value;
}

/**
 * The escape hatch: a summoner from a plain function, for any platform with
 * no provider plugin.
 *
 * ```ts
 * const summoner = defineSummoner({
 *   kind: "my-cloud",
 *   invoke: async (request) => {
 *     await fetch("https://api.my-cloud.example/run", {
 *       method: "POST",
 *       headers: { "idempotency-key": request.dedupeKey },
 *       body: JSON.stringify({ args: request.argv }),
 *     });
 *   },
 * });
 * ```
 *
 * It builds an anonymous provider (`name: "custom:" + kind`, version
 * `"0.0.0"`) whose summon facet wraps `invoke`. A bare function in
 * `SummonPolicy.summoner` is shorthand for `defineSummoner({ invoke })`.
 *
 * @throws {ConfigError} on a malformed option: a `kind` outside
 *   `[a-z0-9-]{1,24}`, a non-positive duration, or a scale style without
 *   `release`.
 */
export function defineSummoner(options: DefineSummonerOptions): Summoner {
  if (typeof options?.invoke !== "function") {
    throw new ConfigError("defineSummoner needs an invoke function");
  }
  const kind = options.kind ?? "custom";
  if (!PROVIDER_KIND.test(kind)) {
    throw new ConfigError(
      "A summoner's kind must be 1-24 characters of lowercase letters, digits and dashes",
      { kind },
    );
  }
  const style = options.style ?? "launch";
  if (style === "scale" && typeof options.release !== "function") {
    throw new ConfigError(
      "A scale-style summoner needs release(): nothing else can set its count back to zero",
      { kind },
    );
  }
  const shutdown = options.shutdown ?? DEFAULT_SHUTDOWN;
  if (!Number.isSafeInteger(shutdown.graceMs) || shutdown.graceMs < 0) {
    throw new ConfigError(
      "shutdown.graceMs must be a whole number of milliseconds",
      { graceMs: shutdown.graceMs },
    );
  }

  const capabilities: SummonCapabilities = Object.freeze({
    style,
    dedupe: options.dedupe ?? { kind: "none" as const },
    passes: options.passes ?? "argv",
    bootBudgetMs: positive(
      "bootBudget",
      options.bootBudget ?? DEFAULT_BOOT_BUDGET,
    ),
    shutdown,
    maxLifetimeMs: null,
    enforcesLifetime: false,
  });

  const invoke = options.invoke;
  const release = options.release;
  const describe = options.describe;
  const facet: SummonFacet = Object.freeze({
    capabilities,
    summon: async (
      request: SummonRequest,
      context: ProviderCallContext,
    ): Promise<SummonResult> =>
      (await invoke(request, context)) ?? { status: "started", handles: [] },
    ...(release === undefined ? {} : { release }),
  });

  // An anonymous provider, built by the host at the host's API version, so
  // it can never be out of date; registration never warns about it.
  const provider = defineProvider<undefined, undefined>(
    {
      name: `custom:${kind}`,
      version: "0.0.0",
      kind,
      apiVersion: {
        core: COMPUTE_PROVIDER_API.core,
        summon: COMPUTE_PROVIDER_API.summon,
      },
      describe: () => ({ kind, ...(describe?.() ?? {}) }),
      summon: () => facet,
    },
    true,
  );
  return provider() as Summoner;
}

/**
 * A policy's `summoner`, as a `Summoner`: a bare function goes through
 * {@link defineSummoner}; an object must carry the configured-provider brand
 * and a summon facet.
 *
 * @throws {ConfigError} for a provider passed unconfigured, a configured
 *   provider with no summon facet, or an object without the brand (a
 *   hand-built literal: wrap its function in `defineSummoner`).
 */
export function toSummoner(summoner: Summoner | SummonerFunction): Summoner {
  if (typeof summoner === "function") {
    if (
      (summoner as { [COMPUTE_PROVIDER]?: unknown })[COMPUTE_PROVIDER] === true
    ) {
      throw new ConfigError(
        "summoner is a compute provider that was not configured: call it with its config, e.g. summoner: acme({ … })",
      );
    }
    return defineSummoner({ invoke: summoner });
  }
  if (typeof summoner !== "object" || summoner === null) {
    throw new ConfigError(
      "summoner must be a function, or a Summoner from defineSummoner() or a provider",
    );
  }
  const facet = (summoner as Partial<Summoner>).summon;
  if (summoner[CONFIGURED_PROVIDER] !== true) {
    throw new ConfigError(
      typeof facet?.summon === "function"
        ? "summoner is a hand-built object: a Summoner must come from defineSummoner() or a compute provider. Wrap its function in defineSummoner({ invoke }), or write it with defineComputeProvider"
        : "summoner must be a function, or a Summoner from defineSummoner() or a provider",
    );
  }
  if (
    typeof facet !== "object" ||
    facet === null ||
    typeof facet.summon !== "function" ||
    // A stand-in facet (config still validating) has no capabilities yet.
    (facetReadiness(facet).settled() !== undefined &&
      typeof facet.capabilities !== "object")
  ) {
    throw new ConfigError(
      `Compute provider ${summoner.provider?.name ?? "(unnamed)"} has no summon facet, so it cannot be a summoner`,
    );
  }
  return summoner;
}
