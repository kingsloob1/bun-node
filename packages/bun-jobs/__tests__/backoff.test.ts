import type { BackoffContext, JobRecord } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BackoffStrategies,
  BUILT_IN_BACKOFFS,
  BunJobs,
  ConfigError,
  MemoryDriver,
} from "../lib/index";
import { nextBackoff } from "../lib/queue/backoff";
import { makeJob, testNamespace, waitFor } from "./helpers";

/**
 * Backoff between a job's attempts: the built-in strategies reaching the
 * worker, and named ones resolved on the worker that runs the job.
 */

/** A job whose backoff is `backoff`, as a worker would read it back. */
function jobWith(backoff: JobRecord["opts"]["backoff"]): JobRecord {
  const job = makeJob({ id: "backoff-job" });
  return { ...job, opts: { ...job.opts, backoff } };
}

/** What a warning reports, exactly as `nextBackoff` declares its sink. */
type WarningFields = Parameters<Parameters<typeof nextBackoff>[4]>[1];

/** Collects warnings instead of logging them. */
function warnings() {
  const seen: { message: string; fields: WarningFields }[] = [];
  return {
    seen,
    warn: (message: string, fields: WarningFields) => {
      seen.push({ message, fields });
    },
  };
}

describe("BackoffStrategies", () => {
  it("registers, finds and lists strategies", () => {
    const strategies = new BackoffStrategies()
      .define("slowRamp", ({ attempt }) => attempt * 1_000)
      .define("never", () => false);

    expect(strategies.has("slowRamp")).toBe(true);
    expect(strategies.get("never")).toBeFunction();
    expect(strategies.names()).toEqual(["slowRamp", "never"]);
  });

  it("refuses a built-in name, an empty name, and something not a function", () => {
    for (const name of BUILT_IN_BACKOFFS) {
      expect(() => new BackoffStrategies().define(name, () => 1)).toThrow(
        ConfigError,
      );
    }
    expect(() => new BackoffStrategies().define("", () => 1)).toThrow(
      ConfigError,
    );
    expect(() => new BackoffStrategies().define("oops", 5 as never)).toThrow(
      ConfigError,
    );
  });

  it("builds from a plain object, and passes a registry through untouched", () => {
    const built = BackoffStrategies.from({ ramp: () => 10 });
    expect(built.has("ramp")).toBe(true);
    expect(BackoffStrategies.from(built)).toBe(built);
    expect(BackoffStrategies.from().names()).toEqual([]);
  });
});

describe("nextBackoff", () => {
  const error = new Error("attempt failed");
  const none = new BackoffStrategies();

  it("computes the built-in strategies", () => {
    const { warn, seen } = warnings();

    expect(nextBackoff(3, jobWith(250), error, none, warn)).toBe(250);
    expect(
      nextBackoff(
        3,
        jobWith({ type: "linear", delay: 100 }),
        error,
        none,
        warn,
      ),
    ).toBe(300);
    expect(
      nextBackoff(
        5,
        jobWith({ type: "fibonacci", delay: 100 }),
        error,
        none,
        warn,
      ),
    ).toBe(500);
    expect(seen).toEqual([]);
  });

  it("calls a named strategy with the attempt, the job, the error and its options", () => {
    const calls: BackoffContext[] = [];
    const strategies = new BackoffStrategies().define("ramp", (context) => {
      calls.push(context);
      return context.attempt * (context.options.delay ?? 0);
    });
    const job = jobWith({ type: "ramp", delay: 70 });

    expect(nextBackoff(4, job, error, strategies, warnings().warn)).toBe(280);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.attempt).toBe(4);
    expect(calls[0]!.job.id).toBe("backoff-job");
    expect(calls[0]!.error).toBe(error);
    expect(calls[0]!.options).toEqual({ type: "ramp", delay: 70 });
  });

  it("caps a named strategy at the job's max", () => {
    const strategies = new BackoffStrategies().define("huge", () => 1e9);
    expect(
      nextBackoff(
        1,
        jobWith({ type: "huge", max: 5_000 }),
        error,
        strategies,
        warnings().warn,
      ),
    ).toBe(5_000);
  });

  it("passes on false, which means stop retrying", () => {
    const strategies = new BackoffStrategies().define("stop", () => false);
    expect(
      nextBackoff(
        1,
        jobWith({ type: "stop" }),
        error,
        strategies,
        warnings().warn,
      ),
    ).toBe(false);
  });

  it("falls back to the default, and says so, for a strategy it cannot use", () => {
    const strategies = new BackoffStrategies()
      .define("throws", () => {
        throw new Error("broken strategy");
      })
      .define("negative", () => -1)
      .define("nan", () => Number.NaN);

    for (const type of ["unknown-name", "throws", "negative", "nan"]) {
      const { warn, seen } = warnings();
      const delay = nextBackoff(1, jobWith({ type }), error, strategies, warn);

      // The default: exponential from 1s with ±10% jitter.
      expect(delay).toBeGreaterThanOrEqual(900);
      expect(delay).toBeLessThanOrEqual(1_100);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.fields.strategy).toBe(type);
    }
  });

  it("reports the fields that match why a strategy could not be used", () => {
    const thrown = new Error("broken strategy");
    const strategies = new BackoffStrategies()
      .define("throws", () => {
        throw thrown;
      })
      .define("negative", () => -1);

    const fieldsFor = (type: string): WarningFields | undefined => {
      const { warn, seen } = warnings();
      nextBackoff(1, jobWith({ type }), error, strategies, warn);
      return seen[0]?.fields;
    };

    expect(fieldsFor("unknown-name")).toEqual({
      jobId: "backoff-job",
      strategy: "unknown-name",
      known: ["throws", "negative"],
    });
    expect(fieldsFor("throws")).toEqual({
      jobId: "backoff-job",
      strategy: "throws",
      error: thrown,
    });
    expect(fieldsFor("negative")).toEqual({
      jobId: "backoff-job",
      strategy: "negative",
      result: -1,
    });
  });
});

describe("backoff on a worker", () => {
  let jobs: BunJobs | undefined;

  afterEach(async () => {
    await jobs?.close();
    jobs = undefined;
  });

  /** A context whose one job always fails. */
  function failingJobs() {
    const context = new BunJobs({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
    });
    context.define("flaky", async () => {
      throw new Error("still broken");
    });
    jobs = context;
    return context;
  }

  it("retries on the schedule a strategy from defineBackoff sets", async () => {
    const context = failingJobs();
    const attempts: number[] = [];
    context.defineBackoff("quickRamp", ({ attempt, options }) => {
      attempts.push(attempt);
      return attempt * (options.delay ?? 0);
    });

    const worker = await context.start({ pollInterval: 5, maxBlock: 10 });
    const delays: number[] = [];
    worker.on("retrying", (job, _error, runAt) => {
      delays.push(runAt - (job.processedOn ?? runAt));
    });

    const job = await context.now(
      "flaky",
      {},
      { attempts: 3, backoff: { type: "quickRamp", delay: 20 } },
    );

    await waitFor(
      async () =>
        (await context.queue("jobs").getJob(job.id))?.state === "dead",
      { timeout: 10_000, message: "the job never ran out of attempts" },
    );

    // Two retries for three attempts, each from the named strategy.
    expect(attempts).toEqual([1, 2]);
    expect(delays).toHaveLength(2);
  }, 15_000);

  it("lets a strategy stop the retries early by returning false", async () => {
    const context = failingJobs();
    let calls = 0;
    context.defineBackoff("giveUp", () => {
      calls++;
      return false;
    });

    await context.start({ pollInterval: 5, maxBlock: 10 });
    const job = await context.now(
      "flaky",
      {},
      { attempts: 10, backoff: { type: "giveUp" } },
    );

    await waitFor(
      async () =>
        (await context.queue("jobs").getJob(job.id))?.state === "dead",
      { timeout: 10_000, message: "the job was retried instead of dying" },
    );

    const stored = await context.queue("jobs").getJob(job.id);
    expect(stored?.attemptsMade).toBe(1);
    expect(calls).toBe(1);
  }, 15_000);

  it("uses a built-in preset from the job's options", async () => {
    const context = failingJobs();
    const worker = await context.start({ pollInterval: 5, maxBlock: 10 });
    const scheduled: number[] = [];
    worker.on("retrying", (_job, _error, runAt) => {
      scheduled.push(runAt);
    });

    const before = Date.now();
    await context.now(
      "flaky",
      {},
      { attempts: 2, backoff: { type: "linear", delay: 60_000 } },
    );

    await waitFor(() => scheduled.length === 1, {
      timeout: 10_000,
      message: "the job was never retried",
    });

    // Linear, first retry: one delay from the failure.
    expect(scheduled[0]!).toBeGreaterThanOrEqual(before + 60_000);
    expect(scheduled[0]!).toBeLessThan(Date.now() + 60_000 + 1);
  }, 15_000);
});
