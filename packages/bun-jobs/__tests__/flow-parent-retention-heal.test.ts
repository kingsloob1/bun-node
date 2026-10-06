import type { DriverConfig, JobsDriver } from "../lib/index";
import type { Backend } from "./helpers/backends";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  createDriver,
  UnrecoverableJobError,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * A flow's top-level parent, buried by a child, gets its `removeOnFail` from
 * the `markChildRecorded` the worker makes on it after the bury. The child is
 * marked recorded before that, so when the parent's mark fails nothing about
 * the child is left to redeliver: the follow-through has to be healed from the
 * parent's own record — buried by a child, not yet marked — by the worker that
 * saw the failure, and by the sweep when that worker is gone.
 */

const closers: (() => Promise<unknown>)[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup().catch(() => undefined);
  }
});

/**
 * A view of `inner` whose `markChildRecorded` throws for one job while
 * `failing()` says so — every attempt, so the worker's write retries give up
 * rather than absorbing it. Everything else passes straight through.
 */
function withFailingMark(
  inner: JobsDriver,
  /** The job whose mark fails, read at call time: it is known only once added. */
  target: () => { queue: string; id: string } | undefined,
  /** Whether the mark fails right now. */
  failing: () => boolean,
): { driver: JobsDriver; failures: () => number } {
  let failures = 0;
  const driver = new Proxy(inner, {
    get(object, property) {
      if (property === "markChildRecorded") {
        const mark: NonNullable<JobsDriver["markChildRecorded"]> = async (
          ...args
        ) => {
          const [q, id] = args;
          const job = target();
          if (failing() && job && q.queue === job.queue && id === job.id) {
            failures++;
            throw new Error("the parent's mark could not be written");
          }
          return await object.markChildRecorded!(...args);
        };
        return mark;
      }

      const value = Reflect.get(object, property, object) as unknown;
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  return { driver, failures: () => failures };
}

/**
 * Every backend this runs on: memory, file and SQLite always, and each server
 * whose URL is set.
 */
const backends: Backend[] = [
  { name: "memory", config: { type: "memory" }, available: true },
  ...(await crossProcessBackends({ cleanups })),
];

/** Above the waits inside each case: a flow on a server makes many round trips. */
const BACKEND_TEST_TIMEOUT = 30_000;

for (const backend of backends) {
  describe.skipIf(!backend.available)(
    `flow parent retention heal on ${backend.name}`,
    () => {
      /** A fresh driver on the backend, closed after the test. */
      const makeDriver = (): JobsDriver => {
        const config = (
          backend.config.type === "sql"
            ? { ...backend.config, syncSchema: true }
            : backend.config
        ) as DriverConfig;
        const driver = createDriver(config);
        closers.push(() => driver.close());
        return driver;
      };

      /** A namespace, a producer on `reports`, and a way to start workers. */
      const setup = (driver: JobsDriver) => {
        const namespace = testNamespace("flowgap");
        // Exactly this namespace, never a prefix sweep: the servers are shared.
        closers.push(() => driver.purge(namespace));
        const queue = new BunQueue("reports", {
          namespace,
          driver,
          logger: noopLogger,
          subscribe: false,
        });
        closers.push(() => queue.close());

        const worker = (
          name: "reports" | "fetch",
          on: JobsDriver,
          /** Whether maintenance runs often enough to heal within the test. */
          healing: boolean,
        ) => {
          const instance = new BunQueueWorker(
            name,
            async () => {
              if (name === "fetch") {
                throw new UnrecoverableJobError("broke");
              }
              return "never";
            },
            {
              namespace,
              driver: on,
              logger: noopLogger,
              pollInterval: 5,
              stalledInterval: healing ? 20 : 60_000,
              waitToExit: false,
              publish: false,
            },
          );
          closers.push(() => instance.close({ force: true }));
          return instance;
        };

        const addFlow = async () =>
          await queue.addFlow({
            name: "top",
            data: {},
            opts: { removeOnFail: true },
            children: [{ name: "child", data: {}, queue: "fetch" }],
          });

        const parentOf = async (id: string) =>
          await driver.getJob({ ns: namespace, queue: "reports" }, id);

        return { worker, addFlow, parentOf };
      };

      it(
        "applies removeOnFail once a failed mark is delivered again",
        async () => {
          const inner = makeDriver();
          let parentId: string | undefined;
          let failing = true;
          const view = withFailingMark(
            inner,
            () =>
              parentId === undefined
                ? undefined
                : { queue: "reports", id: parentId },
            () => failing,
          );
          const { worker, addFlow, parentOf } = setup(inner);

          const flow = await addFlow();
          parentId = flow.job.id;

          // Maintenance a minute apart: only a delivery the worker remembered
          // can finish what the failed mark left undone.
          const fetch = worker("fetch", view.driver, false);
          fetch.on("error", (_error, context) => {
            // Mended once the first pass has given up on the mark.
            if (context === "flow") {
              failing = false;
            }
          });
          void fetch.run();

          await waitFor(() => !failing, {
            timeout: 10_000,
            message: "the parent's mark never failed",
          });
          expect(view.failures()).toBeGreaterThan(0);

          await waitFor(async () => (await parentOf(flow.job.id)) === null, {
            timeout: 5_000,
            message: "the buried parent's removeOnFail was never applied",
          });
        },
        BACKEND_TEST_TIMEOUT,
      );

      it(
        "applies removeOnFail from the sweep when the worker that failed is gone",
        async () => {
          const inner = makeDriver();
          let parentId: string | undefined;
          const view = withFailingMark(
            inner,
            () =>
              parentId === undefined
                ? undefined
                : { queue: "reports", id: parentId },
            // For good: this worker can never finish it, like one that crashed.
            () => true,
          );
          const { worker, addFlow, parentOf } = setup(inner);

          const flow = await addFlow();
          parentId = flow.job.id;

          let gaveUp = false;
          const fetch = worker("fetch", view.driver, false);
          fetch.on("error", (_error, context) => {
            if (context === "flow") {
              gaveUp = true;
            }
          });
          void fetch.run();

          await waitFor(() => gaveUp, {
            timeout: 10_000,
            message: "the parent's mark never failed",
          });
          await fetch.close({ force: true });

          // Buried by its child, its retention still owed.
          const buried = await parentOf(flow.job.id);
          expect(buried?.state).toBe("dead");
          expect(buried?.flow?.recorded).not.toBe(true);

          // A worker on the parent's queue, which never saw the failure.
          void worker("reports", inner, true).run();

          await waitFor(async () => (await parentOf(flow.job.id)) === null, {
            timeout: 5_000,
            message: "the sweep never applied the buried parent's removeOnFail",
          });
        },
        BACKEND_TEST_TIMEOUT,
      );
    },
  );
}
