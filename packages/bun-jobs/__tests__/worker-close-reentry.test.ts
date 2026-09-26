import type { DriverConfig } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, createDriver } from "../lib/index";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * A `close()` that joins a close already under way resolves once that close
 * has finished — the moment the first call resolves — whether or not the
 * worker ever ran.
 *
 * A graceful re-entry used to wait for the claim loop to stop instead. A
 * worker whose `run()` was never called has no loop, and nothing ever
 * resolved what it waited on: the second `close()` hung for good. A process
 * whose shutdown path closed the same worker twice — a signal handler and a
 * supervisor, say — never exited.
 */

const cleanups: (() => Promise<void>)[] = [];
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** Memory, and one server when it is configured: Postgres. */
const BACKENDS = [
  {
    name: "memory",
    config: { type: "memory" } as DriverConfig,
    available: true,
  },
  ...(await crossProcessBackends({ cleanups })).filter(
    (backend) => backend.name === "postgres",
  ),
];

/** How long a re-entrant close may take before it counts as hung. */
const BOUND_MS = 3_000;

/** Resolves with how long `promise` took, or `"hung"` after `BOUND_MS`. */
async function within(promise: Promise<unknown>): Promise<number | "hung"> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then(() => Date.now() - started),
    new Promise<"hung">((resolve) => {
      timer = setTimeout(resolve, BOUND_MS, "hung");
    }),
  ]);
  clearTimeout(timer);
  return outcome;
}

/** A worker that builds, and owns, its driver; never run unless a test runs it. */
function worker(config: DriverConfig): {
  worker: BunQueueWorker;
  events: { closed: number };
} {
  const namespace = testNamespace("close-reentry");
  const created = new BunQueueWorker(
    "close-reentry",
    async (): Promise<unknown> => "done",
    {
      namespace,
      driver: config,
      logger: noopLogger,
      pollInterval: 10,
      waitToExit: false,
    },
  );
  created.on("error", () => {});
  const events = { closed: 0 };
  created.on("closed", () => {
    events.closed += 1;
  });
  closers.push(async () => await created.close({ force: true }));
  if (config.type !== "memory") {
    closers.push(async () => {
      const driver = createDriver(config);
      try {
        await driver.connect();
        await driver.purge(namespace);
      } finally {
        await driver.close();
      }
    });
  }
  return { worker: created, events };
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `close() re-entered (${backend.name})`,
    () => {
      it("close() then close() on a worker that never ran: both resolve", async () => {
        const { worker: never, events } = worker(backend.config);
        const first = never.close();
        const second = never.close().then(() => events.closed);

        expect(await within(first)).not.toBe("hung");
        expect(await within(second)).not.toBe("hung");
        // Resolved with the close finished, not before.
        expect(await second).toBe(1);
        expect(events.closed).toBe(1);
      }, 15_000);

      it("close({ force: true }) then close() on a worker that never ran: both resolve", async () => {
        const { worker: never, events } = worker(backend.config);
        const first = never.close({ force: true });
        const second = never.close().then(() => events.closed);

        expect(await within(first)).not.toBe("hung");
        expect(await within(second)).not.toBe("hung");
        expect(await second).toBe(1);
        expect(events.closed).toBe(1);
      }, 15_000);

      it("close() after the close has finished resolves at once", async () => {
        const { worker: never } = worker(backend.config);
        await never.close();

        expect(await within(never.close())).not.toBe("hung");
        expect(await within(never.close({ force: true }))).not.toBe("hung");
      }, 15_000);

      it("on a running worker, a second close() resolves once the loop has stopped and the close has finished", async () => {
        const { worker: running, events } = worker(backend.config);
        const namespace = running.namespace;
        const queue = new BunQueue("close-reentry", {
          namespace,
          driver: running.driver,
          logger: noopLogger,
        });
        closers.push(async () => await queue.close());
        const loop = running.run();
        let loopStopped = false;
        void loop.then(() => {
          loopStopped = true;
        });
        await new Promise<void>((resolve) => {
          running.once("ready", () => resolve());
        });

        const first = running.close();
        const second = running.close().then(() => ({
          loopStopped,
          closed: events.closed,
        }));

        expect(await within(first)).not.toBe("hung");
        expect(await second).toEqual({ loopStopped: true, closed: 1 });
      }, 15_000);
    },
  );
}
