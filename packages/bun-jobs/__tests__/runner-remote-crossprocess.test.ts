import type { DriverConfig } from "../lib/index";
import type { SpawnedProcess } from "./helpers/spawnBun";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { BunRunnerManager, createDriver } from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { spawnBun } from "./helpers/spawnBun";

/** One observation the owner process appended. */
interface Observation {
  /** What happened: `ready`, `paused`, `resumed`, `scheduled`, `finished`, … */
  event: string;
  /** The owner's pid. */
  pid: number;
  /** The run's source, on `finished`. */
  source?: string;
  /** The run's result, on `finished`. */
  result?: string;
  /** The owner's schedule, on `scheduled`. */
  schedule?: unknown;
  /** A failure's message, on `error`. */
  message?: string;
}

/**
 * Remote control across real processes.
 *
 * Process A (`runner-owner.ts`) owns the runner and never touches it. This
 * test's own process is B: it holds no runner at all, only a driver, and
 * pauses, resumes, reschedules and triggers A's runner through
 * `BunRunnerManager.controller()`. Every assertion about an effect is read from
 * what A reported, so nothing here can pass by sharing a heap with the owner.
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

/** Starts an owner process and returns it with a reader for its observations. */
async function startOwner(
  config: DriverConfig,
  namespace: string,
  env: Record<string, string>,
): Promise<{
  owner: SpawnedProcess;
  observed: () => Promise<Observation[]>;
  log: string;
}> {
  const tmp = await makeTmpDir("bun-jobs-remote");
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

  return { owner, observed, log };
}

/** Stops the owner with `SIGTERM` and checks it exited cleanly. */
async function stopOwner(owner: SpawnedProcess): Promise<void> {
  owner.proc.kill("SIGTERM");
  const [exitCode, stderr] = await Promise.all([owner.exited, owner.errors]);
  expect([exitCode, stderr]).toEqual([0, ""]);
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
  describe.skipIf(!available)(`remote runner across processes: ${name}`, () => {
    it("controls a runner another process owns", async () => {
      const namespace = testNamespace(`remote-${name}`);
      const { owner, observed, log } = await startOwner(config, namespace, {
        RUNNER_CONTROL: "1",
      });

      const driver = createDriver(config);
      cleanups.push(() => driver.close());
      const manager = new BunRunnerManager({
        namespace,
        driver,
        logger: noopLogger,
      });

      const remote = await manager.controller<
        { marker?: string; log?: string; ms?: number },
        string
      >("reports");
      expect(remote.isLocal).toBe(false);

      // What the owner persisted, read from here.
      expect(await remote.info()).toMatchObject({
        id: "reports",
        name: "reports",
        file: HANDLER,
        schedule: { every: 3_600_000 },
        executionMode: "in-process",
        runMode: "single",
        isPaused: false,
        isRunning: false,
        queuedTriggers: 0,
      });

      await remote.pause();
      await observe(observed, "paused", (line) => line.event === "paused");
      expect((await remote.info()).isPaused).toBe(true);
      expect(await remote.trigger()).toEqual({
        outcome: "skipped",
        reason: "paused",
      });

      await remote.updateSchedule({ cron: "0 3 * * *", tz: "UTC" });
      await observe(
        observed,
        "the new schedule",
        (line) =>
          line.event === "scheduled" &&
          JSON.stringify(line.schedule) ===
            JSON.stringify({ cron: "0 3 * * *", tz: "UTC" }),
      );

      await remote.resume();
      await observe(observed, "resumed", (line) => line.event === "resumed");

      const outcome = await remote.trigger({
        args: { marker: "remote", log, ms: 20 },
      });
      expect(outcome).toEqual({ outcome: "queued", position: 1 });

      // It ran in the owner, with this process's arguments.
      const finished = await observe(
        observed,
        "the triggered run",
        (line) => line.event === "finished",
      );
      expect(finished.pid).toBe(owner.proc.pid);
      expect(finished.pid).not.toBe(process.pid);
      expect(finished.source).toBe("queued");
      expect(finished.result?.startsWith("remote:")).toBe(true);
      expect(
        (await readFile(log, "utf8")).split("\n").filter(Boolean),
      ).toHaveLength(1);

      const history = await remote.history();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        source: "queued",
        status: "success",
        result: finished.result,
      });

      // The last write happens after `finished` is emitted.
      await waitFor(async () => (await remote.stats()).success === 1, {
        timeout: 10_000,
      });
      expect(await remote.stats()).toMatchObject({
        success: 1,
        queued: 1,
        skipped: 1,
        total: 1,
      });

      expect(
        (await observed()).filter((line) => line.event === "error"),
      ).toEqual([]);
      await stopOwner(owner);
      await driver.purge(namespace);
    }, 90_000);
  });
}

describe("remote runner across processes: without control", () => {
  it("is adopted at the owner's next sync", async () => {
    const tmp = await makeTmpDir("bun-jobs-remote-sync");
    cleanups.push(tmp.cleanup);
    const config: DriverConfig = {
      type: "file",
      root: join(tmp.path, "driver"),
    };
    const namespace = testNamespace("remote-sync");

    const { owner, observed } = await startOwner(config, namespace, {
      RUNNER_CONTROL: "0",
      SYNC_INTERVAL: "200",
    });

    const driver = createDriver(config);
    cleanups.push(() => driver.close());
    const remote = await new BunRunnerManager({ namespace, driver }).controller(
      "reports",
    );

    const pausedAt = Date.now();
    await remote.pause();
    await observe(observed, "paused", (line) => line.event === "paused");
    // Polled: it waited for a sync, but no longer than a couple of them.
    expect(Date.now() - pausedAt).toBeLessThan(5_000);

    await remote.resume({ triggerNow: true });
    const finished = await observe(
      observed,
      "the triggered run",
      (line) => line.event === "finished",
    );
    expect(finished.source).toBe("queued");
    expect(finished.result?.startsWith("default:")).toBe(true);

    await stopOwner(owner);
  }, 60_000);
});
