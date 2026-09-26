import type { DriverConfig, ExecutionMode } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunRunner,
  BunRunnerManager,
  ConfigError,
  MemoryDriver,
  RUNNER_CONFIG_STATE,
  runnerKey,
} from "../lib/index";
import {
  readStoredRunnerConfig,
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
 * B17: a runner built from a driver *instance* published every mode in
 * `allowedOverrides.executionModes` as `allowed`, so the management API (and the
 * UI) accepted `worker-thread` or `child-process` — which the owner then always refused,
 * having no driver config to hand a child. It now publishes only the modes it
 * can adopt, and a controller refuses the rest before writing anything.
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

/** A started owner over `driver`, in-process by code, permitting in-process and worker. */
async function owner(
  driver: MemoryDriver,
  namespace: string,
  options: {
    childDriver?: DriverConfig;
    executionMode?: ExecutionMode;
    executionModes?: ExecutionMode[];
  } = {},
): Promise<BunRunner<any, any>> {
  const runner = new BunRunner({
    id: "b17",
    namespace,
    driver,
    file: ECHO_HANDLER,
    executionMode: options.executionMode ?? "in-process",
    allowedOverrides: {
      executionModes: options.executionModes ?? ["in-process", "worker-thread"],
    },
    ...(options.childDriver ? { childDriver: options.childDriver } : {}),
    waitToExit: false,
    syncInterval: 25,
    logger: noopLogger,
  });
  started.push(runner);
  await runner.start();
  return runner;
}

/** What the owner persisted as `config:allowed`. */
async function storedAllowed(
  driver: MemoryDriver,
  namespace: string,
): Promise<ExecutionMode[] | undefined> {
  return readStoredRunnerConfig(
    await driver.getState(namespace, runnerKey("b17")),
  ).allowed;
}

describe("B17: allowed lists only the modes an owner can adopt", () => {
  it("leaves out child modes for a runner built from a driver instance", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("b17");
    const runner = await owner(driver, namespace, {
      executionModes: ["child-process", "worker-thread", "in-process"],
    });

    expect(runner.config.allowed).toEqual(["in-process"]);
    expect(await storedAllowed(driver, namespace)).toEqual(["in-process"]);
  });

  it("keeps worker and spawn for a runner with a driver config for its child", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("b17");
    const runner = await owner(driver, namespace, {
      childDriver: { type: "memory" },
      executionModes: ["child-process", "worker-thread", "in-process"],
    });

    expect(runner.config.allowed).toEqual([
      "child-process",
      "worker-thread",
      "in-process",
    ]);
    expect(await storedAllowed(driver, namespace)).toEqual([
      "child-process",
      "worker-thread",
      "in-process",
    ]);
  });

  it("keeps the code's own child mode, which needs no switch", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("b17");
    const runner = await owner(driver, namespace, {
      executionMode: "worker-thread",
      executionModes: ["child-process", "worker-thread", "in-process"],
    });

    expect(runner.config.allowed).toEqual(["worker-thread", "in-process"]);
  });

  it("publishes an empty list, and it is read back as empty, when no permitted mode can be adopted", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("b17");
    const runner = await owner(driver, namespace, {
      executionModes: ["child-process", "worker-thread"],
    });

    expect(runner.config.allowed).toEqual([]);
    // Not dropped as "unknown", which would let anything through.
    expect(await storedAllowed(driver, namespace)).toEqual([]);
    const manager = new BunRunnerManager({
      namespace,
      driver,
      logger: noopLogger,
    });
    const remote = await manager.controller("b17");
    await expect(
      remote.updateConfig({ executionMode: "worker-thread" }),
    ).rejects.toThrow(ConfigError);
  });

  it("refuses locally, before writing, what the owner could not adopt", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("b17");
    const runner = await owner(driver, namespace);
    const before = runner.config.seq;

    let caught: unknown;
    try {
      await runner.updateConfig({ executionMode: "worker-thread" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).context).toMatchObject({
      reason: "not-allowed",
      allowed: ["in-process"],
    });
    expect(runner.config.seq).toBe(before);
  });

  it("still refuses, with the specific reason, an override stored before the owner started", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("b17");
    // Written raw, as an older controller that trusted the old list would have.
    await driver.connect();
    await writeRunnerConfig(driver, namespace, runnerKey("b17"), {
      [RUNNER_CONFIG_STATE.executionMode]: "worker-thread",
    });
    const runner = await owner(driver, namespace);

    await waitFor(() => runner.config.error !== undefined, {
      timeout: 4000,
      message: () => JSON.stringify(runner.config),
    });
    expect(runner.executionMode).toBe("in-process");
    expect(runner.config.error?.message).toContain("driver config");
  });
});

describe("B17: the management API refuses up front", () => {
  const body = {
    executionMode: "worker-thread",
    concurrency: { runMode: "parallel", maxConcurrency: 3 },
  };

  it("answers 409 CONFIG_NOT_ALLOWED for a local instance-built runner, writing nothing", async () => {
    const namespace = testNamespace("b17-api");
    const jobs = jobsContext(namespace);
    const h = harness({ jobs });
    const runner = h.jobs.runner({
      id: "b17",
      file: ECHO_HANDLER,
      executionMode: "in-process",
      allowedOverrides: { executionModes: ["in-process", "worker-thread"] },
    });

    const res = await h.call("PUT", "/runners/b17/config", body);
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 409,
      code: "CONFIG_NOT_ALLOWED",
    });
    expect(res.body.context).toMatchObject({
      runner: "b17",
      executionMode: "worker-thread",
      allowed: ["in-process"],
    });

    expect(runner.config.allowed).toEqual(["in-process"]);
    expect(runner.config.overridden).toEqual([]);
    expect(runner.config.seq).toBe(0);
  });

  it("answers 409 CONFIG_NOT_ALLOWED for an instance-built runner owned by another process", async () => {
    const namespace = testNamespace("b17-api");
    const driver = new MemoryDriver();
    await owner(driver, namespace);
    // A context that does not own the runner: the route goes through what
    // the owner persisted, `config:allowed`.
    const h = harness({ jobs: jobsContext(namespace, driver) });

    const res = await h.call("PUT", "/runners/b17/config", body);
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 409,
      code: "CONFIG_NOT_ALLOWED",
    });
    expect(res.body.context).toMatchObject({
      runner: "b17",
      executionMode: "worker-thread",
      allowed: ["in-process"],
    });
  });

  it("still accepts worker for a runner with a driver config for its child", async () => {
    const namespace = testNamespace("b17-api");
    const driver = new MemoryDriver();
    await owner(driver, namespace, { childDriver: { type: "memory" } });
    const h = harness({ jobs: jobsContext(namespace, driver) });

    const res = await h.call("PUT", "/runners/b17/config", body);
    expect(res.status).toBe(200);
    expect(res.body.allowed).toEqual(["worker-thread", "in-process"]);
  });
});
