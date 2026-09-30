import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type {
  SummonReleaseRequest,
  SummonRequest,
  SummonResult,
} from "../summon/types";
import type { ProviderCallContext, ProviderSetupContext } from "./context";
import { ConfigError } from "../shared/errors";
import { configure } from "./configure";
import { checkApiVersions, markHostBuilt } from "./version";

/**
 * The provider plugin API's core (plugins §6–§7): who a provider is, what it
 * declares, and `defineComputeProvider`, which makes one.
 *
 * A provider is a factory: `defineComputeProvider(definition)` returns a
 * function that takes the user's config and answers a configured provider,
 * whose `summon` facet was built from the validated config. A configured
 * provider with a `summon` facet is what `SummonPolicy.summoner` accepts.
 */

/**
 * The brand on a provider (what `defineComputeProvider` returns). A
 * `Symbol.for` key, so two copies of bun-jobs in one tree recognise each
 * other's providers.
 */
export const COMPUTE_PROVIDER: unique symbol = Symbol.for(
  "@kingsleyweb/bun-jobs/compute-provider",
);

/**
 * The brand on a configured provider. An own, enumerable `Symbol.for` key,
 * so a spread of a configured provider (to wrap its facet) keeps it.
 */
export const CONFIGURED_PROVIDER: unique symbol = Symbol.for(
  "@kingsleyweb/bun-jobs/configured-provider",
);

/** The plugin API versions a provider was written against. */
export interface ProviderApiVersions {
  /** The core version, `"major.minor"`. Required. */
  core: string;
  /** The summon facet version, when the provider has a `summon` facet. */
  summon?: string;
}

/** Who a provider is. Shown in logs, events, the status route and the UI. */
export interface ProviderIdentity {
  /**
   * The provider's unique name: its npm package name, optionally with a
   * `:variant`, e.g. `"@kingsleyweb/bun-jobs:ecs"`. `defineSummoner` names
   * its anonymous provider `"custom:" + kind`. Never parsed.
   */
  readonly name: string;
  /** The provider's own version, semver. `"0.0.0"` for a `defineSummoner` one. */
  readonly version: string;
  /** A short label for badges and event payloads, e.g. `"ecs"`, `"fly"`. */
  readonly kind: string;
  /** A human name for the UI. Defaults to `kind`. */
  readonly displayName?: string;
  /** Where its documentation lives. */
  readonly homepage?: string;
  /** The plugin API versions it was written against. */
  readonly apiVersion: ProviderApiVersions;
}

/** How a platform dedupes a retried call, and the key it accepts. */
export type SummonDedupe =
  | {
      /** A request token the platform remembers: ECS `clientToken`, EC2 `ClientToken`. */
      kind: "token";
      /** The longest key it accepts. `request.dedupeKey` is clipped to fit. */
      maxLength: number;
      /** The characters it accepts, as a character-class body, e.g. `"A-Za-z0-9-"`. */
      charset: string;
      /** What the token is unique within, for the docs and the UI, e.g. `"cluster"`. */
      scope: string;
      /** How long the platform remembers it, in ms, when documented (ECS: up to 24 h). */
      ttlMs?: number;
      /**
       * Whether a same-token request with different parameters is an error
       * (ECS `ConflictException`). When `true`, requests must be pure
       * functions of the key — which the controller guarantees for everything
       * it builds (`SummonRequest.demand` and `reason` excepted: never send
       * those to such a platform).
       */
      strict: boolean;
    }
  | {
      /** A name the platform will not create twice: a systemd unit, a Kubernetes Job. */
      kind: "name";
      /** The longest name it accepts. */
      maxLength: number;
      /** The characters it accepts, as a character-class body. */
      charset: string;
    }
  | {
      /** No platform dedupe. The marker's compare-and-set is the whole guard. */
      kind: "none";
    };

/** What a summon facet declares. The controller reads these instead of knowing platforms by name. */
export interface SummonCapabilities {
  /**
   * How it starts compute: `"launch"` starts N new units (a race can double
   * up, so the marker is claimed first); `"scale"` sets a count, idempotent,
   * and needs `release()` to go back to zero; `"wake"` starts one of a fixed
   * pool of pre-created units, behaving as launch with `maxWorkers` clamped
   * to `poolSize`.
   */
  style: "launch" | "scale" | "wake";
  /** How the platform deduplicates a retried call. */
  dedupe: SummonDedupe;
  /**
   * How per-attempt values reach the process: `"argv"`, or `"none"` when the
   * unit's command line is fixed. With `"none"`, attempts are released by
   * start time (a live worker started at most 5 s before the attempt), not
   * by id.
   */
  passes: "argv" | "none";
  /** The default in-flight TTL, in ms. `SummonPolicy.bootBudget` overrides it. */
  bootBudgetMs: number;
  /** What the platform sends to stop a unit, and how long it waits before killing it. */
  shutdown: {
    /** The stop signal: `"SIGTERM"` on most platforms, `"SIGINT"` on Fly, `"none"` for in-invocation. */
    signal: "SIGTERM" | "SIGINT" | "none";
    /** The grace after the signal, in ms. Passed to the worker as `--bun-jobs-summon-grace-ms`. */
    graceMs: number;
    /** The most the platform allows the grace to be raised to, when known. */
    graceMaxMs?: number;
  };
  /**
   * The platform's own cap on one unit's life, in ms, or `null` for none
   * known. A `maxLifetime` above it is a `ConfigError`.
   */
  maxLifetimeMs: number | null;
  /** Whether the facet maps `request.maxLifetimeMs` onto the platform's cap. */
  enforcesLifetime: boolean;
  /** The most units one `summon()` may start, when the platform limits it. `count` is clamped to it. */
  maxCountPerCall?: number;
  /** `"wake"` only: how many units the pool has. `maxWorkers` above it is clamped, with a `warn`. */
  poolSize?: number;
}

/** One unit, as the platform reports it. */
export interface UnitStatus {
  /** The handle `summon` returned for it. */
  handle: string;
  /** Where it is. `"unknown"` when the platform no longer knows the handle. */
  state: "pending" | "running" | "exited" | "failed" | "unknown";
  /** The exit code, when it exited and the platform says. */
  exitCode?: number;
  /** A short, secret-free platform reason: `"CannotPullContainerError"`, `"OOMKilled"`. */
  detail?: string;
}

/** The summon facet: what the controller calls. */
export interface SummonFacet {
  /** What it can do. Read once, when the controller is built. */
  readonly capabilities: SummonCapabilities;
  /**
   * Starts compute for one attempt. A result when the platform answered
   * normally; a `ProviderError` when it did not, whose kind says how the
   * controller counts it (`throttled` and `quota` are `unavailable`, `auth`
   * and `misconfigured` open the circuit at once). Anything else thrown is
   * `transient`: `failed`, and counted toward the circuit.
   */
  summon: (
    request: SummonRequest,
    context: ProviderCallContext,
  ) => Promise<SummonResult>;
  /** Scale style only, and then required: set the platform's count, usually to `0`. */
  release?: (
    request: SummonReleaseRequest,
    context: ProviderCallContext,
  ) => Promise<void>;
  /**
   * What the platform says about units it started, by handle. Optional: asked
   * once when an attempt is declared lost, to explain it. The first unit's
   * `detail` becomes the attempt's `last.detail` and its `lost` event's.
   */
  status?: (
    handles: readonly string[],
    context: ProviderCallContext,
  ) => Promise<readonly UnitStatus[]>;
  /** Stops units by handle, best effort. Optional: used on a lost attempt whose unit is still pending. */
  cancel?: (
    handles: readonly string[],
    context: ProviderCallContext,
  ) => Promise<void>;
}

/** One preflight finding from `validate()`. */
export interface ProviderCheck {
  /** A stable id for the check, e.g. `"credentials"`, `"cluster-exists"`. */
  id: string;
  /** Whether it passed. `"warn"` means it works but something is off. */
  status: "pass" | "warn" | "fail";
  /** A short, secret-free explanation. */
  detail?: string;
}

/**
 * Everything a plugin author writes. `TConfig` is the validated config the
 * facets receive; `TInput` is what a user passes.
 *
 * This build has no execute facet: a definition with an `execute` key is a
 * `ConfigError`, not silently ignored.
 */
export interface ComputeProviderDefinition<
  TConfig,
  TInput = TConfig,
> extends ProviderIdentity {
  /**
   * Validates and normalises the user's config: any Standard Schema (zod,
   * valibot, arktype, or `toStandardSchema` around a function). When it
   * answers synchronously, an invalid config throws a `ConfigError` from
   * `provider(config)`; when it answers with a promise, the configured
   * provider's `ready` settles later. Omitted, the input is passed through
   * unvalidated.
   */
  readonly config?: StandardSchemaV1<TInput, TConfig>;
  /**
   * Dotted paths into the *validated* config whose values are secrets, e.g.
   * `["apiToken", "credentials.secretAccessKey"]`. Their values (8 characters
   * or more) are redacted from what the provider logs through its contexts,
   * and a `describe()` fact holding one is dropped. A path that does not
   * exist is ignored.
   */
  readonly secrets?: readonly string[];
  /**
   * Secret-free facts for the status route and the UI: a region, a cluster,
   * an app name. Never a token, a key, or a URL with credentials in it. A
   * fact holding a declared secret's value is dropped anyway.
   */
  readonly describe?: (config: TConfig) => Readonly<Record<string, string>>;
  /**
   * An optional preflight: can this config reach the platform? Resolve the
   * credentials, read the cluster, check the function exists. Called by
   * `ConfiguredProvider.validate()`. Must not start compute or spend money.
   */
  readonly validate?: (
    config: TConfig,
    context: ProviderCallContext,
  ) => Promise<readonly ProviderCheck[]>;
  /**
   * The summon facet: how to start compute. Called once, when the provider
   * is configured, with the validated config.
   */
  readonly summon?: (
    config: TConfig,
    context: ProviderSetupContext,
  ) => SummonFacet;
}

/** A provider plus a validated config: what `SummonPolicy.summoner` accepts, when it has a summon facet. */
export interface ConfiguredProvider<TConfig = unknown> {
  /** The provider's identity. */
  readonly provider: ProviderIdentity;
  /**
   * The validated config. Secret paths are still present: never serialise
   * this. `undefined` until `ready` resolves when the schema validates
   * asynchronously.
   */
  readonly config: TConfig;
  /**
   * Resolves once config validation has finished: already resolved when the
   * schema validated synchronously (an invalid config threw instead). With
   * an asynchronous schema it rejects when validation failed (a `ConfigError`
   * carrying the issues, or what the schema threw); a `SummonController`
   * then counts a failed attempt and validates again at its next attempt,
   * and this becomes that attempt's promise.
   */
  readonly ready: Promise<void>;
  /**
   * The summon facet, built from the config, when the provider has one. With
   * an asynchronous schema it is a stand-in until `ready` resolves: its
   * calls wait for the config, and reading its `capabilities` before then
   * throws a `ConfigError`.
   */
  readonly summon?: SummonFacet;
  /**
   * Secret-free facts, from the definition's `describe()`, less any fact
   * holding a declared secret's value. `{}` until the config is validated.
   */
  describe: () => Readonly<Record<string, string>>;
  /** Runs the definition's `validate()` once the config is ready, or answers `[]` when it has none. */
  validate: (options?: {
    /** Aborts the preflight. */
    signal?: AbortSignal;
  }) => Promise<readonly ProviderCheck[]>;
  /** Brand. An own enumerable key, so a spread keeps it. */
  readonly [CONFIGURED_PROVIDER]: true;
}

/**
 * A provider as a user receives it: call it with config to get a configured
 * instance. Also carries the definition, for tooling. `THasSummon` is `true`
 * when the definition has a summon facet, which makes the configured
 * instance usable as `SummonPolicy.summoner`.
 */
export interface ComputeProvider<
  TInput,
  TConfig = TInput,
  THasSummon extends boolean = boolean,
> {
  /**
   * Configures the provider. Validates at once; an invalid config throws a
   * `ConfigError` when the schema answers synchronously.
   */
  (
    ...config: undefined extends TInput ? [config?: TInput] : [config: TInput]
  ): THasSummon extends true
    ? ConfiguredProvider<TConfig> & {
        /** The summon facet, built from the config. */
        readonly summon: SummonFacet;
      }
    : ConfiguredProvider<TConfig>;
  /** The definition it was made from. Read-only; for the conformance kit and tooling. */
  readonly definition: ComputeProviderDefinition<TConfig, TInput>;
  /** Brand, so bun-jobs never has to guess what an object is. */
  readonly [COMPUTE_PROVIDER]: true;
}

/** The kind label's shape, shared with `defineSummoner`. */
export const PROVIDER_KIND = /^[a-z0-9-]{1,24}$/;

/** A non-empty string, or a `ConfigError` naming the field. */
function requireString(provider: string, field: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(
      `A compute provider's ${field} must be a non-empty string`,
      { provider, [field]: value },
    );
  }
}

/** An optional member that must be a function when present. */
function optionalFunction(
  provider: string,
  field: string,
  value: unknown,
): void {
  if (value !== undefined && typeof value !== "function") {
    throw new ConfigError(`A compute provider's ${field} must be a function`, {
      provider,
    });
  }
}

/**
 * Internal: {@link defineComputeProvider}, plus whether the host built it
 * (`defineSummoner`), which registration never warns about.
 */
export function defineProvider<TConfig, TInput>(
  definition: ComputeProviderDefinition<TConfig, TInput>,
  hostBuilt: boolean,
): ComputeProvider<TInput, TConfig> {
  if (typeof definition !== "object" || definition === null) {
    throw new ConfigError("defineComputeProvider needs a definition object");
  }
  const name = String(definition.name);
  requireString(name, "name", definition.name);
  requireString(name, "version", definition.version);
  if (
    typeof definition.kind !== "string" ||
    !PROVIDER_KIND.test(definition.kind)
  ) {
    throw new ConfigError(
      "A compute provider's kind must be 1-24 characters of lowercase letters, digits and dashes",
      { provider: name, kind: definition.kind },
    );
  }
  for (const field of ["displayName", "homepage"] as const) {
    if (
      definition[field] !== undefined &&
      typeof definition[field] !== "string"
    ) {
      throw new ConfigError(`A compute provider's ${field} must be a string`, {
        provider: name,
      });
    }
  }
  checkApiVersions(name, definition.apiVersion, {
    summon: definition.summon !== undefined,
    execute: "execute" in definition,
  });
  optionalFunction(name, "summon", definition.summon);
  optionalFunction(name, "describe", definition.describe);
  optionalFunction(name, "validate", definition.validate);
  if (
    definition.config !== undefined &&
    typeof definition.config?.["~standard"]?.validate !== "function"
  ) {
    throw new ConfigError(
      "A compute provider's config must be a Standard Schema (zod, valibot, arktype, or toStandardSchema around a function)",
      { provider: name },
    );
  }
  if (
    definition.secrets !== undefined &&
    (!Array.isArray(definition.secrets) ||
      !definition.secrets.every(
        (path) => typeof path === "string" && path.length > 0,
      ))
  ) {
    throw new ConfigError(
      "A compute provider's secrets must be an array of dotted config paths",
      { provider: name },
    );
  }

  const { apiVersion } = definition;
  const identity: ProviderIdentity = Object.freeze({
    name: definition.name,
    version: definition.version,
    kind: definition.kind,
    ...(definition.displayName === undefined
      ? {}
      : { displayName: definition.displayName }),
    ...(definition.homepage === undefined
      ? {}
      : { homepage: definition.homepage }),
    apiVersion: Object.freeze({
      core: apiVersion.core,
      ...(apiVersion.summon === undefined ? {} : { summon: apiVersion.summon }),
    }),
  });
  if (hostBuilt) {
    markHostBuilt(identity);
  }

  const provider = (config?: TInput) =>
    configure(definition, identity, config as TInput);
  return Object.freeze(
    Object.assign(provider, {
      definition,
      [COMPUTE_PROVIDER]: true as const,
    }),
  ) as unknown as ComputeProvider<TInput, TConfig>;
}

/**
 * Makes a compute provider: a typed factory plus the brand. It does no I/O;
 * calling the result with a config validates it and builds the facets.
 *
 * ```ts
 * import { defineComputeProvider, COMPUTE_PROVIDER_API } from "@kingsleyweb/bun-jobs/provider";
 *
 * export const acme = defineComputeProvider({
 *   name: "bun-jobs-provider-acme",
 *   version: "1.0.0",
 *   kind: "acme",
 *   apiVersion: { core: COMPUTE_PROVIDER_API.core, summon: COMPUTE_PROVIDER_API.summon },
 *   config: AcmeConfig,                     // any Standard Schema
 *   secrets: ["apiToken"],
 *   describe: (config) => ({ region: config.region }),
 *   summon: (config) => ({
 *     capabilities: { style: "launch", dedupe: { kind: "none" }, passes: "argv",
 *       bootBudgetMs: 60_000, shutdown: { signal: "SIGTERM", graceMs: 10_000 },
 *       maxLifetimeMs: null, enforcesLifetime: false },
 *     summon: async (request, ctx) => { … },
 *   }),
 * });
 *
 * const jobs = new BunJobs({ summon: { emails: { summoner: acme({ region: "eu", apiToken }) } } });
 * ```
 *
 * @throws {ConfigError} on a malformed definition: a `kind` outside
 *   `[a-z0-9-]{1,24}`, an `apiVersion` whose major differs from
 *   {@link COMPUTE_PROVIDER_API}'s, a facet without its version (or the
 *   reverse), an `execute` facet (this build has none), or a `config` that
 *   is not a Standard Schema.
 */
export function defineComputeProvider<TConfig, TInput = TConfig>(
  definition: ComputeProviderDefinition<TConfig, TInput> & {
    /** The summon facet: how to start compute. */
    readonly summon: (
      config: TConfig,
      context: ProviderSetupContext,
    ) => SummonFacet;
  },
): ComputeProvider<TInput, TConfig, true>;
export function defineComputeProvider<TConfig, TInput = TConfig>(
  definition: ComputeProviderDefinition<TConfig, TInput>,
): ComputeProvider<TInput, TConfig, false>;
export function defineComputeProvider<TConfig, TInput = TConfig>(
  definition: ComputeProviderDefinition<TConfig, TInput>,
): ComputeProvider<TInput, TConfig> {
  return defineProvider(definition, false);
}
