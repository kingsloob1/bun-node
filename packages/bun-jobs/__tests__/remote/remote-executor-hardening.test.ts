import type { RemoteExecutorStore, RemoteInvokeJob } from "../../lib/remote";
import { describe, expect, it } from "bun:test";
import {
  createRemoteExecutor,
  createRemoteExecutorStore,
} from "../../lib/remote";
import { remoteExecutorStoreCapacity } from "../../lib/remote/executor/store";
import {
  gate,
  invoke,
  job,
  nextId,
  read,
  SECRET,
  signedPost,
  until,
} from "../helpers/remoteExecutor";

/**
 * Review round 2 of PR-2a3 (#270): the default store's capacity and its
 * eviction warning, a Request rebuilt from a used one, a joined attempt's
 * outcome, malformed fences, and signing the post-authentication 500.
 */

const URL = "http://executor.test/";

/** Sends one batch of `count` fresh `work` jobs. */
async function batch(
  executor: (request: Request) => Promise<Response>,
  count: number,
): Promise<RemoteInvokeJob[]> {
  const jobs = Array.from({ length: count }, () => job({ name: "work" }));
  const answer = await read(
    await executor(await signedPost(URL, invoke(jobs))),
  );
  expect(answer.status).toBe(200);
  return jobs;
}

describe("S1: the default store's capacity", () => {
  it("past capacity within the TTL, an unexpired eviction is warned once, and idempotency is lost", async () => {
    const warnings: [string, Record<string, unknown> | undefined][] = [];
    let runs = 0;
    // 3 × 100 slots × 30 s = 9,000 records, under the 10,000 floor: the
    // store holds 10,000, so about 3,334 attempts.
    const executor = createRemoteExecutor({
      secret: SECRET,
      maxConcurrency: 100,
      maxBatch: 100,
      idempotencyTtl: 30_000,
      onLog: (level, message, fields) => {
        if (level === "warn") {
          warnings.push([message, fields]);
        }
      },
      handlers: {
        work: () => {
          runs++;
        },
      },
    });
    // 33 batches of 100: 9,900 records, all held.
    const [first] = await batch(executor, 100);
    for (let index = 1; index < 33; index++) {
      await batch(executor, 100);
    }
    expect(warnings).toHaveLength(0);
    // Three more: past 10,000 within the TTL, so unexpired records go; one warning.
    for (let index = 0; index < 3; index++) {
      await batch(executor, 100);
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![0]).toContain("evicted");
    expect(warnings[0]![1]).toMatchObject({ capacity: 10_000 });
    // The consequence it warns of: the first attempt, redelivered, runs again.
    const before = runs;
    await read(
      await executor(
        await signedPost(URL, invoke([{ ...first!, delivery: 2 }])),
      ),
    );
    expect(runs).toBe(before + 1);
  });

  it("holds maxConcurrency × TTL at one attempt per slot per second, with no warning", async () => {
    const warnings: string[] = [];
    let runs = 0;
    // 3 × 200 × 120 s = 72,000 records; 24,000 attempts is that rate exactly.
    const executor = createRemoteExecutor({
      secret: SECRET,
      maxConcurrency: 200,
      maxBatch: 200,
      idempotencyTtl: 120_000,
      onLog: (level, message) => {
        if (level === "warn") {
          warnings.push(message);
        }
      },
      handlers: {
        work: () => {
          runs++;
        },
      },
    });
    const [first] = await batch(executor, 200);
    for (let index = 1; index < 120; index++) {
      await batch(executor, 200);
    }
    expect(runs).toBe(24_000);
    expect(warnings).toEqual([]);
    await read(
      await executor(
        await signedPost(URL, invoke([{ ...first!, delivery: 2 }])),
      ),
    );
    expect(runs).toBe(24_000);
  }, 60_000);

  it("the store reports an unexpired eviction once per burst, and never an expired one", () => {
    const reports: number[] = [];
    const store = createRemoteExecutorStore({
      max: 2,
      onEvict: (count) => reports.push(count),
    });
    const record = { kind: "fence", fence: "t:1" } as const;
    store.set("a", record, 100, 0);
    store.set("b", record, 100, 0);
    store.set("c", record, 100, 0); // evicts "a", unexpired: reported at once
    store.set("d", record, 100, 0); // evicts "b": inside the burst, held back
    expect(reports).toEqual([1]);
    // A minute on, everything held has expired: dropping it is not an eviction.
    const later = 60_001;
    store.set("e", record, later + 5_000, later);
    store.set("f", record, later + 5_000, later);
    expect(reports).toEqual([1]);
    store.set("g", record, later + 5_000, later); // evicts "e": a new burst
    expect(reports).toEqual([1, 2]); // "b", then "e"
  });

  it("sizes the default from maxConcurrency and the TTL, never under the floor", () => {
    expect(remoteExecutorStoreCapacity(64, 600_000)).toBe(115_200);
    expect(remoteExecutorStoreCapacity(200, 120_000)).toBe(72_000);
    expect(remoteExecutorStoreCapacity(100, 30_000)).toBe(10_000);
    expect(remoteExecutorStoreCapacity(1, 1)).toBe(10_000);
  });
});

describe("S3: a Request rebuilt from a used one (oven-sh/bun#44307)", () => {
  it("a declared body that reads as empty is a clear 500, not a misleading 401", async () => {
    const logs: string[] = [];
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {},
      onLog: (_level, message) => logs.push(message),
    });
    const original = await signedPost(URL, { v: 1, op: "ping", id: nextId() });
    const text = await original.text();
    const headers = new Headers(original.headers);
    headers.set(
      "content-length",
      String(new TextEncoder().encode(text).length),
    );
    const used = new Request(URL, { method: "POST", body: text, headers });
    await used.text();
    // Bun gives the copy bodyUsed false and an empty body.
    const rebuilt = new Request(used);
    expect(rebuilt.bodyUsed).toBe(false);
    const answer = await read(await executor(rebuilt));
    expect(answer).toMatchObject({
      status: 500,
      hasSignature: false,
      body: {
        code: "INTERNAL",
        detail: expect.stringContaining("44307"),
      },
    });
    expect(logs).toHaveLength(1);
  });

  it("the control: a declared empty body is not mistaken for one", async () => {
    const executor = createRemoteExecutor({ secret: SECRET, handlers: {} });
    const answer = await read(
      await executor(
        new Request(URL, {
          method: "POST",
          body: "",
          headers: { "content-length": "0" },
        }),
      ),
    );
    expect(answer).toMatchObject({
      status: 401,
      body: { code: "SIGNATURE_MISSING" },
    });
  });
});

describe("M-a: a joined attempt answers with the request's own job", () => {
  it("two jobs sharing one idempotency key each get an outcome under their own id", async () => {
    const held = gate();
    let started = 0;
    const base = createRemoteExecutorStore();
    /** Claims of attempt records: one when the second joins, two when it is answered from the store. */
    const claims: string[] = [];
    const store: RemoteExecutorStore = {
      ...base,
      update: (key, change, now) => {
        if (key.startsWith("a:")) {
          claims.push(key);
        }
        return base.update(key, change, now);
      },
    };
    const executor = createRemoteExecutor({
      secret: SECRET,
      store,
      handlers: {
        work: async () => {
          started++;
          await held.promise;
          return "done";
        },
      },
    });
    const first = job({ name: "work" });
    const second = job({ name: "work", idempotencyKey: first.idempotencyKey });
    const one = executor(await signedPost(URL, invoke([first])));
    await until(() => started === 1);
    const two = executor(await signedPost(URL, invoke([second])));
    // Long enough for the second to reach the attempt in progress; if it has
    // not, the claim count below fails the test rather than passing it.
    await Bun.sleep(500);
    held.open();
    const [a, b] = await Promise.all([read(await one), read(await two)]);
    expect(started).toBe(1);
    expect(claims).toHaveLength(1);
    expect(a.body.outcomes[0]).toMatchObject({ job: first.id, result: "done" });
    expect(b.body.outcomes[0]).toMatchObject({
      job: second.id,
      result: "done",
    });
  });
});

describe("M-b: a malformed fence", () => {
  it("is refused as VALIDATION and cannot reset fencing: newer, malformed, older is STALE_FENCE", async () => {
    let runs = 0;
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {
        work: () => {
          runs++;
        },
      },
    });
    const id = nextId("job");
    const claim = (attempt: number, fence: string) =>
      job({
        id,
        name: "work",
        attempt,
        idempotencyKey: `ns:q:${id}:${attempt}`,
        fence,
      });
    const send = async (sent: RemoteInvokeJob) =>
      read(await executor(await signedPost(URL, invoke([sent]))));
    expect((await send(claim(3, "newer:3000"))).body.outcomes[0].status).toBe(
      "completed",
    );
    const malformed = await send(claim(4, "no-claim-time"));
    expect(malformed).toMatchObject({
      status: 400,
      body: { code: "VALIDATION" },
    });
    expect(malformed.body.issues).toContainEqual(
      expect.objectContaining({ path: "jobs.0.fence" }),
    );
    expect((await send(claim(2, "older:2000"))).body.outcomes[0]).toMatchObject(
      {
        op: "rejected",
        code: "STALE_FENCE",
      },
    );
    expect(runs).toBe(1);
  });

  it("an unordered fence (one instant, two claims) runs, and does not replace the stored one", async () => {
    let runs = 0;
    const store = createRemoteExecutorStore();
    const executor = createRemoteExecutor({
      secret: SECRET,
      store,
      handlers: {
        work: () => {
          runs++;
        },
      },
    });
    const id = nextId("job");
    const claim = (attempt: number, fence: string) =>
      job({
        id,
        name: "work",
        attempt,
        idempotencyKey: `ns:q:${id}:${attempt}`,
        fence,
      });
    const send = async (sent: RemoteInvokeJob) => {
      const answer = await read(
        await executor(await signedPost(URL, invoke([sent]))),
      );
      return answer.body.outcomes[0];
    };
    await send(claim(1, "a:2000"));
    expect((await send(claim(2, "b:2000"))).status).toBe("completed");
    expect(runs).toBe(2);
    expect(
      await store.get(`f:${JSON.stringify(["ns", "q", id])}`, Date.now()),
    ).toEqual({ kind: "fence", fence: "a:2000" });
  });
});

describe("M-c: a failure after authentication", () => {
  it("is a signed 500 INTERNAL", async () => {
    const store = createRemoteExecutorStore();
    const throwing: RemoteExecutorStore = {
      ...store,
      get: () => {
        throw new Error("store down");
      },
    };
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {},
      store: throwing,
    });
    const answer = await read(
      await executor(
        await signedPost(URL, {
          v: 1,
          op: "status",
          id: nextId("status"),
          jobs: [{ queue: { ns: "ns", queue: "q" }, job: "j", attempt: 1 }],
        }),
      ),
    );
    expect(answer).toMatchObject({
      status: 500,
      signed: true,
      body: { code: "INTERNAL" },
    });
  });

  it("the control: before authentication it stays unsigned", async () => {
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {},
      nonces: {
        remember: () => {
          throw new Error("nonce store down");
        },
      },
    });
    const answer = await read(
      await executor(await signedPost(URL, { v: 1, op: "ping", id: nextId() })),
    );
    expect(answer).toMatchObject({
      status: 500,
      hasSignature: false,
      body: { code: "INTERNAL" },
    });
  });
});
