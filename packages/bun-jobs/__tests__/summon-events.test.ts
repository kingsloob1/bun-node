import type {
  DriverEvent,
  JobsDriver,
  SummonCheckResult,
  SummonEventPayload,
} from "../lib/index";
import { join } from "node:path";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import {
  BunQueue,
  createDriver,
  defineSummoner,
  SummonController,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { runBun } from "./helpers/spawnBun";

/**
 * The `summon` event across processes (plan §9.1): a `SummonController` in a
 * child process summons for a backlog this process added, and publishes each
 * attempt's state change through the driver — whatever `publishEvents` says,
 * since nothing here turns it on. A `BunQueue` here that subscribes re-emits
 * it as `queue.on("summon")`, with the payload the controller emitted
 * locally; the raw envelope carries no `id`, because the payload's `id` is a
 * summon attempt's, not a job's.
 *
 * On every backend that carries work between processes: the file driver and
 * SQLite always, and the servers whose URLs are set.
 */

setDefaultTimeout(60_000);

const PUBLISHER = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "summon-publisher.ts",
);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0).reverse()) {
    await cleanup().catch(() => {});
  }
});

/** One JSON line the publisher printed. */
interface Line {
  /** What it reports. */
  event: "local" | "checked";
  /** For `local`: the event the controller emitted on itself. */
  payload?: SummonEventPayload;
  /** For `checked`: what the check did. */
  result?: SummonCheckResult;
}

const BACKENDS = await crossProcessBackends({ cleanups });

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `the summon event across processes: ${backend.name}`,
    () => {
      /** A driver, a namespace with one waiting job, and two queues on it: one subscribing, one not. */
      async function setup(): Promise<{
        driver: JobsDriver;
        namespace: string;
        heard: SummonEventPayload[];
        unsubscribedHeard: SummonEventPayload[];
        raw: DriverEvent[];
      }> {
        const driver = createDriver(backend.config);
        await driver.connect();
        const namespace = testNamespace(`summon-events-${backend.name}`);
        const listening = new BunQueue("work", {
          namespace,
          driver,
          logger: noopLogger,
          subscribe: true,
        });
        const deaf = new BunQueue("work", {
          namespace,
          driver,
          logger: noopLogger,
        });
        const heard: SummonEventPayload[] = [];
        const unsubscribedHeard: SummonEventPayload[] = [];
        listening.on("summon", (event) => heard.push(event));
        deaf.on("summon", (event) => unsubscribedHeard.push(event));
        await listening.connect();
        await deaf.add("job", { n: 1 });
        const raw: DriverEvent[] = [];
        const unsubscribe = await driver.subscribe(
          namespace,
          "queue",
          "work",
          (event) => {
            if (event.type === "summon") {
              raw.push(event);
            }
          },
        );
        perTest.push(async () => {
          await unsubscribe();
          await listening.close();
          await deaf.close();
          await driver.purge(namespace);
          await driver.close();
        });
        return { driver, namespace, heard, unsubscribedHeard, raw };
      }

      it("reaches a subscribing queue in this process, as the controller emitted it, with no envelope id", async () => {
        const { namespace, heard, unsubscribedHeard, raw } = await setup();

        const { lines, exitCode, stderr } = await runBun<Line>(PUBLISHER, {
          SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
          SUMMON_TEST_NAMESPACE: namespace,
        });
        expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({
          exitCode: 0,
          stderr: "",
        });
        const checked = lines.find((line) => line.event === "checked")!;
        expect(checked.result).toMatchObject({
          action: "summoned",
          outcome: "started",
        });
        const local = lines
          .filter((line) => line.event === "local")
          .map((line) => line.payload!);
        expect(local).toEqual([
          {
            id: (checked.result as { id: string }).id,
            outcome: "started",
            kind: "fake",
            count: 1,
            handles: ["unit-1"],
            reason: "manual",
          },
        ]);

        // The same events, in the same order, from the other process.
        await waitFor(() => heard.length >= local.length, {
          timeout: 20_000,
          interval: 20,
          message: () =>
            `heard ${JSON.stringify(heard)}; the publisher emitted ${JSON.stringify(local)}`,
        });
        expect(heard).toEqual(local);
        // On the wire: a queue event about the queue, with no `id` — the
        // payload's is an attempt's, and a job channel must not get it.
        await waitFor(() => raw.length >= local.length, { timeout: 20_000 });
        expect(raw[0]).toMatchObject({
          v: 1,
          kind: "queue",
          type: "summon",
          ns: namespace,
          target: "work",
          payload: local[0],
        });
        expect(raw[0]).not.toHaveProperty("id");
        // Negative control: a queue that does not subscribe hears nothing,
        // so it is the subscription that carried it.
        expect(unsubscribedHeard).toEqual([]);
      });
    },
  );
}

/**
 * `close()` waits for the `summon` events a controller is still publishing,
 * but never longer than `summonTimeout`: a publish that never settles — a
 * Redis client queueing commands while it reconnects — must not hold it. On
 * SQLite, with the driver's `publish` wrapped.
 */
describe("close() and a publish that never settles", () => {
  const sqlite = BACKENDS.find((backend) => backend.name === "sqlite")!;

  /** A controller whose driver's `publish` takes `publishMs` (`Infinity`: never settles), after one summon. */
  async function summonedWith(publishMs: number): Promise<{
    controller: SummonController;
    published: () => number;
    warnings: () => string[];
  }> {
    const inner = createDriver(sqlite.config);
    await inner.connect();
    let published = 0;
    const driver = new Proxy(inner, {
      get(target, property) {
        if (property === "publish") {
          return async (...args: Parameters<JobsDriver["publish"]>) => {
            if (!Number.isFinite(publishMs)) {
              return await new Promise<void>(() => {});
            }
            await Bun.sleep(publishMs);
            await target.publish(...args);
            published++;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const namespace = testNamespace("summon-close");
    const queue = new BunQueue("work", {
      namespace,
      driver: inner,
      logger: noopLogger,
    });
    await queue.add("job", {});
    const { logger, events } = createTestLogger();
    const controller = new SummonController({
      driver,
      namespace,
      queue: "work",
      summoner: defineSummoner({ kind: "fake", invoke: async () => {} }),
      triggers: { onAdd: false, events: false, poll: false },
      summonTimeout: 300,
      logger,
    });
    perTest.push(async () => {
      await controller.close();
      await queue.close();
      await inner.purge(namespace);
      await inner.close();
    });
    expect(await controller.check()).toMatchObject({ action: "summoned" });
    return {
      controller,
      published: () => published,
      warnings: () =>
        events
          .filter((event) => event.level === "warn")
          .map((event) => String(event.message)),
    };
  }

  it("returns within summonTimeout, with one warn, when a publish never settles", async () => {
    const { controller, warnings } = await summonedWith(Infinity);
    const started = performance.now();
    await controller.close();
    const took = performance.now() - started;
    // Bounded: `summonTimeout` is 300 ms here; a generous ceiling for load.
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(2_000);
    expect(
      warnings().filter((message) => message.includes("still publishing")),
    ).toHaveLength(1);
  });

  it("negative control: a publish that settles inside the bound is waited for, with no warn", async () => {
    const { controller, published, warnings } = await summonedWith(100);
    expect(published()).toBe(0);
    await controller.close();
    expect(published()).toBe(1);
    expect(
      warnings().filter((message) => message.includes("still publishing")),
    ).toEqual([]);
  });
});
