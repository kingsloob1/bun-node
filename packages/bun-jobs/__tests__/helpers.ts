import type { JobRecord, ResolvedJobOptions } from "../lib/index";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "../lib/index";

/**
 * Shared test helpers.
 *
 * Two rules every suite here follows, because breaking either makes
 * `bun test` hang or fail intermittently:
 *
 * - a unique namespace per suite, so suites sharing a live backend (Redis,
 *   Postgres) cannot see each other's keys;
 * - cleanup registered for every runner, worker, child and temp directory.
 */

/** A namespace no other suite will use. */
export function testNamespace(prefix = "t"): string {
  return `${prefix}-${newId()}`;
}

/** Creates a temp directory and returns it with its cleanup function. */
export async function makeTmpDir(
  prefix = "bun-jobs",
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), `${prefix}-`));
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

/** Job options with every default filled in, for building records directly. */
export function jobOptions(
  overrides: Partial<ResolvedJobOptions> = {},
): ResolvedJobOptions {
  return {
    priority: 0,
    attempts: 1,
    backoff: 0,
    timeout: 0,
    removeOnComplete: false,
    removeOnFail: false,
    keepStacktraces: 5,
    ...overrides,
  };
}

/**
 * A job record with sensible defaults, for driver tests that work at the
 * storage layer rather than through `BunQueue`.
 */
export function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = overrides.createdAt ?? Date.now();

  return {
    id: overrides.id ?? newId(),
    name: "test",
    data: { hello: "world" },
    opts: jobOptions(overrides.opts),
    state: "waiting",
    priority: 0,
    runAt: now,
    createdAt: now,
    processedOn: null,
    finishedOn: null,
    expiresAt: null,
    attemptsMade: 0,
    maxAttempts: 1,
    stalledCount: 0,
    progress: null,
    returnValue: null,
    failedReason: null,
    stacktrace: [],
    lockToken: null,
    lockExpiresAt: null,
    workerId: null,
    repeatKey: null,
    flow: null,
    ...overrides,
  };
}

/** Waits until `predicate` holds, or fails the test after `timeout`. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options?: {
    /** How long to keep trying. Defaults to 2000ms. */
    timeout?: number;
    /** How long to wait between attempts. Defaults to 5ms. */
    interval?: number;
    /**
     * The failure message. A function is called only on failure, so a test
     * can gather the state that explains it without paying for that on the
     * happy path.
     */
    message?: string | (() => string | Promise<string>);
  },
): Promise<void> {
  const timeout = options?.timeout ?? 2000;
  const interval = options?.interval ?? 5;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(interval);
  }

  const message =
    typeof options?.message === "function"
      ? await options.message()
      : options?.message;

  throw new Error(message ?? `Condition not met within ${timeout}ms`);
}
