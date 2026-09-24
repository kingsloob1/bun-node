import type { BunJobs, JobsDriver } from "../../lib/index";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { resolveConfig } from "../../lib/api/config";
import { createJobsApi } from "../../lib/api/createJobsApi";
import {
  FEATURE_ROUTES,
  probeFeatures,
  servedFeatures,
  supportsJobAttribution,
} from "../../lib/api/routes/meta";
import {
  BunQueueWorker,
  FileDriver,
  MemoryDriver,
  MongoDriver,
  NotSupportedError,
  RedisDriver,
  SqlDriver,
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
 * The 2.13 read routes: job filters and totals, batched lookups, workers and
 * throughput. `validateResponses` is on in the harness, so every response here
 * is also checked against its declared schema.
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

/** The driver methods worker records need natively. */
const NATIVE_WORKERS = ["registerWorker", "removeWorker", "listWorkers"];

/** The queue-state methods worker records fall back to. */
const STATE_WORKERS = ["getQueueState", "setQueueState", "listQueueState"];

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

/** A driver with some optional methods added, as a newer one would have them. */
function withMethods(
  driver: JobsDriver,
  methods: readonly string[],
): JobsDriver {
  const added = new Set(methods);
  return new Proxy(driver, {
    get(target, key, receiver) {
      // Never called: only `typeof … === "function"` is asked of them.
      if (typeof key === "string" && added.has(key)) {
        return () => undefined;
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, key) {
      return (
        (typeof key === "string" && added.has(key)) || Reflect.has(target, key)
      );
    },
  }) as JobsDriver;
}

/** A driver declaring extra capabilities, as a newer one would. */
function withCapabilities(
  driver: JobsDriver,
  extra: Record<string, unknown>,
): JobsDriver {
  const capabilities = { ...driver.capabilities, ...extra };
  return new Proxy(driver, {
    get(target, key, receiver) {
      if (key === "capabilities") {
        return capabilities;
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as JobsDriver;
}

/** Starts a worker on a queue, closed after the test. */
function startWorker(jobs: BunJobs, queue: string): void {
  const worker = new BunQueueWorker(queue, async () => "ok", {
    namespace: jobs.namespace,
    driver: jobs.driver,
    pollInterval: 10,
  });
  closers.push(async () => await worker.close({ timeout: 1_000 }));
  void worker.run();
}

/** Waits until the queue reports at least one live worker. */
async function workerReported(jobs: BunJobs, queue: string): Promise<void> {
  await waitFor(
    async () => (await jobs.queue(queue).listWorkers()).length > 0,
    { message: `no worker reported on ${queue}` },
  );
}

describe("listing jobs by name, search and a total", () => {
  it("narrows by name, by search, and counts every match when asked", async () => {
    const h = harness();
    const queue = h.jobs.queue("mail");
    for (let index = 0; index < 6; index++) {
      await queue.add(
        index % 2 === 0 ? "sendEmail" : "resize",
        { index },
        { jobId: `job-0${index}` },
      );
    }

    const byName = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&name=sendEmail",
    );
    expect(byName.status).toBe(200);
    expect(byName.body.items.map((job: any) => job.id)).toEqual([
      "job-00",
      "job-02",
      "job-04",
    ]);
    // A total costs a full count, so it is absent unless asked for.
    expect(byName.body.page.total).toBeUndefined();

    // Search matches the id or the name, ignoring case.
    const bySearch = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&search=JOB-03",
    );
    expect(bySearch.body.items.map((job: any) => job.id)).toEqual(["job-03"]);

    const counted = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&name=sendEmail&total=true&limit=2",
    );
    expect(counted.body.items).toHaveLength(2);
    // Minted on an offset page too, so a client can jump to page N and then
    // walk on from it; see `jobs-list-cursor.test.ts`.
    expect(counted.body.page.next).toStartWith("jl1.");
    expect({ ...counted.body.page, next: undefined }).toEqual({
      offset: 0,
      limit: 2,
      total: 3,
      hasMore: true,
      next: undefined,
    });

    // The last page knows it is the last from the total, not from an extra read.
    const last = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&name=sendEmail&total=true&offset=2&limit=2",
    );
    expect(last.body.page).toEqual({
      offset: 2,
      limit: 2,
      total: 3,
      hasMore: false,
      // A page that ends the list mints no cursor: `null` is the end signal.
      next: null,
    });
  });

  it("takes several names, comma-separated or repeated", async () => {
    const h = harness();
    const queue = h.jobs.queue("mail");
    await queue.add("sendEmail", {}, { jobId: "a" });
    await queue.add("resize", {}, { jobId: "b" });
    await queue.add("purge", {}, { jobId: "c" });

    const commas = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&name=sendEmail,resize",
    );
    expect(commas.body.items.map((job: any) => job.id)).toEqual(["a", "b"]);

    const repeated = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&name=sendEmail&name=purge",
    );
    expect(repeated.body.items.map((job: any) => job.id)).toEqual(["a", "c"]);

    const unknown = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&name=nothing-has-this-name",
    );
    expect(unknown.body.items).toEqual([]);
  });
});

describe("looking several jobs up", () => {
  it("answers in the order asked, null for missing, in one round trip", async () => {
    const driver = new MemoryDriver();
    let batches = 0;
    const native = driver.getJobs.bind(driver);
    driver.getJobs = async (...args) => {
      batches++;
      return await native(...args);
    };
    const jobs = jobsContext("api-reads-lookup", driver);
    const h = harness({ jobs });
    await jobs.queue("mail").add("send", {}, { jobId: "a" });
    await jobs.queue("mail").add("send", {}, { jobId: "c" });

    const res = await h.call("POST", "/queues/mail/jobs/lookup", {
      ids: ["c", "missing", "a", "c"],
    });

    expect(res.status).toBe(200);
    expect(res.body.items.map((job: any) => job?.id ?? null)).toEqual([
      "c",
      null,
      "a",
      "c",
    ]);
    // One batch for the whole list, not one read per id.
    expect(batches).toBe(1);
  });
});

describe("workers", () => {
  it("lists the live workers on a queue and across the namespace", async () => {
    const h = harness();
    await h.jobs.queue("mail").add("send", {});
    startWorker(h.jobs, "mail");
    await workerReported(h.jobs, "mail");

    const one = await h.call("GET", "/queues/mail/workers");
    expect(one.status).toBe(200);
    expect(one.body.items).toHaveLength(1);
    expect(one.body.items[0]).toMatchObject({ queue: "mail", paused: false });
    expect(typeof one.body.items[0].host).toBe("string");
    expect(typeof one.body.items[0].pid).toBe("number");

    const all = await h.call("GET", "/workers");
    expect(all.status).toBe(200);
    expect(all.body.items.map((worker: any) => worker.queue)).toEqual(["mail"]);
  });

  it("omits host and pid when exposeHosts is off", async () => {
    const h = harness({ serialize: { exposeHosts: false } });
    await h.jobs.queue("mail").add("send", {});
    startWorker(h.jobs, "mail");
    await workerReported(h.jobs, "mail");

    const res = await h.call("GET", "/queues/mail/workers");
    expect(res.body.items[0].host).toBeUndefined();
    expect(res.body.items[0].pid).toBeUndefined();
    expect(res.body.items[0].id).toBeTruthy();
  });

  it("never lists a worker on a queue the allowlist excludes", async () => {
    const jobs = jobsContext("api-reads-allow");
    const h = harness({ jobs, queues: ["mail"] });
    await jobs.queue("mail").add("send", {});
    await jobs.queue("secret").add("send", {});
    startWorker(jobs, "mail");
    startWorker(jobs, "secret");
    await workerReported(jobs, "mail");
    await workerReported(jobs, "secret");

    const all = await h.call("GET", "/workers");
    expect(all.body.items.map((worker: any) => worker.queue)).toEqual(["mail"]);
  });
});

describe("throughput", () => {
  it("reports what finished, and refuses a window outside its range", async () => {
    const h = harness();
    await h.jobs.queue("mail").add("send", {});
    await h.jobs.queue("mail").add("send", {});
    startWorker(h.jobs, "mail");
    await waitFor(
      async () => (await h.jobs.queue("mail").count("completed")) === 2,
    );

    const res = await h.call("GET", "/queues/mail/throughput?minutes=5");
    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(5);
    expect(res.body.completed).toBe(2);
    expect(res.body.failed).toBe(0);
    expect(res.body.to).toBe(res.body.buckets.at(-1).at);

    // The window is bounded at both ends, and the schema is what refuses it.
    // `getThroughput` would refuse these too, as INVALID_ARGUMENT, so only the
    // code tells a request the route rejected from one the queue turned away
    // after the call was already made.
    for (const minutes of [0, 1441]) {
      const bad = await h.call(
        "GET",
        `/queues/mail/throughput?minutes=${minutes}`,
      );
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("VALIDATION");
    }
  });
});

describe("the overview", () => {
  it("adds workers and throughput where the backend keeps them", async () => {
    const h = harness();
    await h.jobs.queue("mail").add("send", {});
    startWorker(h.jobs, "mail");
    await waitFor(
      async () => (await h.jobs.queue("mail").count("completed")) === 1,
    );
    await workerReported(h.jobs, "mail");

    const res = await h.call("GET", "/overview?minutes=5");
    expect(res.status).toBe(200);
    expect(res.body.workers).toBe(1);
    expect(res.body.throughput).toEqual({
      minutes: 5,
      completed: 1,
      failed: 0,
    });
  });

  it("counts only the workers on queues the allowlist admits", async () => {
    const jobs = jobsContext("api-reads-overview-allow");
    const h = harness({ jobs, queues: ["mail"] });
    await jobs.queue("mail").add("send", {});
    await jobs.queue("secret").add("send", {});
    startWorker(jobs, "mail");
    startWorker(jobs, "secret");
    await workerReported(jobs, "mail");
    await workerReported(jobs, "secret");

    const res = await h.call("GET", "/overview");
    // Two workers are running, on two queues; the overview sees one of each,
    // because the allowlist decides what this API may look at.
    expect(res.body.workers).toBe(1);
    expect(res.body.queues).toBe(1);
  });

  it("leaves them out where the backend keeps neither", async () => {
    const stripped = without(new MemoryDriver(), [
      ...NATIVE_WORKERS,
      ...STATE_WORKERS,
      "getThroughput",
    ]);
    const jobs = jobsContext("api-reads-bare", stripped);
    const h = harness({ jobs });
    await jobs.queue("mail").add("send", {});

    const res = await h.call("GET", "/overview");
    expect(res.status).toBe(200);
    expect(res.body.workers).toBeUndefined();
    expect(res.body.throughput).toBeUndefined();
    expect(res.body.queues).toBe(1);
  });
});

describe("pruning the read routes", () => {
  it("keeps the worker routes on a driver that keeps workers in queue state", async () => {
    // The decisive case: worker support is native methods *or* queue state, so
    // a route gated on `listWorkers` alone would wrongly 404 here.
    const stateOnly = without(new MemoryDriver(), NATIVE_WORKERS);
    const jobs = jobsContext("api-reads-state", stateOnly);
    const h = harness({ jobs });
    await jobs.queue("mail").add("send", {});
    startWorker(jobs, "mail");
    await workerReported(jobs, "mail");

    const res = await h.call("GET", "/queues/mail/workers");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);

    const meta = await h.call("GET", "/meta");
    expect(meta.body.features.workers).toBe(true);
  });

  it("prunes the worker routes, and says so, when nothing can keep workers", async () => {
    const bare = without(new MemoryDriver(), [
      ...NATIVE_WORKERS,
      ...STATE_WORKERS,
    ]);
    const jobs = jobsContext("api-reads-noworkers", bare);
    const h = harness({ jobs });

    for (const path of ["/workers", "/queues/mail/workers"]) {
      const res = await h.call("GET", path);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("ROUTE_NOT_FOUND");
    }

    const meta = await h.call("GET", "/meta");
    expect(meta.body.features.workers).toBe(false);
  });

  it("prunes throughput, and says so, when the driver cannot count it", async () => {
    const jobs = jobsContext(
      "api-reads-nothroughput",
      without(new MemoryDriver(), ["getThroughput"]),
    );
    const h = harness({ jobs });

    const res = await h.call("GET", "/queues/mail/throughput");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ROUTE_NOT_FOUND");

    const meta = await h.call("GET", "/meta");
    expect(meta.body.features.throughput).toBe(false);
  });

  it("reports run logs only where the driver can both write and read them", async () => {
    const full = harness({
      jobs: jobsContext("api-reads-runlogs", new MemoryDriver()),
    });
    expect((await full.call("GET", "/meta")).body.features.runnerLogs).toBe(
      true,
    );

    // A driver that can read a log it can never write has nothing to serve,
    // so either method missing turns the flag off.
    for (const missing of ["appendRunLog", "getRunLog"] as const) {
      const h = harness({
        jobs: jobsContext(
          `api-reads-runlogs-${missing}`,
          without(new MemoryDriver(), [missing]),
        ),
      });
      const meta = await h.call("GET", "/meta");
      expect({ missing, runnerLogs: meta.body.features.runnerLogs }).toEqual({
        missing,
        runnerLogs: false,
      });
    }
  });

  it("reports runner and worker metrics only where the driver can both write and read them", async () => {
    /** The two methods behind `features.runnerMetrics`: the write, then the read. */
    const RUNNER_METRICS = ["countRunnerRun", "getRunnerMetrics"] as const;
    /** The two behind `features.workerMetrics`. */
    const WORKER_METRICS = ["countWorkerJobs", "getWorkerMetrics"] as const;

    /** `/meta`'s two analytics flags, for one driver. */
    async function flags(
      namespace: string,
      driver: JobsDriver,
    ): Promise<{ runnerMetrics: boolean; workerMetrics: boolean }> {
      const h = harness({ jobs: jobsContext(namespace, driver) });
      const { features } = (await h.call("GET", "/meta")).body;
      return {
        runnerMetrics: features.runnerMetrics,
        workerMetrics: features.workerMetrics,
      };
    }

    // The memory driver records both kinds, so both flags are on for it —
    // this was `false`/`false` while no driver implemented the methods, and
    // moved the day the recording landed, which is the flag doing its job.
    expect(await flags("api-reads-metrics-none", new MemoryDriver())).toEqual({
      runnerMetrics: true,
      workerMetrics: true,
    });

    // A driver with none of the methods — an older one, or one that will
    // never record — says so, and that is not a placeholder: there is no
    // series for either route to serve.
    expect(
      await flags(
        "api-reads-metrics-bare",
        without(new MemoryDriver(), [...RUNNER_METRICS, ...WORKER_METRICS]),
      ),
    ).toEqual({ runnerMetrics: false, workerMetrics: false });

    // Given both pairs, both flags follow.
    expect(
      await flags(
        "api-reads-metrics-both",
        withMethods(new MemoryDriver(), [...RUNNER_METRICS, ...WORKER_METRICS]),
      ),
    ).toEqual({ runnerMetrics: true, workerMetrics: true });

    // And either method missing turns its own flag off — the counter as much
    // as the read, since a series that can be read but never written is an
    // empty chart, not a feature.
    for (const missing of [...RUNNER_METRICS, ...WORKER_METRICS]) {
      const driver = without(
        withMethods(new MemoryDriver(), [...RUNNER_METRICS, ...WORKER_METRICS]),
        [missing],
      );
      const runner = (RUNNER_METRICS as readonly string[]).includes(missing);
      expect({
        missing,
        ...(await flags(`api-reads-metrics-${missing}`, driver)),
      }).toEqual({
        missing,
        runnerMetrics: !runner,
        workerMetrics: runner,
      });
    }

    // Worker series are keyed by the worker's stable key and their rows are
    // the worker listing, so the counters alone serve no route: no single
    // method list says that, which is why `probeFeatures` overrides this one
    // the way it overrides `workerControl`. Runners come from the namespace,
    // not the driver, so that flag is unaffected.
    expect(
      await flags(
        "api-reads-metrics-noworkers",
        without(
          withMethods(new MemoryDriver(), [
            ...RUNNER_METRICS,
            ...WORKER_METRICS,
          ]),
          [...NATIVE_WORKERS, ...STATE_WORKERS],
        ),
      ),
    ).toEqual({ runnerMetrics: true, workerMetrics: false });

    // Every analytics route also needs the three methods a range is resolved
    // against, so a driver with both pairs but one of those three missing has
    // its runner and worker routes pruned, and its flags must say so. They
    // once read `true` here, each checking only its own pair, and advertised
    // routes that answered 404.
    for (const missing of [
      "getMetricsSupport",
      "getNamespaceMetrics",
      "getQueueMetrics",
    ]) {
      const h = harness({
        jobs: jobsContext(
          `api-reads-metrics-base-${missing}`,
          without(new MemoryDriver(), [missing]),
        ),
      });
      const { features } = (await h.call("GET", "/meta")).body;
      const routed = new Set(h.api.routes.map((route) => route.operationId));
      expect({
        missing,
        runnerMetrics: features.runnerMetrics,
        workerMetrics: features.workerMetrics,
        runnersRouted: routed.has("getRunnersAnalytics"),
        workersRouted: routed.has("getWorkersAnalytics"),
      }).toEqual({
        missing,
        runnerMetrics: false,
        workerMetrics: false,
        runnersRouted: false,
        workersRouted: false,
      });
    }

    // And with nothing missing, each flag and its routes agree the other way.
    const full = harness({
      jobs: jobsContext("api-reads-metrics-routed", new MemoryDriver()),
    });
    const routed = new Set(full.api.routes.map((route) => route.operationId));
    const { features } = (await full.call("GET", "/meta")).body;
    expect({
      runnerMetrics: features.runnerMetrics,
      workerMetrics: features.workerMetrics,
    }).toEqual({
      runnerMetrics:
        routed.has("getRunnersAnalytics") && routed.has("getRunnerAnalytics"),
      workerMetrics:
        routed.has("getWorkersAnalytics") && routed.has("getWorkerAnalytics"),
    });
    expect(features.runnerMetrics && features.workerMetrics).toBe(true);
  });

  it("reports each feature exactly where its routes are registered, in every mode", async () => {
    // Every mode, on a driver that supports everything: each flag must be
    // `true` exactly when every route it describes is registered. Before
    // flags took the mode into account, `runnerMetrics` read `true` in
    // `jobs` mode while `/analytics/runners` answered 404.
    const seen: Record<string, Record<string, boolean>> = {};
    for (const mode of ["jobs", "runner", "both"] as const) {
      const driver = new MemoryDriver();
      const h = harness({
        jobs: jobsContext(`api-reads-served-${mode}`, driver),
        mode,
      });
      const { features } = (await h.call("GET", "/meta")).body as {
        features: Record<keyof typeof FEATURE_ROUTES, boolean>;
      };
      const routed = new Set(h.api.routes.map((route) => route.operationId));
      for (const [feature, ids] of Object.entries(FEATURE_ROUTES)) {
        const registered = ids.every((id) => routed.has(id));
        expect({
          mode,
          feature,
          flag: features[feature as keyof typeof FEATURE_ROUTES],
        }).toEqual({
          mode,
          feature,
          // Attribution is the one flag a driver declares rather than one a
          // method implies, so "supports everything" is its capability.
          flag:
            registered &&
            (feature !== "jobAttribution" || supportsJobAttribution(driver)),
        });
      }
      seen[mode] = features;
    }
    // And the answers themselves, so a mapping that made every flag `false`
    // (or named no route) could not pass the loop above vacuously.
    expect(Object.values(seen.both!).every(Boolean)).toBe(true);
    expect(seen.jobs).toMatchObject({
      addedByState: true,
      jobAttribution: true,
      throughput: true,
      workers: true,
      workerMetrics: true,
      runnerLogs: false,
      runnerMetrics: false,
    });
    expect(seen.runner).toMatchObject({
      addedByState: false,
      jobAttribution: false,
      logs: false,
      update: false,
      limits: false,
      flows: false,
      search: false,
      workers: false,
      workerControl: false,
      throughput: false,
      workerMetrics: false,
      runnerLogs: true,
      runnerMetrics: true,
    });
  });

  it("reports job attribution from the driver's capability, narrowed by the mode", async () => {
    // The memory driver records attribution, so the flag is `true` wherever
    // the job list is served and `false` in runner mode, which serves none —
    // through `/meta`, valid against its schema, and echoed as the driver's
    // own capability in every mode.
    for (const mode of ["jobs", "runner", "both"] as const) {
      const h = harness({
        jobs: jobsContext(`api-reads-attribution-${mode}`, new MemoryDriver()),
        mode,
      });
      const { features, driver } = (await h.call("GET", "/meta")).body;
      expect({
        mode,
        jobAttribution: features.jobAttribution,
        capability: driver.capabilities.jobAttribution,
      }).toEqual({
        mode,
        jobAttribution: mode !== "runner",
        capability: true,
      });
    }

    // It tracks the capability: a driver that does not declare it reads
    // `false` everywhere, both as the feature and as the echoed capability,
    // and `/meta` still validates.
    const silent = withCapabilities(new MemoryDriver(), {
      jobAttribution: false,
    });
    expect(probeFeatures(silent).jobAttribution).toBe(false);
    const quiet = harness({
      jobs: jobsContext("api-reads-attribution-silent", silent),
    });
    const quietMeta = (await quiet.call("GET", "/meta")).body;
    expect(quietMeta.features.jobAttribution).toBe(false);
    expect(quietMeta.driver.capabilities.jobAttribution).toBe(false);
    const served = Object.fromEntries(
      (["jobs", "runner", "both"] as const).map((mode) => [
        mode,
        servedFeatures(
          resolveConfig(
            apiConfig({
              jobs: jobsContext(
                `api-reads-attribution-cap-${mode}`,
                new MemoryDriver(),
              ),
              mode,
              websocket: false,
            }),
          ),
        ).jobAttribution,
      ]),
    );
    expect(served).toEqual({ jobs: true, runner: false, both: true });

    // Only `true` itself counts: a truthy non-boolean, or the flag's absence,
    // is not a declaration.
    for (const value of [undefined, false, "yes", 1]) {
      expect({
        value,
        supported: supportsJobAttribution(
          withCapabilities(new MemoryDriver(), { jobAttribution: value }),
        ),
      }).toEqual({ value, supported: false });
    }
  });

  it("reports reads by creation time per driver: served where countAddedJobs is, in jobs and both modes only", async () => {
    // `features.addedByState` covers the two added-by-state routes and
    // `sort=createdAt`. The method's presence is the backend's promise
    // (memory, SQL and MongoDB implement it; Redis and file do not), and the
    // routes are pruned without it — so the flag is the method, narrowed to
    // the modes that register the routes.
    const without = new Proxy(new MemoryDriver(), {
      get(target, key, receiver) {
        if (key === "countAddedJobs") {
          return undefined;
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as JobsDriver;
    expect(probeFeatures(new MemoryDriver()).addedByState).toBe(true);
    expect(probeFeatures(without).addedByState).toBe(false);
    // The built-in drivers, by their prototypes: no instance, no connection.
    expect({
      memory: typeof MemoryDriver.prototype.countAddedJobs,
      sql: typeof SqlDriver.prototype.countAddedJobs,
      mongo: typeof MongoDriver.prototype.countAddedJobs,
      redis: typeof (RedisDriver.prototype as Partial<JobsDriver>)
        .countAddedJobs,
      file: typeof (FileDriver.prototype as Partial<JobsDriver>).countAddedJobs,
    }).toEqual({
      memory: "function",
      sql: "function",
      mongo: "function",
      redis: "undefined",
      file: "undefined",
    });
    for (const mode of ["jobs", "runner", "both"] as const) {
      for (const [label, driver, supported] of [
        ["memory", new MemoryDriver(), true],
        ["without", without, false],
      ] as const) {
        const h = harness({
          jobs: jobsContext(`api-reads-added-${label}-${mode}`, driver),
          mode,
        });
        const routed = new Set(h.api.routes.map((route) => route.operationId));
        const { features } = (await h.call("GET", "/meta")).body;
        const served = mode !== "runner" && supported;
        expect({
          mode,
          label,
          addedByState: features.addedByState,
          routes: FEATURE_ROUTES.addedByState.filter((id) => routed.has(id)),
        }).toEqual({
          mode,
          label,
          addedByState: served,
          routes:
            mode === "runner"
              ? []
              : supported
                ? ["getAddedByState", "getQueueAddedByState", "listJobs"]
                : ["listJobs"],
        });
      }
    }
  });

  it("reads job attribution live: a capability that changes under a running API is reported at once", async () => {
    // The SQL driver's capability turns on when a sync adds the stamp's
    // columns. `/meta` must not have cached the old answer.
    const memory = new MemoryDriver();
    let recording = false;
    const live = new Proxy(memory, {
      get(target, key, receiver) {
        if (key === "capabilities") {
          return { ...target.capabilities, jobAttribution: recording };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as JobsDriver;
    const h = harness({
      jobs: jobsContext("api-reads-attribution-live", live),
    });
    const before = (await h.call("GET", "/meta")).body;
    expect(before.features.jobAttribution).toBe(false);
    expect(before.driver.capabilities.jobAttribution).toBe(false);
    recording = true;
    const after = (await h.call("GET", "/meta")).body;
    expect(after.features.jobAttribution).toBe(true);
    expect(after.driver.capabilities.jobAttribution).toBe(true);
  });

  it("answers /meta when a driver declares a capability this version does not know", async () => {
    // `/meta` picks the capabilities it names rather than spreading them: the
    // schema admits no other key, so a spread would fail response validation.
    const h = harness({
      jobs: jobsContext(
        "api-reads-unknown-capability",
        withCapabilities(new MemoryDriver(), { teleport: true }),
      ),
    });
    const response = await h.call("GET", "/meta");
    expect(response.status).toBe(200);
    expect(response.body.driver.capabilities).not.toHaveProperty("teleport");
  });

  it("keeps a feature flag on under readOnly and a narrow `actions`: those are permissions, not support", async () => {
    const h = harness({
      jobs: jobsContext("api-reads-served-readonly", new MemoryDriver()),
      readOnly: true,
      actions: ["meta.read"],
    });
    const { features } = (await h.call("GET", "/meta")).body;
    const routed = new Set(h.api.routes.map((route) => route.operationId));
    // The routes are gone — `readOnly` prunes the mutations, `actions` the
    // rest — but the backend still has the features, and a UI tells "you may
    // not" from `readOnly` and `/meta/permissions`, not from these flags.
    expect(routed.has("updateJob")).toBe(false);
    expect(routed.has("getRunnersAnalytics")).toBe(false);
    expect(features).toMatchObject({
      update: true,
      workerControl: true,
      runnerMetrics: true,
    });
  });

  it("never lets a routed read answer 501", async () => {
    const bare = without(new MemoryDriver(), [
      ...NATIVE_WORKERS,
      ...STATE_WORKERS,
      "getThroughput",
    ]);
    const jobs = jobsContext("api-reads-501", bare);
    const h = harness({ jobs });
    await jobs.queue("mail").add("send", {});

    // The capability really is gone — the queue itself refuses…
    await expect(jobs.queue("mail").listWorkers()).rejects.toThrow(
      NotSupportedError,
    );
    // …and no route can reach that refusal, so 501 is unreachable.
    for (const path of [
      "/workers",
      "/queues/mail/workers",
      "/queues/mail/throughput",
    ]) {
      expect((await h.call("GET", path)).status).toBe(404);
    }
  });

  it("keeps the reads under readOnly and drops them in runner mode", () => {
    const ids = (config: Parameters<typeof apiConfig>[0]) =>
      createJobsApi(apiConfig({ websocket: false, ...config })).routes.map(
        (route) => route.operationId,
      );

    // Every read survives readOnly: none of them changes anything.
    const readOnly = ids({ readOnly: true });
    expect(readOnly).toContain("listWorkers");
    expect(readOnly).toContain("listQueueWorkers");
    expect(readOnly).toContain("getQueueThroughput");

    const runner = ids({ mode: "runner" });
    expect(runner).not.toContain("listWorkers");
    expect(runner).not.toContain("getQueueThroughput");
  });
});

describe("the generated document", () => {
  it("documents the new reads and their components", () => {
    const doc: any = createJobsApi(apiConfig({ websocket: false })).openapi();

    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/queues/{queue}/workers",
        "/workers",
        "/queues/{queue}/throughput",
      ]),
    );
    expect(doc.components.schemas.Worker).toBeDefined();
    expect(doc.components.schemas.QueueThroughput).toBeDefined();
    expect(doc.components.schemas.ThroughputBucket).toBeDefined();

    // The filters and the total are documented on the list.
    const list = doc.paths["/queues/{queue}/jobs"].get;
    const names = list.parameters.map((one: any) => one.name);
    expect(names).toEqual(expect.arrayContaining(["name", "search", "total"]));
  });
});

describe("authorizing the read routes", () => {
  it("asks once per request, naming the action and the queue", async () => {
    const h = harness();
    await h.jobs.queue("mail").add("send", {});

    await h.call("GET", "/queues/mail/workers");
    await h.call("GET", "/workers");
    await h.call("GET", "/queues/mail/throughput");

    expect(h.calls).toEqual([
      {
        action: "workers.list",
        mutation: false,
        transport: "http",
        queue: "mail",
        route: { method: "GET", path: "/queues/:queue/workers" },
      },
      {
        action: "workers.list",
        mutation: false,
        transport: "http",
        route: { method: "GET", path: "/workers" },
      },
      {
        action: "metrics.read",
        mutation: false,
        transport: "http",
        queue: "mail",
        route: { method: "GET", path: "/queues/:queue/throughput" },
      },
    ]);
  });
});

describe("stacktrace", () => {
  /** A job on `mail` that failed once, with a real stack. */
  async function failedJob(jobs: BunJobs): Promise<string> {
    const job = await jobs.queue("mail").add("send", {}, { attempts: 1 });
    const worker = new BunQueueWorker(
      "mail",
      async () => {
        throw new Error("smtp down");
      },
      { namespace: jobs.namespace, driver: jobs.driver, pollInterval: 10 },
    );
    closers.push(async () => await worker.close({ timeout: 1_000 }));
    void worker.run();
    await waitFor(
      async () => (await jobs.queue("mail").getJob(job.id))?.state === "dead",
      { message: "the job never died" },
    );
    return job.id;
  }

  it("carries stacks only with serialize.exposeStacks, as documented", async () => {
    const hidden = harness();
    const id = await failedJob(hidden.jobs);
    const plain = await hidden.call(
      "GET",
      `/queues/mail/jobs/${id}?include=stacktrace`,
    );
    expect(plain.body.stacktrace).toHaveLength(1);
    expect(plain.body.stacktrace[0]).toMatchObject({
      name: "Error",
      message: "smtp down",
    });
    expect(plain.body.stacktrace[0]).not.toHaveProperty("stack");
    expect(plain.body.failedReason).not.toHaveProperty("stack");

    const shown = harness({ serialize: { exposeStacks: true } });
    const shownId = await failedJob(shown.jobs);
    const withStacks = await shown.call(
      "GET",
      `/queues/mail/jobs/${shownId}?include=stacktrace`,
    );
    expect(withStacks.body.stacktrace[0].stack).toContain("smtp down");

    // The documents say so, where `stacktrace` and `stack` are described.
    const doc = hidden.api.openapi() as unknown as {
      paths: Record<string, Record<string, { description?: string }>>;
      components: {
        schemas: Record<
          string,
          { properties: Record<string, { description?: string }> }
        >;
      };
    };
    const { schemas } = doc.components;
    expect(schemas.Job!.properties.stacktrace!.description).toContain(
      "`serialize.exposeStacks`",
    );
    expect(schemas.Error!.properties.stack!.description).toContain(
      "`serialize.exposeStacks`",
    );
    for (const [path, method] of [
      ["/queues/{queue}/jobs", "get"],
      ["/queues/{queue}/jobs/{id}", "get"],
    ] as const) {
      expect(doc.paths[path]![method]!.description).toContain(
        "`stack` only with `serialize.exposeStacks`",
      );
    }
  });
});
