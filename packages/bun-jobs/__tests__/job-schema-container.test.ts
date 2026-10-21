import type { FakeEngine } from "./helpers/fakeEngine";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { installFakeEngine } from "./helpers/fakeEngine";

/**
 * Job data schemas on a container target (bun-validate V5a, plan §4.8.3),
 * through the fake engine (`helpers/fakeEngine.ts`, a "container" that is a
 * local process): the container is sent the `jsonClone` of the data schema's
 * output, in the copy of the record it is sent, and the stored record keeps
 * the producer's input.
 */

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await Promise.resolve(cleanup()).catch(() => undefined);
  }
}, 60_000);

/** A fake engine for one test, with the test image present. */
function engine(): FakeEngine {
  const fake = installFakeEngine({ images: ["fake/bun:1"] });
  cleanups.push(() => fake.uninstall());
  return fake;
}

describe("job data schemas: container target", () => {
  it("sends the container the jsonClone of the output; a Date arrives as its string", async () => {
    engine();
    const driver = new MemoryDriver();
    const namespace = testNamespace("v5a");
    const queue = new BunQueue("boxed", {
      namespace,
      driver,
      logger: noopLogger,
    });
    const worker = new BunQueueWorker(
      "boxed",
      join(import.meta.dir, "fixtures", "container", "echo.ts"),
      {
        namespace,
        driver,
        key: `v5a-${namespace}`,
        logger: noopLogger,
        pollInterval: 5,
        waitToExit: false,
        target: { kind: "container", image: "fake/bun:1", closeTimeout: 1000 },
        schema: {
          data: z.object({ n: z.coerce.number(), at: z.coerce.date() }),
        },
      },
    );
    cleanups.push(
      () => queue.close(),
      () => worker.close({ force: true }),
    );
    void worker.run();

    const at = "2026-10-21T10:00:00.000Z";
    const job = await queue.add("echo", { n: "7", at });
    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
      {
        timeout: 20_000,
        message: async () => `job is ${(await queue.getJob(job.id))?.state}`,
      },
    );
    const stored = (await queue.getJob(job.id))!;
    expect((stored.returnValue as { data: unknown }).data).toEqual({
      n: 7,
      at,
    });
    expect(stored.data).toEqual({ n: "7", at });
  }, 30_000);
});
