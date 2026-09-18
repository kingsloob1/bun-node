import type {
  JobsApi,
  JobsApiAuthorizeContext,
  JobsApiConfig,
} from "../../lib/api/config";
import type { AnyRouteDef } from "../../lib/api/routes/define";
import { BunRouter, createTestLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { resolveConfig } from "../../lib/api/config";
import {
  buildJobsApi,
  builtInRoutes,
  createJobsApi,
} from "../../lib/api/createJobsApi";
import { defineRoute, isRouteEnabled } from "../../lib/api/routes/define";
import { probeFeatures } from "../../lib/api/routes/meta";
import { s } from "../../lib/api/schema/builder";
import { MetaSchema } from "../../lib/api/schemas/meta";
import { BunQueue, ConfigError, MemoryDriver } from "../../lib/index";
import { apiConfig, jobsContext, openContexts, testRoutes } from "./fixtures";

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

/** An API over the built-in routes plus `extra`. */
function api(
  overrides: Partial<JobsApiConfig> = {},
  extra: AnyRouteDef[] = testRoutes(),
): JobsApi {
  const resolved = resolveConfig(apiConfig(overrides));
  return buildJobsApi(resolved, [...builtInRoutes(resolved), ...extra]);
}

/** A host router with the API mounted at its base path, next to a route of its own. */
function mounted(target: JobsApi): BunRouter {
  const root = new BunRouter();
  root.get("/host", (_req, res) => {
    return res.json({ host: true });
  });
  root.use(target.basePath, target.router);
  return root;
}

/** POSTs JSON (or a raw string) to a mounted API. */
function post(
  root: BunRouter,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return root.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("mounting", () => {
  it("serves the API under basePath and leaves the host's routes alone", async () => {
    const root = mounted(api());
    expect((await root.fetch("/admin/jobs/meta")).status).toBe(200);
    expect(await (await root.fetch("/host")).json()).toEqual({ host: true });

    const missing = await root.fetch("/admin/jobs/nowhere");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await missing.json()).toMatchObject({ code: "ROUTE_NOT_FOUND" });
    // Outside the base path the API's catch-all never answers.
    expect(
      (await root.fetch("/elsewhere")).headers.get("content-type"),
    ).not.toBe("application/problem+json");
  });

  it("reports the routes it registered", () => {
    // The route snapshot: a change here is a change to the API's surface, and
    // should be read as one in review. Default configuration — both halves,
    // every action but the opt-in ones — with the socket off: its route and
    // `/asyncapi.json` are the WebSocket unit's to pin.
    const described = createJobsApi(apiConfig({ websocket: false })).routes.map(
      (route) =>
        `${route.method} ${route.path} ${route.operationId} ${route.action}${route.mutation ? " (mutation)" : ""}`,
    );
    expect(described).toEqual([
      "GET /admin/jobs/meta getMeta meta.read",
      "GET /admin/jobs/meta/permissions getPermissions meta.read",
      "GET /admin/jobs/openapi.json getOpenApiDocument docs.read",
      "GET /admin/jobs/overview getOverview metrics.read",
      "GET /admin/jobs/queues listQueues queues.list",
      "GET /admin/jobs/queues/:queue getQueue queues.read",
      "GET /admin/jobs/queues/:queue/counts getQueueCounts queues.read",
      "POST /admin/jobs/queues/:queue/pause pauseQueue queues.pause (mutation)",
      "POST /admin/jobs/queues/:queue/resume resumeQueue queues.resume (mutation)",
      "POST /admin/jobs/queues/:queue/drain drainQueue queues.drain (mutation)",
      "POST /admin/jobs/queues/:queue/clean cleanQueue queues.clean (mutation)",
      "GET /admin/jobs/queues/:queue/limits getQueueLimits queues.read",
      "PUT /admin/jobs/queues/:queue/limits setQueueLimits queues.limits (mutation)",
      "GET /admin/jobs/queues/:queue/workers listQueueWorkers workers.list",
      "GET /admin/jobs/workers listWorkers workers.list",
      "GET /admin/jobs/queues/:queue/throughput getQueueThroughput metrics.read",
      "GET /admin/jobs/queues/:queue/jobs listJobs jobs.list",
      "POST /admin/jobs/queues/:queue/jobs/lookup lookupJobs jobs.read",
      "GET /admin/jobs/queues/:queue/jobs/:id getJob jobs.read",
      "GET /admin/jobs/queues/:queue/jobs/:id/logs getJobLogs jobs.logs",
      "GET /admin/jobs/queues/:queue/jobs/:id/children getJobChildren jobs.read",
      "DELETE /admin/jobs/queues/:queue/jobs/:id removeJob jobs.remove (mutation)",
      "POST /admin/jobs/queues/:queue/jobs/:id/retry retryJob jobs.retry (mutation)",
      "POST /admin/jobs/queues/:queue/jobs/:id/promote promoteJob jobs.promote (mutation)",
      "POST /admin/jobs/queues/:queue/jobs/retry retryJobs jobs.retry (mutation)",
      "POST /admin/jobs/queues/:queue/jobs/remove removeJobs jobs.remove (mutation)",
      "POST /admin/jobs/queues/:queue/jobs/promote promoteJobs jobs.promote (mutation)",
      "POST /admin/jobs/queues/:queue/jobs/retry-all retryAllJobs jobs.retryAll (mutation)",
      "GET /admin/jobs/queues/:queue/repeatables listRepeatables repeatables.list",
      "DELETE /admin/jobs/queues/:queue/repeatables/:key removeRepeatable repeatables.remove (mutation)",
      "GET /admin/jobs/definitions listDefinitions definitions.list",
      "GET /admin/jobs/runners listRunners runners.list",
      "GET /admin/jobs/runners/:runner getRunner runners.read",
      "GET /admin/jobs/runners/:runner/history getRunnerHistory runners.read",
      "GET /admin/jobs/runners/:runner/stats getRunnerStats runners.read",
      "POST /admin/jobs/runners/:runner/trigger triggerRunner runners.trigger (mutation)",
      "POST /admin/jobs/runners/:runner/pause pauseRunner runners.pause (mutation)",
      "POST /admin/jobs/runners/:runner/resume resumeRunner runners.resume (mutation)",
      "PUT /admin/jobs/runners/:runner/schedule rescheduleRunner runners.reschedule (mutation)",
      "POST /admin/jobs/runners/:runner/kill killRunner runners.kill (mutation)",
      "POST /admin/jobs/runners/:runner/stats/reset resetRunnerStats runners.resetStats (mutation)",
    ]);
  });

  it("exposes basePath and mode, no socket when it is off, and a close that closes nothing it does not own", async () => {
    const jobs = jobsContext();
    const created = createJobsApi(
      apiConfig({ jobs, basePath: "/ops/", websocket: false }),
    );
    expect(created.basePath).toBe("/ops");
    expect(created.mode).toBe("both");
    expect(created.websocket).toBeUndefined();
    expect(created.asyncapi()).toBeUndefined();
    await created.close();
    // The context is still usable: the API never closes what it was given.
    await jobs.queue("still-open").add("x", {});
    expect(await jobs.listQueues()).toContain("still-open");
  });
});

describe("the per-route pipeline", () => {
  const path = "/admin/jobs/queues/mail/items/42/retry";

  /** A mounted API recording every authorize call. */
  function recording(overrides: Partial<JobsApiConfig> = {}) {
    const calls: JobsApiAuthorizeContext[] = [];
    const root = mounted(
      api({
        authorize: (_req, context) => {
          calls.push(context);
          return true;
        },
        ...overrides,
      }),
    );
    return { root, calls };
  }

  it("answers a valid request, authorizing it with the validated target", async () => {
    const { root, calls } = recording();
    const response = await post(root, path, { ids: ["a"] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      queue: "mail",
      id: 42,
      ids: ["a"],
    });
    expect(calls).toEqual([
      {
        action: "jobs.retry",
        mutation: true,
        transport: "http",
        queue: "mail",
        jobIds: ["a"],
        route: { method: "POST", path: "/queues/:queue/items/:id/retry" },
      },
    ]);
  });

  it("uses a declared body-less status", async () => {
    const { root } = recording();
    const response = await post(root, path, { ids: [] });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("refuses a non-JSON mutation, after asking authorize without a target", async () => {
    const { root, calls } = recording();
    const response = await root.fetch(path, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{bad",
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
    // Asked once, and told nothing the request named.
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("queue");
    expect(calls[0]).not.toHaveProperty("jobIds");
  });

  it("answers a malformed JSON body with 400 INVALID_JSON, not a missing body", async () => {
    const { root, calls } = recording();
    const response = await post(root, path, '{"ids": [');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "INVALID_JSON",
      title: "Malformed JSON body",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("queue");

    // A blank body is missing, not malformed: the schema says so.
    const blank = await post(root, path, "   ");
    expect(blank.status).toBe(400);
    expect(await blank.json()).toMatchObject({
      code: "VALIDATION",
      issues: [{ target: "body", path: "", message: "Required" }],
    });
  });

  it("validates before the handler, as a VALIDATION problem", async () => {
    const { root, calls } = recording();
    const response = await post(
      root,
      "/admin/jobs/queues/mail/items/zero/retry?state=nope",
      { ids: ["a", "b", "c"] },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; issues: unknown[] };
    expect(body.code).toBe("VALIDATION");
    expect(body.issues).toEqual([
      {
        target: "params",
        path: "id",
        message: "Expected integer, received string",
      },
      {
        target: "query",
        path: "state.0",
        message: expect.stringMatching(/^Expected one of/),
      },
      { target: "body", path: "ids", message: "Expected at most 2 items" },
    ]);
    // The issues reach a caller only once authorize allowed the request; it
    // was asked once, without a target.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      action: "jobs.retry",
      mutation: true,
      transport: "http",
      route: { method: "POST", path: "/queues/:queue/items/:id/retry" },
    });
  });

  it("answers a denial after validation, and never runs the handler", async () => {
    const root = mounted(
      api({ authorize: () => ({ allow: false, status: 401 }) }),
    );
    const response = await post(root, path, { ids: ["a"] });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("logs a response that breaks its schema only with validateResponses", async () => {
    const strict = createTestLogger();
    const root = mounted(
      api({ validateResponses: true, logger: strict.logger }),
    );
    const response = await root.fetch("/admin/jobs/wrong-body");
    expect(response.status).toBe(200);
    const logged = strict.events.filter(
      (event) => event.message === "jobs api response did not match its schema",
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]!.level).toBe("error");
    expect(logged[0]!.fields).toMatchObject({
      operationId: "getWrongBody",
      status: 200,
      mismatch: "ok: Expected boolean, received string",
    });

    const lax = createTestLogger();
    await mounted(api({ logger: lax.logger })).fetch("/admin/jobs/wrong-body");
    expect(lax.events.filter((event) => event.level === "error")).toHaveLength(
      0,
    );
  });

  it("runs middleware before every route, and maps its thrown status", async () => {
    const calls: string[] = [];
    const root = mounted(
      api({
        authorize: (_req, context) => {
          calls.push(context.action);
          return true;
        },
        middleware: [
          (req) => {
            if (req.getHeader("authorization") !== "Bearer ok") {
              throw Object.assign(new Error("Missing token"), { status: 401 });
            }
          },
          (_req, _res, next) => next(),
        ],
      }),
    );
    const refused = await root.fetch("/admin/jobs/meta");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      code: "UNAUTHORIZED",
      detail: "Missing token",
    });
    expect(calls).toHaveLength(0);
  });

  it("answers CORS preflights when cors is configured, and sends no CORS headers otherwise", async () => {
    const withCors = mounted(api({ cors: { origin: ["https://ui.example"] } }));
    const preflight = await withCors.fetch("/admin/jobs/meta", {
      method: "OPTIONS",
      headers: {
        origin: "https://ui.example",
        "access-control-request-method": "GET",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://ui.example",
    );

    const without = await mounted(api()).fetch("/admin/jobs/meta", {
      headers: { origin: "https://ui.example" },
    });
    expect(without.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses two routes on one path, or two with one operation id", () => {
    const route = () =>
      defineRoute({
        method: "GET",
        path: "/dup",
        operationId: "dup",
        action: "jobs.read",
        mode: "any",
        summary: "x",
        tags: [],
        responses: { 200: s.object({}) },
        handler: () => ({ body: {} }),
      });
    expect(() => api({}, [route(), route()])).toThrow(ConfigError);
    expect(() => api({}, [route(), { ...route(), path: "/other" }])).toThrow(
      /operation id "dup"/,
    );
    expect(() =>
      api({}, [route(), { ...route(), operationId: "other" }]),
    ).toThrow(/GET \/dup/);
  });
});

describe("pruning", () => {
  /** Operation ids an API registered. */
  const ids = (target: JobsApi) =>
    target.routes.map((route) => route.operationId);

  it("routes one half only in a single mode, and 404s the other", async () => {
    const jobsOnly = api({ mode: "jobs" });
    expect(ids(jobsOnly)).toContain("retryItem");
    expect(ids(jobsOnly)).not.toContain("getRunnerThing");
    expect(
      await (
        await mounted(jobsOnly).fetch("/admin/jobs/runners/r/thing")
      ).json(),
    ).toMatchObject({ code: "ROUTE_NOT_FOUND" });
    expect(Object.keys(jobsOnly.openapi().paths as object)).not.toContain(
      "/runners/{runner}/thing",
    );

    const runnerOnly = api({ mode: "runner" });
    expect(ids(runnerOnly)).toContain("getRunnerThing");
    expect(ids(runnerOnly)).not.toContain("retryItem");
    expect(
      (await mounted(runnerOnly).fetch("/admin/jobs/runners/r/thing")).status,
    ).toBe(200);

    const both = api();
    expect(ids(both)).toEqual(
      expect.arrayContaining(["retryItem", "getRunnerThing"]),
    );
  });

  it("registers no mutating route under readOnly", async () => {
    const readOnly = api({ readOnly: true });
    expect(readOnly.routes.some((route) => route.mutation)).toBe(false);
    const response = await post(
      mounted(readOnly),
      "/admin/jobs/queues/mail/items/1/retry",
      { ids: ["a"] },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ROUTE_NOT_FOUND" });
    expect(api().routes.some((route) => route.mutation)).toBe(true);
  });

  it("prunes by actions, leaving opt-in actions out by default", () => {
    expect(ids(api())).not.toContain("addTest");
    expect(ids(api({ actions: ["jobs.add"] }))).toEqual(["addJob", "addTest"]);
    expect(ids(api({ actions: ["meta.read"] }))).toEqual([
      "getMeta",
      "getPermissions",
    ]);
  });

  it("prunes a route whose driver lacks a required method, and /meta says why", async () => {
    const driver = new MemoryDriver();
    const full = api({ jobs: jobsContext("api-routes", driver) });
    expect(ids(full)).toContain("getLogsTest");

    const lacking = new MemoryDriver();
    Object.defineProperty(lacking, "getJobLogs", { value: undefined });
    const pruned = api({ jobs: jobsContext("api-routes", lacking) });
    expect(ids(pruned)).not.toContain("getLogsTest");
    const meta = (await (
      await mounted(pruned).fetch("/admin/jobs/meta")
    ).json()) as {
      features: { logs: boolean };
    };
    expect(meta.features.logs).toBe(false);
  });

  it("prunes routes needing a jobs source when there is none, and docs routes with docs: false", () => {
    const queue = new BunQueue("mail", {
      namespace: "api-routes",
      driver: new MemoryDriver(),
    });
    const direct = api({ jobs: undefined, queues: [queue] });
    expect(ids(direct)).not.toContain("listDefinitionsTest");
    expect(ids(api())).toContain("listDefinitionsTest");

    const noDocs = api({ docs: false });
    expect(ids(noDocs)).not.toContain("getOpenApiDocument");
    // The document itself is still available to the host.
    expect(noDocs.openapi().openapi).toBe("3.1.0");
  });

  it("applies every condition in the one predicate", () => {
    const config = resolveConfig(apiConfig({ mode: "jobs", readOnly: true }));
    const [retry, runner, logs] = testRoutes();
    expect(isRouteEnabled(retry!, config)).toBe(false);
    expect(isRouteEnabled(runner!, config)).toBe(false);
    expect(isRouteEnabled(logs!, config)).toBe(true);
    expect(isRouteEnabled({ ...logs!, enabledWhen: () => false }, config)).toBe(
      false,
    );
  });
});

describe("GET /meta", () => {
  it("describes the API and its backend, matching the Meta schema", async () => {
    const jobs = jobsContext();
    // Socket off: what `/meta` says about a socket is the WebSocket unit's to pin.
    const response = await mounted(api({ jobs, websocket: false })).fetch(
      "/admin/jobs/meta",
    );
    const body = await response.json();
    expect(MetaSchema["~standard"].validate(body)).not.toHaveProperty("issues");
    expect(body).toEqual({
      namespace: "api-routes",
      mode: "both",
      readOnly: false,
      protocol: 1,
      driver: {
        name: jobs.driver.name,
        capabilities: jobs.driver.capabilities,
      },
      features: probeFeatures(jobs.driver),
      events: jobs.driver.capabilities.events,
      publishing: null,
      websocket: null,
      docs: { openapi: "/admin/jobs/openapi.json" },
      csrf: { header: null, requireJson: true },
      limits: {
        defaultPageSize: 20,
        maxPageSize: 100,
        maxBulkIds: 1000,
        maxRetryAll: 10_000,
        maxClean: 10_000,
        maxLogPage: 500,
        maxHistory: 200,
        maxJobDataBytes: 1_048_576,
        maxQueues: 500,
      },
      // `jobs.add` is opt-in and not enabled here: nothing can be added.
      addableNames: [],
      runnerTriggerArgs: false,
    });
    expect(JSON.stringify(body)).not.toContain("url");
  });

  it("reports no docs when they are off or docs.read is not allowed", async () => {
    for (const overrides of [
      { docs: false as const },
      { actions: ["meta.read" as const] },
    ]) {
      const body = (await (
        await mounted(api(overrides)).fetch("/admin/jobs/meta")
      ).json()) as {
        docs: unknown;
      };
      expect(body.docs).toBeNull();
    }
  });
});

describe("GET /meta/permissions", () => {
  it("asks authorize once per registered action, with the queue or runner it concerns", async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    const created = api({
      authorize: (_req, context) => {
        calls.push(context);
        return !context.mutation;
      },
    });
    const root = mounted(created);
    const response = await root.fetch(
      "/admin/jobs/meta/permissions?queue=mail&runner=nightly",
    );
    expect(response.status).toBe(200);
    const { actions } = (await response.json()) as {
      actions: Record<string, boolean>;
    };

    // Exactly the actions of the routes this API registered, plus the socket's.
    const expected = new Set([
      ...created.routes.map((route) => route.action),
      "events.connect",
      "events.subscribe",
    ]);
    expect(new Set(Object.keys(actions))).toEqual(expected);
    expect(actions["jobs.read"]).toBe(true);
    expect(actions["jobs.retry"]).toBe(false);
    // Opt-in actions are not registered, so they are not reported or asked.
    expect(actions).not.toHaveProperty("jobs.add");
    expect(calls.some((call) => call.action === "jobs.add")).toBe(false);

    const evaluated = calls.filter((call) => call.route === undefined);
    expect(evaluated).toHaveLength(expected.size);
    expect(evaluated.find((call) => call.action === "jobs.read")).toEqual({
      action: "jobs.read",
      mutation: false,
      transport: "http",
      queue: "mail",
    });
    expect(evaluated.find((call) => call.action === "runners.trigger")).toEqual(
      {
        action: "runners.trigger",
        mutation: true,
        transport: "http",
        runner: "nightly",
      },
    );
    expect(evaluated.find((call) => call.action === "meta.read")).toEqual({
      action: "meta.read",
      mutation: false,
      transport: "http",
    });
  });

  it("covers only what is routed: no other half, and no mutation under readOnly", async () => {
    const created = api({ mode: "jobs", readOnly: true });
    const root = mounted(created);
    const { actions } = (await (
      await root.fetch("/admin/jobs/meta/permissions")
    ).json()) as { actions: Record<string, boolean> };
    expect(
      Object.keys(actions).some((action) => action.startsWith("runners.")),
    ).toBe(false);
    // Mutating routes are not registered under readOnly, so they are absent
    // rather than reported as false.
    expect(actions).not.toHaveProperty("jobs.remove");
    expect(actions["jobs.list"]).toBe(true);
    expect(new Set(Object.keys(actions))).toEqual(
      new Set([
        ...created.routes.map((route) => route.action),
        "events.connect",
        "events.subscribe",
      ]),
    );
  });

  it("validates the queue and runner it is asked about", async () => {
    const response = await mounted(api()).fetch(
      "/admin/jobs/meta/permissions?queue=a/b",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION",
      issues: [{ target: "query", path: "queue" }],
    });
  });
});

describe("GET /openapi.json", () => {
  it("serves the document, and openapi() returns a fresh copy each time", async () => {
    const created = api();
    const served = await (
      await mounted(created).fetch("/admin/jobs/openapi.json")
    ).json();
    expect(served).toEqual(created.openapi());

    const first = created.openapi();
    (first.info as { title: string }).title = "changed";
    expect((created.openapi().info as { title: string }).title).not.toBe(
      "changed",
    );
  });

  it("follows docs.openapiPath", async () => {
    const created = api({ docs: { openapiPath: "/spec.json" } });
    expect(created.routes.map((route) => route.path)).toContain(
      "/admin/jobs/spec.json",
    );
    expect((await mounted(created).fetch("/admin/jobs/spec.json")).status).toBe(
      200,
    );
  });
});
