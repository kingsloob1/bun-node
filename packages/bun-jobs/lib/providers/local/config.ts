import type {
  Logger,
  LoggerLike,
  StandardSchemaV1,
} from "../../provider/index";
import { availableParallelism } from "node:os";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
// No runtime import of the `./provider` entry here: that entry loads
// `../local.ts`, which reads this module's exports as it loads, so a runtime
// import back would make loading this module first a TDZ error. Types are
// erased; `toStandardSchema` comes from bun-common, where it is defined;
// `CHILD_BASE_ENV` is passed in by `local.ts`.
import { resolveLogger, toStandardSchema } from "@kingsleyweb/bun-common";

/**
 * `localCompute`'s config: what a user passes, what the facets receive, and
 * the schema between them. The schema does no I/O: whether the entry exists
 * is a summon-time `ProviderError` (`misconfigured`) and a `validate()`
 * check, so a config written before the file is built still configures.
 */

/** What a user passes to `localCompute({ … })`. */
export interface LocalComputeOptions {
  /**
   * The worker script each unit runs: it builds the `BunQueueWorker` and
   * calls `runSummoned`. A child process cannot import the host's processor,
   * so the worker is a file of its own. An absolute path, a `file:` URL
   * (`new URL("./worker.ts", import.meta.url)`, or the string
   * `import.meta.resolve("./worker.ts")` answers), or a path relative to
   * `cwd`. Required.
   */
  entry: string | URL;
  /** The units' working directory. Defaults to the host's `process.cwd()` when configured; a relative one resolves against it. */
  cwd?: string;
  /**
   * Extra arguments for the worker script, after `entry` and before the
   * summon arguments (`--bun-jobs-summon-*=`), which always come last so
   * nothing here can override them. Defaults to none.
   */
  args?: readonly string[];
  /** The `bun` executable units run under. Defaults to `process.execPath`, the one running the host. */
  bun?: string;
  /**
   * A unit's environment, with the same names and shape as the
   * child-process target's (PR-i0): an object (the default, `{}`) gives
   * these literal values over **an allowlist**, the variables a process
   * needs to run and nothing usually secret (`CHILD_BASE_ENV`, copied
   * from the live `process.env`) plus `passEnv`; a value of `undefined`
   * removes a variable the allowlist would have copied. `"inherit"` gives
   * the host's whole live `process.env`, secrets included.
   *
   * The summon policy's `env` is added on top in every case.
   * `BUN_JOBS_CHILD` is always removed: it would make the unit refuse its
   * summon arguments. Under the allowlist a unit is started with
   * `--no-env-file`, since Bun would otherwise load a `.env` from its `cwd`.
   */
  env?: "inherit" | Readonly<Record<string, string | undefined>>;
  /**
   * Names of host variables to copy from the live `process.env` at each
   * spawn, beyond the allowlist; one the host does not have is skipped.
   * Contradicts `env: "inherit"`, which already copies everything.
   */
  passEnv?: readonly string[];
  /**
   * The most units this provider runs at once on this host: its capacity.
   * Per configured instance, so queues sharing one instance share the cap.
   * A summon over it starts what fits, and with none free answers
   * `unavailable` (`max-units`). Defaults to the host's CPU count
   * (`os.availableParallelism()`).
   */
  maxUnits?: number;
  /** How long a unit has to register before its attempt is lost, in ms: the declared boot budget. Defaults to `30_000`. */
  bootBudget?: number;
  /**
   * The longest any unit may live, in ms, declared as the platform's cap: a
   * policy `maxLifetime` above it is a `ConfigError`. `null` (default) sets
   * no cap of its own; each unit is still held to its policy's `maxLifetime`.
   */
  maxLifetime?: number | null;
  /** How a unit is stopped: by `cancel()`, at its lifetime's end, and when the host shuts down. */
  shutdown?: {
    /** The stop signal. Defaults to `"SIGTERM"`, which `runSummoned` handles. */
    signal?: "SIGTERM" | "SIGINT";
    /** How long after the stop signal a unit is killed with `SIGKILL`, in ms. Defaults to `10_000`. */
    graceMs?: number;
  };
  /**
   * Where a unit's stdout and stderr go: `"inherit"` (default) writes them
   * to the host's, line by line; `"ignore"` drops them; `{ file }` appends
   * them to a file (relative to `cwd`); `{ logger }` logs each line, stdout
   * at `info` and stderr at `warn`, bound with the unit's handle. Stderr is
   * read in every case, for the last line `status()` reports on a crash.
   */
  output?:
    | "inherit"
    | "ignore"
    | {
        /** The file both streams are appended to. */
        file: string;
      }
    | {
        /** The logger each line goes to: any `LoggerLike`. */
        logger: LoggerLike;
      };
  /**
   * A cgroup directory the units are started under (Linux only; elsewhere a
   * `ConfigError`, since Bun would ignore it): each unit
   * gets a cgroup of its own inside it, so the limits set on this one
   * (`memory.max`, `pids.max`, `cpu.max`) bind all the units together, and
   * every process a unit starts stays in its cgroup, however it detaches.
   * Stopping a unit then kills its whole cgroup (`cgroup.kill`, Linux 5.14+).
   * It must exist: bun-jobs neither creates nor configures it. Without root it must sit in a subtree delegated to the
   * host's user, e.g. under `/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/`.
   */
  cgroup?: string;
}

/** Where a unit's output goes, validated. */
export type LocalComputeOutput =
  | {
      /** To the host's stdout and stderr. */
      kind: "inherit";
    }
  | {
      /** Dropped (stderr is still read for its last line). */
      kind: "ignore";
    }
  | {
      /** Appended to a file. */
      kind: "file";
      /** The file, absolute. */
      path: string;
    }
  | {
      /** Logged, line by line. */
      kind: "logger";
      /** The resolved logger. */
      logger: Logger;
    };

/** The config the facets receive: validated, with every default filled in and every path absolute. */
export interface LocalComputeConfig {
  /** The worker script, an absolute path. */
  entry: string;
  /** The working directory, absolute. */
  cwd: string;
  /** Extra arguments for the worker script. */
  args: readonly string[];
  /** The `bun` executable. */
  bun: string;
  /** The environment policy: `"inherit"`, or literal values over the allowlist (`undefined` removes one). */
  env: "inherit" | Readonly<Record<string, string | undefined>>;
  /** Host variables copied beyond the allowlist. */
  passEnv: readonly string[];
  /** The most units at once. */
  maxUnits: number;
  /** The boot budget, in ms. */
  bootBudgetMs: number;
  /** The cap on a unit's life, in ms, or `null` for none. */
  maxLifetimeMs: number | null;
  /** The stop signal. */
  signal: "SIGTERM" | "SIGINT";
  /** The grace after it, in ms. */
  graceMs: number;
  /** Where output goes. */
  output: LocalComputeOutput;
  /** The cgroup directory, absolute, when one was given. */
  cgroup?: string;
}

/** The defaults, in one place for the docs and the tests. */
export const LOCAL_DEFAULTS = Object.freeze({
  /** {@link LocalComputeOptions.bootBudget}. */
  bootBudget: 30_000,
  /** {@link LocalComputeOptions.shutdown}'s `signal`. */
  signal: "SIGTERM" as const,
  /** {@link LocalComputeOptions.shutdown}'s `graceMs`. */
  graceMs: 10_000,
});

/** An environment variable name: no `=`, no NUL, not empty. */
const ENV_NAME = /^[^=\0]+$/;

/** One validation issue. */
interface Issue {
  /** What is wrong. */
  message: string;
  /** The option it is about: the conformance kit reads the first segment. */
  path: string[];
}

/** A positive whole number. */
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** `entry` as an absolute path, or an issue. */
function entryPath(entry: unknown, cwd: string): string | Issue {
  const issue = (message: string): Issue => ({ message, path: ["entry"] });
  if (entry instanceof URL) {
    return entry.protocol === "file:"
      ? fileURLToPath(entry)
      : issue("entry must be a file: URL or a path");
  }
  if (typeof entry !== "string" || entry.length === 0) {
    return issue("entry is required: the worker script each unit runs");
  }
  if (entry.startsWith("file:")) {
    try {
      return fileURLToPath(entry);
    } catch {
      return issue("entry is not a valid file: URL");
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
    return issue("entry must be a file: URL or a path");
  }
  return isAbsolute(entry) ? entry : resolve(cwd, entry);
}

/** Whether units run under the allowlist (and so with `--no-env-file`). */
export function allowlisted(config: LocalComputeConfig): boolean {
  return config.env !== "inherit";
}

/** Validates and normalises the options. Synchronous, no I/O. */
function validate(input: unknown): StandardSchemaV1.Result<LocalComputeConfig> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      issues: [
        {
          message: "localCompute needs an options object with an entry",
          path: ["entry"],
        },
      ],
    };
  }
  const given = input as Record<string, unknown>;
  const issues: Issue[] = [];

  let cwd = process.cwd();
  if (given.cwd !== undefined) {
    if (typeof given.cwd !== "string" || given.cwd.length === 0) {
      issues.push({ message: "cwd must be a path", path: ["cwd"] });
    } else {
      cwd = resolve(given.cwd);
    }
  }

  const entry = entryPath(given.entry, cwd);
  if (typeof entry !== "string") {
    issues.push(entry);
  }

  const args = given.args ?? [];
  if (
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === "string" && !arg.includes("\0"))
  ) {
    issues.push({
      message: "args must be an array of strings",
      path: ["args"],
    });
  }

  const bun = given.bun ?? process.execPath;
  if (typeof bun !== "string" || bun.length === 0) {
    issues.push({
      message: "bun must be a path to a bun executable",
      path: ["bun"],
    });
  }

  let env: LocalComputeConfig["env"] = {};
  if (given.env === "inherit") {
    env = "inherit";
  } else if (
    typeof given.env === "object" &&
    given.env !== null &&
    !Array.isArray(given.env)
  ) {
    const entries = Object.entries(given.env);
    if (
      !entries.every(
        ([name, value]) =>
          ENV_NAME.test(name) &&
          (value === undefined ||
            (typeof value === "string" && !value.includes("\0"))),
      )
    ) {
      issues.push({
        message:
          "env must map variable names to strings (or undefined, to remove one)",
        path: ["env"],
      });
    } else {
      env = Object.freeze(Object.fromEntries(entries)) as Record<
        string,
        string | undefined
      >;
    }
  } else if (given.env !== undefined) {
    issues.push({
      message: 'env must be "inherit" or an object of string values',
      path: ["env"],
    });
  }
  const passEnv = given.passEnv ?? [];
  if (
    !Array.isArray(passEnv) ||
    !passEnv.every((name) => typeof name === "string" && ENV_NAME.test(name))
  ) {
    issues.push({
      message: "passEnv must be an array of variable names",
      path: ["passEnv"],
    });
  } else if (env === "inherit" && passEnv.length > 0) {
    issues.push({
      message:
        'passEnv has no effect with env: "inherit", which already passes every variable; drop one of them',
      path: ["passEnv"],
    });
  }

  const maxUnits = given.maxUnits ?? availableParallelism();
  if (!positive(maxUnits)) {
    issues.push({
      message: "maxUnits must be a positive whole number",
      path: ["maxUnits"],
    });
  }
  const bootBudget = given.bootBudget ?? LOCAL_DEFAULTS.bootBudget;
  if (!positive(bootBudget)) {
    issues.push({
      message: "bootBudget must be a positive whole number of milliseconds",
      path: ["bootBudget"],
    });
  }
  const maxLifetime = given.maxLifetime ?? null;
  if (maxLifetime !== null && !positive(maxLifetime)) {
    issues.push({
      message:
        "maxLifetime must be a positive whole number of milliseconds, or null",
      path: ["maxLifetime"],
    });
  }

  const shutdown = (given.shutdown ?? {}) as Record<string, unknown>;
  const signal = shutdown.signal ?? LOCAL_DEFAULTS.signal;
  const graceMs = shutdown.graceMs ?? LOCAL_DEFAULTS.graceMs;
  if (
    typeof shutdown !== "object" ||
    (signal !== "SIGTERM" && signal !== "SIGINT") ||
    typeof graceMs !== "number" ||
    !Number.isSafeInteger(graceMs) ||
    graceMs < 0
  ) {
    issues.push({
      message:
        'shutdown must be { signal: "SIGTERM" | "SIGINT", graceMs: a whole number of milliseconds }',
      path: ["shutdown"],
    });
  }

  let output: LocalComputeOutput = { kind: "inherit" };
  const rawOutput = given.output;
  if (rawOutput === "ignore") {
    output = { kind: "ignore" };
  } else if (
    typeof rawOutput === "object" &&
    rawOutput !== null &&
    "file" in rawOutput &&
    typeof rawOutput.file === "string" &&
    rawOutput.file.length > 0
  ) {
    output = { kind: "file", path: resolve(cwd, rawOutput.file) };
  } else if (
    typeof rawOutput === "object" &&
    rawOutput !== null &&
    "logger" in rawOutput &&
    rawOutput.logger !== undefined &&
    rawOutput.logger !== null
  ) {
    try {
      output = {
        kind: "logger",
        logger: resolveLogger(rawOutput.logger as LoggerLike),
      };
    } catch {
      issues.push({
        message: "output.logger is not a logger bun-jobs recognises",
        path: ["output"],
      });
    }
  } else if (rawOutput !== undefined && rawOutput !== "inherit") {
    issues.push({
      message: 'output must be "inherit", "ignore", { file } or { logger }',
      path: ["output"],
    });
  }

  let cgroup: string | undefined;
  if (given.cgroup !== undefined) {
    if (typeof given.cgroup !== "string" || !isAbsolute(given.cgroup)) {
      issues.push({
        message: "cgroup must be an absolute path to a cgroup directory",
        path: ["cgroup"],
      });
    } else if (process.platform !== "linux") {
      // Bun ignores a cgroup elsewhere: a unit would run unbounded.
      issues.push({
        message: "cgroup is Linux only",
        path: ["cgroup"],
      });
    } else {
      cgroup = given.cgroup;
    }
  }

  if (issues.length > 0) {
    return { issues };
  }
  return {
    value: {
      entry: entry as string,
      cwd,
      args: Object.freeze([...(args as string[])]),
      bun: bun as string,
      env,
      passEnv: Object.freeze([...(passEnv as string[])]),
      maxUnits: maxUnits as number,
      bootBudgetMs: bootBudget as number,
      maxLifetimeMs: maxLifetime as number | null,
      signal: signal as "SIGTERM" | "SIGINT",
      graceMs: graceMs as number,
      output,
      ...(cgroup === undefined ? {} : { cgroup }),
    },
  };
}

/** The config schema `localCompute` declares. */
export const localComputeSchema: StandardSchemaV1<
  LocalComputeOptions,
  LocalComputeConfig
> = toStandardSchema<LocalComputeOptions, LocalComputeConfig>(validate, {
  vendor: "bun-jobs",
});

/**
 * A unit's environment: the allowlist (`baseEnv`, `CHILD_BASE_ENV`) and
 * `passEnv`, or everything under `"inherit"`, read from `source` (the live
 * `process.env` by default: `Bun.spawn` with no `env` would hand the child
 * the environment the host *started* with); then the config's literal
 * values; then the request's (the summon policy's `env`).
 *
 * The same rules as the child-process target's `buildChildEnv`, which a
 * test runs side by side with this over one table: own string values only
 * (`process.env.toString` is inherited, not a variable), and `undefined`
 * removes one. `BUN_JOBS_CHILD` is then always removed.
 */
export function unitEnv(
  config: LocalComputeConfig,
  requestEnv: Readonly<Record<string, string>>,
  baseEnv: readonly string[],
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.env === "inherit") {
    for (const [name, value] of Object.entries(source)) {
      if (typeof value === "string") {
        env[name] = value;
      }
    }
  } else {
    for (const name of [...baseEnv, ...config.passEnv]) {
      const value = Object.hasOwn(source, name) ? source[name] : undefined;
      if (typeof value === "string") {
        env[name] = value;
      }
    }
    for (const [name, value] of Object.entries(config.env)) {
      if (value === undefined) {
        delete env[name];
      } else {
        env[name] = value;
      }
    }
  }
  Object.assign(env, requestEnv);
  // A runner child's marker: a unit carrying it refuses its summon
  // arguments (`summonedFromArgs`), so it must never reach one.
  delete env.BUN_JOBS_CHILD;
  return env;
}
