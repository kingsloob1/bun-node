import type { BunJobs } from "../../lib/index";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { BunQueue, ConfigError, MemoryDriver } from "../../lib/index";
import { waitFor } from "../helpers";
import { harness, jobsContext, openContexts, openHarnesses } from "./fixtures";

/**
 * The jobs-mode routes over `fetch()`, with `validateResponses` on: every
 * response in this file is also checked against its declared schema.
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

/** Claims the next claimable job in a queue, as a worker would. */
async function claim(jobs: BunJobs, queue: string) {
  await jobs.driver.connect();
  const ref = { ns: jobs.namespace, queue };
  const token = `token-${Math.random()}`;
  const record = await jobs.driver.claimJob(ref, {
    workerId: "worker-1",
    token,
    lockMs: 60_000,
    now: Date.now(),
  });
  if (!record) {
    throw new Error(`nothing to claim in ${queue}`);
  }
  return { ref, token, record };
}

/** Adds a job and completes it. */
async function completed(jobs: BunJobs, queue: string, id: string) {
  await jobs.queue(queue).add("send", { id }, { jobId: id });
  const { ref, token, record } = await claim(jobs, queue);
  await jobs.driver.completeJob(ref, record.id, token, "ok", false, Date.now());
  return record.id;
}

/** Adds a job and kills it for good, with a failure message. */
async function dead(jobs: BunJobs, queue: string, id: string, message: string) {
  await jobs.queue(queue).add("send", { id }, { jobId: id });
  const { ref, token, record } = await claim(jobs, queue);
  await jobs.driver.failJob(
    ref,
    record.id,
    token,
    { name: "Error", message, stack: `Error: ${message}\n    at secret.ts:1` },
    { retry: false, retention: false },
    Date.now(),
    5,
  );
  return record.id;
}

describe("queues", () => {
  it("sums every queue in the overview, truncating at maxQueues", async () => {
    const h = harness();
    await h.jobs.queue("mail").add("send", {});
    await h.jobs.queue("mail").add("send", {});
    await h.jobs.queue("reports").add("build", {});
    await h.jobs.queue("reports").pause();

    const overview = await h.call("GET", "/overview");
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      queues: 2,
      pausedQueues: 1,
      total: 3,
      truncated: false,
    });
    expect(overview.body.counts).toMatchObject({ waiting: 3, active: 0 });

    const capped = harness({
      jobs: h.jobs,
      limits: { queueCacheMs: 0, maxQueues: 1 },
    });
    expect((await capped.call("GET", "/overview")).body).toMatchObject({
      queues: 1,
      truncated: true,
    });
  });

  it("lists queues, filtered by a name substring", async () => {
    const h = harness();
    await h.jobs.queue("mail").add("send", {});
    await h.jobs.queue("reports").add("build", {});

    const all = await h.call("GET", "/queues");
    expect(all.body.items.map((item: { name: string }) => item.name)).toEqual([
      "mail",
      "reports",
    ]);
    expect(all.body.items[0]).toMatchObject({
      name: "mail",
      total: 1,
      paused: false,
    });
    const searched = await h.call("GET", "/queues?search=rep");
    expect(
      searched.body.items.map((item: { name: string }) => item.name),
    ).toEqual(["reports"]);
  });

  it("reads one queue with its counts and limits", async () => {
    const h = harness();
    await h.jobs.queue("mail").add("send", {});
    await h.jobs.queue("mail").add("send", {});

    expect((await h.call("GET", "/queues/mail")).body).toMatchObject({
      name: "mail",
      total: 2,
      paused: false,
      limits: null,
    });
    const counts = await h.call("GET", "/queues/mail/counts");
    expect(counts.body).toEqual({
      waiting: 2,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      dead: 0,
      "waiting-children": 0,
    });
  });

  it("refuses a bad name before authorize, and an unknown queue after it", async () => {
    const h = harness();
    await h.jobs.queue("mail").add("send", {});

    const bad = await h.call("GET", "/queues/a%20b");
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "INVALID_NAME" });
    // Asked once, without a target: an unusable name is never repeated to
    // `authorize`, and a caller it denies is told 403 rather than the rule.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).not.toHaveProperty("queue");

    h.calls.length = 0;
    const unknown = await h.call("GET", "/queues/ghost/counts");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: "QUEUE_NOT_FOUND" });
    // The unknown queue is only revealed to a caller authorize let through.
    expect(h.calls).toHaveLength(1);
  });

  it("pauses, resumes and drains a queue, with or without a body", async () => {
    const h = harness();
    const queue = h.jobs.queue("mail");
    await queue.add("send", {});
    await queue.add("send", {}, { delay: 60_000 });

    expect((await h.call("POST", "/queues/mail/pause")).body).toEqual({
      paused: true,
    });
    expect(await queue.isPaused()).toBe(true);
    expect((await h.call("POST", "/queues/mail/resume", {})).body).toEqual({
      paused: false,
    });
    expect(await queue.isPaused()).toBe(false);

    expect((await h.call("POST", "/queues/mail/drain")).body).toEqual({
      count: 1,
    });
    expect(await queue.count("delayed")).toBe(1);
    expect(
      (await h.call("POST", "/queues/mail/drain", { delayed: true })).body,
    ).toEqual({ count: 1 });
  });

  it("cleans jobs older than a cutoff, capped by maxClean", async () => {
    const h = harness({ limits: { queueCacheMs: 0, maxClean: 10 } });
    await completed(h.jobs, "mail", "done-1");
    await Bun.sleep(5);

    const cleaned = await h.call("POST", "/queues/mail/clean", {
      state: "completed",
      olderThan: 1,
    });
    expect(cleaned.body).toEqual({ count: 1, ids: ["done-1"] });

    const over = await h.call("POST", "/queues/mail/clean", {
      state: "completed",
      olderThan: 1,
      limit: 11,
    });
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({ code: "VALIDATION" });
  });

  it("reads, replaces and removes limits, refusing bad input", async () => {
    const h = harness();
    await h.jobs.queue("mail").add("send", {});

    expect((await h.call("GET", "/queues/mail/limits")).body).toBeNull();

    const set = await h.call("PUT", "/queues/mail/limits", {
      rate: { max: 5, duration: "1 minute" },
      concurrency: 2,
      names: { send: { concurrency: 1 } },
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      rate: { max: 5, duration: 60_000 },
      concurrency: 2,
      names: { send: { concurrency: 1 } },
    });
    expect((await h.call("GET", "/queues/mail")).body.limits).toEqual(set.body);

    const unreadable = await h.call("PUT", "/queues/mail/limits", {
      rate: { max: 5, duration: "whenever" },
    });
    expect(unreadable.status).toBe(400);
    expect(unreadable.body).toMatchObject({ code: "INVALID_ARGUMENT" });

    const invalid = await h.call("PUT", "/queues/mail/limits", {
      concurrency: 0,
    });
    expect(invalid.body).toMatchObject({ code: "VALIDATION" });

    expect(
      (await h.call("PUT", "/queues/mail/limits", "null")).body,
    ).toBeNull();
    expect(await h.jobs.queue("mail").getLimits()).toBeNull();
  });

  it("answers contended limits with 409 LIMITS_CONTENDED", async () => {
    const h = harness();
    const queue = h.jobs.queue("mail");
    await queue.add("send", {});
    queue.setLimits = async () => {
      throw new ConfigError("they kept changing underneath");
    };
    const response = await h.call("PUT", "/queues/mail/limits", {
      concurrency: 2,
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "LIMITS_CONTENDED" });
  });

  it("prunes the limits routes on a driver that cannot store them", async () => {
    const driver = new MemoryDriver();
    Object.defineProperty(driver, "setQueueState", { value: undefined });
    const h = harness({ jobs: jobsContext("api-jobs", driver) });
    await h.jobs.queue("mail").add("send", {});

    expect((await h.call("GET", "/queues/mail/limits")).body).toMatchObject({
      code: "ROUTE_NOT_FOUND",
    });
    // The detail still answers — without limits, rather than failing on them.
    const detail = await h.call("GET", "/queues/mail");
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ name: "mail", total: 1 });
    expect(detail.body).not.toHaveProperty("limits");
  });
});

describe("jobs", () => {
  /** A harness with three waiting jobs, `a`, `b` and `c`, in `mail`. */
  async function withJobs(overrides = {}) {
    const h = harness(overrides);
    const queue = h.jobs.queue("mail");
    for (const id of ["a", "b", "c"]) {
      await queue.add(
        "send",
        { id, email: `${id}@example.com` },
        { jobId: id },
      );
      await Bun.sleep(2);
    }
    return { ...h, queue };
  }

  it("lists a page, in either order, with includes", async () => {
    const h = await withJobs();

    const first = await h.call("GET", "/queues/mail/jobs?limit=2");
    expect(first.body.items.map((job: { id: string }) => job.id)).toEqual([
      "a",
      "b",
    ]);
    expect(first.body.page).toEqual({ offset: 0, limit: 2, hasMore: true });
    expect(first.body.items[0]).not.toHaveProperty("data");
    expect(first.body.items[0]).not.toHaveProperty("opts");

    const second = await h.call("GET", "/queues/mail/jobs?limit=2&offset=2");
    expect(second.body.items.map((job: { id: string }) => job.id)).toEqual([
      "c",
    ]);
    expect(second.body.page.hasMore).toBe(false);

    const newest = await h.call("GET", "/queues/mail/jobs?order=desc&limit=1");
    expect(newest.body.items[0].id).toBe("c");

    const withData = await h.call(
      "GET",
      "/queues/mail/jobs?include=data,opts&limit=1",
    );
    expect(withData.body.items[0].data).toEqual({
      id: "a",
      email: "a@example.com",
    });
    expect(withData.body.items[0].opts).toBeDefined();

    const none = await h.call(
      "GET",
      "/queues/mail/jobs?state=completed&state=dead",
    );
    expect(none.body.items).toEqual([]);

    expect((await h.call("GET", "/queues/mail/jobs?state=nope")).status).toBe(
      400,
    );
    expect((await h.call("GET", "/queues/mail/jobs?limit=1000")).status).toBe(
      400,
    );
  });

  it("looks jobs up in order, null for a missing one, capped by maxBulkIds", async () => {
    const h = await withJobs();
    const found = await h.call("POST", "/queues/mail/jobs/lookup", {
      ids: ["c", "ghost", "a"],
    });
    expect(found.status).toBe(200);
    expect(
      found.body.items.map((job: { id: string } | null) => job?.id ?? null),
    ).toEqual(["c", null, "a"]);

    const capped = harness({
      jobs: h.jobs,
      limits: { queueCacheMs: 0, maxBulkIds: 2 },
    });
    const over = await capped.call("POST", "/queues/mail/jobs/lookup", {
      ids: ["a", "b", "c"],
    });
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({
      code: "BULK_LIMIT",
      context: { max: 2 },
    });
    // The cap is applied before `authorize`, which is asked without the ids.
    expect(capped.calls).toHaveLength(1);
    expect(capped.calls[0]).not.toHaveProperty("jobIds");
  });

  it("reads one job with its data and options, and an id containing a slash", async () => {
    const h = await withJobs();
    await h.queue.add("send", { tenant: 7 }, { jobId: "tenant/7" });

    const job = await h.call("GET", "/queues/mail/jobs/tenant%2F7");
    expect(job.status).toBe(200);
    expect(job.body).toMatchObject({ id: "tenant/7", data: { tenant: 7 } });
    expect(job.body.opts).toBeDefined();

    const narrowed = await h.call(
      "GET",
      "/queues/mail/jobs/a?include=returnValue",
    );
    expect(narrowed.body).not.toHaveProperty("data");

    const missing = await h.call("GET", "/queues/mail/jobs/ghost");
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "JOB_NOT_FOUND" });
  });

  it("never sends a job's lock token", async () => {
    const h = await withJobs();
    const { token, record } = await claim(h.jobs, "mail");
    const job = await h.call("GET", `/queues/mail/jobs/${record.id}`);
    expect(job.body.state).toBe("active");
    expect(job.body.lockExpiresAt).toEqual(expect.any(Number));
    expect(job.text).not.toContain(token);
    expect(job.text).not.toContain("lockToken");
  });

  it("pages a job's log lines", async () => {
    const h = await withJobs();
    const job = (await h.queue.getJob("a"))!;
    for (const line of ["one", "two", "three"]) {
      await job.log(line);
    }
    const page = await h.call("GET", "/queues/mail/jobs/a/logs?limit=2");
    expect(page.body).toEqual({
      items: ["one", "two"],
      page: { offset: 0, limit: 2, total: 3, hasMore: true },
    });
    expect((await h.call("GET", "/queues/mail/jobs/ghost/logs")).status).toBe(
      404,
    );
  });

  it("describes a flow's children, and hides children in unreachable queues", async () => {
    const h = harness();
    const flow = await h.jobs.queue("reports").addFlow({
      name: "report",
      data: {},
      children: [
        { name: "orders", data: { rows: 3 }, queue: "fetch" },
        { name: "refunds", data: { rows: 1 }, queue: "fetch" },
      ],
    });

    const parent = await h.call(
      "GET",
      `/queues/reports/jobs/${flow.job.id}/children`,
    );
    expect(parent.status).toBe(200);
    expect(parent.body).toMatchObject({
      parent: null,
      pending: 2,
      truncated: false,
    });
    expect(parent.body.children).toHaveLength(2);
    expect(parent.body.children[0]).toMatchObject({
      queue: "fetch",
      job: { queue: "fetch", state: "waiting" },
    });

    const childId = flow.children[0]!.job.id;
    const child = await h.call("GET", `/queues/fetch/jobs/${childId}/children`);
    expect(child.body).toEqual({
      parent: { queue: "reports", id: flow.job.id },
      pending: 0,
      children: [],
      truncated: false,
    });

    const restricted = harness({ jobs: h.jobs, queues: ["reports"] });
    const hidden = await restricted.call(
      "GET",
      `/queues/reports/jobs/${flow.job.id}/children`,
    );
    expect(
      hidden.body.children.map((entry: { job: unknown }) => entry.job),
    ).toEqual([null, null]);
  });

  it("updates a job only when jobs.update is enabled", async () => {
    const byDefault = await withJobs({ actions: undefined });
    expect(
      (await byDefault.call("PATCH", "/queues/mail/jobs/a", { priority: 5 }))
        .body,
    ).toMatchObject({ code: "ROUTE_NOT_FOUND" });

    const h = await withJobs({
      limits: { queueCacheMs: 0, maxJobDataBytes: 200 },
    });
    const prioritised = await h.call("PATCH", "/queues/mail/jobs/a", {
      priority: 5,
    });
    expect(prioritised.status).toBe(200);
    expect(prioritised.body).toMatchObject({ id: "a", priority: 5 });

    const later = await h.call("PATCH", "/queues/mail/jobs/b", {
      runAt: "2099-01-01T00:00:00Z",
    });
    expect(later.body).toMatchObject({
      state: "delayed",
      runAt: Date.parse("2099-01-01T00:00:00Z"),
    });

    const empty = await h.call("PATCH", "/queues/mail/jobs/a", {});
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({ code: "INVALID_ARGUMENT" });

    const conditional = await h.call("PATCH", "/queues/mail/jobs/c", {
      data: { changed: true },
      onlyIn: ["completed"],
    });
    expect(conditional.status).toBe(409);
    expect(conditional.body).toMatchObject({
      code: "JOB_STATE_CONFLICT",
      context: { state: "waiting" },
    });

    expect(
      (await h.call("PATCH", "/queues/mail/jobs/ghost", { priority: 1 }))
        .status,
    ).toBe(404);

    const huge = await h.call("PATCH", "/queues/mail/jobs/a", {
      data: { blob: "x".repeat(500) },
    });
    expect(huge.status).toBe(413);
    expect(huge.body).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      context: { limit: 200 },
    });
  });

  it("removes a job, but not an active one", async () => {
    const h = await withJobs();
    expect((await h.call("DELETE", "/queues/mail/jobs/c")).status).toBe(204);
    expect((await h.call("GET", "/queues/mail/jobs/c")).status).toBe(404);
    expect((await h.call("DELETE", "/queues/mail/jobs/ghost")).status).toBe(
      404,
    );

    const { record } = await claim(h.jobs, "mail");
    const active = await h.call("DELETE", `/queues/mail/jobs/${record.id}`);
    expect(active.status).toBe(409);
    expect(active.body).toMatchObject({
      code: "JOB_ACTIVE",
      context: { state: "active" },
    });
    expect(await h.queue.getJob(record.id)).not.toBeNull();
  });

  it("retries and promotes one job, with 409 in the wrong state", async () => {
    const h = harness();
    const queue = h.jobs.queue("mail");
    await completed(h.jobs, "mail", "done");
    await queue.add("send", {}, { jobId: "waiting" });
    await queue.add("send", {}, { jobId: "later", delay: 60_000 });

    const retried = await h.call("POST", "/queues/mail/jobs/done/retry");
    expect(retried.body).toEqual({ retried: true });
    expect((await queue.getJob("done"))!.state).toBe("waiting");

    const notFinished = await h.call(
      "POST",
      "/queues/mail/jobs/waiting/retry",
      {
        resetAttempts: false,
      },
    );
    expect(notFinished.status).toBe(409);
    expect(notFinished.body).toMatchObject({
      code: "JOB_STATE_CONFLICT",
      context: { state: "waiting" },
    });

    expect(
      (await h.call("POST", "/queues/mail/jobs/later/promote")).body,
    ).toEqual({
      promoted: true,
    });
    expect((await queue.getJob("later"))!.state).toBe("waiting");
    expect(
      (await h.call("POST", "/queues/mail/jobs/waiting/promote")).status,
    ).toBe(409);
    expect((await h.call("POST", "/queues/mail/jobs/ghost/retry")).status).toBe(
      404,
    );
  });

  it("fails one job for good, with 409 once it is finished and 400 without a reason", async () => {
    const h = harness();
    const queue = h.jobs.queue("mail");
    await completed(h.jobs, "mail", "done");
    await queue.add("send", {}, { jobId: "doomed", attempts: 5 });

    const failed = await h.call("POST", "/queues/mail/jobs/doomed/fail", {
      reason: "bad address",
    });
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual({ failed: true });
    const job = await queue.getJob("doomed");
    expect(job?.state).toBe("dead");
    expect(job?.failedReason?.message).toBe("bad address");
    expect(job?.failedReason?.name).toBe("UnrecoverableJobError");
    expect(job?.attemptsMade).toBe(0);

    const again = await h.call("POST", "/queues/mail/jobs/doomed/fail", {
      reason: "twice",
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: "JOB_STATE_CONFLICT",
      context: { state: "dead" },
    });
    expect(
      (
        await h.call("POST", "/queues/mail/jobs/done/fail", {
          reason: "too late",
        })
      ).status,
    ).toBe(409);
    expect(
      (await h.call("POST", "/queues/mail/jobs/ghost/fail", { reason: "x" }))
        .status,
    ).toBe(404);
    expect(
      (await h.call("POST", "/queues/mail/jobs/doomed/fail", {})).status,
    ).toBe(400);
  });

  it("retries, removes and promotes in bulk, reporting what went", async () => {
    const h = harness();
    const queue = h.jobs.queue("mail");
    await completed(h.jobs, "mail", "x");
    await completed(h.jobs, "mail", "y");
    await queue.add("send", {}, { jobId: "later", delay: 60_000 });

    expect(
      (
        await h.call("POST", "/queues/mail/jobs/retry", {
          ids: ["x", "ghost", "x"],
        })
      ).body,
    ).toEqual({ retried: ["x"], skipped: ["ghost"] });
    expect(
      (
        await h.call("POST", "/queues/mail/jobs/promote", {
          ids: ["later", "x"],
        })
      ).body,
    ).toEqual({ promoted: ["later"], skipped: ["x"] });
    expect(
      (
        await h.call("POST", "/queues/mail/jobs/remove", {
          ids: ["y", "ghost"],
        })
      ).body,
    ).toEqual({ removed: ["y"], skipped: ["ghost"] });

    const capped = harness({
      jobs: h.jobs,
      limits: { queueCacheMs: 0, maxBulkIds: 1 },
    });
    const over = await capped.call("POST", "/queues/mail/jobs/remove", {
      ids: ["x", "later"],
    });
    expect(over.body).toMatchObject({ code: "BULK_LIMIT" });
    expect(capped.calls).toHaveLength(1);
    expect(capped.calls[0]).not.toHaveProperty("jobIds");
  });

  it("retries every matching dead job, one retry-all per queue at a time", async () => {
    const h = harness();
    const queue = h.jobs.queue("mail");
    await dead(h.jobs, "mail", "d1", "connect ECONNREFUSED 10.0.0.1");
    await dead(h.jobs, "mail", "d2", "connect ECONNREFUSED 10.0.0.2");
    await dead(h.jobs, "mail", "d3", "invalid address");

    const matched = await h.call("POST", "/queues/mail/jobs/retry-all", {
      state: "dead",
      reason: "ECONNREFUSED",
    });
    expect(matched.body).toEqual({
      count: 2,
      ids: ["d1", "d2"],
      truncated: false,
    });
    expect(await queue.count("dead")).toBe(1);

    const original = queue.retryAll.bind(queue);
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.retryAll = async (...args: Parameters<typeof original>) => {
      entered = true;
      await gate;
      return await original(...args);
    };

    const first = h.call("POST", "/queues/mail/jobs/retry-all", {
      state: "dead",
    });
    await waitFor(() => entered);
    const second = await h.call("POST", "/queues/mail/jobs/retry-all", {
      state: "dead",
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: "OPERATION_IN_PROGRESS" });

    release();
    expect((await first).body).toMatchObject({ count: 1, ids: ["d3"] });
    // The lock is released afterwards, however the first one ended.
    expect(
      (await h.call("POST", "/queues/mail/jobs/retry-all", { state: "dead" }))
        .status,
    ).toBe(200);
  });

  it("adds a job only when jobs.add is enabled, by an addable name, with safe options", async () => {
    const byDefault = await withJobs({ actions: undefined });
    expect(
      (
        await byDefault.call("POST", "/queues/mail/jobs", {
          name: "send",
          data: {},
        })
      ).body,
    ).toMatchObject({ code: "ROUTE_NOT_FOUND" });

    const h = await withJobs({
      limits: { queueCacheMs: 0, maxJobDataBytes: 300 },
    });
    h.jobs.define("send", async () => {});

    const added = await h.call("POST", "/queues/mail/jobs", {
      name: "send",
      data: { to: "z@example.com" },
      opts: { jobId: "new-1", priority: 2, attempts: 3, backoff: 1000 },
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      added: true,
      job: { id: "new-1", priority: 2, data: { to: "z@example.com" } },
    });

    const again = await h.call("POST", "/queues/mail/jobs", {
      name: "send",
      data: { to: "other" },
      opts: { jobId: "new-1" },
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      added: false,
      job: { data: { to: "z@example.com" } },
    });

    const delayed = await h.call("POST", "/queues/mail/jobs", {
      name: "send",
      data: null,
      opts: { runAt: "2099-01-01T00:00:00Z" },
    });
    expect(delayed.body.job.state).toBe("delayed");

    const undefinedName = await h.call("POST", "/queues/mail/jobs", {
      name: "wipe-database",
      data: {},
    });
    expect(undefinedName.status).toBe(403);
    expect(undefinedName.body).toMatchObject({ code: "NAME_NOT_ADDABLE" });

    const repeating = await h.call("POST", "/queues/mail/jobs", {
      name: "send",
      data: {},
      opts: { repeat: { every: 1000 } },
    });
    expect(repeating.status).toBe(400);
    expect(repeating.body).toMatchObject({
      code: "VALIDATION",
      issues: [
        { target: "body", path: "opts.repeat", message: "Unknown property" },
      ],
    });

    const huge = await h.call("POST", "/queues/mail/jobs", {
      name: "send",
      data: { blob: "x".repeat(1000) },
    });
    expect(huge.status).toBe(413);

    // Not yet a queue: the first add creates it (see the test below).
    const unknownQueue = await h.call("POST", "/queues/nowhere/jobs", {
      name: "send",
      data: {},
    });
    expect(unknownQueue.status).toBe(201);

    const anyName = harness({ jobs: h.jobs, addableNames: "any" });
    expect(
      (
        await anyName.call("POST", "/queues/mail/jobs", {
          name: "wipe-database",
          data: {},
        })
      ).status,
    ).toBe(201);
  });
});

describe("adding to a queue that does not exist yet", () => {
  it("creates the queue with its first job, and lists it at once", async () => {
    // A long cache: the queue must be listed because the add invalidated it,
    // not because the cache happened to expire.
    const h = harness({
      actions: undefined,
      limits: { queueCacheMs: 60_000 },
    });
    const withAdd = harness({
      jobs: h.jobs,
      limits: { queueCacheMs: 60_000 },
    });
    h.jobs.define("report", async () => {});

    // Warm both caches while the queue does not exist.
    expect((await withAdd.call("GET", "/queues")).body.items).toEqual([]);
    expect((await h.call("GET", "/queues/fresh")).status).toBe(404);

    const added = await withAdd.call("POST", "/queues/fresh/jobs", {
      name: "report",
      data: { day: 1 },
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      added: true,
      job: { queue: "fresh", name: "report", state: "waiting" },
    });
    expect(await h.jobs.queue("fresh").count("waiting")).toBe(1);

    const listed = await withAdd.call("GET", "/queues");
    expect(listed.body.items.map((q: { name: string }) => q.name)).toEqual([
      "fresh",
    ]);
    expect((await withAdd.call("GET", "/queues/fresh")).status).toBe(200);
  });

  it("still refuses a name that is not addable, and a queue outside a configured list", async () => {
    const h = harness({ limits: { queueCacheMs: 60_000 } });
    h.jobs.define("report", async () => {});
    const built: string[] = [];
    const queue = h.jobs.queue.bind(h.jobs);
    h.jobs.queue = ((name: string) => {
      built.push(name);
      return queue(name);
    }) as typeof h.jobs.queue;

    const refused = await h.call("POST", "/queues/fresh/jobs", {
      name: "wipe-database",
      data: {},
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "NAME_NOT_ADDABLE" });
    // Refused before any queue instance was built for the name.
    expect(built).toEqual([]);
    expect(await h.jobs.listQueues()).toEqual([]);

    const listed = harness({ jobs: h.jobs, queues: ["mail"] });
    const outside = await listed.call("POST", "/queues/fresh/jobs", {
      name: "report",
      data: {},
    });
    expect(outside.status).toBe(404);
    expect(outside.body).toMatchObject({ code: "QUEUE_NOT_FOUND" });
    expect(await h.jobs.listQueues()).toEqual([]);

    // A listed queue with no jobs yet takes its first one.
    const inside = await listed.call("POST", "/queues/mail/jobs", {
      name: "report",
      data: {},
    });
    expect(inside.status).toBe(201);
  });
});

describe("actions is an allow-list", () => {
  it("naming only jobs.add and jobs.update disables every other action", async () => {
    const h = harness({ actions: ["jobs.add", "jobs.update"] });
    h.jobs.define("send", async () => {});
    expect(
      (await h.call("POST", "/queues/mail/jobs", { name: "send", data: {} }))
        .status,
    ).toBe(201);
    for (const [method, path] of [
      ["GET", "/meta"],
      ["GET", "/queues"],
      ["GET", "/queues/mail/jobs"],
      ["POST", "/queues/mail/pause"],
      ["GET", "/openapi.json"],
    ] as const) {
      const res = await h.call(method, path);
      expect({ path, status: res.status, code: res.body?.code }).toEqual({
        path,
        status: 404,
        code: "ROUTE_NOT_FOUND",
      });
    }
  });
});

describe("a queue a stale cache missed", () => {
  it("is found on every queue route, with one backend re-read per cache window", async () => {
    const h = harness({ limits: { queueCacheMs: 60_000 } });
    let lists = 0;
    const listQueues = h.jobs.listQueues.bind(h.jobs);
    h.jobs.listQueues = async () => {
      lists++;
      return await listQueues();
    };

    expect((await h.call("GET", "/queues/elsewhere")).status).toBe(404);
    expect(lists).toBe(1);

    // Another process creates the queue; this API's cache still says no.
    const other = new BunQueue("elsewhere", {
      namespace: h.jobs.namespace,
      driver: h.jobs.driver,
    });
    await other.add("send", {}, { jobId: "x1" });

    expect((await h.call("GET", "/queues/elsewhere")).status).toBe(200);
    expect(lists).toBe(2);
    // The re-read refreshed the cache: every queue route sees it now.
    expect((await h.call("GET", "/queues/elsewhere/counts")).status).toBe(200);
    expect((await h.call("GET", "/queues/elsewhere/jobs/x1")).status).toBe(200);
    expect((await h.call("POST", "/queues/elsewhere/pause")).status).toBe(200);
    expect(lists).toBe(2);

    // Unknown names do not become a backend read each: one re-read per window.
    const misses = await Promise.all(
      ["n1", "n2", "n3", "n4"].map((name) => h.call("GET", `/queues/${name}`)),
    );
    expect(misses.map((res) => res.status)).toEqual([404, 404, 404, 404]);
    expect((await h.call("GET", "/queues/n5")).status).toBe(404);
    expect(lists).toBe(2);
  });
});

describe("repeatables and definitions", () => {
  it("lists repeat series without their data unless asked, and removes one", async () => {
    const h = harness();
    await h.jobs.queue("mail").add("send", {});
    await h.jobs
      .queue("mail")
      .add("digest", { secret: true }, { repeat: { every: 60_000 } });

    const listed = await h.call("GET", "/queues/mail/repeatables");
    expect(listed.body.items).toHaveLength(1);
    const [series] = listed.body.items;
    expect(series).toMatchObject({
      queue: "mail",
      name: "digest",
      every: 60_000,
    });
    expect(series).not.toHaveProperty("data");
    expect(
      (await h.call("GET", "/queues/mail/repeatables?include=data")).body
        .items[0].data,
    ).toEqual({ secret: true });

    const path = `/queues/mail/repeatables/${encodeURIComponent(series.key)}`;
    expect((await h.call("DELETE", path)).status).toBe(204);
    const again = await h.call("DELETE", path);
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ code: "REPEATABLE_NOT_FOUND" });
  });

  it("disables and enables a series, idempotently, and lists whether it is disabled", async () => {
    const h = harness();
    const queue = h.jobs.queue("mail");
    await queue.add("digest", {}, { repeat: { every: 60_000, key: "daily" } });
    const pending = (await queue.listRepeatables())[0]!.nextJobId!;

    const listed = await h.call("GET", "/queues/mail/repeatables");
    expect(listed.body.items[0]).toMatchObject({
      key: "daily",
      disabled: false,
    });

    const disabled = await h.call(
      "POST",
      "/queues/mail/repeatables/daily/disable",
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body).toEqual({ disabled: true });
    expect(await queue.getJob(pending)).toBeNull();
    // No next occurrence while disabled: the pointers are null, not the
    // deleted job's.
    expect(
      (await h.call("GET", "/queues/mail/repeatables")).body.items[0],
    ).toMatchObject({
      key: "daily",
      disabled: true,
      nextRunAt: null,
      nextJobId: null,
    });
    // Already disabled: nothing changes, and nothing is wrong.
    expect(
      (await h.call("POST", "/queues/mail/repeatables/daily/disable")).body,
    ).toEqual({ disabled: true });

    const enabled = await h.call(
      "POST",
      "/queues/mail/repeatables/daily/enable",
    );
    expect(enabled.body).toEqual({ enabled: true });
    const series = (await queue.listRepeatables())[0]!;
    expect(series.disabled).toBe(false);
    const next = await queue.getJob(series.nextJobId!);
    expect(next?.state).toBe("delayed");
    expect(series.nextRunAt).toBe(next!.runAt);
    expect(
      (await h.call("GET", "/queues/mail/repeatables")).body.items[0],
    ).toMatchObject({
      disabled: false,
      nextRunAt: next!.runAt,
      nextJobId: next!.id,
    });
    expect(
      (await h.call("POST", "/queues/mail/repeatables/daily/enable")).body,
    ).toEqual({ enabled: true });

    for (const verb of ["disable", "enable"]) {
      const missing = await h.call(
        "POST",
        `/queues/mail/repeatables/nope/${verb}`,
      );
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ code: "REPEATABLE_NOT_FOUND" });
    }
  });

  it("lists definitions without their handlers, and only with a jobs source", async () => {
    const h = harness();
    h.jobs.define(
      "send",
      async function secretHandlerBody() {
        return "handler source must not leak";
      },
      { attempts: 3, priority: 1 },
    );
    const listed = await h.call("GET", "/definitions");
    expect(listed.body).toEqual({
      items: [{ name: "send", options: { attempts: 3, priority: 1 } }],
    });
    expect(listed.text).not.toContain("secretHandlerBody");
    expect(listed.text).not.toContain("must not leak");

    const queue = new BunQueue("mail", {
      namespace: "api-routes",
      driver: new MemoryDriver(),
    });
    const direct = harness({ jobs: undefined, queues: [queue] });
    expect((await direct.call("GET", "/definitions")).body).toMatchObject({
      code: "ROUTE_NOT_FOUND",
    });
  });
});

describe("pruning", () => {
  it("routes no job route in runner mode, and no job mutation under readOnly", async () => {
    const runnerOnly = harness({ mode: "runner" });
    await runnerOnly.jobs.queue("mail").add("send", {});
    expect((await runnerOnly.call("GET", "/queues")).body).toMatchObject({
      code: "ROUTE_NOT_FOUND",
    });

    const readOnly = harness({ readOnly: true });
    await readOnly.jobs.queue("mail").add("send", {}, { jobId: "a" });
    expect((await readOnly.call("GET", "/queues/mail/jobs/a")).status).toBe(
      200,
    );
    for (const [method, path] of [
      ["POST", "/queues/mail/pause"],
      ["DELETE", "/queues/mail/jobs/a"],
      ["POST", "/queues/mail/jobs/retry-all"],
      ["PUT", "/queues/mail/limits"],
    ] as const) {
      const response = await readOnly.call(method, path, {});
      expect({ method, path, status: response.status }).toEqual({
        method,
        path,
        status: 404,
      });
    }
  });
});
