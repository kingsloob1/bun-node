import { join } from "node:path";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunRunner, MemoryDriver } from "../lib/index";
import { testNamespace } from "./helpers";

/**
 * How a runner reports what happens outside a run: through its logger, and
 * through `error` when somebody is listening for it.
 */

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const started: BunRunner<any, any>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    started.map((runner) => runner.stop({ force: true })),
  );
  started.length = 0;
});

/** A runner over a driver whose state reads fail, so `start()` reports one. */
function brokenStateRunner(logger = createTestLogger()) {
  const driver = new MemoryDriver();
  driver.getState = async () => {
    throw new Error("state is down");
  };
  const namespace = testNamespace();
  const runner = new BunRunner({
    id: "reporting",
    namespace,
    file: fixture("echo"),
    executionMode: "in-process",
    driver,
    logger: logger.logger,
  });
  started.push(runner);
  return { runner, namespace, events: logger.events };
}

describe("BunRunner: reporting", () => {
  it("keeps the runner's bindings when the logger is replaced", () => {
    const { runner, namespace } = brokenStateRunner();
    const replacement = createTestLogger();

    runner.logger = replacement.logger;
    runner.logger.info("hello");

    expect(replacement.events).toHaveLength(1);
    expect(replacement.events[0]!.bindings).toMatchObject({
      namespace,
      runnerId: "reporting",
    });
  });

  it("logs a failure outside a run when nobody listens for error", async () => {
    const { runner, events } = brokenStateRunner();
    await runner.start();

    expect(
      events.some(
        (event) =>
          event.level === "error" && event.fields.context === "readState",
      ),
    ).toBe(true);
  });

  it("still logs it when listeners exist, but none for error", async () => {
    const { runner, events } = brokenStateRunner();
    runner.on("started", () => {});
    await runner.start();

    expect(
      events.some(
        (event) =>
          event.level === "error" && event.fields.context === "readState",
      ),
    ).toBe(true);
  });

  it("hands it to an error listener instead of logging it", async () => {
    const { runner, events } = brokenStateRunner();
    const heard: string[] = [];
    runner.on("error", (_error, context) => heard.push(context));
    await runner.start();

    expect(heard).toContain("readState");
    expect(events.some((event) => event.level === "error")).toBe(false);
  });
});
