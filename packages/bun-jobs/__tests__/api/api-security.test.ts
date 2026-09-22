import type { BunRequest } from "@kingsleyweb/bun-common";
import type {
  JobsApiAuthorizeContext,
  JobsApiConfig,
} from "../../lib/api/config";
import type { ApiError } from "../../lib/api/errors";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  checkCsrf,
  csrfInfo,
  decide,
  isSameOrigin,
  originAllowed,
  originListed,
  pickTarget,
  requestHost,
  requestProtocol,
} from "../../lib/api/auth";
import { declaredBodySizeGuard } from "../../lib/api/body";
import {
  isMutation,
  JOBS_API_ACTIONS,
  resolveConfig,
} from "../../lib/api/config";
import {
  buildJobsApi,
  builtInRoutes,
  createJobsApi,
} from "../../lib/api/createJobsApi";
import { toProblem } from "../../lib/api/errors";
import { defineRoute } from "../../lib/api/routes/define";
import { s } from "../../lib/api/schema/builder";
import {
  ConfigError,
  LockLostError,
  LockUnavailableError,
  MemoryDriver,
  RunnerStoppedError,
} from "../../lib/index";
import {
  apiConfig,
  ECHO_HANDLER,
  harness,
  jobsContext,
  openContexts,
  openHarnesses,
} from "./fixtures";

/**
 * What the API tells a caller it has not authorized yet, and what it never
 * tells anyone.
 *
 * The rule the pre-authorization tests hold: `authorize` is asked exactly once
 * per request. When a check fails it is asked with the target the **path**
 * names (without one when the path itself is invalid), and only a caller it
 * allows learns what was wrong with the request.
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

describe("failures before authorization", () => {
  /** A harness over `mail` with one job, recording every authorize context. */
  async function setup(allow: boolean, overrides: Partial<JobsApiConfig> = {}) {
    const calls: JobsApiAuthorizeContext[] = [];
    const jobs = jobsContext();
    await jobs.queue("mail").add("send", {}, { jobId: "a" });
    const h = harness({
      jobs,
      authorize: (_req, context) => {
        calls.push(context);
        return allow ? true : { allow: false, status: 403 };
      },
      ...overrides,
    });
    return { ...h, calls };
  }

  /**
   * The requests a caller can use to probe a route before being authorized.
   * A mutation, so the CSRF check runs too.
   */
  const probes = [
    {
      name: "a non-JSON mutation",
      path: "/queues/mail/jobs/retry",
      body: "ids=a",
      headers: { "content-type": "text/plain" },
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
      target: { queue: "mail" },
    },
    {
      name: "a malformed JSON body",
      path: "/queues/mail/jobs/retry",
      body: '{"ids": [',
      code: "INVALID_JSON",
      status: 400,
      target: { queue: "mail" },
    },
    {
      name: "a body of the wrong shape",
      path: "/queues/mail/jobs/retry",
      body: { ids: "not-an-array" },
      code: "VALIDATION",
      status: 400,
      target: { queue: "mail" },
    },
    {
      name: "an unusable queue name",
      path: "/queues/a%20b/jobs/retry",
      body: { ids: ["a"] },
      code: "INVALID_NAME",
      status: 400,
      target: {},
    },
  ] as const;

  it("answers each one only to a caller authorize allows, asking it once with the path's target", async () => {
    for (const probe of probes) {
      const h = await setup(true);
      const response = await h.call("POST", probe.path, probe.body, {
        ...("headers" in probe ? probe.headers : {}),
      });
      expect({ probe: probe.name, status: response.status }).toEqual({
        probe: probe.name,
        status: probe.status,
      });
      expect(response.body).toMatchObject({ code: probe.code });
      // Asked once, and told nothing about what the request named.
      expect({ probe: probe.name, calls: h.calls.length }).toEqual({
        probe: probe.name,
        calls: 1,
      });
      // The path's target, never the body's: no `jobIds` from a body that
      // failed, and nothing at all from a path that did.
      expect({ probe: probe.name, context: h.calls[0] }).toEqual({
        probe: probe.name,
        context: {
          action: "jobs.retry",
          mutation: true,
          transport: "http",
          route: { method: "POST", path: "/queues/:queue/jobs/retry" },
          ...probe.target,
        },
      });
    }
  });

  it("answers a caller it denies with the denial, telling it nothing else", async () => {
    for (const probe of probes) {
      const h = await setup(false);
      const response = await h.call("POST", probe.path, probe.body, {
        ...("headers" in probe ? probe.headers : {}),
      });
      expect({ probe: probe.name, status: response.status }).toEqual({
        probe: probe.name,
        status: 403,
      });
      expect(response.body).toMatchObject({ code: "FORBIDDEN" });
      expect(response.text).not.toContain(probe.code);
      expect(h.calls).toHaveLength(1);
    }
  });

  it("caps a bulk list before authorize sees it, and denies without naming the cap", async () => {
    const overrides = { limits: { queueCacheMs: 0, maxBulkIds: 1 } };
    const allowed = await setup(true, overrides);
    const over = await allowed.call("POST", "/queues/mail/jobs/lookup", {
      ids: ["a", "b"],
    });
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({
      code: "BULK_LIMIT",
      context: { max: 1 },
    });
    expect(allowed.calls[0]).not.toHaveProperty("jobIds");
    // The ids are not the path's, but the queue is.
    expect(allowed.calls[0]).toMatchObject({ queue: "mail" });

    const denied = await setup(false, overrides);
    const refused = await denied.call("POST", "/queues/mail/jobs/lookup", {
      ids: ["a", "b"],
    });
    expect(refused.status).toBe(403);
    expect(refused.text).not.toContain("BULK_LIMIT");
  });

  it("still authorizes a good request with its target", async () => {
    const h = await setup(true);
    const response = await h.call("POST", "/queues/mail/jobs/lookup", {
      ids: ["a"],
    });
    expect(response.status).toBe(200);
    expect(h.calls[0]).toEqual({
      action: "jobs.read",
      mutation: false,
      transport: "http",
      queue: "mail",
      jobIds: ["a"],
      route: { method: "POST", path: "/queues/:queue/jobs/lookup" },
    });
  });

  it("refuses an oversized declared body before authorize, and a lying one after it", async () => {
    // The declared check is a router handler of its own: the only answer given
    // before `authorize`, so a caller cannot make the process buffer a body.
    const guard = declaredBodySizeGuard(10);
    const refusals: unknown[] = [];
    const request = (length: string | null) =>
      ({ getHeader: () => length }) as unknown as BunRequest;
    await guard(request("999"), {} as never, (error?: unknown) => {
      refusals.push(error);
      return undefined;
    });
    await guard(request(null), {} as never, (error?: unknown) => {
      refusals.push(error);
      return undefined;
    });
    expect((refusals[0] as ApiError).code).toBe("PAYLOAD_TOO_LARGE");
    expect((refusals[0] as ApiError).context).toEqual({ limit: 10 });
    expect(refusals[1]).toBeUndefined();

    // A body whose size only shows once read is refused after authorization:
    // a denied caller is told 403, not 413.
    const denied = await setup(false, {
      actions: ["jobs.update"],
      limits: { queueCacheMs: 0, maxJobDataBytes: 64 },
    });
    const huge = await denied.call("PATCH", "/queues/mail/jobs/a", {
      data: { blob: "x".repeat(500) },
    });
    expect(huge.status).toBe(403);
  });
});

describe("an invalid query or body is authorized against the path's target", () => {
  /** Three hosts: one allowing everything, and two refusing different things. */
  const policies = {
    /** Allows every request. */
    allowAll: () => true,
    /** Refuses a request that names no queue or runner. */
    refuseUntargeted: (context: JobsApiAuthorizeContext) =>
      context.queue !== undefined || context.runner !== undefined,
    /** Refuses the queue `mail` and the runner `nightly`, and nothing else. */
    refuseThatTarget: (context: JobsApiAuthorizeContext) =>
      context.queue !== "mail" && context.runner !== "nightly",
  } as const;

  /** A mounted API over `mail` (with job `a`) and runner `nightly`, deciding by `policy`. */
  async function setup(policy: (context: JobsApiAuthorizeContext) => boolean) {
    const calls: JobsApiAuthorizeContext[] = [];
    const jobs = jobsContext();
    await jobs.queue("mail").add("send", {}, { jobId: "a" });
    jobs.runner({
      id: "nightly",
      file: ECHO_HANDLER,
      executionMode: "in-process",
    });
    const h = harness({
      jobs,
      mode: "both",
      authorize: (_req, context) => {
        calls.push(context);
        return policy(context) ? true : { allow: false, status: 403 };
      },
    });
    return { ...h, calls };
  }

  /** One route, with a request it accepts and one whose query or body it refuses. */
  interface Case {
    /** What the case exercises. */
    name: string;
    /** The HTTP method. */
    method: string;
    /** Path and query of a request the route accepts. */
    validPath: string;
    /** Path and query of the invalid request; defaults to `validPath`. */
    invalidPath?: string;
    /** Body of the accepted request. */
    valid?: unknown;
    /** Body of the invalid request. */
    invalid?: unknown;
    /** Context fields the accepted request carries that a failed body cannot (a bulk route's ids). */
    bodyOnly?: readonly (keyof JobsApiAuthorizeContext)[];
  }

  const cases: Case[] = [
    {
      name: "fail, empty reason",
      method: "POST",
      validPath: "/queues/mail/jobs/a/fail",
      valid: { reason: "stuck" },
      invalid: { reason: "" },
    },
    {
      name: "fail, reason over 4096 characters",
      method: "POST",
      validPath: "/queues/mail/jobs/a/fail",
      valid: { reason: "stuck" },
      invalid: { reason: "x".repeat(4097) },
    },
    {
      name: "retry",
      method: "POST",
      validPath: "/queues/mail/jobs/a/retry",
      valid: {},
      invalid: { resetAttempts: "maybe" },
    },
    {
      name: "add",
      method: "POST",
      validPath: "/queues/mail/jobs",
      valid: { name: "send", data: {} },
      invalid: { name: "" },
    },
    {
      name: "update",
      method: "PATCH",
      validPath: "/queues/mail/jobs/a",
      valid: { priority: 1 },
      invalid: { priority: "high" },
    },
    {
      name: "a runner route (resume)",
      method: "POST",
      validPath: "/runners/nightly/resume",
      valid: {},
      invalid: { triggerNow: "maybe" },
    },
    {
      name: "a queue route (drain)",
      method: "POST",
      validPath: "/queues/mail/drain",
      valid: {},
      invalid: { delayed: "maybe" },
    },
    {
      name: "a query (list jobs)",
      method: "GET",
      validPath: "/queues/mail/jobs?state=waiting",
      invalidPath: "/queues/mail/jobs?state=nonsense",
    },
    {
      name: "a bulk route (retry many)",
      method: "POST",
      validPath: "/queues/mail/jobs/retry",
      valid: { ids: ["a"] },
      invalid: { ids: "not-an-array" },
      bodyOnly: ["jobIds"],
    },
  ];

  /** The context the accepted request is authorized with, minus what only its body could say. */
  async function successContext(item: Case) {
    const h = await setup(policies.allowAll);
    await h.call(item.method, item.validPath, item.valid);
    expect(h.calls).toHaveLength(1);
    const context: Record<string, unknown> = { ...h.calls[0] };
    for (const key of item.bodyOnly ?? []) {
      expect(context).toHaveProperty(key);
      delete context[key];
    }
    return context;
  }

  /** Sends the invalid request under a policy: the answer and what authorize was asked. */
  async function refuse(
    item: Case,
    policy: (context: JobsApiAuthorizeContext) => boolean,
  ) {
    const h = await setup(policy);
    const response = await h.call(
      item.method,
      item.invalidPath ?? item.validPath,
      item.invalid,
    );
    return { response, calls: h.calls };
  }

  it("asks authorize with the context the accepted request would carry", async () => {
    for (const item of cases) {
      const expected = await successContext(item);
      expect(expected.queue ?? expected.runner).toBeDefined();
      const { response, calls } = await refuse(item, policies.allowAll);
      expect({ case: item.name, status: response.status }).toEqual({
        case: item.name,
        status: 400,
      });
      // Compared as plain records: `expected` lacks what only a body could say.
      const asked: Record<string, unknown>[] = calls.map((call) => ({
        ...call,
      }));
      expect({ case: item.name, calls: asked }).toEqual({
        case: item.name,
        calls: [expected],
      });
    }
  });

  it("allow-all: tells the caller what was wrong", async () => {
    for (const item of cases) {
      const { response } = await refuse(item, policies.allowAll);
      expect({
        case: item.name,
        status: response.status,
        code: response.body?.code,
      }).toEqual({
        case: item.name,
        status: 400,
        code: "VALIDATION",
      });
    }
  });

  it("refusing untargeted requests: still 400, not the untargeted 403", async () => {
    for (const item of cases) {
      const { response } = await refuse(item, policies.refuseUntargeted);
      expect({
        case: item.name,
        status: response.status,
        code: response.body?.code,
      }).toEqual({
        case: item.name,
        status: 400,
        code: "VALIDATION",
      });
    }
  });

  it("refusing that queue or runner: 403, telling it nothing about the schema", async () => {
    for (const item of cases) {
      const { response } = await refuse(item, policies.refuseThatTarget);
      expect({
        case: item.name,
        status: response.status,
        code: response.body?.code,
      }).toEqual({
        case: item.name,
        status: 403,
        code: "FORBIDDEN",
      });
      expect(response.text).not.toContain("VALIDATION");
      expect(response.body).not.toHaveProperty("issues");
    }
  });

  it("every targeted route that reads a body names its target when the body is broken", async () => {
    const probe = await setup(policies.allowAll);
    const registered = new Set(
      probe.api.routes.map((route) => route.operationId),
    );
    const config = resolveConfig(
      apiConfig({
        jobs: probe.jobs,
        mode: "both",
        actions: [...JOBS_API_ACTIONS],
      }),
    );
    const defs = builtInRoutes(config).filter(
      (def) =>
        registered.has(def.operationId) &&
        def.target &&
        (def.body !== undefined || isMutation(def.action)),
    );
    expect(defs.length).toBeGreaterThan(20);
    for (const def of defs) {
      const h = await setup(policies.allowAll);
      const path = def.path
        .replace(":queue", "mail")
        .replace(":id", "a")
        .replace(":runner", "nightly")
        .replace(":worker", "w1")
        .replace(":key", "k");
      const response = await h.call(def.method, path, '{"broken": [');
      expect({ route: def.operationId, status: response.status }).toEqual({
        route: def.operationId,
        status: 400,
      });
      // A route whose `target` reads the body needs a `pathTarget`, or this
      // request would be asked about with no target at all.
      const [context] = h.calls;
      expect({
        route: def.operationId,
        target: context?.queue ?? context?.runner,
      }).toEqual({
        route: def.operationId,
        target: path.startsWith("/runners/") ? "nightly" : "mail",
      });
    }
  });

  it("an invalid path is still authorized without a target", async () => {
    const path = "/queues/a%20b/jobs/a/fail";
    const allowed = await setup(policies.allowAll);
    const told = await allowed.call("POST", path, { reason: "" });
    expect(told.status).toBe(400);
    expect(told.body).toMatchObject({ code: "VALIDATION" });
    expect(allowed.calls).toEqual([
      {
        action: "jobs.fail",
        mutation: true,
        transport: "http",
        route: { method: "POST", path: "/queues/:queue/jobs/:id/fail" },
      },
    ]);

    const refused = await setup(policies.refuseUntargeted);
    const answer = await refused.call("POST", path, { reason: "" });
    expect(answer.status).toBe(403);
    expect(answer.text).not.toContain("VALIDATION");
  });
});

describe("authorize context integrity", () => {
  it("takes only target fields from a route's target", () => {
    expect(
      pickTarget({
        queue: "mail",
        jobId: "7",
        runner: "nightly",
        channel: "queues",
        jobIds: ["a", "b"],
        action: "jobs.read",
        transport: "ws",
        mutation: false,
        route: { method: "GET", path: "/elsewhere" },
      }),
    ).toEqual({
      queue: "mail",
      jobId: "7",
      runner: "nightly",
      channel: "queues",
      jobIds: ["a", "b"],
    });
    // A string is not a list of ids: it would spread into characters.
    expect(pickTarget({ jobIds: "abc" })).toEqual({});
    expect(pickTarget({ jobIds: ["a", 2] })).toEqual({});
    expect(pickTarget({ queue: 7, jobId: null })).toEqual({});
    expect(pickTarget("nonsense")).toEqual({});
  });

  it("never lets a target change the action, transport or mutation", async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    const config = resolveConfig(
      apiConfig({
        csrf: false,
        authorize: (_req, context) => {
          calls.push(context);
          return true;
        },
      }),
    );
    const route = defineRoute({
      method: "POST",
      path: "/hijack",
      operationId: "hijack",
      action: "jobs.remove",
      mode: "jobs",
      summary: "a route whose target returns too much",
      tags: ["Jobs"],
      body: s.object(
        { queue: s.string(), jobIds: s.unknown() },
        { additionalProperties: true },
      ),
      responses: { 200: s.object({ ok: s.boolean() }) },
      target: ({ body }) => body as never,
      handler: () => ({ body: { ok: true } }),
    });
    const api = buildJobsApi(config, [route]);
    const response = await api.router.fetch("/hijack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queue: "mail",
        jobIds: "abc",
        action: "jobs.read",
        transport: "ws",
        mutation: false,
        route: { method: "GET", path: "/meta" },
      }),
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        action: "jobs.remove",
        mutation: true,
        transport: "http",
        queue: "mail",
        route: { method: "POST", path: "/hijack" },
      },
    ]);
  });

  it("derives mutation and transport in decide, whatever it is asked", async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    const config = resolveConfig(
      apiConfig({
        authorize: (_req, context) => {
          calls.push(context);
          return true;
        },
      }),
    );
    await decide(config, {} as BunRequest, {
      action: "jobs.remove",
      transport: "nonsense" as never,
      jobIds: "abc" as never,
      queue: "mail",
    });
    expect(calls[0]).toEqual({
      action: "jobs.remove",
      mutation: true,
      transport: "http",
      queue: "mail",
    });
  });
});

describe("origins", () => {
  it("matches a pattern against the whole canonical origin", () => {
    const list = [/https:\/\/good\.example/];
    expect(originListed("https://good.example", list)).toBe(true);
    expect(originListed("HTTPS://Good.Example", list)).toBe(true);
    // The unanchored pattern must not match a longer, hostile origin.
    expect(originListed("https://good.example.evil.net", list)).toBe(false);
    expect(originListed("https://evil.net/https://good.example", list)).toBe(
      false,
    );
    expect(originListed("https://a.example", ["https://a.example/"])).toBe(
      true,
    );
    expect(originListed("not an origin", [/.*/])).toBe(false);
  });

  it("compares the scheme when the request's own is known", () => {
    expect(isSameOrigin("https://a.example", "a.example")).toBe(true);
    expect(isSameOrigin("https://a.example", "a.example", "https")).toBe(true);
    expect(isSameOrigin("https://a.example", "a.example", "https:")).toBe(true);
    expect(isSameOrigin("http://a.example", "a.example", "https")).toBe(false);
    expect(originAllowed("http://a.example", "a.example", [], "https")).toBe(
      false,
    );
  });

  it("refuses a cross-scheme or hostile-suffix origin on a mutation", async () => {
    const h = harness({
      csrf: { allowedOrigins: [/https:\/\/good\.example/] },
    });
    await h.jobs.queue("mail").add("send", {});

    const suffix = await h.call(
      "POST",
      "/queues/mail/pause",
      {},
      {
        origin: "https://good.example.evil.net",
        "sec-fetch-site": "cross-site",
      },
    );
    expect(suffix.status).toBe(403);
    expect(suffix.body).toMatchObject({ code: "CSRF_REJECTED" });

    // `router.fetch` requests arrive over http, so an https Origin of the same
    // host is a different origin.
    const crossScheme = await h.call(
      "POST",
      "/queues/mail/pause",
      {},
      { origin: "https://localhost" },
    );
    expect(crossScheme.status).toBe(403);

    const listed = await h.call(
      "POST",
      "/queues/mail/pause",
      {},
      { origin: "https://good.example", "sec-fetch-site": "cross-site" },
    );
    expect(listed.status).toBe(200);
  });

  it("takes the scheme and host from forwarded headers only with trustProxy", async () => {
    const forwarded = {
      origin: "https://admin.example",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "admin.example",
    };
    const plain = harness();
    await plain.jobs.queue("mail").add("send", {});
    expect(
      (await plain.call("POST", "/queues/mail/pause", {}, forwarded)).status,
    ).toBe(403);

    const trusting = harness({ jobs: plain.jobs, trustProxy: true });
    expect(
      (await trusting.call("POST", "/queues/mail/pause", {}, forwarded)).status,
    ).toBe(200);
  });

  it("reads the scheme and host from the request, or the proxy headers when trusted", () => {
    const request = new Request("http://admin.example/x", {
      headers: { "x-forwarded-proto": "https, http" },
    });
    expect(requestProtocol(request)).toBe("http");
    expect(requestProtocol(request, { trustProxy: true })).toBe("https");

    // The host takes the same route, and an untrusted header is worth
    // asserting on its own: a forwarded host the API believes is a forged
    // same-origin check.
    const hosted = new Request("http://real.example/x", {
      headers: { "x-forwarded-host": "admin.example, edge.example" },
    });
    expect(requestHost(hosted)).toBe("real.example");
    expect(requestHost(hosted, { trustProxy: true })).toBe("admin.example");
    expect(
      checkCsrf(csrfInfo(request, { trustProxy: true }), {
        requireJson: false,
        header: false,
        allowedOrigins: [],
      }),
    ).toBeUndefined();
  });
});

describe("cors with credentials", () => {
  it("refuses every origin form that can reflect a caller's own", () => {
    for (const origin of [
      undefined,
      true,
      "*",
      ["https://a.example", "*"],
      /.*/,
      [/https:\/\/.*/],
      "null",
      ["null"],
    ]) {
      expect(() =>
        createJobsApi(
          apiConfig({ cors: { credentials: true, origin: origin as never } }),
        ),
      ).toThrow(ConfigError);
    }
  });

  it("accepts an explicit list, and a function that owns the decision", () => {
    expect(
      createJobsApi(
        apiConfig({
          cors: { credentials: true, origin: ["https://admin.example"] },
        }),
      ).routes.length,
    ).toBeGreaterThan(0);
    expect(() =>
      createJobsApi(
        apiConfig({
          cors: {
            credentials: true,
            origin: (_origin, callback) => callback(null, true),
          },
        }),
      ),
    ).not.toThrow();
    // Without credentials a wildcard is merely public.
    expect(() =>
      createJobsApi(apiConfig({ cors: { origin: "*" } })),
    ).not.toThrow();
  });
});

describe("permissions follow the registered routes", () => {
  it("reports one answer per registered action, and nothing pruned", async () => {
    const driver = new MemoryDriver();
    Object.defineProperty(driver, "getJobLogs", { value: undefined });
    const h = harness({
      jobs: jobsContext("api-security", driver),
      docs: false,
      websocket: false,
      mode: "jobs",
    });
    const { actions } = (await h.call("GET", "/meta/permissions")).body as {
      actions: Record<string, boolean>;
    };

    const registered = new Set(h.api.routes.map((route) => route.action));
    expect(Object.keys(actions).sort()).toEqual([...registered].sort());
    // Pruned: no logs route on this driver, no docs, no socket, no runners.
    expect(actions).not.toHaveProperty("jobs.logs");
    expect(actions).not.toHaveProperty("docs.read");
    expect(actions).not.toHaveProperty("events.connect");
    expect(Object.keys(actions).some((a) => a.startsWith("runners."))).toBe(
      false,
    );
    // One authorize call per action, plus the one for the route itself.
    expect(h.calls).toHaveLength(registered.size + 1);
  });

  it("includes the socket actions when the API has a socket", async () => {
    const h = harness();
    const { actions } = (await h.call("GET", "/meta/permissions")).body as {
      actions: Record<string, boolean>;
    };
    expect(actions["events.connect"]).toBe(true);
    expect(actions["events.subscribe"]).toBe(true);
  });
});

describe("error details", () => {
  it("never repeats internal key text or a ConfigError's message", () => {
    const lock = toProblem(
      new LockUnavailableError("bunjobs:shop:runner:nightly:lock"),
    );
    expect(lock.problem.detail).toBe(lock.problem.title);
    expect(JSON.stringify(lock.problem)).not.toContain("bunjobs:");

    expect(toProblem(new LockLostError("r:nightly")).problem.detail).toBe(
      "Lock was lost",
    );
    expect(toProblem(new RunnerStoppedError("nightly")).problem.detail).toBe(
      "Runner is stopped",
    );

    const config = toProblem(
      new ConfigError(
        'Cannot tell which SQL engine "postgres://user:hunter2@db/x" is',
      ),
    );
    expect(config.status).toBe(400);
    expect(config.problem.detail).toBe("Invalid argument");
    expect(JSON.stringify(config.problem)).not.toContain("hunter2");
  });

  it("shows the message from the call sites that validate input", async () => {
    const h = harness();
    await h.jobs.queue("mail").add("send", {});
    const bad = await h.call("PUT", "/queues/mail/limits", {
      rate: { max: 5, duration: "whenever" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_ARGUMENT");
    expect(bad.body.detail).toMatch(/duration/);
  });
});
