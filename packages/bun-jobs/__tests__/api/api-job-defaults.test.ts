import type {
  ApplyJobDefaultsResultDto,
  JobDefaultsDto,
  MetaDto,
} from "../../lib/api/contract/types";
import type {
  JobsDriver,
  PendingOptionsRewrite,
  PendingOptionsRewriteResult,
  QueueRef,
} from "../../lib/index";
import type { HarnessResponse } from "./fixtures";
/**
 * Queue job defaults through the management API: the read, the save and the
 * reset (`queues.defaults`), and the rewrite of pending jobs
 * (`queues.applyDefaults`), on every backend; then, on memory, every refusal
 * — each a 4xx with a detail, never a 5xx — the pruning where a backend lacks
 * support, the two opt-in actions, and `explicit` on a job's options.
 */
import { join } from "node:path";
import process from "node:process";
import { createDeferred } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  FileDriver,
  MemoryDriver,
  MongoDriver,
  RedisDriver,
  SqlDriver,
} from "../../lib/index";
import { makeTmpDir, testNamespace } from "../helpers";
import { harness, openContexts, openHarnesses } from "./fixtures";

/** Undo steps, run as each case ends — exact names only. */
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
  await Promise.all(openContexts.splice(0).map((jobs) => jobs.close()));
});

/** A backend to run the cases on: how to build its driver, or why it is skipped. */
interface Backend {
  /** Shown in the test titles. */
  name: string;
  /** Builds a driver over the case's own storage; `undefined` when unavailable. */
  make: (() => Promise<JobsDriver>) | undefined;
}

/** Closes a driver after the case. */
function closing<T extends JobsDriver>(driver: T): T {
  cleanups.push(async () => await driver.close());
  return driver;
}

/** A server-backed backend, skipped when its variable is unset. */
function server(
  name: string,
  variable: string,
  build: (url: string) => JobsDriver,
): Backend {
  const url = process.env[variable];
  return { name, make: url ? async () => closing(build(url)) : undefined };
}

/** The shared SQL test tables: each case writes only its own namespace. */
function sqlServer(
  adapter: "postgres" | "mysql" | "mariadb",
  variable: string,
): Backend {
  return server(
    adapter,
    variable,
    (url) =>
      new SqlDriver({
        url,
        adapter,
        tablePrefix: "bun_jobs_test_",
        pollInterval: 10,
      }),
  );
}

const BACKENDS: Backend[] = [
  { name: "memory", make: async () => closing(new MemoryDriver()) },
  {
    name: "file",
    make: async () => {
      const tmp = await makeTmpDir("bun-jobs-api-jdef-file");
      cleanups.push(tmp.cleanup);
      return closing(new FileDriver({ root: tmp.path, pollInterval: 10 }));
    },
  },
  {
    name: "sqlite",
    make: async () => {
      const tmp = await makeTmpDir("bun-jobs-api-jdef-sqlite");
      cleanups.push(tmp.cleanup);
      return closing(
        new SqlDriver({ url: `sqlite://${join(tmp.path, "jobs.db")}` }),
      );
    },
  },
  sqlServer("postgres", "BUN_JOBS_TEST_POSTGRES_URL"),
  sqlServer("mysql", "BUN_JOBS_TEST_MYSQL_URL"),
  sqlServer("mariadb", "BUN_JOBS_TEST_MARIADB_URL"),
  server(
    "mongodb",
    "BUN_JOBS_TEST_MONGODB_URL",
    (url) => new MongoDriver({ url, pollInterval: 10 }),
  ),
  server("redis", "BUN_JOBS_TEST_REDIS_URL", (url) => new RedisDriver({ url })),
];

/** A context over `driver` in a namespace of the case's own, purged after. */
function context(driver: JobsDriver, label: string): BunJobs {
  const namespace = testNamespace(label);
  const jobs = new BunJobs({ namespace, driver });
  cleanups.push(async () => {
    await jobs.close();
    await driver.purge(namespace);
  });
  return jobs;
}

/** A driver with some optional methods hidden, as an older or custom one would be. */
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
  });
}

/**
 * A harness over the memory driver (or the options given) whose queues
 * `mail` and `other` exist — a queue the backend does not know is 404
 * `QUEUE_NOT_FOUND` on these routes, as on its limits.
 */
async function seeded(overrides: Parameters<typeof harness>[0] = {}) {
  const h = harness(overrides);
  await h.jobs.queue("mail").add("seed", {}, { attempts: 1, timeout: 0 });
  await h.jobs.queue("other").add("seed", {});
  return h;
}

/** The body of a 2xx answer, failing the case on anything else. */
function ok<T>(response: HarnessResponse): T {
  expect({ status: response.status, body: response.body }).toMatchObject({
    status: 200,
  });
  return response.body as T;
}

/** Asserts a refusal: its status, its code, a detail, and never a 5xx. */
function refused(
  response: HarnessResponse,
  status: number,
  code: string,
): HarnessResponse["body"] {
  expect({ status: response.status, code: response.body?.code }).toEqual({
    status,
    code,
  });
  expect(typeof response.body.detail).toBe("string");
  expect(response.body.detail.length).toBeGreaterThan(0);
  return response.body;
}

/** Walks an apply to its end, one call per `limit`, summing what each did. */
async function applyAll(
  h: ReturnType<typeof harness>,
  queue: string,
  body: Record<string, unknown>,
): Promise<{
  calls: ApplyJobDefaultsResultDto[];
  total: Record<string, number>;
}> {
  const calls: ApplyJobDefaultsResultDto[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const answer = ok<ApplyJobDefaultsResultDto>(
      await h.call("POST", `/queues/${queue}/job-defaults/apply`, {
        ...body,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    calls.push(answer);
    expect(answer.done).toBe(answer.next === null);
    if (answer.done) {
      break;
    }
    cursor = answer.next!;
  }
  const total: Record<string, number> = {};
  for (const key of [
    "examined",
    "rewritten",
    "unchanged",
    "skippedExplicit",
    "skippedUnmarked",
    "moved",
    "exhausted",
  ] as const) {
    total[key] = calls.reduce((sum, call) => sum + call[key], 0);
  }
  return { calls, total };
}

describe.each(BACKENDS)(
  "queue job defaults through the API: $name",
  (backend) => {
    const it_ = backend.make ? it : it.skip;

    it_(
      "reads, saves, applies (dry run, then paged by cursor) and resets",
      async () => {
        const jobs = context(await backend.make!(), `jdef-${backend.name}`);
        const h = harness({ jobs });
        const queue = jobs.queue("mail");

        // Four jobs, added before any override: two defaulted, one with an
        // explicit `attempts`, one with both keys the override will set explicit.
        // (A queue the backend does not know yet is 404, as for its limits.)
        const plain = await queue.add("send", {});
        const later = await queue.add("send", {}, { delay: 3_600_000 });
        const partly = await queue.add("send", {}, { attempts: 9 });
        const fully = await queue.add("send", {}, { attempts: 9, timeout: 50 });

        // Nothing stored yet: seq 0, and the code's values are the effective ones.
        const initial = ok<JobDefaultsDto>(
          await h.call("GET", "/queues/mail/job-defaults"),
        );
        expect(initial).toMatchObject({
          queue: "mail",
          codeSource: "api",
          overridden: [],
          override: {},
          seq: 0,
          propagationMs: 1000,
          pending: {
            waiting: 3,
            delayed: 1,
            failed: 0,
            "waiting-children": 0,
            total: 4,
          },
        });
        expect(initial).not.toHaveProperty("updatedAt");
        expect(initial.effective).toEqual(initial.code);
        expect(initial.code.attempts).toBe(1);

        const saved = ok<JobDefaultsDto>(
          await h.call("PUT", "/queues/mail/job-defaults", {
            attempts: 5,
            timeout: 2_000,
            expectedSeq: 0,
          }),
        );
        expect(saved.seq).toBeGreaterThan(0);
        expect(saved.overridden).toEqual(["attempts", "timeout"]);
        expect(saved.override).toEqual({ attempts: 5, timeout: 2_000 });
        expect(saved.effective).toMatchObject({ attempts: 5, timeout: 2_000 });
        expect(saved.code).toEqual(initial.code);
        expect(typeof saved.updatedAt).toBe("number");
        expect(saved.pending).toEqual({
          waiting: 3,
          delayed: 1,
          failed: 0,
          "waiting-children": 0,
          total: 4,
        });

        // Each job's options say which keys its own add() passed — key names,
        // never the stored number.
        const optsOf = async (id: string) =>
          ok<{ opts: Record<string, unknown> }>(
            await h.call("GET", `/queues/mail/jobs/${encodeURIComponent(id)}`),
          ).opts;
        expect((await optsOf(plain.id)).explicit).toEqual([]);
        expect((await optsOf(partly.id)).explicit).toEqual(["attempts"]);
        expect((await optsOf(fully.id)).explicit).toEqual([
          "attempts",
          "timeout",
        ]);

        // A dry run counts exactly and writes nothing.
        const dry = ok<ApplyJobDefaultsResultDto>(
          await h.call("POST", "/queues/mail/job-defaults/apply", {
            seq: saved.seq,
            dryRun: true,
          }),
        );
        expect(dry).toMatchObject({
          seq: saved.seq,
          keys: ["attempts", "timeout"],
          dryRun: true,
          examined: 4,
          rewritten: 3,
          unchanged: 0,
          skippedExplicit: 1,
          skippedUnmarked: 0,
          moved: 0,
          exhausted: 0,
          next: null,
          done: true,
        });
        expect((await queue.getJob(plain.id))!.opts.attempts).toBe(1);

        // The real walk, two jobs a call, resumed from each call's cursor.
        const { calls, total } = await applyAll(h, "mail", {
          seq: saved.seq,
          limit: 2,
        });
        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(calls[0]!.examined).toBe(2);
        expect(calls[0]!.done).toBe(false);
        expect(typeof calls[0]!.next).toBe("string");
        expect(total).toMatchObject({
          examined: 4,
          rewritten: 3,
          skippedExplicit: 1,
          exhausted: 0,
        });

        const after = async (id: string) => (await queue.getJob(id))!;
        expect((await after(plain.id)).opts).toMatchObject({
          attempts: 5,
          timeout: 2_000,
        });
        expect((await after(plain.id)).maxAttempts).toBe(5);
        expect((await after(later.id)).opts).toMatchObject({
          attempts: 5,
          timeout: 2_000,
        });
        // An explicit key is kept, the defaulted one beside it rewritten.
        expect((await after(partly.id)).opts).toMatchObject({
          attempts: 9,
          timeout: 2_000,
        });
        expect((await after(fully.id)).opts).toMatchObject({
          attempts: 9,
          timeout: 50,
        });

        // A job added now takes the override, and an explicit option still wins.
        expect((await queue.add("send", {})).opts.attempts).toBe(5);
        expect(
          (await queue.add("send", {}, { attempts: 2 })).opts.attempts,
        ).toBe(2);

        // A reset clears the override for new jobs; rewritten jobs keep theirs.
        const reset = ok<JobDefaultsDto>(
          await h.call(
            "DELETE",
            `/queues/mail/job-defaults?expectedSeq=${saved.seq}`,
          ),
        );
        expect(reset.seq).toBeGreaterThan(saved.seq);
        expect(reset.overridden).toEqual([]);
        expect(reset.override).toEqual({});
        expect(reset.effective).toEqual(reset.code);
        expect((await after(plain.id)).opts.attempts).toBe(5);
        expect((await queue.add("send", {})).opts.attempts).toBe(1);
      },
    );
  },
);

describe("queue job defaults: refusals are 4xx with a detail", () => {
  it("refuses values outside the bounds, with the issue on the field", async () => {
    const h = await seeded();
    const cases: [Record<string, unknown>, string][] = [
      [{ attempts: 0 }, "attempts"],
      [{ attempts: 1001 }, "attempts"],
      [{ timeout: 86_400_001 }, "timeout"],
      [{ keepLogs: 0 }, "keepLogs"],
      [{ keepStacktraces: 101 }, "keepStacktraces"],
      [{ priority: 1_048_577 }, "priority"],
      [{ backoff: { type: "linear", delay: 10 } }, "backoff"],
      [{ backoff: 86_400_001 }, "backoff"],
      [{ removeOnComplete: { ttl: 31_536_000_001 } }, "removeOnComplete"],
      [{ attempts: 2.5 }, "attempts"],
      [{ deadLetter: "elsewhere" }, ""],
    ];
    for (const [body, path] of cases) {
      const res = await h.call("PUT", "/queues/mail/job-defaults", body);
      const problem = refused(res, 400, "VALIDATION");
      expect({
        body,
        paths: problem.issues.map((i: { path: string }) => i.path),
      }).toMatchObject({ body });
      if (path) {
        expect(
          problem.issues.some((issue: { path: string }) =>
            issue.path.startsWith(path),
          ),
        ).toBe(true);
      }
    }
    // Nothing was stored by any of them.
    expect(
      ok<JobDefaultsDto>(await h.call("GET", "/queues/mail/job-defaults")).seq,
    ).toBe(0);
  });

  it("refuses what a shape cannot hold: backoff.max under delay, an empty retention", async () => {
    const h = await seeded();
    const low = refused(
      await h.call("PUT", "/queues/mail/job-defaults", {
        backoff: { type: "exponential", delay: 1_000, max: 500 },
      }),
      400,
      "VALIDATION",
    );
    expect(low.issues).toEqual([
      {
        target: "body",
        path: "backoff.max",
        message: "backoff.max must be at least backoff.delay",
      },
    ]);
    const empty = refused(
      await h.call("PUT", "/queues/mail/job-defaults", { removeOnFail: {} }),
      400,
      "VALIDATION",
    );
    expect(empty.issues[0]).toMatchObject({ path: "removeOnFail" });
  });

  it("merges a patch, and null clears one key so the code's value applies again", async () => {
    const h = await seeded();
    const first = ok<JobDefaultsDto>(
      await h.call("PUT", "/queues/mail/job-defaults", {
        attempts: 3,
        backoff: { type: "fixed", delay: 250 },
        removeOnComplete: { count: 10 },
      }),
    );
    expect(first.overridden).toEqual([
      "attempts",
      "backoff",
      "removeOnComplete",
    ]);
    const second = ok<JobDefaultsDto>(
      await h.call("PUT", "/queues/mail/job-defaults", {
        attempts: null,
        keepLogs: 50,
      }),
    );
    expect(second.overridden).toEqual([
      "backoff",
      "removeOnComplete",
      "keepLogs",
    ]);
    expect(second.effective.attempts).toBe(second.code.attempts);
    expect(second.effective.backoff).toEqual({ type: "fixed", delay: 250 });
  });

  it("answers a stale expectedSeq with 409 CONTROL_CONTENDED, changing nothing", async () => {
    const h = await seeded();
    const saved = ok<JobDefaultsDto>(
      await h.call("PUT", "/queues/mail/job-defaults", { attempts: 3 }),
    );
    const stale = refused(
      await h.call("PUT", "/queues/mail/job-defaults", {
        attempts: 4,
        expectedSeq: saved.seq - 1,
      }),
      409,
      "CONTROL_CONTENDED",
    );
    expect(stale.context).toEqual({ queue: "mail", seq: saved.seq });
    refused(
      await h.call(
        "DELETE",
        `/queues/mail/job-defaults?expectedSeq=${saved.seq + 5}`,
      ),
      409,
      "CONTROL_CONTENDED",
    );
    const now = ok<JobDefaultsDto>(
      await h.call("GET", "/queues/mail/job-defaults"),
    );
    expect(now).toMatchObject({ seq: saved.seq, override: { attempts: 3 } });
  });

  it("refuses an apply of a version no longer stored with 409 DEFAULTS_CHANGED", async () => {
    const h = await seeded();
    await h.jobs.queue("mail").add("send", {});
    const saved = ok<JobDefaultsDto>(
      await h.call("PUT", "/queues/mail/job-defaults", { attempts: 3 }),
    );
    const moved = ok<JobDefaultsDto>(
      await h.call("PUT", "/queues/mail/job-defaults", { attempts: 4 }),
    );
    const problem = refused(
      await h.call("POST", "/queues/mail/job-defaults/apply", {
        seq: saved.seq,
      }),
      409,
      "DEFAULTS_CHANGED",
    );
    expect(problem.title).toBe(
      "Job defaults changed since they were confirmed",
    );
    expect(problem.context).toEqual({
      queue: "mail",
      expectedSeq: saved.seq,
      seq: moved.seq,
    });
    // Nothing was written.
    const [job] = await h.jobs.queue("mail").list("waiting");
    expect(job!.opts.attempts).toBe(1);
  });

  it("answers every bad apply request with 400 INVALID_ARGUMENT or VALIDATION", async () => {
    const h = await seeded();
    const path = "/queues/mail/job-defaults/apply";

    // Nothing overridden: nothing to apply.
    const nothing = refused(
      await h.call("POST", path, { seq: 0 }),
      400,
      "INVALID_ARGUMENT",
    );
    expect(nothing.detail).toContain("override nothing");

    const { seq } = ok<JobDefaultsDto>(
      await h.call("PUT", "/queues/mail/job-defaults", { attempts: 3 }),
    );
    expect(
      refused(
        await h.call("POST", path, { seq, keys: ["timeout"] }),
        400,
        "INVALID_ARGUMENT",
      ).detail,
    ).toContain('do not override "timeout"');
    expect(
      refused(
        await h.call("POST", path, { seq, cursor: "junk" }),
        400,
        "INVALID_ARGUMENT",
      ).detail,
    ).toBe("cursor is not one this walk issued");
    refused(
      await h.call("POST", path, { seq, states: ["waiting", "waiting"] }),
      400,
      "INVALID_ARGUMENT",
    );
    refused(
      await h.call("POST", path, { seq, states: ["active"] }),
      400,
      "VALIDATION",
    );
    refused(
      await h.call("POST", path, { seq, limit: 1001 }),
      400,
      "VALIDATION",
    );
    refused(await h.call("POST", path, { seq, limit: 0 }), 400, "VALIDATION");
    refused(await h.call("POST", path, {}), 400, "VALIDATION");
    refused(
      await h.call("POST", path, { seq, keys: ["deadLetter"] }),
      400,
      "VALIDATION",
    );
  });

  it("runs one apply per queue at a time in this process: another is 409 OPERATION_IN_PROGRESS", async () => {
    const gate = createDeferred();
    const entered = createDeferred();
    const memory = new MemoryDriver();
    const driver = new Proxy(memory, {
      get(target, key, receiver) {
        if (key === "rewritePendingOptions") {
          return async (q: QueueRef, request: PendingOptionsRewrite) => {
            entered.resolve();
            await gate.promise;
            return (await target.rewritePendingOptions(
              q,
              request,
            )) as PendingOptionsRewriteResult;
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const jobs = new BunJobs({ namespace: testNamespace("jdef-busy"), driver });
    openContexts.push(jobs);
    const h = await seeded({ jobs });
    const { seq } = ok<JobDefaultsDto>(
      await h.call("PUT", "/queues/mail/job-defaults", { attempts: 3 }),
    );
    const first = h.call("POST", "/queues/mail/job-defaults/apply", { seq });
    await entered.promise;
    refused(
      await h.call("POST", "/queues/mail/job-defaults/apply", { seq }),
      409,
      "OPERATION_IN_PROGRESS",
    );
    // Another queue is not held up.
    ok(await h.call("PUT", "/queues/other/job-defaults", { attempts: 2 }));
    gate.resolve();
    expect((await first).status).toBe(200);
  });
});

describe("queue job defaults: explicit keys, unmarked and exhausted jobs", () => {
  it("skips a job with no explicit record unless includeUnmarked, and serialises it without `explicit`", async () => {
    const driver = new MemoryDriver();
    const jobs = context(driver, "jdef-unmarked");
    const h = harness({ jobs });
    const queue = jobs.queue("mail");
    const job = await queue.add("old", {});
    const stored = (await driver.getJob(queue.ref, job.id))!;
    const { explicit: _mask, ...unmarked } = stored.opts;
    await driver.removeJob(queue.ref, job.id);
    await driver.addJob(queue.ref, { ...stored, opts: unmarked });

    const read = ok<{ opts: Record<string, unknown> }>(
      await h.call("GET", `/queues/mail/jobs/${job.id}`),
    );
    expect(read.opts).not.toHaveProperty("explicit");

    const { seq } = ok<JobDefaultsDto>(
      await h.call("PUT", "/queues/mail/job-defaults", { attempts: 4 }),
    );
    expect(
      ok<ApplyJobDefaultsResultDto>(
        await h.call("POST", "/queues/mail/job-defaults/apply", { seq }),
      ),
    ).toMatchObject({ examined: 1, skippedUnmarked: 1, rewritten: 0 });
    expect(
      ok<ApplyJobDefaultsResultDto>(
        await h.call("POST", "/queues/mail/job-defaults/apply", {
          seq,
          includeUnmarked: true,
        }),
      ),
    ).toMatchObject({ examined: 1, skippedUnmarked: 0, rewritten: 1 });
    expect((await queue.getJob(job.id))!.maxAttempts).toBe(4);
  });

  it("writes an attempts below attemptsMade and counts the job exhausted", async () => {
    const driver = new MemoryDriver();
    const jobs = context(driver, "jdef-exhausted");
    const h = harness({ jobs });
    const queue = jobs.queue("mail");
    const job = await queue.add("send", {}, { timeout: 10 });
    const stored = (await driver.getJob(queue.ref, job.id))!;
    await driver.removeJob(queue.ref, job.id);
    await driver.addJob(queue.ref, { ...stored, attemptsMade: 3 });

    const { seq } = ok<JobDefaultsDto>(
      await h.call("PUT", "/queues/mail/job-defaults", { attempts: 2 }),
    );
    const result = ok<ApplyJobDefaultsResultDto>(
      await h.call("POST", "/queues/mail/job-defaults/apply", { seq }),
    );
    expect(result).toMatchObject({ rewritten: 1, exhausted: 1 });
    expect((await queue.getJob(job.id))!.maxAttempts).toBe(2);
    // Its explicit `timeout` is listed, and was never a key the apply wrote.
    const read = ok<{ opts: Record<string, unknown> }>(
      await h.call("GET", `/queues/mail/jobs/${job.id}`),
    );
    expect(read.opts).toMatchObject({ explicit: ["timeout"], timeout: 10 });
  });

  it("applies only the keys named, and only to the states named", async () => {
    const h = await seeded();
    const queue = h.jobs.queue("mail");
    const waiting = await queue.add("send", {});
    const delayed = await queue.add("send", {}, { delay: 3_600_000 });
    const { seq } = ok<JobDefaultsDto>(
      await h.call("PUT", "/queues/mail/job-defaults", {
        attempts: 6,
        keepStacktraces: 3,
      }),
    );
    const result = ok<ApplyJobDefaultsResultDto>(
      await h.call("POST", "/queues/mail/job-defaults/apply", {
        seq,
        keys: ["keepStacktraces"],
        states: ["delayed"],
      }),
    );
    expect(result).toMatchObject({
      keys: ["keepStacktraces"],
      examined: 1,
      rewritten: 1,
    });
    expect((await queue.getJob(delayed.id))!.opts).toMatchObject({
      attempts: 1,
      keepStacktraces: 3,
    });
    expect((await queue.getJob(waiting.id))!.opts.keepStacktraces).not.toBe(3);
  });

  it("serialises a repeat series' options with key names too", async () => {
    const h = await seeded();
    await h.jobs.queue("mail").add(
      "tick",
      {},
      {
        repeat: { every: 60_000 },
        attempts: 3,
      },
    );
    const list = ok<{ items: { opts: Record<string, unknown> }[] }>(
      await h.call("GET", "/queues/mail/repeatables"),
    );
    expect(list.items[0]!.opts.explicit).toEqual(["attempts"]);
  });
});

describe("queue job defaults: pruning and permissions", () => {
  /** `/meta.features` of a harness. */
  const features = async (h: ReturnType<typeof harness>) =>
    ok<MetaDto>(await h.call("GET", "/meta")).features;

  it("prunes every route, and reads both flags false, on a backend without queue state", async () => {
    const h = harness({
      jobs: context(
        without(new MemoryDriver(), ["getQueueState", "setQueueState"]),
        "jdef-nostate",
      ),
    });
    expect(await features(h)).toMatchObject({
      jobDefaults: false,
      jobDefaultsApply: false,
    });
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", { attempts: 2 }],
      ["DELETE", undefined],
    ] as const) {
      refused(
        await h.call(method, "/queues/mail/job-defaults", body),
        404,
        "ROUTE_NOT_FOUND",
      );
    }
    refused(
      await h.call("POST", "/queues/mail/job-defaults/apply", { seq: 0 }),
      404,
      "ROUTE_NOT_FOUND",
    );
    const permissions = ok<{ actions: Record<string, boolean> }>(
      await h.call("GET", "/meta/permissions"),
    );
    expect(permissions.actions).not.toHaveProperty("queues.defaults");
    expect(permissions.actions).not.toHaveProperty("queues.applyDefaults");
  });

  it("keeps saving but prunes apply on a backend without rewritePendingOptions", async () => {
    const h = await seeded({
      jobs: context(
        without(new MemoryDriver(), ["rewritePendingOptions"]),
        "jdef-norewrite",
      ),
    });
    expect(await features(h)).toMatchObject({
      jobDefaults: true,
      jobDefaultsApply: false,
    });
    ok(await h.call("PUT", "/queues/mail/job-defaults", { attempts: 2 }));
    refused(
      await h.call("POST", "/queues/mail/job-defaults/apply", { seq: 1 }),
      404,
      "ROUTE_NOT_FOUND",
    );
    const permissions = ok<{ actions: Record<string, boolean> }>(
      await h.call("GET", "/meta/permissions"),
    );
    expect(permissions.actions["queues.defaults"]).toBe(true);
    expect(permissions.actions).not.toHaveProperty("queues.applyDefaults");
  });

  it("reads both flags true on the memory driver, whatever the permissions", async () => {
    const h = harness({ actions: undefined });
    expect(await features(h)).toMatchObject({
      jobDefaults: true,
      jobDefaultsApply: true,
    });
  });

  it("leaves both actions off by default, listing them only when the allow-list names them", async () => {
    const byDefault = await seeded({ actions: undefined });
    const listed = ok<{ actions: Record<string, boolean> }>(
      await byDefault.call("GET", "/meta/permissions"),
    ).actions;
    expect(listed).not.toHaveProperty("queues.defaults");
    expect(listed).not.toHaveProperty("queues.applyDefaults");
    expect(listed["queues.read"]).toBe(true);
    // The read is served; the writes are not routed at all.
    ok(await byDefault.call("GET", "/queues/mail/job-defaults"));
    refused(
      await byDefault.call("PUT", "/queues/mail/job-defaults", { attempts: 2 }),
      404,
      "ROUTE_NOT_FOUND",
    );
    refused(
      await byDefault.call("POST", "/queues/mail/job-defaults/apply", {
        seq: 0,
      }),
      404,
      "ROUTE_NOT_FOUND",
    );

    const enabled = harness({
      actions: ["meta.read", "queues.read", "queues.defaults"],
    });
    const some = ok<{ actions: Record<string, boolean> }>(
      await enabled.call("GET", "/meta/permissions"),
    ).actions;
    expect(some["queues.defaults"]).toBe(true);
    expect(some).not.toHaveProperty("queues.applyDefaults");

    const all = harness();
    const every = ok<{ actions: Record<string, boolean> }>(
      await all.call("GET", "/meta/permissions"),
    ).actions;
    expect(every["queues.defaults"]).toBe(true);
    expect(every["queues.applyDefaults"]).toBe(true);

    const readOnly = harness({ readOnly: true });
    const none = ok<{ actions: Record<string, boolean> }>(
      await readOnly.call("GET", "/meta/permissions"),
    ).actions;
    expect(none).not.toHaveProperty("queues.defaults");
    expect(none).not.toHaveProperty("queues.applyDefaults");
  });

  it("asks authorize with the queue as the target", async () => {
    const h = await seeded();
    await h.call("PUT", "/queues/mail/job-defaults", { attempts: 2 });
    expect(h.calls.at(-1)).toMatchObject({
      action: "queues.defaults",
      mutation: true,
      queue: "mail",
      route: { method: "PUT", path: "/queues/:queue/job-defaults" },
    });
  });

  it("documents the four routes and the new error in the OpenAPI document", async () => {
    const h = await seeded();
    const doc = ok<{
      paths: Record<
        string,
        Record<
          string,
          { description?: string; responses: Record<string, unknown> }
        >
      >;
    }>(await h.call("GET", "/openapi.json"));
    const item = doc.paths["/queues/{queue}/job-defaults"]!;
    expect(Object.keys(item).sort()).toEqual(
      expect.arrayContaining(["delete", "get", "put"]),
    );
    const apply = doc.paths["/queues/{queue}/job-defaults/apply"]!.post!;
    expect(apply.responses).toHaveProperty("409");
    expect(apply.description).toContain("irreversible");
    expect(JSON.stringify(apply.responses["409"])).toContain(
      "DEFAULTS_CHANGED",
    );
  });
});
