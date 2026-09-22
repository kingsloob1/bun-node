import type { LogEvent } from "@kingsleyweb/bun-common";
import {
  BunRouter,
  createTestLogger,
  PayloadTooLargeError,
  validate,
} from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  API_ERROR_STATUS,
  ApiError,
  createApiErrorHandler,
  createNotFoundHandler,
  errorStatusCode,
  isNotSupportedError,
  mapCallSiteError,
  problemTitle,
  tagRequestAction,
  toProblem,
} from "../../lib/api/errors";
import { s } from "../../lib/api/schema/builder";
import {
  ChildExitError,
  ChildFailedError,
  ConfigError,
  DriverError,
  InvalidHandlerError,
  JobsError,
  JobTimeoutError,
  LockLostError,
  LockUnavailableError,
  NotSupportedError,
  ProtocolError,
  QueueClosedError,
  QueueFullError,
  RunKilledError,
  RunnerNotFoundError,
  RunnerStoppedError,
  SerializationError,
  UnrecoverableJobError,
  WorkerClosedError,
} from "../../lib/shared/errors";

/** A message no response may ever contain when it is a 5xx. */
const SECRET = "SECRET-internal-detail-7f3a";

/** A router whose one route throws `error`, finished the way the API router is. */
function throwingRouter(error: unknown, events?: LogEvent[]) {
  const { logger, events: collected } = createTestLogger();
  const router = new BunRouter();
  router.get("/boom", (req) => {
    tagRequestAction(req, "jobs.read");
    throw error;
  });
  router.use(createNotFoundHandler());
  router.use(createApiErrorHandler({ logger }));
  return { router, events: events ?? collected };
}

/** Fetches `/boom` through a router throwing `error`. */
async function answer(error: unknown) {
  const { router, events } = throwingRouter(error);
  const response = await router.fetch("/boom");
  const text = await response.text();
  return {
    response,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
    events,
  };
}

describe("the §3.3 mapping", () => {
  const cases: {
    name: string;
    error: () => unknown;
    status: number;
    code: string;
    detail?: string;
    retryAfter?: string;
  }[] = [
    {
      name: "PayloadTooLargeError",
      error: () => new PayloadTooLargeError(1024, 4096),
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      detail: "The request body exceeds 1024 bytes",
    },
    {
      name: "NotSupportedError",
      error: () =>
        new NotSupportedError(SECRET, "getJobLogs", { secret: SECRET }),
      status: 501,
      code: "NOT_SUPPORTED",
    },
    {
      // Only the class decides now: a plain ConfigError that happens to carry
      // a `method` is an input error, not a capability gap.
      name: "a plain ConfigError carrying context.method",
      error: () =>
        new ConfigError(`schedule is invalid ${SECRET}`, {
          method: "updateSchedule",
        }),
      status: 400,
      code: "INVALID_ARGUMENT",
      // Its message is prose from anywhere in the package: only the known
      // input-validating call sites show one (see the call-site tests).
      detail: "Invalid argument",
    },
    {
      name: "RunnerNotFoundError",
      error: () => new RunnerNotFoundError("cleanup", SECRET),
      status: 404,
      code: "RUNNER_NOT_FOUND",
      detail: 'Runner "cleanup" was not found',
    },
    {
      name: "ProtocolError",
      error: () => new ProtocolError(`job channel ${SECRET}`, SECRET),
      status: 500,
      code: "PROTOCOL",
    },
    {
      name: "ConfigError describing input",
      error: () => new ConfigError(`priority must be an integer ${SECRET}`),
      status: 400,
      code: "INVALID_ARGUMENT",
      detail: "Invalid argument",
    },
    {
      name: "SerializationError outside job input",
      error: () => new SerializationError(`result ${SECRET}`),
      status: 500,
      code: "SERIALIZATION",
    },
    {
      name: "QueueClosedError",
      error: () => new QueueClosedError(SECRET),
      status: 503,
      code: "QUEUE_CLOSED",
      retryAfter: "1",
    },
    {
      name: "WorkerClosedError",
      error: () => new WorkerClosedError(SECRET),
      status: 503,
      code: "WORKER_CLOSED",
    },
    {
      name: "RunnerStoppedError",
      error: () => new RunnerStoppedError("cleanup"),
      status: 409,
      code: "RUNNER_STOPPED",
      // The title, not the message: lock and runner-stopped messages carry
      // internal key text.
      detail: "Runner is stopped",
    },
    {
      name: "LockUnavailableError",
      error: () => new LockUnavailableError("r:cleanup"),
      status: 409,
      code: "LOCK_UNAVAILABLE",
    },
    {
      name: "LockLostError",
      error: () => new LockLostError("r:cleanup"),
      status: 409,
      code: "LOCK_LOST",
    },
    {
      name: "QueueFullError",
      error: () => new QueueFullError(SECRET, 10),
      status: 503,
      code: "QUEUE_FULL",
      retryAfter: "1",
    },
    {
      name: "DriverError",
      error: () => new DriverError("redis", "claimJob", new Error(SECRET)),
      status: 503,
      code: "DRIVER_ERROR",
    },
    {
      name: "JobTimeoutError",
      error: () => new JobTimeoutError(5, { secret: SECRET }),
      status: 500,
      code: "JOB_TIMEOUT",
    },
    {
      name: "UnrecoverableJobError",
      error: () => new UnrecoverableJobError(SECRET),
      status: 500,
      code: "UNRECOVERABLE_JOB",
    },
    {
      name: "ChildExitError",
      error: () => new ChildExitError(1, null, { secret: SECRET }),
      status: 500,
      code: "CHILD_EXIT",
    },
    {
      name: "ChildFailedError",
      error: () =>
        new ChildFailedError({ queue: "q", id: "1" }, { message: SECRET }),
      status: 500,
      code: "CHILD_FAILED",
    },
    {
      name: "RunKilledError",
      error: () => new RunKilledError(SECRET),
      status: 500,
      code: "RUN_KILLED",
    },
    {
      name: "InvalidHandlerError",
      error: () => new InvalidHandlerError(SECRET, SECRET),
      status: 500,
      code: "INVALID_HANDLER",
    },
    {
      name: "another JobsError",
      error: () => new JobsError(SECRET, "SOMETHING_ELSE"),
      status: 500,
      code: "SOMETHING_ELSE",
    },
    {
      name: "an unknown Error",
      error: () => new Error(SECRET),
      status: 500,
      code: "INTERNAL",
    },
    {
      name: "a foreign 401 (an auth middleware)",
      error: () => Object.assign(new Error("token expired"), { status: 401 }),
      status: 401,
      code: "UNAUTHORIZED",
      detail: "token expired",
    },
    {
      name: "a foreign 429 via statusCode",
      error: () => Object.assign(new Error("slow down"), { statusCode: 429 }),
      status: 429,
      code: "RATE_LIMITED",
      detail: "slow down",
    },
    {
      name: "a foreign 4xx that must not be exposed",
      error: () =>
        Object.assign(new Error(SECRET), { status: 400, expose: false }),
      status: 400,
      code: "HTTP_400",
      detail: "Bad request",
    },
    {
      name: "a foreign 5xx",
      error: () => Object.assign(new Error(SECRET), { status: 502 }),
      status: 502,
      code: "HTTP_502",
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} → ${testCase.status} ${testCase.code}`, async () => {
      const { response, text, body } = await answer(testCase.error());
      expect(response.status).toBe(testCase.status);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(body.status).toBe(testCase.status);
      expect(body.code).toBe(testCase.code);
      expect(body.type).toBe(`urn:bun-jobs:error:${testCase.code}`);
      expect(body.instance).toBe("/boom");
      if (testCase.retryAfter) {
        expect(response.headers.get("retry-after")).toBe(testCase.retryAfter);
      }
      if (testCase.status >= 500) {
        // The whole point: a server fault carries its title, nothing more.
        expect(body.detail).toBe(body.title);
        expect(text).not.toContain(SECRET);
      } else if (testCase.detail) {
        expect(body.detail).toBe(testCase.detail);
      }
    });
  }

  it("a ValidationError → 400 VALIDATION with the issues", async () => {
    const router = new BunRouter();
    router.get(
      "/v",
      validate({ query: s.query(s.object({ limit: s.integer() })) }),
      () => "ok",
    );
    router.use(createApiErrorHandler({ logger: createTestLogger().logger }));
    const response = await router.fetch("/v?limit=many");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: "urn:bun-jobs:error:VALIDATION",
      title: "Request validation failed",
      status: 400,
      code: "VALIDATION",
      detail: "The request did not match the schema",
      instance: "/v",
      issues: [
        {
          target: "query",
          path: "limit",
          message: "Expected integer, received string",
        },
      ],
    });
  });

  it("NOT_SUPPORTED names the method but never the message or the driver", () => {
    const { problem } = toProblem(new NotSupportedError(SECRET, "getJobLogs"));
    expect(problem.context).toEqual({ method: "getJobLogs" });
    expect(JSON.stringify(problem)).not.toContain(SECRET);
  });

  it("RUNNER_NOT_FOUND names the id but never the namespace", () => {
    const { problem } = toProblem(new RunnerNotFoundError("cleanup", SECRET));
    expect(problem.context).toEqual({ runner: "cleanup" });
    expect(JSON.stringify(problem)).not.toContain(SECRET);
  });

  it("the API's own codes carry their status and title", () => {
    const own: [string, number][] = [
      ["UNAUTHORIZED", 401],
      ["FORBIDDEN", 403],
      ["QUEUE_NOT_FOUND", 404],
      ["JOB_NOT_FOUND", 404],
      ["RUNNER_NOT_FOUND", 404],
      ["RUN_NOT_FOUND", 404],
      ["REPEATABLE_NOT_FOUND", 404],
      ["ROUTE_NOT_FOUND", 404],
      ["INVALID_NAME", 400],
      ["JOB_STATE_CONFLICT", 409],
      ["JOB_ACTIVE", 409],
      ["RUNNER_NOT_LOCAL", 409],
      ["OPERATION_IN_PROGRESS", 409],
      ["BULK_LIMIT", 400],
      ["ARGS_NOT_ALLOWED", 400],
      ["NAME_NOT_ADDABLE", 403],
      ["CSRF_REJECTED", 403],
      ["UNSUPPORTED_MEDIA_TYPE", 415],
    ];
    for (const [code, status] of own) {
      const { problem, status: answered } = toProblem(
        new ApiError(code, status, `detail for ${code}`, {
          context: { state: "active" },
        }),
      );
      expect(answered).toBe(status);
      expect(problem.code).toBe(code);
      expect(problem.title).not.toBe("Request failed");
      expect(problem.detail).toBe(`detail for ${code}`);
      expect(problem.context).toEqual({ state: "active" });
    }
    // An ApiError that is itself a 5xx still hides its message.
    expect(
      toProblem(new ApiError("INTERNAL", 500, SECRET)).problem.detail,
    ).toBe("Internal server error");
  });

  it("an ApiError is a JobsError that also carries status, for the host adapter", () => {
    const error = new ApiError("BULK_LIMIT", 400, "Too many", {
      context: { max: 10 },
    });
    expect(error).toBeInstanceOf(JobsError);
    expect(error.status).toBe(400);
    expect(errorStatusCode(error)).toBe(400);
    expect(error.context).toEqual({ max: 10 });
  });
});

describe("call-site mapping", () => {
  it("a ConfigError from setLimits is a 409 LIMITS_CONTENDED", () => {
    const contended = new ConfigError(
      'Could not store limits for queue "q": they kept changing underneath',
      {
        queue: "q",
      },
    );
    const mapped = mapCallSiteError(contended, "setLimits");
    expect(mapped).toBeInstanceOf(ApiError);
    expect(toProblem(mapped).status).toBe(409);
    expect(toProblem(mapped).problem.code).toBe("LIMITS_CONTENDED");
    // The control: the same error without the call site is a 400.
    expect(toProblem(contended).problem.code).toBe("INVALID_ARGUMENT");
  });

  it("setLimits leaves capability errors and other classes alone", () => {
    const unsupported = new NotSupportedError("memory", "setQueueState");
    expect(mapCallSiteError(unsupported, "setLimits")).toBe(unsupported);
    const driver = new DriverError("redis", "setQueueState", new Error("x"));
    expect(mapCallSiteError(driver, "setLimits")).toBe(driver);
  });

  it("a SerializationError from job input is a 400", () => {
    const error = new SerializationError("job data");
    expect(toProblem(mapCallSiteError(error, "jobInput")).status).toBe(400);
    expect(toProblem(error).status).toBe(500);
    expect(mapCallSiteError(error, "setLimits")).toBe(error);
  });

  it("recognises a capability gap by its class alone", () => {
    expect(isNotSupportedError(new NotSupportedError("memory", "m"))).toBe(
      true,
    );
    // A NotSupportedError is still a ConfigError for older callers.
    expect(new NotSupportedError("memory", "m")).toBeInstanceOf(ConfigError);
    expect(
      isNotSupportedError(new ConfigError("x", { method: "getJobLogs" })),
    ).toBe(false);
    expect(isNotSupportedError(new ConfigError("x"))).toBe(false);
    expect(
      isNotSupportedError(
        Object.assign(new Error("x"), { context: { method: "m" } }),
      ),
    ).toBe(false);
  });
});

describe("errorStatusCode", () => {
  it("honours a 4xx/5xx status or statusCode, else 500", () => {
    expect(errorStatusCode({ status: 404 })).toBe(404);
    expect(errorStatusCode({ statusCode: 503 })).toBe(503);
    expect(errorStatusCode({ status: 302 })).toBe(500);
    expect(errorStatusCode({ status: "404" })).toBe(500);
    expect(errorStatusCode({ status: 600 })).toBe(500);
    expect(errorStatusCode(null)).toBe(500);
    expect(errorStatusCode("boom")).toBe(500);
  });
});

describe("the worker-control and runner-config codes", () => {
  it("each has a status and a title of its own, and none falls back", () => {
    // The routes are not built yet; the codes land with the contract so a
    // client can branch on them, and `problemTitle` must already answer for
    // each — a code with no title of its own would show "Conflict".
    const expected = {
      WORKER_NOT_FOUND: 404,
      WORKER_GONE: 410,
      WORKER_STATE_CONFLICT: 409,
      WORKER_NOT_CONTROLLABLE: 409,
      WORKER_PERSISTENCE_NOT_ALLOWED: 409,
      CONTROL_CONTENDED: 409,
      CONFIG_NOT_ALLOWED: 409,
      RUNNER_NOT_CONFIGURABLE: 409,
    } as const;
    expect(API_ERROR_STATUS).toMatchObject(expected);
    const generic = new Set(["Conflict", "Not found", "Gone"]);
    for (const [code, status] of Object.entries(expected)) {
      const title = problemTitle(code, status);
      expect({ code, generic: generic.has(title) }).toEqual({
        code,
        generic: false,
      });
      expect({ code, empty: title.length === 0 }).toEqual({
        code,
        empty: false,
      });
    }
  });

  it("shapes a problem body a client can branch on", () => {
    const { problem } = toProblem(
      new ApiError(
        "WORKER_PERSISTENCE_NOT_ALLOWED",
        API_ERROR_STATUS.WORKER_PERSISTENCE_NOT_ALLOWED,
        "not allowed here",
      ),
      { instance: "/queues/mail/workers/w1/stop" },
    );
    expect(problem).toMatchObject({
      type: "urn:bun-jobs:error:WORKER_PERSISTENCE_NOT_ALLOWED",
      code: "WORKER_PERSISTENCE_NOT_ALLOWED",
      status: 409,
      detail: "not allowed here",
    });
  });
});

describe("the error handler and catch-all", () => {
  it("answers an unmatched route with a JSON ROUTE_NOT_FOUND", async () => {
    const { router } = throwingRouter(new Error("unused"));
    const response = await router.fetch("/nowhere?x=1", { method: "POST" });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      type: "urn:bun-jobs:error:ROUTE_NOT_FOUND",
      title: "Route not found",
      status: 404,
      code: "ROUTE_NOT_FOUND",
      detail: "No route for POST /nowhere",
      instance: "/nowhere",
    });
  });

  it("logs 5xx at error level and 4xx at debug, with code, status and action", async () => {
    const server = await answer(
      new DriverError("redis", "claimJob", new Error(SECRET)),
    );
    const serverEvents = server.events.filter(
      (event) => event.message === "jobs api request failed",
    );
    expect(serverEvents.map((event) => event.level)).toEqual(["error"]);
    expect(serverEvents[0]!.fields).toMatchObject({
      code: "DRIVER_ERROR",
      status: 503,
      action: "jobs.read",
    });
    // The cause reaches the log, even though it never reaches the client.
    expect(serverEvents[0]!.error).toBeInstanceOf(DriverError);

    const client = await answer(new ApiError("JOB_NOT_FOUND", 404, "gone"));
    const clientEvents = client.events.filter(
      (event) => event.message === "jobs api request failed",
    );
    expect(clientEvents.map((event) => event.level)).toEqual(["debug"]);
    expect(clientEvents[0]!.fields).toMatchObject({
      code: "JOB_NOT_FOUND",
      status: 404,
    });
  });

  it("leaves a response that has already started alone", async () => {
    const router = new BunRouter();
    router.get("/half", (_req, res) => {
      res.status(200).json({ ok: true });
      throw new Error(SECRET);
    });
    router.use(createApiErrorHandler({ logger: createTestLogger().logger }));
    const response = await router.fetch("/half");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("maps a thrown string as an internal error", () => {
    const { problem } = toProblem(SECRET);
    expect(problem.code).toBe("INTERNAL");
    expect(JSON.stringify(problem)).not.toContain(SECRET);
  });
});
