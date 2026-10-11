import type { JobsDriver, SummonOption, SummonPolicy } from "../lib/index";
import { join } from "node:path";
import { createDeferred, noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
  spyOn,
} from "bun:test";
import {
  BunJobs,
  BunQueue,
  createDriver,
  JobsClosedError,
  JobsNotifier,
  QueueClosedError,
  SummonController,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * A `BunJobs` builds nothing that its `close()` will not close. `close()`
 * closes each kind of thing from a list it takes as it reaches that kind —
 * summon controllers first, then notifiers, then runners and workers, then
 * queues — so each kind is refused, with `JobsClosedError`, from the moment
 * its list is taken: a summon controller from the call to `close()` on, a
 * queue only once the workers have finished. A job still running while the
 * workers close can therefore still add jobs, and the queue it adds to is
 * closed with the rest.
 *
 * On SQLite (summoning needs a backend another process can reach), with the
 * driver passed in, so it stays open after the context closes and anything
 * the context left running would still act on it.
 */

setDefaultTimeout(30_000);

const tmp = await makeTmpDir("bun-jobs-closed");
afterAll(async () => await tmp.cleanup());

const HANDLER = join(import.meta.dir, "fixtures", "handlers", "echo.ts");

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

/** Triggers off but a 20 ms poll, so a live controller reads demand at once. */
const POLLING: Partial<SummonPolicy> = {
  triggers: { onAdd: false, events: false, poll: 20 },
  cooldown: 0,
  backoff: { initial: 1, max: 1 },
};

/**
 * A SQLite driver whose `countDemand` calls — one per summon check — are
 * counted, and the context's namespace; purged and closed after the test.
 * `holdConnect()` holds the next `connect()` until the function it returns
 * is called.
 */
function setup(): {
  driver: JobsDriver;
  namespace: string;
  checks: () => number;
  holdConnect: () => () => void;
} {
  const inner = createDriver({
    type: "sql",
    url: `sqlite://${join(tmp.path, "jobs.db")}`,
  });
  const namespace = testNamespace("jobs-closed");
  let checks = 0;
  let held: Promise<void> | undefined;
  const driver = new Proxy(inner, {
    get(target, property) {
      if (property === "connect" && held !== undefined) {
        const gate = held;
        held = undefined;
        return async () => {
          await gate;
          await target.connect();
        };
      }
      if (property === "countDemand") {
        return async (
          ...args: Parameters<NonNullable<JobsDriver["countDemand"]>>
        ) => {
          checks++;
          return await target.countDemand!(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  perTest.push(async () => {
    await inner.purge(namespace).catch(() => {});
    await inner.close();
  });
  const holdConnect = (): (() => void) => {
    const gate = createDeferred<void>();
    held = gate.promise;
    return () => gate.resolve();
  };
  return { driver, namespace, checks: () => checks, holdConnect };
}

/** A policy that summons nothing, polling every 20 ms. */
function policy(extra?: Partial<SummonPolicy>): SummonPolicy {
  return { summoner: async () => {}, ...POLLING, ...extra };
}

/** The summon option of every test: a per-queue controller and a shared unit. */
function summonOption(): SummonOption {
  return [
    { queues: ["mail"], ...policy() },
    {
      queues: ["renders", "thumbs"],
      ...policy(),
      group: { name: "media", unit: "shared" },
    },
  ];
}

/** A context on `driver`, closed after the test whatever it left open. */
function context(driver: JobsDriver, namespace: string): BunJobs {
  const jobs = new BunJobs({
    namespace,
    driver,
    logger: noopLogger,
    summon: summonOption(),
  });
  perTest.unshift(async () => await jobs.close());
  return jobs;
}

/** What `fn` throws (or rejects with), or `undefined`. */
async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Asserts `error` is the context's refusal, naming the method. */
function expectRefused(error: unknown, namespace: string, method: string) {
  expect(error).toBeInstanceOf(JobsClosedError);
  expect(error).toMatchObject({
    code: "JOBS_CLOSED",
    context: { namespace, method },
  });
}

describe("after close() resolves", () => {
  it("summonController() builds no controller: no check reads the backend after close", async () => {
    const { driver, namespace, checks } = setup();
    const jobs = context(driver, namespace);
    const before = jobs.summonController("mail");
    await waitFor(() => checks() > 0);
    await jobs.close();

    const after = checks();
    for (const queue of ["mail", "renders", "thumbs"]) {
      expectRefused(
        await caught(() => jobs.summonController(queue)),
        namespace,
        "summonController()",
      );
    }
    expectRefused(
      await caught(() => jobs.summonController("other", policy())),
      namespace,
      "summonController()",
    );
    // Several poll intervals: a controller built and left running would
    // have read demand by now.
    await Bun.sleep(150);
    expect(checks()).toBe(after);
    // The one it had is closed, and stays closed.
    expect(await before.check()).toEqual({
      action: "skipped",
      reason: "closed",
    });
  });

  it("queue(), worker(), runner(), notifier(), start() and the registry's verbs build nothing", async () => {
    const { driver, namespace } = setup();
    const jobs = context(driver, namespace);
    jobs.define("echo", async () => "ok");
    const existing = jobs.queue("mail");
    await jobs.close();

    const refusals: [string, () => unknown][] = [
      ["queue()", () => jobs.queue("mail")],
      ["queue()", () => jobs.queue("fresh")],
      ["worker()", () => jobs.worker("fresh", async () => null)],
      [
        "runner()",
        () =>
          jobs.runner({
            id: "late",
            file: HANDLER,
            executionMode: "in-process",
          }),
      ],
      ["notifier()", () => jobs.notifier()],
      ["start()", () => jobs.start()],
      ["queue()", () => jobs.now("echo")],
      ["queue()", () => jobs.drain()],
    ];
    for (const [method, call] of refusals) {
      expectRefused(await caught(call), namespace, method);
    }
    // The queue it had is closed, as before.
    expect(await caught(() => existing.add("a", {}))).toBeInstanceOf(
      QueueClosedError,
    );
    expect(jobs.runners.list()).toEqual([]);
  });

  it("still answers what builds nothing: definitions, the backend's lists", async () => {
    const { driver, namespace } = setup();
    const jobs = context(driver, namespace);
    jobs.define("echo", async () => "ok");
    await jobs.queue("mail").add("a", {});
    await jobs.close();

    expect(jobs.definitions().map((definition) => definition.name)).toEqual([
      "echo",
    ]);
    expect(await jobs.listQueues()).toContain("mail");
  });
});

describe("during close()", () => {
  it("refuses summonController() from the call to close() on, before the controllers have closed", async () => {
    const { driver, namespace, checks } = setup();
    const jobs = context(driver, namespace);
    jobs.summonController("mail");
    const closing = jobs.close();

    // Synchronously after the call: the controllers are still closing.
    expectRefused(
      await caught(() => jobs.summonController("mail")),
      namespace,
      "summonController()",
    );
    expectRefused(
      await caught(() => jobs.summonController("late", policy())),
      namespace,
      "summonController()",
    );
    await closing;
    const after = checks();
    await Bun.sleep(150);
    expect(checks()).toBe(after);
  });

  it("lets a job still running while the workers close add jobs, and closes the queue it added to", async () => {
    const { driver, namespace } = setup();
    const jobs = context(driver, namespace);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const probes = createDeferred<Record<string, unknown>>();
    let late: BunQueue | undefined;
    jobs.define("follow-up", async () => "done");
    jobs.define("hold", async () => {
      entered.resolve();
      await release.promise;
      const results: Record<string, unknown> = {};
      const probe = async (name: string, fn: () => unknown) => {
        results[name] = await caught(fn);
      };
      await probe("now", () => jobs.now("follow-up"));
      await probe("late queue", async () => {
        late = jobs.queue("late");
        await late.add("x", {});
      });
      await probe("summonController", () => {
        jobs.summonController("late", policy());
      });
      await probe("notifier", () => jobs.notifier());
      await probe("worker", () => jobs.worker("late", async () => null));
      await probe("runner", () => {
        jobs.runner({ id: "late", file: HANDLER, executionMode: "in-process" });
      });
      probes.resolve(results);
      return "held";
    });
    const worker = await jobs.start({ pollInterval: 10 });
    // Heard when close() reaches the workers: the summon controllers and
    // notifiers are closed by then, the queues not yet.
    const workersClosing = createDeferred<void>();
    const closeWorker = worker.close.bind(worker);
    worker.close = async (options) => {
      workersClosing.resolve();
      await closeWorker(options);
    };
    await jobs.now("hold");
    await entered.promise;

    const closing = jobs.close({ timeout: 10_000 });
    await workersClosing.promise;
    release.resolve();
    const results = await probes.promise;
    await closing;

    // Adding still works: the queues have not been closed yet.
    expect(results.now).toBeUndefined();
    expect(results["late queue"]).toBeUndefined();
    // What close() has already closed the list of is refused.
    expectRefused(results.summonController, namespace, "summonController()");
    expectRefused(results.notifier, namespace, "notifier()");
    expectRefused(results.worker, namespace, "worker()");
    expectRefused(results.runner, namespace, "runner()");
    expect(jobs.runners.list()).toEqual([]);

    // The jobs were written, and the queue made during close() was closed
    // with the others.
    expect(await caught(() => late!.add("y", {}))).toBeInstanceOf(
      QueueClosedError,
    );
    const reader = new BunQueue("late", {
      namespace,
      driver,
      logger: noopLogger,
    });
    perTest.unshift(async () => await reader.close());
    expect(await reader.count("waiting")).toBe(1);
    const registry = new BunQueue("jobs", {
      namespace,
      driver,
      logger: noopLogger,
    });
    perTest.unshift(async () => await registry.close());
    expect(await registry.count("waiting")).toBe(1);
  });

  it("closes a notifier whose start close() overtook, and refuses it", async () => {
    const { driver, namespace, holdConnect } = setup();
    const jobs = context(driver, namespace);
    const closes = spyOn(JobsNotifier.prototype, "close");
    try {
      const release = holdConnect();
      // Asked before close(), still starting when close() takes its list.
      const pending = caught(() => jobs.notifier());
      await jobs.close();
      expect(closes).toHaveBeenCalledTimes(0);
      release();
      expectRefused(await pending, namespace, "notifier()");
      expect(closes).toHaveBeenCalledTimes(1);
    } finally {
      closes.mockRestore();
    }
  });

  it("refuses queue() once the queues are closing", async () => {
    const { driver, namespace } = setup();
    const jobs = context(driver, namespace);
    const queue = jobs.queue("mail");
    let refusal: unknown = "not called";
    const close = queue.close.bind(queue);
    queue.close = async () => {
      refusal = await caught(() => jobs.queue("later"));
      await close();
    };
    await jobs.close();
    expectRefused(refusal, namespace, "queue()");
  });
});

describe("before close()", () => {
  it("builds as before: a controller for a policy, attached to the queue that already exists", async () => {
    const { driver, namespace } = setup();
    const jobs = context(driver, namespace);
    const queue = jobs.queue("extra");
    const calls: string[] = [];
    const controller = jobs.summonController("extra", {
      summoner: async (request) => {
        calls.push(request.queue);
      },
      triggers: { onAdd: true, events: false, poll: false, debounce: 0 },
      cooldown: 0,
    });
    expect(controller).toBeInstanceOf(SummonController);
    expect(jobs.summonController("extra")).toBe(controller);
    // Attached at build: the existing queue's add reaches the controller.
    await queue.add("a", {});
    await waitFor(() => calls.length > 0, { timeout: 5_000 });
    expect(calls[0]).toBe("extra");
  });

  it("refuses a closed context's error as a JobsError with its own code", () => {
    const error = new JobsClosedError("ns", "queue()");
    expect(error).toMatchObject({
      name: "JobsClosedError",
      code: "JOBS_CLOSED",
      context: { namespace: "ns", method: "queue()" },
    });
    expect(error.message).toBe(
      'Jobs context "ns" is closed: queue() builds nothing after close()',
    );
  });
});
