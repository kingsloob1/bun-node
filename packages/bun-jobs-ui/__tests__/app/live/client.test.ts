import type { EventWire, JobsApiGapMessage } from "../../../app/api/types";
import type {
  LiveClientOptions,
  LiveClientState,
} from "../../../app/live/client";
import { JOBS_API_WS_SUBPROTOCOL } from "@kingsleyweb/bun-jobs/api/contract";
import { beforeEach, describe, expect, it } from "bun:test";
import { LiveClient, liveSocketUrl } from "../../../app/live/client";
import { liveChannels } from "../../../app/live/live";
import { FakeSocket, FakeTimers, hello, queueEvent, settle } from "./fakes";

/**
 * `LiveClient` against a fake socket: the test plays the server with the
 * frames `lib/api/ws/session.ts` sends, and checks what the client sends
 * back and tells its holders.
 */

/** 600 channels in frames of at most 256. */
const CHUNKS = [256, 256, 88];

/** Reconnect delays with random() = 0: half of min(30 s, 0.5 s × 2^n). */
const BACKOFF = [250, 500, 1000, 2000, 4000, 8000, 15000, 15000, 15000];

let timers: FakeTimers;

beforeEach(() => {
  FakeSocket.instances = [];
  timers = new FakeTimers();
});

/** A client over the fake socket and timers, with no jitter (delays are half the ceiling). */
function makeClient(options: Partial<LiveClientOptions> = {}) {
  const client = new LiveClient({
    url: "ws://localhost/jobs-api/ws",
    WebSocket: FakeSocket,
    timers,
    random: () => 0,
    ...options,
  });
  const states: LiveClientState[] = [];
  client.subscribe(() => {
    const { state } = client.getSnapshot();
    if (states.at(-1) !== state) {
      states.push(state);
    }
  });
  return { client, states };
}

/** Starts a client and completes the handshake. */
async function connected(options: Partial<LiveClientOptions> = {}) {
  const made = makeClient(options);
  made.client.start();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(hello());
  await settle();
  return { ...made, socket };
}

/** A holder that records what it is told. */
function recorder() {
  const events: EventWire[] = [];
  const gaps: JobsApiGapMessage[] = [];
  const rejected: string[][] = [];
  return {
    events,
    gaps,
    rejected,
    callbacks: {
      onEvent: (event: EventWire) => events.push(event),
      onGap: (gap: JobsApiGapMessage) => gaps.push(gap),
      onRejected: (list: readonly { channel: string }[]) =>
        rejected.push(list.map((rejection) => rejection.channel)),
    },
  };
}

describe("liveSocketUrl", () => {
  it("uses the page's origin for a same-origin API, as ws: or wss:", () => {
    expect(
      liveSocketUrl(
        { path: "/jobs-api/ws" },
        "/jobs-api",
        "http://host:8080/jobs",
      ),
    ).toBe("ws://host:8080/jobs-api/ws");
    expect(
      liveSocketUrl({ path: "/jobs-api/ws" }, "/jobs-api", "https://host/jobs"),
    ).toBe("wss://host/jobs-api/ws");
  });

  it("uses the API's origin when apiBase is cross-origin", () => {
    expect(
      liveSocketUrl(
        { path: "/api/ws" },
        "https://api.example.com/api",
        "http://ui.example.com/jobs",
      ),
    ).toBe("wss://api.example.com/api/ws");
  });

  it("puts a dedicated port on that origin's hostname", () => {
    expect(
      liveSocketUrl(
        { path: "/ws", port: 9001 },
        "/jobs-api",
        "https://host:8443/jobs",
      ),
    ).toBe("wss://host:9001/ws");
  });
});

describe("connection", () => {
  it("offers only the bun-jobs.v1 subprotocol and goes live on hello", async () => {
    const { client, states, socket } = await connected();
    expect(socket.protocols).toEqual([JOBS_API_WS_SUBPROTOCOL]);
    expect(socket.url).toBe("ws://localhost/jobs-api/ws");
    expect(states).toEqual(["connecting", "live"]);
    expect(client.sessionId).toBe("s1");
    expect(client.getSnapshot().detail).toBeNull();
  });

  it("stops with code 1000 and state off, and can start again", async () => {
    const { client, socket } = await connected();
    client.stop();
    expect(socket.closedWith).toBe(1000);
    expect(client.getSnapshot().state).toBe("off");
    client.start();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(client.getSnapshot().state).toBe("reconnecting");
  });
});

describe("subscriptions", () => {
  it("refcounts channels and merges filters, re-subscribing when the merged filter changes", async () => {
    const { client, socket } = await connected();
    const channel = liveChannels.queue("emails");

    const a = client.hold({ channels: [channel], events: ["completed"] });
    const b = client.hold({ channels: [channel], events: ["added"] });
    await settle();
    let subscribes = socket.ops("subscribe");
    expect(subscribes).toHaveLength(1);
    expect(subscribes[0]).toMatchObject({
      channels: [channel],
      events: ["added", "completed"],
    });

    // An unfiltered holder means no filter.
    const c = client.hold({ channels: [channel] });
    await settle();
    subscribes = socket.ops("subscribe");
    expect(subscribes).toHaveLength(2);
    expect(subscribes[1]!.events).toBeUndefined();

    // Its release narrows the filter again: a re-subscribe, not an unsubscribe.
    c.release();
    await settle();
    subscribes = socket.ops("subscribe");
    expect(subscribes).toHaveLength(3);
    expect(subscribes[2]!.events).toEqual(["added", "completed"]);
    expect(socket.ops("unsubscribe")).toHaveLength(0);

    // Its release narrows the merged filter once more.
    a.release();
    await settle();
    expect(socket.ops("subscribe")).toHaveLength(4);
    expect(socket.ops("subscribe")[3]!.events).toEqual(["added"]);

    b.release();
    await settle();
    const unsubscribes = socket.ops("unsubscribe");
    expect(unsubscribes).toHaveLength(1);
    expect(unsubscribes[0]!.channels).toEqual([channel]);
    expect(client.holdCounts().size).toBe(0);
  });

  it("sends nothing when a second holder adds nothing new", async () => {
    const { client, socket } = await connected();
    const a = client.hold({ channels: ["queues"] });
    await settle();
    const b = client.hold({ channels: ["queues"] });
    await settle();
    expect(socket.ops("subscribe")).toHaveLength(1);
    a.release();
    await settle();
    expect(socket.ops("unsubscribe")).toHaveLength(0);
    b.release();
    await settle();
    expect(socket.ops("unsubscribe")).toHaveLength(1);
  });

  it("coalesces one render's holds into one frame, and chunks at 256 channels with unique ids", async () => {
    const { client, socket } = await connected();
    const channels = Array.from({ length: 600 }, (_, i) => `queue/q${i}`);
    client.hold({ channels: channels.slice(0, 300) });
    client.hold({ channels: channels.slice(300) });
    await settle();
    const subscribes = socket.ops("subscribe");
    const sizes = subscribes.map((frame) => frame.channels.length);
    expect(sizes).toEqual(CHUNKS);
    expect(subscribes.flatMap((frame) => frame.channels)).toEqual(channels);
    expect(new Set(subscribes.map((frame) => frame.id)).size).toBe(3);
  });

  it("waits for hello before subscribing, and holds made while disconnected are sent then", async () => {
    const { client } = makeClient();
    client.hold({ channels: ["queues"] });
    client.start();
    const socket = FakeSocket.last;
    socket.open();
    await settle();
    expect(socket.sent).toHaveLength(0);
    socket.receive(hello());
    expect(socket.ops("subscribe")).toHaveLength(1);
    expect(socket.ops("subscribe")[0]!.resume).toBeUndefined();
  });

  it("routes ack rejections to the holders of those channels only, by the raw name", async () => {
    const { client, socket } = await connected();
    const bad = recorder();
    const good = recorder();
    client.hold({ channels: ["queue/bad name", "queues"], ...bad.callbacks });
    client.hold({ channels: ["queues"], ...good.callbacks });
    await settle();
    const [frame] = socket.ops("subscribe");
    socket.receive({
      type: "ack",
      id: frame!.id,
      op: "subscribe",
      channels: ["queues"],
      rejected: [
        {
          channel: "queue/bad name",
          code: "INVALID_CHANNEL",
          status: 400,
          detail: "invalid",
        },
      ],
      seq: 0,
    });
    expect(bad.rejected).toEqual([["queue/bad name"]]);
    expect(good.rejected).toEqual([]);

    // A later holder of the rejected channel learns it at once; nothing is re-sent.
    const late = recorder();
    const hold = client.hold({
      channels: ["queue/bad name"],
      ...late.callbacks,
    });
    expect(hold.rejected().map((rejection) => rejection.code)).toEqual([
      "INVALID_CHANNEL",
    ]);
    await settle();
    expect(socket.ops("subscribe")).toHaveLength(1);
  });

  it("resolves acks by id without a timeout: a late ack still lands", async () => {
    const { client, socket } = await connected({ heartbeatMs: 0 });
    const holder = recorder();
    client.hold({ channels: ["queue/x"], ...holder.callbacks });
    await settle();
    const [frame] = socket.ops("subscribe");
    timers.advance(20_000);
    socket.receive({
      type: "ack",
      id: frame!.id,
      op: "subscribe",
      channels: [],
      rejected: [{ channel: "queue/x", code: "FORBIDDEN", status: 403 }],
      seq: 0,
    });
    expect(holder.rejected).toEqual([["queue/x"]]);
  });
});

describe("events", () => {
  it("delivers replayed events that arrive before the ack", async () => {
    const { client, socket } = await connected();
    const holder = recorder();
    client.hold({ channels: ["queue/emails"], ...holder.callbacks });
    await settle();
    socket.receive(queueEvent(1, ["queue/emails"]));
    expect(holder.events).toHaveLength(1);
    socket.ackAll();
    expect(holder.events).toHaveLength(1);
  });

  it("de-duplicates by a seen-set, not a max: out-of-order seqs are delivered, repeats are not", async () => {
    const { client, socket } = await connected();
    const seen: string[] = [];
    client.hold({
      channels: ["queue/emails"],
      onEvent: (event) => seen.push(event.id ?? ""),
    });
    await settle();
    for (const seq of [5, 3, 5, 4, 3]) {
      socket.receive(
        queueEvent(seq, ["queue/emails"], "completed", { id: String(seq) }),
      );
    }
    expect(seen).toEqual(["5", "3", "4"]);
    expect(client.getSnapshot().lastEventAt).toBe(timers.now());
  });

  it("delivers an event once per holder, however many of its channels match", async () => {
    const { client, socket } = await connected();
    const a = recorder();
    const b = recorder();
    const c = recorder();
    const job = liveChannels.job("emails", "1");
    client.hold({ channels: ["queue/emails", job], ...a.callbacks });
    client.hold({ channels: [job], ...b.callbacks });
    client.hold({ channels: ["runners"], ...c.callbacks });
    await settle();
    socket.receive(queueEvent(1, ["queue/emails", job]));
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(c.events).toHaveLength(0);
  });

  it("applies each holder's own filter on a shared channel", async () => {
    const { client, socket } = await connected();
    const added = recorder();
    const all = recorder();
    client.hold({
      channels: ["queues"],
      events: ["added"],
      ...added.callbacks,
    });
    client.hold({ channels: ["queues"], ...all.callbacks });
    await settle();
    socket.receive(queueEvent(1, ["queues"], "completed"));
    socket.receive(queueEvent(2, ["queues"], "added"));
    expect(added.events.map((event) => event.type)).toEqual(["added"]);
    expect(all.events.map((event) => event.type)).toEqual([
      "completed",
      "added",
    ]);
  });

  it("delivers a repeated seq to a holder it did not reach the first time", async () => {
    const { client, socket } = await connected();
    const a = recorder();
    const b = recorder();
    client.hold({ channels: ["queue/a"], ...a.callbacks });
    client.hold({ channels: ["queue/b"], ...b.callbacks });
    await settle();
    socket.receive(queueEvent(9, ["queue/a"]));
    socket.receive(queueEvent(9, ["queue/a", "queue/b"]));
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  it("maps canonical names in events back to the names held", async () => {
    const { client, socket } = await connected();
    const holder = recorder();
    // Sent un-canonically; the ack gives the canonical key.
    client.hold({ channels: ["queue/emails/job/a b"], ...holder.callbacks });
    await settle();
    const [frame] = socket.ops("subscribe");
    socket.receive({
      type: "ack",
      id: frame!.id,
      op: "subscribe",
      channels: ["queue/emails/job/a%20b"],
      seq: 0,
    });
    socket.receive(queueEvent(1, ["queue/emails/job/a%20b"]));
    expect(holder.events).toHaveLength(1);
  });
});

describe("gaps", () => {
  it("routes a gap to the holders of its channels, or to all without channels", async () => {
    const { client, socket } = await connected();
    const a = recorder();
    const b = recorder();
    client.hold({ channels: ["queue/a"], ...a.callbacks });
    client.hold({ channels: ["queue/b"], ...b.callbacks });
    await settle();
    socket.receive({
      type: "gap",
      epoch: "e1",
      fromSeq: 3,
      toSeq: 9,
      reason: "slow-consumer",
      channels: ["queue/a"],
    });
    expect(a.gaps).toHaveLength(1);
    expect(b.gaps).toHaveLength(0);
    socket.receive({
      type: "gap",
      epoch: "e1",
      fromSeq: 10,
      toSeq: 12,
      reason: "slow-consumer",
    });
    expect(a.gaps).toHaveLength(2);
    expect(b.gaps).toHaveLength(1);
  });
});

describe("reconnect and resume", () => {
  it("resumes with afterSeq = the last seq seen, replay before the ack, no gap when resumed", async () => {
    const { client, socket } = await connected();
    const holder = recorder();
    client.hold({ channels: ["queue/emails"], ...holder.callbacks });
    await settle();
    socket.ackAll();
    socket.receive(queueEvent(7, ["queue/emails"]));
    socket.receive(queueEvent(4, ["queue/emails"], "completed", { id: "4" }));
    socket.drop(1006);
    expect(client.getSnapshot().state).toBe("reconnecting");

    timers.advance(250);
    const second = FakeSocket.last;
    expect(second).not.toBe(socket);
    second.open();
    second.receive(hello({ sessionId: "s2", seq: 9 }));
    const [frame] = second.ops("subscribe");
    expect(frame!.resume).toEqual({ epoch: "e1", afterSeq: 7 });

    // Replay: 8 is new; 7 was already delivered.
    second.receive(queueEvent(8, ["queue/emails"], "completed", { id: "8" }));
    second.receive(queueEvent(7, ["queue/emails"]));
    second.ackAll({ resumed: true });
    expect(holder.events.map((event) => event.id)).toEqual(["1", "4", "8"]);
    expect(holder.gaps).toHaveLength(0);
    expect(client.getSnapshot().state).toBe("live");
  });

  it("turns resumed:false into one gap for those holders (the server's gap after it is not repeated)", async () => {
    const { client, socket } = await connected();
    const holder = recorder();
    const other = recorder();
    client.hold({ channels: ["queue/emails"], ...holder.callbacks });
    await settle();
    socket.ackAll();
    socket.drop(1006);
    timers.advance(250);
    const second = FakeSocket.last;
    second.open();
    second.receive(hello());
    client.hold({ channels: ["queue/other"], ...other.callbacks });
    second.ackAll({ resumed: false, seq: 20 });
    second.receive({
      type: "gap",
      epoch: "e1",
      fromSeq: 1,
      toSeq: 20,
      reason: "resume-expired",
      channels: ["queue/emails"],
    });
    expect(holder.gaps).toHaveLength(1);
    expect(other.gaps).toHaveLength(0);

    // A later gap is delivered normally.
    second.receive({
      type: "gap",
      epoch: "e1",
      fromSeq: 21,
      toSeq: 22,
      reason: "slow-consumer",
    });
    expect(holder.gaps).toHaveLength(2);
  });

  it("does not trust resumed:true on the second frame of a split resume: its holders get a gap", async () => {
    const { client, socket } = await connected();
    const queue = recorder();
    const job = recorder();
    client.hold({ channels: ["queue/emails"], ...queue.callbacks });
    client.hold({
      channels: [liveChannels.job("emails", "1")],
      events: ["added"],
      ...job.callbacks,
    });
    await settle();
    socket.ackAll();
    socket.drop(1006);
    timers.advance(250);
    const second = FakeSocket.last;
    second.open();
    second.receive(hello());
    const frames = second.ops("subscribe");
    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.resume !== undefined)).toBe(true);
    second.ackAll({ resumed: true });
    expect(queue.gaps).toHaveLength(0);
    expect(job.gaps).toHaveLength(1);
  });

  it("treats a new epoch as a gap for every holder and subscribes without resume", async () => {
    const { client, socket } = await connected();
    const holder = recorder();
    client.hold({ channels: ["queue/emails"], ...holder.callbacks });
    await settle();
    socket.ackAll();
    socket.receive(queueEvent(3, ["queue/emails"]));
    socket.drop(1001);
    timers.advance(250);
    const second = FakeSocket.last;
    second.open();
    second.receive(hello({ epoch: "e2", seq: 1 }));
    expect(holder.gaps).toEqual([
      expect.objectContaining({ reason: "epoch-changed", epoch: "e2" }),
    ]);
    expect(second.ops("subscribe")[0]!.resume).toBeUndefined();
    // seq 3 of the new epoch is a different event: not a duplicate.
    second.receive(
      queueEvent(3, ["queue/emails"], "completed", { epoch: "e2" }),
    );
    expect(holder.events).toHaveLength(2);
  });

  it("backs off exponentially up to the ceiling, and resets once live", async () => {
    const { client, socket } = await connected();
    socket.drop(1006);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      const delay = timers.pending()[0]!;
      delays.push(delay);
      timers.advance(delay);
      FakeSocket.last.drop(1006);
    }
    expect(delays).toEqual(BACKOFF);
    expect(client.getSnapshot().state).toBe("reconnecting");

    timers.advance(timers.pending()[0]!);
    FakeSocket.last.open();
    FakeSocket.last.receive(hello());
    FakeSocket.last.drop(1006);
    expect(timers.pending()[0]).toBe(250);
  });

  it("jitters within [ceiling/2, ceiling]", () => {
    const low = makeClient({ random: () => 0 }).client;
    const high = makeClient({ random: () => 0.999999 }).client;
    expect(low.backoffDelay(3)).toBe(2000);
    expect(high.backoffDelay(3)).toBe(4000);
    expect(high.backoffDelay(20)).toBe(30000);
  });
});

describe("heartbeat", () => {
  it("reconnects when nothing arrives within 2 × heartbeatMs + slack", async () => {
    const { client, socket } = await connected();
    socket.receive(hello({ heartbeatMs: 1000 }));
    timers.advance(6_999);
    expect(socket.closedWith).toBeUndefined();
    socket.receive({ type: "heartbeat", seq: 0, at: 0 });
    timers.advance(6_999);
    expect(socket.closedWith).toBeUndefined();
    timers.advance(1);
    expect(socket.closedWith).toBe(4000);
    expect(client.getSnapshot().state).toBe("reconnecting");
    expect(client.getSnapshot().detail).toMatch(/quiet/);
    timers.advance(250);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("pings when heartbeats are off, and reconnects when the pong never comes", async () => {
    const { socket } = await connected({ pingIntervalMs: 1000 });
    socket.receive(hello({ heartbeatMs: 0 }));
    timers.advance(1000);
    expect(socket.ops("ping")).toHaveLength(1);
    socket.receive({ type: "pong", id: socket.ops("ping")[0]!.id, at: 0 });
    timers.advance(1000);
    expect(socket.ops("ping")).toHaveLength(2);
    timers.advance(6000);
    expect(socket.closedWith).toBe(4000);
  });
});

describe("close codes", () => {
  it("1001 going away: reconnects", async () => {
    const { client, socket } = await connected();
    socket.drop(1001);
    expect(client.getSnapshot().state).toBe("reconnecting");
    expect(client.getSnapshot().detail).toMatch(/restarting/);
    timers.advance(250);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  for (const code of [1003, 1008, 1009]) {
    it(`${code}: reconnects with backoff at most 3 times, then refused`, async () => {
      const { client } = await connected();
      for (let attempt = 0; attempt < 3; attempt++) {
        FakeSocket.last.drop(code);
        expect(client.getSnapshot().state).toBe("reconnecting");
        timers.advance(timers.pending()[0]!);
        FakeSocket.last.open();
        FakeSocket.last.receive(hello());
      }
      FakeSocket.last.drop(code);
      expect(client.getSnapshot().state).toBe("refused");
      expect(timers.pending()).toEqual([]);
    });
  }

  it("resets the policy-close count after a stable connection", async () => {
    const { client } = await connected();
    for (let attempt = 0; attempt < 6; attempt++) {
      for (let beat = 0; beat < 3; beat++) {
        timers.advance(20_000);
        FakeSocket.last.receive({ type: "heartbeat", seq: 0, at: 0 });
      }
      FakeSocket.last.drop(1008);
      expect(client.getSnapshot().state).toBe("reconnecting");
      timers.advance(timers.pending()[0]!);
      FakeSocket.last.open();
      FakeSocket.last.receive(hello());
    }
  });

  it("4008 slow consumer: reconnects, then a gap to every holder", async () => {
    const { client, socket } = await connected();
    const holder = recorder();
    client.hold({ channels: ["queue/emails"], ...holder.callbacks });
    await settle();
    socket.ackAll();
    socket.drop(4008);
    expect(client.getSnapshot().state).toBe("reconnecting");
    expect(holder.gaps).toHaveLength(0);
    timers.advance(250);
    FakeSocket.last.open();
    FakeSocket.last.receive(hello());
    expect(holder.gaps).toEqual([
      expect.objectContaining({ reason: "slow-consumer" }),
    ]);
  });

  it("a refused upgrade (1006 before the first open) retries twice, then refused, pointing at events.connect", () => {
    const { client, states } = makeClient();
    client.start();
    FakeSocket.last.drop(1006);
    expect(client.getSnapshot().state).toBe("connecting");
    timers.advance(250);
    FakeSocket.last.drop(1006);
    timers.advance(500);
    FakeSocket.last.drop(1006);
    expect(FakeSocket.instances).toHaveLength(3);
    expect(client.getSnapshot().state).toBe("refused");
    expect(client.getSnapshot().detail).toMatch(/events\.connect/);
    expect(states).toEqual(["connecting", "refused"]);
    timers.advance(60_000);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("after a first open, a connection that never opens keeps retrying", async () => {
    const { client, socket } = await connected();
    socket.drop(1006);
    for (let attempt = 0; attempt < 6; attempt++) {
      timers.advance(timers.pending()[0]!);
      FakeSocket.last.drop(1006);
    }
    expect(client.getSnapshot().state).toBe("reconnecting");
  });
});

describe("error frames", () => {
  it("RATE_LIMITED: backs off sending and re-sends the refused frame after the pause", async () => {
    const { client, socket } = await connected();
    client.hold({ channels: ["queue/a"] });
    await settle();
    const [frame] = socket.ops("subscribe");
    socket.sent.length = 0;
    socket.receive({
      type: "error",
      id: frame!.id,
      code: "RATE_LIMITED",
      status: 429,
      detail: "slow down",
    });
    client.hold({ channels: ["queue/b"] });
    await settle();
    expect(socket.sent).toHaveLength(0);
    timers.advance(2_000);
    await settle();
    const channels = socket.ops("subscribe").flatMap((sent) => sent.channels);
    expect(channels.sort()).toEqual(["queue/a", "queue/b"]);
  });

  it("EVENTS_UNAVAILABLE: says so in the status and retries the subscribe", async () => {
    const { client, socket } = await connected();
    client.hold({ channels: ["queue/a"] });
    await settle();
    const [frame] = socket.ops("subscribe");
    socket.sent.length = 0;
    socket.receive({
      type: "error",
      id: frame!.id,
      code: "EVENTS_UNAVAILABLE",
      status: 503,
      detail: "Live events are unavailable; retry later",
    });
    expect(client.getSnapshot().state).toBe("live");
    expect(client.getSnapshot().detail).toMatch(/unavailable/);
    timers.advance(timers.pending()[0]!);
    expect(socket.ops("subscribe")).toHaveLength(1);
    socket.ackAll();
    expect(client.getSnapshot().detail).toBeNull();
  });

  it("keeps sends within its own budget", async () => {
    const { client, socket } = await connected({ messagesPerSecond: 2 });
    for (let index = 0; index < 6; index++) {
      client.hold({ channels: [`queue/q${index}`], events: ["added"] });
      await settle();
      client.hold({ channels: [`queue/q${index}`] });
      await settle();
    }
    // Burst of 2 × 2, then 2 per second.
    expect(socket.sent).toHaveLength(4);
    timers.advance(1000);
    expect(socket.sent).toHaveLength(6);
  });
});
