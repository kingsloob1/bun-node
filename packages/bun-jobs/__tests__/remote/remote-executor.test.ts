import type { RemoteExecutor, RemoteJobHandler } from "../../lib/remote";
import type { Transport } from "../helpers/remoteExecutor";
import { createHash } from "node:crypto";
import { BunRouter } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  createRemoteExecutor,
  REMOTE_CANARY_JOB,
  signEnvelope,
} from "../../lib/remote";
import { createRemoteExecutorWith } from "../../lib/remote/executor/executor";
import { nodeHmacSha256 } from "../../lib/remote/host/mac";
import { ConfigError, UnrecoverableJobError } from "../../lib/shared/errors";
import {
  gate,
  invoke,
  job,
  nextId,
  read,
  SECRET,
  signedGet,
  signedPost,
  TRANSPORTS,
  WRONG_SECRET,
} from "../helpers/remoteExecutor";

/**
 * The reference executor end to end: every operation, through a real
 * `Bun.serve` on port 0 and as a plain fetch-handler call, with the
 * signature rules, the protocol errors and the handshake's disclosure.
 */

/** Handlers shared by the end-to-end suite. */
function handlers(release: Promise<void>): Record<string, RemoteJobHandler> {
  return {
    echo: async (job) => {
      await job.log(`echo ${JSON.stringify(job.data)}`);
      await job.updateProgress(50);
      return { echoed: job.data };
    },
    boom: async () => {
      const error = new Error("upstream returned 503") as Error & {
        code: string;
        status: number;
      };
      error.code = "UPSTREAM_UNAVAILABLE";
      error.status = 503;
      throw error;
    },
    fatal: async () => {
      throw new UnrecoverableJobError("never going to work");
    },
    bigint: async () => ({ n: 1n }),
    nothing: async () => undefined,
    hold: async (_job, ctx) => {
      await Promise.race([
        release,
        new Promise((resolve) => ctx.signal.addEventListener("abort", resolve)),
      ]);
      return "released";
    },
  };
}

for (const [name, make] of Object.entries(TRANSPORTS)) {
  describe(`every operation, ${name}`, () => {
    let transport: Transport;
    let executor: RemoteExecutor;
    const held = gate();

    beforeAll(() => {
      executor = createRemoteExecutor({
        secret: SECRET,
        name: "test-executor",
        maxBatch: 5,
        handlers: handlers(held.promise),
        health: { check: () => [{ id: "db", status: "pass" }] },
      });
      transport = make(executor);
    });
    afterAll(async () => {
      held.open();
      await transport.close();
    });

    it("answers the signed handshake with the full document, signed", async () => {
      const answer = await read(
        await transport.send(await signedGet(transport.url)),
      );
      expect(answer.status).toBe(200);
      expect(answer.signed).toBe(true);
      expect(answer.body).toMatchObject({
        v: 1,
        op: "handshake",
        protocols: [1],
        authenticated: true,
        name: "test-executor",
        sdk: "@kingsleyweb/bun-jobs/remote",
        maxBatch: 5,
        maxDurationMs: 300_000,
        maxBodyBytes: 1_048_576,
        features: {
          cancel: "v1",
          health: "v1",
          canary: "v1",
          idempotency: "v1",
          fencing: "v1",
          "attempt-status": "v1",
          "replay-protection": "v1",
        },
        secretHash: createHash("sha256").update(SECRET).digest("hex"),
      });
      expect(answer.body.names.sort()).toEqual(
        ["bigint", "boom", "echo", "fatal", "hold", "nothing"].sort(),
      );
      expect(Math.abs(answer.body.now - Date.now())).toBeLessThan(60_000);
    });

    it("answers an unsigned handshake with the public document only, unsigned", async () => {
      const answer = await read(
        await transport.send(new Request(transport.url)),
      );
      expect(answer.status).toBe(200);
      expect(answer.hasSignature).toBe(false);
      expect(Object.keys(answer.body).sort()).toEqual(
        [
          "authenticated",
          "maxBatch",
          "maxDurationMs",
          "now",
          "op",
          "protocols",
          "v",
        ].sort(),
      );
      expect(answer.body.authenticated).toBeNull();
    });

    it("tells a wrong key apart from none: authenticated false, public document", async () => {
      const answer = await read(
        await transport.send(
          await signedGet(transport.url, { secret: WRONG_SECRET }),
        ),
      );
      expect(answer.body.authenticated).toBe(false);
      expect(answer.body.names).toBeUndefined();
      expect(answer.body.secretHash).toBeUndefined();
      expect(answer.hasSignature).toBe(false);
    });

    it("runs an invoke: completed, failed, fatal, missing handler, keyed by id", async () => {
      const jobs = [
        job({ name: "echo", data: { a: 1 } }),
        job({ name: "boom" }),
        job({ name: "fatal" }),
        job({ name: "no-such-name" }),
        job({ name: "nothing" }),
      ];
      const envelope = invoke(jobs);
      const answer = await read(
        await transport.send(await signedPost(transport.url, envelope)),
      );
      expect(answer.status).toBe(200);
      expect(answer.signed).toBe(true);
      expect(answer.body).toMatchObject({
        v: 1,
        op: "invoke-result",
        id: envelope.id,
        capacity: { max: 64 },
      });
      const byId = new Map<string, any>(
        answer.body.outcomes.map((outcome: any) => [outcome.job, outcome]),
      );
      expect(byId.size).toBe(5);
      expect(byId.get(jobs[0]!.id)).toMatchObject({
        op: "result",
        attempt: 1,
        fence: jobs[0]!.fence,
        status: "completed",
        result: { echoed: { a: 1 } },
        progress: 50,
        logs: [{ line: 'echo {"a":1}' }],
      });
      expect(byId.get(jobs[1]!.id)).toMatchObject({
        op: "fail",
        status: "failed",
        error: {
          name: "Error",
          message: "upstream returned 503",
          code: "UPSTREAM_UNAVAILABLE",
          data: { status: 503 },
        },
      });
      expect(typeof byId.get(jobs[1]!.id).error.stack).toBe("string");
      expect(byId.get(jobs[2]!.id)).toMatchObject({
        op: "fail",
        status: "failed-fatal",
        error: { name: "UnrecoverableJobError", code: "UNRECOVERABLE_JOB" },
      });
      expect(byId.get(jobs[3]!.id)).toMatchObject({
        op: "fail",
        status: "handler-not-found",
        error: { name: "HandlerNotFoundError" },
      });
      expect(byId.get(jobs[4]!.id)).toMatchObject({
        op: "result",
        status: "completed",
      });
      expect("result" in byId.get(jobs[4]!.id)).toBe(false);
    });

    it("fails a result that is not JSON, rather than sending a broken one", async () => {
      const one = job({ name: "bigint" });
      const answer = await read(
        await transport.send(await signedPost(transport.url, invoke([one]))),
      );
      expect(answer.body.outcomes[0]).toMatchObject({
        status: "failed",
        error: { name: "TypeError" },
      });
    });

    it("answers ping with pong and capacity", async () => {
      const envelope = { v: 1, op: "ping", id: nextId("ping") };
      const answer = await read(
        await transport.send(await signedPost(transport.url, envelope)),
      );
      expect(answer.signed).toBe(true);
      expect(answer.body).toMatchObject({
        v: 1,
        op: "pong",
        id: envelope.id,
        capacity: { inFlight: 0, max: 64, accepting: true },
      });
    });

    it("answers health with the author's checks", async () => {
      const envelope = { v: 1, op: "health", id: nextId("health") };
      const answer = await read(
        await transport.send(await signedPost(transport.url, envelope)),
      );
      expect(answer.signed).toBe(true);
      expect(answer.body).toMatchObject({
        op: "health-result",
        id: envelope.id,
        ok: true,
        checks: [{ id: "db", status: "pass" }],
      });
    });

    it("cancels a running attempt, answers status while it runs and after", async () => {
      const one = job({ name: "hold" });
      const running = transport.send(
        await signedPost(transport.url, invoke([one])),
      );
      // Should this test fail before awaiting it, the server's close resets
      // the call; handled here, so that is not blamed on a later test.
      running.catch(() => {});
      const ref = { queue: { ns: "ns", queue: "q" }, job: one.id, attempt: 1 };
      const status = async () =>
        (
          await read(
            await transport.send(
              await signedPost(transport.url, {
                v: 1,
                op: "status",
                id: nextId("status"),
                jobs: [ref],
              }),
            ),
          )
        ).body.jobs[0];
      // Running once the executor has it.
      let state = "unknown";
      const end = Date.now() + 10_000;
      while (state !== "running" && Date.now() < end) {
        state = (await status()).state;
      }
      expect(state).toBe("running");

      const cancel = await read(
        await transport.send(
          await signedPost(transport.url, {
            v: 1,
            op: "cancel",
            id: nextId("cancel"),
            jobs: [ref, { ...ref, job: "never-sent" }],
            reason: "timeout",
          }),
        ),
      );
      expect(cancel.signed).toBe(true);
      expect(cancel.body).toMatchObject({
        op: "cancel-result",
        jobs: [
          { ...ref, cancelled: true },
          { ...ref, job: "never-sent", cancelled: false },
        ],
      });
      const answered = await read(await running);
      expect(answered.body.outcomes[0]).toMatchObject({
        status: "failed",
        error: {
          name: "AbortError",
          message: "Cancelled by the gateway (timeout)",
        },
      });
      expect(await status()).toMatchObject({
        state: "done",
        outcome: { op: "fail", status: "failed" },
      });
      expect(
        (
          await read(
            await transport.send(
              await signedPost(transport.url, {
                v: 1,
                op: "status",
                id: nextId("status"),
                jobs: [{ ...ref, job: "never-sent", attempt: 3 }],
              }),
            ),
          )
        ).body.jobs,
      ).toEqual([{ ...ref, job: "never-sent", attempt: 3, state: "unknown" }]);
    });

    it("serves /healthz and /readyz under any mount path, unauthenticated", async () => {
      const base = new URL(transport.url);
      for (const path of [
        "/healthz",
        "/bun-jobs/healthz",
        "/deep/mount/healthz/",
      ]) {
        const answer = await read(
          await transport.send(new Request(`${base.origin}${path}`)),
        );
        expect(answer).toMatchObject({
          status: 200,
          body: { ok: true },
          hasSignature: false,
        });
      }
      const ready = await read(
        await transport.send(new Request(`${base.origin}/bun-jobs/readyz`)),
      );
      expect(ready).toMatchObject({
        status: 200,
        body: { ready: true },
        hasSignature: false,
      });
    });

    it("answers HEAD like GET, without a body", async () => {
      const response = await transport.send(
        new Request(`${transport.url}/healthz`, { method: "HEAD" }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    });

    it("refuses another method with 405, naming the ones it takes", async () => {
      const response = await transport.send(
        new Request(transport.url, { method: "PUT", body: "{}" }),
      );
      const answer = await read(response);
      expect(answer.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD, POST");
      expect(answer.body.code).toBe("UNSUPPORTED_OP");
    });
  });
}

describe("signature failures", () => {
  let runs = 0;
  const executor = createRemoteExecutor({
    secret: SECRET,
    handlers: {
      count: () => {
        runs++;
        return runs;
      },
    },
  });
  const url = "http://executor.test/";

  /** A problem answer: status, code, unsigned, `application/problem+json`. */
  async function refused(request: Request) {
    const response = await executor(request);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    return await read(response);
  }

  it("no signature is 401 SIGNATURE_MISSING, and nothing runs", async () => {
    const before = runs;
    const answer = await refused(
      await signedPost(url, invoke([job({ name: "count" })]), {
        unsigned: true,
      }),
    );
    expect(answer).toMatchObject({
      status: 401,
      hasSignature: false,
      body: {
        type: "urn:bun-jobs:error:SIGNATURE_MISSING",
        code: "SIGNATURE_MISSING",
        status: 401,
      },
    });
    expect(runs).toBe(before);
  });

  it("the wrong key is 401 SIGNATURE_INVALID", async () => {
    const before = runs;
    const answer = await refused(
      await signedPost(url, invoke([job({ name: "count" })]), {
        secret: WRONG_SECRET,
      }),
    );
    expect(answer).toMatchObject({
      status: 401,
      hasSignature: false,
      body: { code: "SIGNATURE_INVALID" },
    });
    expect(runs).toBe(before);
  });

  it("a response replayed as a request is 401 SIGNATURE_INVALID", async () => {
    // A real signed answer of this executor, captured and sent back at it.
    const pong = await executor(
      await signedPost(url, { v: 1, op: "ping", id: nextId("ping") }),
    );
    const body = await pong.text();
    const answer = await refused(
      new Request(url, {
        method: "POST",
        body,
        headers: {
          "bun-jobs-signature": pong.headers.get("bun-jobs-signature")!,
        },
      }),
    );
    expect(answer).toMatchObject({
      status: 401,
      body: { code: "SIGNATURE_INVALID" },
    });
  });

  it("a response's op, even signed as a request, is 400 UNSUPPORTED_OP", async () => {
    const answer = await read(
      await executor(
        await signedPost(url, {
          v: 1,
          op: "invoke-result",
          id: nextId(),
          now: Date.now(),
          outcomes: [],
        }),
      ),
    );
    expect(answer).toMatchObject({
      status: 400,
      signed: true,
      body: { code: "UNSUPPORTED_OP" },
    });
  });

  it("a signature from 400 s ago, or 400 s ahead, is 401 SIGNATURE_TIMESTAMP", async () => {
    for (const offset of [-400_000, 400_000]) {
      const before = runs;
      const answer = await refused(
        await signedPost(url, invoke([job({ name: "count" })]), {
          now: Date.now() + offset,
        }),
      );
      expect(answer).toMatchObject({
        status: 401,
        body: { code: "SIGNATURE_TIMESTAMP" },
      });
      expect(Math.sign(answer.body.context.skewMs)).toBe(-Math.sign(offset));
      expect(runs).toBe(before);
    }
  });

  it("a signature from 200 s ago is inside the window (the control)", async () => {
    const answer = await read(
      await executor(
        await signedPost(url, invoke([job({ name: "count" })]), {
          now: Date.now() - 200_000,
        }),
      ),
    );
    expect(answer.status).toBe(200);
  });

  it("the same signed request twice is 401 REPLAYED the second time, and runs once", async () => {
    const request = await signedPost(url, invoke([job({ name: "count" })]));
    const replay = request.clone() as Request;
    const before = runs;
    expect((await executor(request)).status).toBe(200);
    expect(runs).toBe(before + 1);
    const answer = await refused(replay);
    expect(answer).toMatchObject({ status: 401, body: { code: "REPLAYED" } });
    expect(runs).toBe(before + 1);
  });

  it("a replayed handshake GET is not authenticated", async () => {
    const first = await signedGet(url);
    const second = first.clone() as Request;
    expect((await read(await executor(first))).body.authenticated).toBe(true);
    const answer = await read(await executor(second));
    expect(answer.body.authenticated).toBe(false);
    expect(answer.hasSignature).toBe(false);
  });

  it("a signed GET without its id is not authenticated", async () => {
    const request = await signedGet(url);
    const headers = new Headers(request.headers);
    headers.delete("bun-jobs-id");
    const answer = await read(await executor(new Request(url, { headers })));
    expect(answer.body.authenticated).toBe(false);
  });

  it("verifies against any key of a rotation list and signs with the first", async () => {
    const rotating = createRemoteExecutor({
      secret: [WRONG_SECRET, SECRET],
      handlers: {},
    });
    const response = await rotating(
      await signedPost(url, { v: 1, op: "ping", id: nextId("ping") }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const header = response.headers.get("bun-jobs-signature");
    expect(
      await read(
        new Response(text, { headers: { "bun-jobs-signature": header! } }),
        WRONG_SECRET,
      ),
    ).toMatchObject({ signed: true });
    expect(
      await read(
        new Response(text, { headers: { "bun-jobs-signature": header! } }),
        SECRET,
      ),
    ).toMatchObject({ signed: false });
  });
});

describe("protocol errors", () => {
  const executor = createRemoteExecutor({ secret: SECRET, handlers: {} });
  const url = "http://executor.test/";

  it("a protocol header it does not speak is 400 UNSUPPORTED_PROTOCOL, listing what it does", async () => {
    const answer = await read(
      await executor(
        await signedPost(
          url,
          { v: 1, op: "ping", id: nextId() },
          {
            headers: { "bun-jobs-protocol": "2" },
          },
        ),
      ),
    );
    expect(answer).toMatchObject({
      status: 400,
      body: { code: "UNSUPPORTED_PROTOCOL", supported: [1] },
    });
  });

  it("an envelope version it does not speak is 400 UNSUPPORTED_PROTOCOL, signed", async () => {
    const answer = await read(
      await executor(await signedPost(url, { v: 2, op: "ping", id: nextId() })),
    );
    expect(answer).toMatchObject({
      status: 400,
      signed: true,
      body: { code: "UNSUPPORTED_PROTOCOL", supported: [1] },
    });
  });

  it("an unknown op is 400 UNSUPPORTED_OP, never a 5xx", async () => {
    const answer = await read(
      await executor(
        await signedPost(url, { v: 1, op: "teleport", id: nextId() }),
      ),
    );
    expect(answer).toMatchObject({
      status: 400,
      signed: true,
      body: {
        code: "UNSUPPORTED_OP",
        detail: expect.stringContaining("teleport"),
      },
    });
  });

  it("an authentic body that is not JSON is 400 VALIDATION", async () => {
    const answer = await read(
      await executor(await signedPost(url, "{not json")),
    );
    expect(answer).toMatchObject({
      status: 400,
      signed: true,
      body: {
        code: "VALIDATION",
        issues: [{ target: "body", path: "", message: "Not valid JSON" }],
      },
    });
  });

  it("an envelope that does not match its schema is 400 VALIDATION with its issues", async () => {
    const answer = await read(
      await executor(
        await signedPost(url, {
          v: 1,
          op: "invoke",
          id: nextId(),
          now: Date.now(),
          deadlineAt: Date.now() + 1_000,
          namespace: "ns",
          queue: "q",
          worker: { id: "w", key: "k" },
          jobs: [],
        }),
      ),
    );
    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe("VALIDATION");
    expect(answer.body.issues).toContainEqual(
      expect.objectContaining({ target: "body", path: "jobs" }),
    );
  });

  it("one job id twice in one invoke is 400 VALIDATION", async () => {
    const one = job({ name: "x" });
    const answer = await read(
      await executor(await signedPost(url, invoke([one, { ...one }]))),
    );
    expect(answer).toMatchObject({
      status: 400,
      body: { code: "VALIDATION", issues: [{ path: "jobs.1.id" }] },
    });
  });

  it("tolerates unknown fields everywhere", async () => {
    const answer = await read(
      await executor(
        await signedPost(url, {
          v: 1,
          op: "ping",
          id: nextId(),
          from: "the future",
          nested: { anything: true },
        }),
      ),
    );
    expect(answer.status).toBe(200);
  });

  it("an executor failure is a 500 INTERNAL problem, not a throw", async () => {
    const broken = createRemoteExecutor({
      secret: SECRET,
      handlers: {},
      nonces: {
        remember: () => {
          throw new Error("nonce store down");
        },
      },
    });
    const logs: string[] = [];
    const logged = createRemoteExecutor({
      secret: SECRET,
      handlers: {},
      onLog: (_level, message) => logs.push(message),
      nonces: {
        remember: () => {
          throw new Error("nonce store down");
        },
      },
    });
    for (const executor of [broken, logged]) {
      const answer = await read(
        await executor(
          await signedPost(url, { v: 1, op: "ping", id: nextId() }),
        ),
      );
      expect(answer).toMatchObject({ status: 500, body: { code: "INTERNAL" } });
    }
    expect(logs).toEqual(["The remote executor failed to answer a request"]);
  });
});

describe("handlers", () => {
  it('a "*" handler runs any name without its own, and the handshake says "*"', async () => {
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: { "*": (job) => `any:${job.name}`, named: () => "named" },
    });
    const url = "http://executor.test/";
    const answer = await read(
      await executor(
        await signedPost(
          url,
          invoke([job({ name: "whatever" }), job({ name: "named" })], {}),
        ),
      ),
    );
    // maxBatch defaults to 1: the second is refused, never run.
    expect(answer.body.outcomes).toMatchObject([
      { status: "completed", result: "any:whatever" },
      { op: "rejected", code: "BUSY" },
    ]);
    expect(
      (await read(await executor(await signedGet(url)))).body.names,
    ).toEqual(["*"]);
  });

  it("hands a handler the reduced job and its context", async () => {
    let seen:
      | { job: Record<string, unknown>; ctx: Record<string, unknown> }
      | undefined;
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {
        look: (job, ctx) => {
          seen = {
            job: { ...job },
            ctx: { ...ctx, aborted: ctx.signal.aborted },
          };
        },
      },
    });
    const one = job({
      name: "look",
      data: { x: 1 },
      attempt: 2,
      delivery: 3,
      maxAttempts: 5,
      priority: 7,
      createdAt: 123,
      repeatKey: "rk",
      parent: { queue: "pq", id: "pid" },
    });
    const envelope = invoke([one]);
    await executor(await signedPost("http://executor.test/", envelope));
    expect(seen!.job).toMatchObject({
      id: one.id,
      name: "look",
      data: { x: 1 },
      queue: { ns: "ns", queue: "q" },
      attemptsMade: 2,
      maxAttempts: 5,
      createdAt: 123,
      priority: 7,
      repeatKey: "rk",
      parent: { queue: "pq", id: "pid" },
      idempotencyKey: one.idempotencyKey,
      fence: one.fence,
    });
    expect(typeof seen!.job.log).toBe("function");
    expect(typeof seen!.job.updateProgress).toBe("function");
    // Driver-bound members are absent, not present and broken.
    for (const absent of [
      "retry",
      "remove",
      "extendLock",
      "update",
      "getLogs",
    ]) {
      expect(absent in seen!.job).toBe(false);
    }
    expect(seen!.ctx).toMatchObject({
      attempt: 2,
      delivery: 3,
      workerId: "worker-1",
      invokeId: envelope.id,
      deadlineAt: envelope.deadlineAt,
      aborted: false,
    });
  });

  it("forwards every handler log line to onLog, with the job's fields", async () => {
    const lines: [string, string, Record<string, unknown> | undefined][] = [];
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {
        talk: async (job, ctx) => {
          await job.log("one");
          await ctx.log("two");
          await ctx.heartbeat();
        },
      },
      onLog: (level, message, fields) => lines.push([level, message, fields]),
    });
    const one = job({ name: "talk" });
    const answer = await read(
      await executor(await signedPost("http://executor.test/", invoke([one]))),
    );
    expect(
      answer.body.outcomes[0].logs.map((entry: any) => entry.line),
    ).toEqual(["one", "two"]);
    expect(lines).toEqual([
      [
        "info",
        "one",
        expect.objectContaining({ job: one.id, attempt: 1, queue: "q" }),
      ],
      ["info", "two", expect.objectContaining({ job: one.id })],
    ]);
  });
});

describe("mounting", () => {
  it("mounts in bun-common's router, raw body intact", async () => {
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: { echo: (job) => job.data },
    });
    const router = new BunRouter();
    // The router parses bodies by default, so the executor is handed a
    // Request rebuilt from the raw bytes the router kept (`req.buffer`).
    const mount = async (req: any, res: any) => {
      res.send(
        await executor(
          new Request(req.request.url, {
            method: req.method,
            headers: req.request.headers,
            body: req.buffer ?? null,
          }),
        ),
      );
    };
    router.all("/jobs", mount);
    router.all("/jobs/healthz", mount);
    const one = job({ name: "echo", data: "hi" });
    const request = await signedPost("http://app.test/jobs", invoke([one]));
    const response = await router.fetch(request);
    const answer = await read(response);
    expect(answer).toMatchObject({
      status: 200,
      signed: true,
      body: { outcomes: [{ result: "hi" }] },
    });
    expect((await router.fetch("/jobs/healthz")).status).toBe(200);
  });

  it("a body a host already consumed is a 500 that says so, not a misleading 401", async () => {
    const logs: string[] = [];
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {},
      onLog: (_level, message) => logs.push(message),
    });
    const request = await signedPost("http://app.test/", {
      v: 1,
      op: "ping",
      id: nextId(),
    });
    await request.text();
    const answer = await read(await executor(request));
    expect(answer).toMatchObject({
      status: 500,
      body: {
        code: "INTERNAL",
        detail: expect.stringContaining("already read"),
      },
    });
    expect(logs).toHaveLength(1);
  });
});

describe("the MAC seam", () => {
  it("an executor on node:crypto verifies WebCrypto's signatures, and they verify its", async () => {
    const executor = createRemoteExecutorWith(nodeHmacSha256, {
      secret: SECRET,
      handlers: { echo: (job) => job.data },
    });
    const answer = await read(
      await executor(
        await signedPost(
          "http://executor.test/",
          invoke([job({ name: "echo", data: 5 })]),
        ),
      ),
    );
    expect(answer).toMatchObject({
      status: 200,
      signed: true,
      body: { outcomes: [{ result: 5 }] },
    });
  });
});

describe("options", () => {
  const ok = { secret: SECRET, handlers: {} };

  it("refuses a key shorter than 32 bytes", () => {
    expect(() => createRemoteExecutor({ ...ok, secret: "short" })).toThrow(
      ConfigError,
    );
    expect(() =>
      createRemoteExecutor({ ...ok, secret: [SECRET, "short"] }),
    ).toThrow(ConfigError);
    expect(() => createRemoteExecutor({ ...ok, secret: [] })).toThrow(
      ConfigError,
    );
  });

  it("refuses a handler under the canary's name", () => {
    expect(() =>
      createRemoteExecutor({
        ...ok,
        handlers: { [REMOTE_CANARY_JOB]: () => 1 },
      }),
    ).toThrow(/reserved/);
  });

  it("refuses unusable numbers and shapes", () => {
    for (const bad of [
      { maxBatch: 0 },
      { maxBatch: 1.5 },
      { maxDurationMs: 0 },
      { maxDurationMs: 2 ** 31 },
      { maxBodyBytes: -1 },
      { maxConcurrency: 0 },
      { idempotencyTtl: -1 },
      { name: 3 },
      { store: {} },
      { nonces: { remember: 1 } },
      { onLog: "x" },
      { health: { check: 1 } },
      { handlers: { x: 1 } },
      { handlers: null },
    ]) {
      expect(() => createRemoteExecutor({ ...ok, ...(bad as object) })).toThrow(
        ConfigError,
      );
    }
  });

  it("takes the defaults it documents", async () => {
    const executor = createRemoteExecutor(ok);
    const answer = await read(
      await executor(await signedGet("http://e.test/")),
    );
    expect(answer.body).toMatchObject({
      maxBatch: 1,
      maxDurationMs: 300_000,
      maxBodyBytes: 1_048_576,
    });
    const pong = await read(
      await executor(
        await signedPost("http://e.test/", { v: 1, op: "ping", id: nextId() }),
      ),
    );
    expect(pong.body.capacity).toEqual({
      inFlight: 0,
      max: 64,
      accepting: true,
    });
  });
});

describe("signEnvelope interop", () => {
  it("a hand-built request, signed with the public helper, runs", async () => {
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: { add: (job) => (job.data as number) + 1 },
    });
    const body = JSON.stringify(invoke([job({ name: "add", data: 1 })]));
    const response = await executor(
      new Request("http://e.test/", {
        method: "POST",
        body,
        headers: {
          "bun-jobs-signature": await signEnvelope(body, {
            direction: "request",
            secret: SECRET,
          }),
        },
      }),
    );
    expect((await read(response)).body.outcomes[0].result).toBe(2);
  });
});
