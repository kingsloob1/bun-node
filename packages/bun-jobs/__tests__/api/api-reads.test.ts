import type { BunJobs, JobsDriver } from "../../lib/index";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createJobsApi } from "../../lib/api/createJobsApi";
import {
  BunQueueWorker,
  MemoryDriver,
  NotSupportedError,
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
    expect(counted.body.page).toEqual({
      offset: 0,
      limit: 2,
      total: 3,
      hasMore: true,
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
