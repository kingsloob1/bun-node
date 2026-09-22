import type { MongoClient } from "mongodb";
import type { MongoClientLike } from "../lib/drivers/mongo/mongo-driver";
import type { QueueRef } from "../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { MongoDriver } from "../lib/drivers/mongo/mongo-driver";
import { BunQueue, BunQueueWorker } from "../lib/index";
import { queueEvent } from "../lib/shared/events";
import { makeJob, testNamespace, waitFor } from "./helpers";

/**
 * MongoDB driver fixes from the 2026-09-22 deep check, each beyond what the
 * shared contract can see.
 *
 * - **B9, read preference.** Every collection the driver reads is pinned to
 *   the primary, whatever the client it was handed prefers. A shared client
 *   reading secondaries would otherwise let `failJob` see a stale lock and
 *   lose a failure.
 * - **B10, a flow parent past 16 MB.** Every child's result lives on the
 *   parent document. When one would take it past MongoDB's limit the write
 *   fails the same way on every delivery, so the parent is buried with a
 *   reason saying so instead of waiting forever.
 * - **C6, settles and claims in fewer round trips.** A completion that removes
 *   the job is one conditional delete; `completeJobs` and `claimJobs` settle
 *   and take a burst with each job's own conditional write, sent together.
 * - **C17, one event poll per namespace.** Subscriptions share a single
 *   `find` per tick instead of one per channel, and still hear every event of
 *   their channel once, in order.
 *
 * ```bash
 * BUN_JOBS_TEST_MONGODB_URL=mongodb://127.0.0.1:27017/bun_jobs_test bun test fix-mongo
 * ```
 *
 * On the default collections, in namespaces of its own, each purged by name.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_MONGODB_URL;

/** Clients to close when the suite ends. */
const clients: MongoClient[] = [];
/** Drivers to close when the suite ends. */
const drivers: MongoDriver[] = [];
/** The exact namespaces this run created, to purge — never a prefix sweep. */
const namespaces = new Set<string>();

afterAll(async () => {
  const [driver] = drivers;
  if (driver) {
    for (const ns of namespaces) {
      await driver.purge(ns).catch(() => undefined);
    }
  }
  await Promise.allSettled(drivers.map((driver) => driver.close()));
  await Promise.allSettled(clients.map((client) => client.close()));
}, 30_000);

/** A queue in a namespace of this case's own, purged by name at the end. */
function scope(name: string, queue = "fix"): QueueRef {
  const ns = testNamespace(`mfix-${name}`);
  namespaces.add(ns);
  return { ns, queue };
}

/** A connected real client, closed when the suite ends. */
async function connectClient(url: string): Promise<MongoClient> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(url);
  await client.connect();
  clients.push(client);
  return client;
}

/** A driver on its own client, closed when the suite ends. */
function makeDriver(): MongoDriver {
  const driver = new MongoDriver({ url: URL! });
  drivers.push(driver);
  return driver;
}

/** A collection handle as the real driver returns it, for its read preference. */
interface CollectionHandle {
  /** The collection's resolved read preference. */
  readPreference?: { mode: string };
}

describe.skipIf(!URL)("MongoDriver fixes (B9: read preference)", () => {
  it("reads every collection from the primary, whatever the shared client prefers", async () => {
    const url = new globalThis.URL(URL!);
    url.searchParams.set("readPreference", "secondaryPreferred");
    const real = await connectClient(url.toString());

    /** Every collection handle the driver obtained, by name. */
    const obtained: { name: string; handle: CollectionHandle }[] = [];

    // The client as the application would share it, with `db().collection()`
    // recorded on the way through.
    const shared = new Proxy(real, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (property !== "db") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...args: Parameters<MongoClient["db"]>) => {
          const db = target.db(...args);
          return new Proxy(db, {
            get(dbTarget, dbProperty) {
              const member: unknown = Reflect.get(
                dbTarget,
                dbProperty,
                dbTarget,
              );
              if (dbProperty !== "collection" || typeof member !== "function") {
                return typeof member === "function"
                  ? member.bind(dbTarget)
                  : member;
              }
              return (name: string, ...rest: unknown[]) => {
                const handle = (
                  member as (...a: unknown[]) => CollectionHandle
                ).call(dbTarget, name, ...rest);
                obtained.push({ name, handle });
                return handle;
              };
            },
          });
        };
      },
    }) as unknown as MongoClientLike;

    // The client's own preference really is secondaries: the control.
    expect(real.db().collection("anything").readPreference?.mode).toBe(
      "secondaryPreferred",
    );

    const driver = new MongoDriver({ url: URL!, client: shared });
    drivers.push(driver);
    const q = scope("readpref");
    const now = Date.now();

    await driver.addJob(q, makeJob({ id: "a", createdAt: now }));
    const claimed = await driver.claimJob(q, {
      now,
      token: "t",
      lockMs: 30_000,
      workerId: "w",
    });
    expect(claimed?.id).toBe("a");
    expect(
      await driver.failJob(
        q,
        "a",
        "t",
        { name: "Error", message: "boom" },
        { retry: false, retention: false },
        now,
        5,
      ),
    ).toBe(true);
    await driver.getJob(q, "a");

    const jobs = obtained.filter(
      ({ name }) => name === driver.collections.jobs,
    );
    expect(jobs.length).toBeGreaterThan(0);
    for (const { name, handle } of obtained) {
      expect({ name, mode: handle.readPreference?.mode }).toEqual({
        name,
        mode: "primary",
      });
    }
  });
});

/** A value whose JSON is `bytes` long, give or take the quotes. */
function valueOf(bytes: number): string {
  return "x".repeat(bytes);
}

/** A parent waiting on two children in queue `c`. */
function parentOf(id: string, state: "waiting-children" | "dead") {
  return makeJob({
    id,
    state,
    flow: {
      parent: null,
      children: [
        { queue: "c", id: "c1" },
        { queue: "c", id: "c2" },
      ],
      pending: 2,
      values: {},
      failures: {},
      recorded: false,
    },
  });
}

describe.skipIf(!URL)("MongoDriver fixes (B10: flow parent past 16 MB)", () => {
  it("buries the parent, saying why, when a child's result would take it past 16 MB", async () => {
    const driver = makeDriver();
    const q = scope("toolarge", "p");
    const now = Date.now();
    await driver.addJob(q, parentOf("p", "waiting-children"));

    // 9 MB fits; a second 9 MB does not.
    expect(
      await driver.recordChild(
        q,
        "p",
        { queue: "c", id: "c1" },
        { completed: true, value: valueOf(9_000_000) },
        now,
      ),
    ).toBe("recorded");
    expect(
      await driver.recordChild(
        q,
        "p",
        { queue: "c", id: "c2" },
        { completed: true, value: valueOf(9_000_000) },
        now,
      ),
    ).toBe("buried");

    const parent = await driver.getJob(q, "p");
    expect(parent?.state).toBe("dead");
    expect(parent?.finishedOn).toBe(now);
    expect(parent?.failedReason).toMatchObject({
      name: "ChildFailedError",
      code: "CHILD_FAILED",
      data: {
        child: "c:c2",
        context: { limit: "16MB", cause: expect.stringContaining("16 MB") },
      },
    });
    // The driver's own frames say nothing to whoever reads the reason.
    expect(parent?.failedReason?.stack).toBeUndefined();
    expect(parent?.failedReason?.message).toContain("16 MB document limit");
    // The first child's value is kept; the one that did not fit is not.
    expect(Object.keys(parent?.flow?.values ?? {})).toEqual(["c:c1"]);

    // A repeat of the delivery is refused on the dead parent, storing nothing.
    expect(
      await driver.recordChild(
        q,
        "p",
        { queue: "c", id: "c2" },
        { completed: true, value: valueOf(9_000_000) },
        now,
      ),
    ).toBe("parent-dead");
  });

  it("answers parent-dead, storing nothing, when a dead parent cannot keep a result for its retry", async () => {
    const driver = makeDriver();
    const q = scope("toolarge-dead", "p");
    const now = Date.now();
    await driver.addJob(q, parentOf("p", "dead"));

    expect(
      await driver.recordChild(
        q,
        "p",
        { queue: "c", id: "c1" },
        { completed: true, value: valueOf(9_000_000) },
        now,
      ),
    ).toBe("recorded");
    expect(
      await driver.recordChild(
        q,
        "p",
        { queue: "c", id: "c2" },
        { completed: true, value: valueOf(9_000_000) },
        now,
      ),
    ).toBe("parent-dead");
    const parent = await driver.getJob(q, "p");
    expect(Object.keys(parent?.flow?.values ?? {})).toEqual(["c:c1"]);
  });

  it("ends the flow through the worker: the parent fails with the reason, and delivery does not loop", async () => {
    const driver = makeDriver();
    const namespace = testNamespace("mfix-flowworker");
    namespaces.add(namespace);

    let deliveries = 0;
    const recordChild = driver.recordChild.bind(driver);
    driver.recordChild = async (...args) => {
      deliveries++;
      return await recordChild(...args);
    };

    const queue = new BunQueue("reports", {
      namespace,
      driver,
      logger: noopLogger,
      subscribe: false,
      defaultJobOptions: { removeOnComplete: false },
    });
    const workers = [
      new BunQueueWorker("reports", async () => "never", {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        stalledInterval: 20,
        waitToExit: false,
        publish: false,
      }),
      new BunQueueWorker("fetch", async () => valueOf(9_000_000), {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        stalledInterval: 20,
        waitToExit: false,
        publish: false,
      }),
    ];

    try {
      const flow = await queue.addFlow({
        name: "report",
        data: {},
        children: [
          { name: "a", data: {}, queue: "fetch" },
          { name: "b", data: {}, queue: "fetch" },
        ],
      });
      for (const worker of workers) {
        void worker.run();
      }

      await waitFor(
        async () =>
          (
            await driver.getJob(
              { ns: namespace, queue: "reports" },
              flow.job.id,
            )
          )?.state === "dead",
        { timeout: 10_000 },
      );
      const parent = await driver.getJob(
        { ns: namespace, queue: "reports" },
        flow.job.id,
      );
      expect(parent?.failedReason?.message).toContain("16 MB document limit");

      // Deliveries die down and stop. Redundant ones are expected meanwhile:
      // with multi-megabyte documents each read is slow, so maintenance (every
      // 20ms) and the completion itself deliver from reads taken before the
      // child was marked, and each answers "already" or "parent-dead". What
      // must not happen is what happened before the fix: every pass delivering
      // the result that did not fit, failing the same way, forever — with the
      // parent never leaving `waiting-children`.
      expect(deliveries).toBeGreaterThan(0);
      let seen = -1;
      let quietSince = Date.now();
      await waitFor(
        () => {
          if (deliveries !== seen) {
            seen = deliveries;
            quietSince = Date.now();
          }
          return Date.now() - quietSince >= 1_500;
        },
        {
          timeout: 20_000,
          interval: 50,
          message: () => `still delivering: ${deliveries} so far`,
        },
      );
    } finally {
      for (const worker of workers) {
        await worker.close({ force: true }).catch(() => undefined);
      }
      await queue.close().catch(() => undefined);
    }
  }, 60_000);
});

/** Every command a driver sends, by name, from a monitored client. */
async function monitoredDriver(): Promise<{
  driver: MongoDriver;
  commands: string[];
}> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(URL!, { monitorCommands: true });
  clients.push(client);
  const commands: string[] = [];
  client.on("commandStarted", (event) => commands.push(event.commandName));
  const driver = new MongoDriver({
    url: URL!,
    client: client as unknown as MongoClientLike,
  });
  drivers.push(driver);
  await driver.connect();
  return { driver, commands };
}

/** Claim options under `token`, at `now`. */
function claimAt(now: number, token = "tok") {
  return { now, token, lockMs: 60_000, workerId: `w-${token}` };
}

describe.skipIf(!URL)("MongoDriver fixes (C6: settle and claim)", () => {
  it("completes a job it removes with one conditional delete", async () => {
    const { driver, commands } = await monitoredDriver();
    const q = scope("remove-one");
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "a", createdAt: now }));
    await driver.addJob(
      q,
      makeJob({ id: "b", createdAt: now + 1, runAt: now }),
    );
    await driver.claimJob(q, claimAt(now));
    await driver.claimJob(q, claimAt(now, "other"));

    commands.length = 0;
    expect(await driver.completeJob(q, "a", "tok", 1, true, now)).toBe(true);
    expect(commands).toEqual(["delete"]);
    expect(await driver.getJob(q, "a")).toBeNull();

    // Not the holder: nothing removed, and `false`, as before.
    expect(await driver.completeJob(q, "b", "tok", 1, true, now)).toBe(false);
    expect((await driver.getJob(q, "b"))?.state).toBe("active");
  });

  it("completes a burst: each job by its own retention, and none it no longer holds", async () => {
    const driver = makeDriver();
    const q = scope("burst");
    const now = Date.now();
    await driver.addJobs(
      q,
      ["a", "b", "c", "lost"].map((id, index) =>
        makeJob({ id, createdAt: now + index, runAt: now }),
      ),
    );
    expect(
      (await driver.claimJobs!(q, claimAt(now), 3)).map((job) => job.id),
    ).toEqual(["a", "b", "c"]);
    await driver.claimJob(q, claimAt(now, "other"));

    const settled = await driver.completeJobs!(
      q,
      "tok",
      [
        { id: "a", result: "A", retention: true },
        { id: "b", result: "B", retention: false },
        { id: "c", result: "C", retention: { ttl: 5_000 } },
        { id: "lost", result: "X", retention: false },
      ],
      now,
    );

    expect(settled.sort()).toEqual(["a", "b", "c"]);
    expect(await driver.getJob(q, "a")).toBeNull();
    expect(await driver.getJob(q, "b")).toMatchObject({
      state: "completed",
      returnValue: "B",
      finishedOn: now,
      expiresAt: null,
      lockToken: null,
    });
    expect(await driver.getJob(q, "c")).toMatchObject({
      state: "completed",
      returnValue: "C",
      expiresAt: now + 5_000,
    });
    expect((await driver.getJob(q, "lost"))?.state).toBe("active");
  });

  it("applies a burst's count retention once, keeping the cap", async () => {
    const driver = makeDriver();
    const q = scope("burst-count");
    const now = Date.now();
    const ids = ["a", "b", "c", "d"];
    await driver.addJobs(
      q,
      ids.map((id, index) =>
        makeJob({ id, createdAt: now + index, runAt: now }),
      ),
    );
    await driver.claimJobs!(q, claimAt(now), 4);

    const settled = await driver.completeJobs!(
      q,
      "tok",
      ids.map((id) => ({ id, result: id, retention: 2 })),
      now,
    );

    expect(settled.sort()).toEqual(ids);
    const kept = await driver.listJobs(q, ["completed"], {
      offset: 0,
      limit: 10,
      order: "desc",
    });
    // Equal `finishedOn`, so `_id` breaks the tie: the two highest are kept.
    expect(kept.map((job) => job.id)).toEqual(["d", "c"]);
  });

  it("claims a batch in claim order, each job exactly once across racing claimers", async () => {
    const one = makeDriver();
    const two = makeDriver();
    const q = scope("claim-race");
    const now = Date.now();
    const total = 40;
    /** One of the backlog's jobs, its priority cycling through three. */
    const backlogJob = (index: number) =>
      makeJob({
        id: `j${String(index).padStart(2, "0")}`,
        priority: index % 3,
        createdAt: now + index,
        runAt: now,
      });
    await one.addJobs(
      q,
      Array.from({ length: total }, (_, index) => backlogJob(index)),
    );

    const taken: string[] = [];
    const race = async (driver: MongoDriver, token: string) => {
      for (;;) {
        const batch = await driver.claimJobs!(q, claimAt(now, token), 7);
        if (batch.length === 0) {
          return;
        }
        // Claim order within every batch: priority, then createdAt, then id.
        const ordered = [...batch].sort(
          (a, b) => a.priority - b.priority || a.createdAt - b.createdAt,
        );
        expect(batch.map((job) => job.id)).toEqual(
          ordered.map((job) => job.id),
        );
        for (const job of batch) {
          expect(job).toMatchObject({ state: "active", lockToken: token });
        }
        taken.push(...batch.map((job) => job.id));
      }
    };
    await Promise.all([race(one, "one"), race(two, "two")]);

    expect(taken.length).toBe(total);
    expect(new Set(taken).size).toBe(total);
  });

  it("claims nothing from a paused queue", async () => {
    const driver = makeDriver();
    const q = scope("claim-paused");
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "a", createdAt: now }));
    await driver.pauseQueue(q);
    expect(await driver.claimJobs!(q, claimAt(now), 5)).toEqual([]);
    await driver.resumeQueue(q);
    expect(
      (await driver.claimJobs!(q, claimAt(now), 5)).map((job) => job.id),
    ).toEqual(["a"]);
  });
});

/** A driver whose event finds are counted, polling every `poll` ms. */
async function countingDriver(poll: number): Promise<{
  driver: MongoDriver;
  finds: () => number;
  reset: () => void;
}> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(URL!, { monitorCommands: true });
  clients.push(client);
  let finds = 0;
  client.on("commandStarted", (event) => {
    if (
      event.commandName === "find" &&
      String(event.command.find).endsWith("events")
    ) {
      finds++;
    }
  });
  const driver = new MongoDriver({
    url: URL!,
    client: client as unknown as MongoClientLike,
    pollInterval: poll,
  });
  drivers.push(driver);
  await driver.connect();
  return {
    driver,
    finds: () => finds,
    reset: () => {
      finds = 0;
    },
  };
}

/** An event on queue `target`, carrying `n`. */
function numbered(ns: string, target: string, n: number) {
  return queueEvent({ ns, target, type: "added", origin: "fix-mongo" }, {
    id: `e${n}`,
    n,
  } as never);
}

/** The `n` an event carries. */
function numberOf(event: unknown): number {
  return (event as { payload: { n: number } }).payload.n;
}

describe.skipIf(!URL)(
  "MongoDriver fixes (C17: one event poll per namespace)",
  () => {
    it("polls a namespace once per tick however many channels it follows", async () => {
      const { driver, finds, reset } = await countingDriver(50);
      const ns = scope("poll-count").ns;
      const stops: (() => Promise<void>)[] = [];
      for (let channel = 0; channel < 10; channel++) {
        stops.push(
          await driver.subscribe(ns, "queue", `q${channel}`, () => {}),
        );
      }

      await Bun.sleep(200);
      reset();
      await Bun.sleep(1_000);
      // About 20 ticks, plus a probe every 20: one poll per channel was ~200.
      expect(finds()).toBeLessThanOrEqual(30);
      expect(finds()).toBeGreaterThan(5);

      for (const stop of stops) {
        await stop();
      }
      // The last unsubscribe stops the poll.
      await Bun.sleep(100);
      reset();
      await Bun.sleep(300);
      expect(finds()).toBe(0);
    });

    it("delivers each channel's events once and in order, to every subscriber of it", async () => {
      const { driver } = await countingDriver(20);
      const publisher = makeDriver();
      const ns = scope("poll-order").ns;
      const heard = new Map<string, number[]>();
      const listen = (name: string) => (event: unknown) => {
        heard.set(name, [...(heard.get(name) ?? []), numberOf(event)]);
      };

      await driver.subscribe(ns, "queue", "a", listen("a1"));
      await driver.subscribe(ns, "queue", "a", listen("a2"));
      await driver.subscribe(ns, "queue", "b", listen("b"));
      // A listener that throws costs the others nothing.
      await driver.subscribe(ns, "queue", "b", () => {
        throw new Error("listener failure");
      });

      const sent = { a: [] as number[], b: [] as number[] };
      for (let n = 0; n < 60; n++) {
        const target = n % 3 === 0 ? "b" : "a";
        sent[target].push(n);
        await publisher.publish(numbered(ns, target, n));
      }

      await waitFor(
        () =>
          (heard.get("a1")?.length ?? 0) === sent.a.length &&
          (heard.get("a2")?.length ?? 0) === sent.a.length &&
          (heard.get("b")?.length ?? 0) === sent.b.length,
        { timeout: 5_000 },
      );
      await Bun.sleep(150);
      expect(heard.get("a1")).toEqual(sent.a);
      expect(heard.get("a2")).toEqual(sent.a);
      expect(heard.get("b")).toEqual(sent.b);
    });

    it("tells a later subscriber of a followed channel only what comes after it", async () => {
      const { driver } = await countingDriver(20);
      const publisher = makeDriver();
      const ns = scope("poll-late").ns;
      const early: number[] = [];
      const late: number[] = [];

      await driver.subscribe(ns, "queue", "a", (event) => {
        early.push(numberOf(event));
      });
      await publisher.publish(numbered(ns, "a", 1));
      await waitFor(() => early.length === 1, { timeout: 5_000 });

      await driver.subscribe(ns, "queue", "a", (event) => {
        late.push(numberOf(event));
      });
      await publisher.publish(numbered(ns, "a", 2));
      await waitFor(() => early.length === 2 && late.length === 1, {
        timeout: 5_000,
      });
      expect(early).toEqual([1, 2]);
      expect(late).toEqual([2]);
    });

    it("gets past a run of numbers longer than a poll's window with no event behind them", async () => {
      const { driver } = await countingDriver(10);
      const publisher = makeDriver();
      const ns = scope("poll-jump").ns;
      const heard: number[] = [];
      await driver.subscribe(ns, "queue", "a", (event) => {
        heard.push(numberOf(event));
      });

      await publisher.publish(numbered(ns, "a", 1));
      await waitFor(() => heard.length === 1, { timeout: 5_000 });

      // 300 numbers taken and never written, as publishes whose insert failed
      // leave them.
      const client = await connectClient(URL!);
      await client
        .db()
        .collection<{ _id: string }>(publisher.collections.kv)
        .updateOne(
          { _id: `${ns}:__events_seq:queue:a` },
          { $inc: { "counters.seq": 300 } },
        );

      await publisher.publish(numbered(ns, "a", 2));
      await waitFor(() => heard.length === 2, { timeout: 5_000 });
      expect(heard).toEqual([1, 2]);
    });

    it("stops polling when the driver closes", async () => {
      const { driver, finds, reset } = await countingDriver(20);
      const ns = scope("poll-close").ns;
      await driver.subscribe(ns, "queue", "a", () => {});
      await Bun.sleep(100);
      expect(finds()).toBeGreaterThan(0);

      await driver.close();
      await Bun.sleep(50);
      reset();
      await Bun.sleep(200);
      expect(finds()).toBe(0);
    });
  },
);
