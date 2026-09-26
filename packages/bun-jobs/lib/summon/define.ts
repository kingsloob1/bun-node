import type {
  ProviderCallContext,
  SummonCapabilities,
  SummonDedupe,
  Summoner,
  SummonerFunction,
  SummonReleaseRequest,
  SummonRequest,
  SummonResult,
} from "./types";
import { ConfigError } from "../shared/errors";

/**
 * The plugin API versions a summoner built here speaks. It is built by the
 * host, so it can never be out of date.
 */
const HOST_API = Object.freeze({ core: "0.1", summon: "0.1" });

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
  if (!/^[a-z0-9-]{1,24}$/.test(kind)) {
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

  return Object.freeze({
    provider: Object.freeze({
      name: `custom:${kind}`,
      version: "0.0.0",
      kind,
      apiVersion: HOST_API,
    }),
    summon: Object.freeze({
      capabilities,
      summon: async (
        request: SummonRequest,
        context: ProviderCallContext,
      ): Promise<SummonResult> =>
        (await invoke(request, context)) ?? { status: "started", handles: [] },
      ...(release === undefined ? {} : { release }),
    }),
    describe: () => ({ kind, ...(describe?.() ?? {}) }),
  });
}

/** A policy's `summoner`, as a `Summoner`: a bare function goes through {@link defineSummoner}. */
export function toSummoner(summoner: Summoner | SummonerFunction): Summoner {
  if (typeof summoner === "function") {
    return defineSummoner({ invoke: summoner });
  }
  if (
    typeof summoner !== "object" ||
    summoner === null ||
    typeof summoner.summon?.summon !== "function" ||
    typeof summoner.summon.capabilities !== "object"
  ) {
    throw new ConfigError(
      "summoner must be a function, or a Summoner from defineSummoner() or a provider",
    );
  }
  return summoner;
}
