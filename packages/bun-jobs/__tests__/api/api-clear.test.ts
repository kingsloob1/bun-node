import type {
  BunJobs,
  BunRunner,
  JobsDriver,
  RunRecord,
} from "../../lib/index";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { CLEAR_HISTORY_STALE_AFTER } from "../../lib/api/schemas/runners";
import {
  DEFAULT_STALE_RUN_AFTER,
  MemoryDriver,
  newToken,
  runnerKey,
} from "../../lib/index";
import { waitFor } from "../helpers";
import { harness, jobsContext, openContexts, openHarnesses } from "./fixtures";

/**
 * The two clear routes end to end, through the API over a real `BunJobs` on
 * the memory driver: `DELETE /queues/:queue/jobs/:id/logs` and
 * `DELETE /runners/:runner/history`.
 *
 * Every driver here counts calls to the driver's own `clearHistory`, which
 * drops every run, in progress or not. The route must never reach it, so each
 * test that clears history asserts the count stays at zero.
 */

const TICK = new URL("./handlers/tick.ts", import.meta.url);
const DAY = 86_400_000;

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
});

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

/** A memory driver that counts calls to its whole-history `clearHistory`. */
function countingDriver() {
  const driver = new MemoryDriver();
  const counts = { clearHistory: 0 };
  const original = driver.clearHistory.bind(driver);
  driver.clearHistory = async (ns, key) => {
    counts.clearHistory += 1;
    await original(ns, key);
  };
  return { driver, counts };
}

/** Hides one optional driver method, as an older or third-party driver would lack it. */
function without<T extends object>(driver: T, method: string): T {
  Object.defineProperty(driver, method, { value: undefined });
  return driver;
}

/** A harness over a fresh namespace on `driver`. */
function clearHarness(driver: JobsDriver = new MemoryDriver(), overrides = {}) {
  const namespace = `api-clear-${newToken().slice(0, 8)}`;
  return harness({ jobs: jobsContext(namespace, driver), ...overrides });
}

/* --- a job's log ------------------------------------------------------ */

describe("DELETE /queues/:queue/jobs/:id/logs", () => {
  /** A job run to completion by a real worker that logged `lines` lines. */
  async function finishedJob(jobs: BunJobs, lines: number) {
    const queue = jobs.queue("mail");
    const worker = jobs.worker("mail", async (job) => {
      for (let index = 1; index <= lines; index++) {
        await job.log(`line ${index}`);
      }
      return "sent";
    });
    cleanups.push(() => worker.close({ force: true }));
    void worker.run();
    const job = await queue.add("send", { to: "a@b.c" });
    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
    );
    await worker.close();
    return { queue, job: (await queue.getJob(job.id))! };
  }

  it("empties a finished job's log, and the next line counts from one", async () => {
    const h = clearHarness();
    const { queue, job } = await finishedJob(h.jobs, 3);
    const countsBefore = await h.call("GET", "/queues/mail/counts");

    const before = await h.call("GET", `/queues/mail/jobs/${job.id}/logs`);
    expect(before.body.page.total).toBe(3);

    const cleared = await h.call("DELETE", `/queues/mail/jobs/${job.id}/logs`);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ removed: 3 });

    const after = await h.call("GET", `/queues/mail/jobs/${job.id}/logs`);
    expect(after.body.items).toEqual([]);
    expect(after.body.page.total).toBe(0);

    // A fresh log: the next line is its first.
    expect(await job.log("again")).toBe(1);
    const fresh = await h.call("GET", `/queues/mail/jobs/${job.id}/logs`);
    expect(fresh.body.items).toEqual(["again"]);
    expect(fresh.body.page.total).toBe(1);

    // The job and the queue's figures are untouched.
    const reread = (await queue.getJob(job.id))!;
    expect(reread.state).toBe("completed");
    expect(reread.returnValue).toBe("sent");
    expect(reread.attemptsMade).toBe(job.attemptsMade);
    expect((await h.call("GET", "/queues/mail/counts")).body).toEqual(
      countsBefore.body,
    );

    // A job that never logged clears to zero, still a success.
    const quiet = await queue.add("send", {});
    expect(
      (await h.call("DELETE", `/queues/mail/jobs/${quiet.id}/logs`)).body,
    ).toEqual({ removed: 0 });
  });

  it("is 409 JOB_ACTIVE while a worker runs the job, with nothing removed", async () => {
    const h = clearHarness();
    const queue = h.jobs.queue("mail");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = h.jobs.worker("mail", async (job) => {
      await job.log("started");
      await gate;
      await job.log("finished");
      return 1;
    });
    cleanups.push(() => worker.close({ force: true }));
    void worker.run();
    const job = await queue.add("send", {});
    await waitFor(async () => (await queue.getJobLogs(job.id)).count === 1);
    expect((await queue.getJob(job.id))?.state).toBe("active");

    const refused = await h.call("DELETE", `/queues/mail/jobs/${job.id}/logs`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("JOB_ACTIVE");
    expect(refused.body.context).toEqual({ state: "active" });
    expect(await queue.getJobLogs(job.id)).toEqual({
      logs: ["started"],
      count: 1,
    });

    // Once the attempt settles the same request succeeds, whole log and all.
    release();
    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
    );
    const cleared = await h.call("DELETE", `/queues/mail/jobs/${job.id}/logs`);
    expect(cleared.body).toEqual({ removed: 2 });
  });

  it("is refused by the driver's own step for a job claimed after it was read", async () => {
    // No worker: the job is claimed straight on the driver, so the only thing
    // standing between the request and the log is the driver's check.
    const h = clearHarness();
    const queue = h.jobs.queue("mail");
    const job = await queue.add("send", {});
    await job.log("kept");
    const claimed = await h.jobs.driver.claimJob(queue.ref, {
      workerId: "w",
      token: newToken(),
      lockMs: 10_000,
      now: Date.now(),
    });
    expect(claimed?.id).toBe(job.id);

    const refused = await h.call("DELETE", `/queues/mail/jobs/${job.id}/logs`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("JOB_ACTIVE");
    expect((await queue.getJobLogs(job.id)).count).toBe(1);
  });

  it("is 404 for a missing job or queue, and authorizes on queue and job id", async () => {
    const h = clearHarness();
    await h.jobs.queue("mail").add("send", {}, { jobId: "real" });

    const missing = await h.call("DELETE", "/queues/mail/jobs/nobody/logs");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("JOB_NOT_FOUND");

    const noQueue = await h.call("DELETE", "/queues/ghost/jobs/real/logs");
    expect(noQueue.status).toBe(404);
    expect(noQueue.body.code).toBe("QUEUE_NOT_FOUND");

    await h.call("DELETE", "/queues/mail/jobs/real/logs");
    expect(h.calls.at(-1)).toMatchObject({
      action: "jobs.clearLogs",
      mutation: true,
      transport: "http",
      queue: "mail",
      jobId: "real",
      route: { method: "DELETE", path: "/queues/:queue/jobs/:id/logs" },
    });
  });

  it("is pruned, never a 501, on a driver without clearJobLogs", async () => {
    const h = clearHarness(without(new MemoryDriver(), "clearJobLogs"));
    const job = await h.jobs.queue("mail").add("send", {});
    await job.log("kept");

    expect(
      h.api.routes.some((route) => route.action === "jobs.clearLogs"),
    ).toBe(false);
    const permissions = await h.call("GET", "/meta/permissions");
    expect("jobs.clearLogs" in permissions.body.actions).toBe(false);
    const answered = await h.call("DELETE", `/queues/mail/jobs/${job.id}/logs`);
    expect(answered.status).toBe(404);
    expect((await job.getLogs()).count).toBe(1);
  });

  it("is listed in /meta/permissions, and readOnly removes it", async () => {
    const h = clearHarness();
    const permissions = await h.call("GET", "/meta/permissions");
    expect(permissions.body.actions["jobs.clearLogs"]).toBe(true);
    expect(permissions.body.actions["runners.clearHistory"]).toBe(true);

    const readOnly = clearHarness(new MemoryDriver(), { readOnly: true });
    const actions = new Set(readOnly.api.routes.map((route) => route.action));
    expect(actions.has("jobs.clearLogs")).toBe(false);
    expect(actions.has("runners.clearHistory")).toBe(false);
  });
});

/* --- a runner's history ----------------------------------------------- */

describe("DELETE /runners/:runner/history", () => {
  /** Two finished runs, then one in progress whose log keeps growing. */
  async function withRunInProgress(
    runner: BunRunner<{ gap?: number; quick?: boolean }, number>,
  ) {
    for (let index = 0; index < 2; index++) {
      await runner.trigger({ args: { quick: true } });
      await waitFor(async () => {
        const history = await runner.history();
        return history.filter((run) => run.status !== "running").length > index;
      });
    }
    const started = await runner.trigger({ args: { gap: 10 } });
    expect(started.outcome).toBe("started");
    const runId = (started as { runId: string }).runId;
    return runId;
  }

  /** The run's log through the API. */
  async function runLog(
    h: ReturnType<typeof harness>,
    runner: string,
    runId: string,
  ) {
    const page = await h.call("GET", `/runners/${runner}/runs/${runId}/logs`);
    expect(page.status).toBe(200);
    return page.body as {
      items: { seq: number; message: string }[];
      lastSeq: number;
      live: boolean;
    };
  }

  it("removes the finished runs and keeps the run in progress, whose log keeps growing", async () => {
    const { driver, counts } = countingDriver();
    const h = clearHarness(driver);
    const runner = h.jobs.runner<{ gap?: number; quick?: boolean }, number>({
      id: "nightly",
      file: TICK,
      executionMode: "in-process",
    });
    cleanups.push(() => runner.stop({ force: true }));
    const runId = await withRunInProgress(runner);
    await waitFor(async () => (await runLog(h, "nightly", runId)).lastSeq >= 3);
    const finished = (await runner.history())
      .filter((run) => run.status !== "running")
      .map((run) => run.runId);
    expect(finished).toHaveLength(2);
    const statsBefore = await h.call("GET", "/runners/nightly/stats");

    const cleared = await h.call("DELETE", "/runners/nightly/history");
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ removed: 2, kept: [runId] });

    // The finished runs are gone, record and log.
    const history = await h.call("GET", "/runners/nightly/history");
    expect(history.body.items.map((run: RunRecord) => run.runId)).toEqual([
      runId,
    ]);
    expect(history.body.items[0].status).toBe("running");
    for (const gone of finished) {
      const log = await h.call("GET", `/runners/nightly/runs/${gone}/logs`);
      expect(log.status).toBe(404);
    }

    // The run in progress keeps its log from its first line, and it grows.
    const atClear = await runLog(h, "nightly", runId);
    expect(atClear.items[0]).toMatchObject({ seq: 1, message: "tick 1" });
    expect(atClear.live).toBe(true);
    await waitFor(
      async () =>
        (await runLog(h, "nightly", runId)).lastSeq >= atClear.lastSeq + 3,
    );
    const grown = await runLog(h, "nightly", runId);
    expect(grown.items[0]).toMatchObject({ seq: 1, message: "tick 1" });

    // The lifetime counters are untouched by the clear.
    expect((await h.call("GET", "/runners/nightly/stats")).body).toEqual(
      statsBefore.body,
    );

    // The kept run settles onto its own record as usual.
    runner.send("release", runId);
    await waitFor(
      async () => (await runner.history())[0]?.status === "success",
    );
    const [settled] = await runner.history();
    expect(settled?.runId).toBe(runId);
    expect(settled?.logLines).toBeGreaterThanOrEqual(grown.lastSeq);
    expect((await runner.stats()).success).toBe(statsBefore.body.success + 1);

    expect(counts.clearHistory).toBe(0);
    const authorized = h.calls.find(
      (call) => call.action === "runners.clearHistory",
    );
    expect(authorized).toMatchObject({
      mutation: true,
      runner: "nightly",
      route: { method: "DELETE", path: "/runners/:runner/history" },
    });
  });

  it("works for a runner registered in another process", async () => {
    // Two contexts over one memory driver: the API's has no runner, the other
    // registers and runs it — to the API it is known only through the backend.
    const { driver, counts } = countingDriver();
    const h = clearHarness(driver);
    const owner = jobsContext(h.jobs.namespace, driver);
    const runner = owner.runner<{ gap?: number; quick?: boolean }, number>({
      id: "elsewhere",
      file: TICK,
      executionMode: "in-process",
      runMode: "parallel",
    });
    cleanups.push(() => runner.stop({ force: true }));
    const runId = await withRunInProgress(runner);
    await waitFor(
      async () => (await runLog(h, "elsewhere", runId)).lastSeq >= 2,
    );
    expect(h.jobs.runners.get("elsewhere")).toBeUndefined();
    const statsBefore = await runner.stats();

    const cleared = await h.call("DELETE", "/runners/elsewhere/history");
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ removed: 2, kept: [runId] });

    const atClear = await runLog(h, "elsewhere", runId);
    expect(atClear.items[0]).toMatchObject({ seq: 1, message: "tick 1" });
    await waitFor(
      async () =>
        (await runLog(h, "elsewhere", runId)).lastSeq >= atClear.lastSeq + 3,
    );
    expect((await runner.history()).map((run) => run.runId)).toEqual([runId]);
    expect(await runner.stats()).toEqual(statsBefore);

    // The same through a `RunnerController` in the API's context, after another
    // finished run: the one in progress stays.
    runner.send("release", runId);
    await waitFor(
      async () => (await runner.history())[0]?.status === "success",
    );
    const second = await runner.trigger({ args: { gap: 10 } });
    const secondId = (second as { runId: string }).runId;
    const remote = await h.jobs.runners.controller("elsewhere");
    expect(remote.isLocal).toBe(false);
    expect(await remote.clearHistory()).toEqual({
      removed: 1,
      kept: [secondId],
    });
    runner.send("release", secondId);

    expect(counts.clearHistory).toBe(0);
  });

  it("carries staleAfter to the runtime, bounded, and refuses what it cannot take", async () => {
    const { driver, counts } = countingDriver();
    const h = clearHarness(driver);
    const ns = h.jobs.namespace;
    const key = runnerKey("crashed");
    await driver.connect();
    await driver.setState(ns, key, { name: "crashed", paused: "0" });
    // A run whose process died two days ago: its record still says running.
    const stale: RunRecord = {
      runId: "stale-run",
      runnerId: "crashed",
      attempt: 1,
      source: "manual",
      mode: "spawn",
      host: "gone",
      startedAt: Date.now() - 2 * DAY,
      status: "running",
    };
    await driver.appendHistory(ns, key, stale, 50);

    // Out of range, or not a number: 400, and nothing removed.
    for (const value of [
      String(CLEAR_HISTORY_STALE_AFTER.min - 1),
      String(CLEAR_HISTORY_STALE_AFTER.max + 1),
      "0",
      "1.5",
      "soon",
    ]) {
      const refused = await h.call(
        "DELETE",
        `/runners/crashed/history?staleAfter=${value}`,
      );
      expect({
        value,
        status: refused.status,
        code: refused.body.code,
      }).toEqual({ value, status: 400, code: "VALIDATION" });
    }
    expect(await driver.listHistory(ns, key)).toHaveLength(1);

    // Raised past its age, the crashed run is still in progress: kept.
    const kept = await h.call(
      "DELETE",
      `/runners/crashed/history?staleAfter=${3 * DAY}`,
    );
    expect(kept.body).toEqual({ removed: 0, kept: ["stale-run"] });

    // At the default — one day, the floor — it is a crash, and is removed.
    const removed = await h.call("DELETE", "/runners/crashed/history");
    expect(removed.body).toEqual({ removed: 1, kept: [] });
    expect(await driver.listHistory(ns, key)).toEqual([]);

    expect(CLEAR_HISTORY_STALE_AFTER.min).toBe(DEFAULT_STALE_RUN_AFTER);
    expect(counts.clearHistory).toBe(0);
  });

  it("is 404 RUNNER_NOT_FOUND for an unknown runner", async () => {
    const h = clearHarness();
    const answered = await h.call("DELETE", "/runners/ghost/history");
    expect(answered.status).toBe(404);
    expect(answered.body.code).toBe("RUNNER_NOT_FOUND");
    expect(await h.jobs.driver.listRunners(h.jobs.namespace)).toEqual([]);
  });

  it("is pruned, never a 501, on a driver without removeRuns", async () => {
    const { driver, counts } = countingDriver();
    const h = clearHarness(without(driver, "removeRuns"));
    const runner = h.jobs.runner({
      id: "nightly",
      file: TICK,
      executionMode: "in-process",
    });
    cleanups.push(() => runner.stop({ force: true }));
    await runner.trigger({ args: { quick: true } });
    await waitFor(
      async () => (await runner.history())[0]?.status === "success",
    );

    expect(
      h.api.routes.some((route) => route.action === "runners.clearHistory"),
    ).toBe(false);
    const permissions = await h.call("GET", "/meta/permissions");
    expect("runners.clearHistory" in permissions.body.actions).toBe(false);
    expect((await h.call("DELETE", "/runners/nightly/history")).status).toBe(
      404,
    );
    expect(await runner.history()).toHaveLength(1);
    expect(counts.clearHistory).toBe(0);
  });

  it("never falls back to the driver's clearHistory when a runner's own driver cannot remove runs", async () => {
    // The API's driver can, so the route is registered; this one runner was
    // built on a driver that cannot. The honest answer is 501 with the
    // history whole — never the driver's whole-history clear, which would
    // take the run in progress with it.
    const h = clearHarness();
    const { driver: own, counts } = countingDriver();
    without(own, "removeRuns");
    const runner = h.jobs.runners.add<
      { gap?: number; quick?: boolean },
      number
    >({ id: "legacy", file: TICK, executionMode: "in-process", driver: own });
    cleanups.push(() => runner.stop({ force: true }));
    const runId = await withRunInProgress(runner);

    const answered = await h.call("DELETE", "/runners/legacy/history");
    expect(answered.status).toBe(501);
    expect(answered.body.code).toBe("NOT_SUPPORTED");
    expect(counts.clearHistory).toBe(0);
    const history = await runner.history();
    expect(history).toHaveLength(3);
    expect(history[0]?.runId).toBe(runId);
    runner.send("release", runId);
  });
});
