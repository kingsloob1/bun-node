import type {
  ChildToParent,
  ParentToChild,
  SerializableContext,
} from "../lib/runner/protocol";
import { join } from "node:path";
import { serializeError } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { runChildProtocol } from "../lib/runner/bootstrap/child-runtime";
import { JOB_CHANNEL } from "../lib/runner/protocol";
import { makeJob } from "./helpers";

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
