import type { DriverEvent } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  BunRunner,
  MemoryDriver,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * `close()` and `stop()` wait for events still being published.
 *
 * A worker publishes `completed` after telling its own listeners, without
 * waiting for the write. A process that closes on completion — from that very
 * listener — used to shut the driver under the write, and the event was lost
 * for everyone else: reliably on MongoDB, whose publish takes two round trips.
 * A publish slowed down here makes the window certain.
 */

/** A memory driver whose publishes take a while to land, recording which did. */
function slowPublishingDriver() {
  const driver = new MemoryDriver();
  const publish = driver.publish.bind(driver);
  const landed: string[] = [];

  driver.publish = async (event: DriverEvent) => {
    await Bun.sleep(50);
    await publish(event);
    landed.push(event.type);
  };

  return { driver, landed };
}

describe("close(), stop() and events in flight", () => {
  it("waits for a worker's completed event when closed from its listener", async () => {
    const { driver, landed } = slowPublishingDriver();
    const namespace = testNamespace();
    const queue = new BunQueue("closing", {
      namespace,
      driver,
      logger: noopLogger,
    });
    const worker = new BunQueueWorker("closing", async () => "done", {
      namespace,
      driver,
      logger: noopLogger,
      publish: true,
      pollInterval: 5,
      waitToExit: false,
    });

    let closed: Promise<void> | undefined;
    worker.on("completed", () => {
      closed ??= worker.close();
    });

    await queue.add("x", {});
    void worker.run();
    await waitFor(() => closed !== undefined, { timeout: 5_000 });
    await closed;

    // Resolved only once the event it published on the way had landed.
    expect(landed).toContain("completed");
    await queue.close();
  });

  it("waits for a runner's succeeded event when stopped from its listener", async () => {
    const { driver, landed } = slowPublishingDriver();
    const runner = new BunRunner({
      id: "stopping",
      namespace: testNamespace(),
      file: join(import.meta.dir, "fixtures", "handlers", "echo.ts"),
      executionMode: "in-process",
      driver,
      logger: noopLogger,
      publish: true,
      waitToExit: false,
    });
    await runner.start();

    let stopped: Promise<void> | undefined;
    runner.on("finished", () => {
      stopped ??= runner.stop();
    });

    await runner.trigger();
    await waitFor(() => stopped !== undefined, { timeout: 5_000 });
    await stopped;

    // Resolved only once the event it published on the way had landed.
    expect(landed).toContain("succeeded");
  });
});
