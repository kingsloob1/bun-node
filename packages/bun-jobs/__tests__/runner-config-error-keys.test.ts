import type { ExecutionMode } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { toRunnerConfigDto } from "../lib/api/serialize";
import {
  BunRunner,
  BunRunnerManager,
  describeRunnerConfig,
  MemoryDriver,
  RUNNER_CONFIG_STATE,
  runnerKey,
} from "../lib/index";
import {
  parseRunnerConfigError,
  resolveRunnerConfig,
  writeRunnerConfig,
} from "../lib/runner/config";
import {
  ECHO_HANDLER,
  harness,
  jobsContext,
  openContexts,
  openHarnesses,
} from "./api/fixtures";
import { testNamespace, waitFor } from "./helpers";

/**
 * `RunnerConfigInfo.error.keys`: an owner's refusal names the settings it
 * refused, so a controller can tell a partial refusal from a whole one
 * without parsing the message. Carried from the owner's resolution through
 * its own snapshot, the stored `config:error`, the read path another process
 * uses, the DTO and the API — every hop in turn.
 */

const started: BunRunner<any, any>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    started.splice(0).map((r) => r.stop({ force: true })),
  );
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
});

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

/** The state key the runner in this suite lives under. */
const KEY = runnerKey("keys");

/**
 * A started owner built from a driver *instance*, so it has no driver config
 * to hand a child: an override asking for `worker-thread` is one it must refuse.
 */
async function owner(
  driver: MemoryDriver,
  namespace: string,
  executionModes: ExecutionMode[] = ["in-process", "worker-thread"],
): Promise<BunRunner<any, any>> {
  const runner = new BunRunner({
    id: "keys",
    namespace,
    driver,
    file: ECHO_HANDLER,
    executionMode: "in-process",
    runMode: "parallel",
    allowedOverrides: { executionModes },
    waitToExit: false,
    syncInterval: 25,
    logger: noopLogger,
  });
  started.push(runner);
  await runner.start();
  return runner;
}

describe("a runner config refusal names the refused settings", () => {
  it("names only the refused key on a partial refusal, and adopts the rest", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("error-keys");
    // Stored raw before the owner starts, as an older controller would have:
    // `worker-thread` needs a child driver this owner does not have, `single` is fine.
    await driver.connect();
    await writeRunnerConfig(driver, namespace, KEY, {
      [RUNNER_CONFIG_STATE.executionMode]: "worker-thread",
      [RUNNER_CONFIG_STATE.runMode]: "single",
    });
    const runner = await owner(driver, namespace);

    await waitFor(() => runner.config.error !== undefined, {
      timeout: 4000,
      message: () => JSON.stringify(runner.config),
    });

    // The owner's own view.
    const local = runner.config;
    expect(local.overridden).toEqual(["executionMode", "runMode"]);
    expect(local.error?.keys).toEqual(["executionMode"]);
    expect(local.effective.runMode).toBe("single");
    expect(local.effective.executionMode).toBe("in-process");
    expect(local.error?.message).toContain("driver config");

    // What it stored, and another process's read of it.
    const stored = JSON.parse(
      (await driver.getState(namespace, KEY))[RUNNER_CONFIG_STATE.error]!,
    ) as { keys?: unknown };
    expect(stored.keys).toEqual(["executionMode"]);
    const observer = new BunRunnerManager({
      namespace,
      driver,
      logger: noopLogger,
    });
    const remote = await observer.controller("keys");
    expect((await remote.config())?.error?.keys).toEqual(["executionMode"]);

    // The DTO copies the list rather than sharing it.
    const dto = toRunnerConfigDto(local);
    expect(dto.error?.keys).toEqual(["executionMode"]);
    expect(dto.error?.keys).not.toBe(local.error?.keys);

    // And the API, from a context that does not own the runner, answers it
    // in the schema's shape (the harness checks every response).
    const h = harness({ jobs: jobsContext(namespace, driver) });
    const res = await h.call("GET", "/runners/keys");
    expect(res.status).toBe(200);
    expect(res.body.config.error.keys).toEqual(["executionMode"]);
  });

  it("names every overridden key when the whole override is refused", () => {
    const resolved = resolveRunnerConfig({
      override: {
        maxConcurrency: "9000",
        runMode: "sometimes",
        executionMode: "worker-thread",
      },
      code: {
        executionMode: "in-process",
        runMode: "parallel",
        maxConcurrency: 4,
      },
      allowed: ["in-process", "worker-thread"],
      hasChildDriver: false,
    });
    expect(resolved.overridden).toEqual([
      "executionMode",
      "runMode",
      "maxConcurrency",
    ]);
    expect(resolved.refusedKeys).toEqual(resolved.overridden);
    expect(resolved.refusals).toHaveLength(3);
  });

  it("names nothing when every setting is adopted", () => {
    const resolved = resolveRunnerConfig({
      override: { runMode: "single", executionMode: "worker-thread" },
      code: {
        executionMode: "in-process",
        runMode: "parallel",
        maxConcurrency: 4,
      },
      allowed: ["in-process", "worker-thread"],
      hasChildDriver: true,
    });
    expect(resolved.refusedKeys).toEqual([]);
    expect(resolved.refusals).toEqual([]);
  });

  it("reads an error stored before keys existed as keys: []", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("error-keys");
    // An owner that has started, so the runner is configurable, and then
    // a `config:error` in the old shape, as an older owner left it.
    const runner = await owner(driver, namespace);
    await runner.stop({ force: true });
    await driver.setState(namespace, KEY, {
      [RUNNER_CONFIG_STATE.error]: JSON.stringify({
        at: 123,
        message: 'executionMode "worker-thread" needs a driver config',
      }),
    });

    const described = describeRunnerConfig(
      await driver.getState(namespace, KEY),
    );
    expect(described?.error).toEqual({
      at: 123,
      message: 'executionMode "worker-thread" needs a driver config',
      keys: [],
    });

    const h = harness({ jobs: jobsContext(namespace, driver) });
    const res = await h.call("GET", "/runners/keys");
    expect(res.status).toBe(200);
    expect(res.body.config.error.keys).toEqual([]);
  });

  it("sanitises a stored key list: contract order, unknown names dropped", () => {
    expect(
      parseRunnerConfigError(
        JSON.stringify({
          at: 1,
          message: "m",
          keys: ["maxConcurrency", "queueRuns", "executionMode", 7],
        }),
      ),
    ).toEqual({
      at: 1,
      message: "m",
      keys: ["executionMode", "maxConcurrency"],
    });
    expect(
      parseRunnerConfigError(
        JSON.stringify({ at: 1, message: "m", keys: "runMode" }),
      ),
    ).toEqual({ at: 1, message: "m", keys: [] });
    expect(parseRunnerConfigError(JSON.stringify({ at: 1 }))).toBeUndefined();
    expect(parseRunnerConfigError("not json")).toBeUndefined();
    expect(parseRunnerConfigError(undefined)).toBeUndefined();
  });
});
