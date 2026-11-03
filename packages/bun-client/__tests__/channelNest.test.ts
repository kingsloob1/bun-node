/**
 * The `"bun-nest"` codec (typed-client plan, `websocket.md` §11, PR-W3) on
 * the wire, against a scripted server on port 0 speaking bun-nest's packets
 * (`MessageEventTypes`: `EVENT` 2, `ACK` 3, `ERROR` 4, `BINARY_EVENT` 5,
 * `BINARY_ACK` 6), so every packet shape is pinned here; bun-nest's own
 * suite runs the codec against a real gateway
 * (`packages/bun-nest/__tests__/channelClient.nest.test.ts`).
 *
 * Covered: what a send and a request write (data-less, a numeric id, bytes
 * as base64 in a `BINARY_EVENT`); an `ACK` resolving the request of its id
 * (several arguments as an array, a `BINARY_ACK`'s bytes), one no request
 * waits for ignored; a server `EVENT` is a push even with a waiting
 * request's id (control); the `exception` event as an error frame or a
 * push; `ERROR` as an `"error"` push; lifecycle packets ignored; the
 * descriptor's `codec`.
 */
import type { ServerWebSocket } from "bun";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "bun:test";
import { channelContract } from "@kingsleyweb/bun-common";
import { z } from "zod";
import type { ChannelDescriptor } from "../lib/channel";
import { channel, ChannelError, RequestTimeoutError } from "../lib/channel";
import { createClient } from "../lib/index";

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

/** The channel the tests open: a gateway's maps, shared (NTR §7). */
const chat = channelContract({
  path: "/chat",
  receives: {
    say: z.object({ text: z.string() }),
    typing: null,
    upload: z.instanceof(Uint8Array),
  },
  sends: {
    said: z.object({ text: z.string() }),
    "say ack": z.object({ ok: z.boolean() }),
    pair: z.tuple([z.string(), z.number()]),
    bytes: z.instanceof(Uint8Array),
    exception: z.object({ status: z.literal("error"), message: z.string() }),
    error: z.string(),
  },
  replies: { say: "say ack" },
});

/** A scripted packet server: what it received, its sockets. */
interface PacketServer {
  /** Its port. */
  port: number;
  /** Every packet received, parsed. */
  got: Record<string, unknown>[];
  /** The open sockets. */
  sockets: ServerWebSocket<unknown>[];
  /** Sends `packet` (JSON) to every socket. */
  send: (packet: object) => void;
}

const servers: { stop: (force: boolean) => unknown }[] = [];
const handles: { close: () => void }[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  for (const server of servers.splice(0)) await server.stop(true);
});

/** Serves a socket that records packets, answering each with `answer` when given. */
function serve(
  answer?: (packet: Record<string, unknown>) => object | undefined,
): PacketServer {
  const state: PacketServer = {
    port: 0,
    got: [],
    sockets: [],
    send: (packet) => {
      for (const ws of state.sockets) ws.send(JSON.stringify(packet));
    },
  };
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
    websocket: {
      open: (ws) => void state.sockets.push(ws),
      message(ws, message) {
        const packet = JSON.parse(String(message)) as Record<string, unknown>;
        state.got.push(packet);
        const reply = answer?.(packet);
        if (reply !== undefined) ws.send(JSON.stringify(reply));
      },
    },
  });
  servers.push(server);
  state.port = Number(server.port);
  return state;
}

/** A client of `server` and its warnings. */
function clientOf(server: PacketServer) {
  const warnings: string[] = [];
  const api = createClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    mode: "development",
    logger: {
      warn: (message: unknown) => void warnings.push(String(message)),
      error: (...args: unknown[]) => void warnings.push(args.join(" ")),
      debug: () => {},
    },
  });
  return { api, warnings };
}

/** Opens `chat` on `server` with the codec. */
function open(server: PacketServer) {
  const { api, warnings } = clientOf(server);
  const room = channel(api, chat, { codec: "bun-nest" });
  handles.push(room);
  return { room, warnings };
}

describe('the "bun-nest" codec: what it writes', () => {
  it("a send is an EVENT [type, data]; a data-less one [type]; a request carries a numeric id", async () => {
    const server = serve((packet) =>
      packet.id === undefined
        ? undefined
        : { type: 3, namespace: "/", id: packet.id, data: [{ ok: true }] },
    );
    const { room } = open(server);
    room.send("say", { text: "hi" });
    room.send("typing");
    expect(await room.request("say", { text: "asked" })).toEqual({ ok: true });
    expect(server.got).toEqual([
      { type: 2, namespace: "/", data: ["say", { text: "hi" }] },
      { type: 2, namespace: "/", data: ["typing"] },
      { type: 2, namespace: "/", id: 1, data: ["say", { text: "asked" }] },
    ]);
  });

  it("bytes are a BINARY_EVENT, base64, marked (a view's own bytes only)", async () => {
    const server = serve();
    const { room } = open(server);
    const backing = new Uint8Array([9, 0, 1, 255, 9]);
    room.send("upload", backing.subarray(1, 4));
    await until(() => server.got.length === 1);
    expect(server.got[0]).toEqual({
      type: 5,
      namespace: "/",
      data: ["upload", Buffer.from([0, 1, 255]).toString("base64")],
      binary: [0],
    });
  });
});

describe('the "bun-nest" codec: what it reads', () => {
  it("an ACK resolves the request of its id, whatever the order (control: matched by id)", async () => {
    const pending: Record<string, unknown>[] = [];
    const server = serve((packet) => {
      pending.push(packet);
      return undefined;
    });
    const { room } = open(server);
    const first = room.request("say", { text: "one" });
    const second = room.request("say", { text: "two" });
    await until(() => pending.length === 2);
    server.send({
      type: 3,
      namespace: "/",
      id: pending[1].id,
      data: [{ ok: false }],
    });
    server.send({
      type: 3,
      namespace: "/",
      id: pending[0].id,
      data: [{ ok: true }],
    });
    expect(await second).toEqual({ ok: false });
    expect(await first).toEqual({ ok: true });
  });

  it("an ACK with several arguments is their array; a BINARY_ACK's marked ones are bytes", async () => {
    const descriptor: ChannelDescriptor<{
      params: Record<never, never>;
      receives: { pair: undefined; blob: undefined };
      sends: { pairAck: [string, number]; blobAck: [Uint8Array, string] };
      replies: { pair: "pairAck"; blob: "blobAck" };
    }> = {
      path: "/chat",
      replies: { pair: "pairAck", blob: "blobAck" },
      codec: "bun-nest",
    };
    const server = serve((packet) => {
      const [type] = packet.data as [string];
      return type === "pair"
        ? { type: 3, namespace: "/", id: packet.id, data: ["a", 1] }
        : {
            type: 6,
            namespace: "/",
            id: packet.id,
            data: [Buffer.from([7, 8]).toString("base64"), "plain"],
            binary: [0],
          };
    });
    const { api } = clientOf(server);
    // The descriptor's codec applies: no option names one.
    const room = channel(api, descriptor);
    handles.push(room);
    expect(await room.request("pair")).toEqual(["a", 1]);
    const [bytes, plain] = await room.request("blob");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...(bytes as unknown as Uint8Array)]).toEqual([7, 8]);
    expect(plain).toBe("plain");
  });

  it("an ACK no request waits for is ignored", async () => {
    const server = serve();
    const { room, warnings } = open(server);
    const errors: unknown[] = [];
    room.on("$error", (error) => void errors.push(error));
    const pushes: unknown[] = [];
    room.on("said", (data) => void pushes.push(data));
    await until(() => room.state === "open");
    server.send({ type: 3, namespace: "/", id: 41, data: [{ ok: true }] });
    server.send({ type: 2, namespace: "/", data: ["said", { text: "after" }] });
    await until(() => pushes.length === 1);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a server EVENT is a push, even of the reply's type with a waiting request's id (control)", async () => {
    const asked: Record<string, unknown>[] = [];
    const server = serve((packet) => {
      asked.push(packet);
      return undefined;
    });
    const { room } = open(server);
    const pushes: unknown[] = [];
    room.on("say ack", (data) => void pushes.push(data));
    const request = room.request("say", { text: "x" }, { timeout: 150 });
    await until(() => asked.length === 1);
    server.send({
      type: 2,
      namespace: "/",
      id: asked[0].id,
      data: ["say ack", { ok: true }],
    });
    expect(await request.catch((error: unknown) => error)).toBeInstanceOf(
      RequestTimeoutError,
    );
    expect(pushes).toEqual([{ ok: true }]);
  });

  it("a BINARY_EVENT's marked arguments are bytes; several arguments are an array", async () => {
    const server = serve();
    const { room, warnings } = open(server);
    const got: unknown[] = [];
    room.on("bytes", (data) => void got.push(data));
    room.on("pair", (data) => void got.push(data));
    await until(() => room.state === "open");
    server.send({
      type: 5,
      namespace: "/",
      data: ["bytes", Buffer.from([1, 2]).toString("base64")],
      binary: [0],
    });
    server.send({ type: 2, namespace: "/", data: ["pair", "x", 2] });
    await until(() => got.length === 2);
    expect(got[0]).toBeInstanceOf(Uint8Array);
    expect([...(got[0] as Uint8Array)]).toEqual([1, 2]);
    expect(got[1]).toEqual(["x", 2]);
    expect(warnings).toEqual([]);
  });

  it("the ValidationExceptionFilter's exception is a ChannelError on $error; another exception a push", async () => {
    const server = serve();
    const { room } = open(server);
    const errors: unknown[] = [];
    const exceptions: unknown[] = [];
    room.on("$error", (error) => void errors.push(error));
    room.on("exception", (data) => void exceptions.push(data));
    await until(() => room.state === "open");
    const issues = [{ target: "payload", message: "Too small", path: "text" }];
    server.send({
      type: 2,
      namespace: "/",
      data: ["exception", { status: 400, code: "VALIDATION", issues }],
    });
    server.send({
      type: 2,
      namespace: "/",
      data: ["exception", { status: "error", message: "nope" }],
    });
    await until(() => errors.length === 1 && exceptions.length === 1);
    const error = errors[0] as ChannelError;
    expect(error).toBeInstanceOf(ChannelError);
    expect(error.code).toBe("VALIDATION");
    expect(error.status).toBe(400);
    expect(error.issues).toEqual(issues);
    expect(exceptions).toEqual([{ status: "error", message: "nope" }]);
  });

  it('an ERROR packet is an "error" push; CONNECT and DISCONNECT are ignored', async () => {
    const server = serve();
    const { room, warnings } = open(server);
    const got: unknown[] = [];
    room.on("error", (data) => void got.push(data));
    room.on("said", (data) => void got.push(data));
    await until(() => room.state === "open");
    server.send({ type: 0, namespace: "/" });
    server.send({ type: 1, namespace: "/" });
    server.send({ type: 4, namespace: "/", data: "Unexpected token" });
    server.send({ type: 2, namespace: "/", data: ["said", { text: "end" }] });
    await until(() => got.length === 2);
    expect(got).toEqual(["Unexpected token", { text: "end" }]);
    expect(warnings).toEqual([]);
  });
});
