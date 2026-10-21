import type { JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  BunQueue,
  BunQueueWorker,
  createDriver,
  JobDataValidationError,
  MemoryDriver,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Job data schemas on every backend (bun-validate V5a): what the producer
 * stores must come back from the store in a shape its own schema accepts,
 * because the worker checks the stored input again before the handler. A
 * refused add writes nothing on any backend. A flow (V5c): one bad node
 * writes nothing for the whole flow, and a good one runs each node with its
 * schema's output and hands the parent its children's results.
 */

const cleanups: (() => Promise<void>)[] = [];
const servers = await crossProcessBackends({ cleanups });

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/** Teardown for one test, in reverse. */
const perTest: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (perTest.length > 0) {
    await perTest.pop()!();
  }
});

const backends: {
  name: string;
  available: boolean;
  make: () => JobsDriver;
}[] = [
  { name: "memory", available: true, make: () => new MemoryDriver() },
  ...servers.map((server) => ({
    name: server.name,
    available: server.available,
    make: () => createDriver(server.config),
  })),
];

/** A data schema with a coercion, a default, nesting and an array. */
const Order = z.object({
  id: z.string(),
  qty: z.coerce.number().int(),
  note: z.string().default(""),
  lines: z.array(z.object({ sku: z.string(), at: z.coerce.date() })),
});

for (const backend of backends) {
  describe.skipIf(!backend.available)(
    `job data schemas: ${backend.name}`,
    () => {
      /** A queue and a checking worker on this backend, torn down afterwards. */
      function setup(schema: z.ZodType, seen: unknown[]): BunQueue<any, any> {
        const driver = backend.make();
        const namespace = testNamespace("v5a");
        const queue = new BunQueue("orders", {
          namespace,
          driver,
          logger: noopLogger,
          schema: { data: schema },
        });
        const worker = new BunQueueWorker(
          "orders",
          async (job) => {
            seen.push(job.data);
            return null;
          },
          {
            namespace,
            driver,
            logger: noopLogger,
            pollInterval: 10,
            waitToExit: false,
            schema: { data: schema },
          },
        );
        void worker.run();
        perTest.push(async () => {
          await worker.close({ force: true }).catch(() => undefined);
          await queue.close().catch(() => undefined);
          // Exactly the namespace this test made, never a prefix sweep.
          await driver.purge(namespace).catch(() => undefined);
          await driver.close().catch(() => undefined);
        });
        return queue;
      }

      it("stores the input, and the worker hands the handler the output", async () => {
        const seen: unknown[] = [];
        const queue = setup(Order, seen);
        const at = "2026-10-21T10:00:00.000Z";
        const input = { id: "o-1", qty: "3", lines: [{ sku: "a", at }] };
        const job = await queue.add("order", input);

        await waitFor(() => seen.length === 1, { timeout: 15_000 });
        expect(seen[0]).toEqual({
          id: "o-1",
          qty: 3,
          note: "",
          lines: [{ sku: "a", at: new Date(at) }],
        });
        await waitFor(
          async () => (await queue.getJob(job.id))?.state === "completed",
          { timeout: 15_000 },
        );
        expect((await queue.getJob(job.id))?.data).toEqual(input);
      }, 30_000);

      it("refuses bad data, writing nothing", async () => {
        const queue = setup(Order, []);
        const error = await queue
          .add("order", { id: 1, qty: "x", lines: [] })
          .catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(JobDataValidationError);
        const counts = await queue.count();
        expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0);
      }, 30_000);

      it("a flow with one bad grandchild writes nothing; a good one runs whole", async () => {
        const seen: unknown[] = [];
        const queue = setup(Order, seen);
        const at = "2026-10-21T10:00:00.000Z";
        const order = (id: string) => ({
          id,
          qty: "2",
          lines: [{ sku: "a", at }],
        });

        const error = await queue
          .addFlow({
            name: "order",
            data: order("top"),
            opts: { jobId: "top" },
            children: [
              {
                name: "order",
                data: order("mid"),
                opts: { jobId: "mid" },
                children: [
                  {
                    name: "order",
                    data: { id: "leaf", qty: "x", lines: [] },
                    opts: { jobId: "leaf" },
                  },
                ],
              },
            ],
          })
          .catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(JobDataValidationError);
        expect((error as JobDataValidationError).context.flowPath).toBe(
          "children.0.children.0",
        );
        for (const id of ["top", "mid", "leaf"]) {
          expect(await queue.getJob(id)).toBeNull();
        }
        const counts = await queue.count();
        expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0);

        const flow = await queue.addFlow({
          name: "order",
          data: order("top"),
          children: [
            { name: "order", data: order("a"), opts: { jobId: "a" } },
            { name: "order", data: order("b"), opts: { jobId: "b" } },
          ],
        });
        await waitFor(
          async () => (await queue.getJob(flow.job.id))?.state === "completed",
          { timeout: 15_000 },
        );
        // Every node's handler got the output; the store kept the input.
        expect(seen).toHaveLength(3);
        for (const data of seen) {
          expect(data).toMatchObject({ qty: 2, note: "" });
        }
        expect((await queue.getJob("a"))?.data).toEqual(order("a"));
        const parent = await queue.getJob(flow.job.id);
        expect(await parent!.getChildrenValues()).toEqual({
          "orders:a": null,
          "orders:b": null,
        });
      }, 30_000);

      it("a job with no data is checked as null, at enqueue and before the handler", async () => {
        const seen: unknown[] = [];
        const queue = setup(z.null(), seen);
        // Stored, and read back, as `null` (JSON has no `undefined`), so the
        // enqueue check sees `null` too, and both checks agree.
        const job = await queue.add("empty", undefined);
        await waitFor(
          async () => (await queue.getJob(job.id))?.state === "completed",
          { timeout: 15_000 },
        );
        expect(seen).toEqual([null]);
      }, 30_000);
    },
  );
}
