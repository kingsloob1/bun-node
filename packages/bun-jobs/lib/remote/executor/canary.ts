/**
 * The built-in canary handler (`remote-transports.md` §5.3) and the
 * readiness checks it shares with `/readyz` and the `health` probe.
 *
 * Browser-safe: Web APIs only.
 */

import type { RemoteHealthCheck } from "../types";
import type { RemoteExecutorHealthOptions, RemoteJobHandler } from "./types";
import { UnrecoverableJobError } from "../../shared/errors";

/**
 * The reserved job name of the functional canary: an ordinary invoke whose
 * one job proves verify → decode → dispatch → a handler → progress → log →
 * result → sign, end to end. Every executor answers it with the built-in
 * handler; an author may not register a handler under it.
 */
export const REMOTE_CANARY_JOB = "bun-jobs:canary";

/** How long the author's checks may take before they are reported as failed. */
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;
/** The canary's step count: default, and the most it will run. */
const STEPS = { default: 3, max: 10 } as const;
/** The canary's step spacing in ms: default, and the most it will wait. */
const STEP_MS = { default: 100, max: 1_000 } as const;
/** The longest nonce the canary echoes. */
const MAX_NONCE = 128;

/** Why an author check could not run, reported as one failed check. */
function failedRun(detail: string): RemoteHealthCheck[] {
  return [{ id: "health.check", status: "fail", detail }];
}

/** Whether a value is a list of checks. */
function isChecks(value: unknown): value is RemoteHealthCheck[] {
  return (
    Array.isArray(value) &&
    value.every(
      (check) =>
        check !== null &&
        typeof check === "object" &&
        typeof (check as RemoteHealthCheck).id === "string" &&
        ((check as RemoteHealthCheck).status === "pass" ||
          (check as RemoteHealthCheck).status === "fail"),
    )
  );
}

/**
 * Runs the author's checks, bounded by {@link HEALTH_CHECK_TIMEOUT_MS}. A
 * throw, a timeout or a malformed answer is one failed check named
 * `health.check`; no checks configured is an empty list.
 */
export function createHealthRunner(
  options: RemoteExecutorHealthOptions | undefined,
): () => Promise<RemoteHealthCheck[]> {
  const check = options?.check;
  if (check === undefined) {
    return async () => [];
  }
  /** Concurrent callers share one run, so an unauthenticated `/readyz` cannot multiply the work. */
  let running: Promise<RemoteHealthCheck[]> | undefined;
  return () => {
    running ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve().then(check),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(resolve, HEALTH_CHECK_TIMEOUT_MS, "timeout");
          }),
        ]);
        if (result === "timeout") {
          return failedRun(
            `the checks took longer than ${HEALTH_CHECK_TIMEOUT_MS} ms`,
          );
        }
        return isChecks(result)
          ? result
          : failedRun("the checks did not answer a list of { id, status }");
      } catch (error) {
        return failedRun(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(timer);
        running = undefined;
      }
    })();
    return running;
  };
}

/** Whether every check passed. */
export function allPass(checks: readonly RemoteHealthCheck[]): boolean {
  return checks.every((check) => check.status === "pass");
}

/** A whole number within bounds, or the default when absent; `undefined` when invalid. */
function bounded(
  value: unknown,
  limits: { default: number; max: number },
): number | undefined {
  if (value === undefined) {
    return limits.default;
  }
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= limits.max
    ? (value as number)
    : undefined;
}

/** Waits `ms`, or until the signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * The canary's handler. `data` is `{ nonce, steps?, stepMs? }` (at most 10
 * steps, 1 s apart): it reports `steps` progress values `stepMs` apart,
 * writes one log line, runs the author's checks, and answers
 * `{ nonce, checks }`. The gateway checks the nonce echoes and every check
 * passed. Malformed data fails it, fatally.
 */
export function createCanaryHandler(
  runChecks: () => Promise<RemoteHealthCheck[]>,
): RemoteJobHandler {
  return async (job, ctx) => {
    const data = (job.data ?? {}) as Record<string, unknown>;
    const steps = bounded(data.steps, STEPS);
    const stepMs = bounded(data.stepMs, STEP_MS);
    if (
      typeof data.nonce !== "string" ||
      data.nonce.length > MAX_NONCE ||
      steps === undefined ||
      stepMs === undefined
    ) {
      throw new UnrecoverableJobError(
        `A canary's data is { nonce: string (≤ ${MAX_NONCE}), steps?: 0–${STEPS.max}, stepMs?: 0–${STEP_MS.max} }`,
      );
    }
    for (let step = 1; step <= steps; step++) {
      await pause(stepMs, ctx.signal);
      await job.updateProgress(Math.round((step / steps) * 100));
    }
    await job.log(`canary ${data.nonce}`);
    return { nonce: data.nonce, checks: await runChecks() };
  };
}
