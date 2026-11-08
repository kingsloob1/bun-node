/**
 * `LiveClient`'s `onAuthFailure`: every 401/403 the socket reports reaches
 * it, after the client has handled the failure as it always did; nothing
 * else does.
 */
import type { LiveClientOptions } from "../../../../app/jobs/live/client";
import { JOBS_API_WS_CLOSE } from "@kingsleyweb/bun-jobs/api/contract";
import { beforeEach, describe, expect, it } from "bun:test";
import { LiveClient } from "../../../../app/jobs/live/client";
import { FakeSocket, FakeTimers, hello, settle } from "./fakes";

let timers: FakeTimers;

beforeEach(() => {
  FakeSocket.instances = [];
  timers = new FakeTimers();
});

/** A started, connected client whose auth failures are recorded. */
async function connected(options: Partial<LiveClientOptions> = {}) {
  const failures: number[] = [];
  const client = new LiveClient({
    url: "ws://localhost/jobs-api/ws",
    WebSocket: FakeSocket,
    timers,
    random: () => 0,
    onAuthFailure: (status) => failures.push(status),
    ...options,
  });
  client.start();
  const socket = FakeSocket.last;
  socket.open();
  socket.receive(hello());
  await settle();
  return { client, socket, failures };
}

describe("LiveClient onAuthFailure", () => {
  it("reports 401 for the UNAUTHORIZED close, after refusing", async () => {
    const { client, socket, failures } = await connected();
    socket.drop(JOBS_API_WS_CLOSE.UNAUTHORIZED);
    expect(failures).toEqual([401]);
    expect(client.getSnapshot().state).toBe("refused");
  });

  it("reports the status of each channel an ack refuses with 401 or 403, and no other", async () => {
    const { client, socket, failures } = await connected();
    client.hold({ channels: ["queue/a", "queue/b", "queue/c", "queues"] });
    await settle();
    const [frame] = socket.ops("subscribe");
    socket.receive({
      type: "ack",
      id: frame.id,
      op: "subscribe",
      channels: ["queues"],
      rejected: [
        { channel: "queue/a", code: "FORBIDDEN", status: 403 },
        { channel: "queue/b", code: "UNAUTHORIZED", status: 401 },
        { channel: "queue/c", code: "INVALID_CHANNEL", status: 400 },
      ],
      seq: 0,
    });
    expect(failures).toEqual([403, 401]);
  });

  it("reports an error frame's 401 or 403, and not its other statuses", async () => {
    const { client, socket, failures } = await connected();
    client.hold({ channels: ["queue/a"] });
    await settle();
    const [frame] = socket.ops("subscribe");
    socket.receive({
      type: "error",
      id: frame.id,
      code: "RATE_LIMITED",
      status: 429,
      detail: "slow down",
    });
    expect(failures).toEqual([]);
    socket.receive({
      type: "error",
      code: "UNAUTHORIZED",
      status: 401,
      detail: "The message was refused",
    });
    expect(failures).toEqual([401]);
  });

  it("does not report a refused upgrade: a browser cannot see its status", async () => {
    const failures: number[] = [];
    const client = new LiveClient({
      url: "ws://localhost/jobs-api/ws",
      WebSocket: FakeSocket,
      timers,
      random: () => 0,
      maxRefusedRetries: 0,
      onAuthFailure: (status) => failures.push(status),
    });
    client.start();
    FakeSocket.last.drop(1006);
    expect(client.getSnapshot().state).toBe("refused");
    expect(failures).toEqual([]);
  });

  it("does not report the other closes", async () => {
    const { socket, failures } = await connected();
    socket.drop(JOBS_API_WS_CLOSE.GOING_AWAY);
    expect(failures).toEqual([]);
  });
});
