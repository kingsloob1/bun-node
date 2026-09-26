import type { JobRecord, JobsDriver } from "../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createJobsApi } from "../../lib/api/createJobsApi";
import { DEMAND_METRICS } from "../../lib/api/prometheus";
import { FEATURE_ROUTES } from "../../lib/api/routes/meta";
import { DEFAULT_DEMAND_CAP } from "../../lib/drivers/index";
import {
  BunJobs,
  FileDriver,
  MemoryDriver,
  MongoDriver,
  RedisDriver,
  SqlDriver,
} from "../../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "../helpers";
import { harness, openHarnesses } from "./fixtures";

/**
 * The depth endpoint — `GET /queues/{queue}/demand` and `GET /demand` — end to
 * end through the management API over a real `BunJobs`: the JSON body, the
 * Prometheus exposition and how it is chosen, authorization and visibility,
 * the cap, the fallback's `exact: false`, and `features.demand`.
 *
 * What each driver counts is the driver contract's (`countDemand`); this is
 * the route's side. Each case asserts what a parameter *excludes* as well as
 * what it keeps: a route that took `queues` or `format` and dropped it would
 * answer 200 with a plausible body.
 */

/** Undo steps, run as each case ends — exact names only. */
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
  for (const cleanup of cleanups.splice(0, cleanups.length).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

afterAll(async () => {
  for (const cleanup of cleanups.splice(0, cleanups.length).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** A context over `driver` in a namespace of the case's own, purged after. */
function context(driver: JobsDriver, label: string): BunJobs {
  const namespace = testNamespace(label);
  const jobs = new BunJobs({ namespace, driver });
  cleanups.push(async () => {
    await jobs.close();
    await driver.purge(namespace);
    await driver.close();
  });
  return jobs;
}

/** Stores records in a queue as they are, whatever state they claim. */
async function seed(
  jobs: BunJobs,
  queue: string,
  records: Partial<JobRecord>[],
): Promise<void> {
  const q = jobs.queue(queue);
  await q.connect();
  await jobs.driver.addJobs(
    q.ref,
    records.map((record) => makeJob(record)),
  );
}

/** One minute, in ms. */
const MINUTE = 60_000;

/**
 * Queue `a`: two waiting jobs, a delayed job and a retry both past due, an
 * active job whose lock lapsed (stalled), one whose lock is live, a delayed
 * job due in an hour, and a finished job that never counts.
 */
async function seedBacklog(jobs: BunJobs, queue = "a"): Promise<number> {
  const now = Date.now();
  const future = now + 60 * MINUTE;
  await seed(jobs, queue, [
    { id: "w-1", state: "waiting", createdAt: now - 5 },
    { id: "w-2", state: "waiting", createdAt: now - 4 },
    { id: "d-due", state: "delayed", runAt: now - MINUTE },
    {
      id: "f-due",
      state: "failed",
      runAt: now - MINUTE,
      attemptsMade: 1,
      maxAttempts: 3,
    },
    {
      id: "a-lapsed",
      state: "active",
      lockToken: "t1",
      lockExpiresAt: now - MINUTE,
      processedOn: now - 2 * MINUTE,
      workerId: "gone",
    },
    {
      id: "a-live",
      state: "active",
      lockToken: "t2",
      lockExpiresAt: now + 60 * MINUTE,
      processedOn: now - 1,
      workerId: "busy",
    },
    { id: "d-later", state: "delayed", runAt: future },
    {
      id: "c-1",
      state: "completed",
      finishedOn: now - 1,
      processedOn: now - 2,
    },
  ]);
  return future;
}

/** What `seedBacklog` makes queue `a` demand. */
const BACKLOG = {
  paused: false,
  waiting: 2,
  dueNow: 2,
  stalled: 1,
  active: 2,
  workers: 0,
  demand: 5,
  outstanding: 6,
  capped: false,
  exact: true,
};

/** A GET through a harness's router, returning the raw response. */
async function raw(
  h: ReturnType<typeof harness>,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await h.root.fetch(`/admin/jobs${path}`, { headers });
}

/** One parsed exposition sample. */
interface Sample {
  /** The metric name. */
  name: string;
  /** Its labels. */
  labels: Record<string, string>;
  /** Its value. */
  value: number;
}

/**
 * Parses an exposition strictly enough to catch a malformed one: every
 * family's `# HELP` then `# TYPE` then its samples, each family once, and a
 * line feed after the last line.
 */
function parseExposition(text: string): {
  families: string[];
  samples: Sample[];
} {
  expect(text.endsWith("\n")).toBe(true);
  const lines = text.slice(0, -1).split("\n");
  const families: string[] = [];
  const samples: Sample[] = [];
  let current: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const help = /^# HELP ([a-z_:][\w:]*) .+$/i.exec(line);
    if (help) {
      const type = lines[index + 1];
      expect(type).toBe(`# TYPE ${help[1]} gauge`);
      expect(families).not.toContain(help[1]);
      families.push(help[1]!);
      current = help[1];
      index++;
      continue;
    }
    const sample = /^([a-z_:][\w:]*)\{(.*)\} (\S+)$/i.exec(line);
    expect(sample).not.toBeNull();
    expect(sample![1]).toBe(current!);
    const labels: Record<string, string> = {};
    for (const pair of sample![2]!.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
      labels[pair[1]!] = pair[2]!;
    }
    samples.push({ name: sample![1]!, labels, value: Number(sample![3]) });
  }
  return { families, samples };
}

/** The value of `name` for `queue` in a parsed exposition. */
function valueOf(
  parsed: ReturnType<typeof parseExposition>,
  name: string,
  queue: string,
): number | undefined {
  return parsed.samples.find(
    (sample) => sample.name === name && sample.labels.queue === queue,
  )?.value;
}

/** A memory driver whose `countDemand` is hidden: a driver of somebody else's. */
function withoutCountDemand(): JobsDriver {
  return new Proxy(new MemoryDriver(), {
    get(target, key, receiver) {
      if (key === "countDemand") {
        return undefined;
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as JobsDriver;
}

describe("GET /queues/{queue}/demand: the JSON body", () => {
  it("counts waiting, due, stalled and active work, never finished jobs, and names the queue", async () => {
    const jobs = context(new MemoryDriver(), "demand-json");
    const future = await seedBacklog(jobs);
    const h = harness({ jobs });

    const before = Date.now();
    const read = await h.call("GET", "/queues/a/demand");
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/json");
    expect(read.headers.get("vary")).toBe("Accept");
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(read.body).toEqual({
      queue: "a",
      at: read.body.at,
      nextDueAt: future,
      ...BACKLOG,
    });
    expect(read.body.at).toBeGreaterThanOrEqual(before);
  });

  it("answers a paused queue's backlog with demand and outstanding 0, and the backlog again once resumed", async () => {
    const jobs = context(new MemoryDriver(), "demand-paused");
    await seedBacklog(jobs);
    const h = harness({ jobs });

    expect((await h.call("POST", "/queues/a/pause")).status).toBe(200);
    const paused = await h.call("GET", "/queues/a/demand");
    expect(paused.body).toMatchObject({
      ...BACKLOG,
      paused: true,
      demand: 0,
      outstanding: 0,
    });
    const scrape = parseExposition(
      await (await raw(h, "/queues/a/demand?format=prometheus")).text(),
    );
    expect(valueOf(scrape, "bunjobs_queue_demand", "a")).toBe(0);
    expect(valueOf(scrape, "bunjobs_queue_paused", "a")).toBe(1);
    expect(valueOf(scrape, "bunjobs_queue_waiting", "a")).toBe(2);

    // Control: the same backlog demands work once claiming resumes.
    expect((await h.call("POST", "/queues/a/resume")).status).toBe(200);
    expect((await h.call("GET", "/queues/a/demand")).body).toMatchObject(
      BACKLOG,
    );
  });

  it("answers an unknown queue 404 and a bad name 400, as problems whatever the format", async () => {
    const jobs = context(new MemoryDriver(), "demand-missing");
    await seedBacklog(jobs);
    const h = harness({ jobs });

    const missing = await raw(h, "/queues/nope/demand?format=prometheus");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await missing.json()).toMatchObject({ code: "QUEUE_NOT_FOUND" });
    const bad = await h.call("GET", "/queues/a%20b/demand");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_NAME");
  });
});

describe("the cap", () => {
  it("takes no cap from the caller: ?cap= is ignored, as any unknown query parameter is", async () => {
    const jobs = context(new MemoryDriver(), "demand-cap-ignored");
    await seedBacklog(jobs);
    const h = harness({ jobs });
    const strip = (body: Record<string, unknown>) => ({ ...body, at: 0 });

    const plain = await h.call("GET", "/queues/a/demand");
    for (const cap of ["5", "1", "0", "abc", "999999"]) {
      for (const path of ["/queues/a/demand", "/demand?queues=a"]) {
        const sep = path.includes("?") ? "&" : "?";
        const read = await h.call("GET", `${path}${sep}cap=${cap}`);
        expect({ path, cap, status: read.status }).toEqual({
          path,
          cap,
          status: 200,
        });
        const body =
          path === "/demand?queues=a" ? read.body.queues[0] : read.body;
        // Never applied: `cap=1` would read `waiting: 1, capped: true`.
        expect(strip(body)).toEqual(strip(plain.body));
        expect(body).toMatchObject({ waiting: 2, dueNow: 2, capped: false });
      }
    }
  });

  it("counts to the package default and says when a figure went past it", async () => {
    const jobs = context(new MemoryDriver(), "demand-cap-default");
    const now = Date.now();
    await seed(
      jobs,
      "a",
      Array.from({ length: DEFAULT_DEMAND_CAP + 1 }, (_, index) => ({
        id: `w-${index}`,
        state: "waiting" as const,
        createdAt: now - index,
      })),
    );
    const h = harness({ jobs });

    const read = await h.call("GET", "/queues/a/demand");
    expect(read.body).toMatchObject({
      waiting: DEFAULT_DEMAND_CAP,
      demand: DEFAULT_DEMAND_CAP,
      capped: true,
    });
    const scrape = parseExposition(
      await (await raw(h, "/queues/a/demand?format=prometheus")).text(),
    );
    expect(valueOf(scrape, "bunjobs_queue_demand_capped", "a")).toBe(1);
    // Control: one job fewer is exactly the cap, which is not capped.
    await jobs.queue("a").remove("w-0");
    expect((await h.call("GET", "/queues/a/demand")).body).toMatchObject({
      waiting: DEFAULT_DEMAND_CAP,
      capped: false,
    });
  });

  it("refuses an unknown format", async () => {
    const jobs = context(new MemoryDriver(), "demand-format-bad");
    await seedBacklog(jobs);
    const refused = await harness({ jobs }).call(
      "GET",
      "/queues/a/demand?format=openmetrics",
    );
    expect(refused.status).toBe(400);
    expect(refused.body.issues[0]).toMatchObject({ path: "format" });
  });
});

describe("the Prometheus exposition", () => {
  it("is chosen by ?format=prometheus, and carries every figure the JSON does", async () => {
    const jobs = context(new MemoryDriver(), "demand-prom");
    await seedBacklog(jobs);
    const h = harness({ jobs });

    const response = await raw(h, "/queues/a/demand?format=prometheus");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; version=0.0.4; charset=utf-8",
    );
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const parsed = parseExposition(await response.text());
    expect(parsed.families).toEqual([
      "bunjobs_queue_demand",
      "bunjobs_queue_outstanding",
      "bunjobs_queue_waiting",
      "bunjobs_queue_due",
      "bunjobs_queue_stalled",
      "bunjobs_queue_active",
      "bunjobs_queue_workers",
      "bunjobs_queue_paused",
      "bunjobs_queue_demand_capped",
    ]);
    for (const sample of parsed.samples) {
      expect(sample.labels).toEqual({ ns: jobs.namespace, queue: "a" });
    }
    const figures = {
      bunjobs_queue_demand: BACKLOG.demand,
      bunjobs_queue_outstanding: BACKLOG.outstanding,
      bunjobs_queue_waiting: BACKLOG.waiting,
      bunjobs_queue_due: BACKLOG.dueNow,
      bunjobs_queue_stalled: BACKLOG.stalled,
      bunjobs_queue_active: BACKLOG.active,
      bunjobs_queue_workers: 0,
      bunjobs_queue_paused: 0,
      bunjobs_queue_demand_capped: 0,
    };
    expect(
      Object.fromEntries(
        parsed.samples.map((sample) => [sample.name, sample.value]),
      ),
    ).toEqual(figures);
    expect(DEMAND_METRICS.map((metric) => metric.name)).toEqual(
      parsed.families,
    );
  });

  it("is chosen by an Accept preferring text/plain, and JSON otherwise; format overrides Accept", async () => {
    const jobs = context(new MemoryDriver(), "demand-accept");
    await seedBacklog(jobs);
    const h = harness({ jobs });
    const prometheusScrape =
      "application/openmetrics-text;version=1.0.0,application/openmetrics-text;version=0.0.1;q=0.75,text/plain;version=0.0.4;q=0.5,*/*;q=0.1";

    const cases: [string, Record<string, string>, "text" | "json"][] = [
      ["/queues/a/demand", { accept: "text/plain" }, "text"],
      ["/queues/a/demand", { accept: "text/plain;version=0.0.4" }, "text"],
      ["/queues/a/demand", { accept: prometheusScrape }, "text"],
      ["/demand", { accept: "text/plain" }, "text"],
      // JSON: no Accept, a wildcard, JSON, a browser, a type neither serves.
      ["/queues/a/demand", {}, "json"],
      ["/queues/a/demand", { accept: "*/*" }, "json"],
      ["/queues/a/demand", { accept: "application/json" }, "json"],
      [
        "/queues/a/demand",
        { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
        "json",
      ],
      ["/queues/a/demand", { accept: "application/xml" }, "json"],
      // `format` wins over `Accept`, both ways.
      ["/queues/a/demand?format=json", { accept: "text/plain" }, "json"],
      [
        "/queues/a/demand?format=prometheus",
        { accept: "application/json" },
        "text",
      ],
      ["/demand?format=json", { accept: "text/plain" }, "json"],
    ];
    for (const [path, headers, expected] of cases) {
      const response = await raw(h, path, headers);
      const type = response.headers.get("content-type");
      expect({ path, headers, type }).toEqual({
        path,
        headers,
        type:
          expected === "text"
            ? "text/plain; version=0.0.4; charset=utf-8"
            : "application/json",
      });
    }
  });

  it("scrapes the namespace as one exposition, each family grouped once over every queue", async () => {
    const jobs = context(new MemoryDriver(), "demand-prom-ns");
    await seedBacklog(jobs, "a");
    await seed(jobs, "b", [{ id: "b-1", state: "waiting" }]);
    const h = harness({ jobs });

    const parsed = parseExposition(
      await (await raw(h, "/demand?format=prometheus")).text(),
    );
    expect(parsed.families).toHaveLength(DEMAND_METRICS.length);
    expect(parsed.samples).toHaveLength(DEMAND_METRICS.length * 2);
    expect(valueOf(parsed, "bunjobs_queue_demand", "a")).toBe(5);
    expect(valueOf(parsed, "bunjobs_queue_demand", "b")).toBe(1);
    expect(new Set(parsed.samples.map((sample) => sample.labels.ns))).toEqual(
      new Set([jobs.namespace]),
    );
  });
});

describe("authorization and visibility", () => {
  it("asks queues.read about the queue, and a refusal is 403 in either format", async () => {
    const jobs = context(new MemoryDriver(), "demand-auth");
    await seedBacklog(jobs);
    const h = harness({
      jobs,
      authorize: (_req, ctx) =>
        !(ctx.action === "queues.read" && ctx.queue === "a"),
    });

    const refused = await raw(h, "/queues/a/demand?format=prometheus");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("content-type")).toBe(
      "application/problem+json",
    );

    const open = harness({ jobs });
    expect((await open.call("GET", "/queues/a/demand")).status).toBe(200);
    expect(open.calls).toEqual([
      expect.objectContaining({
        action: "queues.read",
        queue: "a",
        route: { method: "GET", path: "/queues/:queue/demand" },
      }),
    ]);
  });

  it("reads /demand under queues.list, and hides what the allowlist or listQueues: authorized hides", async () => {
    const jobs = context(new MemoryDriver(), "demand-visible");
    await seedBacklog(jobs, "a");
    await seed(jobs, "b", [{ id: "b-1", state: "waiting" }]);
    await seed(jobs, "secret", [
      { id: "s-1", state: "waiting" },
      { id: "s-2", state: "waiting" },
    ]);
    const names = (response: { body: { queues: { queue: string }[] } }) =>
      response.body.queues.map((one) => one.queue);

    // Control: everything visible, by name.
    const open = harness({ jobs });
    const all = await open.call("GET", "/demand");
    expect(all.status).toBe(200);
    expect(names(all)).toEqual(["a", "b", "secret"]);
    expect(all.body.truncated).toBe(false);
    expect(open.calls.map((call) => call.action)).toEqual(["queues.list"]);

    // The allowlist: `secret` is not reachable at all, even by name.
    const listed = harness({ jobs, queues: ["a", "b"] });
    expect(names(await listed.call("GET", "/demand"))).toEqual(["a", "b"]);
    expect(names(await listed.call("GET", "/demand?queues=secret,a"))).toEqual([
      "a",
    ]);

    // `listQueues: "authorized"`: `authorize` refuses `queues.read` on
    // `secret`, asked as `GET /queues/{queue}` would ask.
    const asked: { action: string; route?: unknown }[] = [];
    const authorized = harness({
      jobs,
      listQueues: "authorized",
      authorize: (_req, ctx) => {
        asked.push(ctx);
        return !(ctx.action === "queues.read" && ctx.queue === "secret");
      },
    });
    const filtered = await authorized.call("GET", "/demand");
    expect(filtered.status).toBe(200);
    expect(names(filtered)).toEqual(["a", "b"]);
    expect(
      names(await authorized.call("GET", "/demand?queues=secret,b")),
    ).toEqual(["b"]);
    expect(
      asked.filter((call) => call.action === "queues.read")[0],
    ).toMatchObject({ route: { method: "GET", path: "/queues/:queue" } });
    const scrape = parseExposition(
      await (await raw(authorized, "/demand?format=prometheus")).text(),
    );
    expect(
      scrape.samples.some((sample) => sample.labels.queue === "secret"),
    ).toBe(false);

    // Refused `queues.list` outright: 403.
    const noList = harness({
      jobs,
      authorize: (_req, ctx) => ctx.action !== "queues.list",
    });
    expect((await noList.call("GET", "/demand")).status).toBe(403);
  });

  it("keeps ?queues= in the order asked, once each, leaving unknown names out", async () => {
    const jobs = context(new MemoryDriver(), "demand-order");
    await seedBacklog(jobs, "a");
    await seed(jobs, "b", [{ id: "b-1", state: "waiting" }]);
    const h = harness({ jobs });

    const read = await h.call("GET", "/demand?queues=b,nope,a,b");
    expect(read.body.queues.map((one: { queue: string }) => one.queue)).toEqual(
      ["b", "a"],
    );
    expect(read.body.queues[1]).toMatchObject(BACKLOG);
    const repeated = await h.call("GET", "/demand?queues=a&queues=b");
    expect(repeated.body.queues).toHaveLength(2);
    const empty = await h.call("GET", "/demand?queues=nope");
    expect(empty.body).toEqual({ queues: [], truncated: false });
  });

  it("reads at most limits.maxQueues, says so, and refuses a longer ?queues=", async () => {
    const jobs = context(new MemoryDriver(), "demand-trunc");
    for (const name of ["a", "b", "c"]) {
      await seed(jobs, name, [{ id: `${name}-1`, state: "waiting" }]);
    }
    const h = harness({ jobs, limits: { queueCacheMs: 0, maxQueues: 2 } });

    const read = await h.call("GET", "/demand");
    expect(read.body.queues.map((one: { queue: string }) => one.queue)).toEqual(
      ["a", "b"],
    );
    expect(read.body.truncated).toBe(true);
    const refused = await h.call("GET", "/demand?queues=a,b,c");
    expect(refused.status).toBe(400);
    expect(refused.body.issues[0]).toMatchObject({ path: "queues" });
  });

  it("serves the scaler recipe: a read-only API allowed queues.read and nothing else", async () => {
    const jobs = context(new MemoryDriver(), "demand-scaler");
    await seedBacklog(jobs);
    const scaler = createJobsApi({
      jobs,
      basePath: "/scaler",
      readOnly: true,
      actions: ["queues.read"],
      // The plan's recipe wrote `({ req }) => req.headers.get(…)`; `authorize`
      // takes `(req, context)` and a `BunRequest` reads a header by name.
      authorize: (req) => req.getHeader("authorization") === "Bearer s3",
      logger: noopLogger,
    });
    expect(scaler.routes.map((route) => route.operationId)).toContain(
      "getQueueDemand",
    );
    // `/demand` is `queues.list`, which this API does not allow.
    expect(scaler.routes.map((route) => route.operationId)).not.toContain(
      "listQueueDemand",
    );
    const allowed = await scaler.router.fetch("/queues/a/demand", {
      headers: { authorization: "Bearer s3" },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject(BACKLOG);
    const denied = await scaler.router.fetch("/queues/a/demand", {
      headers: { authorization: "Bearer wrong" },
    });
    expect([401, 403]).toContain(denied.status);
    await scaler.close();
  });
});

describe("the fallback, and features.demand", () => {
  it("serves a driver without countDemand: features.demand true, each answer exact: false", async () => {
    const jobs = context(withoutCountDemand(), "demand-fallback");
    await seed(jobs, "a", [
      { id: "w-1", state: "waiting" },
      { id: "d-1", state: "delayed", runAt: Date.now() - MINUTE },
      { id: "d-2", state: "delayed", runAt: Date.now() - MINUTE },
    ]);
    const h = harness({ jobs });

    expect(h.api.routes.map((route) => route.operationId)).toEqual(
      expect.arrayContaining(["getQueueDemand", "listQueueDemand"]),
    );
    // The flag says the routes are served; exactness is per answer.
    expect((await h.call("GET", "/meta")).body.features.demand).toBe(true);
    const read = await h.call("GET", "/queues/a/demand");
    expect(read.status).toBe(200);
    // Two jobs are due; the fallback can only say that something is.
    expect(read.body).toMatchObject({
      waiting: 1,
      dueNow: 1,
      demand: 2,
      exact: false,
    });

    // Control: the same seed on a driver that counts demand is exact.
    const exact = context(new MemoryDriver(), "demand-fallback-control");
    await seed(exact, "a", [
      { id: "w-1", state: "waiting" },
      { id: "d-1", state: "delayed", runAt: Date.now() - MINUTE },
      { id: "d-2", state: "delayed", runAt: Date.now() - MINUTE },
    ]);
    const control = harness({ jobs: exact });
    expect((await control.call("GET", "/meta")).body.features.demand).toBe(
      true,
    );
    expect((await control.call("GET", "/queues/a/demand")).body).toMatchObject({
      dueNow: 2,
      demand: 3,
      exact: true,
    });
  });

  it("is false in runner mode, where the demand routes are not served", async () => {
    const h = harness({
      jobs: context(new MemoryDriver(), "demand-runner"),
      mode: "runner",
    });
    expect((await h.call("GET", "/meta")).body.features.demand).toBe(false);
    const routed = h.api.routes.map((route) => route.operationId);
    for (const id of FEATURE_ROUTES.demand) {
      expect(routed).not.toContain(id);
    }
  });

  it("documents both routes, JSON and the exposition, in the OpenAPI document", async () => {
    const h = harness({ jobs: context(new MemoryDriver(), "demand-spec") });
    const document = h.api.openapi() as unknown as {
      paths: Record<string, Record<string, any>>;
    };
    const one = document.paths["/queues/{queue}/demand"]!.get;
    const many = document.paths["/demand"]!.get;
    expect(one.operationId).toBe("getQueueDemand");
    expect(one["x-bun-jobs-action"]).toBe("queues.read");
    expect(one["x-bun-jobs-requires"]).toEqual([]);
    expect(many.operationId).toBe("listQueueDemand");
    expect(many["x-bun-jobs-action"]).toBe("queues.list");
    expect(Object.keys(one.responses["200"].content)).toEqual([
      "application/json",
      "text/plain; version=0.0.4",
    ]);
    expect(one.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/QueueDemand",
    });
    expect(many.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/QueueDemandList",
    });
    expect(
      one.responses["200"].content["text/plain; version=0.0.4"].schema.type,
    ).toBe("string");
    const parameters = (op: { parameters: { name: string }[] }) =>
      op.parameters.map((parameter) => parameter.name).sort();
    expect(parameters(one)).toEqual(["format", "queue"]);
    expect(parameters(many)).toEqual(["format", "queues"]);
    // Control: a JSON-only route documents JSON alone.
    expect(
      Object.keys(
        document.paths["/queues/{queue}/counts"]!.get.responses["200"].content,
      ),
    ).toEqual(["application/json"]);
  });
});

/** A backend for the per-driver case; `undefined` `make` when unavailable. */
interface Backend {
  /** Shown in the test title. */
  name: string;
  /** Builds a driver. */
  make: (() => Promise<JobsDriver>) | undefined;
}

/** A server-backed backend, skipped when its variable is unset. */
function server(
  name: string,
  variable: string,
  build: (url: string) => JobsDriver,
): Backend {
  const url = process.env[variable];
  return { name, make: url ? async () => build(url) : undefined };
}

const BACKENDS: Backend[] = [
  { name: "memory", make: async () => new MemoryDriver() },
  {
    name: "file",
    make: async () => {
      const tmp = await makeTmpDir("bun-jobs-api-demand");
      cleanups.push(tmp.cleanup);
      return new FileDriver({ root: tmp.path, pollInterval: 10 });
    },
  },
  {
    name: "sqlite",
    make: async () => {
      const tmp = await makeTmpDir("bun-jobs-api-demand-sqlite");
      cleanups.push(tmp.cleanup);
      return new SqlDriver({ url: `sqlite://${tmp.path}/jobs.db` });
    },
  },
  ...(["postgres", "mysql", "mariadb"] as const).map((adapter) =>
    server(
      adapter,
      `BUN_JOBS_TEST_${adapter.toUpperCase()}_URL`,
      (url) =>
        new SqlDriver({
          url,
          adapter,
          tablePrefix: "bun_jobs_test_",
          pollInterval: 10,
        }),
    ),
  ),
  server(
    "mongodb",
    "BUN_JOBS_TEST_MONGODB_URL",
    (url) => new MongoDriver({ url, pollInterval: 10 }),
  ),
  server("redis", "BUN_JOBS_TEST_REDIS_URL", (url) => new RedisDriver({ url })),
];

describe("features.demand, per driver", () => {
  for (const backend of BACKENDS) {
    it.skipIf(!backend.make)(
      `${backend.name}: exact, and the routes answer the same figures`,
      async () => {
        const driver = await backend.make!();
        const jobs = context(driver, `demand-flag-${backend.name}`);
        const now = Date.now();
        await seed(jobs, "a", [
          { id: "w-1", state: "waiting", createdAt: now - 3 },
          { id: "w-2", state: "waiting", createdAt: now - 2 },
          { id: "d-due", state: "delayed", runAt: now - MINUTE },
          { id: "d-later", state: "delayed", runAt: now + 60 * MINUTE },
        ]);
        const h = harness({ jobs });
        expect((await h.call("GET", "/meta")).body.features.demand).toBe(true);
        const one = await h.call("GET", "/queues/a/demand");
        expect(one.body).toMatchObject({
          queue: "a",
          waiting: 2,
          dueNow: 1,
          demand: 3,
          outstanding: 3,
          nextDueAt: now + 60 * MINUTE,
          exact: true,
        });
        const all = await h.call("GET", "/demand");
        expect(all.body.queues).toEqual([
          { ...one.body, at: all.body.queues[0].at },
        ]);
        const scrape = parseExposition(
          await (await raw(h, "/queues/a/demand?format=prometheus")).text(),
        );
        expect(valueOf(scrape, "bunjobs_queue_demand", "a")).toBe(3);
      },
    );
  }
});
