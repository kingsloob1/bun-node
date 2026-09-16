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
import { resolveConfig } from "../../lib/api/config";
import { buildJobsApi, createJobsApi } from "../../lib/api/createJobsApi";
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
 * per request. When a check fails it is asked **without** a target, and only a
 * caller it allows learns what was wrong with the request.
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
    },
    {
      name: "a malformed JSON body",
      path: "/queues/mail/jobs/retry",
      body: '{"ids": [',
      code: "INVALID_JSON",
      status: 400,
    },
    {
      name: "a body of the wrong shape",
      path: "/queues/mail/jobs/retry",
      body: { ids: "not-an-array" },
      code: "VALIDATION",
      status: 400,
    },
    {
      name: "an unusable queue name",
      path: "/queues/a%20b/jobs/retry",
      body: { ids: ["a"] },
      code: "INVALID_NAME",
      status: 400,
    },
  ] as const;

  it("answers each one only to a caller authorize allows, asking it once without a target", async () => {
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
      expect(h.calls[0]).toEqual({
        action: "jobs.retry",
        mutation: true,
        transport: "http",
        route: { method: "POST", path: "/queues/:queue/jobs/retry" },
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
