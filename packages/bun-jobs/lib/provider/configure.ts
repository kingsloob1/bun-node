import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { ProviderSetupContext } from "./context";
import type {
  ComputeProviderDefinition,
  ConfiguredProvider,
  ProviderCheck,
  ProviderIdentity,
  SummonCapabilities,
  SummonFacet,
} from "./define";
import type { ProviderReadiness, RegisteredProvider } from "./registry";
import { JOBS_VERSION } from "../shared/constants";
import { ConfigError } from "../shared/errors";
import { createJobsLogger } from "../shared/logger";
import { providerCallContext } from "./context";
import { CONFIGURED_PROVIDER } from "./define";
import { MIN_SECRET_LENGTH, redactingLogger, textRedactor } from "./redact";
import { nextProviderId, registerConfigured } from "./registry";
import { negotiate } from "./version";

/**
 * Configuring a provider (plugins §6.3): `provider(config)` validates the
 * config and builds the facets from the validated output.
 *
 * - **A synchronous schema** (or none): validated at once. Invalid, it throws
 *   a `ConfigError` carrying the issues; valid, the facets are built now and
 *   `ready` is already resolved.
 * - **An asynchronous schema**: `provider(config)` returns at once and the
 *   first validation starts. The summon facet is a stand-in until it
 *   succeeds. A validation in flight is shared by everyone waiting on it; a
 *   success is kept; a failure is kept only until someone asks again, so a
 *   transient fault (a network call inside the schema) clears on the next
 *   attempt.
 */

/** Everything known about one configured provider. */
interface ProviderState {
  /** What it was made from. */
  readonly definition: ComputeProviderDefinition<unknown, unknown>;
  /** Its identity. */
  readonly identity: ProviderIdentity;
  /** What the user passed. */
  readonly input: unknown;
  /** Whether the config has been validated (always, for a synchronous schema). */
  known: boolean;
  /** The validated config, once known. */
  config: unknown;
  /** The summon facet, once built. */
  facet: SummonFacet | undefined;
  /** The latest validation's promise: what `ready` answers. */
  current: Promise<void>;
  /** The validation in flight, if one is. */
  inFlight: Promise<SummonFacet | undefined> | undefined;
  /**
   * What building the facets from a valid config threw: deterministic for
   * that config, so kept, and every later settle rejects with it.
   */
  fatal: unknown;
  /**
   * Whether the latest validation rejected (and no newer one has started):
   * what makes an unknown config `"failed"` rather than `"pending"`.
   */
  failed: boolean;
  /** Its entry in the per-process registry, held here so it lives as long as the provider does. */
  entry: RegisteredProvider | undefined;
}

/** Configured providers, and the stand-in facets of pending ones, to their state. */
const STATES = new WeakMap<object, ProviderState>();

/**
 * States by a configured provider's `validate` function: a spread of a
 * configured provider copies it, so this finds the instance behind a copy
 * whose facet was replaced.
 */
const VALIDATORS = new WeakMap<object, ProviderState>();

/** Definitions by identity, for the secrets of a configured provider copied by a spread. */
const DEFINITIONS = new WeakMap<
  ProviderIdentity,
  ComputeProviderDefinition<unknown, unknown>
>();

/** Whether a value is a promise (a Standard Schema answers a result or a promise of one). */
function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** The value at a dotted path, or `undefined`. */
function at(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The declared secrets' values in `config`. */
function secretValues(
  definition: ComputeProviderDefinition<unknown, unknown>,
  config: unknown,
): unknown[] {
  return (definition.secrets ?? []).map((path) => at(config, path));
}

/** A Standard Schema issue's path, dotted. */
function issuePath(issue: StandardSchemaV1.Issue): string {
  return (issue.path ?? [])
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".");
}

/**
 * The `ConfigError` for a failed validation: the issues' paths and messages,
 * with the input's declared secret values redacted from the messages.
 */
function invalid(
  state: Pick<ProviderState, "definition" | "identity" | "input">,
  issues: readonly StandardSchemaV1.Issue[],
): ConfigError {
  const redact = textRedactor(secretValues(state.definition, state.input));
  const listed = issues.map((issue) => ({
    path: issuePath(issue),
    message: redact(issue.message),
  }));
  return new ConfigError(
    `Invalid config for compute provider ${state.identity.name}: ${listed
      .map((issue) =>
        issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`,
      )
      .join("; ")}`,
    { provider: state.identity.name, issues: listed },
  );
}

/** A malformed facet, as a `ConfigError` naming the provider. */
function malformed(identity: ProviderIdentity, what: string): ConfigError {
  return new ConfigError(
    `Compute provider ${identity.name}'s summon facet ${what}`,
    { provider: identity.name },
  );
}

/** Checks what a summon facet declares, so the controller never meets a shape it cannot read. */
function checkFacet(identity: ProviderIdentity, facet: unknown): SummonFacet {
  if (typeof facet !== "object" || facet === null) {
    throw malformed(identity, "must be an object");
  }
  const candidate = facet as Partial<SummonFacet>;
  if (typeof candidate.summon !== "function") {
    throw malformed(identity, "needs a summon function");
  }
  for (const hook of ["release", "status", "cancel"] as const) {
    if (
      candidate[hook] !== undefined &&
      typeof candidate[hook] !== "function"
    ) {
      throw malformed(identity, `has a ${hook} that is not a function`);
    }
  }
  const capabilities = candidate.capabilities as
    | Partial<SummonCapabilities>
    | undefined;
  if (typeof capabilities !== "object" || capabilities === null) {
    throw malformed(identity, "needs capabilities");
  }
  if (!["launch", "scale", "wake"].includes(capabilities.style as string)) {
    throw malformed(identity, 'needs a style of "launch", "scale" or "wake"');
  }
  if (!["argv", "none"].includes(capabilities.passes as string)) {
    throw malformed(identity, 'needs passes of "argv" or "none"');
  }
  if (
    !["token", "name", "none"].includes(capabilities.dedupe?.kind as string)
  ) {
    throw malformed(
      identity,
      'needs a dedupe kind of "token", "name" or "none"',
    );
  }
  if (
    !Number.isSafeInteger(capabilities.bootBudgetMs) ||
    capabilities.bootBudgetMs! <= 0
  ) {
    throw malformed(
      identity,
      "needs bootBudgetMs, a positive whole number of ms",
    );
  }
  const shutdown = capabilities.shutdown;
  if (
    typeof shutdown !== "object" ||
    shutdown === null ||
    !["SIGTERM", "SIGINT", "none"].includes(shutdown.signal) ||
    !Number.isSafeInteger(shutdown.graceMs) ||
    shutdown.graceMs < 0
  ) {
    throw malformed(
      identity,
      'needs shutdown: { signal: "SIGTERM" | "SIGINT" | "none", graceMs: a whole number of ms }',
    );
  }
  if (
    capabilities.maxLifetimeMs !== null &&
    (!Number.isSafeInteger(capabilities.maxLifetimeMs) ||
      capabilities.maxLifetimeMs! <= 0)
  ) {
    throw malformed(
      identity,
      "needs maxLifetimeMs: a positive whole number of ms, or null",
    );
  }
  if (typeof capabilities.enforcesLifetime !== "boolean") {
    throw malformed(identity, "needs enforcesLifetime, a boolean");
  }
  return facet as SummonFacet;
}

/** The logger a provider's setup and preflight see: the default, bound to it, redacting. */
function providerLogger(state: ProviderState) {
  return redactingLogger(
    createJobsLogger(undefined, { provider: state.identity.name }, "provider"),
    secretValues(state.definition, state.known ? state.config : state.input),
  );
}

/**
 * Builds the facets from a validated config, and records it as known — only
 * once the build has succeeded.
 */
function adopt(state: ProviderState, config: unknown): SummonFacet | undefined {
  const build = state.definition.summon;
  let facet: SummonFacet | undefined;
  if (build !== undefined) {
    const context: ProviderSetupContext = {
      api: negotiate(state.identity.apiVersion),
      hostVersion: JOBS_VERSION,
      logger: redactingLogger(
        createJobsLogger(
          undefined,
          { provider: state.identity.name },
          "provider",
        ),
        secretValues(state.definition, config),
      ),
    };
    facet = checkFacet(state.identity, build(config, context));
  }
  state.config = config;
  state.facet = facet;
  state.known = true;
  return facet;
}

/** Starts one asynchronous validation, shared until it settles. */
function attempt(
  state: ProviderState,
  result: PromiseLike<StandardSchemaV1.Result<unknown>>,
): Promise<SummonFacet | undefined> {
  // This validation's shared promise, once made: a late failure compares it
  // with `state.inFlight` to tell whether a newer validation is running.
  let settled: Promise<SummonFacet | undefined> | undefined;
  const run = (async () => {
    let outcome: StandardSchemaV1.Result<unknown>;
    try {
      outcome = await result;
      if (outcome.issues !== undefined) {
        throw invalid(state, outcome.issues);
      }
    } catch (error) {
      // A failure, perhaps late and after this validation was abandoned:
      // whoever still waits on it takes a success another validation
      // reached meanwhile, or joins the one in flight, before failing.
      if (state.known) {
        return state.facet;
      }
      if (state.inFlight !== undefined && state.inFlight !== settled) {
        return await state.inFlight;
      }
      throw error;
    }
    // Any success is as good as another (the input never changes): the
    // first one adopts, a later one — abandoned or in parallel — reuses it.
    if (state.known) {
      return state.facet;
    }
    if (state.fatal !== undefined) {
      throw state.fatal;
    }
    try {
      return adopt(state, outcome.value);
    } catch (error) {
      // A valid config whose facets cannot be built fails the same way
      // every time: kept, not retried.
      state.fatal = error;
      throw error;
    }
  })();
  const shared = run.finally(() => {
    // Dropped once settled: a success is kept in `state`, a failure is
    // retried by whoever asks next.
    if (state.inFlight === shared) {
      state.inFlight = undefined;
    }
  });
  settled = shared;
  state.inFlight = shared;
  state.failed = false;
  const current = run.then(() => undefined);
  // `ready` may never be awaited; its rejection must not be unhandled. A
  // rejection of the latest validation marks the provider failed until the
  // next one starts.
  current.catch(() => {
    if (state.current === current) {
      state.failed = true;
    }
  });
  shared.catch(() => {});
  state.current = current;
  return shared;
}

/**
 * Abandons a validation that outlasted a caller's timeout: it stops being
 * the one new callers join, so the next settle starts a fresh one in
 * parallel. It keeps running for whoever already waits on it (another
 * controller, `ready`), and its answer, however late, still counts.
 */
function abandon(
  state: ProviderState,
  inFlight: Promise<SummonFacet | undefined> | undefined,
): void {
  if (inFlight !== undefined && state.inFlight === inFlight) {
    state.inFlight = undefined;
  }
}

/** Validates the input again (asynchronous schema only), or joins the validation in flight. */
function settle(state: ProviderState): Promise<SummonFacet | undefined> {
  if (state.known) {
    return Promise.resolve(state.facet);
  }
  if (state.fatal !== undefined) {
    return Promise.reject(state.fatal);
  }
  if (state.inFlight !== undefined) {
    return state.inFlight;
  }
  const schema = state.definition.config!;
  let result:
    | StandardSchemaV1.Result<unknown>
    | PromiseLike<StandardSchemaV1.Result<unknown>>;
  try {
    result = schema["~standard"].validate(state.input);
  } catch (error) {
    return attempt(state, Promise.reject(error));
  }
  return attempt(
    state,
    isPromiseLike(result) ? result : Promise.resolve(result),
  );
}

/**
 * The stand-in summon facet of a provider whose config validates
 * asynchronously: its calls wait for the config, and its `capabilities` are
 * unknown (a `ConfigError`) until then.
 */
function standIn(state: ProviderState): SummonFacet {
  const real = async (): Promise<SummonFacet> => (await settle(state))!;
  const facet: SummonFacet = Object.freeze({
    get capabilities(): SummonCapabilities {
      if (state.facet === undefined) {
        throw new ConfigError(
          `Compute provider ${state.identity.name}'s config is still being validated: await its ready before reading capabilities`,
          { provider: state.identity.name },
        );
      }
      return state.facet.capabilities;
    },
    summon: async (request, context) =>
      await (await real()).summon(request, context),
    release: async (request, context) => {
      const target = await real();
      if (target.release === undefined) {
        throw malformed(state.identity, "has no release");
      }
      await target.release(request, context);
    },
    status: async (handles, context) => {
      const target = await real();
      return target.status === undefined
        ? []
        : await target.status(handles, context);
    },
    cancel: async (handles, context) => {
      await (await real()).cancel?.(handles, context);
    },
  } satisfies SummonFacet);
  STATES.set(facet, state);
  return facet;
}

/**
 * Internal: `provider(config)`. Validates now when the schema answers
 * synchronously, and builds the facets.
 *
 * @throws {ConfigError} for an invalid config under a synchronous schema, or
 *   a malformed facet.
 */
export function configure<TConfig, TInput>(
  definition: ComputeProviderDefinition<TConfig, TInput>,
  identity: ProviderIdentity,
  input: TInput,
): ConfiguredProvider<TConfig> {
  const general = definition as ComputeProviderDefinition<unknown, unknown>;
  DEFINITIONS.set(identity, general);
  const state: ProviderState = {
    definition: general,
    identity,
    input,
    known: false,
    config: undefined,
    facet: undefined,
    current: Promise.resolve(),
    inFlight: undefined,
    fatal: undefined,
    failed: false,
    entry: undefined,
  };

  const schema = definition.config;
  const result:
    | StandardSchemaV1.Result<unknown>
    | Promise<StandardSchemaV1.Result<unknown>> =
    schema === undefined
      ? { value: input }
      : schema["~standard"].validate(input);
  let summon: SummonFacet | undefined;
  if (isPromiseLike<StandardSchemaV1.Result<unknown>>(result)) {
    void attempt(state, result);
    summon = definition.summon === undefined ? undefined : standIn(state);
  } else {
    if (result.issues !== undefined) {
      throw invalid(state, result.issues);
    }
    summon = adopt(state, result.value);
  }

  const describe = (): Readonly<Record<string, string>> => {
    if (!state.known || definition.describe === undefined) {
      return {};
    }
    const facts = definition.describe(state.config as TConfig);
    const secrets = secretValues(general, state.config).filter(
      (secret): secret is string =>
        typeof secret === "string" && secret.length > 0,
    );
    return Object.fromEntries(
      Object.entries(facts).filter(
        ([, value]) =>
          !secrets.some(
            (secret) =>
              value === secret ||
              (secret.length >= MIN_SECRET_LENGTH &&
                String(value).includes(secret)),
          ),
      ),
    );
  };

  const validate = async (options?: {
    signal?: AbortSignal;
  }): Promise<readonly ProviderCheck[]> => {
    await settle(state);
    if (definition.validate === undefined) {
      return [];
    }
    return await definition.validate(
      state.config as TConfig,
      providerCallContext(
        options?.signal ?? new AbortController().signal,
        providerLogger(state),
      ),
    );
  };

  const configured: ConfiguredProvider<TConfig> = Object.freeze({
    provider: identity,
    get config(): TConfig {
      return state.config as TConfig;
    },
    get ready(): Promise<void> {
      return state.current;
    },
    ...(summon === undefined ? {} : { summon }),
    describe,
    validate,
    [CONFIGURED_PROVIDER]: true as const,
  });
  STATES.set(configured, state);
  VALIDATORS.set(validate, state);
  state.entry = {
    id: nextProviderId(identity),
    identity,
    definition: general,
    configured,
    readiness: () => readinessOf(state),
    secrets: () =>
      secretValues(general, state.known ? state.config : state.input),
  };
  registerConfigured(state.entry);
  return configured;
}

/** How far a provider's config has got (see {@link RegisteredProvider.readiness}). */
function readinessOf(state: ProviderState): ProviderReadiness {
  if (state.known) {
    return "ready";
  }
  return state.fatal !== undefined || state.failed ? "failed" : "pending";
}

/**
 * Internal: the registry entry of a configured provider, or of a spread of
 * one (found through its stand-in facet or its `validate`), or `undefined`
 * for anything that cannot be traced to an instance.
 */
export function registeredProvider(configured: {
  /** Its summon facet: a pending provider's stand-in leads to its state. */
  readonly summon?: unknown;
  /** Its preflight: a spread keeps the instance's own. */
  readonly validate?: unknown;
}): RegisteredProvider | undefined {
  const state =
    STATES.get(configured) ??
    (typeof configured.summon === "object" && configured.summon !== null
      ? STATES.get(configured.summon)
      : undefined) ??
    (typeof configured.validate === "function"
      ? VALIDATORS.get(configured.validate)
      : undefined);
  return state?.entry;
}

/** Internal: how a summoner's facet stands, for the controller (see {@link facetReadiness}). */
export interface FacetReadiness {
  /** The real facet, or `undefined` while the config is validating (or failed to build). */
  settled: () => SummonFacet | undefined;
  /** What building the facet threw, for good; `undefined` otherwise. */
  fatal: () => unknown;
  /**
   * Whether the config is known to have failed: building the facet threw, or
   * the latest validation rejected and none newer has started. `false` while
   * one is in flight.
   */
  failed: () => boolean;
  /** Waits for the real facet, joining a validation in flight; rejects with its failure. */
  settle: () => Promise<SummonFacet>;
  /**
   * Gives up on the validation `waited` (a promise this `settle` returned)
   * joined, after the caller's timeout passed: the next `settle` starts a
   * fresh one. Only that validation: if another caller has since abandoned it
   * and a newer one is in flight, the newer one is left alone.
   */
  abandon: (waited: Promise<SummonFacet>) => void;
}

/**
 * Internal, for the controller: how a summoner's facet stands. `settled` is
 * the real facet when it can be called now (always, except for the stand-in
 * of a provider whose config is still validating); `settle` waits for it,
 * sharing a validation in flight and retrying one that failed.
 */
export function facetReadiness(facet: SummonFacet): FacetReadiness {
  const state = STATES.get(facet);
  if (state === undefined) {
    return {
      settled: () => facet,
      fatal: () => undefined,
      failed: () => false,
      settle: async () => facet,
      abandon: () => {},
    };
  }
  // Each promise `settle` returned, to the validation it joined, so a
  // caller abandons that one and never whatever is in flight by then.
  const joined = new WeakMap<
    Promise<SummonFacet>,
    Promise<SummonFacet | undefined>
  >();
  return {
    settled: () => (state.known ? state.facet : undefined),
    fatal: () => state.fatal,
    failed: () => readinessOf(state) === "failed",
    settle: () => {
      const validation = settle(state);
      const waited = validation.then((facet) => facet!);
      joined.set(waited, validation);
      return waited;
    },
    abandon: (waited) => abandon(state, joined.get(waited)),
  };
}

/**
 * Internal: the declared secrets' values of a configured provider (or a
 * spread of one): what its call contexts redact. Before an asynchronous
 * config is validated, the input's values at the same paths.
 */
export function providerSecrets(configured: {
  /** The provider's identity. */
  readonly provider: ProviderIdentity;
  /** Its config. */
  readonly config?: unknown;
  /** Its summon facet: a pending provider's stand-in leads to its live state. */
  readonly summon?: unknown;
}): unknown[] {
  // The live state, through the configured provider or — for a spread taken
  // before an asynchronous config was validated, whose `config` is a stale
  // `undefined` — through the stand-in facet it copied.
  const state =
    STATES.get(configured) ??
    (typeof configured.summon === "object" && configured.summon !== null
      ? STATES.get(configured.summon)
      : undefined);
  if (state !== undefined) {
    return secretValues(
      state.definition,
      state.known ? state.config : state.input,
    );
  }
  const definition = DEFINITIONS.get(configured.provider);
  return definition === undefined
    ? []
    : secretValues(definition, configured.config);
}
