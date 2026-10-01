import type { RemoteInvokeJob } from "../../lib/remote";
import { describe, expect, it } from "bun:test";
import { createRemoteExecutor } from "../../lib/remote";
import {
  gate,
  invoke,
  job,
  nextId,
  read,
  SECRET,
  signedPost,
  until,
} from "../helpers/remoteExecutor";

/**
 * `cancel` and `status` name an attempt by its queue as well as its job id
 * and attempt: a job id is unique only within a queue, so two queues can run
 * "the same" attempt at once. Each must reach only its own.
 */

const URL = "http://executor.test/";
const A = { ns: "ns", queue: "queue-a" };
const B = { ns: "ns", queue: "queue-b" };

describe("cancel and status are scoped to a queue", () => {
  /** One executor running job `id` attempt 1 in both queues, each held until aborted or released. */
  async function twoQueues() {
    const release = { a: gate(), b: gate() };
    const started: string[] = [];
    const executor = createRemoteExecutor({
      secret: SECRET,
      handlers: {
        hold: async (job, ctx) => {
          started.push(job.queue.queue);
          const own = job.queue.queue === A.queue ? release.a : release.b;
          await Promise.race([
            own.promise,
            new Promise((resolve) =>
              ctx.signal.addEventListener("abort", resolve),
            ),
          ]);
          return { queue: job.queue.queue, aborted: ctx.signal.aborted };
        },
      },
    });
    const id = nextId("same");
    const inQueue = (queue: string): RemoteInvokeJob =>
      job({
        id,
        name: "hold",
        idempotencyKey: `ns:${queue}:${id}:1`,
        fence: `token-${queue}:1000`,
      });
    const callA = executor(
      await signedPost(URL, invoke([inQueue(A.queue)], { queue: A.queue })),
    );
    await until(() => started.length === 1);
    const callB = executor(
      await signedPost(URL, invoke([inQueue(B.queue)], { queue: B.queue })),
    );
    await until(() => started.length === 2);
    const send = async (body: object) =>
      (await read(await executor(await signedPost(URL, body)))).body;
    return { executor, id, release, callA, callB, send };
  }

  it("a cancel aimed at queue A aborts A's attempt and leaves B's running", async () => {
    const { id, release, callA, callB, send } = await twoQueues();
    const cancel = await send({
      v: 1,
      op: "cancel",
      id: nextId("cancel"),
      jobs: [{ queue: A, job: id, attempt: 1 }],
    });
    expect(cancel.jobs).toEqual([
      { queue: A, job: id, attempt: 1, cancelled: true },
    ]);
    const a = await read(await callA);
    expect(a.body.outcomes[0]).toMatchObject({
      status: "failed",
      error: { name: "AbortError" },
    });
    // B is untouched: still running until released, then completes on its own.
    const status = await send({
      v: 1,
      op: "status",
      id: nextId("status"),
      jobs: [{ queue: B, job: id, attempt: 1 }],
    });
    expect(status.jobs[0]).toMatchObject({ queue: B, state: "running" });
    release.b.open();
    const b = await read(await callB);
    expect(b.body.outcomes[0]).toMatchObject({
      status: "completed",
      result: { queue: B.queue, aborted: false },
    });
  });

  it("status for queue A answers A's record while B's same attempt still runs", async () => {
    const { id, release, callA, callB, send } = await twoQueues();
    release.a.open();
    await callA;
    const status = await send({
      v: 1,
      op: "status",
      id: nextId("status"),
      jobs: [
        { queue: A, job: id, attempt: 1 },
        { queue: B, job: id, attempt: 1 },
      ],
    });
    expect(status.jobs[0]).toMatchObject({
      queue: A,
      job: id,
      attempt: 1,
      state: "done",
      outcome: { status: "completed", result: { queue: A.queue } },
    });
    expect(status.jobs[1]).toMatchObject({ queue: B, state: "running" });
    release.b.open();
    await callB;
  });

  it("a ref without its queue is refused as VALIDATION", async () => {
    const executor = createRemoteExecutor({ secret: SECRET, handlers: {} });
    for (const op of ["cancel", "status"]) {
      const answer = await read(
        await executor(
          await signedPost(URL, {
            v: 1,
            op,
            id: nextId(op),
            jobs: [{ job: "j", attempt: 1 }],
          }),
        ),
      );
      expect(answer).toMatchObject({
        status: 400,
        body: { code: "VALIDATION" },
      });
      expect(answer.body.issues).toContainEqual(
        expect.objectContaining({ path: "jobs.0.queue" }),
      );
    }
  });
});
