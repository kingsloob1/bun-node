import { createTestLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * How a worker reports what fails outside a job: through its logger, and
 * through `error` when somebody is listening for it.
 */

const workers: BunQueueWorker<any, any>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    workers.map(async (worker) => await worker.close({ force: true })),
  );
  workers.length = 0;
});

/**
 * A worker over a driver whose promotion fails, which a worker with nothing to
 * claim runs straight away — a failure that belongs to no job.
 */
function brokenPromotionWorker() {
  const driver = new MemoryDriver();
  driver.promoteDelayed = async () => {
    throw new Error("promotion is down");
  };
  const { logger, events } = createTestLogger();
  const worker = new BunQueueWorker("reporting", async () => null, {
    namespace: testNamespace(),
    driver,
    logger,
    pollInterval: 5,
    waitToExit: false,
  });
  workers.push(worker);
  return { worker, events };
}

/** Whether the logger recorded an error from the promotion. */
const loggedPromotion = (events: { level: string; fields: object }[]) =>
  events.some(
    (event) =>
      event.level === "error" &&
      (event.fields as { context?: string }).context === "promote",
  );

describe("BunQueueWorker: reporting", () => {
  it("logs a failure outside a job when nobody listens for error", async () => {
    const { worker, events } = brokenPromotionWorker();
    void worker.run();

    await waitFor(() => loggedPromotion(events), {
      timeout: 2_000,
      message: "the promotion failure was never logged",
    });
  });

  it("still logs it when listeners exist, but none for error", async () => {
    const { worker, events } = brokenPromotionWorker();
    worker.on("completed", () => {});
    void worker.run();

    await waitFor(() => loggedPromotion(events), {
      timeout: 2_000,
      message: "a listener for another event swallowed the failure",
    });
  });

  it("hands it to an error listener instead of logging it", async () => {
    const { worker, events } = brokenPromotionWorker();
    const heard: string[] = [];
    worker.on("error", (_error, context) => heard.push(context));
    void worker.run();

    await waitFor(() => heard.includes("promote"), { timeout: 2_000 });
    expect(loggedPromotion(events)).toBe(false);
  });
});
