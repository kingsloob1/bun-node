import type {
  EventWire,
  JobsApiClientMessage,
  JobsApiGapMessage,
  JobsApiServerMessage,
} from "@kingsleyweb/bun-jobs/api/contract";
import type { LiveSocketConstructor } from "../../../app/live/client";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterEach, describe, expect, it } from "bun:test";
import { LiveClient, liveSocketUrl } from "../../../app/live/client";

/**
 * `LiveClient` against a REAL live-events socket: `createJobsApi` over the
 * memory driver with `publishEvents`, on a `BunHttpAdapter` listening on port
 * 0, the socket attached, and Bun's own `WebSocket` underneath. A real worker
 * completes real jobs; the client must see their events on the queue and job
 * channels, survive the server dropping it, and refcount its channels.
 * Every test starts its own stack (`startStack`), so the order is free.
 */

const BASE = "/jobs-api";
const QUEUE = "mail";

/** Bun's WebSocket, captured before any DOM test could replace the global. */
const NativeWebSocket = globalThis.WebSocket;

/** Every frame sent by, and received by, one stack's client sockets. */
interface Wire {
  /** Frames the client sent. */
  sent: JobsApiClientMessage[];
  /** Frames the server sent. */
  received: JobsApiServerMessage[];
}

/**
 * One self-contained server and client. Each test builds its own, so no test
 * depends on a job, a subscription or a stopped server another test left
 * behind, and the file passes in any order (`bun test --randomize`).
 */
interface Stack {
  /** The service whose queues the tests drive. */
  jobs: BunJobs;
  /** The API serving the live-events socket. */
  api: ReturnType<typeof createJobsApi>;
  /** The adapter currently serving the API (replaced by `serve`). */
  adapter: BunHttpAdapter;
  /** The port the first `serve` was given; later ones reuse it. */
  port: number;
  /** The client under test, started and live. */
  client: LiveClient;
  /** What that client's sockets sent and received. */
  wire: Wire;
}

/** Serves the API and attaches its socket on a fresh adapter (port 0 the first time). */
async function serve(
  api: Stack["api"],
  on: number,
): Promise<{ adapter: BunHttpAdapter; port: number }> {
  const adapter = new BunHttpAdapter(0, { logger: noopLogger });
  adapter.use(api.basePath, api.router);
  api.websocket!.attach(adapter);
  const server = await adapter.listen(on);
  return { adapter, port: server.port! };
}

/** Resolves once `check` holds. */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Frames of one op `wire` recorded as sent since `from`. */
function sentOps<T extends JobsApiClientMessage["op"]>(
  wire: Wire,
  op: T,
  from = 0,
): Extract<JobsApiClientMessage, { op: T }>[] {
  return wire.sent
    .slice(from)
    .filter(
      (frame): frame is Extract<JobsApiClientMessage, { op: T }> =>
        frame.op === op,
    );
}

/** Whether the server acked every subscribe/unsubscribe sent so far. */
function allAcked(wire: Wire): boolean {
  const acked = new Set(
    wire.received.flatMap((frame) => (frame.type === "ack" ? [frame.id] : [])),
  );
  return wire.sent.every((frame) => frame.op === "ping" || acked.has(frame.id));
}

/** Adds a job with a known id and has a real worker complete it. */
async function completeJob(jobs: BunJobs, id: string): Promise<void> {
  const queue = jobs.queue(QUEUE);
  await queue.add("send", { id }, { jobId: id });
  const worker = jobs.worker(QUEUE, async () => "sent");
  void worker.run();
  try {
    const deadline = Date.now() + 5_000;
    while ((await queue.getJob(id))?.state !== "completed") {
      if (Date.now() > deadline) {
        throw new Error(`job ${id} did not complete`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await worker.close({ timeout: 1_000 });
  }
}

/** Every stack started and not yet closed, closed by `afterEach`. */
const open: Stack[] = [];

/** Starts a fresh service, API, server (port 0) and client, and waits for it to be live. */
async function startStack(): Promise<Stack> {
  const wire: Wire = { sent: [], received: [] };

  /** Bun's WebSocket, recording both directions into this stack's `wire`. */
  class RecordingSocket extends NativeWebSocket {
    constructor(url: string, protocols: string[]) {
      super(url, protocols);
      this.addEventListener("message", (event) => {
        wire.received.push(
          JSON.parse(String(event.data)) as JobsApiServerMessage,
        );
      });
    }

    override send(data: string): void {
      wire.sent.push(JSON.parse(data) as JobsApiClientMessage);
      super.send(data);
    }
  }

  const jobs = new BunJobs({
    namespace: `ui-live-${crypto.randomUUID().slice(0, 8)}`,
    driver: new MemoryDriver(),
    logger: noopLogger,
    publishEvents: true,
  });
  const api = createJobsApi({
    jobs,
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
  });
  const { adapter, port } = await serve(api, 0);
  const client = new LiveClient({
    url: () =>
      liveSocketUrl(
        { path: api.websocket!.path },
        BASE,
        `http://127.0.0.1:${port}/jobs`,
      ),
    WebSocket: RecordingSocket as unknown as LiveSocketConstructor,
    backoffInitialMs: 50,
    backoffMaxMs: 200,
  });
  const stack: Stack = {
    jobs,
    api,
    adapter,
    port,
    client,
    wire,
  };
  open.push(stack);
  client.start();
  await until(() => client.getSnapshot().state === "live");
  return stack;
}

afterEach(async () => {
  for (const stack of open.splice(0)) {
    stack.client.stop();
    await stack.api.close();
    await stack.adapter.close();
    await stack.jobs.close();
  }
});

describe("LiveClient against a real API socket", () => {
  it("offers bun-jobs.v1, and receives a real job's events on its queue and job channels", async () => {
    const { client, jobs, wire } = await startStack();
    const queueEvents: EventWire[] = [];
    const jobEvents: EventWire[] = [];
    expect(wire.received[0]).toMatchObject({ type: "hello", protocol: 1 });

    client.hold({
      channels: [`queue/${QUEUE}`],
      onEvent: (event) => queueEvents.push(event),
    });
    client.hold({
      channels: [`queue/${QUEUE}/job/j-1`],
      onEvent: (event) => jobEvents.push(event),
    });
    await until(() => sentOps(wire, "subscribe").length > 0 && allAcked(wire));

    await completeJob(jobs, "j-1");
    await until(() => jobEvents.some((event) => event.type === "completed"));
    await until(() =>
      queueEvents.some(
        (event) => event.type === "completed" && event.id === "j-1",
      ),
    );
    expect(jobEvents.every((event) => event.id === "j-1")).toBe(true);
    expect(jobEvents.map((event) => event.type)).toContain("added");
    expect(client.getSnapshot().lastEventAt).not.toBeNull();
  });

  it("resumes (or reports a gap) after the server drops the connection", async () => {
    const stack = await startStack();
    const { client, jobs, wire } = stack;
    const queueEvents: EventWire[] = [];
    const gaps: JobsApiGapMessage[] = [];

    // A subscription that has seen an event, so it has a position to resume from.
    client.hold({
      channels: [`queue/${QUEUE}`],
      onEvent: (event) => queueEvents.push(event),
      onGap: (gap) => gaps.push(gap),
    });
    await until(() => sentOps(wire, "subscribe").length > 0 && allAcked(wire));
    await completeJob(jobs, "j-1");
    await until(() =>
      queueEvents.some(
        (event) => event.type === "completed" && event.id === "j-1",
      ),
    );

    const helloCount = () =>
      wire.received.filter((frame) => frame.type === "hello").length;
    const before = helloCount();
    const sentBefore = wire.sent.length;

    // The server goes away with the socket (no close frame reaches the client).
    await stack.adapter.close();
    await until(() => client.getSnapshot().state === "reconnecting");

    // Meanwhile a job completes: the API's replay ring keeps its events.
    await completeJob(jobs, "j-2");

    stack.adapter = (await serve(stack.api, stack.port)).adapter;
    await until(() => helloCount() > before);
    await until(() => client.getSnapshot().state === "live");
    const resumed = sentOps(wire, "subscribe", sentBefore);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed[0]!.resume?.epoch).toBeString();
    expect(resumed[0]!.resume?.afterSeq).toBeGreaterThan(0);

    await until(
      () =>
        gaps.length > 0 ||
        queueEvents.some(
          (event) => event.type === "completed" && event.id === "j-2",
        ),
    );
  });

  it("refcounts: two holders of one channel, one unsubscribe after both release", async () => {
    const { client, wire } = await startStack();
    const from = wire.sent.length;
    const channel = `queue/${QUEUE}-refcount`;
    const a = client.hold({ channels: [channel] });
    const b = client.hold({ channels: [channel] });
    await until(
      () => sentOps(wire, "subscribe", from).length === 1 && allAcked(wire),
    );
    a.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sentOps(wire, "unsubscribe", from)).toHaveLength(0);
    b.release();
    await until(
      () => sentOps(wire, "unsubscribe", from).length === 1 && allAcked(wire),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const unsubscribes = sentOps(wire, "unsubscribe", from);
    expect(unsubscribes).toHaveLength(1);
    expect(unsubscribes[0]!.channels).toEqual([channel]);
    expect(sentOps(wire, "subscribe", from)).toHaveLength(1);
  });
});
