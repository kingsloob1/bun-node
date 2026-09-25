import type { BunJobs } from "../../lib/index";
import { Buffer } from "node:buffer";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { MAX_DATE_MS } from "../../lib/api/contract/constants";
import { scheduleIssuePath } from "../../lib/api/routes/runners";
import { runnerKey } from "../../lib/index";
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
 * would have persisted, and is reached through `manager.controller(id)`.
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

/**
 * Waits until a runner has recorded `count` finished runs. A run enters the
 * history as `running` the moment it starts and is rewritten when it settles,
 * so counting records alone returns while the run is still in flight, with no
 * `result` yet. That window is widest on the first in-process run of a handler
 * in the process, which pays for importing the file.
 */
async function runsRecorded(jobs: BunJobs, id: string, count: number) {
  const controller = await jobs.runners.controller(id);
  await waitFor(async () => {
    const history = await controller.history();
    return history.filter((run) => run.status !== "running").length >= count;
  });
}

describe("listing and reading", () => {
  it("lists local runners with name and status, then remote ids", async () => {
    const h = await withRunners();
    const listed = await h.call("GET", "/runners");
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([
      {
        id: "nightly",
        isLocal: true,
        local: true,
        name: "nightly",
        status: h.nightly.status,
        isPaused: false,
        isRunning: false,
      },
      {
        id: "remote",
        isLocal: false,
        local: false,
        isPaused: false,
        isRunning: false,
      },
    ]);
  });

  it("names locality isLocal in the list, as the detail does, keeping local as a deprecated copy", async () => {
    const h = await withRunners();
    const listed = await h.call("GET", "/runners");
    for (const item of listed.body.items) {
      expect(item.local, item.id).toBe(item.isLocal);
      const read = await h.call("GET", `/runners/${item.id}`);
      expect(item.isLocal, item.id).toBe(read.body.isLocal);
    }

    const document = h.api.openapi() as any;
    const schema =
      document.paths["/runners"].get.responses["200"].content[
        "application/json"
      ].schema;
    const resolve = (node: any): any =>
      node.$ref
        ? resolve(
            node.$ref
              .replace("#/", "")
              .split("/")
              .reduce((at: any, key: string) => at[key], document),
          )
        : node;
    const item = resolve(resolve(schema).properties.items.items);
    expect(item.required).toContain("isLocal");
    expect(item.properties.local.deprecated).toBe(true);
    expect(item.properties.isLocal.deprecated).toBeUndefined();
  });

  it("says in the list which runners are paused, remote ones included (UI-G16)", async () => {
    const h = await withRunners();
    await (await h.jobs.runners.controller("remote")).pause();

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

  it("still reads a runner removed from its manager: the record outlives the registration", async () => {
    // `runners.remove()` drops a runner from its own process's manager alone.
    // The backend's registration is permanent — it carries what the cluster
    // decided about the runner, here a pause — so the API keeps answering for
    // it, now as a runner no process owns. The core of this, including the
    // intent surviving into a fresh registration, is pinned in
    // `__tests__/runner.test.ts`.
    const h = await withRunners();
    await h.nightly.start();
    await h.nightly.pause();

    expect(await h.jobs.runners.remove("nightly")).toBe(true);
    expect(h.jobs.runners.get("nightly")).toBeUndefined();

    const read = await h.call("GET", "/runners/nightly");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      id: "nightly",
      isLocal: false,
      isPaused: true,
    });

    const listed = await h.call("GET", "/runners");
    expect(
      listed.body.items.find((item: { id: string }) => item.id === "nightly"),
    ).toMatchObject({ id: "nightly", isLocal: false, isPaused: true });
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
      // An empty history still carries its page: `total: 0` is what tells a
      // pager the list is empty rather than merely this window of it, and
      // `next: null` tells a walking client the same thing.
      page: { offset: 0, limit: 5, total: 0, hasMore: false, next: null },
    });
    expect(
      (await h.call("GET", "/runners/nightly/history?limit=6")).status,
    ).toBe(400);
  });

  /**
   * Paging the history over the route.
   *
   * `runner-history-paging.test.ts` runs the slicing itself against all eight
   * backends; what is left for here is the HTTP surface — the `page` envelope,
   * the defaults, and that `limits.maxHistory` refuses a page rather than
   * shortening one. The records are written through the driver because this is
   * about the route's arithmetic, and thirty real runs would take thirty times
   * as long to say the same thing.
   */
  describe("history paging", () => {
    /** Writes `count` records for a runner only another process registered. */
    async function seedHistory(
      h: Awaited<ReturnType<typeof withRunners>>,
      count: number,
    ) {
      const key = runnerKey("remote");
      for (let n = 1; n <= count; n++) {
        await h.jobs.driver.appendHistory(
          h.jobs.namespace,
          key,
          {
            runId: `r${String(n).padStart(2, "0")}`,
            runnerId: "remote",
            attempt: 1,
            source: "manual",
            mode: "in-process",
            host: "test",
            startedAt: 1_700_000_000_000 + n * 1000,
            finishedAt: 1_700_000_000_500 + n * 1000,
            durationMs: 500,
            status: "success",
          },
          1000,
        );
      }
    }

    it("pages past the first page, and page two holds the runs page one did not", async () => {
      const h = await withRunners({
        limits: { queueCacheMs: 0, maxHistory: 10 },
      });
      await seedHistory(h, 25);

      const first = await h.call("GET", "/runners/remote/history?limit=10");
      const second = await h.call(
        "GET",
        "/runners/remote/history?limit=10&offset=10",
      );
      const third = await h.call(
        "GET",
        "/runners/remote/history?limit=10&offset=20",
      );

      const idsOf = (r: any) => r.body.items.map((run: any) => run.runId);
      // Newest first by default, as before paging existed.
      expect(idsOf(first)).toEqual([
        "r25",
        "r24",
        "r23",
        "r22",
        "r21",
        "r20",
        "r19",
        "r18",
        "r17",
        "r16",
      ]);
      // The assertion the feature exists for: disjoint pages that add up.
      expect(idsOf(second)).toEqual([
        "r15",
        "r14",
        "r13",
        "r12",
        "r11",
        "r10",
        "r09",
        "r08",
        "r07",
        "r06",
      ]);
      expect(idsOf(third)).toEqual(["r05", "r04", "r03", "r02", "r01"]);
      expect(
        idsOf(second).filter((id: string) => idsOf(first).includes(id)),
      ).toEqual([]);

      // The envelope the UI's pager reads: "21–25 of 25" on the last page.
      // `next` rides along on every page: an offset client may ignore it, and
      // a client that wants to stop losing rows to a starting run can switch
      // to walking without re-deriving anything.
      expect(first.body.page).toMatchObject({
        offset: 0,
        limit: 10,
        total: 25,
        hasMore: true,
      });
      expect(first.body.page.next).toBeTypeOf("string");
      expect(second.body.page).toMatchObject({
        offset: 10,
        limit: 10,
        total: 25,
        hasMore: true,
      });
      expect(third.body.page).toEqual({
        offset: 20,
        limit: 10,
        total: 25,
        hasMore: false,
        // The last page ends the walk, so there is nothing to continue with.
        next: null,
      });
    });

    it("reaches records the old `limit`-only route could never serve", async () => {
      // `keepHistory` above `maxHistory`: before paging, runs 1–5 were stored
      // and no client could ask for them.
      const h = await withRunners({
        limits: { queueCacheMs: 0, maxHistory: 10 },
      });
      await seedHistory(h, 15);

      const capped = await h.call("GET", "/runners/remote/history?limit=10");
      expect(capped.body.items).toHaveLength(10);
      expect(capped.body.page.total).toBe(15);

      const beyond = await h.call(
        "GET",
        "/runners/remote/history?limit=10&offset=10",
      );
      expect(beyond.body.items.map((run: any) => run.runId)).toEqual([
        "r05",
        "r04",
        "r03",
        "r02",
        "r01",
      ]);
    });

    it("orders oldest first on request, paging the same list", async () => {
      const h = await withRunners({
        limits: { queueCacheMs: 0, maxHistory: 10 },
      });
      await seedHistory(h, 12);

      const asc = await h.call(
        "GET",
        "/runners/remote/history?limit=4&order=asc",
      );
      expect(asc.body.items.map((run: any) => run.runId)).toEqual([
        "r01",
        "r02",
        "r03",
        "r04",
      ]);
      expect(asc.body.page).toMatchObject({
        offset: 0,
        limit: 4,
        total: 12,
        hasMore: true,
      });

      const ascNext = await h.call(
        "GET",
        "/runners/remote/history?limit=4&order=asc&offset=8",
      );
      expect(ascNext.body.items.map((run: any) => run.runId)).toEqual([
        "r09",
        "r10",
        "r11",
        "r12",
      ]);
      expect(ascNext.body.page.hasMore).toBe(false);
    });

    it("answers an empty page past the end, still saying how many there are", async () => {
      const h = await withRunners({
        limits: { queueCacheMs: 0, maxHistory: 10 },
      });
      await seedHistory(h, 7);

      const past = await h.call(
        "GET",
        "/runners/remote/history?limit=10&offset=7",
      );
      expect(past.status).toBe(200);
      expect(past.body.items).toEqual([]);
      // Not `total: 0`: the list has seven runs, this window just has none.
      expect(past.body.page).toEqual({
        offset: 7,
        limit: 10,
        total: 7,
        hasMore: false,
        next: null,
      });
    });

    it("refuses a page over `maxHistory` rather than shortening one, and caps no offset", async () => {
      const h = await withRunners({
        limits: { queueCacheMs: 0, maxHistory: 10 },
      });
      await seedHistory(h, 12);

      // The cap bounds a page…
      const over = await h.call("GET", "/runners/remote/history?limit=11");
      expect(over.status).toBe(400);
      // The schema's own refusal, as every other over-cap `limit` answers.
      expect(over.body.type).toBe("urn:bun-jobs:error:VALIDATION");
      expect(
        (await h.call("GET", "/runners/remote/history?limit=10")).status,
      ).toBe(200);

      // …and nothing bounds how deep `offset` reads, which is the whole point:
      // a cap on both is what made stored runs unreachable.
      const deep = await h.call(
        "GET",
        "/runners/remote/history?limit=10&offset=100000",
      );
      expect(deep.status).toBe(200);
      expect(deep.body.page.total).toBe(12);
    });
  });

  /**
   * Walking the history with `cursor`, over the route.
   *
   * `runner-history-cursor.test.ts` runs the seek itself against all eight
   * backends, including the interleaving that offset loses records to. What is
   * left for here is the HTTP surface: `page.next` round-tripping as `cursor`,
   * the end-of-walk signal, and the refusals — a cursor that answers 200 with
   * page one where it should answer 400 is the failure mode a client cannot
   * see.
   */
  describe("history cursor", () => {
    /** Writes `count` records for a runner only another process registered. */
    async function seedHistory(
      h: Awaited<ReturnType<typeof withRunners>>,
      runner: string,
      count: number,
    ) {
      const key = runnerKey(runner);
      for (let n = 1; n <= count; n++) {
        await h.jobs.driver.appendHistory(
          h.jobs.namespace,
          key,
          {
            runId: `${runner}-r${String(n).padStart(2, "0")}`,
            runnerId: runner,
            attempt: 1,
            source: "manual",
            mode: "in-process",
            host: "test",
            startedAt: 1_700_000_000_000 + n * 1000,
            finishedAt: 1_700_000_000_500 + n * 1000,
            durationMs: 500,
            status: "success",
          },
          1000,
        );
      }
    }

    it("walks the whole history with `page.next`, and ends with `next: null`", async () => {
      const h = await withRunners({
        limits: { queueCacheMs: 0, maxHistory: 10 },
      });
      await seedHistory(h, "remote", 12);

      const seen: string[] = [];
      let url = "/runners/remote/history?limit=5";
      let pages = 0;

      for (;;) {
        const res = await h.call("GET", url);
        expect(res.status).toBe(200);
        seen.push(...res.body.items.map((run: any) => run.runId));
        pages += 1;
        if (res.body.page.next === null || pages > 10) {
          // The end of the walk is a null cursor on a page that still holds
          // rows, not an extra empty page a client has to ask for.
          expect(res.body.items.length).toBe(2);
          expect(res.body.page.offset).toBe(10);
          break;
        }
        url = `/runners/remote/history?limit=5&cursor=${encodeURIComponent(res.body.page.next)}`;
      }

      expect(pages).toBe(3);
      // Newest first, nothing missed, nothing twice.
      expect(seen).toEqual(
        Array.from(
          { length: 12 },
          (_, i) => `remote-r${String(12 - i).padStart(2, "0")}`,
        ),
      );
    });

    it("walks `asc` too, and a cursor reports where the seek landed", async () => {
      const h = await withRunners({
        limits: { queueCacheMs: 0, maxHistory: 10 },
      });
      await seedHistory(h, "remote", 12);

      const first = await h.call(
        "GET",
        "/runners/remote/history?limit=4&order=asc",
      );
      expect(first.body.items.map((r: any) => r.runId)).toEqual([
        "remote-r01",
        "remote-r02",
        "remote-r03",
        "remote-r04",
      ]);
      const second = await h.call(
        "GET",
        `/runners/remote/history?limit=4&order=asc&cursor=${encodeURIComponent(first.body.page.next)}`,
      );
      expect(second.body.items.map((r: any) => r.runId)).toEqual([
        "remote-r05",
        "remote-r06",
        "remote-r07",
        "remote-r08",
      ]);
      // Not an echo of the `offset` query (which was never sent): the position
      // the seek resolved to, so a pager can still say "5–8 of 12".
      expect(second.body.page).toMatchObject({
        offset: 4,
        limit: 4,
        total: 12,
        hasMore: true,
      });
    });

    it("ignores `offset` when a cursor is sent", async () => {
      const h = await withRunners({
        limits: { queueCacheMs: 0, maxHistory: 10 },
      });
      await seedHistory(h, "remote", 12);

      const first = await h.call("GET", "/runners/remote/history?limit=4");
      const second = await h.call(
        "GET",
        `/runners/remote/history?limit=4&offset=9&cursor=${encodeURIComponent(first.body.page.next)}`,
      );
      expect(second.body.items.map((r: any) => r.runId)).toEqual([
        "remote-r08",
        "remote-r07",
        "remote-r06",
        "remote-r05",
      ]);
      expect(second.body.page.offset).toBe(4);
    });

    it("refuses a cursor it did not issue with 400 INVALID_ARGUMENT", async () => {
      const h = await withRunners({
        limits: { queueCacheMs: 0, maxHistory: 10 },
      });
      await seedHistory(h, "remote", 12);

      for (const bad of [
        "nonsense",
        "rh1.",
        "rh1.!!!",
        `rh1.${Buffer.from('{"v":1}').toString("base64url")}`,
      ]) {
        const res = await h.call(
          "GET",
          `/runners/remote/history?cursor=${encodeURIComponent(bad)}`,
        );
        // Never a 200 with page one: a client walking a list cannot tell that
        // apart from the end of the list, and would stop early and silently.
        expect(res.status, bad).toBe(400);
        expect(res.body.type).toBe("urn:bun-jobs:error:INVALID_ARGUMENT");
      }
    });

    it("refuses one runner's cursor on another, and one order's on the other", async () => {
      const h = await withRunners({
        limits: { queueCacheMs: 0, maxHistory: 10 },
      });
      await seedHistory(h, "remote", 12);
      await seedHistory(h, "nightly", 12);

      const mine = await h.call("GET", "/runners/remote/history?limit=4");
      const cursor = encodeURIComponent(mine.body.page.next);

      // The same position means something else in another runner's history,
      // so resuming there would skip rows without saying so.
      const elsewhere = await h.call(
        "GET",
        `/runners/nightly/history?limit=4&cursor=${cursor}`,
      );
      expect(elsewhere.status).toBe(400);
      expect(elsewhere.body.type).toBe("urn:bun-jobs:error:INVALID_ARGUMENT");

      // And the other direction is a different walk over the same records.
      const flipped = await h.call(
        "GET",
        `/runners/remote/history?limit=4&order=asc&cursor=${cursor}`,
      );
      expect(flipped.status).toBe(400);
      expect(flipped.body.type).toBe("urn:bun-jobs:error:INVALID_ARGUMENT");
    });

    it("refuses a cursor over the length cap as VALIDATION, before decoding it", async () => {
      const h = await withRunners({
        limits: { queueCacheMs: 0, maxHistory: 10 },
      });
      const res = await h.call(
        "GET",
        `/runners/remote/history?cursor=rh1.${"a".repeat(2100)}`,
      );
      expect(res.status).toBe(400);
      expect(res.body.type).toBe("urn:bun-jobs:error:VALIDATION");
    });
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

  it("refuses a time a Date cannot hold as VALIDATION, at the field", async () => {
    const h = await withRunners();
    const before = (await h.call("GET", "/runners/nightly")).body.schedule;
    const cases = [
      [{ every: 1000, anchor: Number.MAX_SAFE_INTEGER }, "schedule.anchor"],
      [{ at: Number.MAX_SAFE_INTEGER }, "schedule.at"],
      [{ every: 1000, anchor: MAX_DATE_MS + 1 }, "schedule.anchor"],
      [{ at: MAX_DATE_MS + 1 }, "schedule.at"],
      [{ at: "not a time" }, "schedule.at"],
      [{ every: 1000, anchor: "2024-02-30T00:00:00Z" }, "schedule.anchor"],
    ] as const;
    for (const [schedule, path] of cases) {
      const response = await h.call("PUT", "/runners/nightly/schedule", {
        schedule,
      });
      expect({ schedule, status: response.status }).toEqual({
        schedule,
        status: 400,
      });
      expect(response.body.code).toBe("VALIDATION");
      expect(response.body.issues).toEqual([
        expect.objectContaining({ target: "body", path }),
      ]);
    }
    expect((await h.call("GET", "/runners/nightly")).body.schedule).toEqual(
      before,
    );

    // The last instant a Date holds is still a time.
    const last = await h.call("PUT", "/runners/nightly/schedule", {
      schedule: { at: MAX_DATE_MS },
    });
    expect(last.status).toBe(200);
    expect(last.body.schedule).toEqual({ at: MAX_DATE_MS });
  });

  it("documents exactly the INVALID_SCHEDULE paths a request can produce", async () => {
    const h = await withRunners();
    const produced = new Set<string>();
    for (const schedule of [
      "not a cron expression",
      { cron: "99 * * * *" },
      { cron: "0 9 * * *", tz: "Nowhere/Land" },
    ]) {
      const response = await h.call("PUT", "/runners/nightly/schedule", {
        schedule,
      });
      expect(response.body.code).toBe("INVALID_SCHEDULE");
      produced.add(response.body.issues[0].path);
    }
    const document = h.api.openapi() as unknown as {
      paths: Record<string, Record<string, { description?: string }>>;
    };
    const description = String(
      document.paths["/runners/{runner}/schedule"]?.put?.description,
    );
    const listed = description
      .slice(description.indexOf("INVALID_SCHEDULE"))
      .match(/`schedule(?:\.\w+)?`/g)
      ?.map((path) => path.slice(1, -1));
    expect(new Set(listed)).toEqual(produced);
    expect([...produced].sort()).toEqual([
      "schedule",
      "schedule.cron",
      "schedule.tz",
    ]);
  });

  it("blames each part of a schedule the normaliser refuses, with its own rule", () => {
    expect(
      scheduleIssuePath({ every: 1000, anchor: Number.MAX_SAFE_INTEGER }),
    ).toBe("schedule.anchor");
    expect(scheduleIssuePath({ every: 1000, anchor: -MAX_DATE_MS - 1 })).toBe(
      "schedule.anchor",
    );
    expect(scheduleIssuePath({ every: 0, anchor: 0 })).toBe("schedule.every");
    expect(scheduleIssuePath({ every: 0 })).toBe("schedule.every");
    expect(scheduleIssuePath({ at: Number.MAX_SAFE_INTEGER })).toBe(
      "schedule.at",
    );
    expect(scheduleIssuePath({ cron: "99 * * * *" })).toBe("schedule.cron");
    expect(scheduleIssuePath({ cron: "0 9 * * *", tz: "Nowhere/Land" })).toBe(
      "schedule.tz",
    );
    expect(scheduleIssuePath("not a cron expression")).toBe("schedule");
    expect(scheduleIssuePath(0)).toBe("schedule");
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
      // Backticked, because bare `control` appears throughout unrelated
      // prose: the option's own spelling is what has to be there.
      expect(paths[path]![method]!.description).toContain("`control: true`");
      // And what the default now does on its own, which is the part an
      // operator reading "30s" would otherwise take as the only answer.
      expect(paths[path]![method]!.description).toContain('`control: "auto"`');
      expect(paths[path]![method]!.description).toContain("30s");
    }
  });
});
