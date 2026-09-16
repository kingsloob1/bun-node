import type { BunRequest } from "@kingsleyweb/bun-common";
import type {
  JobsApiAuthorize,
  JobsApiAuthorizeContext,
  JobsApiConfig,
  ResolvedJobsApiConfig,
} from "../../lib/api/config";
import { BunRouter, createTestLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  authorizeHandler,
  canonicalOrigin,
  checkCsrf,
  csrfGuard,
  csrfInfo,
  decide,
  isSameOrigin,
  normalizeAuthorizeResult,
  originAllowed,
  originGuard,
} from "../../lib/api/auth";
import {
  DEFAULT_JOBS_API_LIMITS,
  isAddableName,
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
  JOBS_API_OPT_IN_ACTIONS,
  resolveConfig,
} from "../../lib/api/config";
import {
  buildJobsApi,
  builtInRoutes,
  createJobsApi,
} from "../../lib/api/createJobsApi";
import {
  createApiErrorHandler,
  createNotFoundHandler,
} from "../../lib/api/errors";
import { BunJobs, BunQueue, ConfigError, MemoryDriver } from "../../lib/index";
import { testRoutes } from "./fixtures";

/*
 * The route-level authorization table is at the end of this file ("route-level
 * authorization"). It covers the routes that exist: `/meta`,
 * `/meta/permissions` and `/openapi.json`, plus the synthetic mutating and
 * opt-in routes from `fixtures.ts`. Each later unit's routes join it through
 * `api.routes` without changing the test.
 */

describe("route-level authorization", () => {
  /**
   * Mounts an API over seeded data — queue `mail` with job `7`, local runner
   * `nightly`, a `send` definition — and records every authorize call.
   */
  async function setup(
    overrides: Partial<JobsApiConfig> = {},
    answer: (context: JobsApiAuthorizeContext) => unknown = () => true,
  ) {
    const calls: JobsApiAuthorizeContext[] = [];
    const jobs = jobsContext();
    await jobs.queue("mail").add("send", { to: "a" }, { jobId: "7" });
    jobs.runner({
      id: "nightly",
      file: new URL("../fixtures/handlers/echo.ts", import.meta.url),
      executionMode: "in-process",
    });
    jobs.define("send", async () => {});
    const config = resolveConfig({
      jobs,
      basePath: "/admin/jobs",
      logger: createTestLogger().logger,
      limits: { queueCacheMs: 0 },
      authorize: (_req, context) => {
        calls.push(context);
        return answer(context) as boolean;
      },
      ...overrides,
    });
    const api = buildJobsApi(config, [
      ...builtInRoutes(config),
      ...testRoutes(),
    ]);
    const root = new BunRouter();
    root.use(api.basePath, api.router);
    return { api, root, calls };
  }

  /** Bodies that pass validation, by operation id; every other route needs none. */
  const BODIES: Record<string, unknown> = {
    retryItem: { ids: ["a"] },
    lookupJobs: { ids: ["7"] },
    retryJobs: { ids: ["7"] },
    removeJobs: { ids: ["7"] },
    promoteJobs: { ids: ["7"] },
    cleanQueue: { state: "completed", olderThan: 0 },
    setQueueLimits: { concurrency: 2 },
    retryAllJobs: { state: "dead" },
    addJob: { name: "send", data: {} },
    updateJob: { priority: 1 },
    rescheduleRunner: { schedule: null },
  };

  /** Operation ids whose authorize target carries the bulk ids. */
  const BULK = new Set([
    "lookupJobs",
    "retryJobs",
    "removeJobs",
    "promoteJobs",
  ]);

  /** A request that passes every check but authorization, for any registered route. */
  function requestFor(route: {
    method: string;
    path: string;
    operationId: string;
  }): [string, RequestInit] {
    const path = route.path
      .replace(":queue", "mail")
      .replace(":id", "7")
      .replace(":runner", "nightly")
      .replace(":key", "k");
    if (route.method === "GET") {
      return [path, { method: "GET" }];
    }
    const body = BODIES[route.operationId];
    return [
      path,
      {
        method: route.method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ];
  }

  /** The authorize target a route should report, from its path. */
  function expectedTarget(route: {
    path: string;
    operationId: string;
  }): Record<string, unknown> {
    const target: Record<string, unknown> = {};
    if (route.path.includes(":queue")) {
      target.queue = "mail";
    }
    if (route.path.includes(":runner")) {
      target.runner = "nightly";
    }
    if (route.path.includes(":id") && route.operationId !== "retryItem") {
      target.jobId = "7";
    }
    if (BULK.has(route.operationId)) {
      target.jobIds = ["7"];
    }
    if (route.operationId === "retryItem") {
      target.jobIds = ["a"];
    }
    return target;
  }

  it("asks authorize exactly once per route, with its action, mutation, pattern and target", async () => {
    const { api, root, calls } = await setup({
      actions: [...JOBS_API_ACTIONS],
    });
    expect(api.routes.length).toBeGreaterThan(30);
    for (const route of api.routes) {
      calls.length = 0;
      const response = await root.fetch(...requestFor(route));
      expect({ route: route.operationId, status: response.status }).toEqual({
        route: route.operationId,
        status: expect.any(Number),
      });
      // Past authorization: a 404 for data an earlier route removed is fine.
      expect([401, 403, 500]).not.toContain(response.status);
      // `/meta/permissions` also evaluates every action, without a route.
      const own = calls.filter((call) => call.route !== undefined);
      expect({ route: route.operationId, calls: own.length }).toEqual({
        route: route.operationId,
        calls: 1,
      });
      expect(own[0]).toEqual({
        action: route.action,
        mutation: route.mutation,
        transport: "http",
        route: {
          method: route.method,
          path: route.path.slice("/admin/jobs".length),
        },
        ...expectedTarget(route),
      });
    }
  });

  it("answers every route with the denial's status", async () => {
    for (const status of [401, 403] as const) {
      const { api, root } = await setup(
        { actions: [...JOBS_API_ACTIONS] },
        () => ({ allow: false, status }),
      );
      for (const route of api.routes) {
        const response = await root.fetch(...requestFor(route));
        expect({ route: route.operationId, status: response.status }).toEqual({
          route: route.operationId,
          status,
        });
      }
    }
  });

  it("registers no mutating route under readOnly, answering 404", async () => {
    const all = (await setup({ actions: [...JOBS_API_ACTIONS] })).api.routes;
    const mutating = all.filter((route) => route.mutation);
    expect(mutating.length).toBeGreaterThan(0);

    const { api, root, calls } = await setup({
      readOnly: true,
      actions: [...JOBS_API_ACTIONS],
    });
    expect(api.routes.filter((route) => route.mutation)).toEqual([]);
    for (const route of mutating) {
      const response = await root.fetch(...requestFor(route));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "ROUTE_NOT_FOUND" });
    }
    expect(calls).toHaveLength(0);
  });

  it("prunes by actions, with opt-in actions absent unless listed", async () => {
    const ids = (routes: readonly { operationId: string }[]) =>
      routes.map((route) => route.operationId);
    const byDefault = ids((await setup()).api.routes);
    expect(byDefault).not.toContain("addTest");
    expect(byDefault).not.toContain("addJob");
    expect(byDefault).not.toContain("updateJob");
    expect(
      ids((await setup({ actions: ["jobs.add", "meta.read"] })).api.routes),
    ).toEqual(["getMeta", "getPermissions", "addJob", "addTest"]);
  });

  it("runs middleware before authorize, mapping a thrown { status: 401 }", async () => {
    const { api, root, calls } = await setup({
      middleware: [
        () => {
          throw Object.assign(new Error("No session"), { status: 401 });
        },
      ],
    });
    for (const route of api.routes) {
      const response = await root.fetch(...requestFor(route));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: "UNAUTHORIZED",
        detail: "No session",
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("fails closed at construction through createJobsApi too", () => {
    expect(() =>
      createJobsApi({ jobs: jobsContext(), basePath: "/admin/jobs" }),
    ).toThrow(ConfigError);
  });
});

const allow: JobsApiAuthorize = () => true;

/** A context over the memory driver, in its own namespace. */
function jobsContext(namespace = "api-auth") {
  return new BunJobs({ namespace, driver: new MemoryDriver() });
}

/** Resolves a configuration with sensible required fields filled in. */
function resolve(
  overrides: Partial<JobsApiConfig> = {},
): ResolvedJobsApiConfig {
  return resolveConfig({
    jobs: jobsContext(),
    basePath: "/admin/jobs",
    authorize: allow,
    logger: createTestLogger().logger,
    ...overrides,
  });
}

/** Expects `fn` to throw a ConfigError whose message matches. */
function expectConfigError(fn: () => unknown, message: RegExp) {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toMatch(message);
}

describe("resolveConfig: construction", () => {
  it("throws without authorize unless allowUnauthenticated is set", () => {
    expectConfigError(
      () => resolveConfig({ jobs: jobsContext(), basePath: "/admin/jobs" }),
      /needs `authorize`/,
    );
    expectConfigError(
      () =>
        resolveConfig({
          jobs: jobsContext(),
          basePath: "/admin/jobs",
          allowUnauthenticated: false,
        }),
      /needs `authorize`/,
    );
    expectConfigError(
      () => resolve({ authorize: "yes" as unknown as JobsApiAuthorize }),
      /authorize must be a function/,
    );
  });

  it("warns on every construction with allowUnauthenticated, and not with authorize", () => {
    const { logger, events } = createTestLogger();
    const open = resolveConfig({
      jobs: jobsContext(),
      basePath: "/admin/jobs",
      allowUnauthenticated: true,
      logger,
    });
    expect(open.allowUnauthenticated).toBe(true);
    expect(open.authorize).toBeUndefined();
    resolveConfig({
      jobs: jobsContext(),
      basePath: "/admin/jobs",
      allowUnauthenticated: true,
      logger,
    });
    const warnings = events.filter((event) => event.level === "warn");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.message).toMatch(/unauthenticated/);

    const quiet = createTestLogger();
    const guarded = resolveConfig({
      jobs: jobsContext(),
      basePath: "/admin/jobs",
      authorize: allow,
      allowUnauthenticated: true,
      logger: quiet.logger,
    });
    // `authorize` wins, and nothing is logged about being open.
    expect(guarded.allowUnauthenticated).toBe(false);
    expect(quiet.events.filter((event) => event.level === "warn")).toHaveLength(
      0,
    );
  });

  it("requires a source, and names only with jobs", () => {
    expectConfigError(
      () => resolveConfig({ basePath: "/a", authorize: allow }),
      /needs `jobs`/,
    );
    expectConfigError(
      () => resolveConfig({ basePath: "/a", authorize: allow, queues: "all" }),
      /"all" needs `jobs`/,
    );
    expectConfigError(
      () =>
        resolveConfig({ basePath: "/a", authorize: allow, queues: ["mail"] }),
      /without `jobs`/,
    );
    expectConfigError(
      () => resolve({ queues: ["bad name"] }),
      /may only contain/,
    );

    const driver = new MemoryDriver();
    const queue = new BunQueue("mail", { namespace: "direct", driver });
    const direct = resolveConfig({
      basePath: "/a",
      authorize: allow,
      queues: [queue],
      logger: createTestLogger().logger,
    });
    expect(direct.mode).toBe("jobs");
    expect(direct.namespace).toBe("direct");
    expect(direct.driver).toBe(driver);
    expect(direct.queues).toEqual(new Map([["mail", queue]]));
  });

  it("refuses sources from different namespaces", () => {
    const queue = new BunQueue("mail", {
      namespace: "elsewhere",
      driver: new MemoryDriver(),
    });
    expectConfigError(() => resolve({ queues: [queue] }), /one namespace/);
  });

  it("defaults mode from the sources and refuses a half with none", () => {
    expect(resolve().mode).toBe("both");
    expect(resolve({ runners: false }).mode).toBe("jobs");
    expectConfigError(
      () => resolve({ runners: false, mode: "runner" }),
      /no source/,
    );
    expectConfigError(
      () => resolve({ runners: false, mode: "both" }),
      /no source/,
    );
    expectConfigError(() => resolve({ mode: "all" as never }), /mode must be/);
  });

  it("validates and normalises basePath", () => {
    expect(resolve({ basePath: "/admin/jobs/" }).basePath).toBe("/admin/jobs");
    expectConfigError(() => resolve({ basePath: "admin" }), /absolute path/);
    expectConfigError(() => resolve({ basePath: "/" }), /may not be "\/"/);
    expectConfigError(
      () => resolve({ basePath: "/admin/:tenant" }),
      /segments/,
    );
    expectConfigError(
      () => resolve({ basePath: "/admin/../jobs" }),
      /segments/,
    );
    expectConfigError(() => resolve({ basePath: "/admin jobs" }), /segments/);
  });

  it("rejects unknown actions and applies the opt-in default", () => {
    expectConfigError(
      () =>
        resolve({
          actions: ["jobs.read", "jobs.nuke" as never, "queues.drop" as never],
        }),
      /Unknown action\(s\): jobs\.nuke, queues\.drop/,
    );

    const defaults = resolve();
    for (const action of JOBS_API_ACTIONS) {
      expect(defaults.enabledActions.has(action)).toBe(
        !JOBS_API_OPT_IN_ACTIONS.has(action),
      );
    }
    expect(resolve({ actions: ["jobs.add"] }).enabledActions).toEqual(
      new Set(["jobs.add"]),
    );
  });

  it("readOnly removes every mutation, as a static limit", () => {
    const config = resolve({ readOnly: true, actions: [...JOBS_API_ACTIONS] });
    for (const action of JOBS_API_ACTIONS) {
      expect(config.enabledActions.has(action)).toBe(
        !JOBS_API_MUTATIONS.has(action),
      );
      expect(config.actions.has(action)).toBe(true);
    }
  });

  it("refuses cors with credentials and a wildcard origin", () => {
    for (const origin of [
      undefined,
      "*",
      true,
      ["https://a.example", "*"],
    ] as const) {
      expectConfigError(
        () => resolve({ cors: { credentials: true, origin: origin as never } }),
        /credentials: true needs an explicit origin/,
      );
    }
    expect(
      resolve({
        cors: { credentials: true, origin: ["https://admin.example"] },
      }).cors,
    ).toEqual({
      credentials: true,
      origin: ["https://admin.example"],
    });
    // Without credentials a wildcard is merely public, not dangerous.
    expect(resolve({ cors: { origin: "*" } }).cors).toEqual({ origin: "*" });
    expect(resolve().cors).toBe(false);
  });

  it("normalises limits and refuses unusable ones", () => {
    expect(resolve().limits).toEqual(DEFAULT_JOBS_API_LIMITS);
    expect(
      resolve({ limits: { maxPageSize: 10 } }).limits.defaultPageSize,
    ).toBe(10);
    expect(resolve({ limits: { queueCacheMs: 0 } }).limits.queueCacheMs).toBe(
      0,
    );
    expectConfigError(
      () => resolve({ limits: { maxPageSize: 10, defaultPageSize: 20 } }),
      /may not exceed/,
    );
    expectConfigError(
      () => resolve({ limits: { maxBulkIds: 0 } }),
      /at least 1/,
    );
    expectConfigError(() => resolve({ limits: { maxClean: 1.5 } }), /integer/);
  });

  it("defaults csrf, docs, websocket and serializers", () => {
    const config = resolve();
    expect(config.csrf).toEqual({
      requireJson: true,
      header: false,
      allowedOrigins: [],
    });
    expect(resolve({ csrf: { header: "X-Bun-Jobs-CSRF" } }).csrf).toMatchObject(
      {
        header: "x-bun-jobs-csrf",
      },
    );
    expectConfigError(
      () => resolve({ csrf: { header: "bad header" } }),
      /valid header name/,
    );
    expect(resolve({ csrf: false }).csrf).toBe(false);

    expect(config.docs).toMatchObject({
      openapiPath: "/openapi.json",
      ui: false,
      uiPath: "/docs",
    });
    expect(config.websocket).toMatchObject({
      path: "/ws",
      heartbeatMs: 25_000,
      allowedOrigins: [],
    });
    expect(resolve({ websocket: false, docs: false })).toMatchObject({
      websocket: false,
      docs: false,
    });
    expectConfigError(
      () => resolve({ websocket: { path: "ws" } }),
      /absolute path/,
    );

    expect(config.serialize).toMatchObject({
      exposeStacks: false,
      exposeRunnerFiles: false,
      exposeHosts: true,
    });
    expect(config.runnerTriggerArgs).toBe(false);
    expect(config.validateResponses).toBe(false);
  });

  it("resolves addable names from definitions at request time", () => {
    const jobs = jobsContext();
    const config = resolve({ jobs });
    expect(config.addableNames).toBe("defined");
    expect(isAddableName(config, "send-email")).toBe(false);
    jobs.define("send-email", async () => {});
    expect(isAddableName(config, "send-email")).toBe(true);

    expect(isAddableName(resolve({ addableNames: "any" }), "anything")).toBe(
      true,
    );
    expect(isAddableName(resolve({ addableNames: ["a"] }), "b")).toBe(false);
  });
});

describe("authorize normalisation", () => {
  it("maps every answer shape, failing closed on anything else", () => {
    expect(normalizeAuthorizeResult(true)).toEqual({ allow: true });
    expect(normalizeAuthorizeResult({ allow: true })).toEqual({ allow: true });
    expect(normalizeAuthorizeResult(false)).toEqual({
      allow: false,
      status: 403,
    });
    expect(normalizeAuthorizeResult({ allow: false })).toEqual({
      allow: false,
      status: 403,
    });
    expect(
      normalizeAuthorizeResult({ allow: false, status: 401, reason: "log in" }),
    ).toEqual({
      allow: false,
      status: 401,
      reason: "log in",
    });
    expect(normalizeAuthorizeResult({ allow: false, status: 500 })).toEqual({
      allow: false,
      status: 403,
    });
    for (const malformed of [
      undefined,
      null,
      "yes",
      1,
      {},
      { allow: "true" },
    ]) {
      expect(normalizeAuthorizeResult(malformed)).toEqual({
        allow: false,
        status: 403,
      });
    }
  });
});

describe("decide", () => {
  const req = {} as BunRequest;

  it("applies static limits before asking authorize", async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    const config = resolve({
      readOnly: true,
      authorize: (_req, context) => {
        calls.push(context);
        return true;
      },
    });
    expect(
      await decide(config, req, { action: "jobs.retry", transport: "http" }),
    ).toMatchObject({
      allow: false,
      status: 403,
      static: true,
    });
    expect(
      await decide(config, req, { action: "jobs.add", transport: "http" }),
    ).toMatchObject({
      static: true,
    });
    expect(calls).toHaveLength(0);

    expect(
      await decide(config, req, {
        action: "jobs.read",
        transport: "http",
        queue: "mail",
      }),
    ).toEqual({
      allow: true,
    });
    expect(calls).toEqual([
      {
        action: "jobs.read",
        mutation: false,
        transport: "http",
        queue: "mail",
      },
    ]);
  });

  it("derives mutation and hands authorize a frozen copy of the ids", async () => {
    let seen: JobsApiAuthorizeContext | undefined;
    const config = resolve({
      authorize: (_req, context) => {
        seen = context;
        return { allow: false, status: 401 };
      },
    });
    const ids = ["1", "2"];
    const decision = await decide(config, req, {
      action: "jobs.retry",
      transport: "ws",
      jobIds: ids,
      mutation: false,
    } as never);
    expect(decision).toEqual({ allow: false, status: 401 });
    expect(seen!.mutation).toBe(true);
    expect(seen!.jobIds).toEqual(ids);
    expect(seen!.jobIds).not.toBe(ids);
    expect(Object.isFrozen(seen!.jobIds)).toBe(true);
  });

  it("allows everything enabled under allowUnauthenticated", async () => {
    const config = resolveConfig({
      jobs: jobsContext(),
      basePath: "/a",
      allowUnauthenticated: true,
      logger: createTestLogger().logger,
    });
    expect(
      await decide(config, req, { action: "jobs.remove", transport: "http" }),
    ).toEqual({ allow: true });
    expect(
      (await decide(config, req, { action: "jobs.add", transport: "http" }))
        .allow,
    ).toBe(false);
  });
});

describe("authorizeHandler through router.fetch", () => {
  /** A router with one authorized route. */
  function router(authorize: JobsApiAuthorize) {
    const config = resolve({ authorize });
    const r = new BunRouter();
    r.post(
      "/queues/:queue/jobs/retry",
      authorizeHandler(config, "jobs.retry", {
        route: { method: "POST", path: "/queues/:queue/jobs/retry" },
        target: (req) => ({ queue: req.params.queue, jobIds: ["a"] }),
      }),
      (_req, res) => res.json({ ok: true }),
    );
    r.use(createNotFoundHandler());
    r.use(createApiErrorHandler({ logger: createTestLogger().logger }));
    return r;
  }

  const post = (r: BunRouter) =>
    r.fetch("/queues/mail/jobs/retry", { method: "POST" });

  it("runs the route when allowed, with the full context", async () => {
    let seen: JobsApiAuthorizeContext | undefined;
    const response = await post(
      router((_req, context) => {
        seen = context;
        return { allow: true };
      }),
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual({
      action: "jobs.retry",
      mutation: true,
      transport: "http",
      queue: "mail",
      jobIds: ["a"],
      route: { method: "POST", path: "/queues/:queue/jobs/retry" },
    });
  });

  it("answers a denial with 403 FORBIDDEN, or 401 with the given reason", async () => {
    const forbidden = await post(router(() => false));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });

    const unauthenticated = await post(
      router(async () => ({
        allow: false,
        status: 401,
        reason: "Session expired",
      })),
    );
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      code: "UNAUTHORIZED",
      detail: "Session expired",
    });
  });

  it("maps a throwing authorize by its status, and hides a plain failure", async () => {
    const thrown = await post(
      router(() => {
        throw Object.assign(new Error("bad token"), { status: 401 });
      }),
    );
    expect(thrown.status).toBe(401);

    const crashed = await post(
      router(() => {
        throw new Error("database password is hunter2");
      }),
    );
    expect(crashed.status).toBe(500);
    expect(await crashed.text()).not.toContain("hunter2");
  });
});

describe("origin checks", () => {
  it("canonicalises origins and compares against Host with default ports", () => {
    expect(canonicalOrigin("HTTPS://Admin.Example:443/")).toBe(
      "https://admin.example",
    );
    expect(canonicalOrigin("not a url")).toBeUndefined();
    expect(isSameOrigin("https://a.example", "a.example")).toBe(true);
    expect(isSameOrigin("https://a.example", "a.example:443")).toBe(true);
    expect(isSameOrigin("http://a.example:8080", "a.example:8080")).toBe(true);
    expect(isSameOrigin("http://a.example:8080", "a.example")).toBe(false);
    expect(isSameOrigin("https://evil.example", "a.example")).toBe(false);
    expect(isSameOrigin("null", "a.example")).toBe(false);
    expect(isSameOrigin("https://a.example", null)).toBe(false);
  });

  it("allows no Origin, the same origin, listed origins and patterns", () => {
    expect(originAllowed(null, "a.example", undefined)).toBe(true);
    expect(originAllowed("https://a.example", "a.example", [])).toBe(true);
    expect(originAllowed("https://evil.example", "a.example", [])).toBe(false);
    expect(
      originAllowed("https://ui.example", "a.example", ["https://ui.example/"]),
    ).toBe(true);
    expect(
      originAllowed("https://x.ui.example", "a.example", [
        /^https:\/\/[a-z]+\.ui\.example$/g,
      ]),
    ).toBe(true);
    // A global pattern must not remember where its last match ended.
    expect(
      originAllowed("https://y.ui.example", "a.example", [
        /^https:\/\/[a-z]+\.ui\.example$/g,
      ]),
    ).toBe(true);
    expect(originAllowed("https://anything.example", "a.example", "*")).toBe(
      true,
    );
    expect(originAllowed("null", "a.example", [])).toBe(false);
    expect(originAllowed("null", "a.example", ["null"])).toBe(true);
  });

  it("originGuard refuses with 403 ORIGIN_REJECTED", async () => {
    const r = new BunRouter();
    r.get("/ws", originGuard(["https://ui.example"]), (_req, res) => {
      return res.json({ ok: true });
    });
    r.use(createApiErrorHandler({ logger: createTestLogger().logger }));

    const refused = await r.fetch("/ws", {
      headers: { origin: "https://evil.example" },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "ORIGIN_REJECTED" });

    expect(
      (await r.fetch("/ws", { headers: { origin: "https://ui.example" } }))
        .status,
    ).toBe(200);
    expect(
      (await r.fetch("/ws", { headers: { origin: "http://localhost" } }))
        .status,
    ).toBe(200);
    expect((await r.fetch("/ws")).status).toBe(200);
  });
});

describe("CSRF guard through router.fetch", () => {
  /** A router with the guard on POST, PATCH and DELETE routes. */
  function router(csrf: JobsApiConfig["csrf"]) {
    const config = resolve({ csrf });
    const r = new BunRouter();
    const ok = (
      _req: BunRequest,
      res: { json: (body: Record<string, unknown>) => unknown },
    ) => res.json({ ok: true });
    r.post("/m", csrfGuard(config.csrf), ok);
    r.patch("/m", csrfGuard(config.csrf), ok);
    r.delete("/m", csrfGuard(config.csrf), ok);
    r.use(createApiErrorHandler({ logger: createTestLogger().logger }));
    return r;
  }

  const json = { "content-type": "application/json" };

  it("accepts a same-origin JSON mutation, and a bodiless DELETE", async () => {
    const r = router(undefined);
    const response = await r.fetch("/m", {
      method: "POST",
      headers: {
        ...json,
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(
      (
        await r.fetch("/m", {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
        })
      ).status,
    ).toBe(200);
    expect((await r.fetch("/m", { method: "DELETE" })).status).toBe(200);
  });

  it("answers a non-JSON POST, even without a body, with 415", async () => {
    const r = router(undefined);
    for (const init of [
      { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" },
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1",
      },
      { method: "POST" },
      {
        method: "PATCH",
        headers: { "content-type": "text/plain" },
        body: "{}",
      },
    ]) {
      const response = await r.fetch("/m", init);
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({
        code: "UNSUPPORTED_MEDIA_TYPE",
      });
    }
  });

  it("refuses cross-site mutations by Sec-Fetch-Site or Origin with 403", async () => {
    const r = router(undefined);
    const crossSite = await r.fetch("/m", {
      method: "POST",
      headers: { ...json, "sec-fetch-site": "cross-site" },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ code: "CSRF_REJECTED" });

    const foreign = await r.fetch("/m", {
      method: "DELETE",
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ code: "CSRF_REJECTED" });
  });

  it("lets a listed origin through both checks", async () => {
    const r = router({ allowedOrigins: ["https://ui.example"] });
    const response = await r.fetch("/m", {
      method: "POST",
      headers: {
        ...json,
        origin: "https://ui.example",
        "sec-fetch-site": "cross-site",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
  });

  it("requires the configured header", async () => {
    const r = router({ header: "X-Bun-Jobs-CSRF" });
    const missing = await r.fetch("/m", {
      method: "POST",
      headers: json,
      body: "{}",
    });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({
      code: "CSRF_REJECTED",
      context: { header: "x-bun-jobs-csrf" },
    });
    const present = await r.fetch("/m", {
      method: "POST",
      headers: { ...json, "x-bun-jobs-csrf": "1" },
      body: "{}",
    });
    expect(present.status).toBe(200);
  });

  it("does nothing when disabled", async () => {
    const r = router(false);
    const response = await r.fetch("/m", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
  });

  it("reads the same fields from a native Request, for WebSocket reuse", () => {
    const request = new Request("http://admin.example/m", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "content-length": "2",
        origin: "http://admin.example",
      },
      body: "{}",
    });
    const info = csrfInfo(request);
    expect(info).toMatchObject({
      method: "POST",
      contentType: "text/plain",
      hasBody: true,
      origin: "http://admin.example",
      host: "admin.example",
    });
    expect(
      checkCsrf(info, { requireJson: true, header: false, allowedOrigins: [] })
        ?.code,
    ).toBe("UNSUPPORTED_MEDIA_TYPE");
  });
});
