import type {
  JobsDriver,
  PendingOptionsRewrite,
  QueueRef,
  QueueStateEntry,
  StoredJobOptions,
} from "../lib/drivers/driver";
import type { JobDefaultsPatch } from "../lib/queue/jobDefaults";
import { describe, expect, it } from "bun:test";
import {
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_BOUNDS,
} from "../lib/api/contract/constants";
import { MemoryDriver } from "../lib/drivers/memory-driver";
import {
  ALL_JOB_OPTION_BITS,
  assertRewriteRequest,
  decodeRewriteCursor,
  DEFAULT_JOB_DEFAULTS_REFRESH_MS,
  describeJobDefaults,
  encodeRewriteCursor,
  explicitKeys,
  explicitMaskOf,
  JOB_DEFAULTS_STATE,
  JOB_OPTION_BITS,
  jobDefaultIssue,
  JobDefaultsCache,
  maskOfKeys,
  overlayJobDefaults,
  planPendingRewrite,
  readJobDefaults,
  resetJobDefaults,
  sanitizeJobDefaults,
  supportsJobDefaults,
  writeJobDefaults,
} from "../lib/queue/jobDefaults";
import {
  DEFAULT_JOB_OPTIONS,
  resolveJobOptions,
  resolveLayeredJobOptions,
} from "../lib/queue/options";
import { DEFAULT_KEEP_LOGS } from "../lib/shared/constants";
import { ConfigError, NotSupportedError } from "../lib/shared/errors";
import { jobOptions, makeJob, testNamespace } from "./helpers";

/** A queue of a memory driver of its own: nothing here is shared between cases. */
function fresh(): { driver: MemoryDriver; q: QueueRef } {
  return {
    driver: new MemoryDriver(),
    q: { ns: testNamespace("jdef"), queue: "q" },
  };
}

/** `driver` with its queue-state reads counted, and optionally slowed. */
function counting(
  driver: JobsDriver,
  delayMs = 0,
): { driver: JobsDriver; reads: () => number } {
  let reads = 0;
  const wrapped = Object.create(driver) as JobsDriver;

  wrapped.getQueueState = async (q: QueueRef, name: string) => {
    reads++;
    if (delayMs > 0) {
      await Bun.sleep(delayMs);
    }
    return await driver.getQueueState!(q, name);
  };

  return { driver: wrapped, reads: () => reads };
}

/** A driver with the queue-state methods hidden, as a minimal custom one would be. */
function withoutQueueState(driver: JobsDriver): JobsDriver {
  const hidden = Object.create(driver) as JobsDriver;
  Object.defineProperty(hidden, "getQueueState", { value: undefined });
  Object.defineProperty(hidden, "setQueueState", { value: undefined });
  return hidden;
}

describe("the explicit mask", () => {
  it("gives every editable key its own bit, and all of them make 255", () => {
    const bits = JOB_DEFAULT_KEYS.map((key) => JOB_OPTION_BITS[key]);

    expect(Object.keys(JOB_OPTION_BITS).sort()).toEqual(
      [...JOB_DEFAULT_KEYS].sort(),
    );
    expect(new Set(bits).size).toBe(bits.length);
    for (const bit of bits) {
      expect(Math.log2(bit) % 1).toBe(0);
    }
    expect(bits.reduce((a, b) => a | b, 0)).toBe(ALL_JOB_OPTION_BITS);
    // Stored jobs carry these numbers; they must never move.
    expect(JOB_OPTION_BITS).toEqual({
      attempts: 1,
      backoff: 2,
      timeout: 4,
      priority: 8,
      removeOnComplete: 16,
      removeOnFail: 32,
      keepLogs: 64,
      keepStacktraces: 128,
    });
  });

  it("marks exactly the editable keys a call passed, and nothing for undefined", () => {
    expect(explicitMaskOf(undefined)).toBe(0);
    expect(explicitMaskOf({})).toBe(0);
    expect(
      explicitMaskOf({
        attempts: 3,
        priority: 0,
        removeOnFail: false,
        timeout: undefined,
        // Not editable: never a bit.
        delay: 5,
        jobId: "x",
      }),
    ).toBe(
      JOB_OPTION_BITS.attempts |
        JOB_OPTION_BITS.priority |
        JOB_OPTION_BITS.removeOnFail,
    );
  });

  it("reads back as keys in contract order, and tells no mask from an empty one", () => {
    expect(explicitKeys(undefined)).toBeUndefined();
    expect(explicitKeys(0)).toEqual([]);
    expect(explicitKeys(maskOfKeys(["keepLogs", "attempts"]))).toEqual([
      "attempts",
      "keepLogs",
    ]);
    // A bit from a newer version is ignored rather than invented.
    expect(explicitKeys(256 | JOB_OPTION_BITS.timeout)).toEqual(["timeout"]);
    expect(explicitKeys(-1)).toBeUndefined();
    expect(explicitKeys(1.5)).toBeUndefined();
  });
});

describe("validating stored values", () => {
  it("accepts each numeric bound's ends and refuses one past them, and fractions", () => {
    for (const key of [
      "attempts",
      "timeout",
      "priority",
      "keepLogs",
      "keepStacktraces",
    ] as const) {
      const { min, max } = JOB_DEFAULTS_BOUNDS[key];
      expect(jobDefaultIssue(key, min)).toBeNull();
      expect(jobDefaultIssue(key, max)).toBeNull();
      expect(jobDefaultIssue(key, min - 1)).toContain(key);
      expect(jobDefaultIssue(key, max + 1)).toContain(key);
      expect(jobDefaultIssue(key, min + 0.5)).toContain(key);
      expect(jobDefaultIssue(key, String(min))).toContain(key);
    }

    // In code 0 means "keep every line"; remotely it is refused.
    expect(jobDefaultIssue("keepLogs", 0)).not.toBeNull();
  });

  it("allows only fixed and exponential backoff, whole delays and max ≥ delay", () => {
    expect(jobDefaultIssue("backoff", 0)).toBeNull();
    expect(jobDefaultIssue("backoff", 1_000)).toBeNull();
    expect(jobDefaultIssue("backoff", -1)).not.toBeNull();
    expect(
      jobDefaultIssue("backoff", { type: "exponential", delay: 100 }),
    ).toBeNull();
    expect(
      jobDefaultIssue("backoff", {
        type: "fixed",
        delay: 100,
        max: 100,
        jitter: 0.5,
      }),
    ).toBeNull();
    expect(jobDefaultIssue("backoff", { type: "linear", delay: 1 })).toContain(
      "type",
    );
    expect(jobDefaultIssue("backoff", { type: "fixed" })).toContain("delay");
    expect(
      jobDefaultIssue("backoff", { type: "fixed", delay: 100, max: 99 }),
    ).toContain("max");
    expect(
      jobDefaultIssue("backoff", { type: "fixed", delay: 1, jitter: 2 }),
    ).toContain("jitter");
    expect(
      jobDefaultIssue("backoff", { type: "fixed", delay: 1, factor: 3 }),
    ).toContain("factor");
    expect(jobDefaultIssue("backoff", null)).not.toBeNull();
  });

  it("allows booleans, counts and { count?, ttl? } retention, with at least one", () => {
    for (const key of ["removeOnComplete", "removeOnFail"] as const) {
      expect(jobDefaultIssue(key, true)).toBeNull();
      expect(jobDefaultIssue(key, false)).toBeNull();
      expect(jobDefaultIssue(key, 10)).toBeNull();
      expect(jobDefaultIssue(key, { ttl: 1_000 })).toBeNull();
      expect(jobDefaultIssue(key, { count: 1, ttl: 1 })).toBeNull();
      expect(jobDefaultIssue(key, {})).toContain("count");
      expect(jobDefaultIssue(key, { count: -1 })).not.toBeNull();
      expect(
        jobDefaultIssue(key, {
          ttl: JOB_DEFAULTS_BOUNDS.retentionTtl.max + 1,
        }),
      ).not.toBeNull();
      expect(jobDefaultIssue(key, { age: 1 })).toContain("age");
      expect(jobDefaultIssue(key, "forever")).not.toBeNull();
    }
  });

  it("sanitises a stored override: unknown keys and bad values go, with reasons", () => {
    const { values, issues } = sanitizeJobDefaults({
      attempts: 3,
      timeout: -5,
      backoff: { delay: 10, type: "fixed", extra: 1 },
      removeOnComplete: { ttl: 5, count: 2 },
      somethingNew: true,
    });

    expect(values).toEqual({
      attempts: 3,
      removeOnComplete: { count: 2, ttl: 5 },
    });
    expect(issues).toHaveLength(3);
    expect(sanitizeJobDefaults(undefined)).toEqual({ values: {}, issues: [] });
    expect(sanitizeJobDefaults([1]).issues).toHaveLength(1);
  });
});

describe("storing a queue's override", () => {
  it("reads as nothing, seq 0, before anything is stored", async () => {
    const { driver, q } = fresh();
    expect(supportsJobDefaults(driver)).toBe(true);
    expect(await readJobDefaults(driver, q)).toEqual({ values: {}, seq: 0 });
  });

  it("merges a patch, clears a key with null, and seq only rises — a reset included", async () => {
    const { driver, q } = fresh();

    const first = await writeJobDefaults(
      driver,
      q,
      { attempts: 4, timeout: 100 },
      { now: 10, by: "ops" },
    );
    expect(first).toEqual({
      stored: {
        values: { attempts: 4, timeout: 100 },
        seq: 1,
        updatedAt: 10,
        by: "ops",
      },
      contended: false,
    });

    const second = await writeJobDefaults(
      driver,
      q,
      { timeout: null, priority: -2 },
      { now: 20 },
    );
    expect(second.stored).toMatchObject({
      values: { attempts: 4, priority: -2 },
      seq: 2,
    });

    const reset = await resetJobDefaults(driver, q, { now: 30 });
    expect(reset.stored).toMatchObject({ values: {}, seq: 3, updatedAt: 30 });

    // Stored as `{}`, not deleted: the version keeps rising.
    const entry = await driver.getQueueState(q, JOB_DEFAULTS_STATE);
    expect(entry).toEqual({
      value: { v: 1, values: {}, at: 30 },
      version: 3,
    });
    expect(await readJobDefaults(driver, q)).toEqual({
      values: {},
      seq: 3,
      updatedAt: 30,
    });
  });

  it("stores its own copy of an object value, fields in a fixed order", async () => {
    const { driver, q } = fresh();
    const backoff = { jitter: 0.1, delay: 5, type: "exponential" as const };

    await writeJobDefaults(driver, q, { backoff });
    backoff.delay = 999;

    const entry = await driver.getQueueState(q, JOB_DEFAULTS_STATE);
    const values = (entry?.value as { values: JobDefaultsPatch }).values;
    expect(JSON.stringify(values.backoff)).toBe(
      '{"type":"exponential","delay":5,"jitter":0.1}',
    );
  });

  it("refuses a stale expectedSeq without writing, and accepts a current one", async () => {
    const { driver, q } = fresh();

    // `0` means "nothing stored yet".
    expect(
      (await writeJobDefaults(driver, q, { attempts: 2 }, { expectedSeq: 0 }))
        .contended,
    ).toBe(false);

    const stale = await writeJobDefaults(
      driver,
      q,
      { attempts: 9 },
      { expectedSeq: 0 },
    );
    expect(stale.contended).toBe(true);
    expect(stale.stored).toMatchObject({ values: { attempts: 2 }, seq: 1 });

    const current = await writeJobDefaults(
      driver,
      q,
      { attempts: 9 },
      { expectedSeq: 1 },
    );
    expect(current).toMatchObject({
      contended: false,
      stored: { values: { attempts: 9 }, seq: 2 },
    });
  });

  it("keeps both of two concurrent writers' keys without expectedSeq", async () => {
    const { driver, q } = fresh();

    await Promise.all([
      writeJobDefaults(driver, q, { attempts: 3 }),
      writeJobDefaults(driver, q, { timeout: 50 }),
    ]);

    expect((await readJobDefaults(driver, q)).values).toEqual({
      attempts: 3,
      timeout: 50,
    });
  });

  it("refuses an unknown key or a value out of bounds before writing anything", async () => {
    const { driver, q } = fresh();

    await expect(
      writeJobDefaults(driver, q, { attempts: 0 }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      writeJobDefaults(driver, q, {
        attempts: 2,
        jobId: "x",
      } as unknown as JobDefaultsPatch),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      writeJobDefaults(driver, q, {
        backoff: { type: "custom", delay: 1 },
      } as unknown as JobDefaultsPatch),
    ).rejects.toBeInstanceOf(ConfigError);

    expect(await driver.getQueueState(q, JOB_DEFAULTS_STATE)).toBeNull();
  });

  it("cannot be forged or clobbered through setQueueState", async () => {
    const { driver, q } = fresh();

    await expect(
      driver.setQueueState(q, JOB_DEFAULTS_STATE, { v: 1, values: {} }, null),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("drops what a hand-edited entry cannot use, and says why", async () => {
    const { driver, q } = fresh();
    await writeJobDefaults(driver, q, { attempts: 2 });

    // What a newer version, or a person with a database client, might leave.
    const bypass = counting(driver);
    const entry = (await driver.getQueueState(q, JOB_DEFAULTS_STATE))!;
    const edited: QueueStateEntry = {
      value: {
        v: 1,
        values: { attempts: 1e9, timeout: 20, colour: "red" },
        at: "yesterday",
      },
      version: entry.version,
    };
    bypass.driver.getQueueState = async () => edited;

    const read = await readJobDefaults(bypass.driver, q);
    expect(read.values).toEqual({ timeout: 20 });
    expect(read.seq).toBe(entry.version);
    expect(read.updatedAt).toBeUndefined();
    expect(read.issues).toHaveLength(2);
  });

  it("gives up after repeated collisions and says it was contended", async () => {
    const { driver, q } = fresh();
    const losing = Object.create(driver) as JobsDriver;
    losing.getQueueState = driver.getQueueState.bind(driver);
    let tries = 0;
    losing.setQueueState = async () => {
      tries++;
      return null;
    };

    const result = await writeJobDefaults(losing, q, { attempts: 2 });
    expect(result).toEqual({
      stored: { values: {}, seq: 0 },
      contended: true,
    });
    expect(tries).toBe(5);
  });

  it("without queue state: reads as nothing and refuses to write", async () => {
    const { driver, q } = fresh();
    const bare = withoutQueueState(driver);

    expect(supportsJobDefaults(bare)).toBe(false);
    expect(await readJobDefaults(bare, q)).toEqual({ values: {}, seq: 0 });
    await expect(
      writeJobDefaults(bare, q, { attempts: 2 }),
    ).rejects.toBeInstanceOf(NotSupportedError);
  });
});

describe("JobDefaultsCache", () => {
  it("trusts a read for refreshMs and reads again after", async () => {
    const { driver, q } = fresh();
    const counted = counting(driver);
    const cache = new JobDefaultsCache(counted.driver, q, 1_000);

    expect(cache.refreshMs).toBe(1_000);
    expect(await cache.get(0)).toEqual({});
    await writeJobDefaults(driver, q, { attempts: 3 });

    // Within the window: the old answer, no read.
    expect(await cache.get(999)).toEqual({});
    expect(counted.reads()).toBe(1);

    // Past it: read, and the change is seen.
    expect(await cache.get(1_000)).toEqual({ attempts: 3 });
    expect(counted.reads()).toBe(2);
    expect((await cache.read(1_500)).seq).toBe(1);
    expect(counted.reads()).toBe(2);
  });

  it("defaults to a one-second window", () => {
    const { driver, q } = fresh();
    expect(DEFAULT_JOB_DEFAULTS_REFRESH_MS).toBe(1_000);
    expect(new JobDefaultsCache(driver, q).refreshMs).toBe(1_000);
  });

  it("reads on every call with refreshMs 0, and never shares a read then", async () => {
    const { driver, q } = fresh();
    const counted = counting(driver, 5);
    const cache = new JobDefaultsCache(counted.driver, q, 0);

    await cache.get(0);
    await cache.get(0);
    await Promise.all([cache.get(0), cache.get(0)]);
    expect(counted.reads()).toBe(4);
  });

  it("shares one read between concurrent callers of a stale cache", async () => {
    const { driver, q } = fresh();
    const counted = counting(driver, 10);
    const cache = new JobDefaultsCache(counted.driver, q, 1_000);

    await Promise.all(Array.from({ length: 8 }, () => cache.get(0)));
    expect(counted.reads()).toBe(1);
  });

  it("serves a primed answer at once, and a read that started earlier cannot overwrite it", async () => {
    const { driver, q } = fresh();
    const counted = counting(driver, 20);
    const cache = new JobDefaultsCache(counted.driver, q, 1_000);

    // A read is in flight, and will answer "nothing" …
    const early = cache.read(0);
    // … when a write through this same producer lands and primes the cache.
    const { stored } = await writeJobDefaults(driver, q, { attempts: 7 });
    cache.prime(stored, 1);

    expect(await cache.get(2)).toEqual({ attempts: 7 });
    await early;
    expect(await cache.get(3)).toEqual({ attempts: 7 });

    cache.invalidate();
    expect(await cache.get(4)).toEqual({ attempts: 7 });
    expect(counted.reads()).toBe(2);
  });

  it("answers nothing, never reading, on a driver without queue state", async () => {
    const { driver, q } = fresh();
    const cache = new JobDefaultsCache(withoutQueueState(driver), q);
    expect(await cache.read()).toEqual({ values: {}, seq: 0 });
  });

  it("refuses a refresh interval that is not a whole number of ms, 0 or more", () => {
    const { driver, q } = fresh();
    for (const bad of [-1, 0.5, Number.NaN, Infinity]) {
      expect(() => new JobDefaultsCache(driver, q, bad)).toThrow(ConfigError);
    }
  });
});

describe("resolving a new job's options in layers", () => {
  it("ranks the call, the override, the definition, the code, then the built-ins", () => {
    const opts = resolveLayeredJobOptions(
      {
        code: { attempts: 2, timeout: 10, priority: 1, keepStacktraces: 9 },
        definition: { attempts: 3, timeout: 20, removeOnFail: true },
        override: { attempts: 4, removeOnFail: { count: 5 } },
      },
      { attempts: 5 },
    );

    expect(opts).toEqual({
      ...DEFAULT_JOB_OPTIONS,
      attempts: 5, // the call
      removeOnFail: { count: 5 }, // override over the definition
      timeout: 20, // definition over the code
      priority: 1, // the code
      keepStacktraces: 9, // the code
      explicit: JOB_OPTION_BITS.attempts,
    });
  });

  it("records only the call's own options as explicit, 0 included", () => {
    expect(resolveLayeredJobOptions({}, undefined).explicit).toBe(0);
    expect(
      resolveLayeredJobOptions(
        { code: { attempts: 3 }, definition: { timeout: 9 } },
        {},
      ).explicit,
    ).toBe(0);
    expect(
      resolveLayeredJobOptions({ override: { priority: 3 } }, { priority: 3 })
        .explicit,
    ).toBe(JOB_OPTION_BITS.priority);
  });

  it("lets an undefined key fall through to the layer below", () => {
    const opts = resolveLayeredJobOptions(
      { code: { timeout: 10 }, override: { attempts: 4 } },
      { attempts: undefined, timeout: undefined },
    );
    expect(opts.attempts).toBe(4);
    expect(opts.timeout).toBe(10);
    expect(opts.explicit).toBe(0);
  });

  it("replaces a backoff object whole rather than merging it", () => {
    const opts = resolveLayeredJobOptions(
      {
        code: { backoff: { type: "exponential", delay: 1, factor: 4 } },
        override: { backoff: { type: "fixed", delay: 5 } },
      },
      undefined,
    );
    expect(opts.backoff).toEqual({ type: "fixed", delay: 5 });
  });

  it("still checks every value, whichever layer it came from", () => {
    expect(() =>
      resolveLayeredJobOptions({ definition: { attempts: 0 } }, undefined),
    ).toThrow(ConfigError);
  });

  it("leaves the two-layer resolveJobOptions exactly as it was: no mask", () => {
    expect(resolveJobOptions(undefined, undefined)).toEqual(
      DEFAULT_JOB_OPTIONS,
    );
    expect(
      "explicit" in resolveJobOptions({ attempts: 2 }, { timeout: 1 }),
    ).toBe(false);
  });
});

describe("overlaying an override on resolved options", () => {
  it("writes the keys whose bit is clear, keeps the rest, and leaves the input alone", () => {
    const opts = storedOptions({
      attempts: 2,
      timeout: 3,
      explicit: JOB_OPTION_BITS.attempts,
    });
    const snapshot = structuredClone(opts);
    const override: JobDefaultsPatch = {
      attempts: 9,
      timeout: 90,
      backoff: { type: "fixed", delay: 1 },
    };

    const next = overlayJobDefaults(opts, override);

    expect(next).toEqual({
      ...opts,
      timeout: 90,
      backoff: { type: "fixed", delay: 1 },
    });
    expect(opts).toEqual(snapshot);
    // Not the override's own object.
    expect(next.backoff).not.toBe(override.backoff);
  });

  it("leaves mask-less options alone unless told otherwise", () => {
    const legacy = storedOptions({ timeout: 3 });
    expect(overlayJobDefaults(legacy, { timeout: 9 })).toBe(legacy);
    expect(
      overlayJobDefaults(legacy, { timeout: 9 }, { includeUnmarked: true })
        .timeout,
    ).toBe(9);
  });
});

describe("planning one pending job's rewrite", () => {
  const base = { priority: 0, maxAttempts: 1, attemptsMade: 0 };

  it("names the outcome, and a rewrite's keys, in contract order", () => {
    expect(
      planPendingRewrite(
        { ...base, opts: storedOptions() },
        { timeout: 5 },
        false,
      ),
    ).toEqual({ outcome: "skippedUnmarked" });

    expect(
      planPendingRewrite(
        {
          ...base,
          opts: storedOptions({ explicit: JOB_OPTION_BITS.timeout }),
        },
        { timeout: 5 },
        false,
      ),
    ).toEqual({ outcome: "skippedExplicit" });

    expect(
      planPendingRewrite(
        { ...base, opts: storedOptions({ timeout: 5, explicit: 0 }) },
        { timeout: 5 },
        false,
      ),
    ).toEqual({ outcome: "unchanged" });

    const plan = planPendingRewrite(
      { ...base, opts: storedOptions({ explicit: 0 }) },
      { keepLogs: 3, attempts: 2, timeout: 0 },
      false,
    );
    expect(plan).toMatchObject({
      outcome: "rewritten",
      keys: ["attempts", "keepLogs"],
      maxAttempts: 2,
      priority: 0,
      exhausted: false,
    });
  });

  it("compares the columns too: a stale maxAttempts or priority is a change", () => {
    const plan = planPendingRewrite(
      {
        priority: 4,
        maxAttempts: 1,
        attemptsMade: 0,
        opts: storedOptions({ attempts: 3, priority: 7, explicit: 0 }),
      },
      { attempts: 3, priority: 7 },
      false,
    );
    expect(plan).toMatchObject({
      outcome: "rewritten",
      keys: ["attempts", "priority"],
      maxAttempts: 3,
      priority: 7,
    });
  });

  it("counts a job exhausted only when its attempts is actually written", () => {
    const spent = { priority: 0, maxAttempts: 5, attemptsMade: 3 };
    expect(
      planPendingRewrite(
        { ...spent, opts: storedOptions({ attempts: 5, explicit: 0 }) },
        { attempts: 3 },
        false,
      ),
    ).toMatchObject({ outcome: "rewritten", exhausted: true });
    expect(
      planPendingRewrite(
        {
          ...spent,
          opts: storedOptions({ attempts: 5, explicit: 0 }),
        },
        { attempts: 4, timeout: 1 },
        false,
      ),
    ).toMatchObject({ outcome: "rewritten", exhausted: false });
  });

  it("never mutates the job, and never shares the values' objects", () => {
    const opts = storedOptions({ explicit: 0 });
    const snapshot = structuredClone(opts);
    const values = { removeOnComplete: { count: 3 } };

    const plan = planPendingRewrite({ ...base, opts }, values, false);

    expect(opts).toEqual(snapshot);
    expect(plan.outcome).toBe("rewritten");
    if (plan.outcome === "rewritten") {
      expect(plan.opts.removeOnComplete).toEqual({ count: 3 });
      expect(plan.opts.removeOnComplete).not.toBe(values.removeOnComplete);
      expect(plan.opts.explicit).toBe(0);
    }
  });
});

describe("rewrite requests and cursors", () => {
  const ok: PendingOptionsRewrite = {
    states: ["waiting", "failed"],
    values: { attempts: 2 },
    cursor: null,
    limit: 10,
    includeUnmarked: false,
    dryRun: false,
    now: 0,
  };

  it("refuses states outside the four, repeats, an empty list, a bad limit or value", () => {
    expect(() => assertRewriteRequest(ok)).not.toThrow();

    for (const bad of [
      { states: [] },
      { states: ["active"] },
      { states: ["completed"] },
      { states: ["waiting", "waiting"] },
      { limit: 0 },
      { limit: 1.5 },
      { values: { attempts: 0 } },
      { values: { delay: 5 } },
    ] as Partial<PendingOptionsRewrite>[]) {
      expect(() => assertRewriteRequest({ ...ok, ...bad })).toThrow(
        ConfigError,
      );
    }
  });

  it("round-trips a cursor and refuses anything it did not issue", () => {
    const cursor = encodeRewriteCursor("failed", [3, 1_700_000_000_000, 12]);
    expect(
      decodeRewriteCursor(
        cursor,
        ["waiting", "failed"],
        ["number", "number", "number"],
      ),
    ).toEqual({ state: "failed", key: [3, 1_700_000_000_000, 12] });

    const three = ["number", "number", "number"] as const;
    for (const bad of [
      "",
      "garbage",
      "jd1.%%%",
      encodeRewriteCursor("failed", [3, 1, 12]).slice(0, -2),
      // A state the walk does not cover.
      encodeRewriteCursor("delayed", [3, 1, 12]),
      // The wrong shape of key.
      encodeRewriteCursor("failed", [3, 1]),
      encodeRewriteCursor("failed", [3, "1", 12]),
    ]) {
      expect(() =>
        decodeRewriteCursor(bad, ["waiting", "failed"], three),
      ).toThrow(ConfigError);
    }
  });
});

describe("describing a queue's defaults", () => {
  it("shows the code's values, the override, and what a job gets", () => {
    const code = resolveJobOptions({ attempts: 2, timeout: 5 }, undefined);
    const view = describeJobDefaults(code, {
      values: { attempts: 6, keepLogs: 10 },
      seq: 4,
      updatedAt: 99,
    });

    expect(view.code).toMatchObject({
      attempts: 2,
      timeout: 5,
      keepLogs: DEFAULT_KEEP_LOGS,
    });
    expect(view.effective).toMatchObject({
      attempts: 6,
      timeout: 5,
      keepLogs: 10,
    });
    expect(view.overridden).toEqual(["attempts", "keepLogs"]);
    expect(view.seq).toBe(4);
    expect(view.updatedAt).toBe(99);
  });
});

describe("memory driver: rewriting pending options", () => {
  it("refuses a cursor naming a state the call does not walk", async () => {
    const { driver, q } = fresh();
    await driver.addJob(q, makeJob({ opts: storedOptions({ explicit: 0 }) }));

    const cursor = encodeRewriteCursor("delayed", [0, 0, 0]);
    await expect(
      driver.rewritePendingOptions(q, {
        states: ["waiting"],
        values: { timeout: 3 },
        cursor,
        limit: 5,
        includeUnmarked: false,
        dryRun: false,
        now: Date.now(),
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("answers next: null when the walk ends exactly at the limit", async () => {
    const { driver, q } = fresh();
    const now = Date.now();
    await driver.addJobs(q, [
      makeJob({ id: "a", runAt: now, opts: storedOptions({ explicit: 0 }) }),
      makeJob({ id: "b", runAt: now, opts: storedOptions({ explicit: 0 }) }),
    ]);

    const request: PendingOptionsRewrite = {
      states: ["waiting", "delayed"],
      values: { timeout: 3 },
      cursor: null,
      limit: 2,
      includeUnmarked: false,
      dryRun: false,
      now,
    };
    expect(await driver.rewritePendingOptions(q, request)).toMatchObject({
      examined: 2,
      next: null,
    });

    const one = await driver.rewritePendingOptions(q, {
      ...request,
      limit: 1,
    });
    expect(one.next).not.toBeNull();
  });

  it("keeps the waiting index in claim order after a rewrite reorders it", async () => {
    const { driver, q } = fresh();
    const now = Date.now();
    const ids = Array.from({ length: 30 }, (_, index) => `j${index}`);

    await driver.addJobs(
      q,
      ids.map((id, index) =>
        makeJob({
          id,
          priority: index % 5,
          runAt: now,
          createdAt: now + index,
          opts: storedOptions({
            priority: index % 5,
            explicit: index % 3 === 0 ? JOB_OPTION_BITS.priority : 0,
          }),
        }),
      ),
    );

    await driver.rewritePendingOptions(q, {
      states: ["waiting"],
      values: { priority: 2 },
      cursor: null,
      limit: 7,
      includeUnmarked: false,
      dryRun: false,
      now,
    });

    // What claim order must be, worked out from the stored records alone.
    const records = await Promise.all(ids.map((id) => driver.getJob(q, id)));
    const expected = records
      .map((job) => job!)
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
      .map((job) => job.id);

    const claimed: string[] = [];
    for (;;) {
      const job = await driver.claimJob(q, {
        workerId: "w",
        token: "t",
        lockMs: 1_000,
        now,
      });
      if (!job) {
        break;
      }
      claimed.push(job.id);
    }

    expect(claimed).toEqual(expected);
  });
});

/**
 * Job options with every default filled in, plus the explicit mask when
 * given — `jobOptions` for the stored shape, which alone carries `explicit`.
 */
function storedOptions(
  overrides: Partial<StoredJobOptions> = {},
): StoredJobOptions {
  return { ...jobOptions(), ...overrides };
}
