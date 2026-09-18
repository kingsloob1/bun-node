import type { BunJobs } from "../../lib/index";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { waitFor } from "../helpers";
import {
  ECHO_HANDLER,
  harness,
  openContexts,
  openHarnesses,
  registerRunnerElsewhere,
  SLEEP_HANDLER,
} from "./fixtures";

/**
 * The runner routes over `fetch()`, with `validateResponses` on. `nightly` is
 * registered in this process; `remote` exists only as state another process
 * would have persisted, and is reached through `manager.remote(id)`.
 */

afterEach(() => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
});

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

/** A harness with a local runner `nightly` and a remote runner `remote`. */
async function withRunners(overrides = {}) {
  const h = harness(overrides);
  const nightly = h.jobs.runner({
    id: "nightly",
    file: ECHO_HANDLER,
    executionMode: "in-process",
  });
  await registerRunnerElsewhere(h.jobs, "remote");
  return { ...h, nightly };
}

/** Waits until a runner has recorded `count` runs. */
async function runsRecorded(jobs: BunJobs, id: string, count: number) {
  const controller = await jobs.runners.remote(id);
  await waitFor(async () => (await controller.history()).length >= count);
}

describe("listing and reading", () => {
  it("lists local runners with name and status, then remote ids", async () => {
    const h = await withRunners();
    const listed = await h.call("GET", "/runners");
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([
      {
        id: "nightly",
        local: true,
        name: "nightly",
        status: h.nightly.status,
        isPaused: false,
        isRunning: false,
      },
      { id: "remote", local: false, isPaused: false, isRunning: false },
    ]);
  });

  it("says in the list which runners are paused, remote ones included (UI-G16)", async () => {
    const h = await withRunners();
    await (await h.jobs.runners.remote("remote")).pause();

    const listed = await h.call("GET", "/runners");
    expect(listed.status).toBe(200);
    // What the list says is what reading each runner says.
    for (const item of listed.body.items) {
      const read = await h.call("GET", `/runners/${item.id}`);
      expect(item.isPaused, item.id).toBe(read.body.isPaused);
      expect(item.isRunning, item.id).toBe(read.body.isRunning);
    }
    expect(
      listed.body.items.find((item: { id: string }) => item.id === "remote"),
    ).toMatchObject({ local: false, isPaused: true, isRunning: false });
  });

  it("reads a local runner and a remote one, never its file unless exposed", async () => {
    const h = await withRunners();

    const local = await h.call("GET", "/runners/nightly");
    expect(local.status).toBe(200);
    expect(local.body).toMatchObject({
      id: "nightly",
      isLocal: true,
      isPaused: false,
      local: { activeRuns: [] },
    });
    expect(local.body).not.toHaveProperty("file");
    // Unlimited concurrency is Infinity, which JSON cannot carry: left out.
    expect(local.body).not.toHaveProperty("maxConcurrency");

    const remote = await h.call("GET", "/runners/remote");
    expect(remote.body).toMatchObject({ id: "remote", isLocal: false });
    expect(remote.body).not.toHaveProperty("local");

    const exposed = harness({
      jobs: h.jobs,
      serialize: { exposeRunnerFiles: true },
    });
    expect((await exposed.call("GET", "/runners/nightly")).body.file).toContain(
      "echo.ts",
    );
  });

  it("answers an unknown runner with 404 and a bad id with 400 before authorize", async () => {
    const h = await withRunners();
    const unknown = await h.call("GET", "/runners/ghost");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: "RUNNER_NOT_FOUND" });
    expect(h.calls).toHaveLength(1);

    h.calls.length = 0;
    const bad = await h.call("GET", "/runners/a%20b/stats");
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "INVALID_NAME" });
    // Asked once, without the unusable id.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).not.toHaveProperty("runner");
  });

  it("reads history and stats, from any process", async () => {
    const h = await withRunners({ limits: { queueCacheMs: 0, maxHistory: 5 } });
    // A single-mode runner skips a trigger while a run is in flight, so each
    // run is let finish before the next is asked for.
    await h.nightly.trigger();
    await runsRecorded(h.jobs, "nightly", 1);
    await waitFor(() => h.nightly.activeRuns.size === 0);
    await h.nightly.trigger();
    await runsRecorded(h.jobs, "nightly", 2);

    const history = await h.call("GET", "/runners/nightly/history?limit=1");
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject({
      runnerId: "nightly",
      status: "success",
    });

    const stats = await h.call("GET", "/runners/nightly/stats");
    expect(stats.body).toMatchObject({ success: 2, total: 2 });

    expect((await h.call("GET", "/runners/remote/stats")).body).toMatchObject({
      total: 0,
    });
    expect((await h.call("GET", "/runners/remote/history")).body).toEqual({
      items: [],
    });
    expect(
      (await h.call("GET", "/runners/nightly/history?limit=6")).status,
    ).toBe(400);
  });
});

describe("control", () => {
  it("triggers: 202 when started or queued, 200 when skipped", async () => {
    const h = await withRunners();

    const started = await h.call("POST", "/runners/nightly/trigger");
    expect(started.status).toBe(202);
    expect(started.body).toEqual({
      outcome: "started",
      runId: expect.any(String),
    });

    const queued = await h.call("POST", "/runners/remote/trigger", {});
    expect(queued.status).toBe(202);
    expect(queued.body).toEqual({ outcome: "queued", position: 1 });

    await h.call("POST", "/runners/remote/pause");
    const skipped = await h.call("POST", "/runners/remote/trigger", {});
    expect(skipped.status).toBe(200);
    expect(skipped.body).toEqual({ outcome: "skipped", reason: "paused" });

    const forced = await h.call("POST", "/runners/remote/trigger", {
      force: true,
    });
    expect(forced.status).toBe(202);
    expect(forced.body).toEqual({ outcome: "queued", position: 2 });
  });

  it("refuses run arguments unless runnerTriggerArgs is on", async () => {
    const h = await withRunners();
    const refused = await h.call("POST", "/runners/nightly/trigger", {
      args: { value: 1 },
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "ARGS_NOT_ALLOWED" });

    const allowed = harness({ jobs: h.jobs, runnerTriggerArgs: true });
    const started = await allowed.call("POST", "/runners/nightly/trigger", {
      args: { value: 42 },
    });
    expect(started.status).toBe(202);
    await runsRecorded(h.jobs, "nightly", 1);
    const [run] = await h.nightly.history(1);
    expect(run!.result).toMatchObject({ value: 42 });
  });

  it("pauses and resumes local and remote runners everywhere", async () => {
    const h = await withRunners();

    for (const id of ["nightly", "remote"]) {
      expect((await h.call("POST", `/runners/${id}/pause`)).body).toEqual({
        paused: true,
      });
      expect((await h.call("GET", `/runners/${id}`)).body.isPaused).toBe(true);
      expect(
        (await h.call("POST", `/runners/${id}/resume`, { triggerNow: false }))
          .body,
      ).toEqual({ paused: false });
      expect((await h.call("GET", `/runners/${id}`)).body.isPaused).toBe(false);
    }

    await h.call("POST", "/runners/remote/resume", { triggerNow: true });
    expect((await h.call("GET", "/runners/remote")).body.queuedTriggers).toBe(
      1,
    );
  });

  it("reschedules a runner, refusing an invalid schedule with 400", async () => {
    const h = await withRunners();

    const cron = await h.call("PUT", "/runners/nightly/schedule", {
      schedule: "*/5 * * * *",
    });
    expect(cron.status).toBe(200);
    expect(cron.body).toEqual({
      schedule: { cron: expect.any(String) },
      nextRunAt: expect.any(Number),
    });

    const every = await h.call("PUT", "/runners/remote/schedule", {
      schedule: { every: 60_000 },
    });
    expect(every.body.schedule).toEqual({ every: 60_000 });
    expect((await h.call("GET", "/runners/remote")).body.schedule).toEqual({
      every: 60_000,
    });

    const at = await h.call("PUT", "/runners/remote/schedule", {
      schedule: { at: "2099-01-01T00:00:00Z" },
    });
    expect(at.body).toEqual({
      schedule: { at: Date.parse("2099-01-01T00:00:00Z") },
      nextRunAt: Date.parse("2099-01-01T00:00:00Z"),
    });

    const cleared = await h.call("PUT", "/runners/nightly/schedule", {
      schedule: null,
    });
    expect(cleared.body).toEqual({ schedule: null, nextRunAt: null });

    const invalid = await h.call("PUT", "/runners/nightly/schedule", {
      schedule: "not a cron expression",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: "INVALID_SCHEDULE" });

    const zero = await h.call("PUT", "/runners/nightly/schedule", {
      schedule: 0,
    });
    expect(zero.body).toMatchObject({ code: "VALIDATION" });
  });

  it("says which part of a refused schedule is wrong, as a VALIDATION-style issue (UI-G18)", async () => {
    const h = await withRunners();
    const refused = async (schedule: unknown) => {
      const response = await h.call("PUT", "/runners/nightly/schedule", {
        schedule,
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_SCHEDULE");
      expect(response.body.issues).toHaveLength(1);
      expect(response.body.issues[0]).toMatchObject({
        target: "body",
        message: response.body.detail,
      });
      return response.body.issues[0].path;
    };

    expect(await refused("not a cron expression")).toBe("schedule");
    expect(await refused({ cron: "99 * * * *" })).toBe("schedule.cron");
    expect(await refused({ cron: "0 9 * * *", tz: "Nowhere/Land" })).toBe(
      "schedule.tz",
    );
    // A bad expression is blamed before the zone, whatever the zone.
    expect(await refused({ cron: "99 * * * *", tz: "Nowhere/Land" })).toBe(
      "schedule.cron",
    );
    // Nothing was written by any of them.
    expect((await h.call("GET", "/runners/nightly")).body.schedule).toEqual(
      h.nightly.schedule ?? null,
    );
  });

  it("kills local runs: 202 at once, 200 after waiting, 404 for an unknown run", async () => {
    const h = await withRunners();
    const sleepy = h.jobs.runner({
      id: "sleepy",
      file: SLEEP_HANDLER,
      executionMode: "in-process",
      runMode: "parallel",
      args: { ms: 10_000 },
    });

    const first = await sleepy.trigger();
    expect(first.outcome).toBe("started");
    const runId = (first as { runId: string }).runId;
    await waitFor(() => sleepy.activeRuns.has(runId));

    const unknownRun = await h.call("POST", "/runners/sleepy/kill", {
      runId: "ghost",
    });
    expect(unknownRun.status).toBe(404);
    expect(unknownRun.body).toMatchObject({ code: "RUN_NOT_FOUND" });

    const waited = await h.call("POST", "/runners/sleepy/kill", {
      runId,
      wait: true,
    });
    expect(waited.status).toBe(200);
    expect(waited.body).toEqual({ runIds: [runId] });
    expect(sleepy.activeRuns.size).toBe(0);

    const second = (await sleepy.trigger()) as { runId: string };
    await waitFor(() => sleepy.activeRuns.has(second.runId));
    const immediate = await h.call("POST", "/runners/sleepy/kill");
    expect(immediate.status).toBe(202);
    expect(immediate.body).toEqual({ runIds: [second.runId] });
    await waitFor(() => sleepy.activeRuns.size === 0);
  });

  it("keeps kill and stats reset local-only: 409 for a remote runner, 404 for an unknown one", async () => {
    const h = await withRunners();
    for (const path of [
      "/runners/remote/kill",
      "/runners/remote/stats/reset",
    ]) {
      const response = await h.call("POST", path);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "RUNNER_NOT_LOCAL" });
    }
    expect((await h.call("POST", "/runners/ghost/kill")).status).toBe(404);
  });

  it("resets a local runner's stats", async () => {
    const h = await withRunners();
    await h.nightly.trigger();
    await runsRecorded(h.jobs, "nightly", 1);
    expect((await h.call("GET", "/runners/nightly/stats")).body.total).toBe(1);

    expect((await h.call("POST", "/runners/nightly/stats/reset")).status).toBe(
      204,
    );
    expect((await h.call("GET", "/runners/nightly/stats")).body.total).toBe(0);
  });
});

describe("pruning and docs", () => {
  it("routes no runner route in jobs mode, and no runner mutation under readOnly", async () => {
    const jobsOnly = await withRunners({ mode: "jobs" });
    expect((await jobsOnly.call("GET", "/runners")).body).toMatchObject({
      code: "ROUTE_NOT_FOUND",
    });

    const readOnly = await withRunners({ readOnly: true });
    expect((await readOnly.call("GET", "/runners/remote")).status).toBe(200);
    for (const path of [
      "/runners/remote/trigger",
      "/runners/remote/pause",
      "/runners/nightly/kill",
    ]) {
      expect((await readOnly.call("POST", path)).status).toBe(404);
    }
  });

  it("documents how soon a remote change takes effect", async () => {
    const h = await withRunners();
    const paths = h.api.openapi().paths as Record<
      string,
      Record<string, { description?: string }>
    >;
    for (const [path, method] of [
      ["/runners/{runner}/trigger", "post"],
      ["/runners/{runner}/pause", "post"],
      ["/runners/{runner}/resume", "post"],
      ["/runners/{runner}/schedule", "put"],
    ] as const) {
      expect(paths[path]![method]!.description).toContain(
        "remoteControl: true",
      );
      expect(paths[path]![method]!.description).toContain("30s");
    }
  });
});
