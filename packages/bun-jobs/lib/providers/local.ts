import type {
  ComputeProvider,
  ProviderCallContext,
  ProviderCheck,
  SummonCapabilities,
  SummonFacet,
  SummonRequest,
  SummonResult,
  UnitStatus,
} from "../provider/index";
import type { LocalComputeConfig, LocalComputeOptions } from "./local/config";
import type { LocalUnit } from "./local/units";
import { accessSync, constants, statSync } from "node:fs";
import { hostname } from "node:os";
import process from "node:process";
import {
  COMPUTE_PROVIDER_API,
  defineComputeProvider,
  ProviderError,
} from "../provider/index";
import { localComputeSchema, unitEnv } from "./local/config";
import { startUnit, stopUnit, unitStatus } from "./local/units";

export type {
  LocalComputeConfig,
  LocalComputeOptions,
  LocalComputeOutput,
} from "./local/config";

/**
 * `localCompute`: a compute provider that summons workers on the host the
 * queue's controller runs on, as child processes (`Bun.spawn`). Built on
 * the public plugin API alone, like any third-party provider.
 */

/** How long a dedupe token is remembered, in ms: the declared `dedupe.ttlMs`. */
const TOKEN_TTL_MS = 3_600_000;

/** The most tokens remembered at once; the oldest goes first. */
const TOKEN_MAX = 4_096;

/** Exited units kept for `status()`, per configured instance; the oldest goes first. */
const EXITED_MAX = 256;

/** A process-wide counter, so two handles never repeat even when a pid does. */
let unitSeq = 0;

/** How long `validate()` waits for `bun --version`, in ms. */
const PROBE_TIMEOUT_MS = 10_000;

/** An errno code of a thrown error, when it has one. */
function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code)
    ? code
    : undefined;
}

/** Codes that mean the host is short of a resource for now, not misconfigured. */
const TRANSIENT_ERRNO = new Set([
  "EAGAIN",
  "EMFILE",
  "ENFILE",
  "ENOMEM",
  "EBUSY",
  "EINTR",
]);

/** A spawn that threw, as a `ProviderError`. */
function spawnFailure(
  error: unknown,
  config: LocalComputeConfig,
): ProviderError {
  const code = errnoOf(error);
  const kind =
    code === undefined || TRANSIENT_ERRNO.has(code)
      ? "transient"
      : "misconfigured";
  const what =
    config.cgroup === undefined
      ? `could not start ${config.bun}`
      : `could not start ${config.bun} in cgroup ${config.cgroup}`;
  return new ProviderError(
    `localCompute ${what}${code === undefined ? "" : ` (${code})`}`,
    kind,
    {
      ...(code === undefined ? {} : { platformCode: code }),
      cause: error,
    },
  );
}

/** The `misconfigured` error for a `cwd` that is not a usable directory, or `undefined`. */
function cwdProblem(config: LocalComputeConfig): ProviderError | undefined {
  try {
    if (statSync(config.cwd).isDirectory()) {
      return undefined;
    }
    return new ProviderError(
      `localCompute's cwd ${config.cwd} is not a directory`,
      "misconfigured",
      { platformCode: "ENOTDIR" },
    );
  } catch (error) {
    return new ProviderError(
      `localCompute's cwd ${config.cwd} is not usable (${errnoOf(error) ?? "error"})`,
      "misconfigured",
      { platformCode: errnoOf(error) ?? "CwdNotUsable", cause: error },
    );
  }
}

/** The `misconfigured` error for an entry that is not a readable file, or `undefined`. */
function entryProblem(config: LocalComputeConfig): ProviderError | undefined {
  try {
    if (!statSync(config.entry).isFile()) {
      return new ProviderError(
        `localCompute's entry ${config.entry} is not a file`,
        "misconfigured",
        { platformCode: "EISDIR" },
      );
    }
    accessSync(config.entry, constants.R_OK);
    return undefined;
  } catch (error) {
    return new ProviderError(
      `localCompute's entry ${config.entry} is not readable (${errnoOf(error) ?? "error"})`,
      "misconfigured",
      { platformCode: errnoOf(error) ?? "EntryNotReadable", cause: error },
    );
  }
}

/** Throws the call's abort reason when its signal has fired. */
function throwIfAborted(context: ProviderCallContext): void {
  if (context.signal.aborted) {
    throw context.signal.reason instanceof Error
      ? context.signal.reason
      : new Error("the summon call was aborted");
  }
}

/** One instance's units and tokens: what its facet reads and writes. */
interface UnitTable {
  /** Every unit by handle: the live ones and the most recent exited. */
  units: Map<string, LocalUnit>;
  /** Handles of exited units, oldest first, for the cap. */
  exited: string[];
  /** Dedupe tokens: the handles each started, and when. */
  tokens: Map<string, { handles: string[]; at: number }>;
}

/** How many of a table's units are still running. */
function liveCount(table: UnitTable): number {
  let count = 0;
  for (const unit of table.units.values()) {
    if (unit.exitCode === undefined) {
      count++;
    }
  }
  return count;
}

/** Forgets tokens past their TTL, and the oldest beyond the cap. */
function pruneTokens(table: UnitTable, now: number): void {
  for (const [token, entry] of table.tokens) {
    if (now - entry.at < TOKEN_TTL_MS && table.tokens.size <= TOKEN_MAX) {
      break;
    }
    table.tokens.delete(token);
  }
}

/** Each validated config's unit table, so `validate()` can read the running count. */
const TABLES = new WeakMap<LocalComputeConfig, UnitTable>();

/** The summon facet for one validated config. */
function localFacet(config: LocalComputeConfig): SummonFacet {
  const table: UnitTable = { units: new Map(), exited: [], tokens: new Map() };

  const capabilities: SummonCapabilities = {
    style: "launch",
    dedupe: {
      kind: "token",
      maxLength: 64,
      charset: "A-Za-z0-9-",
      scope: "process",
      ttlMs: TOKEN_TTL_MS,
      strict: false,
    },
    passes: "argv",
    bootBudgetMs: config.bootBudgetMs,
    shutdown: { signal: config.signal, graceMs: config.graceMs },
    maxLifetimeMs: config.maxLifetimeMs,
    enforcesLifetime: true,
    maxCountPerCall: config.maxUnits,
  };

  const onExit = (unit: LocalUnit): void => {
    table.exited.push(unit.handle);
    while (table.exited.length > EXITED_MAX) {
      table.units.delete(table.exited.shift()!);
    }
  };

  const summon = async (
    request: SummonRequest,
    context: ProviderCallContext,
  ): Promise<SummonResult> => {
    throwIfAborted(context);
    // Everything from the token check to recording the token is
    // synchronous, so concurrent calls with one key start one unit.
    const now = context.now();
    pruneTokens(table, now);
    const known = table.tokens.get(request.dedupeKey);
    if (known !== undefined) {
      return { status: "deduped", handles: [...known.handles] };
    }
    const problem = cwdProblem(config) ?? entryProblem(config);
    if (problem !== undefined) {
      throw problem;
    }
    const free = config.maxUnits - liveCount(table);
    if (free <= 0) {
      return {
        status: "unavailable",
        reason: `max-units: ${config.maxUnits} of ${config.maxUnits} running`,
      };
    }
    const count = Math.min(Math.max(1, request.count), free);
    const env = unitEnv(config, request.env);
    const lifetimeMs =
      config.maxLifetimeMs === null
        ? request.maxLifetimeMs
        : Math.min(request.maxLifetimeMs, config.maxLifetimeMs);
    const handles: string[] = [];
    for (let index = 0; index < count; index++) {
      let unit: LocalUnit;
      try {
        unit = startUnit(config, {
          handle: `local-${process.pid}-${++unitSeq}`,
          argv: request.argv,
          env,
          lifetimeMs,
          onExit,
        });
      } catch (error) {
        if (handles.length === 0) {
          throw spawnFailure(error, config);
        }
        context.logger.warn("localCompute started fewer units than asked", {
          started: handles.length,
          asked: count,
          error,
        });
        break;
      }
      table.units.set(unit.handle, unit);
      handles.push(unit.handle);
    }
    table.tokens.set(request.dedupeKey, { handles, at: now });
    if (count < request.count) {
      context.logger.debug("localCompute started what maxUnits allows", {
        started: count,
        asked: request.count,
        maxUnits: config.maxUnits,
      });
    }
    return { status: "started", handles };
  };

  const status = async (
    handles: readonly string[],
  ): Promise<readonly UnitStatus[]> =>
    handles.map((handle) => {
      const unit = table.units.get(handle);
      return unit === undefined
        ? { handle, state: "unknown" as const }
        : unitStatus(unit);
    });

  const cancel = async (
    handles: readonly string[],
    context: ProviderCallContext,
  ): Promise<void> => {
    const stopping = handles
      .map((handle) => table.units.get(handle))
      .filter((unit): unit is LocalUnit => unit !== undefined)
      .map(async (unit) => await stopUnit(unit, "cancelled"));
    // Resolves on real exit; an abort only stops the waiting; the
    // escalation to SIGKILL goes on regardless.
    let onAbort: () => void = () => {};
    await Promise.race([
      Promise.all(stopping),
      new Promise<void>((done) => {
        onAbort = done;
        context.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    context.signal.removeEventListener("abort", onAbort);
  };

  TABLES.set(config, table);
  return { capabilities, summon, status, cancel };
}

/** Runs `bun --version` the way a unit is started, in the cgroup when one is set. */
async function probeBun(
  config: LocalComputeConfig,
  context: ProviderCallContext,
): Promise<ProviderCheck[]> {
  const checks: ProviderCheck[] = [];
  try {
    const proc = Bun.spawn({
      cmd: [config.bun, "--version"],
      cwd: config.cwd,
      env: unitEnv(config, {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      signal: context.signal,
      ...(config.cgroup === undefined ? {} : { cgroup: config.cgroup }),
    });
    const [code, version] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    checks.push(
      code === 0
        ? { id: "bun", status: "pass", detail: `bun ${version.trim()}` }
        : {
            id: "bun",
            status: "fail",
            detail: `${config.bun} --version exited ${code}`,
          },
    );
    if (config.cgroup !== undefined) {
      checks.push(
        code === 0
          ? {
              id: "cgroup",
              status: "pass",
              detail: `a process started in ${config.cgroup}`,
            }
          : {
              id: "cgroup",
              status: "fail",
              detail: `no process could run in ${config.cgroup}`,
            },
      );
    }
  } catch (error) {
    const code = errnoOf(error) ?? "error";
    if (config.cgroup !== undefined && process.platform === "linux") {
      // posix_spawn names the executable; clone3 (or an open of the
      // directory) the cgroup.
      const syscall = (error as { syscall?: unknown }).syscall;
      const cgroupFailed = syscall !== "posix_spawn";
      checks.push({
        id: "bun",
        status: cgroupFailed ? "warn" : "fail",
        detail: cgroupFailed
          ? "not checked: the cgroup refused the probe"
          : `${config.bun} could not be started (${code})`,
      });
      checks.push({
        id: "cgroup",
        status: cgroupFailed ? "fail" : "warn",
        detail: cgroupFailed
          ? `${config.cgroup} cannot be joined (${code}): it must exist and sit in a subtree this user may write`
          : "not checked: bun could not be started",
      });
    } else {
      checks.push({
        id: "bun",
        status: "fail",
        detail: `${config.bun} could not be started (${code})`,
      });
    }
  }
  return checks;
}

/**
 * Summons workers on this host, as child processes: each unit is
 * `bun <entry> [...args] --bun-jobs-summon-*=…`, started with `Bun.spawn`.
 *
 * Exported by `@kingsleyweb/bun-jobs/provider`:
 *
 * ```ts
 * const jobs = new BunJobs({
 *   driver: { type: "sql", url: "sqlite://jobs.db" },
 *   summon: {
 *     emails: { summoner: localCompute({ entry: new URL("./worker.ts", import.meta.url) }) },
 *   },
 * });
 * ```
 *
 * - **The entry** is a worker script of its own (a child cannot import the
 *   host's processor): it builds the worker with `summonedFromArgs()` and
 *   runs it with `runSummoned`, which exits once the queue is idle.
 * - **The driver must be one processes share** (SQLite, file, Redis,
 *   Postgres, MySQL, MariaDB, MongoDB): the controller refuses the memory
 *   driver, and the unit could not see the host's queue through it anyway.
 * - **Identity goes by arguments, the environment by allowlist**: a unit
 *   gets the host's `PATH`, `HOME`, locale and the like, not its secrets,
 *   unless `env` says otherwise; the summon policy's `env` is added on top.
 * - **`maxUnits`** caps the units running at once (by default the CPU
 *   count); a summon with none free answers `unavailable`.
 * - **No orphans**: every unit is killed when the host exits, and sent its
 *   stop signal (then `SIGKILL` after the grace) when the host is
 *   signalled. A host killed with `SIGKILL` cannot clean up: its units then
 *   end on their own, at `runSummoned`'s idle exit or deadline.
 * - **Not a sandbox**: a unit runs as the host's user, with its files and
 *   network. `cgroup` bounds its memory, CPU and processes; nothing bounds
 *   what it may read.
 */
export const localCompute: ComputeProvider<
  LocalComputeOptions,
  LocalComputeConfig,
  true
> = defineComputeProvider<LocalComputeConfig, LocalComputeOptions>({
  name: "@kingsleyweb/bun-jobs:local",
  version: "0.1.0",
  kind: "local",
  displayName: "Local processes",
  homepage:
    "https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-jobs/docs/providers/user-guide.md#summoning-on-this-host-localcompute",
  apiVersion: {
    core: COMPUTE_PROVIDER_API.core,
    summon: COMPUTE_PROVIDER_API.summon,
  },
  config: localComputeSchema,
  describe: (config) => ({
    host: hostname(),
    pid: String(process.pid),
    maxUnits: String(config.maxUnits),
    entry: config.entry,
    runtime: `bun ${Bun.version}`,
    env: config.env === "inherit" ? "inherit" : "allowlist",
    output: config.output.kind,
    ...(config.cgroup === undefined ? {} : { cgroup: config.cgroup }),
  }),
  validate: async (config, context) => {
    const checks: ProviderCheck[] = [];
    const cwd = cwdProblem(config);
    checks.push(
      cwd === undefined
        ? { id: "cwd", status: "pass", detail: config.cwd }
        : { id: "cwd", status: "fail", detail: cwd.message },
    );
    const entry = entryProblem(config);
    checks.push(
      entry === undefined
        ? { id: "entry", status: "pass", detail: config.entry }
        : { id: "entry", status: "fail", detail: entry.message },
    );
    if (cwd === undefined) {
      checks.push(...(await probeBun(config, context)));
    }
    if (config.cgroup !== undefined && process.platform !== "linux") {
      checks.push({
        id: "cgroup",
        status: "warn",
        detail: "ignored: cgroups exist on Linux only",
      });
    }
    const table = TABLES.get(config);
    const running = table === undefined ? 0 : liveCount(table);
    checks.push({
      id: "capacity",
      status: running < config.maxUnits ? "pass" : "warn",
      detail: `${running} of ${config.maxUnits} units running`,
    });
    checks.push({
      id: "isolation",
      status: "warn",
      detail:
        "units run as this host's user, with its files and network: not a sandbox",
    });
    return checks;
  },
  summon: (config) => localFacet(config),
});
