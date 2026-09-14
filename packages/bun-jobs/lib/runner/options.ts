import type { DriverConfig, JobsDriver } from "../drivers/index";
import type { BunRunnerOptions, ResolvedRunnerOptions } from "./types";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveDriver } from "../drivers/index";
import {
  DEFAULT_CLOSE_TIMEOUT,
  DEFAULT_KEEP_HISTORY,
  DEFAULT_KILL_TIMEOUT,
  DEFAULT_LOCK_TTL,
  DEFAULT_MAX_QUEUED_RUNS,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_START_TIMEOUT,
  DEFAULT_SYNC_INTERVAL,
} from "../shared/constants";
import { ConfigError } from "../shared/errors";
import { assertNamespace, assertSegment } from "../shared/keys";
import { normalizeSchedule } from "../shared/schedule";

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

/** Applies every default and validates what cannot be defaulted. */
export function resolveRunnerOptions<TArgs>(options: BunRunnerOptions<TArgs>): {
  resolved: ResolvedRunnerOptions<TArgs>;
  driver: JobsDriver;
  ownsDriver: boolean;
} {
  const id = assertSegment(options.id, "runner id");
  const namespace = assertNamespace(options.namespace);

  const { driver, owned } = resolveDriver(options.driver);

  // A child cannot receive a driver instance, only a description of one, so
  // an explicit `childDriver` wins and a config-shaped `driver` stands in.
  const childDriver: DriverConfig | undefined =
    options.childDriver ??
    (options.driver && "type" in options.driver
      ? (options.driver as DriverConfig)
      : undefined);

  const lockTtl = options.lockTtl ?? DEFAULT_LOCK_TTL;

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
    publish: options.publish ?? false,
    args: options.args,
    childDriver,
    spawn: {
      stdout: "inherit",
      stderr: "inherit",
      startTimeout: DEFAULT_START_TIMEOUT,
      ...options.spawn,
    },
    worker: { ...options.worker },
    inProcess: { ...options.inProcess },
  };

  return { resolved, driver, ownsDriver: owned };
}
