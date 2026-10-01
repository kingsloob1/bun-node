import type { RemoteHealthCheck } from "../../lib/remote";
import { describe, expect, it } from "bun:test";
import { createRemoteExecutor, REMOTE_CANARY_JOB } from "../../lib/remote";
import { RemoteMessageTooLargeError } from "../../lib/shared/errors";
import {
  gate,
  invoke,
  job,
  nextId,
  read,
  SECRET,
  served,
  signedPost,
  until,
} from "../helpers/remoteExecutor";

/**
 * The executor's limits and probes: `maxDurationMs` (and the job's and the
 * invoke's own time), `maxBodyBytes`, `maxConcurrency`, the built-in canary,
 * `health`, `/healthz` and `/readyz`.
 *
 * Timing assertions are one-sided where a busy machine could stretch them:
 * an attempt is never answered *before* its budget, and is answered long
 * before a handler that ignores its signal would finish. Each has a control
 * that runs the same handler inside its budget.
 */

const URL = "http://executor.test/";

/** Pings, to read the capacity. */
async function capacityOf(executor: (request: Request) => Promise<Response>) {
  return (
    await read(
      await executor(await signedPost(URL, { v: 1, op: "ping", id: nextId() })),
    )
  ).body.capacity;
}

describe("maxDurationMs and the attempt's time", () => {
  it("aborts the handler's signal at maxDurationMs and answers a timeout", async () => {
    let abortedWith: unknown;
    const executor = createRemoteExecutor({
      secret: SECRET,
      maxDurationMs: 300,
      handlers: {
        slow: (_job, ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              abortedWith = ctx.signal.reason;
              resolve("too late");
            });
          }),
      },
    });
    const started = performance.now();
    const answer = await read(
      await executor(await signedPost(URL, invoke([job({ name: "slow" })]))),
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(answer.body.outcomes[0]).toMatchObject({
      op: "fail",
      status: "failed",
      error: {
        name: "JobTimeoutError",
        code: "JOB_TIMEOUT",
        message: "Timed out after 300ms",
        data: { ms: 300, context: { limit: "maxDurationMs", ms: 300 } },
      },
    });
    expect((abortedWith as Error).name).toBe("JobTimeoutError");
  });

  it("the control: the same handler finishing inside its time completes", async () => {
    const executor = createRemoteExecutor({
      secret: SECRET,
      maxDurationMs: 10_000,
      handlers: {
        quick: async (_job, ctx) => {
          await Bun.sleep(50);
          return ctx.signal.aborted ? "aborted" : "done";
        },
      },
    });
    const answer = await read(
      await executor(await signedPost(URL, invoke([job({ name: "quick" })]))),
    );
    expect(answer.body.outcomes[0]).toMatchObject({
      status: "completed",
      result: "done",
    });
  });

  it("answers at the budget even when the handler ignores its signal, and holds the slot until it returns", async () => {
    const held = gate();
    let returned = false;
    const executor = createRemoteExecutor({
      secret: SECRET,
      maxDurationMs: 200,
      handlers: {
        stubborn: async (job) => {
          await held.promise;
          await job.log("after the answer");
          await job.updateProgress(99);
          returned = true;
          return "ignored";
        },
      },
    });
    const answer = await read(
      await executor(
        await signedPost(URL, invoke([job({ name: "stubborn" })])),
      ),
    );
    expect(returned).toBe(false);
    expect(answer.body.outcomes[0]).toMatchObject({
      status: "failed",
      error: { name: "JobTimeoutError" },
    });
    expect("logs" in answer.body.outcomes[0]).toBe(false);
    // Still using the machine: still counted.
    expect((await capacityOf(executor)).inFlight).toBe(1);
    held.open();
    await until(() => returned);
    let inFlight = 1;
    const end = Date.now() + 10_000;
    while (inFlight !== 0 && Date.now() < end) {
      inFlight = (await capacityOf(executor)).inFlight;
    }
    expect(inFlight).toBe(0);
  });

  it("the job's own timeoutMs, when shorter, is the limit", async () => {
    const executor = createRemoteExecutor({
      secret: SECRET,
      maxDurationMs: 60_000,
      handlers: {
        wait: (_job, ctx) =>
          new Promise((resolve) =>
            ctx.signal.addEventListener("abort", resolve),
          ),
      },
    });
    const answer = await read(
      await executor(
        await signedPost(URL, invoke([job({ name: "wait", timeoutMs: 150 })])),
      ),
    );
    expect(answer.body.outcomes[0].error.data.context).toEqual({
      limit: "timeoutMs",
      ms: 150,
    });
  });

  it("the invoke's deadline, on the gateway's clock, when sooner, is the limit", async () => {
    const executor = createRemoteExecutor({
      secret: SECRET,
      maxDurationMs: 60_000,
      handlers: {
        wait: (_job, ctx) =>
          new Promise((resolve) =>
            ctx.signal.addEventListener("abort", resolve),
          ),
      },
    });
    // The gateway's clock is an hour behind this one: only the difference
    // between its now and its deadline counts.
    const now = Date.now() - 3_600_000;
    const answer = await read(
      await executor(
        await signedPost(
          URL,
          invoke([job({ name: "wait" })], { now, deadlineAt: now + 150 }),
        ),
      ),
    );
    expect(answer.body.outcomes[0].error.data.context).toEqual({
      limit: "deadlineAt",
      ms: 150,
    });
  });

  it("a deadline already past is a timeout, and the handler is never called", async () => {
    let called = false;
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {
        never: () => {
          called = true;
        },
      },
    });
    const now = Date.now();
    const answer = await read(
      await executor(
        await signedPost(
          URL,
          invoke([job({ name: "never" })], { now, deadlineAt: now - 1 }),
        ),
      ),
    );
    expect(answer.body.outcomes[0]).toMatchObject({
      status: "failed",
      error: { name: "JobTimeoutError", data: { ms: 0 } },
    });
    expect(called).toBe(false);
  });
});

describe("maxBodyBytes", () => {
  const executor = createRemoteExecutor({
    secret: SECRET,
    maxBodyBytes: 2_048,
    handlers: { echo: (job) => job.data },
  });

  it("a body above it is 413 TOO_LARGE, before its signature is even checked", async () => {
    const big = invoke([job({ name: "echo", data: "x".repeat(4_096) })]);
    for (const unsigned of [false, true]) {
      const response = await executor(await signedPost(URL, big, { unsigned }));
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      const answer = await read(response);
      expect(answer).toMatchObject({
        status: 413,
        hasSignature: false,
        body: {
          type: "urn:bun-jobs:error:TOO_LARGE",
          code: "TOO_LARGE",
          context: { max: 2_048 },
        },
      });
      // A Request built in-process has no content-length, so the size is
      // known only as "more than the cap"; over a socket it is declared.
      expect(answer.body.context.bytes).toBeNull();
    }
  });

  it("a streamed body with no length is cut off at the cap", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(1_024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 100) {
          controller.close();
        } else {
          controller.enqueue(chunk);
        }
      },
    });
    const answer = await read(
      await executor(new Request(URL, { method: "POST", body })),
    );
    expect(answer).toMatchObject({
      status: 413,
      body: { code: "TOO_LARGE", context: { bytes: null, max: 2_048 } },
    });
    // It stopped reading at the cap, not at the end.
    expect(pulled).toBeLessThan(10);
  });

  it("the control: the same envelope under the cap runs", async () => {
    const small = invoke([job({ name: "echo", data: "x".repeat(512) })]);
    const answer = await read(await executor(await signedPost(URL, small)));
    expect(answer.status).toBe(200);
  });

  it("through Bun.serve too", async () => {
    const transport = served(executor);
    try {
      const big = invoke([job({ name: "echo", data: "x".repeat(4_096) })]);
      const answer = await read(
        await transport.send(await signedPost(transport.url, big)),
      );
      expect(answer).toMatchObject({
        status: 413,
        body: { code: "TOO_LARGE" },
      });
      // Declared by content-length, so refused without reading the body.
      expect(answer.body.context.bytes).toBeGreaterThan(2_048);
    } finally {
      await transport.close();
    }
  });

  it("RemoteMessageTooLargeError names the size and the cap", () => {
    const error = new RemoteMessageTooLargeError(5_000, 1_024);
    expect(error).toMatchObject({
      name: "RemoteMessageTooLargeError",
      code: "TOO_LARGE",
      bytes: 5_000,
      max: 1_024,
      context: { bytes: 5_000, max: 1_024 },
    });
    expect(error.message).toBe(
      "The message is 5000 bytes, above the 1024-byte limit",
    );
    expect(new RemoteMessageTooLargeError(null, 10).message).toBe(
      "The message is larger than the 10-byte limit",
    );
  });
});

describe("maxConcurrency and maxBatch", () => {
  it("a job arriving with every slot taken is rejected BUSY, and /readyz says busy", async () => {
    const held = gate();
    let started = 0;
    const executor = createRemoteExecutor({
      secret: SECRET,
      maxConcurrency: 1,
      handlers: {
        hold: async () => {
          started++;
          await held.promise;
        },
      },
    });
    const first = executor(
      await signedPost(URL, invoke([job({ name: "hold" })])),
    );
    await until(() => started === 1);
    const busy = await read(
      await executor(await signedPost(URL, invoke([job({ name: "hold" })]))),
    );
    expect(busy.body.outcomes[0]).toMatchObject({
      op: "rejected",
      code: "BUSY",
      retryAfterMs: 1_000,
    });
    expect(busy.body.capacity).toEqual({
      inFlight: 1,
      max: 1,
      accepting: false,
    });
    expect(
      await read(await executor(new Request(`${URL}readyz`))),
    ).toMatchObject({ status: 503, body: { ready: false, reason: "busy" } });
    expect(started).toBe(1);
    held.open();
    await first;
    let ready = 503;
    const end = Date.now() + 10_000;
    while (ready !== 200 && Date.now() < end) {
      ready = (await executor(new Request(`${URL}readyz`))).status;
    }
    expect(ready).toBe(200);
  });

  it("runs a batch's jobs concurrently, and refuses those past maxBatch as BUSY", async () => {
    const held = gate();
    let running = 0;
    let peak = 0;
    const executor = createRemoteExecutor({
      secret: SECRET,
      maxBatch: 3,
      handlers: {
        hold: async (job) => {
          running++;
          peak = Math.max(peak, running);
          await held.promise;
          running--;
          return job.id;
        },
      },
    });
    const jobs = [1, 2, 3, 4].map(() => job({ name: "hold" }));
    const call = executor(await signedPost(URL, invoke(jobs)));
    await until(() => running === 3);
    held.open();
    const answer = await read(await call);
    expect(peak).toBe(3);
    const byId = new Map(
      answer.body.outcomes.map((outcome: any) => [outcome.job, outcome]),
    );
    for (const done of jobs.slice(0, 3)) {
      expect(byId.get(done.id)).toMatchObject({
        status: "completed",
        result: done.id,
      });
    }
    expect(byId.get(jobs[3]!.id)).toMatchObject({
      op: "rejected",
      code: "BUSY",
    });
  });
});

describe("the canary", () => {
  it("reports progress over time, one log line, the author's checks, and echoes the nonce", async () => {
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {},
      health: { check: () => [{ id: "gpu", status: "pass" }] },
    });
    const started = performance.now();
    const answer = await read(
      await executor(
        await signedPost(
          URL,
          invoke([
            job({
              name: REMOTE_CANARY_JOB,
              data: { nonce: "abc123", steps: 3, stepMs: 50 },
              idempotencyKey: "canary:s:1",
            }),
          ]),
        ),
      ),
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    expect(answer.signed).toBe(true);
    expect(answer.body.outcomes[0]).toMatchObject({
      op: "result",
      status: "completed",
      result: { nonce: "abc123", checks: [{ id: "gpu", status: "pass" }] },
      progress: 100,
      logs: [{ line: "canary abc123" }],
    });
  });

  it("carries a failing check in its result, and still completes", async () => {
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {},
      health: {
        check: () => [{ id: "gpu", status: "fail", detail: "no device" }],
      },
    });
    const answer = await read(
      await executor(
        await signedPost(
          URL,
          invoke([
            job({ name: REMOTE_CANARY_JOB, data: { nonce: "n", steps: 0 } }),
          ]),
        ),
      ),
    );
    expect(answer.body.outcomes[0].result.checks).toEqual([
      { id: "gpu", status: "fail", detail: "no device" },
    ]);
  });

  it("refuses malformed data fatally", async () => {
    const executor = createRemoteExecutor({ secret: SECRET, handlers: {} });
    for (const data of [
      null,
      { nonce: 1 },
      { nonce: "n", steps: 11 },
      { nonce: "n", stepMs: 5_000 },
    ]) {
      const answer = await read(
        await executor(
          await signedPost(
            URL,
            invoke([job({ name: REMOTE_CANARY_JOB, data })]),
          ),
        ),
      );
      expect(answer.body.outcomes[0]).toMatchObject({
        status: "failed-fatal",
        error: { name: "UnrecoverableJobError" },
      });
    }
  });

  it("works with no handlers at all, and is not advertised as a name", async () => {
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: { a: () => 1 },
    });
    const answer = await read(
      await executor(
        await signedPost(
          URL,
          invoke([
            job({
              name: REMOTE_CANARY_JOB,
              data: { nonce: "n", steps: 1, stepMs: 0 },
            }),
          ]),
        ),
      ),
    );
    expect(answer.body.outcomes[0].status).toBe("completed");
  });
});

describe("health and readiness", () => {
  it("/healthz is 200 whatever the checks say; /readyz is 503 checks-failed", async () => {
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {},
      health: {
        check: () => [{ id: "db", status: "fail", detail: "secret detail" }],
      },
    });
    expect(
      await read(await executor(new Request(`${URL}healthz`))),
    ).toMatchObject({
      status: 200,
      body: { ok: true },
    });
    const ready = await read(await executor(new Request(`${URL}readyz`)));
    expect(ready).toEqual({
      status: 503,
      body: { ready: false, reason: "checks-failed" },
      signed: false,
      hasSignature: false,
    });
    // The signed probe says more, to the gateway only.
    const health = await read(
      await executor(
        await signedPost(URL, { v: 1, op: "health", id: nextId() }),
      ),
    );
    expect(health.body).toMatchObject({
      ok: false,
      checks: [{ id: "db", status: "fail", detail: "secret detail" }],
    });
  });

  it("a check that throws, hangs or answers nonsense is one failed health.check", async () => {
    const cases: (() => RemoteHealthCheck[] | Promise<RemoteHealthCheck[]>)[] =
      [
        () => {
          throw new Error("db down");
        },
        () => "nonsense" as unknown as RemoteHealthCheck[],
      ];
    for (const check of cases) {
      const executor = createRemoteExecutor({
        secret: SECRET,
        handlers: {},
        health: { check },
      });
      const health = await read(
        await executor(
          await signedPost(URL, { v: 1, op: "health", id: nextId() }),
        ),
      );
      expect(health.body.ok).toBe(false);
      expect(health.body.checks).toMatchObject([
        { id: "health.check", status: "fail" },
      ]);
    }
  });

  it("concurrent probes share one run of the checks", async () => {
    const held = gate<RemoteHealthCheck[]>();
    let runs = 0;
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {},
      health: {
        check: () => {
          runs++;
          return held.promise;
        },
      },
    });
    const probes = [1, 2, 3].map(() => executor(new Request(`${URL}readyz`)));
    await until(() => runs === 1);
    held.open([{ id: "x", status: "pass" }]);
    const statuses = (await Promise.all(probes)).map(
      (response) => response.status,
    );
    expect(statuses).toEqual([200, 200, 200]);
    expect(runs).toBe(1);
  });
});
