import type { BunRunnerOptions, RunRecord } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunRunnerManager,
  ConfigError,
  MemoryDriver,
  newToken,
  NotSupportedError,
  runnerKey,
  RunnerNotFoundError,
} from "../lib/index";
import {
  DEFAULT_STALE_RUN_AFTER,
  planHistoryClear,
} from "../lib/runner/clearHistory";
import { testNamespace, waitFor } from "./helpers";

/**
 * The two clear actions above the driver: `BunQueue.clearJobLogs` and
 * `Job.clearLogs`, and `BunRunner.clearHistory` / `RunnerController.clearHistory`
 * with the rule that decides which runs are still in progress.
 *
 * The driver half — exactly which records and lines go — is the shared
 * contract's (`helpers/driverContract.ts`). What is asserted here is the part
 * only the runner knows: which runs it names for removal.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** Hides one optional driver method, as an older or third-party driver would lack it. */
function without<T extends object>(driver: T, method: string): T {
  Object.defineProperty(driver, method, { value: undefined });
  return driver;
}

/* --- a job's log ------------------------------------------------------ */

describe("clearing a job's log", () => {
  /** A queue on a memory driver. */
  function setup(driver = new MemoryDriver()) {
    const queue = new BunQueue<{ v: number }>("clear-logs", {
      namespace: testNamespace("clear-logs"),
      driver,
      logger: noopLogger,
    });
    closers.push(() => queue.close());
    return { driver, queue };
  }

  it("empties the log through the queue and through the job, and counts from one after", async () => {
    const { queue } = setup();
    const job = await queue.add("x", { v: 1 });
    await job.log("one");
    await job.log("two");

    expect(await queue.clearJobLogs(job.id)).toEqual({
      status: "cleared",
      removed: 2,
    });
    expect(await queue.getJobLogs(job.id)).toEqual({ logs: [], count: 0 });

    // `keepLogs` defaults to 1 000, so the answer is the fresh log's length.
    expect(await job.log("three")).toBe(1);
    expect(await job.clearLogs()).toEqual({ status: "cleared", removed: 1 });
    expect(await job.getLogs()).toEqual({ logs: [], count: 0 });
  });

  it("trims a capped job's fresh log from its own first line", async () => {
    const { queue } = setup();
    const job = await queue.add("x", { v: 1 }, { keepLogs: 2 });
    for (const line of ["a", "b", "c"]) {
      await job.log(line);
    }

    expect(await job.clearLogs()).toEqual({ status: "cleared", removed: 2 });
    expect(await job.log("d")).toBe(1);
    expect(await job.log("e")).toBe(2);
    expect(await job.log("f")).toBe(2);
    expect((await job.getLogs()).logs).toEqual(["e", "f"]);
  });

  it("refuses an active job without removing a line, and answers missing for an unknown id", async () => {
    const { driver, queue } = setup();
    const job = await queue.add("x", { v: 1 });
    await job.log("started");
    const claimed = await driver.claimJob(queue.ref, {
      workerId: "w",
      token: newToken(),
      lockMs: 10_000,
      now: Date.now(),
    });
    expect(claimed?.id).toBe(job.id);

    // The view was read while the job waited; the driver's own check refuses.
    expect(job.state).toBe("waiting");
    expect(await job.clearLogs()).toEqual({ status: "active" });
    expect(await queue.clearJobLogs(job.id)).toEqual({ status: "active" });
    expect(await queue.getJobLogs(job.id)).toEqual({
      logs: ["started"],
      count: 1,
    });

    expect(await queue.clearJobLogs("nobody")).toEqual({ status: "missing" });
  });

  it("throws NotSupportedError on a driver without clearJobLogs, and never falls back", async () => {
    const { queue } = setup(without(new MemoryDriver(), "clearJobLogs"));
    const job = await queue.add("x", { v: 1 });
    await job.log("kept");

    await expect(queue.clearJobLogs(job.id)).rejects.toThrow(NotSupportedError);
    await expect(job.clearLogs()).rejects.toThrow(NotSupportedError);
    expect((await job.getLogs()).count).toBe(1);
  });
});

/* --- which runs are in progress -------------------------------------- */

describe("planHistoryClear", () => {
  const NOW = 1_700_000_000_000;
  const HOUR = 3_600_000;

  /** A record `ageMs` old. */
  function rec(
    runId: string,
    status: RunRecord["status"],
    ageMs: number,
  ): RunRecord {
    return {
      runId,
      runnerId: "r",
      attempt: 1,
      source: "manual",
      mode: "in-process",
      host: "h",
      startedAt: NOW - ageMs,
      status,
    };
  }

  it("removes settled runs and keeps a recent running one", () => {
    expect(
      planHistoryClear({
        records: [
          rec("live", "running", HOUR),
          rec("ok", "success", HOUR),
          rec("bad", "failed", HOUR),
          rec("slow", "timeout", HOUR),
          rec("stopped", "killed", HOUR),
        ],
        now: NOW,
        staleAfter: DEFAULT_STALE_RUN_AFTER,
      }),
    ).toEqual({ remove: ["ok", "bad", "slow", "stopped"], keep: ["live"] });
  });

  it("removes a running record nothing vouches for: a crashed run", () => {
    // Two days old, not executing here, not the lock holder's run.
    expect(
      planHistoryClear({
        records: [rec("crashed", "running", 48 * HOUR)],
        now: NOW,
        staleAfter: DEFAULT_STALE_RUN_AFTER,
      }),
    ).toEqual({ remove: ["crashed"], keep: [] });
    // The same record is kept while the runner's lock is live and names it...
    expect(
      planHistoryClear({
        records: [rec("crashed", "running", 48 * HOUR)],
        lockedRunId: "crashed",
        now: NOW,
        staleAfter: DEFAULT_STALE_RUN_AFTER,
      }),
    ).toEqual({ remove: [], keep: ["crashed"] });
    // ...but a live lock vouches only for a record still running.
    expect(
      planHistoryClear({
        records: [rec("done", "success", 48 * HOUR)],
        lockedRunId: "done",
        now: NOW,
        staleAfter: DEFAULT_STALE_RUN_AFTER,
      }),
    ).toEqual({ remove: ["done"], keep: [] });
  });

  it("keeps whatever this process is executing, whatever its record says or its age", () => {
    expect(
      planHistoryClear({
        records: [
          rec("mine", "running", 48 * HOUR),
          rec("old", "running", 48 * HOUR),
        ],
        local: new Set(["mine"]),
        now: NOW,
        staleAfter: 0,
      }),
    ).toEqual({ remove: ["old"], keep: ["mine"] });
  });

  it("bounds a running record by staleAfter, exclusive", () => {
    const plan = (staleAfter: number) =>
      planHistoryClear({
        records: [rec("r", "running", HOUR)],
        now: NOW,
        staleAfter,
      });
    expect(plan(HOUR + 1)).toEqual({ remove: [], keep: ["r"] });
    expect(plan(HOUR)).toEqual({ remove: ["r"], keep: [] });
    expect(DEFAULT_STALE_RUN_AFTER).toBe(24 * HOUR);
  });
});

/* --- a runner's history ----------------------------------------------- */

describe("clearing a runner's history", () => {
  /** The gated fixture: returns its marker, and with `hold` waits for "release". */
  const GATED = join(import.meta.dir, "fixtures", "handlers", "gated.ts");

  /** An owning manager, an observing one standing in for another process, and their driver. */
  function cluster(driver = new MemoryDriver()) {
    const namespace = testNamespace("clear-history");
    return {
      driver,
      namespace,
      owner: new BunRunnerManager({ namespace, driver, logger: noopLogger }),
      observer: new BunRunnerManager({ namespace, driver, logger: noopLogger }),
    };
  }

  /** What the gated fixture takes. */
  interface Gated {
    /** Returned as the run's result. */
    marker?: string;
    /** Wait for a `"release"` message before returning. */
    hold?: boolean;
  }

  /** Registers the gated runner, started, with quiet test defaults. */
  async function addRunner(
    manager: BunRunnerManager,
    options: Partial<Omit<BunRunnerOptions<Gated>, "namespace">> = {},
  ) {
    const runner = manager.add<Gated, string>({
      id: "history",
      file: GATED,
      executionMode: "in-process",
      waitToExit: false,
      syncInterval: 0,
      ...options,
    });
    closers.push(() => runner.stop({ force: true }));
    await runner.start();
    return runner;
  }

  /** Runs `count` quick runs to completion. */
  async function finishRuns(
    runner: Awaited<ReturnType<typeof addRunner>>,
    count: number,
  ): Promise<void> {
    for (let index = 0; index < count; index++) {
      const finished = new Promise<void>((resolve) => {
        runner.once("finished", () => resolve());
      });
      await runner.trigger({ args: { marker: `done-${index}` } });
      await finished;
    }
  }

  /** Starts a held run and answers its id once its record is written. */
  async function holdRun(
    runner: Awaited<ReturnType<typeof addRunner>>,
  ): Promise<string> {
    const started = new Promise<string>((resolve) => {
      runner.once("started", (record) => resolve(record.runId));
    });
    await runner.trigger({ args: { marker: "live", hold: true } });
    return await started;
  }

  it("removes finished runs and keeps a run this process is executing, record and log", async () => {
    const { driver, namespace, owner } = cluster();
    // Parallel: no lock, so nothing but "this process runs it" can vouch for
    // the run once `staleAfter` is 0.
    const runner = await addRunner(owner, { runMode: "parallel" });
    await finishRuns(runner, 2);
    const live = await holdRun(runner);
    const key = runnerKey("history");
    await driver.appendRunLog(
      namespace,
      key,
      live,
      [{ stream: "stdout", at: Date.now(), text: "first words" }],
      { maxLines: 0, maxBytes: 0, keepRuns: 0 },
    );
    const statsBefore = await runner.stats();

    const result = await runner.clearHistory({ staleAfter: 0 });

    expect(result).toEqual({ removed: 2, kept: [live] });
    const history = await runner.history();
    expect(history.map((record) => record.runId)).toEqual([live]);
    expect(history[0]?.status).toBe("running");
    const page = await driver.getRunLog(namespace, key, live, {
      offset: 0,
      limit: 10,
      order: "asc",
    });
    expect(page.lines.map((line) => line.text)).toEqual(["first words"]);
    // Lifetime counters are not the history's to clear.
    expect(await runner.stats()).toEqual(statsBefore);
    expect(statsBefore.success).toBe(2);

    // The kept run settles into the record it kept.
    runner.send("release");
    await waitFor(
      async () => (await runner.history())[0]?.status === "success",
    );
    expect((await runner.history()).map((record) => record.runId)).toEqual([
      live,
    ]);
  });

  it("from another process, keeps a run by its stored status alone — and only that", async () => {
    const { owner, observer } = cluster();
    const runner = await addRunner(owner, { runMode: "parallel" });
    await finishRuns(runner, 1);
    const live = await holdRun(runner);

    const remote = await observer.controller("history");
    expect(remote.isLocal).toBe(false);

    // A recent `running` record is in progress by default...
    expect(await remote.clearHistory()).toEqual({ removed: 1, kept: [live] });
    // ...and with nothing but its age to go on, a remote caller that says a
    // run this young is stale gets what it asked for.
    expect(await remote.clearHistory({ staleAfter: 0 })).toEqual({
      removed: 1,
      kept: [],
    });
    expect(await runner.history()).toEqual([]);

    // The run carries on; its settle finds no record, and nothing breaks.
    runner.send("release");
    await waitFor(() => runner.activeRuns.size === 0);
    expect((await runner.stats()).success).toBe(2);
  });

  it("from another process, keeps the single-mode lock holder's run however old", async () => {
    const { owner, observer } = cluster();
    const runner = await addRunner(owner);
    await finishRuns(runner, 1);
    const live = await holdRun(runner);

    const remote = await observer.controller("history");
    // `staleAfter: 0` takes age out of it: only the live lock vouches.
    expect(await remote.clearHistory({ staleAfter: 0 })).toEqual({
      removed: 1,
      kept: [live],
    });
    runner.send("release");
    await waitFor(() => runner.activeRuns.size === 0);
  });

  it("clears a crashed run's record once nothing vouches for it", async () => {
    const { driver, namespace, observer } = cluster();
    const key = runnerKey("history");
    const crashedAt = Date.now() - 2 * DEFAULT_STALE_RUN_AFTER;
    // What a process that died mid-run leaves: state, a `running` record, and
    // an expired lock naming its run.
    await driver.setState(namespace, key, {
      name: "history",
      lastRunId: "crashed",
    });
    await driver.appendHistory(
      namespace,
      key,
      {
        runId: "crashed",
        runnerId: "history",
        attempt: 1,
        source: "schedule",
        mode: "child-process",
        host: "gone",
        startedAt: crashedAt,
        status: "running",
      },
      0,
    );
    expect(
      await driver.acquireLock(namespace, key, newToken(), 1, crashedAt),
    ).toBe(true);

    const remote = await observer.controller("history");
    expect(await remote.clearHistory()).toEqual({ removed: 1, kept: [] });
    expect(await remote.history()).toEqual([]);
  });

  it("never touches the counters, the state or the queued triggers", async () => {
    const { driver, namespace, owner } = cluster();
    const runner = await addRunner(owner);
    await finishRuns(runner, 3);
    const key = runnerKey("history");
    const state = await driver.getState(namespace, key);

    expect(await runner.clearHistory()).toEqual({ removed: 3, kept: [] });
    expect(await driver.getState(namespace, key)).toEqual(state);
    expect((await runner.stats()).success).toBe(3);
  });

  it("throws NotSupportedError on a driver without removeRuns, rather than dropping everything", async () => {
    const driver = without(new MemoryDriver(), "removeRuns");
    const { owner, observer } = cluster(driver);
    const runner = await addRunner(owner, { runMode: "parallel" });
    await finishRuns(runner, 1);

    await expect(runner.clearHistory()).rejects.toThrow(NotSupportedError);
    const remote = await observer.controller("history");
    await expect(remote.clearHistory()).rejects.toThrow(NotSupportedError);
    expect(await runner.history()).toHaveLength(1);
  });

  it("refuses a bad staleAfter, and an unknown runner", async () => {
    const { owner, observer } = cluster();
    const runner = await addRunner(owner);

    for (const staleAfter of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runner.clearHistory({ staleAfter })).rejects.toThrow(
        ConfigError,
      );
    }
    await expect(observer.controller("nobody")).rejects.toThrow(
      RunnerNotFoundError,
    );
  });
});
