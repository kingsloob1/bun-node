import type {
  ChildToParent,
  ParentToChild,
  SerializableContext,
} from "../lib/runner/protocol";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { serializeError } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { runChildProtocol } from "../lib/runner/bootstrap/child-runtime";
import { CLOSE_EXIT_CODE, JOB_CHANNEL } from "../lib/runner/protocol";
import { makeJob, makeTmpDir, waitFor } from "./helpers";

/**
 * The child half of the protocol, driven in this process through a fake
 * transport, so a test can play the worker and answer the job channel with
 * exactly the reply it wants — including ones a real worker never sends.
 */

const handler = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

/** A job-channel request, as the child sends it. */
interface ChannelRequest {
  /** The operation asked for. */
  operation: string;
  /** Pairs the reply with the request. */
  seq: number;
}

/** How a driven run ended. */
type Settled = Extract<ChildToParent, { t: "done" } | { t: "error" }>;

/**
 * Runs `file` as an isolated job in a child runtime, answering every
 * job-channel request with whatever `reply` returns for it.
 */
async function drive(
  file: string,
  reply: (request: ChannelRequest) => Record<string, unknown>,
): Promise<Settled> {
  const runId = "run-1";
  const ctx: SerializableContext = {
    runId,
    runnerId: "isolated",
    runnerName: "worker-1",
    namespace: "test",
    attempt: 1,
    source: "queued",
    mode: "worker-thread",
    startedAt: Date.now(),
    deadline: null,
    args: null,
    file: handler(file),
    closeTimeout: 1_000,
    forwardLogs: true,
    kind: "job",
    job: makeJob({ name: "parent" }),
  };

  return await new Promise<Settled>((resolve) => {
    const listeners: ((message: ParentToChild) => void)[] = [];
    const deliver = (message: ParentToChild) => {
      queueMicrotask(() => {
        for (const listener of [...listeners]) {
          listener(message);
        }
      });
    };

    runChildProtocol({
      onMessage: (listener) => {
        listeners.push(listener);
      },
      send: (message) => {
        if (message.t === "ready") {
          deliver({ t: "start", runId, ctx });
        } else if (message.t === "message") {
          const data = message.data as Record<string, unknown>;
          const request = {
            operation: String(data[JOB_CHANNEL]),
            seq: Number(data.seq),
          };
          deliver({
            t: "message",
            runId,
            data: {
              [JOB_CHANNEL]: "reply",
              seq: request.seq,
              ...reply(request),
            },
          });
        } else if (message.t === "done" || message.t === "error") {
          resolve(message);
        }
      },
    });
  });
}

describe("child runtime: job channel replies", () => {
  it("resolves job.log() with the count the worker answered", async () => {
    const settled = await drive("job-log", () => ({ value: 4 }));

    expect(settled).toMatchObject({ t: "done", result: 4 });
  });

  it("rejects job.log() with a ProtocolError when the reply carries no value", async () => {
    // This used to resolve `NaN`: `Number(undefined)`.
    const settled = await drive("job-log", () => ({}));

    expect(settled.t).toBe("error");
    if (settled.t === "error") {
      expect(settled.error.name).toBe("ProtocolError");
      expect(settled.error.message).toContain("carried no value");
    }
  });

  it("rejects a reply whose value is the wrong shape for its operation", async () => {
    const settled = await drive("job-log", () => ({ value: "4" }));

    expect(settled.t).toBe("error");
    if (settled.t === "error") {
      expect(settled.error.name).toBe("ProtocolError");
      expect(settled.error.message).toContain('"log"');
    }
  });

  it("rejects with the worker's own error when it replies with one", async () => {
    const settled = await drive("job-children", () => ({
      error: serializeError(new Error("driver down")),
    }));

    expect(settled.t).toBe("error");
    if (settled.t === "error") {
      expect(settled.error.message).toBe("driver down");
    }
  });

  it("hands a processor its children's values and failures, rebuilt as errors", async () => {
    const failure = serializeError(new Error("optional source down"));
    const reply = ({ operation }: ChannelRequest) =>
      operation === "childrenValues"
        ? { value: { "fetch:1": { rows: 3 } } }
        : { value: { "fetch:2": failure } };
    const settled = await drive("job-children", reply);

    expect(settled).toMatchObject({
      t: "done",
      result: {
        parent: null,
        values: { "fetch:1": { rows: 3 } },
        failures: {
          "fetch:2": {
            isError: true,
            name: "Error",
            message: "optional source down",
          },
        },
      },
    });
  });
});

describe("child runtime: a close before the handler is called", () => {
  /**
   * Both entry points — the spawned child and the worker — run this same
   * protocol, so these cases hold for both modes. They are the only ones that
   * can put a *timeout's* close ahead of `start` in a worker for certain: a
   * worker cannot be held before it boots the way `gated-start.sh` holds a
   * child, while here the test is the parent and chooses the order.
   */
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  /** A child runtime driven by the test, with `slow-import.ts` as its handler. */
  async function harness() {
    const dir = await makeTmpDir("child-close");
    cleanups.push(dir.cleanup);
    const importing = join(dir.path, "importing");
    const gate = join(dir.path, "gate");
    const ready = join(dir.path, "ready");

    // The module reads these at import, from this process.
    process.env.RUNNER_TEST_IMPORTING = importing;
    process.env.RUNNER_TEST_GATE = gate;
    cleanups.push(() => {
      delete process.env.RUNNER_TEST_IMPORTING;
      delete process.env.RUNNER_TEST_GATE;
    });

    const runId = "run-1";
    const startedAt = Date.now();
    const ctx: SerializableContext = {
      runId,
      runnerId: "early",
      runnerName: "early",
      namespace: "test",
      attempt: 1,
      source: "manual",
      mode: "worker-thread",
      startedAt,
      deadline: startedAt + 250,
      // A fresh module, so its import really happens here — this process has
      // no other way to forget one — and the handler finishes on its own, so
      // a runtime that ignores the close still settles.
      args: { ms: 100, ready },
      file: `${handler("slow-import")}?t=${crypto.randomUUID()}`,
      closeTimeout: 10_000,
      forwardLogs: false,
    };

    const sent: ChildToParent[] = [];
    const exits: number[] = [];
    const listeners: ((message: ParentToChild) => void)[] = [];
    let settle: (message: Settled) => void = () => {};
    const settled = new Promise<Settled>((resolve) => {
      settle = resolve;
    });

    runChildProtocol({
      onMessage: (listener) => {
        listeners.push(listener);
      },
      send: (message) => {
        sent.push(message);
        if (message.t === "done" || message.t === "error") {
          settle(message);
        }
      },
      exit: (code) => {
        exits.push(code);
      },
    });

    /** Delivers a message as a transport would: on a later turn. */
    const deliver = async (message: ParentToChild) => {
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          for (const listener of [...listeners]) {
            listener(message);
          }
          resolve();
        });
      });
    };

    return {
      ctx,
      sent,
      exits,
      settled,
      importing,
      gate,
      ready,
      start: () => deliver({ t: "start", runId, ctx }),
      close: (reason: "timeout" | "kill") =>
        deliver({ t: "close", runId, reason }),
    };
  }

  it("never imports the handler when a kill's close came before `start`", async () => {
    const child = await harness();
    // The gate stands open: a runtime that dropped the close imports and runs
    // the handler to its end, and fails the assertions below rather than
    // hanging on the gate.
    await Bun.write(child.gate, "");

    await child.close("kill");
    await child.start();
    const settled = await child.settled;

    expect(settled.t).toBe("error");
    if (settled.t === "error") {
      expect(settled.error.name).toBe("RunKilledError");
      expect(settled.error.message).toBe("Run was killed: kill");
    }
    expect(child.exits).toEqual([CLOSE_EXIT_CODE]);
    // Nothing between `ready` and the result: no `started`, no import.
    expect(child.sent.map((message) => message.t)).toEqual(["ready", "error"]);
    expect(existsSync(child.importing)).toBe(false);
    expect(existsSync(child.ready)).toBe(false);
  });

  it("reports a timeout as one when its close came before `start`", async () => {
    const child = await harness();
    await Bun.write(child.gate, "");

    await child.close("timeout");
    await child.start();
    const settled = await child.settled;

    expect(settled.t).toBe("error");
    if (settled.t === "error") {
      expect(settled.error.name).toBe("JobTimeoutError");
      expect(settled.error.message).toBe("Timed out after 250ms");
    }
    expect(child.exits).toEqual([CLOSE_EXIT_CODE]);
    expect(existsSync(child.importing)).toBe(false);
  });

  it("skips the handler when a timeout's close lands mid-import", async () => {
    const child = await harness();

    await child.start();
    await waitFor(() => existsSync(child.importing), {
      message: "the handler's import never began",
    });
    await child.close("timeout");
    await Bun.write(child.gate, "");
    const settled = await child.settled;

    expect(settled.t).toBe("error");
    if (settled.t === "error") {
      expect(settled.error.name).toBe("JobTimeoutError");
    }
    expect(child.exits).toEqual([CLOSE_EXIT_CODE]);
    // Its module was evaluated; the handler it exports was never called.
    expect(existsSync(child.ready)).toBe(false);
  });

  it("still calls the handler when no close came", async () => {
    // The control: the same harness, unclosed, runs the handler to the end.
    const child = await harness();

    await child.start();
    await waitFor(() => existsSync(child.importing));
    await Bun.write(child.gate, "");
    const settled = await child.settled;

    expect(settled).toMatchObject({ t: "done", result: "finished" });
    expect(child.exits).toEqual([0]);
    expect(existsSync(child.ready)).toBe(true);
  });
});
