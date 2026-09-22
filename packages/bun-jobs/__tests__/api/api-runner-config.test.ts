import type { JobsApiAuthorizeContext } from "../../lib/api/config";
import type { BunJobs, JobsDriver } from "../../lib/index";
import { BunRouter } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { JOBS_API_ACTIONS } from "../../lib/api/config";
import {
  EXECUTION_MODES,
  RUNNER_CONFIG_BOUNDS,
} from "../../lib/api/contract/constants";
import { createJobsApi } from "../../lib/api/createJobsApi";
import { ApiError } from "../../lib/api/errors";
import { configError } from "../../lib/api/routes/runners";
import {
  ConfigError,
  MemoryDriver,
  RUNNER_CONFIG_STATE,
  runnerKey,
} from "../../lib/index";
import {
  apiConfig,
  ECHO_HANDLER,
  harness,
  jobsContext,
  openContexts,
  openHarnesses,
  registerRunnerElsewhere,
} from "./fixtures";

/**
 * `PUT` and `DELETE /runners/:runner/config`: the two routes that let an
 * operator change a runner's executor and overlap settings from outside the
 * process that owns it.
 *
 * Three kinds of runner appear, on purpose. A **local** runner is the whole
 * path end to end — the controller delegates to the instance, so the answer
 * says what is actually in force. A runner **registered elsewhere** is state
 * another process persisted; whether it carries `config:code` decides whether
 * it can be configured at all, and both cases are here. `validateResponses`
 * is on in the harness, so every answer is checked against its schema too.
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

/** A harness whose context owns one local, configurable runner. */
function withRunner(
  namespace: string,
  runner: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const jobs = jobsContext(namespace);
  const h = harness({ jobs, ...overrides });
  const nightly = h.jobs.runner({
    id: "nightly",
    file: ECHO_HANDLER,
    executionMode: "in-process",
    runMode: "parallel",
    maxConcurrency: 3,
    ...runner,
  });
  return { ...h, nightly };
}

/**
 * Makes the backend know a runner an owner *that supports remote
 * configuration* registered: `config:code` and `config:allowed` are what such
 * an owner persists, and their absence is what makes a runner unconfigurable.
 */
async function registerConfigurableElsewhere(
  jobs: BunJobs,
  id: string,
  allowed: readonly string[] = EXECUTION_MODES,
): Promise<void> {
  await registerRunnerElsewhere(jobs, id);
  await jobs.driver.setState(jobs.namespace, runnerKey(id), {
    executionMode: "spawn",
    runMode: "single",
    maxConcurrency: "Infinity",
    [RUNNER_CONFIG_STATE.code]: JSON.stringify({
      executionMode: "spawn",
      runMode: "single",
      maxConcurrency: null,
    }),
    [RUNNER_CONFIG_STATE.allowed]: JSON.stringify([...allowed]),
  });
}

/** A driver with some methods hidden, as a partial one would be. */
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

describe("storing and clearing an override", () => {
  it("answers 200 with the configuration, and puts it in force on a local runner", async () => {
    const h = withRunner("api-runner-config-put");

    const res = await h.call("PUT", "/runners/nightly/config", {
      executionMode: "in-process",
      concurrency: { runMode: "parallel", maxConcurrency: 1 },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      effective: {
        executionMode: "in-process",
        runMode: "parallel",
        maxConcurrency: 1,
      },
      code: {
        executionMode: "in-process",
        runMode: "parallel",
        maxConcurrency: 3,
      },
      overridden: ["executionMode", "runMode", "maxConcurrency"],
      // Built from a driver instance: it cannot hand a child a driver config,
      // so it publishes only the modes it can adopt (B17).
      allowed: ["in-process"],
    });
    expect(res.body.seq).toBeGreaterThan(0);
    // The instance adopted it, so the cap it gates on really changed.
    expect(h.nightly.maxConcurrency).toBe(1);
  });

  it("is a merge patch: a field left out is untouched, `null` clears one", async () => {
    const h = withRunner("api-runner-config-merge");

    await h.call("PUT", "/runners/nightly/config", {
      executionMode: "in-process",
      concurrency: { runMode: "parallel", maxConcurrency: 2 },
    });
    // Only `concurrency` this time: `executionMode` stays overridden.
    const merged = await h.call("PUT", "/runners/nightly/config", {
      concurrency: { runMode: "single" },
    });
    expect(merged.body.overridden).toEqual(["executionMode", "runMode"]);
    expect(merged.body.effective.runMode).toBe("single");

    const cleared = await h.call("PUT", "/runners/nightly/config", {
      executionMode: null,
    });
    expect(cleared.body.overridden).toEqual(["runMode"]);
    expect(cleared.body.effective.executionMode).toBe("in-process");
  });

  it("takes `maxConcurrency: null` as unlimited, and does not bound it", async () => {
    const h = withRunner("api-runner-config-unlimited");

    const res = await h.call("PUT", "/runners/nightly/config", {
      concurrency: { runMode: "parallel", maxConcurrency: null },
    });
    expect(res.status).toBe(200);
    expect(res.body.effective.maxConcurrency).toBeNull();
    expect(h.nightly.maxConcurrency).toBe(Number.POSITIVE_INFINITY);
  });

  it("resets with 200 and the configuration, not 204, and the version keeps counting", async () => {
    const h = withRunner("api-runner-config-reset");

    const stored = await h.call("PUT", "/runners/nightly/config", {
      concurrency: { runMode: "parallel", maxConcurrency: 2 },
    });
    const reset = await h.call("DELETE", "/runners/nightly/config");

    expect(reset.status).toBe(200);
    expect(reset.body.overridden).toEqual([]);
    expect(reset.body.effective.maxConcurrency).toBe(3);
    // A version that restarted would let an owner believe it was up to date.
    expect(reset.body.seq).toBeGreaterThan(stored.body.seq);
    expect(h.nightly.maxConcurrency).toBe(3);
  });

  it("reaches a runner only another process registered", async () => {
    const jobs = jobsContext("api-runner-config-remote");
    const h = harness({ jobs });
    await registerConfigurableElsewhere(jobs, "elsewhere");

    const res = await h.call("PUT", "/runners/elsewhere/config", {
      concurrency: { runMode: "parallel", maxConcurrency: 4 },
    });
    expect(res.status).toBe(200);
    // Nothing has adopted it: `effective` is still what the owner persisted.
    expect(res.body.effective.runMode).toBe("single");
    expect(res.body.overridden).toEqual(["runMode", "maxConcurrency"]);
    expect(res.body.seq).toBeGreaterThan(res.body.appliedSeq ?? 0);

    const state = await jobs.driver.getState(
      jobs.namespace,
      runnerKey("elsewhere"),
    );
    expect(state[RUNNER_CONFIG_STATE.maxConcurrency]).toBe("4");
  });
});

describe("the runner snapshot", () => {
  it("carries the configuration on GET /runners/:runner", async () => {
    const h = withRunner("api-runner-config-info");

    const before = await h.call("GET", "/runners/nightly");
    expect(before.body.config).toMatchObject({
      effective: { executionMode: "in-process", maxConcurrency: 3 },
      overridden: [],
      seq: 0,
    });

    await h.call("PUT", "/runners/nightly/config", {
      concurrency: { runMode: "parallel", maxConcurrency: 1 },
    });
    const after = await h.call("GET", "/runners/nightly");
    expect(after.body.config.effective.maxConcurrency).toBe(1);
    expect(after.body.config.overridden).toEqual(["runMode", "maxConcurrency"]);
  });

  it("leaves it out for a runner from before remote configuration", async () => {
    const jobs = jobsContext("api-runner-config-absent");
    const h = harness({ jobs });
    await registerRunnerElsewhere(jobs, "legacy");

    const res = await h.call("GET", "/runners/legacy");
    expect(res.status).toBe(200);
    expect(res.body.config).toBeUndefined();
  });
});

describe("what it refuses", () => {
  it("bounds maxConcurrency with RUNNER_CONFIG_BOUNDS, at concurrency.maxConcurrency", async () => {
    const h = withRunner("api-runner-config-bounds");
    const { min, max } = RUNNER_CONFIG_BOUNDS.maxConcurrency;

    for (const maxConcurrency of [min - 1, max + 1, 1.5]) {
      const res = await h.call("PUT", "/runners/nightly/config", {
        concurrency: { runMode: "parallel", maxConcurrency },
      });
      expect({
        maxConcurrency,
        status: res.status,
        code: res.body.code,
      }).toEqual({ maxConcurrency, status: 400, code: "VALIDATION" });
      expect(res.body.issues).toEqual([
        {
          target: "body",
          path: "concurrency.maxConcurrency",
          message: expect.any(String),
        },
      ]);
    }
    // The bounds hold: nothing was written.
    expect(
      (await h.call("GET", "/runners/nightly")).body.config.overridden,
    ).toEqual([]);
  });

  it("refuses an empty patch with 400 VALIDATION", async () => {
    const h = withRunner("api-runner-config-empty");

    const res = await h.call("PUT", "/runners/nightly/config", {});
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 400,
      code: "VALIDATION",
    });
    expect(res.body.issues).toEqual([
      { target: "body", path: "", message: expect.any(String) },
    ]);
  });

  it("refuses an execution mode outside the enumeration before the runtime sees it", async () => {
    const h = withRunner("api-runner-config-enum");

    const res = await h.call("PUT", "/runners/nightly/config", {
      executionMode: "telepathy",
    });
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 400,
      code: "VALIDATION",
    });
    expect(res.body.issues?.[0]?.path).toBe("executionMode");
  });

  it("answers 409 CONFIG_NOT_ALLOWED, naming the modes the runner's code permits", async () => {
    const h = withRunner("api-runner-config-notallowed", {
      remoteConfig: { executionModes: ["in-process"] },
    });

    const res = await h.call("PUT", "/runners/nightly/config", {
      executionMode: "spawn",
    });
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 409,
      code: "CONFIG_NOT_ALLOWED",
    });
    expect(res.body.detail).toContain("in-process");
    expect(res.body.context).toMatchObject({
      runner: "nightly",
      executionMode: "spawn",
      allowed: ["in-process"],
    });
    // A mode it does permit still goes through.
    expect(
      (
        await h.call("PUT", "/runners/nightly/config", {
          executionMode: "in-process",
        })
      ).status,
    ).toBe(200);
  });

  it("answers 409 RUNNER_NOT_CONFIGURABLE for a runner no modern owner has started", async () => {
    const jobs = jobsContext("api-runner-config-legacy");
    const h = harness({ jobs });
    await registerRunnerElsewhere(jobs, "legacy");

    for (const [method, body] of [
      ["PUT", { executionMode: "in-process" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await h.call(method, "/runners/legacy/config", body);
      expect({ method, status: res.status, code: res.body.code }).toEqual({
        method,
        status: 409,
        code: "RUNNER_NOT_CONFIGURABLE",
      });
      expect(res.body.context).toMatchObject({ runner: "legacy" });
    }
  });

  it("answers 404 RUNNER_NOT_FOUND for a runner nothing knows, and 400 for a bad name", async () => {
    const h = withRunner("api-runner-config-404");

    const missing = await h.call("PUT", "/runners/nobody/config", {
      executionMode: "in-process",
    });
    expect({ status: missing.status, code: missing.body.code }).toEqual({
      status: 404,
      code: "RUNNER_NOT_FOUND",
    });

    const reset = await h.call("DELETE", "/runners/nobody/config");
    expect(reset.body.code).toBe("RUNNER_NOT_FOUND");

    const bad = await h.call("DELETE", "/runners/not%20a%20segment/config");
    expect({ status: bad.status, code: bad.body.code }).toEqual({
      status: 400,
      code: "INVALID_NAME",
    });
  });
});

describe("the ConfigError mapping", () => {
  /**
   * `"invalid"` cannot be reached over HTTP — the body schema refuses a bad
   * enum or an out-of-range cap first — so the table is asserted directly.
   * Every branch keys off `context.reason`, never the message.
   */
  it("maps every reason, and blames the body field the client sent", () => {
    const invalid = configError(
      new ConfigError("bad cap", {
        reason: "invalid",
        field: "maxConcurrency",
      }),
      "nightly",
    ) as ApiError;
    expect(invalid).toBeInstanceOf(ApiError);
    expect({ code: invalid.code, status: invalid.status }).toEqual({
      code: "VALIDATION",
      status: 400,
    });
    expect(invalid.issues).toEqual([
      {
        target: "body",
        path: "concurrency.maxConcurrency",
        message: "bad cap",
      },
    ]);

    // `runMode` is a state field but half of one body property.
    const runMode = configError(
      new ConfigError("bad policy", { reason: "invalid", field: "runMode" }),
      "nightly",
    ) as ApiError;
    expect(runMode.issues?.[0]?.path).toBe("concurrency.runMode");

    // A reason this table does not know is not this route's to translate.
    const foreign = new ConfigError("something internal", { reason: "other" });
    expect(configError(foreign, "nightly")).toBe(foreign);
    const plain = new Error("boom");
    expect(configError(plain, "nightly")).toBe(plain);
  });
});

describe("authorization, opt-in and pruning", () => {
  it("authorizes runners.configure against the runner, as the other runner routes do", async () => {
    const h = withRunner("api-runner-config-authz");

    await h.call("PUT", "/runners/nightly/config", {
      executionMode: "in-process",
    });
    await h.call("DELETE", "/runners/nightly/config");

    const configure = h.calls.filter(
      (call: JobsApiAuthorizeContext) => call.action === "runners.configure",
    );
    expect(configure).toHaveLength(2);
    for (const call of configure) {
      expect(call).toMatchObject({
        action: "runners.configure",
        runner: "nightly",
        mutation: true,
        transport: "http",
      });
      expect(call.queue).toBeUndefined();
    }

    // A host that refuses this one runner is obeyed, and nothing is written.
    const denied = withRunner(
      "api-runner-config-denied",
      {},
      {
        authorize: (_req: unknown, c: JobsApiAuthorizeContext) =>
          c.action !== "runners.configure",
      },
    );
    expect(
      (
        await denied.call("PUT", "/runners/nightly/config", {
          executionMode: "in-process",
        })
      ).status,
    ).toBe(403);
    expect(denied.nightly.config.overridden).toEqual([]);
  });

  it("is opt-in: a default configuration serves neither route", async () => {
    const jobs = jobsContext("api-runner-config-optin");
    jobs.runner({ id: "nightly", file: ECHO_HANDLER });
    const off = createJobsApi(apiConfig({ jobs }));
    const root = new BunRouter();
    root.use(off.basePath, off.router);

    expect(
      off.routes.filter((route) => route.action === "runners.configure"),
    ).toEqual([]);
    // The rest of the runner surface is on by default.
    expect(off.routes.map((route) => route.action)).toContain("runners.pause");

    const refused = await root.fetch("/admin/jobs/runners/nightly/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionMode: "in-process" }),
    });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ code: "ROUTE_NOT_FOUND" });

    // Asked for by name, both routes appear.
    const on = createJobsApi(
      apiConfig({ jobs, actions: [...JOBS_API_ACTIONS] }),
    );
    expect(
      on.routes
        .filter((route) => route.action === "runners.configure")
        .map((route) => route.operationId)
        .sort(),
    ).toEqual(["configureRunner", "resetRunnerConfig"]);
  });

  it("prunes both routes on a driver that cannot version the override", async () => {
    const jobs = jobsContext(
      "api-runner-config-pruned",
      without(new MemoryDriver(), ["incrementCounters"]),
    );
    jobs.runner({ id: "nightly", file: ECHO_HANDLER });
    const h = harness({ jobs });
    const operations = h.api.routes.map((route) => route.operationId);

    expect(operations).toContain("getRunner");
    for (const pruned of ["configureRunner", "resetRunnerConfig"]) {
      expect({ pruned, routed: operations.includes(pruned) }).toEqual({
        pruned,
        routed: false,
      });
    }
    const res = await h.call("DELETE", "/runners/nightly/config");
    expect({ status: res.status, code: res.body.code }).toEqual({
      status: 404,
      code: "ROUTE_NOT_FOUND",
    });
  });
});

describe("the documents", () => {
  /** The OpenAPI document of an API with every action enabled. */
  function openapi(overrides: Record<string, unknown> = {}) {
    const jobs = jobsContext("api-runner-config-docs");
    jobs.runner({ id: "nightly", file: ECHO_HANDLER });
    const api = createJobsApi(
      apiConfig({ jobs, actions: [...JOBS_API_ACTIONS], ...overrides }),
    );
    return api.openapi() as unknown as {
      paths: Record<string, Record<string, any>>;
      components: { schemas: Record<string, any> };
    };
  }

  it("documents both routes, their schemas and the :runner pattern", () => {
    const doc = openapi();
    const path = doc.paths["/runners/{runner}/config"]!;
    expect(Object.keys(path).sort()).toEqual(["delete", "put"]);
    expect(path.put.operationId).toBe("configureRunner");
    expect(path.delete.operationId).toBe("resetRunnerConfig");
    // 200 with the configuration on both, never a body-less 204.
    for (const method of ["put", "delete"] as const) {
      expect(Object.keys(path[method].responses)).toContain("200");
      expect(Object.keys(path[method].responses)).not.toContain("204");
      expect(
        path[method].responses["200"].content["application/json"].schema.$ref,
      ).toBe("#/components/schemas/RunnerConfig");
    }

    // The pattern the route enforces itself, exactly as another runner
    // mutation documents it.
    const patternOf = (at: string, method: string) =>
      doc.paths[at]![method].parameters.find(
        (param: any) => param.name === "runner",
      ).schema.pattern;
    expect(patternOf("/runners/{runner}/config", "put")).toBe(
      patternOf("/runners/{runner}/schedule", "put"),
    );
    expect(patternOf("/runners/{runner}/config", "delete")).toBe(
      patternOf("/runners/{runner}/schedule", "put"),
    );

    // Every DTO is a named component, so a client generator emits one type.
    expect(
      Object.keys(doc.components.schemas)
        .filter((name) => name.startsWith("RunnerConfig"))
        .sort(),
    ).toEqual(["RunnerConfig", "RunnerConfigBody", "RunnerConfigValues"]);
    expect(doc.components.schemas.RunnerInfo.properties.config.$ref).toBe(
      "#/components/schemas/RunnerConfig",
    );

    // The bounds come from the contract, not from a literal in the schema.
    const { min, max } = RUNNER_CONFIG_BOUNDS.maxConcurrency;
    const parallel =
      doc.components.schemas.RunnerConfigBody.properties.concurrency.anyOf[0].anyOf.find(
        (member: any) => member.properties?.maxConcurrency !== undefined,
      );
    expect(parallel.properties.maxConcurrency.anyOf[0]).toMatchObject({
      type: "integer",
      minimum: min,
      maximum: max,
    });
    expect(parallel.properties.maxConcurrency.anyOf[1]).toEqual({
      type: "null",
    });
    expect(
      doc.components.schemas.RunnerConfigBody.properties.executionMode.anyOf[0]
        .enum,
    ).toEqual([...EXECUTION_MODES]);

    // And the errors each route can answer with.
    for (const method of ["put", "delete"] as const) {
      expect(
        Object.values(path[method].responses).flatMap(
          (response: any) => response["x-bun-jobs-codes"] ?? [],
        ),
      ).toEqual(
        expect.arrayContaining([
          "RUNNER_NOT_FOUND",
          "CONFIG_NOT_ALLOWED",
          "RUNNER_NOT_CONFIGURABLE",
        ]),
      );
    }
  });

  it("carries the CSRF header on both, exactly as another runner mutation does", () => {
    const doc = openapi({ csrf: { header: "x-csrf" } });
    const headerOf = (at: string, method: string) =>
      doc.paths[at]![method].parameters.find(
        (param: any) => param.in === "header",
      );
    expect(headerOf("/runners/{runner}/config", "put")).toEqual(
      headerOf("/runners/{runner}/schedule", "put"),
    );
    expect(headerOf("/runners/{runner}/config", "delete")).toMatchObject({
      name: "x-csrf",
      required: true,
    });
    // A read carries none.
    expect(headerOf("/runners/{runner}", "get")).toBeUndefined();
  });
});
