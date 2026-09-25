import type { DriverConfig } from "../lib/index";
import type { SpawnedProcess } from "./helpers/spawnBun";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { BunRunnerManager, ConfigError, createDriver } from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { spawnBun } from "./helpers/spawnBun";

/**
 * Remote runner configuration across real processes, on every backend.
 *
 * Process A (`runner-owner.ts`) owns the runner and never reconfigures it.
 * This test's process holds no runner at all, only a driver, and changes A's
 * `executionMode` and overlap settings through `BunRunnerManager.controller()`.
 * Every assertion about an effect is read from what A reported, so nothing
 * here can pass by sharing a heap with the owner.
 */

const cleanups: (() => Promise<void>)[] = [];

const READY = await crossProcessBackends({ cleanups });

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** The owner process's script. */
const OWNER = join(import.meta.dir, "fixtures", "processes", "runner-owner.ts");

/** The handler: appends a line per run and returns `marker:runId`. */
const HANDLER = join(import.meta.dir, "fixtures", "handlers", "append.ts");

/** One observation the owner process appended. */
interface Observation {
  /** What happened. */
  event: string;
  /** The owner's pid. */
  pid: number;
  /** The adopted execution mode, on `configured`. */
  executionMode?: string;
  /** The adopted overlap policy, on `configured`. */
  runMode?: string;
  /** The adopted cap, on `configured`. */
  maxConcurrency?: number | null;
  /** Which settings an override is stored for, on `configured`. */
  overridden?: string[];
  /** A refusal or failure message. */
  error?: string;
  /** A failure's message, on `error`. */
  message?: string;
}

/** Starts an owner process and returns it with a reader for its observations. */
async function startOwner(
  config: DriverConfig,
  namespace: string,
  env: Record<string, string>,
): Promise<{
  owner: SpawnedProcess;
  observed: () => Promise<Observation[]>;
}> {
  const tmp = await makeTmpDir("bun-jobs-runner-config");
  cleanups.push(tmp.cleanup);

  const events = join(tmp.path, "events.jsonl");
  const log = join(tmp.path, "runs.log");
  await writeFile(events, "");
  await writeFile(log, "");

  const owner = spawnBun(OWNER, {
    RUNNER_ID: "reports",
    NAMESPACE: namespace,
    DRIVER_CONFIG: JSON.stringify(config),
    HANDLER_FILE: HANDLER,
    EVENTS: events,
    RUN_LOG: log,
    ...env,
  });
  cleanups.push(async () => {
    owner.proc.kill("SIGKILL");
    await owner.exited;
  });

  const observed = async () =>
    (await readFile(events, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Observation);

  await waitFor(
    async () => (await observed()).some((line) => line.event === "ready"),
    {
      timeout: 30_000,
      message: async () => `owner never became ready: ${await owner.errors}`,
    },
  );

  return { owner, observed };
}

/** Waits for the owner to report something matching `match`. */
async function observe(
  observed: () => Promise<Observation[]>,
  label: string,
  match: (line: Observation) => boolean,
): Promise<Observation> {
  let found: Observation | undefined;
  await waitFor(
    async () => {
      found = (await observed()).find(match);
      return found !== undefined;
    },
    {
      timeout: 30_000,
      interval: 20,
      message: async () =>
        `owner never reported ${label}: ${JSON.stringify(await observed())}`,
    },
  );
  return found!;
}

for (const { name, config, available } of READY) {
  describe.skipIf(!available)(
    `remote runner config across processes: ${name}`,
    () => {
      it("reconfigures a runner another process owns", async () => {
        const namespace = testNamespace(`runner-config-${name}`);
        const { owner, observed } = await startOwner(config, namespace, {
          RUNNER_CONTROL: "1",
          // The owner's code forbids `spawn`, so the allow-list is exercised
          // from a process that never saw the option.
          EXECUTION_MODES: "in-process,worker",
        });

        const driver = createDriver(config);
        cleanups.push(() => driver.close());
        const remote = await new BunRunnerManager({
          namespace,
          driver,
          logger: noopLogger,
        }).controller("reports");
        expect(remote.isLocal).toBe(false);

        // What the owner persisted about its configuration, read from here.
        const before = await remote.config();
        expect(before).toMatchObject({
          effective: {
            executionMode: "in-process",
            runMode: "single",
            maxConcurrency: null,
          },
          code: { executionMode: "in-process", runMode: "single" },
          overridden: [],
          allowed: ["worker", "in-process"],
          seq: 0,
        });

        // Refused here, before anything is written: the allow-list came from
        // the owner, not from this process's knowledge of it.
        const refused = await remote
          .updateConfig({ executionMode: "spawn" })
          .catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(ConfigError);
        expect((refused as ConfigError).context).toMatchObject({
          reason: "not-allowed",
        });

        await remote.updateConfig({
          executionMode: "worker",
          concurrency: { runMode: "parallel", maxConcurrency: 2 },
        });

        const adopted = await observe(
          observed,
          "the adopted configuration",
          (line) => line.event === "configured",
        );
        expect(adopted.pid).toBe(owner.proc.pid);
        expect(adopted).toMatchObject({
          executionMode: "worker",
          runMode: "parallel",
          maxConcurrency: 2,
          overridden: ["executionMode", "runMode", "maxConcurrency"],
        });
        expect(adopted.error).toBeUndefined();

        // And the owner wrote the effective values back where every client
        // already looks for them.
        await waitFor(
          async () => (await remote.info()).executionMode === "worker",
          { timeout: 20_000 },
        );
        const after = await remote.config();
        expect(after?.appliedSeq).toBe(after?.seq);
        expect(after?.effective).toEqual({
          executionMode: "worker",
          runMode: "parallel",
          maxConcurrency: 2,
        });

        await remote.resetConfig();
        const reset = await observe(
          observed,
          "the reset",
          (line) => line.event === "configured" && line.runMode === "single",
        );
        expect(reset).toMatchObject({
          executionMode: "in-process",
          runMode: "single",
          overridden: [],
        });

        expect(
          (await observed()).filter((line) => line.event === "error"),
        ).toEqual([]);

        owner.proc.kill("SIGTERM");
        const [exitCode, stderr] = await Promise.all([
          owner.exited,
          owner.errors,
        ]);
        expect([exitCode, stderr]).toEqual([0, ""]);
        await driver.purge(namespace);
      }, 90_000);
    },
  );
}
