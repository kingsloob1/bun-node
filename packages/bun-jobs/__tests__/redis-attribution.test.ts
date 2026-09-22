import type { JobWorkerRef } from "../lib/drivers/driver";
import type { JobQuery, JobRecord } from "../lib/index";
import process from "node:process";
import { RedisClient as BunRedis } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import {
  packStamp,
  STAMP_FIELD,
  unpackStamp,
} from "../lib/drivers/redis/stamp";
import { newToken, RedisDriver, RedisKeys } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";

/**
 * Worker attribution on the Redis driver, below what the shared contract's
 * `describe("job attribution")` can see: the packed stamp's encoding, the raw
 * hash after a settle, and how many script calls a filtered read costs.
 *
 * The contract says *what* `processedBy` and the four filters answer; these
 * pin *how* Redis stores and reads them, because two of the ways it could go
 * wrong answer correctly in a small test — a separator inside a key only
 * misattributes the jobs of a worker whose key contains it, and a walk that
 * makes one call per job instead of one per chunk is only slow.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Drivers to close when the suite ends. */
const drivers: RedisDriver[] = [];

/** Clients this file opened for itself, closed after the drivers. */
const clients: BunRedis[] = [];

/**
 * The exact namespaces this file created, purged by name when the suite ends —
 * never a prefix sweep: other sessions share that server.
 */
const namespaces: string[] = [];

afterAll(async () => {
  await Promise.allSettled(drivers.map(async (driver) => await driver.close()));

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

  for (const client of clients.splice(0)) {
    client.close();
  }
});

/** A queue in a namespace of its own, remembered so it is purged afterwards. */
function scope(queue: string): { ns: string; queue: string } {
  const ns = testNamespace("attr");
  namespaces.push(ns);
  return { ns, queue };
}

/**
 * A driver whose client counts the scripts it runs — `EVALSHA` and `EVAL`
 * alike, since the first run of a script is an `EVAL`.
 */
function countingDriver(): { driver: RedisDriver; calls: () => number } {
  const client = new BunRedis(URL!);
  clients.push(client);
  let calls = 0;

  const counted = new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      const method = value as (...args: unknown[]) => unknown;
      if (property === "evalsha" || property === "eval") {
        return (...args: unknown[]) => {
          calls++;
          return method.apply(target, args);
        };
      }
      return method.bind(target);
    },
  });

  const driver = new RedisDriver({ url: URL, client: counted });
  drivers.push(driver);
  return { driver, calls: () => calls };
}

/** Refs chosen to break a separator-based encoding, each in a different way. */
const ADVERSARIAL: JobWorkerRef[] = [
  { id: "w-1", key: "svc.emails", host: "host-a", pid: 101 },
  { id: "w-1" },
  { id: "" },
  { id: "w-1", key: "", host: "", pid: 0 },
  // A key that is itself a well-formed packed stamp, and one holding every
  // separator anyone would pick.
  { id: "w-1", key: "3:abc6:host-a", host: "h", pid: 1 },
  { id: "w-1", key: "a\u001Fb\u001Fc", host: "\u001F", pid: 2 },
  { id: "1:a", key: "-", host: "--", pid: 3 },
  { id: "w:1", key: "k:e:y", host: "10.0.0.1:8080", pid: 4 },
  // Multi-byte text, where a length in UTF-16 units would cut mid-character.
  { id: "wörker", key: "ключ.🔑", host: "hôte", pid: 5 },
  // Partial refs: a restored record may carry any subset.
  { id: "w-1", host: "only-host" },
  { id: "w-1", pid: 9 },
  { id: "w-1", key: "only-key" },
];

describe("Redis attribution: the packed stamp", () => {
  it("round-trips every ref exactly, however hostile its text", () => {
    for (const ref of ADVERSARIAL) {
      expect(unpackStamp(packStamp(ref)), JSON.stringify(ref)).toEqual(ref);
    }
  });

  it("packs distinct refs to distinct strings", () => {
    // Injective: no two refs can be confused on disk, which is what would let
    // one worker's filter match another's jobs.
    const packed = ADVERSARIAL.map((ref) => packStamp(ref));
    expect(new Set(packed).size).toBe(packed.length);
  });

  it("is length-prefixed in bytes, with absent parts as '-'", () => {
    expect(
      packStamp({ id: "alpha-1", key: "svc.emails", host: "host-a", pid: 101 }),
    ).toBe("7:alpha-110:svc.emails6:host-a3:101");
    expect(packStamp({ id: "alpha-2" })).toBe("7:alpha-2");
    expect(packStamp({ id: "w", host: "h" })).toBe("1:w-1:h");
    // "é" is two bytes in UTF-8 and one UTF-16 unit.
    expect(packStamp({ id: "é" })).toBe("2:é");
  });

  it("reads nothing, rather than a guess, from a malformed value", () => {
    for (const bad of [
      "",
      "x",
      "5:abc",
      "3abc",
      "-",
      "1:a1:b1:c1:d1:e",
      "1:a-1:h1:x",
    ]) {
      expect(unpackStamp(bad), bad).toBeNull();
    }
    expect(unpackStamp(undefined)).toBeNull();
  });
});

describe.skipIf(!URL)("Redis attribution: storage", () => {
  it("writes the stamp in the claim and keeps it through every settle", async () => {
    const { driver } = countingDriver();
    const q = scope("raw");
    const now = Date.now();
    const worker = { key: "svc.raw", host: "host-r", pid: 42 };
    const client = new BunRedis(URL!);
    clients.push(client);
    const hash = (id: string): string =>
      `${new RedisKeys({}).queue(q).jobPrefix}${id}`;

    await driver.addJobs(q, [
      makeJob({ id: "completes", runAt: now, createdAt: now }),
      makeJob({ id: "dies", runAt: now, createdAt: now + 1 }),
      makeJob({ id: "buried", runAt: now, createdAt: now + 2 }),
    ]);

    const settle: Record<string, (token: string) => Promise<unknown>> = {
      completes: async (token) =>
        await driver.completeJob(q, "completes", token, null, false, now + 1),
      dies: async (token) =>
        await driver.failJob(
          q,
          "dies",
          token,
          { name: "Error", message: "x" },
          { retry: false, retention: false },
          now + 1,
          3,
        ),
      buried: async (token) =>
        await driver.buryJob(
          q,
          "buried",
          { name: "Error", message: "x" },
          { retention: false, keepStacktraces: 3, token },
          now + 1,
        ),
    };

    for (const id of ["completes", "dies", "buried"]) {
      const token = newToken();
      const claimed = await driver.claimJob(q, {
        workerId: `w-${id}`,
        worker,
        token,
        lockMs: 30_000,
        now,
      });
      expect(claimed?.id).toBe(id);
      expect(await client.hget(hash(id), STAMP_FIELD)).toBe(
        packStamp({ id: `w-${id}`, ...worker }),
      );

      await settle[id]!(token);

      // The stamp survives untouched; the holder is cleared, as before.
      expect(await client.hget(hash(id), STAMP_FIELD), id).toBe(
        packStamp({ id: `w-${id}`, ...worker }),
      );
      expect(await client.hget(hash(id), "workerId"), id).toBe("");
      expect((await driver.getJob(q, id))?.processedBy, id).toEqual({
        id: `w-${id}`,
        ...worker,
      });
    }
  });

  it("claims with the stamp in the same script call as the claim", async () => {
    const { driver, calls } = countingDriver();
    const q = scope("one-call");
    const now = Date.now();
    await driver.addJobs(q, [
      makeJob({ id: "one", runAt: now, createdAt: now }),
      makeJob({ id: "two", runAt: now, createdAt: now + 1 }),
      makeJob({ id: "three", runAt: now, createdAt: now + 2 }),
    ]);
    const worker = { key: "svc.one", host: "h", pid: 1 };

    const before = calls();
    await driver.claimJob(q, {
      workerId: "w",
      worker,
      token: newToken(),
      lockMs: 30_000,
      now,
    });
    expect(calls() - before).toBe(1);

    const plural = calls();
    const claimed = await driver.claimJobs(
      q,
      { workerId: "w", worker, token: newToken(), lockMs: 30_000, now },
      5,
    );
    expect(calls() - plural).toBe(1);
    expect(claimed.map((job) => job.processedBy)).toEqual([
      { id: "w", ...worker },
      { id: "w", ...worker },
    ]);
  });

  it("filters exactly on keys that would break a separator encoding", async () => {
    const { driver } = countingDriver();
    const q = scope("hostile");
    const now = Date.now();

    // Each claimed under its own hostile ref, then completed.
    const workers = ADVERSARIAL.filter((ref) => ref.key !== undefined).map(
      (ref, index) => ({ jobId: `job-${index}`, ref }),
    );
    await driver.addJobs(
      q,
      workers.map(({ jobId }, index) =>
        makeJob({ id: jobId, runAt: now, createdAt: now + index }),
      ),
    );
    for (const { jobId, ref } of workers) {
      const token = newToken();
      const claimed = await driver.claimJob(q, {
        workerId: ref.id,
        worker: { key: ref.key!, host: ref.host ?? "", pid: ref.pid ?? 0 },
        token,
        lockMs: 30_000,
        now,
      });
      expect(claimed?.id).toBe(jobId);
      await driver.completeJob(q, jobId, token, null, false, now + 1);
    }

    const find = async (query: Partial<JobQuery>): Promise<string[]> => {
      const page = await driver.findJobs(q, {
        states: ["completed"],
        offset: 0,
        limit: 100,
        order: "asc",
        ...query,
      });
      return page.jobs.map((job) => job.id).sort();
    };

    for (const { jobId, ref } of workers) {
      const expected = workers
        .filter((other) => other.ref.key === ref.key)
        .map((other) => other.jobId)
        .sort();
      expect(await find({ workerKeys: [ref.key!] }), ref.key).toEqual(expected);
      expect(expected).toContain(jobId);
    }

    // The parts a naive split would read as the key match nothing.
    for (const decoy of [
      "abc",
      "a",
      "b",
      "3",
      "6:host-a",
      "k",
      "ключ",
      "\u001F",
    ]) {
      expect(await find({ workerKeys: [decoy] }), decoy).toEqual([]);
    }
    // A key that looks like a stamp's id segment is not an id, nor the reverse.
    expect(await find({ workerIds: ["a"] })).toEqual([]);
    expect(await find({ workerIds: ["1:a"] })).toEqual(
      workers.filter(({ ref }) => ref.id === "1:a").map(({ jobId }) => jobId),
    );
  });
});

describe.skipIf(!URL)(
  "Redis attribution: the range is finishedOn, not the score",
  () => {
    it("never matches a finished record restored without a finishedOn", async () => {
      const { driver } = countingDriver();
      const q = scope("no-finished-on");
      const base = 1_700_000_000_000;

      // Scored by createdAt, since the add script falls back to it — squarely
      // inside the range — but carrying no finishedOn, so no range can match it.
      await driver.addJobs(q, [
        makeJob({
          id: "unscored",
          state: "completed",
          createdAt: base + 500,
          attemptsMade: 1,
          processedOn: base,
        }),
        makeJob({
          id: "scored",
          state: "completed",
          createdAt: base,
          finishedOn: base + 500,
          attemptsMade: 1,
          processedOn: base,
        }),
      ]);

      const page = await driver.findJobs(q, {
        states: ["completed"],
        offset: 0,
        limit: 10,
        order: "asc",
        total: true,
        finishedFrom: base,
        finishedTo: base + 1_000,
      });
      expect(page.jobs.map((job) => job.id)).toEqual(["scored"]);
      expect(page.total).toBe(1);
    });
  },
);

describe.skipIf(!URL)("Redis attribution: bounded script calls", () => {
  /** Jobs seeded per test: enough for three chunks of 500. */
  const SIZE = 1_200;
  /** When the seeded jobs finish: one millisecond apart from here. */
  const BASE = 1_700_000_000_000;

  /**
   * `SIZE` completed jobs, restored already stamped — one `addJobs` call per
   * 500 rather than a claim and a completion each. Every hundredth is claimed
   * by the key the tests look for; the rest by another.
   */
  async function seeded(queue: string): Promise<{
    q: { ns: string; queue: string };
    driver: RedisDriver;
    calls: () => number;
  }> {
    const { driver, calls } = countingDriver();
    const q = scope(queue);
    const jobs: JobRecord[] = [];
    for (let index = 0; index < SIZE; index++) {
      jobs.push(
        makeJob({
          id: `j-${String(index).padStart(5, "0")}`,
          state: "completed",
          createdAt: BASE + index,
          processedOn: BASE + index,
          finishedOn: BASE + index,
          attemptsMade: 1,
          processedBy: {
            id: `w-${index % 7}`,
            key: index % 100 === 0 ? "svc.hit" : "svc.miss",
            host: "h",
            pid: index,
          },
        }),
      );
    }
    await driver.addJobs(q, jobs);
    return { q, driver, calls };
  }

  it("walks a residual worker filter one call per 500 members, not per job", async () => {
    const { q, driver, calls } = await seeded("chunks");

    const before = calls();
    const page = await driver.findJobs(q, {
      states: ["completed"],
      offset: 0,
      limit: 100,
      order: "asc",
      total: true,
      workerKeys: ["svc.hit"],
    });

    // Twelve matches among 1,200: the page never fills, so the walk covers the
    // whole set — in ceil(1200 / 500) calls.
    expect(page.total).toBe(12);
    expect(page.jobs.map((job) => job.id)).toEqual(
      Array.from(
        { length: 12 },
        (_, index) => `j-${String(index * 100).padStart(5, "0")}`,
      ),
    );
    expect(calls() - before).toBe(Math.ceil(SIZE / 500));
  });

  it("reads a range as a window of the set: calls scale with the range, not the set", async () => {
    const { q, driver, calls } = await seeded("window");

    // 100 of 1,200 jobs finished in [BASE + 300, BASE + 400).
    const range = { finishedFrom: BASE + 300, finishedTo: BASE + 400 };

    let before = calls();
    const all = await driver.findJobs(q, {
      states: ["completed", "waiting", "active", "failed", "delayed"],
      offset: 0,
      limit: 1_000,
      order: "asc",
      total: true,
      ...range,
    });
    expect(all.total).toBe(100);
    expect(all.jobs[0]?.id).toBe("j-00300");
    expect(all.jobs.at(-1)?.id).toBe("j-00399");
    // One call: the window holds 100 members, and no unfinished state is asked.
    expect(calls() - before).toBe(1);

    before = calls();
    const filtered = await driver.findJobs(q, {
      states: ["completed"],
      offset: 0,
      limit: 10,
      order: "desc",
      total: true,
      workerKeys: ["svc.hit"],
      ...range,
    });
    expect(filtered.jobs.map((job) => job.id)).toEqual(["j-00300"]);
    expect(filtered.total).toBe(1);
    expect(calls() - before).toBe(1);

    // Paged in the window, from either end.
    const desc = await driver.findJobs(q, {
      states: ["completed"],
      offset: 5,
      limit: 3,
      order: "desc",
      ...range,
    });
    expect(desc.jobs.map((job) => job.id)).toEqual([
      "j-00394",
      "j-00393",
      "j-00392",
    ]);
  });

  it("stops at the first chunk when the page fills and no total is asked", async () => {
    const { q, driver, calls } = await seeded("first-chunk");

    const before = calls();
    const page = await driver.findJobs(q, {
      states: ["completed", "dead"],
      offset: 0,
      limit: 50,
      order: "asc",
      finishedFrom: BASE,
    });
    expect(page.jobs).toHaveLength(50);
    expect(page.jobs[0]?.id).toBe("j-00000");
    expect(calls() - before).toBe(1);
  });
});
