import type { DriverConfig, ExecutionMode, JobsDriver } from "../drivers/index";
import type {
  BunRunnerOptions,
  ResolvedRunLogCaptureOptions,
  ResolvedRunnerOptions,
  RunLogCaptureOptions,
} from "./types";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { EXECUTION_MODES } from "../api/contract/constants";
import { resolveDriver, resolveMetricsOptions } from "../drivers/index";
import {
  DEFAULT_CLOSE_TIMEOUT,
  DEFAULT_KEEP_HISTORY,
  DEFAULT_KILL_TIMEOUT,
  DEFAULT_LOCK_TTL,
  DEFAULT_MAX_QUEUED_RUNS,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_RUN_LOG_CAPTURE_BYTES,
  DEFAULT_RUN_LOG_MAX_BYTES,
  DEFAULT_RUN_LOG_MAX_LINE_BYTES,
  DEFAULT_RUN_LOG_MAX_LINES,
  DEFAULT_START_TIMEOUT,
  DEFAULT_SYNC_INTERVAL,
} from "../shared/constants";
import { ConfigError } from "../shared/errors";
import { assertNamespace, assertSegment } from "../shared/keys";
import { normalizeSchedule } from "../shared/schedule";
import { createRedactor } from "./redact";

/**
 * Option resolution, done once in the constructor.
 *
 * Defaults live in `../shared/constants`, and everything that could be wrong
 * — an unusable id, a malformed cron expression, a file that does not
 * resolve — is rejected here rather than at the first tick, when the caller
 * is no longer watching.
 */

/** Turns the file option into an absolute path a child can be handed. */
function resolveFile(file: string | URL, cwd?: string): string {
  if (file instanceof URL) {
    return file.protocol === "file:" ? fileURLToPath(file) : file.href;
  }

  if (file.startsWith("file://")) {
    return fileURLToPath(file);
  }

  try {
    return Bun.resolveSync(file, cwd ?? process.cwd());
  } catch (error) {
    throw new ConfigError(
      `Cannot resolve the runner file "${file}": ${(error as Error).message}`,
      { file, cwd },
    );
  }
}

/**
 * Resolves the execution modes a remote override may choose.
 *
 * Defaults to all three. An empty list is refused rather than silently
 * meaning "none": a runner nobody can reconfigure is spelled by leaving
 * `allowedOverrides` out and never granting the action.
 */
function resolveExecutionModes(
  modes: ExecutionMode[] | undefined,
): ExecutionMode[] {
  if (modes === undefined) {
    return [...EXECUTION_MODES];
  }

  if (modes.length === 0) {
    throw new ConfigError(
      "allowedOverrides.executionModes must name at least one execution mode",
      { executionModes: modes },
    );
  }

  for (const mode of modes) {
    if (!(EXECUTION_MODES as readonly string[]).includes(mode)) {
      throw new ConfigError(
        `allowedOverrides.executionModes must only contain ${EXECUTION_MODES.join(", ")}`,
        { executionModes: modes, offending: mode },
      );
    }
  }

  // De-duplicated in the canonical order, so `config:allowed` reads the same
  // however the option was written.
  return EXECUTION_MODES.filter((mode) => modes.includes(mode));
}

/**
 * Whether the runner subscribes to its `control` events.
 *
 * `"auto"` — the default — asks the driver. A backend that pushes events
 * (Redis) or holds them in this process (memory) costs nothing to listen on,
 * while one that polls (SQL, MongoDB, the file driver) would run a query every
 * few dozen milliseconds **per runner**. The sync adopts every change either
 * way, so this decides latency alone. `BunQueueWorker` resolves the
 * `subscribe` of its own `control` option with the very same rule.
 */
function resolveControl(
  control: boolean | "auto" | undefined,
  driver: JobsDriver,
): boolean {
  return control === undefined || control === "auto"
    ? driver.capabilities.events !== "poll"
    : control;
}

/**
 * Expands `captureLogs` into the five settings capture and the store read.
 *
 * A bare `true`/`false` is the enabled flag with every cap defaulted, and an
 * object may say `enabled` too — so `{ maxLines: 50 }` is still on, and
 * `{ enabled: false, maxLines: 50 }` is off with a cap nothing reads. Every
 * cap is rejected here rather than at the first line: a negative one would
 * otherwise mean "drop everything" on one backend and "unbounded" on another.
 */
function resolveCaptureLogs(
  captureLogs: boolean | RunLogCaptureOptions | undefined,
): ResolvedRunLogCaptureOptions {
  const given: RunLogCaptureOptions =
    typeof captureLogs === "boolean"
      ? { enabled: captureLogs }
      : (captureLogs ?? {});

  const resolved: ResolvedRunLogCaptureOptions = {
    enabled: given.enabled ?? true,
    maxLines: given.maxLines ?? DEFAULT_RUN_LOG_MAX_LINES,
    maxBytes: given.maxBytes ?? DEFAULT_RUN_LOG_MAX_BYTES,
    maxLineBytes: given.maxLineBytes ?? DEFAULT_RUN_LOG_MAX_LINE_BYTES,
    captureBytes: given.captureBytes ?? DEFAULT_RUN_LOG_CAPTURE_BYTES,
    console: given.console ?? true,
    // Compiled once per runner, not per run or per line.
    redact: createRedactor(given.redact),
  };

  for (const cap of [
    "maxLines",
    "maxBytes",
    "maxLineBytes",
    "captureBytes",
  ] as const) {
    if (!Number.isFinite(resolved[cap]) || resolved[cap] < 0) {
      throw new ConfigError(
        `captureLogs.${cap} must be a non-negative number (0 means unbounded)`,
        { [cap]: resolved[cap] },
      );
    }
  }

  return resolved;
}

/** Applies every default and validates what cannot be defaulted. */
export function resolveRunnerOptions<TArgs>(options: BunRunnerOptions<TArgs>): {
  resolved: ResolvedRunnerOptions<TArgs>;
  driver: JobsDriver;
  ownsDriver: boolean;
} {
  const id = assertSegment(options.id, "runner id");
  const namespace = assertNamespace(options.namespace);

  const { driver, owned } = resolveDriver(options.driver, options.metrics);

  // A child cannot receive a driver instance, only a description of one, so
  // an explicit `childDriver` wins and a config-shaped `driver` stands in.
  const childDriver: DriverConfig | undefined =
    options.childDriver ??
    (options.driver && "type" in options.driver
      ? (options.driver as DriverConfig)
      : undefined);

  const lockTtl = options.lockTtl ?? DEFAULT_LOCK_TTL;
  const captureLogs = resolveCaptureLogs(options.captureLogs);
  // Capture reads a spawned run's output from its pipes, so it is what the
  // stdio defaults to while capture is on. `SpawnExecutor` writes every piped
  // chunk straight through to this process's own stdout and stderr, so the
  // change is invisible except that the output is also stored. An explicit
  // `"inherit"` or `"ignore"` still wins, and that stream is not captured.
  const childStdio = captureLogs.enabled ? "pipe" : "inherit";

  if (options.maxConcurrency !== undefined && options.maxConcurrency < 1) {
    throw new ConfigError("maxConcurrency must be at least 1", {
      maxConcurrency: options.maxConcurrency,
    });
  }

  const resolved: ResolvedRunnerOptions<TArgs> = {
    id,
    namespace,
    name: options.name ?? id,
    file: resolveFile(options.file, options.spawn?.cwd),
    schedule: normalizeSchedule(options.schedule),
    executionMode: options.executionMode ?? "spawn",
    runMode: options.runMode ?? "single",
    queueRuns: options.queueRuns ?? false,
    maxQueuedRuns: options.maxQueuedRuns ?? DEFAULT_MAX_QUEUED_RUNS,
    maxConcurrency: options.maxConcurrency ?? Number.POSITIVE_INFINITY,
    timeout: options.timeout ?? 0,
    closeTimeout: options.closeTimeout ?? DEFAULT_CLOSE_TIMEOUT,
    killTimeout: options.killTimeout ?? DEFAULT_KILL_TIMEOUT,
    waitToExit: options.waitToExit ?? true,
    lockTtl,
    heartbeatInterval:
      options.heartbeatInterval ?? Math.max(1000, Math.floor(lockTtl / 3)),
    onLockLost: options.onLockLost ?? "abort",
    keepHistory: options.keepHistory ?? DEFAULT_KEEP_HISTORY,
    maxResultBytes: options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    autostart: options.autostart ?? false,
    startPaused: options.startPaused ?? false,
    syncInterval: options.syncInterval ?? DEFAULT_SYNC_INTERVAL,
    forwardLogs: options.forwardLogs ?? false,
    captureLogs,
    metrics: resolveMetricsOptions(options.metrics),
    publish: options.publish ?? false,
    control: resolveControl(options.control, driver),
    args: options.args,
    childDriver,
    allowedOverrides: {
      executionModes: resolveExecutionModes(
        options.allowedOverrides?.executionModes,
      ),
    },
    spawn: {
      stdout: childStdio,
      stderr: childStdio,
      startTimeout: DEFAULT_START_TIMEOUT,
      ...options.spawn,
    },
    worker: { ...options.worker },
    inProcess: { ...options.inProcess },
  };

  return { resolved, driver, ownsDriver: owned };
}
