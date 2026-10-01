import type { DriverConfig, SummonEventPayload } from "../../lib/index";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  BunJobs,
  BunQueue,
  createDriver,
  SummonController,
} from "../../lib/index";
import { localCompute } from "../../lib/provider/index";
import { liveUnits } from "../../lib/providers/local/units";
import { makeTmpDir } from "../helpers";

/**
 * A real summon, end to end on SQLite: a queue with a backlog, a
 * `SummonController` with `localCompute`, a summoned child process that
 * registers, processes every job, exits once idle, and leaves no process
 * behind. Once through a controller by hand, once through `BunJobs`'s
 * `summon` option with the add trigger.
 */

setDefaultTimeout(120_000);

const WORKER = join(import.meta.dir, "../fixtures/local/worker.ts");

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/** A SQLite backend in a temporary directory. */
async function sqlite(): Promise<{ dir: string; config: DriverConfig }> {
  const dir = await makeTmpDir("bun-jobs-local-summon");
  cleanups.push(dir.cleanup);
  return {
    dir: dir.path,
    config: { type: "sql", url: `sqlite://${join(dir.path, "jobs.db")}` },
  };
}

/** The `processed <id> <pid>` lines the summoned workers wrote to `file`. */
function processed(file: string): { id: string; pid: number }[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("processed "))
    .map((line) => {
      const [, id, pid] = line.split(" ");
      return { id: id!, pid: Number(pid) };
    });
}

/** Whether a process exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `fn` until it holds or `withinMs` passes, answering whether it held. */
async function until(
  fn: () => boolean | Promise<boolean>,
  withinMs = 30_000,
): Promise<boolean> {
  const by = Date.now() + withinMs;
  while (Date.now() < by) {
    if (await fn()) {
      return true;
    }
    await Bun.sleep(50);
  }
  return await fn();
}

describe("localCompute: a real summon on SQLite", () => {
  it("summons a child that registers, drains the queue, exits when idle and leaves nothing behind", async () => {
    const { dir, config } = await sqlite();
    const log = join(dir, "units.log");
    const driver = createDriver(config);
    await driver.connect();
    const namespace = "local-e2e";
    const queue = new BunQueue("emails", {
      namespace,
      driver,
      logger: noopLogger,
    });
    await queue.addBulk(
      Array.from({ length: 6 }, (_, index) => ({
        name: "send",
        data: { index },
      })),
    );
    const summoner = localCompute({
      entry: WORKER,
      output: { file: log },
      maxUnits: 2,
      shutdown: { graceMs: 2_000 },
    });
    const controller = new SummonController({
      driver,
      namespace,
      queue: "emails",
      summoner,
      triggers: { onAdd: false, events: false, poll: false },
      cooldown: 0,
      env: {
        LOCAL_TEST_DRIVER: JSON.stringify(config),
        LOCAL_TEST_IDLE_MS: "500",
      },
      logger: noopLogger,
    });
    const events: SummonEventPayload[] = [];
    controller.on("summon", (event) => events.push(event));
    try {
      const first = await controller.check();
      expect(first).toMatchObject({ action: "summoned", outcome: "started" });
      const attempt = (first as { id: string }).id;
      const handles =
        events.find(
          (event) => event.id === attempt && event.outcome === "started",
        )?.handles ?? [];
      expect(handles).toHaveLength(1);

      // The child registers: the controller releases the attempt by its id.
      expect(
        await until(async () => {
          await controller.check();
          return events.some(
            (event) => event.id === attempt && event.outcome === "registered",
          );
        }),
      ).toBe(true);

      // It drains the backlog, every job in one process.
      expect(await until(() => processed(log).length >= 6)).toBe(true);
      expect(
        await until(async () => (await queue.getDemand()).outstanding === 0),
      ).toBe(true);
      const pids = new Set(processed(log).map((line) => line.pid));
      expect(pids.size).toBe(1);
      const [pid] = [...pids];
      expect(pid).not.toBe(process.pid);

      // Idle, it exits 0 on its own, and the process is gone.
      expect(
        await until(async () => {
          const [unit] = await summoner.summon.status!(handles, {
            signal: new AbortController().signal,
            logger: noopLogger,
            fetch,
            now: Date.now,
          });
          return unit?.state === "exited";
        }),
      ).toBe(true);
      const [unit] = await summoner.summon.status!(handles, {
        signal: new AbortController().signal,
        logger: noopLogger,
        fetch,
        now: Date.now,
      });
      expect(unit).toEqual({
        handle: handles[0]!,
        state: "exited",
        exitCode: 0,
      });
      expect(alive(pid!)).toBe(false);

      // Nothing is left: no demand, no attempt in flight, no unit running.
      expect((await controller.check()).action).toBe("none");
      expect((await controller.status()).pending).toEqual([]);
      expect(await until(() => liveUnits().count === 0, 5_000)).toBe(true);
    } finally {
      await controller.close();
      await queue.close();
      await driver.purge(namespace).catch(() => {});
      await driver.close();
    }
  });

  it("summons on add through BunJobs's summon option", async () => {
    const { dir, config } = await sqlite();
    const log = join(dir, "units.log");
    const jobs = new BunJobs({
      namespace: "local-e2e-jobs",
      driver: config,
      logger: noopLogger,
      summon: {
        emails: {
          summoner: localCompute({
            entry: WORKER,
            output: { file: log },
            shutdown: { graceMs: 2_000 },
          }),
          triggers: { poll: false, debounce: 0 },
          env: {
            LOCAL_TEST_DRIVER: JSON.stringify(config),
            LOCAL_TEST_IDLE_MS: "500",
          },
        },
      },
    });
    try {
      const queue = jobs.queue("emails");
      await queue.add("send", { to: "a@example.test" });
      await queue.add("send", { to: "b@example.test" });
      expect(await until(() => processed(log).length >= 2)).toBe(true);
      const [pid] = [...new Set(processed(log).map((line) => line.pid))];
      expect(await until(() => !alive(pid!))).toBe(true);
      expect(await until(() => liveUnits().count === 0, 5_000)).toBe(true);
    } finally {
      await jobs.close();
    }
  });
});
