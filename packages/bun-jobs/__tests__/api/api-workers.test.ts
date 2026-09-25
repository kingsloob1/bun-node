import type { JobsApiAuthorizeContext } from "../../lib/api/config";
import type { BunJobs, JobsDriver, WorkerInfo } from "../../lib/index";
import { BunRouter } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { JOBS_API_ACTIONS } from "../../lib/api/config";
import { createJobsApi } from "../../lib/api/createJobsApi";
import {
  isWorkerStale,
  STALE_REPORTS,
  toWorkerDto,
} from "../../lib/api/serialize";
import {
  BunQueueWorker,
  MemoryDriver,
  readWorkerConfig,
  readWorkerControl,
  writeWorkerControl,
} from "../../lib/index";
import { waitFor } from "../helpers";
import {
  apiConfig,
  harness,
  jobsContext,
  openContexts,
  openHarnesses,
} from "./fixtures";

/**
 * The worker routes: listing with filters, reading one worker, the four
 * lifecycle instructions and the configuration overrides.
 *
 * Two kinds of worker appear here on purpose. A **synthetic record**, written
 * straight into the registry, is how a state, a control block or a lapsed
 * heartbeat is put in front of a route exactly — nothing else can produce a
 * `stopping` worker on demand. A **real `BunQueueWorker`** is how the paths
 * that must reach a live process are tested: `?wait=`, and a configuration
 * override being adopted. `validateResponses` is on in the harness, so every
 * answer here is also checked against its declared schema.
 */

/** Workers to close after each test, newest first. */
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
  while (closers.length > 0) {
    await closers.pop()!().catch(() => undefined);
  }
});

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

/** The settings a synthetic record reports, one of each kind. */
const CONFIG_VALUES = {
  concurrency: 1,
  pollInterval: 1_000,
  maxBlock: 1_000,
  lockDuration: 30_000,
  heartbeatInterval: 10_000,
  stalledInterval: 30_000,
  maxStalledCount: 1,
  reportInterval: 10_000,
  drainDelay: 5_000,
};

/** A worker record as a live worker would have written it, plus overrides. */
function workerRecord(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  const now = Date.now();
  // An explicit `undefined` removes a field, so a record from before remote
  // control — no `state`, no `config`, no `control` — can be asked for.
  const given = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<WorkerInfo>;
  const record: WorkerInfo = {
    id: "mail.1",
    key: "mail",
    queue: "mail",
    host: "test-host",
    pid: 4_242,
    concurrency: 1,
    active: 0,
    paused: false,
    state: "running",
    startedAt: now - 1_000,
    processStartedAt: now - 2_000,
    heartbeatAt: now,
    expiresAt: now + 60_000,
    version: "2.13.0",
    config: {
      effective: { ...CONFIG_VALUES },
      code: { ...CONFIG_VALUES },
      overridden: [],
      seq: 0,
    },
    control: {
      enabled: true,
      mode: "poll",
      appliedSeq: 0,
      configSeq: 0,
      pending: false,
      stopPersistence: "process",
      stopPersistenceOverridable: false,
    },
    ...given,
  };
  for (const [field, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete record[field as keyof WorkerInfo];
    }
  }
  return record;
}

/** Writes a synthetic record into a queue's registry, creating the queue. */
async function putWorker(
  jobs: BunJobs,
  overrides: Partial<WorkerInfo> = {},
): Promise<WorkerInfo> {
  const worker = workerRecord(overrides);
  await jobs.driver.connect();
  await jobs.driver.ensureQueue({ ns: jobs.namespace, queue: worker.queue });
  await jobs.driver.registerWorker!(
    { ns: jobs.namespace, queue: worker.queue },
    worker,
  );
  return worker;
}

/** A live worker that obeys remote control, closed after the test. */
function startWorker(
  jobs: BunJobs,
  queue: string,
  options: Record<string, unknown> = {},
): BunQueueWorker<unknown, unknown> {
  const worker = new BunQueueWorker<unknown, unknown>(queue, async () => "ok", {
    namespace: jobs.namespace,
    driver: jobs.driver,
    control: true,
    reportInterval: 1_000,
    pollInterval: 10,
    waitToExit: false,
    ...options,
  });
  closers.push(async () => await worker.close({ force: true }));
  void worker.run();
  return worker;
}

/** A driver with some optional methods hidden, as an older one would be. */
function without(driver: JobsDriver, methods: readonly string[]): JobsDriver {
  const hidden = new Set(methods);
  return new Proxy(driver, {
    get(target, key, receiver) {
      if (typeof key === "string" && hidden.has(key)) {
        return undefined;
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, key) {
      return typeof key === "string" && hidden.has(key)
        ? false
        : Reflect.has(target, key);
    },
  }) as JobsDriver;
}

/** Waits until a queue reports a live worker with that id. */
async function reported(jobs: BunJobs, queue: string, id: string) {
  await waitFor(
    async () =>
      (await jobs.queue(queue).listWorkers()).some(
        (worker) => worker.id === id,
      ),
    { message: `worker ${id} never registered on ${queue}` },
  );
}

describe("reading one worker", () => {
  it("reports the whole record: key, service, state, version, config and control", async () => {
    const jobs = jobsContext("api-workers-read");
    const h = harness({ jobs });
    const worker = await putWorker(jobs, {
      service: "billing",
      key: "billing.mail",
      id: "billing.mail.7f",
    });

    const res = await h.call("GET", "/queues/mail/workers/billing.mail.7f");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "billing.mail.7f",
      key: "billing.mail",
      service: "billing",
      queue: "mail",
      state: "running",
      version: "2.13.0",
      stale: false,
      host: "test-host",
      pid: 4_242,
    });
    expect(res.body.config).toEqual({
      effective: CONFIG_VALUES,
      code: CONFIG_VALUES,
      overridden: [],
      seq: 0,
    });
    expect(res.body.control).toEqual(worker.control);
  });

  it("surfaces rssBytes and heartbeatRttMs, and omits them on a record without them", async () => {
    const jobs = jobsContext("api-workers-samples");
    const h = harness({ jobs });
    await putWorker(jobs, {
      id: "mail.sampled",
      rssBytes: 123_456_789,
      heartbeatRttMs: 2.5,
    });
    // `workerRecord` drops a field given as `undefined`, so this is a record
    // from a worker that reports neither.
    await putWorker(jobs, {
      id: "mail.older",
      rssBytes: undefined,
      heartbeatRttMs: undefined,
    });

    const sampled = await h.call("GET", "/queues/mail/workers/mail.sampled");
    expect(sampled.status).toBe(200);
    // Whole bytes and fractional milliseconds both survive the round trip,
    // and `validateResponses` checks them against `WorkerSchema` on the way.
    expect({
      rssBytes: sampled.body.rssBytes,
      heartbeatRttMs: sampled.body.heartbeatRttMs,
    }).toEqual({ rssBytes: 123_456_789, heartbeatRttMs: 2.5 });

    // Absent, never `0`: an older worker reports nothing, which is a different
    // answer from a process using no memory or a write that took no time.
    const older = await h.call("GET", "/queues/mail/workers/mail.older");
    expect(older.status).toBe(200);
    expect("rssBytes" in older.body).toBe(false);
    expect("heartbeatRttMs" in older.body).toBe(false);

    // And the list says what the reads say.
    const list = await h.call("GET", "/workers");
    const byId = new Map(
      (list.body.items as { id: string }[]).map((item) => [item.id, item]),
    );
    expect(byId.get("mail.sampled")).toMatchObject({
      rssBytes: 123_456_789,
      heartbeatRttMs: 2.5,
    });
    expect("rssBytes" in byId.get("mail.older")!).toBe(false);
  });

  it("is 404 for a worker nothing names, and 410 when an instruction is still stored for it", async () => {
    const jobs = jobsContext("api-workers-gone");
    const h = harness({ jobs });
    await putWorker(jobs);

    const missing = await h.call("GET", "/queues/mail/workers/nobody");
    expect({ status: missing.status, code: missing.body.code }).toEqual({
      status: 404,
      code: "WORKER_NOT_FOUND",
    });

    // The process died: its record lapsed, but the instruction written to it
    // is still there, so the worker is *gone*, not unknown.
    await writeWorkerControl(
      jobs.driver,
      { ns: jobs.namespace, queue: "mail" },
      { id: "ghost", key: "mail", incarnation: 1, state: "stopped" },
    );
    const gone = await h.call("GET", "/queues/mail/workers/ghost");
    expect({ status: gone.status, code: gone.body.code }).toEqual({
      status: 410,
      code: "WORKER_GONE",
    });
  });

  it("calls a worker stale once it is 1.5 report intervals late, and says nothing without a config", () => {
    const now = 1_000_000;
    const late = workerRecord({
      heartbeatAt: now - CONFIG_VALUES.reportInterval * STALE_REPORTS - 1,
    });
    const fresh = workerRecord({
      heartbeatAt: now - CONFIG_VALUES.reportInterval,
    });
    const old = workerRecord({
      heartbeatAt: now - 1_000_000,
      config: undefined,
    });

    expect(isWorkerStale(late, now)).toBe(true);
    expect(isWorkerStale(fresh, now)).toBe(false);
    expect(isWorkerStale(old, now)).toBeUndefined();
    expect(toWorkerDto(old, { exposeHosts: false }, now)).not.toHaveProperty(
      "stale",
    );
    expect(toWorkerDto(late, { exposeHosts: false }, now).stale).toBe(true);
  });
});

describe("listing workers", () => {
  it("filters by queue, service, state and key, and ANDs them", async () => {
    const jobs = jobsContext("api-workers-filter");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "a", key: "mail", service: "billing" });
    await putWorker(jobs, {
      id: "b",
      key: "mail.2",
      service: "billing",
      state: "paused",
      paused: true,
    });
    await putWorker(jobs, {
      id: "c",
      queue: "reports",
      key: "reports",
      service: "analytics",
    });

    const ids = async (query: string) => {
      const listed = await h.call("GET", `/workers${query}`);
      return listed.body.items.map((worker: any) => worker.id).sort();
    };

    expect(await ids("")).toEqual(["a", "b", "c"]);
    expect(await ids("?queue=mail")).toEqual(["a", "b"]);
    expect(await ids("?service=analytics")).toEqual(["c"]);
    expect(await ids("?state=paused")).toEqual(["b"]);
    expect(await ids("?state=paused&state=running")).toEqual(["a", "b", "c"]);
    expect(await ids("?key=mail.2")).toEqual(["b"]);
    // ANDed, not ORed.
    expect(await ids("?queue=mail&service=analytics")).toEqual([]);
    // The queue-scoped listing takes the same filters, minus the queue.
    expect(
      (await h.call("GET", "/queues/mail/workers?state=paused")).body.items.map(
        (worker: any) => worker.id,
      ),
    ).toEqual(["b"]);
  });

  it("refuses a host filter when hosts are hidden, and applies it when they are not", async () => {
    const jobs = jobsContext("api-workers-host");
    const hidden = harness({ jobs, serialize: { exposeHosts: false } });
    await putWorker(jobs, { id: "a", host: "box-1" });
    await putWorker(jobs, { id: "b", host: "box-2" });

    const refused = await hidden.call("GET", "/workers?host=box-1");
    expect({ status: refused.status, code: refused.body.code }).toEqual({
      status: 400,
      code: "INVALID_ARGUMENT",
    });
    expect((await hidden.call("GET", "/workers")).body.items).toHaveLength(2);

    const shown = harness({ jobs: jobsContext("api-workers-host-2") });
    await putWorker(shown.jobs, { id: "a", host: "box-1" });
    await putWorker(shown.jobs, { id: "b", host: "box-2" });
    expect(
      (await shown.call("GET", "/workers?host=box-2")).body.items.map(
        (worker: any) => worker.id,
      ),
    ).toEqual(["b"]);
  });

  it("adds the overrides no live worker carries, only when includeOffline asks", async () => {
    const jobs = jobsContext("api-workers-offline");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "a", key: "mail" });
    await h.call("PUT", "/queues/mail/worker-configs/mail", {
      concurrency: 3,
    });
    await h.call("PUT", "/queues/mail/worker-configs/mail.retired", {
      concurrency: 4,
    });

    const plain = await h.call("GET", "/workers");
    expect(plain.body.offline).toBeUndefined();

    const withOffline = await h.call("GET", "/workers?includeOffline=true");
    expect(withOffline.body.offline).toEqual([
      {
        queue: "mail",
        key: "mail.retired",
        values: { concurrency: 4 },
        seq: expect.any(Number),
        updatedAt: expect.any(Number),
        instances: [],
      },
    ]);
  });
});

describe("a worker on a queue newer than the queue cache", () => {
  it("is listed at once with the default queueCacheMs, and a refused queue's stays hidden", async () => {
    const jobs = jobsContext("api-workers-new-queue");
    const h = harness({
      jobs,
      // The default cache window, not the harness's zero.
      limits: { queueCacheMs: 2_000 },
      listQueues: "authorized",
      authorize: (_req, ctx) =>
        !(ctx.action === "queues.read" && ctx.queue === "secret"),
    });
    // Fills the queue cache while neither queue exists.
    expect((await h.call("GET", "/workers")).body.items).toEqual([]);

    const started = Date.now();
    const fresh = jobs.worker("fresh", async () => null);
    const secret = jobs.worker("secret", async () => null);
    closers.push(async () => await fresh.close({ force: true }));
    closers.push(async () => await secret.close({ force: true }));
    void fresh.run();
    void secret.run();
    await waitFor(async () => (await jobs.listWorkers()).length === 2, {
      timeout: 250,
      message: "the workers never reported",
    });

    const listed = await h.call("GET", "/workers");
    expect(Date.now() - started).toBeLessThan(250);
    expect(listed.body.items.map((worker: any) => worker.id)).toEqual([
      fresh.id,
    ]);
    // The fresh read refreshed the cache for everyone: the queue is listed.
    expect(
      (await h.call("GET", "/queues")).body.items.map((q: any) => q.name),
    ).toEqual(["fresh"]);
  });
});

describe("lifecycle control", () => {
  it("stores the instruction, answers 202, and 200 once the worker acknowledges it", async () => {
    const jobs = jobsContext("api-workers-pause");
    const h = harness({ jobs });
    const worker = startWorker(jobs, "mail");
    await reported(jobs, "mail", worker.id);

    const waited = await h.call(
      "POST",
      `/queues/mail/workers/${worker.id}/pause`,
      { wait: 3_000 },
    );

    expect(waited.status).toBe(200);
    expect(waited.body).toMatchObject({
      desired: "paused",
      applied: true,
      seq: expect.any(Number),
    });
    expect(waited.body.worker.id).toBe(worker.id);
    expect(worker.state).toBe("paused");

    // Without `wait` the route answers as soon as it has stored it.
    const resumed = await h.call(
      "POST",
      `/queues/mail/workers/${worker.id}/resume`,
      {},
    );
    expect(resumed.status).toBe(202);
    expect(resumed.body).toMatchObject({ desired: "running", applied: false });
    expect(resumed.body.worker).toBeUndefined();
    await waitFor(() => worker.state === "running", {
      message: () => `still ${worker.state}`,
    });
  });

  it("honours `?wait=`, the spelling a client sends, and re-reads the worker", async () => {
    const jobs = jobsContext("api-workers-wait-query");
    const h = harness({ jobs });
    const worker = startWorker(jobs, "mail");
    await reported(jobs, "mail", worker.id);

    await h.call("POST", `/queues/mail/workers/${worker.id}/pause`, {
      wait: 3_000,
    });
    expect(worker.state).toBe("paused");

    // The query parameter alone — no body at all, as the UI's client sends it.
    const resumed = await h.call(
      "POST",
      `/queues/mail/workers/${worker.id}/resume?wait=5000`,
    );
    expect({ status: resumed.status, applied: resumed.body.applied }).toEqual({
      status: 200,
      applied: true,
    });
    // `applied` is the re-read, not the write: the worker it answers with is
    // the record as it stands *after* the acknowledgement.
    expect(resumed.body.worker.state).toBe("running");
    expect(resumed.body.worker.control.appliedSeq).toBeGreaterThanOrEqual(
      resumed.body.seq,
    );

    // The same request without it answers 202 with `applied: false`.
    const unwaited = await h.call(
      "POST",
      `/queues/mail/workers/${worker.id}/pause`,
    );
    expect({
      status: unwaited.status,
      applied: unwaited.body.applied,
    }).toEqual({ status: 202, applied: false });
    await waitFor(() => worker.state === "paused");
  });

  it("takes `wait` from the query over the body, and refuses one out of range", async () => {
    const jobs = jobsContext("api-workers-wait-precedence");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "silent" });

    // Body says 3s, query says none: the query wins, so it answers at once.
    const started = Date.now();
    const res = await h.call(
      "POST",
      "/queues/mail/workers/silent/pause?wait=0",
      { wait: 3_000 },
    );
    expect(res.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(1_000);

    const tooLong = await h.call(
      "POST",
      "/queues/mail/workers/silent/pause?wait=60000",
    );
    expect({ status: tooLong.status, code: tooLong.body.code }).toEqual({
      status: 400,
      code: "VALIDATION",
    });
    expect(tooLong.body.issues).toEqual([
      { target: "query", path: "wait", message: expect.any(String) },
    ]);
  });

  it("gives up on `wait` and answers 202, having stored the instruction all the same", async () => {
    const jobs = jobsContext("api-workers-unacked");
    const h = harness({ jobs });
    // A record with nobody behind it: the instruction is stored and nothing
    // ever acknowledges it.
    await putWorker(jobs, { id: "silent" });

    const started = Date.now();
    const res = await h.call("POST", "/queues/mail/workers/silent/pause", {
      wait: 300,
    });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ desired: "paused", applied: false });
    expect(res.body.worker).toBeUndefined();
    // It waited rather than answering at once, and gave up at the deadline.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(
      (
        await readWorkerControl(
          jobs.driver,
          { ns: jobs.namespace, queue: "mail" },
          "silent",
        )
      )?.value.state,
    ).toBe("paused");
  });

  it("is 404 when the record lapsed before the instruction could be written", async () => {
    const jobs = jobsContext("api-workers-vanished");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "a" });

    const res = await h.call("POST", "/queues/mail/workers/b/stop", {});
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 404,
      code: "WORKER_NOT_FOUND",
    });
  });

  it("answers 200 and writes nothing to wait for when the worker is already there", async () => {
    const jobs = jobsContext("api-workers-idempotent");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "p", state: "paused", paused: true });

    const res = await h.call("POST", "/queues/mail/workers/p/pause", {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ desired: "paused", applied: true });
    expect(res.body.worker.state).toBe("paused");
  });

  it("refuses resume on a parked worker: 409, naming start", async () => {
    const jobs = jobsContext("api-workers-conflict");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "s", state: "stopped" });

    const res = await h.call("POST", "/queues/mail/workers/s/resume", {});
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 409,
      code: "WORKER_STATE_CONFLICT",
    });
    expect(res.body.detail).toContain("use start");
    // `start` is what does reach it.
    expect(
      (await h.call("POST", "/queues/mail/workers/s/start", {})).status,
    ).toBe(202);
  });

  it.each([
    { action: "pause", from: { state: "running" as const } },
    { action: "resume", from: { state: "paused" as const, paused: true } },
  ])(
    "answers $action with 409 WORKER_STATE_CONFLICT, not a 500, when the worker stops between the route's check and the call",
    async ({ action, from }) => {
      // The route reads the worker once (allowed), then `WorkerController` resolves
      // it again: from then on the backend says it is stopped, as if it
      // stopped in between, so the library's own check refuses it.
      const memory = new MemoryDriver();
      let reads = 0;
      const racing = new Proxy(memory, {
        get(target, key, receiver) {
          if (key === "listWorkers") {
            return async (...args: Parameters<MemoryDriver["listWorkers"]>) => {
              const workers = await target.listWorkers(...args);
              reads += 1;
              return reads === 1
                ? workers
                : workers.map((worker) => ({ ...worker, state: "stopped" }));
            };
          }
          const value = Reflect.get(target, key, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as JobsDriver;
      const jobs = jobsContext(`api-workers-race-${action}`, racing);
      const h = harness({ jobs });
      await putWorker(jobs, { id: "r", ...from });
      reads = 0;

      const res = await h.call("POST", `/queues/mail/workers/r/${action}`, {});
      expect(reads).toBeGreaterThanOrEqual(2);
      expect({
        status: res.status,
        code: res.body.code,
        context: res.body.context,
      }).toEqual({
        status: 409,
        code: "WORKER_STATE_CONFLICT",
        context: { worker: "r", state: "stopped" },
      });
      expect(res.body.detail).toContain(
        `Worker "r" cannot be ${action}d while it is stopped`,
      );
    },
  );

  it("refuses a worker that does not listen for control", async () => {
    const jobs = jobsContext("api-workers-deaf");
    const h = harness({ jobs });
    await putWorker(jobs, {
      id: "off",
      control: { ...workerRecord().control!, enabled: false },
    });
    await putWorker(jobs, { id: "old", control: undefined });

    for (const id of ["off", "old"]) {
      const res = await h.call(`POST`, `/queues/mail/workers/${id}/pause`, {});
      expect({ id, status: res.status, code: res.body.code }).toEqual({
        id,
        status: 409,
        code: "WORKER_NOT_CONTROLLABLE",
      });
    }
  });

  it("lets the worker, not the caller, decide how long a stop lasts", async () => {
    const jobs = jobsContext("api-workers-persist");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "fixed" });
    await putWorker(jobs, {
      id: "open",
      control: {
        ...workerRecord().control!,
        stopPersistenceOverridable: true,
      },
    });

    const refused = await h.call("POST", "/queues/mail/workers/fixed/stop", {
      persist: "key",
    });
    expect({ status: refused.status, code: refused.body.code }).toEqual({
      status: 409,
      code: "WORKER_PERSISTENCE_NOT_ALLOWED",
    });

    // The worker's own value applies, and is reported, when none is asked for.
    const own = await h.call("POST", "/queues/mail/workers/fixed/stop", {});
    expect(own.body.persisted).toBe("process");

    const allowed = await h.call("POST", "/queues/mail/workers/open/stop", {
      persist: "key",
    });
    expect(allowed.body.persisted).toBe("key");
    expect(
      (
        await readWorkerControl(
          jobs.driver,
          { ns: jobs.namespace, queue: "mail" },
          "open",
        )
      )?.value.persist,
    ).toBe("key");
  });

  it("forwards a stop timeout, and refuses one on the other three actions", async () => {
    const jobs = jobsContext("api-workers-timeout");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "t" });

    const stopped = await h.call("POST", "/queues/mail/workers/t/stop", {
      timeout: 5_000,
    });
    expect(stopped.status).toBe(202);
    expect(
      (
        await readWorkerControl(
          jobs.driver,
          { ns: jobs.namespace, queue: "mail" },
          "t",
        )
      )?.value.timeout,
    ).toBe(5_000);

    for (const action of ["pause", "resume", "start"]) {
      const res = await h.call(`POST`, `/queues/mail/workers/t/${action}`, {
        timeout: 5_000,
      });
      expect({ action, status: res.status, code: res.body.code }).toEqual({
        action,
        status: 400,
        code: "INVALID_ARGUMENT",
      });
    }

    // Out of range is refused by the schema, before anything is stored.
    const huge = await h.call("POST", "/queues/mail/workers/t/stop", {
      timeout: 3_600_001,
    });
    expect({ status: huge.status, code: huge.body.code }).toEqual({
      status: 400,
      code: "VALIDATION",
    });
  });
});

describe("configuration overrides", () => {
  it("merges a patch, clears one field with null, and resets the lot", async () => {
    const jobs = jobsContext("api-workers-config");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "a", key: "mail" });

    const first = await h.call("PUT", "/queues/mail/worker-configs/mail", {
      concurrency: 8,
      pollInterval: 250,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      queue: "mail",
      key: "mail",
      values: { concurrency: 8, pollInterval: 250 },
      instances: [{ id: "a", applied: false, state: "running" }],
    });

    // A merge patch: what is left out stays, and `null` clears one field.
    const merged = await h.call("PUT", "/queues/mail/worker-configs/mail", {
      pollInterval: null,
      maxBlock: 500,
    });
    expect(merged.body.values).toEqual({ concurrency: 8, maxBlock: 500 });
    expect(merged.body.seq).toBeGreaterThan(first.body.seq);

    const listed = await h.call("GET", "/queues/mail/worker-configs");
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].values).toEqual({
      concurrency: 8,
      maxBlock: 500,
    });

    const reset = await h.call("DELETE", "/queues/mail/worker-configs/mail");
    expect(reset.status).toBe(200);
    expect(reset.body.values).toEqual({});
    // Emptied, never deleted: the version keeps rising, so a worker that had
    // applied an older one cannot believe it is up to date.
    expect(reset.body.seq).toBeGreaterThan(merged.body.seq);
  });

  it("refuses a write whose expectedSeq has moved on", async () => {
    const jobs = jobsContext("api-workers-contend");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "a" });

    const stored = await h.call("PUT", "/queues/mail/worker-configs/mail", {
      concurrency: 2,
    });
    const stale = await h.call("PUT", "/queues/mail/worker-configs/mail", {
      concurrency: 3,
      expectedSeq: stored.body.seq - 1,
    });

    expect({ status: stale.status, code: stale.body.code }).toEqual({
      status: 409,
      code: "CONTROL_CONTENDED",
    });
    // Nothing was written.
    expect(
      (
        await readWorkerConfig(
          jobs.driver,
          { ns: jobs.namespace, queue: "mail" },
          "mail",
        )
      )?.value.values,
    ).toEqual({ concurrency: 2 });
  });

  it("enforces the bounds, and the one rule that spans two fields", async () => {
    const jobs = jobsContext("api-workers-bounds");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "a", key: "mail" });

    const low = await h.call("PUT", "/queues/mail/worker-configs/mail", {
      concurrency: 0,
    });
    expect({ status: low.status, code: low.body.code }).toEqual({
      status: 400,
      code: "VALIDATION",
    });

    // Each bound is the schema's; the pair is the route's, checked against the
    // *merged effective* values of the live worker (code lockDuration 30s).
    const pair = await h.call("PUT", "/queues/mail/worker-configs/mail", {
      heartbeatInterval: 20_000,
    });
    expect({ status: pair.status, code: pair.body.code }).toEqual({
      status: 400,
      code: "VALIDATION",
    });
    expect(pair.body.issues).toEqual([
      {
        target: "body",
        path: "heartbeatInterval",
        message: expect.stringContaining("half of lockDuration"),
      },
    ]);
    // Raising the lock in the same patch makes the pair hold.
    expect(
      (
        await h.call("PUT", "/queues/mail/worker-configs/mail", {
          heartbeatInterval: 20_000,
          lockDuration: 60_000,
        })
      ).status,
    ).toBe(200);
  });

  it("reaches a live worker, which adopts it and reports it applied", async () => {
    const jobs = jobsContext("api-workers-adopt");
    const h = harness({ jobs });
    const worker = startWorker(jobs, "mail", { key: "svc.mail" });
    await reported(jobs, "mail", worker.id);

    const res = await h.call("PUT", "/queues/mail/worker-configs/svc.mail", {
      concurrency: 5,
    });
    expect(res.status).toBe(200);
    expect(res.body.instances.map((one: any) => one.id)).toEqual([worker.id]);

    await waitFor(() => worker.concurrency === 5, {
      message: () => `concurrency is ${worker.concurrency}`,
    });
    await waitFor(
      async () => {
        const seen = await h.call("GET", `/queues/mail/workers/${worker.id}`);
        return seen.body.config.overridden.length > 0;
      },
      { message: "the worker never reported the override" },
    );
    const read = await h.call("GET", `/queues/mail/workers/${worker.id}`);
    expect(read.body.config.effective.concurrency).toBe(5);
    expect(read.body.config.code.concurrency).not.toBe(5);
    expect(read.body.config.overridden).toEqual(["concurrency"]);
  });

  it("is opt-in: a default configuration serves neither configuration route", async () => {
    const jobs = jobsContext("api-workers-optin");
    await putWorker(jobs, { id: "a" });
    // No `actions`: the default list, which leaves out every opt-in action.
    const off = createJobsApi(apiConfig({ jobs }));
    const root = new BunRouter();
    root.use(off.basePath, off.router);

    expect(
      off.routes.filter((route) => route.action === "workers.configure"),
    ).toEqual([]);
    // The rest of the worker surface is on by default: `queues.pause` already
    // stops every worker on a queue, so a single worker's stop being opt-in
    // would be stricter than the blunter tool.
    expect(off.routes.map((route) => route.action)).toContain("workers.stop");

    const refused = await root.fetch(
      "/admin/jobs/queues/mail/worker-configs/mail",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrency: 2 }),
      },
    );
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ code: "ROUTE_NOT_FOUND" });

    // Asked for by name, both routes appear.
    const on = harness({ jobs });
    expect(
      on.api.routes
        .filter((route) => route.action === "workers.configure")
        .map((route) => route.operationId)
        .sort(),
    ).toEqual(["configureWorker", "resetWorkerConfig"]);
  });
});

describe("authorization", () => {
  it("names the worker and the key in the target, with the queue", async () => {
    const jobs = jobsContext("api-workers-target");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "a", key: "mail" });

    await h.call("POST", "/queues/mail/workers/a/pause", {});
    await h.call("PUT", "/queues/mail/worker-configs/mail", {
      concurrency: 2,
    });
    await h.call("GET", "/queues/mail/workers/a");

    const of = (action: string) =>
      h.calls.find(
        (call: JobsApiAuthorizeContext) => call.action === action,
      ) as JobsApiAuthorizeContext;
    expect(of("workers.pause")).toMatchObject({
      queue: "mail",
      worker: "a",
      mutation: true,
    });
    expect(of("workers.pause").workerKey).toBeUndefined();
    expect(of("workers.configure")).toMatchObject({
      queue: "mail",
      workerKey: "mail",
      mutation: true,
    });
    expect(of("workers.read")).toMatchObject({ queue: "mail", worker: "a" });
  });

  it("obeys a host that refuses one queue, and one that refuses an untargeted request", async () => {
    const jobs = jobsContext("api-workers-authz");
    const byQueue = harness({
      jobs,
      authorize: (_req, context) => context.queue !== "secret",
    });
    await putWorker(jobs, { id: "a", key: "mail" });
    await putWorker(jobs, { id: "s", queue: "secret", key: "secret" });

    expect(
      (await byQueue.call("POST", "/queues/secret/workers/s/pause", {})).status,
    ).toBe(403);
    expect(
      (await byQueue.call("PUT", "/queues/secret/worker-configs/secret", {}))
        .status,
    ).toBe(403);
    expect(
      (await byQueue.call("POST", "/queues/mail/workers/a/pause", {})).status,
    ).toBe(202);

    // The real-target rule: a host may refuse anything it cannot see a queue
    // for. The namespace-wide listing carries none, the queue-scoped one does.
    const targeted = harness({
      jobs,
      authorize: (_req, context) => context.queue !== undefined,
    });
    expect((await targeted.call("GET", "/workers")).status).toBe(403);
    expect((await targeted.call("GET", "/queues/mail/workers")).status).toBe(
      200,
    );
    expect(
      (await targeted.call("GET", "/queues/mail/worker-configs")).status,
    ).toBe(200);
  });

  it("refuses a worker id that is not a key segment before reading anything", async () => {
    const jobs = jobsContext("api-workers-name");
    const h = harness({ jobs });
    await putWorker(jobs, { id: "a" });

    const res = await h.call("GET", "/queues/mail/workers/not%20a%20segment");
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 400,
      code: "INVALID_NAME",
    });
    // `authorize` is still asked first, and with no target at all — the same
    // as an invalid queue name, because a path that does not parse decides
    // nothing. A host refusing untargeted requests therefore answers 403
    // before the caller learns the name was malformed.
    expect(h.calls.at(-1)).toEqual({
      action: "workers.read",
      mutation: false,
      transport: "http",
      route: { method: "GET", path: "/queues/:queue/workers/:worker" },
    });
    const badQueue = await h.call("GET", "/queues/not%20a%20queue/workers/a");
    expect(badQueue.body.code).toBe("INVALID_NAME");
    expect(h.calls.at(-1)!.queue).toBeUndefined();
  });
});

describe("/meta and pruning", () => {
  it("reports workerControl, and turns it off on a backend that cannot store it", async () => {
    const h = harness();
    expect((await h.call("GET", "/meta")).body.features).toMatchObject({
      workers: true,
      workerControl: true,
    });

    // Queue state is what the desired state and the overrides are stored in:
    // without it a worker can be listed but never controlled.
    const stateless = harness({
      jobs: jobsContext(
        "api-workers-stateless",
        without(new MemoryDriver(), ["setQueueState"]),
      ),
    });
    expect((await stateless.call("GET", "/meta")).body.features).toMatchObject({
      workers: true,
      workerControl: false,
    });
  });

  it("prunes every control route on a backend that cannot store the desired state", async () => {
    const stateless = harness({
      jobs: jobsContext(
        "api-workers-pruned",
        without(new MemoryDriver(), ["setQueueState"]),
      ),
    });
    const operations = stateless.api.routes.map((route) => route.operationId);

    // Listing and reading survive: the registry is still there.
    expect(operations).toContain("listWorkers");
    expect(operations).toContain("getWorker");
    for (const pruned of [
      "pauseWorker",
      "resumeWorker",
      "stopWorker",
      "startWorker",
      "listWorkerConfigs",
      "configureWorker",
      "resetWorkerConfig",
    ]) {
      expect({ pruned, routed: operations.includes(pruned) }).toEqual({
        pruned,
        routed: false,
      });
    }
    // And a request to one is a plain 404, never a 501.
    const res = await stateless.call(
      "POST",
      "/queues/mail/workers/a/pause",
      {},
    );
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 404,
      code: "ROUTE_NOT_FOUND",
    });
  });
});

describe("the documents", () => {
  /** The OpenAPI document of an API with every action enabled. */
  function openapi(overrides: Record<string, unknown> = {}) {
    const api = createJobsApi(
      apiConfig({
        jobs: jobsContext("api-workers-docs"),
        actions: [...JOBS_API_ACTIONS],
        ...overrides,
      }),
    );
    return api.openapi() as unknown as {
      paths: Record<string, Record<string, any>>;
      components: { schemas: Record<string, unknown> };
    };
  }

  it("documents every route, its schemas, and the name pattern on both new params", () => {
    const doc = openapi();
    // The worker analytics routes are the analytics suite's to pin.
    const paths = Object.keys(doc.paths).filter(
      (path) => path.includes("worker") && !path.includes("/analytics/"),
    );
    expect(paths).toEqual([
      "/queues/{queue}/workers",
      "/workers",
      "/queues/{queue}/workers/{worker}",
      "/queues/{queue}/workers/{worker}/pause",
      "/queues/{queue}/workers/{worker}/resume",
      "/queues/{queue}/workers/{worker}/stop",
      "/queues/{queue}/workers/{worker}/start",
      "/queues/{queue}/worker-configs",
      "/queues/{queue}/worker-configs/{key}",
    ]);

    // The pattern the route enforces itself, documented on the parameter —
    // the rule `:queue` already follows.
    const patternOf = (path: string, method: string, name: string) =>
      doc.paths[path]![method].parameters.find(
        (param: any) => param.name === name,
      ).schema.pattern;
    expect(patternOf("/queues/{queue}/workers/{worker}", "get", "worker")).toBe(
      patternOf("/queues/{queue}/workers/{worker}", "get", "queue"),
    );
    expect(
      patternOf("/queues/{queue}/worker-configs/{key}", "put", "key"),
    ).toBe(patternOf("/queues/{queue}/worker-configs/{key}", "put", "queue"));

    // Every DTO is a named component, so a client generator emits one type.
    expect(
      Object.keys(doc.components.schemas)
        // The analytics components are the analytics suite's to pin.
        .filter(
          (name) =>
            name.startsWith("Worker") &&
            !/Analytics|Busyness|WorkerJobs/.test(name),
        )
        .sort(),
    ).toEqual([
      "Worker",
      "WorkerConfig",
      "WorkerConfigBody",
      "WorkerConfigOverride",
      "WorkerConfigPatch",
      "WorkerConfigResult",
      "WorkerConfigValues",
      "WorkerControl",
      "WorkerControlBody",
      "WorkerControlResult",
      "WorkerState",
      "WorkerStopPersistence",
      "WorkerTargetInfo",
    ]);

    // The statuses the design fixed: 200 and 202 on a control route, 200 on a
    // config one, and every error code it can answer with.
    const pause = doc.paths["/queues/{queue}/workers/{worker}/pause"]!.post;
    expect(Object.keys(pause.responses)).toContain("202");
    expect(
      Object.values(pause.responses).flatMap(
        (response: any) => response["x-bun-jobs-codes"] ?? [],
      ),
    ).toEqual(
      expect.arrayContaining([
        "WORKER_NOT_FOUND",
        "WORKER_GONE",
        "WORKER_STATE_CONFLICT",
        "WORKER_NOT_CONTROLLABLE",
        "WORKER_PERSISTENCE_NOT_ALLOWED",
        "INVALID_ARGUMENT",
      ]),
    );
    expect(
      Object.values(
        doc.paths["/queues/{queue}/worker-configs/{key}"]!.put.responses,
      ).flatMap((response: any) => response["x-bun-jobs-codes"] ?? []),
    ).toContain("CONTROL_CONTENDED");
  });

  it("carries the CSRF header on a worker mutation, exactly as a queue mutation does", () => {
    const doc = openapi({ csrf: { header: "x-csrf" } });
    const headerOf = (path: string, method: string) =>
      doc.paths[path]![method].parameters.find(
        (param: any) => param.in === "header",
      );
    expect(headerOf("/queues/{queue}/workers/{worker}/stop", "post")).toEqual(
      headerOf("/queues/{queue}/pause", "post"),
    );
    expect(
      headerOf("/queues/{queue}/worker-configs/{key}", "delete"),
    ).toMatchObject({ name: "x-csrf", required: true });
    // A read carries none.
    expect(headerOf("/queues/{queue}/workers/{worker}", "get")).toBeUndefined();
  });
});

describe("a worker's target", () => {
  const target = {
    kind: "child-process" as const,
    processor: "file" as const,
    file: "/srv/app/jobs/resize.ts",
  };

  it("serves target without the processor file's path by default", async () => {
    const jobs = jobsContext("api-workers-target");
    const h = harness({ jobs });
    await putWorker(jobs, { target });

    const one = await h.call("GET", "/queues/mail/workers/mail.1");
    const list = await h.call("GET", "/workers");

    expect(one.status).toBe(200);
    expect(one.body.target).toEqual({
      kind: "child-process",
      processor: "file",
    });
    expect(list.body.items[0].target).toEqual({
      kind: "child-process",
      processor: "file",
    });
    expect(one.text).not.toContain("/srv/app/jobs");
  });

  it("serves the path with exposeProcessorFiles, and a custom target's name", async () => {
    const jobs = jobsContext("api-workers-target-files");
    const h = harness({ jobs, serialize: { exposeProcessorFiles: true } });
    await putWorker(jobs, { target });
    await putWorker(jobs, {
      id: "mail.2",
      target: { kind: "custom", processor: "function", name: "grpc-pool" },
    });

    const file = await h.call("GET", "/queues/mail/workers/mail.1");
    const custom = await h.call("GET", "/queues/mail/workers/mail.2");

    expect(file.body.target).toEqual(target);
    expect(custom.body.target).toEqual({
      kind: "custom",
      processor: "function",
      name: "grpc-pool",
    });
  });

  it("leaves target off an older worker's record: absent, never in-process", async () => {
    const jobs = jobsContext("api-workers-target-old");
    const h = harness({ jobs, serialize: { exposeProcessorFiles: true } });
    await putWorker(jobs);

    const res = await h.call("GET", "/queues/mail/workers/mail.1");

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("target");
  });
});
