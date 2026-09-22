import type { BunRequest } from "@kingsleyweb/bun-common";
import type {
  ResolvedJobsApiConfig,
  ResolvedJobsApiSerializers,
} from "../../lib/api/config";
import type {
  DriverEvent,
  JobRecord,
  RemoteRunnerInfo,
  RepeatRecord,
  RunRecord,
} from "../../lib/index";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { resolveConfig } from "../../lib/api/config";
import { ApiError } from "../../lib/api/errors";
import {
  JOB_LIST_INCLUDE,
  JOB_READ_INCLUDE,
  toErrorDto,
  toEventDto,
  toJobDto,
  toRepeatableDto,
  toRunnerInfoDto,
  toRunRecordDto,
  toWorkerDto,
} from "../../lib/api/serialize";
import { parseSegment, QueueSource, RunnerSource } from "../../lib/api/sources";
import { BunJobs, BunQueue, MemoryDriver, runnerKey } from "../../lib/index";

const contexts: BunJobs[] = [];

afterAll(async () => {
  await Promise.all(contexts.map((jobs) => jobs.close()));
});

/** A fresh context over the memory driver. */
function jobsContext(namespace = "api-sources") {
  const jobs = new BunJobs({ namespace, driver: new MemoryDriver() });
  contexts.push(jobs);
  return jobs;
}

/** Resolves a configuration around `jobs`. */
function resolve(
  jobs: BunJobs,
  overrides: Record<string, unknown> = {},
): ResolvedJobsApiConfig {
  return resolveConfig({
    jobs,
    basePath: "/admin/jobs",
    authorize: () => true,
    logger: createTestLogger().logger,
    ...overrides,
  });
}

/** Awaits `promise`, expecting an ApiError with this code and status. */
async function expectApiError(
  promise: Promise<unknown>,
  code: string,
  status: number,
) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  expect((error as ApiError).status).toBe(status);
}

/** A controllable clock. */
function clock() {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("parseSegment", () => {
  it("accepts key segments and refuses anything else with 400 INVALID_NAME", () => {
    expect(parseSegment("mail.v2_high-1", "queue")).toBe("mail.v2_high-1");
    for (const bad of [
      "",
      ".",
      "..",
      "a/b",
      "a:b",
      "a b",
      "x".repeat(201),
      42,
      undefined,
    ]) {
      let thrown: unknown;
      try {
        parseSegment(bad, "runner");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).code).toBe("INVALID_NAME");
      expect((thrown as ApiError).status).toBe(400);
      expect((thrown as ApiError).message).toMatch(/runner id/);
    }
  });
});

describe("QueueSource", () => {
  it("checks membership against a cached listQueues, and only then builds the queue", async () => {
    const jobs = jobsContext();
    await jobs.queue("mail").add("send", {});

    let lists = 0;
    const listQueues = jobs.listQueues.bind(jobs);
    jobs.listQueues = async () => {
      lists++;
      return await listQueues();
    };
    const built: string[] = [];
    const queue = jobs.queue.bind(jobs);
    jobs.queue = ((name: string) => {
      built.push(name);
      return queue(name);
    }) as typeof jobs.queue;

    const time = clock();
    const source = new QueueSource(resolve(jobs), { now: time.now });

    // Unknown and invalid names never reach `jobs.queue`, which would cache an
    // instance per name forever.
    await expectApiError(source.get("ghost"), "QUEUE_NOT_FOUND", 404);
    await expectApiError(source.get("bad/name"), "INVALID_NAME", 400);
    expect(built).toEqual([]);

    expect(await source.get("mail")).toBe(queue("mail"));
    expect(built).toEqual(["mail"]);
    expect(await source.names()).toEqual(["mail"]);
    expect(lists).toBe(1);

    // Concurrent checks share one read; a stale cache is read again. The miss
    // for "x" was answered by that fresh read, so it is final: no re-read.
    time.advance(2_000);
    await Promise.all([
      source.has("mail"),
      source.has("mail"),
      source.has("x"),
    ]);
    expect(lists).toBe(2);

    // A queue created elsewhere is missing from the cache, so the miss is
    // checked against the backend once more before it is believed.
    await jobs.queue("reports").add("build", {});
    expect(await source.has("reports")).toBe(true);
    expect(lists).toBe(3);

    // At most one such re-read per cache window, however many misses: the
    // next queue created elsewhere waits for the cache to expire, or for an
    // invalidate.
    await jobs.queue("audit").add("log", {});
    expect(
      await Promise.all([source.has("audit"), source.has("ghost")]),
    ).toEqual([false, false]);
    expect(lists).toBe(3);
    source.invalidate();
    expect(await source.has("audit")).toBe(true);
    expect(lists).toBe(4);

    // Once the window has passed, a miss may re-read again.
    time.advance(2_000);
    expect(await source.has("mail")).toBe(true);
    expect(lists).toBe(5);
    await jobs.queue("late").add("log", {});
    expect(await source.has("late")).toBe(true);
    expect(lists).toBe(6);
  });

  it("shares one re-read between misses arriving together", async () => {
    const jobs = jobsContext("api-sources-share");
    await jobs.queue("mail").add("send", {});
    let lists = 0;
    const listQueues = jobs.listQueues.bind(jobs);
    jobs.listQueues = async () => {
      lists++;
      return await listQueues();
    };
    const time = clock();
    const source = new QueueSource(resolve(jobs), { now: time.now });
    expect(await source.has("mail")).toBe(true);
    await jobs.queue("new").add("send", {});

    expect(
      await Promise.all([
        source.has("new"),
        source.has("new"),
        source.has("ghost"),
      ]),
    ).toEqual([true, true, false]);
    expect(lists).toBe(2);
  });

  it("confirms backend-sourced names with a fresh read, past has()'s one-per-window limit", async () => {
    const jobs = jobsContext("api-sources-confirm");
    await jobs.queue("mail").add("send", {});
    let lists = 0;
    const listQueues = jobs.listQueues.bind(jobs);
    jobs.listQueues = async () => {
      lists++;
      return await listQueues();
    };
    const time = clock();
    const source = new QueueSource(resolve(jobs), { now: time.now });
    expect(await source.names()).toEqual(["mail"]);

    // The window's one re-read goes on a first new queue...
    await jobs.queue("first").add("n", {});
    expect(await source.has("first")).toBe(true);
    expect(lists).toBe(2);
    // ...so has() cannot see a second one until the window passes.
    await jobs.queue("second").add("n", {});
    expect(await source.has("second")).toBe(false);

    // confirm() is for names a worker record gave, which exist: it reads
    // again, and only what the backend lists comes back.
    expect([...(await source.confirm(["second", "mail", "ghost"]))]).toEqual([
      "second",
      "mail",
    ]);
    expect(lists).toBe(3);
    // The fresh read is the cache now, for every caller.
    expect(await source.names()).toEqual(["first", "mail", "second"]);
    // Nothing missing: answered from the cache, and concurrent misses share.
    expect([...(await source.confirm(["mail"]))]).toEqual(["mail"]);
    await jobs.queue("third").add("n", {});
    await Promise.all([source.confirm(["third"]), source.confirm(["third"])]);
    expect(lists).toBe(4);

    // With a configured list, only its members, and no backend read.
    const listed = new QueueSource(resolve(jobs, { queues: ["mail"] }));
    expect([...(await listed.confirm(["mail", "second"]))]).toEqual(["mail"]);
    expect(lists).toBe(4);
  });

  it("builds an unknown queue for an add, and still refuses one outside a configured list", async () => {
    const jobs = jobsContext("api-sources-add");
    const all = new QueueSource(resolve(jobs));
    const fresh = await all.getForAdd("fresh");
    expect(fresh.created).toBe(true);
    expect(fresh.queue).toBe(jobs.queue("fresh"));
    await expectApiError(all.getForAdd("bad/name"), "INVALID_NAME", 400);

    await jobs.queue("mail").add("send", {});
    all.invalidate();
    const known = await all.getForAdd("mail");
    expect(known.created).toBe(false);

    const listed = new QueueSource(resolve(jobs, { queues: ["mail"] }));
    expect((await listed.getForAdd("mail")).created).toBe(false);
    await expectApiError(listed.getForAdd("fresh"), "QUEUE_NOT_FOUND", 404);
  });

  it("reads the backend every time with queueCacheMs 0", async () => {
    const jobs = jobsContext();
    let lists = 0;
    const listQueues = jobs.listQueues.bind(jobs);
    jobs.listQueues = async () => {
      lists++;
      return await listQueues();
    };
    const source = new QueueSource(
      resolve(jobs, { limits: { queueCacheMs: 0 } }),
    );
    await source.has("a");
    await source.has("a");
    expect(lists).toBe(2);
  });

  it("restricts to a configured list without asking the backend", async () => {
    const jobs = jobsContext();
    jobs.listQueues = async () => {
      throw new Error("must not be called");
    };
    const instance = new BunQueue("direct", {
      namespace: "api-sources",
      driver: jobs.driver,
    });
    const source = new QueueSource(
      resolve(jobs, { queues: ["mail", instance] }),
    );

    expect(await source.names()).toEqual(["direct", "mail"]);
    expect(await source.get("direct")).toBe(instance);
    expect(await source.get("mail")).toBe(jobs.queue("mail"));
    await expectApiError(source.get("reports"), "QUEUE_NOT_FOUND", 404);
  });
});

describe("RunnerSource", () => {
  const file = new URL("../fixtures/handlers/echo.ts", import.meta.url);

  /**
   * Makes the backend know a runner the way another process's `start()` does:
   * by persisting its state under the shared driver and namespace.
   */
  async function registerElsewhere(jobs: BunJobs, id: string) {
    await jobs.driver.connect();
    await jobs.driver.setState(jobs.namespace, runnerKey(id), {
      name: id,
      paused: "0",
      updatedAt: Date.now(),
    });
  }

  it("resolves local and remote runners with a controller, and 404s the rest", async () => {
    const jobs = jobsContext();
    const local = jobs.runner({
      id: "local",
      file,
      executionMode: "in-process",
    });
    await registerElsewhere(jobs, "remote");

    const source = new RunnerSource(resolve(jobs));
    expect(await source.list()).toEqual({ local: [local], remote: ["remote"] });

    const here = await source.resolve("local");
    expect(here.local).toBe(true);
    expect(here.local && here.runner).toBe(local);
    expect(here.controller.isLocal).toBe(true);

    const elsewhere = await source.resolve("remote");
    expect(elsewhere.local).toBe(false);
    expect(elsewhere).not.toHaveProperty("runner");
    expect(elsewhere.controller.isLocal).toBe(false);
    // The controller really reaches the runner through the backend.
    await elsewhere.controller.pause();
    expect((await elsewhere.controller.info()).isPaused).toBe(true);

    await expectApiError(source.resolve("ghost"), "RUNNER_NOT_FOUND", 404);
    await expectApiError(source.resolve("bad id"), "INVALID_NAME", 400);
  });

  it("keeps kill and stats reset local-only, with 409 RUNNER_NOT_LOCAL", async () => {
    const jobs = jobsContext();
    const local = jobs.runner({
      id: "local",
      file,
      executionMode: "in-process",
    });
    await registerElsewhere(jobs, "remote");
    const source = new RunnerSource(resolve(jobs));

    expect(await source.requireLocal("local", "kill")).toBe(local);
    expect(await source.requireLocal("local", "resetStats")).toBe(local);
    for (const operation of ["kill", "resetStats"] as const) {
      const error = await source.requireLocal("remote", operation).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("RUNNER_NOT_LOCAL");
      expect((error as ApiError).status).toBe(409);
      expect((error as ApiError).context).toEqual({
        runner: "remote",
        operation,
      });
    }
    await expectApiError(
      source.requireLocal("ghost", "kill"),
      "RUNNER_NOT_FOUND",
      404,
    );
  });

  it("caches discovery for listing", async () => {
    const jobs = jobsContext();
    let discoveries = 0;
    jobs.runners.discover = async () => {
      discoveries++;
      return ["remote"];
    };
    const time = clock();
    const source = new RunnerSource(resolve(jobs), { now: time.now });
    await source.list();
    await source.list();
    expect(discoveries).toBe(1);
    time.advance(5_000);
    expect(await source.list()).toEqual({ local: [], remote: ["remote"] });
    expect(discoveries).toBe(2);
  });

  it("finds only the listed runners for a fixed list, and none with runners: false", async () => {
    const jobs = jobsContext();
    const listed = jobs.runner({
      id: "listed",
      file,
      executionMode: "in-process",
    });
    jobs.runner({ id: "unlisted", file, executionMode: "in-process" });
    await registerElsewhere(jobs, "remote");

    const fixed = new RunnerSource(resolve(jobs, { runners: [listed] }));
    expect(await fixed.list()).toEqual({ local: [listed], remote: [] });
    const found = await fixed.resolve("listed");
    expect(found.local && found.runner).toBe(listed);
    expect(found.controller.isLocal).toBe(true);
    // Known to the manager and to the backend, but not on the list.
    await expectApiError(fixed.resolve("unlisted"), "RUNNER_NOT_FOUND", 404);
    await expectApiError(fixed.resolve("remote"), "RUNNER_NOT_FOUND", 404);

    const none = new RunnerSource(resolve(jobs, { runners: false }));
    expect(none.local()).toEqual([]);
    await expectApiError(none.resolve("listed"), "RUNNER_NOT_FOUND", 404);
  });
});

describe("serializers", () => {
  const req = {} as BunRequest;
  const defaults: ResolvedJobsApiSerializers = {
    exposeStacks: false,
    exposeRunnerFiles: false,
    exposeHosts: true,
  };
  const failure = {
    name: "Error",
    message: "boom",
    stack: "Error: boom\n    at secret/path.ts:1",
    code: "E_BOOM",
    cause: {
      name: "TypeError",
      message: "inner",
      stack: "TypeError: inner\n    at x",
    },
  };
  const record: JobRecord = {
    id: "1",
    name: "send",
    data: { email: "a@example.com" },
    opts: {
      priority: 0,
      attempts: 3,
      backoff: 1000,
      timeout: 0,
      removeOnComplete: false,
      removeOnFail: false,
      keepStacktraces: 10,
    },
    state: "failed",
    priority: 0,
    runAt: 10,
    createdAt: 1,
    processedOn: 5,
    finishedOn: null,
    expiresAt: null,
    attemptsMade: 1,
    maxAttempts: 3,
    stalledCount: 0,
    progress: 50,
    returnValue: null,
    failedReason: failure,
    stacktrace: [failure],
    lockToken: "host:123:token-that-must-never-leave",
    lockExpiresAt: 99,
    workerId: "w1",
    repeatKey: null,
    flow: {
      parent: null,
      children: [{ queue: "q", id: "c" }],
      pending: 0,
      values: {},
      failures: { "q:c": failure },
      recorded: true,
    },
  };

  it("never emits lockToken, nor a field nobody chose to publish", () => {
    const withExtra = { ...record, internalSecret: "nope" } as JobRecord;
    const dto = toJobDto(
      withExtra,
      {
        queue: "mail",
        include: new Set(["data", "returnValue", "stacktrace", "opts"]),
        req,
      },
      defaults,
    );
    const text = JSON.stringify(dto);
    expect(text).not.toContain("lockToken");
    expect(text).not.toContain("token-that-must-never-leave");
    expect(text).not.toContain("internalSecret");
    expect(dto.queue).toBe("mail");
  });

  it("includes optional fields only when asked, and strips stacks by default", () => {
    const listed = toJobDto(
      record,
      { queue: "mail", include: JOB_LIST_INCLUDE, req },
      defaults,
    );
    expect(listed).not.toHaveProperty("data");
    expect(listed).not.toHaveProperty("opts");
    expect(listed).not.toHaveProperty("stacktrace");
    expect(listed.failedReason).toEqual({
      name: "Error",
      message: "boom",
      code: "E_BOOM",
      cause: { name: "TypeError", message: "inner" },
    });
    expect(listed.flow!.failures["q:c"]).not.toHaveProperty("stack");

    const read = toJobDto(
      record,
      { queue: "mail", include: JOB_READ_INCLUDE, req },
      defaults,
    );
    expect(read.data).toEqual({ email: "a@example.com" });
    expect(read).toHaveProperty("returnValue");
    // The stored options pass through as they are, the mask aside: a number
    // only the drivers read, which never leaves the process as one.
    const { explicit: _mask, ...stored } = record.opts;
    expect(read.opts).toEqual(stored);
    expect(read).not.toHaveProperty("stacktrace");

    const withStacks = toErrorDto(failure, { exposeStacks: true });
    expect(withStacks.stack).toContain("secret/path.ts");
    expect(withStacks.cause!.stack).toContain("TypeError");
  });

  it("applies serialize.job with the default DTO, the record and the request", () => {
    const dto = toJobDto(
      record,
      { queue: "mail", include: JOB_READ_INCLUDE, req },
      {
        ...defaults,
        job: (shaped, raw, request) => {
          expect(raw).toBe(record);
          expect(request).toBe(req);
          return { ...shaped, data: { email: "***" } };
        },
      },
    );
    expect(dto.data).toEqual({ email: "***" });
  });

  const run: RunRecord = {
    runId: "run-1",
    runnerId: "cleanup",
    attempt: 1,
    source: "manual",
    mode: "spawn",
    host: "db-host-7",
    pid: 4242,
    startedAt: 1,
    status: "failed",
    error: failure,
  };

  it("shapes runner info: no file, epoch times, hosts only when exposed", () => {
    const info: RemoteRunnerInfo = {
      id: "cleanup",
      namespace: "api-sources",
      isLocal: true,
      name: "Cleanup",
      file: "/srv/app/secret/cleanup.ts",
      schedule: { every: 1000 },
      nextRunAt: new Date(5_000),
      executionMode: "spawn",
      runMode: "single",
      queueRuns: false,
      maxQueuedRuns: 100,
      maxConcurrency: 1,
      isPaused: false,
      isRunning: true,
      runningOn: { host: "db-host-7", pid: 4242, runId: "run-1", since: 1 },
      queuedTriggers: 0,
      stats: {
        success: 1,
        failed: 1,
        timeout: 0,
        killed: 0,
        skipped: 0,
        queued: 0,
        total: 2,
      },
      lastRun: run,
      lastError: { name: "Error", message: "boom" },
      updatedAt: 9,
      local: {
        status: "running",
        activeRuns: [run],
        nextRunAt: new Date(6_000),
      },
    };

    const dto = toRunnerInfoDto(info, req, defaults);
    expect(dto).not.toHaveProperty("file");
    expect(dto.nextRunAt).toBe(5_000);
    expect(dto.local!.nextRunAt).toBe(6_000);
    expect(dto.maxQueuedRuns).toBe(100);
    expect(dto.updatedAt).toBe(9);
    expect(dto.runningOn).toEqual({
      runId: "run-1",
      since: 1,
      host: "db-host-7",
      pid: 4242,
    });
    expect(dto.local!.activeRuns[0]!.error).not.toHaveProperty("stack");

    const hidden = toRunnerInfoDto(info, req, {
      ...defaults,
      exposeHosts: false,
      exposeRunnerFiles: true,
    });
    expect(hidden.file).toBe("/srv/app/secret/cleanup.ts");
    expect(JSON.stringify(hidden)).not.toContain("db-host-7");
    expect(JSON.stringify(hidden)).not.toContain("4242");
    expect(hidden.runningOn).toEqual({ runId: "run-1", since: 1 });

    // A runner only another process registered: the backend view alone.
    const { local: _local, file: _file, ...remoteOnly } = info;
    const remote = toRunnerInfoDto(
      { ...remoteOnly, isLocal: false, executionMode: undefined },
      req,
      { ...defaults, exposeRunnerFiles: true },
    );
    expect(remote).not.toHaveProperty("local");
    expect(remote).not.toHaveProperty("file");
    expect(remote).not.toHaveProperty("executionMode");
    expect(remote.isLocal).toBe(false);

    const renamed = toRunnerInfoDto(info, req, {
      ...defaults,
      runner: (shaped) => ({ ...shaped, name: "x" }),
    });
    expect(renamed.name).toBe("x");
    const runHook = toRunRecordDto(run, req, {
      ...defaults,
      run: (shaped) => ({ ...shaped, attempt: 9 }),
    });
    expect(runHook.attempt).toBe(9);
  });

  it("shapes events without ns, origin or stacks, and lets the hook drop one", () => {
    const event: DriverEvent = {
      v: 1,
      ns: "api-sources",
      origin: "db-host-7:4242:abc",
      kind: "queue",
      type: "failed",
      target: "mail",
      id: "1",
      at: 7,
      payload: { id: "1", error: failure },
    };
    const dto = toEventDto(event, req, defaults)!;
    expect(dto).toEqual({
      v: 1,
      kind: "queue",
      type: "failed",
      target: "mail",
      id: "1",
      at: 7,
      payload: {
        id: "1",
        error: {
          name: "Error",
          message: "boom",
          code: "E_BOOM",
          cause: { name: "TypeError", message: "inner" },
        },
      },
    });
    expect(JSON.stringify(dto)).not.toContain("db-host-7");
    expect(
      toEventDto(event, req, { ...defaults, event: () => null }),
    ).toBeNull();
  });

  it("shapes repeatables and workers", () => {
    const repeat: RepeatRecord = {
      key: "k",
      name: "digest",
      data: { secret: true },
      opts: record.opts,
      cron: "0 * * * *",
      count: 2,
      nextRunAt: 100,
      nextJobId: "j",
      createdAt: 1,
      updatedAt: 2,
    };
    const listed = toRepeatableDto(
      repeat,
      { queue: "mail", include: new Set(), req },
      defaults,
    );
    expect(listed).not.toHaveProperty("data");
    expect(listed).not.toHaveProperty("every");
    expect(listed.cron).toBe("0 * * * *");
    expect(
      toRepeatableDto(
        repeat,
        { queue: "mail", include: new Set(["data"]), req },
        defaults,
      ).data,
    ).toEqual({
      secret: true,
    });

    const worker = {
      id: "w",
      queue: "mail",
      host: "db-host-7",
      pid: 1,
      concurrency: 2,
      active: 1,
      paused: false,
      startedAt: 1,
      heartbeatAt: 2,
      expiresAt: 3,
    };
    expect(toWorkerDto(worker, { exposeHosts: true })).toEqual(worker);
    expect(toWorkerDto(worker, { exposeHosts: false })).not.toHaveProperty(
      "host",
    );
  });
});
