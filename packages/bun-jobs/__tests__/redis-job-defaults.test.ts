import type {
  JobRecord,
  JobsDriver,
  PendingOptionsRewrite,
  PendingOptionsRewriteResult,
  QueueRef,
  StoredJobOptions,
} from "../lib/index";
import { Buffer } from "node:buffer";
import process from "node:process";
import { serializeError } from "@kingsleyweb/bun-common";
import { RedisClient } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { RedisKeys } from "../lib/drivers/redis/keys";
import {
  EXPLICIT_MASK_FIELD,
  MAX_ATTEMPTS_FIELD,
  OPTION_FIELD_PREFIX,
  REWRITE_BATCH_MAX,
  REWRITE_BLOB_BUDGET,
  REWRITE_PENDING,
} from "../lib/drivers/redis/scripts";
import { RedisDriver } from "../lib/index";
import { JOB_OPTION_BITS } from "../lib/queue/jobDefaults";
import { newToken } from "../lib/shared/ids";
import { jobOptions, makeJob, testNamespace } from "./helpers";

/**
 * What the Redis driver does for queue job defaults beyond the shared driver
 * contract: where it keeps what a rewrite writes, how its scripts read a job's
 * options without parsing the payload, the records older layouts left behind,
 * the batch and cursor arithmetic of the walk, and the flow race fix on a
 * cluster-shaped key layout.
 *
 * ```bash
 * BUN_JOBS_TEST_REDIS_URL=redis://127.0.0.1:6379/15 bun test redis-job-defaults
 * ```
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Drivers to close when the suite ends. */
const drivers: JobsDriver[] = [];

/** Raw clients to close when the suite ends. */
const clients: RedisClient[] = [];

/**
 * The exact namespaces this file created, purged by name when the suite ends,
 * never by a prefix sweep: other sessions share that server.
 */
const namespaces: string[] = [];

afterAll(async () => {
  await Promise.allSettled(drivers.map((driver) => driver.close()));

  if (URL && namespaces.length > 0) {
    const janitor = new RedisDriver({ url: URL });

    try {
      for (const ns of namespaces.splice(0)) {
        await janitor.purge(ns).catch(() => undefined);
      }
    } finally {
      await janitor.close();
    }
  }

  for (const client of clients) {
    client.close();
  }
});

const BITS = JOB_OPTION_BITS;

/** A driver on the configured server, tracked for cleanup. */
function makeDriver(options: { cluster?: boolean } = {}): RedisDriver {
  const driver = new RedisDriver({ url: URL, ...options });
  drivers.push(driver);
  return driver;
}

/** A raw client on the configured server, for reading and forging hashes. */
async function rawClient(): Promise<RedisClient> {
  const client = new RedisClient(URL);
  clients.push(client);
  await client.connect();
  return client;
}

/** A queue in a namespace of this file's own, remembered for the purge. */
function scope(name: string, queue = "jdef"): QueueRef {
  const ns = testNamespace(`rjd-${name}`);
  namespaces.push(ns);
  return { ns, queue };
}

/** The hash key of a job, as the driver builds it. */
function jobKey(q: QueueRef, id: string, cluster = false): string {
  return `${new RedisKeys({ cluster }).queue(q).jobPrefix}${id}`;
}

/** Stored options with a mask, as this version adds every job. */
function marked(
  explicit: number,
  overrides: Partial<StoredJobOptions> = {},
): StoredJobOptions {
  return { ...jobOptions(), ...overrides, explicit };
}

/** One request, every field at the value a case usually wants. */
function request(
  values: PendingOptionsRewrite["values"],
  extra: Partial<PendingOptionsRewrite> = {},
): PendingOptionsRewrite {
  return {
    states: ["waiting", "delayed", "failed", "waiting-children"],
    values,
    cursor: null,
    limit: 1_000,
    includeUnmarked: false,
    dryRun: false,
    now: Date.now(),
    ...extra,
  };
}

/** The stored job, which must exist. */
async function stored(
  driver: JobsDriver,
  q: QueueRef,
  id: string,
): Promise<JobRecord> {
  const job = await driver.getJob(q, id);
  expect(job).not.toBeNull();
  return job!;
}

/** Claims everything claimable, in claim order, and answers the ids. */
async function drain(
  driver: JobsDriver,
  q: QueueRef,
  now: number,
): Promise<string[]> {
  const ids: string[] = [];

  for (;;) {
    const job = await driver.claimJob(q, {
      workerId: "w-rjd",
      token: newToken(),
      lockMs: 5_000,
      now,
    });

    if (!job) {
      return ids;
    }

    ids.push(job.id);
  }
}

/** Every count of `result` added into `total`. */
function add(
  total: PendingOptionsRewriteResult,
  result: PendingOptionsRewriteResult,
): void {
  for (const key of [
    "examined",
    "rewritten",
    "unchanged",
    "skippedExplicit",
    "skippedUnmarked",
    "moved",
    "exhausted",
  ] as const) {
    total[key] += result[key];
  }
}

/** A result with every count at zero. */
function zero(): PendingOptionsRewriteResult {
  return {
    examined: 0,
    rewritten: 0,
    unchanged: 0,
    skippedExplicit: 0,
    skippedUnmarked: 0,
    moved: 0,
    exhausted: 0,
    next: null,
  };
}

describe.skipIf(!URL)("Redis queue job defaults", () => {
  it("writes opts ahead of data in the blob, so a script can read options without the payload", async () => {
    const driver = makeDriver();
    const raw = await rawClient();
    const q = scope("order");

    await driver.addJob(q, makeJob({ id: "one", opts: marked(0) }));

    const blob = await raw.hget(jobKey(q, "one"), "blob");
    expect(Object.keys(JSON.parse(blob!))).toEqual([
      "name",
      "maxAttempts",
      "opts",
      "data",
    ]);
    // The add wrote no field for the mask: it rides inside `opts`.
    expect(await raw.hget(jobKey(q, "one"), EXPLICIT_MASK_FIELD)).toBeNull();
    expect((await stored(driver, q, "one")).opts.explicit).toBe(0);
  });

  it("writes rewritten values beside the blob, leaving it byte for byte", async () => {
    const driver = makeDriver();
    const raw = await rawClient();
    const q = scope("beside");
    // Values a cjson round trip would change: an empty array reads back as
    // an object. The blob must never go through one.
    const data = { empty: [], nested: { list: [] }, text: "ok" };

    await driver.addJob(q, makeJob({ id: "job", data, opts: marked(0) }));
    const before = await raw.hget(jobKey(q, "job"), "blob");

    const backoff = { type: "exponential" as const, delay: 250 };
    const result = await driver.rewritePendingOptions(
      q,
      request({ attempts: 4, backoff, timeout: 900, priority: 2 }),
    );
    expect(result).toMatchObject({ examined: 1, rewritten: 1, next: null });

    const fields = (await raw.hgetall(jobKey(q, "job"))) as Record<
      string,
      string
    >;
    expect(fields.blob).toBe(before!);
    expect(fields[`${OPTION_FIELD_PREFIX}attempts`]).toBe("4");
    expect(fields[MAX_ATTEMPTS_FIELD]).toBe("4");
    expect(JSON.parse(fields[`${OPTION_FIELD_PREFIX}backoff`]!)).toEqual(
      backoff,
    );
    expect(fields[`${OPTION_FIELD_PREFIX}timeout`]).toBe("900");
    expect(fields.priority).toBe("2");
    expect(fields.optsPriority).toBe("2");
    // Priority keeps the field `updateJob` writes; there is no `o:priority`.
    expect(fields[`${OPTION_FIELD_PREFIX}priority`]).toBeUndefined();

    const job = await stored(driver, q, "job");
    expect(job.data).toEqual(data);
    expect(job.opts).toMatchObject({
      attempts: 4,
      backoff,
      timeout: 900,
      priority: 2,
      explicit: 0,
    });
    expect(job.maxAttempts).toBe(4);
    expect(job.priority).toBe(2);
  });

  it("reads the right options past a name and a payload built to fool the head scan", async () => {
    const driver = makeDriver();
    const q = scope("fool");
    // Quotes, braces and the very text the scan looks for, in the name, in
    // the options and in a payload that follows them.
    const name = 'we"ird}{,"maxAttempts":1,"opts":{"explicit":255}\\';
    const data = {
      bait: '},"opts":{"explicit":255,"attempts":9}',
      opts: { explicit: 255, attempts: 9 },
      braces: '{{{}}}"\\',
    };
    const opts = marked(0, {
      backoff: { type: "fixed", delay: 5 },
      jobId: 'id "with" {braces}',
    } as Partial<StoredJobOptions>);

    await driver.addJobs(q, [
      makeJob({ id: "defaulted", name, data, opts }),
      makeJob({
        id: "pinned",
        name,
        data,
        opts: { ...opts, explicit: BITS.attempts },
      }),
    ]);

    const result = await driver.rewritePendingOptions(
      q,
      request({ attempts: 3 }),
    );
    expect(result).toMatchObject({
      examined: 2,
      rewritten: 1,
      skippedExplicit: 1,
    });

    const defaulted = await stored(driver, q, "defaulted");
    expect(defaulted.name).toBe(name);
    expect(defaulted.data).toEqual(data);
    expect(defaulted.opts.attempts).toBe(3);
    expect((await stored(driver, q, "pinned")).opts.attempts).toBe(1);
  });

  it("decodes only the head of the blob: a payload it cannot parse does not stop a rewrite", async () => {
    const driver = makeDriver();
    const raw = await rawClient();
    const q = scope("head-only");

    await driver.addJob(q, makeJob({ id: "job", opts: marked(0) }));
    // Braces and quotes inside the options' strings, then a payload that is
    // not JSON at all: only a scan that skips string contents finds where
    // `opts` closes, and only a decode that stops there succeeds.
    const opts = JSON.stringify(
      marked(0, { jobId: '}{"}' } as Partial<StoredJobOptions>),
    );
    await raw.hset(
      jobKey(q, "job"),
      "blob",
      `{"name":"test","maxAttempts":1,"opts":${opts},"data":{not json`,
    );

    const result = await driver.rewritePendingOptions(
      q,
      request({ timeout: 21 }),
    );
    expect(result).toMatchObject({ examined: 1, rewritten: 1 });
    expect(
      await raw.hget(jobKey(q, "job"), `${OPTION_FIELD_PREFIX}timeout`),
    ).toBe("21");
  });

  it("reads records an older layout wrote: payload ahead of opts, and no blob at all", async () => {
    const driver = makeDriver();
    const raw = await rawClient();
    const q = scope("layouts");
    const opts = jobOptions({ timeout: 7 });

    await driver.addJobs(q, [
      makeJob({ id: "old-unmarked", opts }),
      makeJob({ id: "old-marked", opts }),
      makeJob({ id: "pre-blob", opts }),
    ]);

    // The blob as it was written before `opts` led: payload first.
    const oldBlob = (explicit?: number) =>
      JSON.stringify({
        name: "test",
        maxAttempts: 1,
        data: { opts: { explicit: 255 } },
        opts: explicit === undefined ? opts : { ...opts, explicit },
      });
    await raw.hset(jobKey(q, "old-unmarked"), "blob", oldBlob());
    await raw.hset(jobKey(q, "old-marked"), "blob", oldBlob(0));
    // And before the blob: four fields of their own.
    await raw.hdel(jobKey(q, "pre-blob"), "blob");
    await raw.hset(jobKey(q, "pre-blob"), {
      name: "test",
      maxAttempts: "1",
      data: JSON.stringify({ hello: "world" }),
      opts: JSON.stringify(opts),
    });

    const skipping = await driver.rewritePendingOptions(
      q,
      request({ timeout: 1_000 }),
    );
    expect(skipping).toMatchObject({
      examined: 3,
      rewritten: 1,
      skippedUnmarked: 2,
    });
    expect((await stored(driver, q, "old-marked")).opts.timeout).toBe(1_000);
    expect((await stored(driver, q, "old-unmarked")).opts.timeout).toBe(7);

    const including = await driver.rewritePendingOptions(
      q,
      request({ timeout: 1_000, attempts: 2 }, { includeUnmarked: true }),
    );
    expect(including).toMatchObject({ examined: 3, rewritten: 3 });

    for (const id of ["old-unmarked", "old-marked", "pre-blob"]) {
      const job = await stored(driver, q, id);
      expect(job.opts).toMatchObject({ timeout: 1_000, attempts: 2 });
      expect(job.maxAttempts).toBe(2);
    }
    expect((await stored(driver, q, "pre-blob")).data).toEqual({
      hello: "world",
    });
    expect(
      (await stored(driver, q, "old-unmarked")).opts.explicit,
    ).toBeUndefined();

    // updateJob finds the mask in an old blob too, and leaves none on the
    // unmarked ones.
    await driver.updateJob(q, "old-marked", { priority: 4 }, Date.now());
    await driver.updateJob(q, "old-unmarked", { priority: 4 }, Date.now());
    await driver.updateJob(q, "pre-blob", { priority: 4 }, Date.now());
    expect((await stored(driver, q, "old-marked")).opts.explicit).toBe(
      BITS.priority,
    );
    expect(
      (await stored(driver, q, "old-unmarked")).opts.explicit,
    ).toBeUndefined();
    expect((await stored(driver, q, "pre-blob")).opts.explicit).toBeUndefined();
  });

  it("keeps the priority bit updateJob set through a rewrite, and ORs it into the stored mask", async () => {
    const driver = makeDriver();
    const raw = await rawClient();
    const q = scope("xmask");

    await driver.addJob(
      q,
      makeJob({ id: "job", opts: marked(BITS.timeout | BITS.keepLogs) }),
    );
    await driver.updateJob(q, "job", { priority: 3 }, Date.now());
    expect(await raw.hget(jobKey(q, "job"), EXPLICIT_MASK_FIELD)).toBe(
      String(BITS.timeout | BITS.keepLogs | BITS.priority),
    );

    const result = await driver.rewritePendingOptions(
      q,
      request({ priority: 9, timeout: 5, attempts: 6 }),
    );
    // attempts is the only key neither explicit nor already there.
    expect(result).toMatchObject({ rewritten: 1 });

    const job = await stored(driver, q, "job");
    expect(job.priority).toBe(3);
    expect(job.opts).toMatchObject({ priority: 3, timeout: 0, attempts: 6 });
    expect(job.opts.explicit).toBe(
      BITS.timeout | BITS.keepLogs | BITS.priority,
    );
  });

  it("re-checks each job's state in the script, and counts a hash that disagrees with its set as moved", async () => {
    const driver = makeDriver();
    const raw = await rawClient();
    const q = scope("recheck");

    await driver.addJobs(q, [
      makeJob({ id: "stray", opts: marked(0) }),
      makeJob({ id: "fine", opts: marked(0) }),
    ]);
    // Still in the wait set, but its hash says a worker holds it.
    await raw.hset(jobKey(q, "stray"), "state", "active");

    const result = await driver.rewritePendingOptions(
      q,
      request({ timeout: 11 }, { states: ["waiting"] }),
    );
    expect(result).toMatchObject({ examined: 2, rewritten: 1, moved: 1 });
    expect(
      await raw.hget(jobKey(q, "stray"), `${OPTION_FIELD_PREFIX}timeout`),
    ).toBeNull();
    expect((await stored(driver, q, "fine")).opts.timeout).toBe(11);
  });

  it("writes nothing at all on a dry run, down to the hash fields and the wait set", async () => {
    const driver = makeDriver();
    const raw = await rawClient();
    const q = scope("dry");
    const keys = new RedisKeys({}).queue(q);

    await driver.addJobs(q, [
      makeJob({ id: "a", opts: marked(0) }),
      makeJob({ id: "b", opts: marked(0) }),
    ]);
    await driver.updateJob(q, "b", { priority: 1 }, Date.now());

    const snapshot = async () => ({
      a: await raw.hgetall(jobKey(q, "a")),
      b: await raw.hgetall(jobKey(q, "b")),
      wait: await raw.send("ZRANGE", [keys.wait, "0", "-1", "WITHSCORES"]),
    });
    const before = await snapshot();

    const result = await driver.rewritePendingOptions(
      q,
      request({ priority: 5, attempts: 3 }, { dryRun: true }),
    );
    expect(result).toMatchObject({ examined: 2, rewritten: 2 });
    expect(await snapshot()).toEqual(before);
  });

  it("walks more jobs than one script takes, in claim order, and keeps FIFO among equal priorities", async () => {
    const driver = makeDriver();
    const q = scope("batches");
    const now = Date.now();
    const count = REWRITE_BATCH_MAX * 2 + 50;
    const ids = Array.from(
      { length: count },
      (_, index) => `j${String(index).padStart(4, "0")}`,
    );

    await driver.addJobs(
      q,
      ids.map((id, index) =>
        makeJob({ id, createdAt: now + index, runAt: now, opts: marked(0) }),
      ),
    );

    // One call, several scripts: the limit is well above one batch. Each job
    // re-scored from 0 to 2 lands ahead of the cursor, so a later batch of
    // the same call meets it again — as `unchanged`, and never twice written.
    const first = await driver.rewritePendingOptions(
      q,
      request({ priority: 2 }, { limit: 2_000 }),
    );
    expect(first).toMatchObject({
      examined: count * 2,
      rewritten: count,
      unchanged: count,
      next: null,
    });

    // A limit that ends inside a batch, walked to the end with the cursor.
    // Nothing moves this time, so each job is met once.
    const total = zero();
    let cursor: string | null = null;
    let calls = 0;
    do {
      const result = await driver.rewritePendingOptions(
        q,
        request({ priority: 2, timeout: 3 }, { limit: 170, cursor }),
      );
      expect(result.examined).toBeLessThanOrEqual(170);
      add(total, result);
      cursor = result.next;
      calls++;
      expect(calls).toBeLessThan(20);
    } while (cursor !== null);
    expect(calls).toBe(Math.ceil(count / 170));
    expect(total).toMatchObject({ examined: count, rewritten: count });

    expect(await drain(driver, q, now + 10)).toEqual(ids);
  });

  it("stops a script at its byte budget with heavy payloads, and the walk carries on in the next", async () => {
    const driver = makeDriver();
    const raw = await rawClient();
    const q = scope("budget");
    const keys = new RedisKeys({});
    const now = Date.now();
    const count = 40;
    // Together well past one script's budget, each well under it.
    const data = {
      pad: "x".repeat(Math.ceil((REWRITE_BLOB_BUDGET * 2) / count)),
    };

    const jobs: JobRecord[] = [];
    for (let index = 0; index < count; index++) {
      jobs.push(
        makeJob({
          id: `h${String(index).padStart(2, "0")}`,
          createdAt: now + index,
          data,
          opts: marked(0),
        }),
      );
    }
    await driver.addJobs(q, jobs);

    // One script asked for all of them examines only what its budget allows,
    // and says more follow.
    const script = (await raw.send("EVAL", [
      REWRITE_PENDING,
      String(keys.queueScriptKeys(q).length),
      ...keys.queueScriptKeys(q),
      keys.queue(q).jobPrefix,
      "waiting",
      "0",
      "",
      "",
      String(count),
      "0",
      "1",
      "timeout",
      "5",
    ])) as unknown[];
    expect(Number(script[0])).toBeGreaterThan(0);
    expect(Number(script[0])).toBeLessThan(count);
    expect(Number(script[9])).toBe(1);

    // The driver's call walks on through as many scripts as that takes.
    const result = await driver.rewritePendingOptions(
      q,
      request({ timeout: 5 }),
    );
    expect(result).toMatchObject({
      examined: count,
      rewritten: count,
      next: null,
    });
  });

  it("resumes past a cursor whose job has gone, comparing members byte by byte as the sorted set does", async () => {
    const driver = makeDriver();
    const raw = await rawClient();
    const q = scope("resume");
    const at = Date.now() + 60_000;
    // One score, so the order is the members' bytes alone — which a
    // locale-aware comparison would not reproduce for the last two.
    const ids = ["b", "a", "Z", "aa", "é", "ä", "A-1", "a b"];

    await driver.addJobs(
      q,
      ids.map((id) =>
        makeJob({ id, state: "delayed", runAt: at, opts: marked(0) }),
      ),
    );

    const total = zero();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await driver.rewritePendingOptions(
        q,
        request({ timeout: 8 }, { limit: 1, cursor, states: ["delayed"] }),
      );
      add(total, result);
      cursor = result.next;

      // Remove the job just rewritten, so the next call's cursor names a
      // member that is no longer in the set.
      for (const id of ids) {
        if (
          !seen.includes(id) &&
          (await raw.hget(jobKey(q, id), `${OPTION_FIELD_PREFIX}timeout`))
        ) {
          seen.push(id);
          await driver.removeJob(q, id);
        }
      }
    } while (cursor !== null);

    expect(total).toMatchObject({
      examined: ids.length,
      rewritten: ids.length,
    });
    // Visited in byte order, each exactly once.
    expect(seen).toEqual(
      [...ids].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y))),
    );
  });

  it.each([
    ["in the script that buries", false],
    ["before the script, on a cluster layout", true],
  ] as const)(
    "refuses a stale failure, reading a child on another queue %s",
    async (_how, cluster) => {
      const driver = makeDriver({ cluster });
      const ns = testNamespace("rjd-stale");
      namespaces.push(ns);
      const parents: QueueRef = { ns, queue: "parents" };
      const children: QueueRef = { ns, queue: "children" };
      const now = Date.now();
      const ofParent = {
        parent: { queue: "parents", id: "p" },
        children: [],
        pending: 0,
        values: {},
        failures: {},
        recorded: false,
      };
      const failure = serializeError(new Error("broke"));

      await driver.addJobs(children, [
        makeJob({ id: "bad", state: "dead", finishedOn: now, flow: ofParent }),
        makeJob({
          id: "worse",
          state: "dead",
          finishedOn: now,
          flow: ofParent,
        }),
      ]);
      await driver.addJob(
        parents,
        makeJob({
          id: "p",
          state: "waiting-children",
          flow: {
            parent: null,
            children: [
              { queue: "children", id: "bad" },
              { queue: "children", id: "worse" },
            ],
            pending: 2,
            values: {},
            failures: {},
            recorded: false,
          },
        }),
      );

      const fail = {
        completed: false,
        ignored: false,
        error: failure,
      } as const;
      const bad = { queue: "children", id: "bad" };
      expect(await driver.recordChild(parents, "p", bad, fail, now)).toBe(
        "buried",
      );
      await driver.markChildRecorded(children, "bad", false, now);
      expect(await driver.requeueParent(parents, "p", now)).toBe(true);

      // The stale delivery is refused; a new one still buries.
      expect(await driver.recordChild(parents, "p", bad, fail, now + 1)).toBe(
        "already",
      );
      expect((await stored(driver, parents, "p")).state).toBe(
        "waiting-children",
      );

      // Retried itself, the child's mark is reset — its state still says the
      // failure is behind it.
      expect(await driver.retryJob(children, "bad", true, now + 1)).toBe(true);
      expect((await stored(driver, children, "bad")).flow?.recorded).toBe(
        false,
      );
      expect(await driver.recordChild(parents, "p", bad, fail, now + 1)).toBe(
        "already",
      );
      expect((await stored(driver, parents, "p")).state).toBe(
        "waiting-children",
      );
      expect(
        await driver.recordChild(
          parents,
          "p",
          { queue: "children", id: "worse" },
          fail,
          now + 2,
        ),
      ).toBe("buried");
    },
  );
});
