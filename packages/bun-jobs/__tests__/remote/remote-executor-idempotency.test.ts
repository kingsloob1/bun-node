import type {
  RemoteExecutorRecord,
  RemoteExecutorStore,
  RemoteInvokeJob,
} from "../../lib/remote";
import { describe, expect, it } from "bun:test";
import {
  createRemoteExecutor,
  createRemoteExecutorStore,
} from "../../lib/remote";
import { compareFences } from "../../lib/remote/executor/executor";
import { ConfigError } from "../../lib/shared/errors";
import {
  gate,
  invoke,
  job,
  nextId,
  read,
  SECRET,
  served,
  signedPost,
  until,
} from "../helpers/remoteExecutor";

/**
 * Idempotency and fencing (`worker-runtimes.md` §5.8, `remote-transports.md`
 * §4.9): a redelivered attempt is answered from the store rather than run
 * again, and an attempt from an older claim is refused `STALE_FENCE`. Each
 * mechanism has a control that turns it off and shows the double run it
 * prevents, so a test passing proves the mechanism and not the setup.
 */

const URL = "http://executor.test/";

/** An executor whose one handler counts its runs, optionally held on a gate. */
function counting(
  options: {
    idempotencyTtl?: number;
    store?: RemoteExecutorStore;
    hold?: Promise<void>;
    maxBatch?: number;
  } = {},
) {
  const runs: string[] = [];
  const executor = createRemoteExecutor({
    secret: SECRET,
    maxBatch: options.maxBatch ?? 4,
    idempotencyTtl: options.idempotencyTtl,
    store: options.store,
    handlers: {
      work: async (job) => {
        runs.push(`${job.id}#${job.attemptsMade}`);
        await options.hold;
        return { run: runs.length };
      },
    },
  });
  const send = async (jobs: RemoteInvokeJob[], queue = "q") =>
    (await read(await executor(await signedPost(URL, invoke(jobs, { queue })))))
      .body;
  return { executor, runs, send };
}

/** The same attempt, redelivered: a fresh envelope, the same key, `delivery + 1`. */
function redeliver(original: RemoteInvokeJob): RemoteInvokeJob {
  return { ...original, delivery: original.delivery + 1 };
}

describe("idempotency", () => {
  it("a re-POSTed attempt is answered from the store and runs once", async () => {
    const { runs, send } = counting();
    const one = job({ name: "work" });
    const first = await send([one]);
    const second = await send([redeliver(one)]);
    expect(runs).toEqual([`${one.id}#1`]);
    expect(second.outcomes).toEqual(first.outcomes);
    expect(second.outcomes[0]).toMatchObject({
      status: "completed",
      result: { run: 1 },
    });
  });

  it("the control: with idempotency off, the same re-POST runs it twice", async () => {
    const { runs, send } = counting({ idempotencyTtl: 0 });
    const one = job({ name: "work" });
    await send([one]);
    const second = await send([redeliver(one)]);
    expect(runs).toEqual([`${one.id}#1`, `${one.id}#1`]);
    expect(second.outcomes[0].result).toEqual({ run: 2 });
  });

  it("the mutation check: a store that forgets everything runs it twice", async () => {
    const forgetful: RemoteExecutorStore = {
      get: () => undefined,
      set: () => {},
      update: () => undefined,
    };
    const { runs, send } = counting({ store: forgetful });
    const one = job({ name: "work" });
    await send([one]);
    await send([redeliver(one)]);
    expect(runs).toHaveLength(2);
  });

  it("a new attempt of the same job is a new key, and runs", async () => {
    const { runs, send } = counting();
    const first = job({ name: "work" });
    await send([first]);
    const second = job({
      ...first,
      attempt: 2,
      idempotencyKey: `ns:q:${first.id}:2`,
      fence: `token-${first.id}-b:2000`,
    });
    await send([second]);
    expect(runs).toEqual([`${first.id}#1`, `${first.id}#2`]);
  });

  it("a redelivery while the attempt is running here joins it: one run, one outcome", async () => {
    const held = gate();
    const { runs, executor } = counting({ hold: held.promise });
    const one = job({ name: "work" });
    const firstCall = executor(await signedPost(URL, invoke([one])));
    await until(() => runs.length === 1);
    const secondCall = executor(
      await signedPost(URL, invoke([redeliver(one)])),
    );
    // The redelivery holds no slot of its own.
    const pong = await read(
      await executor(await signedPost(URL, { v: 1, op: "ping", id: nextId() })),
    );
    expect(pong.body.capacity.inFlight).toBe(1);
    held.open();
    const [first, second] = await Promise.all([
      read(await firstCall),
      read(await secondCall),
    ]);
    expect(runs).toHaveLength(1);
    expect(second.body.outcomes).toEqual(first.body.outcomes);
  });

  it("a shared store: running on one instance is DUPLICATE_RUNNING on another, then answered from the store", async () => {
    const store = createRemoteExecutorStore();
    const held = gate();
    const a = counting({ store, hold: held.promise });
    const b = counting({ store });
    const one = job({ name: "work" });
    const onA = a.send([one]);
    await until(() => a.runs.length === 1);
    const duplicate = await b.send([redeliver(one)]);
    expect(duplicate.outcomes[0]).toMatchObject({
      op: "rejected",
      code: "DUPLICATE_RUNNING",
      retryAfterMs: 1_000,
    });
    held.open();
    const answered = await onA;
    const later = await b.send([redeliver(redeliver(one))]);
    expect(later.outcomes).toEqual(answered.outcomes);
    expect(a.runs).toHaveLength(1);
    expect(b.runs).toHaveLength(0);
  });

  it("the control: two instances with their own stores both run it", async () => {
    const a = counting();
    const b = counting();
    const one = job({ name: "work" });
    await a.send([one]);
    await b.send([redeliver(one)]);
    expect(a.runs.length + b.runs.length).toBe(2);
  });

  it("over HTTP too: a re-POST through Bun.serve runs once", async () => {
    const { executor, runs } = counting();
    const transport = served(executor);
    try {
      const one = job({ name: "work" });
      const post = async (sent: RemoteInvokeJob) =>
        (
          await read(
            await transport.send(
              await signedPost(transport.url, invoke([sent])),
            ),
          )
        ).body;
      const first = await post(one);
      const second = await post(redeliver(one));
      expect(second.outcomes).toEqual(first.outcomes);
      expect(runs).toHaveLength(1);
    } finally {
      await transport.close();
    }
  });

  it("a store that throws refuses the job as BUSY, without running it, and logs why", async () => {
    const logs: string[] = [];
    let runs = 0;
    const executor = createRemoteExecutor({
      secret: SECRET,
      onLog: (level, message) => logs.push(`${level}: ${message}`),
      store: {
        get: () => undefined,
        set: () => {},
        update: () => {
          throw new Error("kv unreachable");
        },
      },
      handlers: {
        work: () => {
          runs++;
        },
      },
    });
    const answer = await read(
      await executor(await signedPost(URL, invoke([job({ name: "work" })]))),
    );
    expect(answer.body.outcomes[0]).toMatchObject({
      op: "rejected",
      code: "BUSY",
    });
    expect(runs).toBe(0);
    expect(logs[0]).toStartWith("error: The remote executor's store failed");
    expect(answer.body.capacity.inFlight).toBe(0);
  });

  it("the canary is never remembered: two with one key both run", async () => {
    const store = createRemoteExecutorStore();
    const writes: string[] = [];
    const watched: RemoteExecutorStore = {
      get: store.get,
      set: (key, ...rest) => {
        writes.push(key);
        return store.set(key, ...rest);
      },
      update: (key, ...rest) => {
        writes.push(key);
        return store.update(key, ...rest);
      },
    };
    const executor = createRemoteExecutor({
      secret: SECRET,
      store: watched,
      handlers: {},
    });
    const canary = job({
      name: "bun-jobs:canary",
      data: { nonce: "n", steps: 0 },
      idempotencyKey: "canary:s:1",
    });
    for (let index = 0; index < 2; index++) {
      const answer = await read(
        await executor(await signedPost(URL, invoke([canary]))),
      );
      expect(answer.body.outcomes[0]).toMatchObject({ status: "completed" });
    }
    expect(writes).toEqual([]);
  });
});

describe("fencing", () => {
  /** Attempt `attempt` of `id`, claimed at `at` with `token`. */
  function claim(id: string, attempt: number, token: string, at: number) {
    return job({
      id,
      name: "work",
      attempt,
      idempotencyKey: `ns:q:${id}:${attempt}`,
      fence: `${token}:${at}`,
    });
  }

  it("an attempt from an older claim than one seen is rejected STALE_FENCE, and does not run", async () => {
    const { runs, send } = counting();
    const id = nextId("job");
    await send([claim(id, 2, "newer", 2_000)]);
    const stale = await send([claim(id, 1, "older", 1_000)]);
    expect(stale.outcomes[0]).toEqual({
      op: "rejected",
      job: id,
      attempt: 1,
      fence: "older:1000",
      code: "STALE_FENCE",
    });
    expect(runs).toEqual([`${id}#2`]);
  });

  it("the control: with fencing off, the same older claim runs", async () => {
    const { runs, send } = counting({ idempotencyTtl: 0 });
    const id = nextId("job");
    await send([claim(id, 2, "newer", 2_000)]);
    const stale = await send([claim(id, 1, "older", 1_000)]);
    expect(stale.outcomes[0].status).toBe("completed");
    expect(runs).toEqual([`${id}#2`, `${id}#1`]);
  });

  it("a redelivery of the stale claim's own attempt is refused too, even with an outcome stored", async () => {
    const { runs, send } = counting();
    const id = nextId("job");
    const old = claim(id, 1, "older", 1_000);
    await send([old]);
    await send([claim(id, 2, "newer", 2_000)]);
    const again = await send([redeliver(old)]);
    expect(again.outcomes[0]).toMatchObject({ code: "STALE_FENCE" });
    expect(runs).toHaveLength(2);
  });

  it("a newer claim after an older one runs: fences only ever move forward", async () => {
    const { runs, send } = counting();
    const id = nextId("job");
    await send([claim(id, 1, "a", 1_000)]);
    await send([claim(id, 2, "b", 2_000)]);
    await send([claim(id, 3, "c", 3_000)]);
    expect(runs).toHaveLength(3);
    const stale = await send([claim(id, 4, "d", 2_500)]);
    expect(stale.outcomes[0].code).toBe("STALE_FENCE");
  });

  it("the same job id in another queue is another job: its fences do not interfere", async () => {
    const { runs, send } = counting();
    const id = nextId("job");
    await send([claim(id, 2, "newer", 2_000)], "q");
    const elsewhere = await send([claim(id, 1, "older", 1_000)], "other-queue");
    expect(elsewhere.outcomes[0].status).toBe("completed");
    expect(runs).toHaveLength(2);
  });

  it("fences it cannot order are not refused", async () => {
    const { runs, send } = counting();
    const id = nextId("job");
    await send([{ ...claim(id, 1, "x", 1), fence: "opaque-b" }]);
    await send([{ ...claim(id, 2, "x", 1), fence: "opaque-a" }]);
    expect(runs).toHaveLength(2);
  });

  it("orders fences by claim time, and only when it can", () => {
    expect(compareFences("a:1000", "b:2000")).toBeLessThan(0);
    expect(compareFences("b:2000", "a:1000")).toBeGreaterThan(0);
    expect(compareFences("a:1000", "a:1000")).toBe(0);
    expect(compareFences("tok:with:colons:5", "t:4")).toBeGreaterThan(0);
    // Two claims at one instant, or a fence of another shape: not ordered.
    expect(compareFences("a:1000", "b:1000")).toBeUndefined();
    expect(compareFences("opaque", "a:1000")).toBeUndefined();
    expect(compareFences(":1000", "a:1")).toBeUndefined();
  });
});

describe("the in-memory store", () => {
  const record: RemoteExecutorRecord = { kind: "fence", fence: "t:1" };

  it("forgets a record at its expiry", () => {
    const store = createRemoteExecutorStore();
    store.set("k", record, 1_000, 0);
    expect(store.get("k", 999)).toEqual(record);
    expect(store.get("k", 1_000)).toBeUndefined();
  });

  it("update resolves what was there before, and null leaves it", () => {
    const store = createRemoteExecutorStore();
    expect(
      store.update("k", () => ({ record, expiresAt: 100 }), 0),
    ).toBeUndefined();
    expect(store.update("k", () => null, 1)).toEqual(record);
    expect(store.get("k", 2)).toEqual(record);
    const next: RemoteExecutorRecord = { kind: "fence", fence: "t:2" };
    expect(
      store.update("k", () => ({ record: next, expiresAt: 100 }), 3),
    ).toEqual(record);
    expect(store.get("k", 4)).toEqual(next);
  });

  it("holds at most max, forgetting the oldest write first", () => {
    const store = createRemoteExecutorStore({ max: 2 });
    store.set("a", record, 100, 0);
    store.set("b", record, 100, 0);
    store.set("a", record, 100, 0); // rewritten: now the newest
    store.set("c", record, 100, 0);
    expect(store.get("b", 1)).toBeUndefined();
    expect(store.get("a", 1)).toEqual(record);
    expect(store.get("c", 1)).toEqual(record);
  });

  it("refuses a max that is not a positive integer", () => {
    expect(() => createRemoteExecutorStore({ max: 0 })).toThrow(ConfigError);
  });
});
