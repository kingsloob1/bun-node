import type { DriverConfig } from "../../drivers/index";
import type { Summoner } from "../../summon/types";
import type { ProviderCallContext } from "../context";
import type {
  ComputeProvider,
  ProviderApiVersions,
  ProviderCheck,
  ProviderIdentity,
} from "../define";
import type { FakePlatform } from "./fake";
import type { ConformanceCheck, ConformanceReport } from "./report";
import type { KitRun } from "./run";
import { ConfigError } from "../../shared/errors";
import { providerSecrets } from "../configure";
import {
  COMPUTE_PROVIDER,
  CONFIGURED_PROVIDER,
  PROVIDER_KIND,
} from "../define";
import { MIN_SECRET_LENGTH } from "../redact";
import { COMPUTE_PROVIDER_API } from "../version";
import {
  capabilityChecks,
  concurrencyChecks,
  dedupeChecks,
  describeChecks,
  errorChecks,
  lifetimeChecks,
  purityChecks,
  scaleChecks,
  statusChecks,
  timeoutChecks,
  validateChecks,
} from "./checks";
import { fakeInternals } from "./fake";
import { casChecks, handoffChecks, verdictProbe } from "./handoff";
import { buildReport } from "./report";
import { createRun, describeThrown, randomHex } from "./run";
import { findSecrets } from "./scan";

/**
 * `runProviderConformance` (plugins §12.2, summon only): runs a provider's
 * summon facet and its core against a fake of its platform, and reports
 * every check in a fixed order.
 */

/** Every check, in report order, with its level. `purity` is `must` only under a strict token. */
const CHECKS: readonly (readonly [string, ConformanceCheck["level"]])[] = [
  ["summon.identity.name", "must"],
  ["summon.identity.version", "must"],
  ["summon.identity.kind", "must"],
  ["summon.identity.api-version", "must"],
  ["summon.identity.brand", "must"],
  ["summon.config.accepts", "must"],
  ["summon.config.rejects-invalid", "must"],
  ["summon.config.schema", "should"],
  ["summon.capabilities.well-formed", "must"],
  ["summon.capabilities.scale-has-release", "must"],
  ["summon.capabilities.wake-has-pool-size", "must"],
  ["summon.capabilities.dedupe-charset", "must"],
  ["summon.capabilities.platform-limits", "should"],
  ["summon.routing.through-ctx-fetch", "must"],
  ["summon.purity.identical-requests", "should"],
  ["summon.dedupe.token-is-key", "must"],
  ["summon.dedupe.same-key-one-unit", "must"],
  ["summon.concurrency.distinct-ids", "must"],
  ["summon.concurrency.same-id-one-unit", "must"],
  ["summon.errors.transient", "must"],
  ["summon.errors.throttled", "must"],
  ["summon.errors.quota", "must"],
  ["summon.errors.auth", "must"],
  ["summon.errors.misconfigured", "must"],
  ["summon.errors.conflict", "must"],
  ["summon.errors.capacity-200", "must"],
  ["summon.errors.platform-code", "should"],
  ["summon.timeouts.rejects-on-abort", "must"],
  ["summon.timeouts.no-timer-left", "must"],
  ["summon.scale.target-idempotent", "must"],
  ["summon.scale.release-to-zero", "must"],
  ["summon.status.knows-handles", "must"],
  ["summon.status.cancel-stops-pending", "must"],
  ["summon.lifetime.enforced", "must"],
  ["summon.describe.facts", "should"],
  ["summon.validate.healthy", "must"],
  ["summon.validate.auth-fails", "must"],
  ["summon.validate.starts-nothing", "must"],
  ["summon.secrets.no-leak", "must"],
  ["summon.handoff.started", "must"],
  ["summon.handoff.released", "must"],
  ["summon.handoff.drained", "must"],
  ["summon.handoff.scale-down", "must"],
  ["summon.cas.one-call", "must"],
];

/** A semver version, strictly. */
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Z-]+(?:\.[0-9A-Z-]+)*)?(?:\+[0-9A-Z-]+(?:\.[0-9A-Z-]+)*)?$/i;

/** A `"major.minor"` API version. */
const API_VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/** The group of a check id: its second segment. */
function groupOf(id: string): string {
  return id.split(".")[1] ?? id;
}

/** Whether a value is a provider (unconfigured), by its brand. */
function isComputeProvider(
  value: unknown,
): value is ComputeProvider<unknown, unknown> {
  return (
    typeof value === "function" &&
    (value as { [COMPUTE_PROVIDER]?: unknown })[COMPUTE_PROVIDER] === true
  );
}

/** A copy of `config` with the string at each dotted path replaced by a canary. */
function seed(
  config: unknown,
  paths: readonly string[],
): { config: unknown; canaries: string[]; seededPaths: string[] } {
  const canaries: string[] = [];
  const seededPaths: string[] = [];
  let root = config;
  paths.forEach((path, index) => {
    const segments = path.split(".");
    const copy = (value: unknown, depth: number): unknown => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return value;
      }
      const key = segments[depth]!;
      const record = value as Record<string, unknown>;
      if (!(key in record)) {
        return value;
      }
      if (depth === segments.length - 1) {
        if (typeof record[key] !== "string") {
          return value;
        }
        const canary = `bjcanary${index}x${randomHex(12)}`;
        canaries.push(canary);
        seededPaths.push(path);
        return { ...record, [key]: canary };
      }
      const inner = copy(record[key], depth + 1);
      return inner === record[key] ? value : { ...record, [key]: inner };
    };
    root = copy(root, 0);
  });
  return { config: root, canaries, seededPaths };
}

/** A config error's issue paths, when it carries them. */
function issuePaths(error: unknown): string[] {
  const issues = (error as { context?: { issues?: unknown } })?.context?.issues;
  return Array.isArray(issues)
    ? issues.map((issue) => String((issue as { path?: unknown }).path ?? ""))
    : [];
}

/** Configures `provider` with `config`: the configured provider, or what it threw or `ready` rejected with. */
async function configureWith(
  provider: ComputeProvider<unknown, unknown>,
  config: unknown,
): Promise<{ ok: true; summoner: Summoner } | { ok: false; error: unknown }> {
  try {
    const configured = (provider as (config: unknown) => Summoner)(config);
    await configured.ready;
    return { ok: true, summoner: configured };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The identity group. */
function identityChecks(
  set: KitRun["set"],
  identity: ProviderIdentity,
  branded: boolean,
): void {
  set(
    "summon.identity.name",
    typeof identity.name === "string" && identity.name.length > 0
      ? "pass"
      : "fail",
    typeof identity.name === "string" && identity.name.length > 0
      ? undefined
      : "name is empty",
  );
  set(
    "summon.identity.version",
    SEMVER.test(identity.version) ? "pass" : "fail",
    SEMVER.test(identity.version)
      ? undefined
      : `version ${JSON.stringify(identity.version)} is not semver`,
  );
  set(
    "summon.identity.kind",
    PROVIDER_KIND.test(identity.kind) ? "pass" : "fail",
    PROVIDER_KIND.test(identity.kind)
      ? undefined
      : `kind ${JSON.stringify(identity.kind)} is not [a-z0-9-]{1,24}`,
  );
  const problems: string[] = [];
  const notes: string[] = [];
  for (const facet of ["core", "summon"] as const) {
    const declared = identity.apiVersion?.[facet];
    const match =
      typeof declared === "string" ? API_VERSION.exec(declared) : null;
    if (match === null) {
      problems.push(`apiVersion.${facet} is ${JSON.stringify(declared)}`);
      continue;
    }
    const [hostMajor, hostMinor] = COMPUTE_PROVIDER_API[facet]
      .split(".")
      .map(Number) as [number, number];
    if (Number(match[1]) !== hostMajor) {
      problems.push(
        `apiVersion.${facet} ${declared} has another major than the host's ${COMPUTE_PROVIDER_API[facet]}`,
      );
    } else if (Number(match[2]) > hostMinor) {
      notes.push(
        `apiVersion.${facet} ${declared} is newer than the host's ${COMPUTE_PROVIDER_API[facet]}`,
      );
    }
  }
  set(
    "summon.identity.api-version",
    problems.length === 0 ? "pass" : "fail",
    problems.length === 0
      ? notes.length === 0
        ? undefined
        : notes.join("; ")
      : problems.join("; "),
  );
  set(
    "summon.identity.brand",
    branded ? "pass" : "fail",
    branded
      ? undefined
      : "the configured provider has no brand: make it with defineComputeProvider or defineSummoner",
  );
}

/**
 * Runs the summon facet (and the core) of a provider against a fake of its
 * platform, and reports every check in a fixed order (plugins §12.2):
 * identity, config, capabilities, routing, purity, dedupe, concurrency,
 * errors, timeouts, scale, status, lifetime, describe, validate, secrets,
 * the handoff to a real worker, and the compare-and-set race.
 *
 * The provider is an unconfigured `ComputeProvider` (configured here with
 * `config`, and again with every declared secret replaced by a canary) or a
 * `Summoner` (from `defineSummoner`, or a provider already configured, whose
 * config checks are then skipped). Every call gets a `ctx.fetch` that routes
 * to the fake; the handoff and the race need a backend several processes
 * share, a temporary SQLite file unless `driver` names one.
 *
 * Never throws for a failing provider: that is what the report says. Pass
 * it to {@link assertConformance} in a test.
 *
 * @throws {ConfigError} when `provider` is neither a provider nor a
 *   summoner, or `platform` is not from `fakePlatform()`.
 */
export async function runProviderConformance<TInput, TConfig>(
  provider: ComputeProvider<TInput, TConfig, boolean> | Summoner,
  options: {
    /** A config pointing at the fake: its URL, test credentials. Ignored for a `Summoner`. */
    config?: TInput;
    /** Configs the schema must reject, each with the dotted path its issue should name. */
    invalidConfigs?: readonly {
      /** The config. */
      config: unknown;
      /** The path of the issue it should raise, e.g. `"region"`. */
      path: string;
    }[];
    /** The fake platform, from `fakePlatform()`. */
    platform: FakePlatform;
    /** Checks to skip, each with a reason printed in the report. */
    skip?: readonly {
      /** The check id. */
      id: string;
      /** Why, for the report. */
      reason: string;
    }[];
    /**
     * The backend the handoff and the compare-and-set checks run on: one
     * several processes share (SQLite, the file driver, Redis, Postgres, …).
     * Defaults to a SQLite file in a temporary directory, removed after.
     */
    driver?: DriverConfig;
  },
): Promise<ConformanceReport> {
  const internals = fakeInternals(options.platform);
  const unconfigured = isComputeProvider(provider)
    ? (provider as unknown as ComputeProvider<unknown, unknown>)
    : undefined;
  if (
    unconfigured === undefined &&
    (typeof provider !== "object" ||
      provider === null ||
      typeof (provider as Partial<Summoner>).summon?.summon !== "function")
  ) {
    throw new ConfigError(
      "runProviderConformance needs a provider from defineComputeProvider, or a Summoner",
    );
  }

  const checks = new Map<string, ConformanceCheck>(
    CHECKS.map(([id, level]) => [id, { id, level, status: "pass" }]),
  );
  const skipped = new Map(
    (options.skip ?? []).map((entry) => [entry.id, entry.reason]),
  );
  for (const [id, reason] of skipped) {
    const check = checks.get(id);
    if (check !== undefined) {
      check.status = "skip";
      check.detail = `skipped: ${reason}`;
    }
  }
  const outcome = new Set<string>();
  const set: KitRun["set"] = (id, status, detail) => {
    const check = checks.get(id);
    if (check === undefined || skipped.has(id)) {
      return;
    }
    outcome.add(id);
    check.status =
      status === "fail" && check.level === "should" ? "warn" : status;
    if (detail === undefined) {
      delete check.detail;
    } else {
      check.detail = detail;
    }
  };
  const skipAll = (prefix: string, detail: string): void => {
    for (const id of checks.keys()) {
      if (id.startsWith(prefix) && !outcome.has(id)) {
        set(id, "skip", detail);
      }
    }
  };
  const finish = (identity: ProviderIdentity): ConformanceReport => {
    // Anything never reached is reported as skipped rather than passed.
    for (const id of checks.keys()) {
      if (!outcome.has(id) && !skipped.has(id)) {
        set(id, "skip", "not reached");
      }
    }
    return buildReport(
      `${identity.name}@${identity.version}`,
      {
        declared: { ...identity.apiVersion } as ProviderApiVersions,
        host: { ...COMPUTE_PROVIDER_API },
      },
      CHECKS.map(([id]) => checks.get(id)!),
    );
  };

  // Identity, and configuring the provider.
  const identity: ProviderIdentity = unconfigured
    ? (unconfigured.definition as unknown as ProviderIdentity)
    : (provider as Summoner).provider;
  let summoner: Summoner;
  let fresh: () => Summoner = () => summoner;
  let secrets: string[] = [];
  /** What each of `secrets` is, for the report: its declared path. */
  let labels: string[] = [];
  let validate:
    | ((context: ProviderCallContext) => Promise<readonly ProviderCheck[]>)
    | undefined;
  if (unconfigured !== undefined) {
    const { definition } = unconfigured;
    const given = await configureWith(unconfigured, options.config);
    // The provider's brand, and the configured instance's when it has one.
    identityChecks(
      set,
      identity,
      !given.ok ||
        (given.summoner as { [CONFIGURED_PROVIDER]?: unknown })[
          CONFIGURED_PROVIDER
        ] === true,
    );
    if (!given.ok) {
      set(
        "summon.config.accepts",
        "fail",
        `the given config was refused: ${describeThrown(given.error)}${issuePaths(given.error).length > 0 ? ` at ${issuePaths(given.error).join(", ")}` : ""}`,
      );
      for (const id of checks.keys()) {
        if (!id.startsWith("summon.identity.") && !outcome.has(id)) {
          set(id, "skip", "skipped: the provider could not be configured");
        }
      }
      return finish(identity);
    }
    if (typeof given.summoner.summon?.summon !== "function") {
      set("summon.config.accepts", "pass");
      skipAll("summon.", "skipped: the provider has no summon facet");
      return finish(identity);
    }
    set("summon.config.accepts", "pass");
    set(
      "summon.config.schema",
      definition.config === undefined ? "fail" : "pass",
      definition.config === undefined
        ? "no config schema: the input reaches the facets unvalidated"
        : undefined,
    );
    const invalid = options.invalidConfigs ?? [];
    if (invalid.length === 0) {
      set("summon.config.rejects-invalid", "skip", "no invalidConfigs given");
    } else {
      const problems: string[] = [];
      for (const entry of invalid) {
        const result = await configureWith(unconfigured, entry.config);
        if (result.ok) {
          problems.push(`a config invalid at ${entry.path} was accepted`);
        } else if (!(result.error instanceof ConfigError)) {
          problems.push(
            `a config invalid at ${entry.path} threw ${describeThrown(result.error)}, not a ConfigError`,
          );
        } else if (!issuePaths(result.error).includes(entry.path)) {
          problems.push(
            `a config invalid at ${entry.path} named ${issuePaths(result.error).join(", ") || "no path"}`,
          );
        }
      }
      set(
        "summon.config.rejects-invalid",
        problems.length === 0 ? "pass" : "fail",
        problems.length === 0 ? undefined : problems.join("; "),
      );
    }

    // The instance every other check runs on: every declared secret a
    // canary, so the scan knows exactly what to look for.
    const declared = definition.secrets ?? [];
    const seeded = seed(options.config, declared);
    const canaried =
      seeded.canaries.length > 0
        ? await configureWith(unconfigured, seeded.config)
        : undefined;
    if (canaried?.ok === true) {
      summoner = canaried.summoner;
      secrets = seeded.canaries;
      labels = seeded.seededPaths;
      fresh = () =>
        (unconfigured as unknown as (config: unknown) => Summoner)(
          seeded.config,
        );
    } else {
      summoner = given.summoner;
      fresh = () =>
        (unconfigured as unknown as (config: unknown) => Summoner)(
          options.config,
        );
      ({ secrets, labels } = givenSecrets(summoner));
    }
    if (declared.length === 0) {
      set("summon.secrets.no-leak", "skip", "the provider declares no secrets");
    } else if (secrets.length === 0) {
      set(
        "summon.secrets.no-leak",
        "skip",
        "no declared secret held a string the kit could seed or look for",
      );
    }
    if (definition.validate !== undefined) {
      const validateFn = definition.validate;
      const config = summoner.config;
      validate = async (context) =>
        await (
          validateFn as (
            config: unknown,
            context: ProviderCallContext,
          ) => Promise<readonly ProviderCheck[]>
        )(config, context);
    }
  } else {
    summoner = provider as Summoner;
    identityChecks(
      set,
      identity,
      (summoner as { [CONFIGURED_PROVIDER]?: unknown })[CONFIGURED_PROVIDER] ===
        true,
    );
    skipAll(
      "summon.config.",
      "a configured provider: its config was validated when it was configured",
    );
    ({ secrets, labels } = givenSecrets(summoner));
    if (secrets.length === 0) {
      set("summon.secrets.no-leak", "skip", "the provider declares no secrets");
    }
  }

  const run = createRun({
    identity,
    summoner,
    platform: options.platform,
    internals,
    driver: options.driver,
    fresh,
    secrets,
    set,
    wanted: (id) => checks.has(id) && !skipped.has(id),
  });
  const purity = checks.get("summon.purity.identical-requests")!;
  const { dedupe } = run.capabilities;
  purity.level = dedupe.kind === "token" && dedupe.strict ? "must" : "should";

  const wanted = (group: string): boolean =>
    [...checks.keys()].some(
      (id) => groupOf(id) === group && !skipped.has(id) && !outcome.has(id),
    );

  capabilityChecks(run, options.platform.limits);
  // The end-to-end groups need a controller, which refuses what the
  // capabilities and brand checks refuse: they are skipped, not failed, so
  // one defect fails one group.
  const blocking = [...checks.values()].filter(
    (check) =>
      check.status === "fail" &&
      (groupOf(check.id) === "capabilities" ||
        check.id === "summon.identity.brand" ||
        check.id === "summon.identity.api-version"),
  );
  const blocked =
    blocking.length === 0
      ? undefined
      : `skipped: ${blocking.map((check) => check.id).join(", ")} failed, and a controller refuses such a provider`;
  describeChecks(run);
  if (wanted("validate")) {
    await validateChecks(run, validate);
  }
  if (wanted("dedupe")) {
    await dedupeChecks(run);
  }
  if (wanted("purity")) {
    await purityChecks(run);
  }
  if (wanted("concurrency")) {
    await concurrencyChecks(run);
  }
  if (wanted("status")) {
    await statusChecks(run);
  }
  if (wanted("lifetime")) {
    await lifetimeChecks(run);
  }
  if (wanted("errors")) {
    // Each fault's verdict comes from a real controller, which needs a
    // provider it accepts.
    const probe = blocked === undefined ? await verdictProbe(run) : undefined;
    try {
      await errorChecks(run, probe?.probe, blocked);
    } finally {
      await probe?.close();
    }
  }
  if (wanted("timeouts")) {
    await timeoutChecks(run);
  }

  if (run.capabilities.style !== "scale") {
    skipAll("summon.scale.", `style is ${run.capabilities.style}`);
  } else if (blocked !== undefined) {
    skipAll("summon.scale.", blocked);
  } else if (wanted("scale")) {
    await scaleChecks(run);
  }
  if (blocked !== undefined) {
    skipAll("summon.handoff.", blocked);
    skipAll("summon.cas.", blocked);
  } else {
    if (wanted("handoff")) {
      await handoffChecks(run);
    }
    if (wanted("cas")) {
      await casChecks(run);
    }
  }

  // Routing: every request the fake saw came through `ctx.fetch`.
  const requests = internals.requests;
  const unrouted = requests.filter((record) => !record.routed);
  set(
    "summon.routing.through-ctx-fetch",
    requests.length > 0 && unrouted.length === 0 ? "pass" : "fail",
    requests.length === 0
      ? "the fake received no request"
      : unrouted.length === 0
        ? undefined
        : `${unrouted.length} of ${requests.length} platform requests did not go through ctx.fetch (first: ${unrouted[0]!.method} ${unrouted[0]!.path})`,
  );

  // Secrets: nothing bun-jobs would write carries one.
  if (wanted("secrets")) {
    const found = findSecrets(
      [
        ...run.logs.map((event) => ({
          message: event.message,
          fields: event.fields,
          bindings: event.bindings,
          error: event.error,
        })),
        ...run.scanned,
      ],
      secrets,
    );
    set(
      "summon.secrets.no-leak",
      found.length === 0 ? "pass" : "fail",
      found.length === 0
        ? `${secrets.length} secret(s) looked for in ${run.logs.length} log lines and ${run.scanned.length} results, errors and facts`
        : `declared secret(s) ${found.map((hit) => labels[hit.index]).join(", ")} appeared in what bun-jobs would log or store`,
    );
  }
  return finish(identity);
}

/** A configured provider's own secret values the kit can look for, with a label each. */
function givenSecrets(summoner: Summoner): {
  secrets: string[];
  labels: string[];
} {
  const secrets = providerSecrets(summoner).filter(
    (value): value is string =>
      typeof value === "string" && value.length >= MIN_SECRET_LENGTH,
  );
  return {
    secrets,
    labels: secrets.map((_, index) => `#${index + 1}`),
  };
}
