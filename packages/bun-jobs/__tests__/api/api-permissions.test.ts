import type {
  JobsApiAuthorize,
  JobsApiAuthorizeContext,
  JobsApiConfig,
} from "../../lib/api/config";
import type { BunJobs } from "../../lib/index";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createJobsApi } from "../../lib/api/createJobsApi";
import { JOBS_API_WS_SUBPROTOCOL } from "../../lib/api/ws/protocol";
import { BunQueueWorker, ConfigError } from "../../lib/index";
import { waitFor } from "../helpers";
import { apiConfig, harness, jobsContext, openContexts } from "./fixtures";

/**
 * Permission previews and per-queue listing:
 *
 * - `/meta/permissions` costs N + 1 `authorize` calls, and says so;
 * - each preview is shaped like the real request — `route` for an HTTP
 *   action, `transport: "ws"` and no route for the socket's — so an
 *   `authorize` deciding by either gives the map the request's answer;
 * - `listQueues: "authorized"` hides the queues `authorize` denies
 *   `queues.read` on, from `/queues` (paging included), `/overview` and
 *   `/workers`.
 */

/** Undone after each test, last first. */
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

afterAll(async () => {
  await Promise.all(openContexts.splice(0).map((jobs) => jobs.close()));
});

/** A harness whose API (and its socket) is closed after the test. */
function closing(overrides: Partial<JobsApiConfig> = {}) {
  const h = harness(overrides);
  cleanups.push(() => h.api.close());
  return h;
}

/** `ctx.route` as `"GET /path"`, or `undefined`. */
function routeOf(context: JobsApiAuthorizeContext): string | undefined {
  return context.route
    ? `${context.route.method} ${context.route.path}`
    : undefined;
}

/** An `authorize` that records every call and denies exactly the routes given. */
function denyingRoutes(
  calls: JobsApiAuthorizeContext[],
  denied: readonly string[],
): JobsApiAuthorize {
  return (_req, context) => {
    calls.push(context);
    const route = routeOf(context);
    return route === undefined || !denied.includes(route);
  };
}

describe("/meta/permissions: what it costs", () => {
  it("asks authorize N + 1 times: the request's own meta.read, then once per action", async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    const h = closing({ authorize: denyingRoutes(calls, []) });

    for (const query of ["", "?queue=mail", "?runner=nightly"]) {
      calls.length = 0;
      const res = await h.call("GET", `/meta/permissions${query}`);
      expect(res.status).toBe(200);
      const n = Object.keys(res.body.actions).length;
      expect(n).toBeGreaterThan(20);
      expect(calls).toHaveLength(n + 1);
      // The request's own call comes first, for its own route, and is not
      // reused for the map's `meta.read`: that entry previews `GET /meta`.
      expect(routeOf(calls[0]!)).toBe("GET /meta/permissions");
      expect(calls.slice(1).map((call): string => call.action)).toEqual(
        Object.keys(res.body.actions),
      );
      expect(
        calls
          .slice(1)
          .filter((call) => call.action === "meta.read")
          .map(routeOf),
      ).toEqual(["GET /meta"]);
    }

    // A channel that parses and is available adds exactly one more.
    calls.length = 0;
    const withChannel = await h.call(
      "GET",
      "/meta/permissions?channel=queue/mail",
    );
    expect(calls).toHaveLength(
      Object.keys(withChannel.body.actions).length + 2,
    );
    // One that does not parse adds none.
    calls.length = 0;
    const refused = await h.call("GET", "/meta/permissions?channel=nope");
    expect(refused.body.channel.allowed).toBe(false);
    expect(calls).toHaveLength(Object.keys(refused.body.actions).length + 1);
  });

  it("documents that cost exactly", () => {
    const h = closing();
    const doc = h.api.openapi() as unknown as {
      paths: Record<string, { get?: { description?: string } }>;
    };
    const operation = doc.paths["/meta/permissions"]?.get;
    expect(operation?.description).toContain(
      "`authorize` is called N + 1 times per request",
    );
    expect(operation?.description).not.toContain(
      "The cost is that many `authorize` calls per request",
    );
  });
});

describe("/meta/permissions: each preview is shaped like the real request", () => {
  it("gives every HTTP action a route of its own, chosen as documented", async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    const h = closing({ authorize: denyingRoutes(calls, []) });
    const patterns = new Map<string, string[]>();
    for (const route of h.api.routes) {
      const list = patterns.get(route.action) ?? [];
      list.push(`${route.method} ${route.path.slice("/admin/jobs".length)}`);
      patterns.set(route.action, list);
    }

    const previewed = async (query: string) => {
      calls.length = 0;
      await h.call("GET", `/meta/permissions${query}`);
      return new Map(
        calls.slice(1).map((call) => [call.action, call] as const),
      );
    };

    for (const query of ["", "?queue=mail", "?runner=nightly"]) {
      for (const [action, call] of await previewed(query)) {
        if (action.startsWith("events.")) {
          expect({
            action,
            transport: call.transport,
            route: call.route,
          }).toEqual({ action, transport: "ws", route: undefined });
          continue;
        }
        expect(call.transport).toBe("http");
        // Always one of the action's own registered patterns.
        expect(patterns.get(action)).toContain(routeOf(call)!);
      }
    }

    const untargeted = await previewed("");
    const byQueue = await previewed("?queue=mail");
    const byRunner = await previewed("?runner=nightly");
    const chosen = (
      map: Map<string, JobsApiAuthorizeContext>,
      action: string,
    ) => routeOf(map.get(action)!);

    expect(chosen(untargeted, "meta.read")).toBe("GET /meta");
    expect(chosen(untargeted, "metrics.read")).toBe("GET /overview");
    expect(chosen(byQueue, "metrics.read")).toBe(
      "GET /queues/:queue/throughput",
    );
    expect(chosen(untargeted, "workers.list")).toBe("GET /workers");
    expect(chosen(byQueue, "workers.list")).toBe("GET /queues/:queue/workers");
    // No route without `:queue`: the action's first registered route.
    expect(chosen(untargeted, "jobs.read")).toBe(
      "POST /queues/:queue/jobs/lookup",
    );
    expect(chosen(byQueue, "jobs.read")).toBe(
      "POST /queues/:queue/jobs/lookup",
    );
    expect(chosen(byQueue, "queues.read")).toBe("GET /queues/:queue");
    expect(chosen(untargeted, "runners.list")).toBe("GET /runners");
    expect(chosen(byRunner, "runners.read")).toBe("GET /runners/:runner");
    expect(chosen(byRunner, "runners.trigger")).toBe(
      "POST /runners/:runner/trigger",
    );
    // A runner target does not steer a queue-side action, nor the reverse.
    expect(chosen(byRunner, "metrics.read")).toBe("GET /overview");
    expect(chosen(byQueue, "runners.read")).toBe("GET /runners/:runner");
  });

  it("agrees with the real request when authorize decides by route", async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    const h = closing({
      authorize: denyingRoutes(calls, [
        "GET /queues/:queue",
        "GET /overview",
        "GET /workers",
        "GET /meta",
      ]),
    });
    await h.jobs.queue("mail").add("send", {});

    const map = async (query = "") =>
      (await h.call("GET", `/meta/permissions${query}`)).body.actions as Record<
        string,
        boolean
      >;
    const untargeted = await map();
    const mail = await map("?queue=mail");

    const statusOf = async (path: string) => (await h.call("GET", path)).status;

    // queues.read: denied on GET /queues/:queue, in the map and for real.
    expect(mail["queues.read"]).toBe(false);
    expect(await statusOf("/queues/mail")).toBe(403);

    // metrics.read: untargeted is /overview (denied); for a queue it is the
    // queue's throughput (allowed).
    expect(untargeted["metrics.read"]).toBe(false);
    expect(await statusOf("/overview")).toBe(403);
    expect(mail["metrics.read"]).toBe(true);
    expect(await statusOf("/queues/mail/throughput")).toBe(200);

    // workers.list: likewise.
    expect(untargeted["workers.list"]).toBe(false);
    expect(await statusOf("/workers")).toBe(403);
    expect(mail["workers.list"]).toBe(true);
    expect(await statusOf("/queues/mail/workers")).toBe(200);

    // meta.read: the map previews GET /meta, which is denied, although the
    // /meta/permissions request that asks it is allowed.
    expect(untargeted["meta.read"]).toBe(false);
    expect(await statusOf("/meta")).toBe(403);

    // Everything else is allowed in both.
    expect(mail["jobs.list"]).toBe(true);
    expect(await statusOf("/queues/mail/jobs")).toBe(200);
  });

  it("previews the socket's actions as the upgrade and a subscribe frame ask them", async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    // A host that allows the socket only over the socket, and only when no
    // HTTP route is involved — as the real upgrade and subscribe are asked.
    const authorize: JobsApiAuthorize = (_req, context) => {
      calls.push(context);
      if (context.action.startsWith("events.")) {
        return context.transport === "ws" && context.route === undefined;
      }
      return true;
    };
    const jobs = jobsContext("api-permissions-ws");
    const api = createJobsApi(
      apiConfig({ jobs, authorize, logger: noopLogger }),
    );
    const adapter = new BunHttpAdapter(0, { logger: noopLogger });
    adapter.use(api.basePath, api.router);
    api.websocket!.attach(adapter);
    const server = await adapter.listen(0);
    cleanups.push(async () => {
      await api.close();
      await adapter.close();
    });
    await jobs.queue("mail").add("send", {});
    const origin = `http://127.0.0.1:${server.port}`;

    const preview = (await (
      await fetch(`${origin}/admin/jobs/meta/permissions?channel=queue/mail`)
    ).json()) as {
      actions: Record<string, boolean>;
      channel: { allowed: boolean };
    };
    expect(preview.actions["events.connect"]).toBe(true);
    expect(preview.actions["events.subscribe"]).toBe(true);
    expect(preview.channel.allowed).toBe(true);
    const previewed = calls.filter(
      (call) => call.action === "events.subscribe" && call.channel,
    );
    expect(previewed).toHaveLength(1);

    // The real upgrade and subscribe: allowed, and the subscribe was asked
    // with exactly the context the preview used.
    calls.length = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/admin/jobs/ws`, [
      JOBS_API_WS_SUBPROTOCOL,
    ]);
    cleanups.push(() => ws.close());
    const frames: { type: string; rejected?: unknown[] }[] = [];
    ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the upgrade was refused"));
    });
    ws.send(
      JSON.stringify({ op: "subscribe", id: "s1", channels: ["queue/mail"] }),
    );
    await waitFor(() => frames.some((frame) => frame.type === "ack"), {
      message: () => `no ack: ${JSON.stringify(frames)}`,
    });
    expect(
      frames.find((frame) => frame.type === "ack")?.rejected ?? [],
    ).toEqual([]);
    const real = calls.filter(
      (call) => call.action === "events.subscribe" && call.channel,
    );
    expect(real).toEqual(previewed);
    expect(calls.filter((call) => call.action === "events.connect")).toEqual([
      { action: "events.connect", mutation: false, transport: "ws" },
    ]);
  });
});

/** Starts a worker on a queue, closed after the test. */
function startWorker(jobs: BunJobs, queue: string): void {
  const worker = new BunQueueWorker(queue, async () => "ok", {
    namespace: jobs.namespace,
    driver: jobs.driver,
    pollInterval: 10,
  });
  cleanups.push(async () => await worker.close({ timeout: 1_000 }));
  void worker.run();
}

/** Waits until the queue reports at least one live worker. */
async function workerReported(jobs: BunJobs, queue: string): Promise<void> {
  await waitFor(
    async () => (await jobs.queue(queue).listWorkers()).length > 0,
    { message: `no worker reported on ${queue}` },
  );
}

/** An `authorize` that records every call and denies `queues.read` on the queues given. */
function hidingQueues(
  calls: JobsApiAuthorizeContext[],
  hidden: readonly string[],
): JobsApiAuthorize {
  return (_req, context) => {
    calls.push(context);
    return !(
      context.action === "queues.read" &&
      context.queue !== undefined &&
      hidden.includes(context.queue)
    );
  };
}

describe("listQueues", () => {
  it("defaults to every reachable queue, without asking per queue", async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    const h = closing({ authorize: hidingQueues(calls, ["payroll"]) });
    for (const queue of ["audit", "mail", "payroll"]) {
      await h.jobs.queue(queue).add("send", {});
    }
    const res = await h.call("GET", "/queues");
    expect(res.body.items.map((item: { name: string }) => item.name)).toEqual([
      "audit",
      "mail",
      "payroll",
    ]);
    expect(res.body.page.total).toBe(3);
    expect((await h.call("GET", "/overview")).body.queues).toBe(3);
    expect(calls.map((call) => call.action)).toEqual([
      "queues.list",
      "metrics.read",
    ]);
  });

  it('"authorized" hides a denied queue from /queues, /overview and /workers', async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    const h = closing({
      listQueues: "authorized",
      authorize: hidingQueues(calls, ["payroll"]),
    });
    for (const queue of ["audit", "mail", "payroll"]) {
      await h.jobs.queue(queue).add("send", {});
    }
    await h.jobs.queue("payroll").add("send", {});
    startWorker(h.jobs, "mail");
    startWorker(h.jobs, "payroll");
    await workerReported(h.jobs, "mail");
    await workerReported(h.jobs, "payroll");

    calls.length = 0;
    const list = await h.call("GET", "/queues");
    expect(list.status).toBe(200);
    expect(list.body.items.map((item: { name: string }) => item.name)).toEqual([
      "audit",
      "mail",
    ]);
    expect(list.body.page).toMatchObject({ total: 2, hasMore: false });
    // One call for the route, then one per queue, with the queue read's own
    // context — route included.
    expect(calls).toHaveLength(4);
    expect(calls.slice(1)).toEqual(
      ["audit", "mail", "payroll"].map((queue) => ({
        action: "queues.read",
        mutation: false,
        transport: "http",
        queue,
        route: { method: "GET", path: "/queues/:queue" },
      })),
    );

    const overview = await h.call("GET", "/overview");
    expect(overview.body.queues).toBe(2);
    // payroll's two jobs are not summed.
    expect(overview.body.total).toBe(2);
    expect(overview.body.workers).toBe(1);

    const workers = await h.call("GET", "/workers");
    expect(
      workers.body.items.map((worker: { queue: string }) => worker.queue),
    ).toEqual(["mail"]);

    // The queue's own read agrees.
    expect((await h.call("GET", "/queues/payroll")).status).toBe(403);
    expect((await h.call("GET", "/queues/mail")).status).toBe(200);
    expect(h.mismatches()).toEqual([]);
  });

  it("pages the filtered list: offset, limit, total and hasMore count only what is shown", async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    const h = closing({
      listQueues: "authorized",
      authorize: hidingQueues(calls, ["b", "d", "f"]),
    });
    for (const queue of ["a", "b", "c", "d", "e", "f", "g"]) {
      await h.jobs.queue(queue).add("send", {});
    }
    const page = async (query: string) => {
      const res = await h.call("GET", `/queues${query}`);
      return {
        names: res.body.items.map((item: { name: string }) => item.name),
        page: res.body.page,
        truncated: res.body.truncated,
      };
    };
    expect(await page("?limit=2")).toEqual({
      names: ["a", "c"],
      page: { offset: 0, limit: 2, total: 4, hasMore: true },
      truncated: true,
    });
    expect(await page("?limit=2&offset=2")).toEqual({
      names: ["e", "g"],
      page: { offset: 2, limit: 2, total: 4, hasMore: false },
      truncated: false,
    });
    expect(await page("?limit=2&offset=4")).toEqual({
      names: [],
      page: { offset: 4, limit: 2, total: 4, hasMore: false },
      truncated: false,
    });
    // `search` narrows first, and only the matching queues are asked about.
    calls.length = 0;
    expect((await page("?search=d")).page.total).toBe(0);
    expect(
      calls.filter((call) => call.action === "queues.read").map((c) => c.queue),
    ).toEqual(["d"]);
    expect(h.mismatches()).toEqual([]);
  });

  it("asks at most 16 at a time, once per queue per request", async () => {
    let inFlight = 0;
    let peak = 0;
    const asked: string[] = [];
    const h = closing({
      listQueues: "authorized",
      authorize: async (_req, context) => {
        if (context.action !== "queues.read") {
          return true;
        }
        asked.push(context.queue!);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(2);
        inFlight--;
        return true;
      },
    });
    const names = Array.from(
      { length: 40 },
      (_, index) => `q${String(index).padStart(2, "0")}`,
    );
    for (const name of names) {
      await h.jobs.queue(name).add("send", {});
    }
    const res = await h.call("GET", "/queues?limit=5");
    expect(res.body.page.total).toBe(40);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
    expect(asked.toSorted()).toEqual(names);
  });

  it("fails the request with a 500 when authorize throws, as every route does", async () => {
    const h = closing({
      listQueues: "authorized",
      authorize: (_req, context) => {
        if (context.action === "queues.read" && context.queue === "mail") {
          throw new Error("policy store unreachable");
        }
        return true;
      },
    });
    await h.jobs.queue("audit").add("send", {});
    await h.jobs.queue("mail").add("send", {});
    for (const path of ["/queues", "/overview"]) {
      const res = await h.call("GET", path);
      expect({ path, status: res.status }).toEqual({ path, status: 500 });
      expect(res.body.code).toBe("INTERNAL");
      // Nothing about the queues leaks into the problem.
      expect(res.text).not.toContain("audit");
    }
    // A throwing authorize on a queue's own read is a 500 too.
    expect((await h.call("GET", "/queues/mail")).status).toBe(500);
  });

  it("is validated at construction", () => {
    expect(() =>
      createJobsApi(
        apiConfig({
          listQueues: "some" as unknown as "all",
        }),
      ),
    ).toThrow(ConfigError);
    // Without `queues.read` every queue would be hidden.
    expect(() =>
      createJobsApi(
        apiConfig({
          listQueues: "authorized",
          actions: ["queues.list", "meta.read"],
        }),
      ),
    ).toThrow(/queues\.read/);
    // The option is inert, and accepted, where there are no queue routes.
    expect(() =>
      createJobsApi(
        apiConfig({
          mode: "runner",
          listQueues: "authorized",
          actions: ["runners.list"],
        }),
      ),
    ).not.toThrow();
  });
});
