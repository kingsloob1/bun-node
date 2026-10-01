import { REMOTE_OPS } from "@kingsleyweb/bun-jobs/remote";
import { describe, expect, it } from "bun:test";
import {
  parseRemoteEnvelope,
  parseRemoteMessage,
  REMOTE_ENVELOPE_SCHEMAS,
  REMOTE_MESSAGE_SCHEMAS,
} from "../../lib/remote/schemas";

/**
 * Every envelope (`worker-runtimes.md` §5.3–§5.5) and session message
 * (`remote-transports.md` §4.1–§4.2) validates its documented example, keeps
 * unknown fields, and refuses what it must. The examples are the plans' own,
 * with only their elisions (`…`) filled in.
 */

const FENCE = "h7f3-4211-1789:1790000000400";
const JOB = "01JB7Q2M8ZRT9V";
const CAPACITY = { inFlight: 1, max: 8, accepting: true };

/** The plan's examples, one per op, by family. */
const ENVELOPES: Record<string, Record<string, unknown>> = {
  handshake: {
    v: 1,
    op: "handshake",
    protocols: [1],
    name: "orders-cf",
    runtime: "workerd",
    sdk: "@kingsleyweb/bun-jobs/remote@2.3.0",
    names: ["resize-image", "send-welcome"],
    maxBatch: 25,
    maxDurationMs: 25000,
    maxBodyBytes: 1048576,
    features: {
      cancel: "v1",
      idempotency: "v1",
      fencing: "v1",
      "progress-stream": "v1",
      "replay-protection": "v1",
    },
    secretHash: "b2ed9921".padEnd(64, "0"),
    now: 1790000000123,
  },
  invoke: {
    v: 1,
    op: "invoke",
    id: "inv_01JB7Q2M9S0P",
    now: 1790000000456,
    deadlineAt: 1790000025456,
    namespace: "shop",
    queue: "media",
    worker: { id: "api.media.h7f3-4211-1789", key: "api.media" },
    jobs: [
      {
        id: JOB,
        name: "resize-image",
        data: { url: "https://cdn.example.com/a.png", width: 320 },
        attempt: 1,
        maxAttempts: 3,
        createdAt: 1789999999000,
        priority: 0,
        timeoutMs: 20000,
        idempotencyKey: `shop:media:${JOB}:1`,
        fence: FENCE,
        delivery: 1,
        repeatKey: null,
        parent: null,
      },
    ],
  },
  "invoke-result": {
    v: 1,
    op: "invoke-result",
    id: "inv_01JB7Q2M9S0P",
    now: 1790000003111,
    outcomes: [
      {
        op: "result",
        job: JOB,
        attempt: 1,
        fence: FENCE,
        status: "completed",
        result: { bytes: 20481 },
        logs: [{ at: 1790000001200, line: "resizing https://cdn…/a.png" }],
        progress: 100,
        durationMs: 2655,
      },
      {
        op: "fail",
        job: "01JB7Q2M8ZRT9X",
        attempt: 2,
        fence: FENCE,
        status: "failed",
        error: {
          name: "FetchError",
          message: "upstream returned 503",
          code: "UPSTREAM_UNAVAILABLE",
          stack: "FetchError: upstream returned 503\n    at …",
        },
        retryAfterMs: 30000,
      },
      {
        op: "rejected",
        job: "01JB7Q2M8ZRT9W",
        attempt: 1,
        code: "BUSY",
        retryAfterMs: 2000,
      },
    ],
    capacity: { inFlight: 3, max: 25 },
  },
  cancel: {
    v: 1,
    op: "cancel",
    id: "can_1",
    jobs: [{ job: JOB, attempt: 1 }],
    reason: "timeout",
    at: 1790000000999,
  },
  "cancel-result": {
    v: 1,
    op: "cancel-result",
    id: "can_1",
    jobs: [{ job: JOB, attempt: 1, cancelled: true }],
  },
  ping: { v: 1, op: "ping", id: "p17", at: 1790000020000 },
  pong: { v: 1, op: "pong", id: "p17", capacity: CAPACITY, at: 1790000020003 },
  health: { v: 1, op: "health", id: "h3", at: 1790000030000 },
  "health-result": {
    v: 1,
    op: "health-result",
    id: "h3",
    ok: true,
    capacity: CAPACITY,
    checks: [
      { id: "gpu", status: "pass" },
      { id: "model-loaded", status: "fail", detail: "still loading" },
    ],
    at: 1790000030004,
  },
  status: {
    v: 1,
    op: "status",
    id: "st_1",
    jobs: [{ job: JOB, attempt: 1 }],
  },
  "status-result": {
    v: 1,
    op: "status-result",
    id: "st_1",
    jobs: [
      {
        job: JOB,
        attempt: 1,
        state: "done",
        outcome: {
          op: "result",
          status: "completed",
          result: { bytes: 20481 },
          fence: FENCE,
        },
      },
      { job: "01JB7Q2M8ZRT9X", attempt: 2, state: "unknown" },
    ],
  },
};

const MESSAGES: Record<string, Record<string, unknown>> = {
  hello: {
    op: "hello",
    v: 1,
    protocols: [1],
    role: "gateway",
    nonce: "q3JtZ2FfZ3c0bE1uUXpXRA",
    t: 1790000000,
    worker: { id: "api.media.h7f3-4211-1789", key: "api.media" },
    want: { keepaliveMs: 10000, heartbeatMs: 10000, ackDelayMs: 50 },
    resume: null,
    features: {
      session: "v1",
      health: "v1",
      cancel: "v1",
      "attempt-status": "v1",
      resume: "v1",
    },
  },
  welcome: {
    op: "welcome",
    v: 1,
    protocol: 1,
    role: "executor",
    nonce: "Ym9iX2V4ZWN1dG9yX25vbg",
    name: "media-ws",
    runtime: "bun",
    sdk: "@kingsleyweb/bun-jobs/remote@2.3.0",
    names: ["resize-image"],
    maxBatch: 25,
    maxDurationMs: 3300000,
    maxMessageBytes: 1048576,
    timing: { keepaliveMs: 10000, heartbeatMs: 10000 },
    capacity: { inFlight: 0, max: 8, accepting: true },
    features: { session: "v1", canary: "v1" },
    resumed: null,
    now: 1790000000123,
    at: 1790000000123,
  },
  invoke: {
    op: "invoke",
    v: 1,
    id: "inv_01JB7Q2M9S0P",
    kind: "job",
    now: 1790000000456,
    deadlineAt: 1790000025456,
    namespace: "shop",
    queue: "media",
    jobs: [
      {
        id: JOB,
        name: "resize-image",
        data: { url: "…" },
        attempt: 1,
        maxAttempts: 3,
        timeoutMs: 20000,
        idempotencyKey: `shop:media:${JOB}:1`,
        fence: FENCE,
        delivery: 1,
      },
    ],
    at: 1790000000456,
  },
  accepted: {
    op: "accepted",
    job: JOB,
    attempt: 1,
    fence: FENCE,
    duplicate: false,
    at: 1790000000470,
  },
  rejected: {
    op: "rejected",
    job: JOB,
    attempt: 1,
    code: "BUSY",
    retryAfterMs: 2000,
    at: 1790000000470,
  },
  progress: {
    op: "progress",
    job: JOB,
    attempt: 1,
    pseq: 4,
    progress: 40,
    at: 1790000001200,
  },
  log: {
    op: "log",
    job: JOB,
    attempt: 1,
    level: "info",
    message: "frame 400/1000",
    at: 1790000001201,
  },
  heartbeat: {
    op: "heartbeat",
    running: [{ job: JOB, attempt: 1, since: 1790000000470 }],
    capacity: CAPACITY,
    at: 1790000010470,
  },
  ping: { op: "ping", id: "p17", at: 1790000020000 },
  pong: { op: "pong", id: "p17", capacity: CAPACITY, at: 1790000020003 },
  health: { op: "health", id: "h3", at: 1790000030000 },
  "health-result": {
    op: "health-result",
    id: "h3",
    ok: true,
    capacity: CAPACITY,
    checks: [
      { id: "gpu", status: "pass" },
      { id: "model-loaded", status: "pass" },
    ],
    at: 1790000030004,
  },
  result: {
    op: "result",
    job: JOB,
    attempt: 1,
    fence: FENCE,
    status: "completed",
    result: { bytes: 20481 },
    durationMs: 2655,
    at: 1790000003111,
  },
  fail: {
    op: "fail",
    job: "01JB7Q2M8ZRT9X",
    attempt: 2,
    fence: FENCE,
    status: "failed",
    error: {
      name: "FetchError",
      message: "upstream returned 503",
      code: "UPSTREAM_UNAVAILABLE",
    },
    retryAfterMs: 30000,
    at: 1790000003111,
  },
  cancel: {
    op: "cancel",
    jobs: [{ job: JOB, attempt: 1 }],
    reason: "timeout",
    at: 1790000003111,
  },
  status: { op: "status", jobs: [{ job: JOB, attempt: 1 }], at: 1 },
  "status-result": {
    op: "status-result",
    jobs: [
      {
        job: JOB,
        attempt: 1,
        state: "done",
        outcome: {
          op: "result",
          status: "completed",
          result: { bytes: 20481 },
          fence: FENCE,
        },
      },
    ],
    at: 1,
  },
  ack: { op: "ack" },
  close: { op: "close", code: "DRAINING", drain: true, retryAfterMs: 0, at: 1 },
  problem: {
    op: "problem",
    problem: {
      type: "urn:bun-jobs:error:UNSUPPORTED_OP",
      title: "Unsupported op",
      status: 400,
      code: "UNSUPPORTED_OP",
    },
    fatal: false,
    at: 1,
  },
};

describe("coverage", () => {
  it("has a schema for every op, envelope or message, and nothing else", () => {
    const covered = new Set([
      ...Object.keys(REMOTE_ENVELOPE_SCHEMAS),
      ...Object.keys(REMOTE_MESSAGE_SCHEMAS),
    ]);
    expect([...covered].sort()).toEqual([...REMOTE_OPS].sort());
  });

  it("the twenty session messages are the first twenty ops", () => {
    expect(Object.keys(REMOTE_MESSAGE_SCHEMAS).sort()).toEqual(
      REMOTE_OPS.slice(0, 20).sort(),
    );
  });

  it("every schema has an example here, so none goes untested", () => {
    expect(Object.keys(ENVELOPES).sort()).toEqual(
      Object.keys(REMOTE_ENVELOPE_SCHEMAS).sort(),
    );
    expect(Object.keys(MESSAGES).sort()).toEqual(
      Object.keys(REMOTE_MESSAGE_SCHEMAS).sort(),
    );
  });
});

describe.each([
  ["envelope", ENVELOPES, parseRemoteEnvelope],
  ["message", MESSAGES, parseRemoteMessage],
] as const)("every %s", (_family, examples, parse) => {
  for (const [op, example] of Object.entries(examples)) {
    describe(op, () => {
      it("accepts the plan's example", () => {
        const result = parse(example);
        expect(result).toEqual({ ok: true, value: example as never });
      });

      it("keeps a field it does not know", () => {
        const result = parse({ ...example, fromTheFuture: { x: 1 } });
        expect(result.ok && (result.value as Record<string, unknown>)).toEqual({
          ...example,
          fromTheFuture: { x: 1 },
        });
      });

      it("refuses a missing required field, naming it", () => {
        // `op` aside, the first required key of the example.
        const required = Object.keys(example).find(
          (key) =>
            key !== "op" &&
            !parse(
              Object.fromEntries(
                Object.entries(example).filter(([k]) => k !== key),
              ),
            ).ok,
        );
        if (op === "ack") {
          // `ack` has nothing but its op.
          expect(required).toBeUndefined();
          return;
        }
        expect(required).toBeDefined();
        const without = Object.fromEntries(
          Object.entries(example).filter(([key]) => key !== required),
        );
        const result = parse(without);
        expect(result.ok).toBe(false);
        expect(
          !result.ok && result.issues.map((issue) => issue.path),
        ).toContain(required!);
      });

      it("refuses a string where an object is", () => {
        expect(parse(JSON.stringify(example)).ok).toBe(false);
      });
    });
  }
});

/** Refused, at a path: one negative case. */
function refuses(
  parse: typeof parseRemoteEnvelope | typeof parseRemoteMessage,
  value: unknown,
  path: string,
): void {
  const result = parse(value);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.issues.map((issue) => issue.path)).toContain(
    path,
  );
}

describe("negative cases", () => {
  const invoke = ENVELOPES.invoke!;
  const job = (invoke.jobs as Record<string, unknown>[])[0]!;
  const withJob = (patch: Record<string, unknown>) => ({
    ...invoke,
    jobs: [{ ...job, ...patch }],
  });

  it("an op that is not this family's is UNSUPPORTED, at `op`", () => {
    for (const op of ["nope", "hello", 42, undefined]) {
      refuses(parseRemoteEnvelope, { ...invoke, op }, "op");
    }
    for (const op of ["handshake", "invoke-result", "cancel-result"]) {
      refuses(parseRemoteMessage, { op }, "op");
    }
    refuses(parseRemoteEnvelope, null, "op");
    refuses(parseRemoteEnvelope, [invoke], "op");
  });

  it("an op named after Object.prototype is not an op", () => {
    refuses(parseRemoteEnvelope, { op: "constructor" }, "op");
    refuses(parseRemoteMessage, { op: "__proto__" }, "op");
  });

  it("a protocol version other than 1", () => {
    refuses(parseRemoteEnvelope, { ...invoke, v: 2 }, "v");
    refuses(parseRemoteEnvelope, { ...invoke, v: "1" }, "v");
  });

  it("an invoke with no jobs, or without its worker", () => {
    refuses(parseRemoteEnvelope, { ...invoke, jobs: [] }, "jobs");
    const { worker: _worker, ...noWorker } = invoke;
    refuses(parseRemoteEnvelope, noWorker, "worker");
    // A session invoke may leave the worker out: the hello named it.
    expect(parseRemoteMessage({ ...noWorker, op: "invoke" }).ok).toBe(true);
  });

  it("an invoke of a kind not yet designed", () => {
    refuses(parseRemoteEnvelope, { ...invoke, kind: "run" }, "kind");
  });

  it("a job without its idempotency key, fence or delivery", () => {
    for (const key of [
      "idempotencyKey",
      "fence",
      "delivery",
      "attempt",
      "data",
    ]) {
      const { [key]: _gone, ...rest } = job;
      refuses(
        parseRemoteEnvelope,
        { ...invoke, jobs: [rest] },
        `jobs.0.${key}`,
      );
    }
  });

  it("a zero or fractional attempt or delivery", () => {
    refuses(parseRemoteEnvelope, withJob({ attempt: 0 }), "jobs.0.attempt");
    refuses(parseRemoteEnvelope, withJob({ delivery: 1.5 }), "jobs.0.delivery");
  });

  it("a job id longer than the queue allows", () => {
    refuses(parseRemoteEnvelope, withJob({ id: "x".repeat(192) }), "jobs.0.id");
    expect(parseRemoteEnvelope(withJob({ id: "x".repeat(191) })).ok).toBe(true);
  });

  it("a negative or fractional instant", () => {
    refuses(parseRemoteEnvelope, { ...invoke, now: -1 }, "now");
    refuses(parseRemoteEnvelope, { ...invoke, deadlineAt: 1.5 }, "deadlineAt");
  });

  it("an outcome with no op, or keyed by id rather than job", () => {
    // `worker-runtimes.md` §5.5's outcome predates `remote-transports.md`
    // §4.2, which makes outcomes the `result`/`fail` bodies; the newer wins.
    const legacy = {
      ...ENVELOPES["invoke-result"],
      outcomes: [{ id: JOB, status: "completed", result: {} }],
    };
    refuses(parseRemoteEnvelope, legacy, "outcomes.0.op");
    refuses(parseRemoteEnvelope, legacy, "outcomes.0.job");
  });

  it("a completed result that says it failed, and a failure with no error", () => {
    const result = MESSAGES.result!;
    refuses(parseRemoteMessage, { ...result, status: "failed" }, "status");
    const { error: _error, ...noError } = MESSAGES.fail!;
    refuses(parseRemoteMessage, noError, "error");
    refuses(
      parseRemoteMessage,
      { ...MESSAGES.fail, status: "unknown" },
      "status",
    );
  });

  it("an outcome without its fence", () => {
    const { fence: _fence, ...noFence } = MESSAGES.result!;
    refuses(parseRemoteMessage, noFence, "fence");
    // A rejection may lack one (the plan's example does): the remote may
    // refuse before reading it.
    expect("fence" in MESSAGES.rejected!).toBe(false);
    expect(parseRemoteMessage(MESSAGES.rejected).ok).toBe(true);
  });

  it("a problem code that is not an upper-case word, and accepts one it does not know", () => {
    refuses(parseRemoteMessage, { ...MESSAGES.rejected, code: "busy" }, "code");
    refuses(parseRemoteMessage, { ...MESSAGES.close, code: "" }, "code");
    expect(
      parseRemoteMessage({ ...MESSAGES.rejected, code: "QUOTA_EXCEEDED" }).ok,
    ).toBe(true);
  });

  it("a nonce that is not 128 bits of base64url", () => {
    refuses(parseRemoteMessage, { ...MESSAGES.hello, nonce: "short" }, "nonce");
    refuses(
      parseRemoteMessage,
      { ...MESSAGES.hello, nonce: "q3JtZ2FfZ3c0bE1uUXpXRA==" },
      "nonce",
    );
    refuses(
      parseRemoteMessage,
      { ...MESSAGES.hello, nonce: "q3JtZ2FfZ3c0bE1uUXpX+A" },
      "nonce",
    );
  });

  it("a hello from a role that does not exist, or without its timestamp", () => {
    refuses(parseRemoteMessage, { ...MESSAGES.hello, role: "admin" }, "role");
    const { t: _t, ...noT } = MESSAGES.hello!;
    refuses(parseRemoteMessage, noT, "t");
  });

  it("a log level the logger does not have", () => {
    refuses(parseRemoteMessage, { ...MESSAGES.log, level: "verbose" }, "level");
  });

  it("a health check that neither passed nor failed", () => {
    refuses(
      parseRemoteEnvelope,
      {
        ...ENVELOPES["health-result"],
        checks: [{ id: "gpu", status: "maybe" }],
      },
      "checks.0.status",
    );
  });

  it("an attempt state that does not exist, or a retained outcome that is not one", () => {
    const entry = (ENVELOPES["status-result"]!.jobs as unknown[])[0] as Record<
      string,
      unknown
    >;
    refuses(
      parseRemoteEnvelope,
      { ...ENVELOPES["status-result"], jobs: [{ ...entry, state: "lost" }] },
      "jobs.0.state",
    );
    refuses(
      parseRemoteEnvelope,
      {
        ...ENVELOPES["status-result"],
        jobs: [{ ...entry, outcome: { op: "rejected", code: "BUSY" } }],
      },
      "jobs.0.outcome",
    );
  });

  it("a cancel with no jobs, or for a reason that does not exist", () => {
    refuses(parseRemoteEnvelope, { ...ENVELOPES.cancel, jobs: [] }, "jobs");
    refuses(
      parseRemoteEnvelope,
      { ...ENVELOPES.cancel, reason: "bored" },
      "reason",
    );
  });

  it("a handshake that lists no protocol, or a secret hash that is not one", () => {
    refuses(
      parseRemoteEnvelope,
      { ...ENVELOPES.handshake, protocols: [] },
      "protocols",
    );
    refuses(
      parseRemoteEnvelope,
      { ...ENVELOPES.handshake, secretHash: "b2ed9921…916c" },
      "secretHash",
    );
    refuses(
      parseRemoteEnvelope,
      { ...ENVELOPES.handshake, maxBatch: 0 },
      "maxBatch",
    );
  });

  it("the public handshake: only protocols, maxBatch, maxDurationMs and now", () => {
    const result = parseRemoteEnvelope({
      v: 1,
      op: "handshake",
      protocols: [1],
      maxBatch: 25,
      maxDurationMs: 25000,
      now: 1,
      authenticated: null,
    });
    expect(result.ok).toBe(true);
  });

  it("a problem whose status is not an HTTP status", () => {
    refuses(
      parseRemoteMessage,
      {
        ...MESSAGES.problem,
        problem: { ...(MESSAGES.problem!.problem as object), status: 42 },
      },
      "problem.status",
    );
  });
});
