/**
 * `channel()` (typed-client plan, `websocket.md` §4–§8, §12, PR-W2) against
 * real bun-common channels: `defineChannel(contract)` served by a
 * `BunHttpAdapter` on port 0, the client and the server in one process.
 *
 * Covered: send and receive, both checked (control: production checks
 * nothing); a planted invalid server frame warned and delivered, dropped
 * under `"drop"`; a request resolved by its echoed id while a push of the
 * same type arrives first; the custom idField; error frames (a request's,
 * and `$error`); timeouts; a drop rejecting waiting requests and re-running
 * `resubscribe`; `retry: true`; a fatal close code not retried; the offline
 * buffer's order and limit and `"fail"`; `sendWhenReady` on a large
 * `bufferedAmount`; the heartbeat watchdog and the ping; one socket per URL;
 * `messages()`; `close()`; a custom codec; a generated descriptor checked by
 * generated schemas; BYO schemas; the URL.
 */
import type { ServerWebSocket } from "bun";
import type { BunHttpAdapter as Adapter } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunHttpAdapter,
  channelContract,
  createTestLogger,
  defineChannel,
} from "@kingsleyweb/bun-common";
import { z } from "zod";
import type { ChannelDescriptor } from "../lib/channel";
import {
  channel,
  ChannelClosedError,
  ChannelError,
  DisconnectedError,
  RequestTimeoutError,
} from "../lib/channel";
import { createClient, ValidationError } from "../lib/index";

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

const AT = "2026-11-03T00:00:00.000Z";

/** The shared, browser-safe half: what a client imports. */
const chat = channelContract({
  path: "/rooms/:room",
  request: { params: z.object({ room: z.string().regex(/^[a-z]+$/) }) },
  receives: {
    say: z.object({ text: z.string().min(1), at: z.iso.datetime().optional() }),
    quiet: z.object({ text: z.string() }),
    typing: null,
    ping: null,
    plant: z.object({ frame: z.string() }),
    close: z.object({ code: z.number(), reason: z.string() }),
  },
  sends: {
    said: z.object({ by: z.string(), text: z.string(), at: z.iso.datetime() }),
    someoneTyping: z.object({ by: z.string() }),
    pong: null,
  },
  replies: { say: "said", quiet: "said" },
});

/** What the server saw and how it behaves, per test. */
interface Server {
  adapter: Adapter;
  port: number;
  /** Every frame's type the server handled, in order. */
  seen: string[];
  /** Every `say` text, in order. */
  texts: string[];
  /** Sockets opened so far. */
  opens: number;
  /** The open sockets. */
  sockets: Set<ServerWebSocket<unknown>>;
  /** `say` pushes a `said` without an id first. */
  pushFirst: boolean;
}

const servers: Adapter[] = [];
const handles: { close: () => void }[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  for (const adapter of servers.splice(0)) await adapter.close();
});

/** Serves `chat` on port 0; `deflate: false` turns per-message deflate off. */
async function serve(
  contract = chat,
  options: { deflate?: boolean } = {},
): Promise<Server> {
  const ch = defineChannel(contract);
  const { logger } = createTestLogger();
  const adapter = new BunHttpAdapter(0, {
    logger,
    ...(options.deflate === false
      ? { websocket: { wsOptions: { perMessageDeflate: false } } }
      : {}),
  });
  const server = {
    adapter,
    port: 0,
    seen: [] as string[],
    texts: [] as string[],
    opens: 0,
    sockets: new Set<ServerWebSocket<unknown>>(),
    pushFirst: false,
  };
  adapter.webSocketAdapter.on("open", (ws) => {
    server.opens++;
    server.sockets.add(ws);
  });
  adapter.webSocketAdapter.on("close", (ws) => {
    server.sockets.delete(ws);
  });
  adapter.ws(
    ch.path,
    ch.checks(),
    ch.handler({
      say(ws, msg) {
        server.seen.push("say");
        server.texts.push(msg.text);
        if (server.pushFirst)
          void ch.send(ws, "said", { by: "someone", text: "a push", at: AT });
        return { by: "me", text: msg.text, at: AT };
      },
      quiet() {
        server.seen.push("quiet");
      },
      typing(ws) {
        server.seen.push("typing");
        void ch.send(ws, "someoneTyping", { by: ws.data.params.room });
      },
      ping(ws) {
        server.seen.push("ping");
        void ch.send(ws, "pong");
      },
      plant(ws, msg) {
        // A frame written past the out policy: what a drifted server sends.
        ws.send(msg.frame);
      },
      close(ws, msg) {
        ws.close(msg.code, msg.reason);
      },
    }),
    ch.options(),
  );
  servers.push(adapter);
  const bound = await adapter.listen(0);
  server.port = Number(bound.port);
  return server;
}

/** A client of `server`, its warnings collected. */
function clientOf(
  server: Server,
  extra: Parameters<typeof createClient>[0] = {},
) {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const api = createClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    mode: "development",
    logger: {
      warn: (message: unknown) => void warnings.push(String(message)),
      error: (...args: unknown[]) => void errors.push(args),
      debug: () => {},
    },
    ...extra,
  });
  return { api, warnings, errors };
}

/** Keeps `handle` for the cleanup. */
function kept<C extends { close: () => void }>(handle: C): C {
  handles.push(handle);
  return handle;
}

/** Resolves once `room` is open. */
async function opened(room: { state: string }) {
  await until(() => room.state === "open");
}

describe("channel(): send and receive", () => {
  it("sends a checked message and receives a typed push", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    const typing: { by: string }[] = [];
    room.on("someoneTyping", (data) => void typing.push(data));
    room.send("typing");
    await until(() => typing.length === 1);
    expect(typing).toEqual([{ by: "lobby" }]);
    expect(server.seen).toEqual(["typing"]);
    expect(room.state).toBe("open");
  });

  it("a send failing the contract throws ValidationError and writes nothing", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    await opened(room);
    let thrown: unknown;
    try {
      room.send("say", { text: "" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).direction).toBe("send");
    expect((thrown as ValidationError).issues).toEqual([
      expect.objectContaining({
        target: "data",
        key: "say",
        path: "text",
        source: "builtin",
      }),
    ]);
    room.send("typing");
    await until(() => server.seen.length === 1);
    expect(server.seen).toEqual(["typing"]);
  });

  it("control: in production nothing is checked, and the server answers the bad frame with an error frame", async () => {
    const server = await serve();
    const { api } = clientOf(server, { mode: "production" });
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    const errors: unknown[] = [];
    room.on("$error", (error) => void errors.push(error));
    await opened(room);
    room.send("say", { text: "" });
    await until(() => errors.length === 1);
    expect(errors[0]).toBeInstanceOf(ChannelError);
    expect((errors[0] as ChannelError).code).toBe("VALIDATION");
    expect((errors[0] as ChannelError).issues.length).toBe(1);
  });

  it("the client's level applies: validate.request turns sends off, onFailure.request sets their failure mode", async () => {
    const server = await serve();
    const off = clientOf(server, { validate: { request: false } });
    const unchecked = kept(
      channel(off.api, chat, { params: { room: "lobby" } }),
    );
    const errors: unknown[] = [];
    unchecked.on("$error", (error) => void errors.push(error));
    await opened(unchecked);
    unchecked.send("say", { text: "" });
    // Not refused here: the server answers it.
    await until(() => errors.length === 1);
    expect(errors[0]).toBeInstanceOf(ChannelError);

    const warn = clientOf(server, {
      validate: { onFailure: { request: "warn" } },
    });
    const lax = kept(channel(warn.api, chat, { params: { room: "lobby" } }));
    await opened(lax);
    await lax.request("say", { text: "ok" });
    lax.send("say", { text: "" });
    expect(warn.warnings).toEqual([
      expect.stringContaining("/rooms/:room send failed validation: data.text"),
    ]);
  });

  it("a send before the checks loaded is checked in order once they have; its failure reaches $error", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    const errors: unknown[] = [];
    room.on("$error", (error) => void errors.push(error));
    // Synchronously after channel(): the checks are still loading.
    room.send("say", { text: "first" });
    room.send("say", { text: "" });
    room.send("say", { text: "third" });
    await until(() => server.texts.length === 2 && errors.length === 1);
    expect(server.texts).toEqual(["first", "third"]);
    expect(errors[0]).toBeInstanceOf(ValidationError);
  });

  it('a planted invalid server frame is warned and delivered; under "drop" it is dropped and $invalid fires', async () => {
    const server = await serve();
    const bad = JSON.stringify({ type: "someoneTyping", data: { by: 42 } });
    const good = JSON.stringify({ type: "someoneTyping", data: { by: "ada" } });

    const warned = clientOf(server);
    const room = kept(channel(warned.api, chat, { params: { room: "lobby" } }));
    const seen: unknown[] = [];
    room.on("someoneTyping", (data) => void seen.push(data));
    room.send("plant", { frame: bad });
    room.send("plant", { frame: good });
    await until(() => seen.length === 2);
    expect(seen).toEqual([{ by: 42 }, { by: "ada" }]);
    expect(warned.warnings).toEqual([
      expect.stringContaining(
        "/rooms/:room receive failed validation: data.by",
      ),
    ]);

    const dropped = clientOf(server);
    const strict = kept(
      channel(dropped.api, chat, {
        params: { room: "other" },
        validate: { onFailure: { receive: "drop" } },
      }),
    );
    const kept2: unknown[] = [];
    const invalid: ValidationError[] = [];
    strict.on("someoneTyping", (data) => void kept2.push(data));
    strict.on("$invalid", (error) => void invalid.push(error));
    strict.send("plant", { frame: bad });
    strict.send("plant", { frame: good });
    await until(() => kept2.length === 1 && invalid.length === 1);
    expect(kept2).toEqual([{ by: "ada" }]);
    expect(invalid[0].direction).toBe("receive");
    expect(dropped.warnings).toEqual([]);
  });

  it("an undeclared message type arriving is warned as drift and delivered", async () => {
    const server = await serve();
    const { api, warnings } = clientOf(server);
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    const all: unknown[] = [];
    void (async () => {
      for await (const message of room.messages()) all.push(message);
    })();
    room.send("plant", {
      frame: JSON.stringify({ type: "surprise", data: 1 }),
    });
    await until(() => all.length === 1);
    expect(all).toEqual([{ type: "surprise", data: 1 }]);
    expect(warnings[0]).toContain("This type is not declared");
  });
});

describe("channel(): requests", () => {
  it("resolves by the echoed id, while a push of the reply's type arrives first", async () => {
    const server = await serve();
    server.pushFirst = true;
    const { api } = clientOf(server);
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    const pushes: unknown[] = [];
    room.on("said", (data) => void pushes.push(data));
    const reply = await room.request("say", { text: "hello" });
    expect(reply).toEqual({ by: "me", text: "hello", at: AT });
    await until(() => pushes.length === 1);
    // The push (no id) went to the listeners; the reply did not.
    expect(pushes).toEqual([{ by: "someone", text: "a push", at: AT }]);
  });

  it("echoes the channel's own idField", async () => {
    const rid = channelContract({
      path: "/rid",
      receives: { say: z.object({ text: z.string() }) },
      sends: { said: z.object({ text: z.string() }) },
      replies: { say: "said" },
      envelope: { idField: "rid" },
    });
    const ch = defineChannel(rid);
    const adapter = new BunHttpAdapter(0, {
      logger: createTestLogger().logger,
    });
    const frames: string[] = [];
    const handler = ch.handler({
      say: (_ws, msg) => ({ text: msg.text.toUpperCase() }),
    });
    adapter.ws(
      ch.path,
      ch.checks(),
      {
        ...handler,
        message(ws, message) {
          frames.push(String(message));
          return handler.message(ws as never, message);
        },
      },
      ch.options(),
    );
    servers.push(adapter);
    const bound = await adapter.listen(0);
    const api = createClient({ baseUrl: `http://127.0.0.1:${bound.port}` });
    const room = kept(channel(api, rid));
    expect(await room.request("say", { text: "hi" })).toEqual({ text: "HI" });
    expect(JSON.parse(frames[0]) as unknown).toEqual({
      type: "say",
      rid: "1",
      data: { text: "hi" },
    });
    // bun-common's error frame echoes the id as `id` whatever the idField
    // (`channelErrorFrame`): the request still matches it.
    const unchecked = createClient({
      baseUrl: `http://127.0.0.1:${bound.port}`,
      mode: "production",
    });
    const raw = kept(channel(unchecked, rid, { reconnect: false }));
    const error = await raw
      .request("say", { text: 1 as unknown as string })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ code: "VALIDATION", type: "say" });
  });

  it("an error frame echoing the request's id rejects it with ChannelError", async () => {
    const server = await serve();
    const { api } = clientOf(server, { mode: "production" });
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    const error = await room
      .request("say", { text: "" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({
      code: "VALIDATION",
      status: 400,
      type: "say",
    });
  });

  it("rejects with RequestTimeoutError when no reply comes", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    const error = await room
      .request("quiet", { text: "x" }, { timeout: 50 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error).toMatchObject({ type: "quiet", id: "1", timeout: 50 });
  });

  it('a reply failing its check rejects under "throw" and is delivered under "warn"', async () => {
    const lax = channelContract({
      path: "/lax",
      receives: { say: z.object({ text: z.string() }) },
      sends: { said: z.object({ text: z.string() }) },
      replies: { say: "said" },
      messageValidation: { out: "off" },
    });
    const ch = defineChannel(lax);
    const adapter = new BunHttpAdapter(0, {
      logger: createTestLogger().logger,
    });
    adapter.ws(
      ch.path,
      ch.checks(),
      ch.handler({ say: () => ({ text: 7 }) as unknown as { text: string } }),
      ch.options(),
    );
    servers.push(adapter);
    const bound = await adapter.listen(0);
    const api = createClient({
      baseUrl: `http://127.0.0.1:${bound.port}`,
      logger: { warn: () => {}, error: () => {}, debug: () => {} },
    });
    const warn = kept(channel(api, lax));
    // Typed `{ text: string }`; delivered as it arrived under "warn".
    expect((await warn.request("say", { text: "x" })) as unknown).toEqual({
      text: 7,
    });
    const strict = kept(
      channel(api, lax, { validate: { onFailure: { receive: "throw" } } }),
    );
    const error = await strict
      .request("say", { text: "x" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe("channel(): reconnection", () => {
  it("a drop rejects waiting requests with DisconnectedError, reconnects and re-runs resubscribe", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    let resubscribed = 0;
    const room = kept(
      channel(api, chat, {
        params: { room: "lobby" },
        reconnect: { initialMs: 10, maxMs: 20 },
        resubscribe: (r) => {
          resubscribed++;
          r.send("typing");
        },
      }),
    );
    const states: string[] = [];
    room.on("$state", (state) => void states.push(state));
    await until(() => server.seen.length === 1);
    const waiting = room
      .request("quiet", { text: "x" })
      .catch((e: unknown) => e);
    await until(() => server.seen.length === 2);
    for (const ws of server.sockets) ws.close(1011, "restart");
    const error = await waiting;
    expect(error).toBeInstanceOf(DisconnectedError);
    expect(error).toMatchObject({ code: 1011, reason: "restart" });
    await until(() => resubscribed === 2 && server.seen.length === 3);
    expect(server.seen).toEqual(["typing", "quiet", "typing"]);
    expect(states).toEqual(["open", "reconnecting", "open"]);
    expect(server.opens).toBe(2);
  });

  it("retry: true sends the request again after the reconnect", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(
      channel(api, chat, {
        params: { room: "lobby" },
        reconnect: { initialMs: 10 },
      }),
    );
    await opened(room);
    // The first socket drops before it answers: the request is resent.
    const first = [...server.sockets][0];
    first.close(1011, "restart");
    const reply = await room.request("say", { text: "again" }, { retry: true });
    expect(reply).toMatchObject({ text: "again" });
    expect(server.opens).toBe(2);
  });

  it("a fatal close code is not retried: the channel closes with ChannelClosedError", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(
      channel(api, chat, {
        params: { room: "lobby" },
        reconnect: { initialMs: 10 },
      }),
    );
    const errors: unknown[] = [];
    room.on("$error", (error) => void errors.push(error));
    await opened(room);
    room.send("close", { code: 4401, reason: "unauthorized" });
    await until(() => room.state === "closed");
    await Bun.sleep(60);
    expect(server.opens).toBe(1);
    expect(errors[0]).toBeInstanceOf(ChannelClosedError);
    expect(errors[0]).toMatchObject({ code: 4401, reason: "unauthorized" });
    expect(() => room.send("typing")).toThrow(ChannelClosedError);
  });

  it("control: a non-fatal close code is retried", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(
      channel(api, chat, {
        params: { room: "lobby" },
        reconnect: { initialMs: 10 },
      }),
    );
    await opened(room);
    room.send("close", { code: 4000, reason: "again" });
    await until(() => server.opens === 2 && room.state === "open");
  });

  it("the heartbeat watchdog closes a silent socket with 4000 and reconnects", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(
      channel(api, chat, {
        params: { room: "lobby" },
        reconnect: { initialMs: 10 },
        heartbeat: { type: "pong", intervalMs: 40, slackMs: 0 },
      }),
    );
    const states: string[] = [];
    room.on("$state", (state) => void states.push(state));
    await until(() => server.opens === 2, 2000);
    expect(states.slice(0, 2)).toEqual(["open", "reconnecting"]);
  });

  it("a declared ping is sent after intervalMs of silence, and its answer keeps the heartbeat alive", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(
      channel(api, chat, {
        params: { room: "lobby" },
        ping: { type: "ping", intervalMs: 20 },
        heartbeat: { type: "pong", intervalMs: 40, slackMs: 20 },
      }),
    );
    await until(() => server.seen.filter((t) => t === "ping").length >= 4);
    expect(server.opens).toBe(1);
    expect(room.state).toBe("open");
  });
});

describe("channel(): the offline buffer and backpressure", () => {
  it("buffers sends while connecting and flushes them in order on open", async () => {
    const server = await serve();
    const { api } = clientOf(server, { mode: "production" });
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    expect(room.state).toBe("connecting");
    room.send("say", { text: "1" });
    room.send("say", { text: "2" });
    room.send("say", { text: "3" });
    await until(() => server.texts.length === 3);
    expect(server.texts).toEqual(["1", "2", "3"]);
  });

  it('past the buffer\'s limit, and with offline: "fail", send throws ChannelClosedError', async () => {
    const server = await serve();
    const { api } = clientOf(server, { mode: "production" });
    const small = kept(
      channel(api, chat, { params: { room: "small" }, offline: { buffer: 2 } }),
    );
    small.send("typing");
    small.send("typing");
    expect(() => small.send("typing")).toThrow(ChannelClosedError);
    const fail = kept(
      channel(api, chat, { params: { room: "fail" }, offline: "fail" }),
    );
    expect(() => fail.send("typing")).toThrow(ChannelClosedError);
    await until(() => server.seen.length === 2);
  });

  it("sendWhenReady waits until bufferedAmount is under highWaterMark", async () => {
    // Per-message deflate off: compressing and inflating the backlog was
    // nine tenths of this test's time, and what is under test is the
    // socket's buffer, not compression.
    const server = await serve(chat, { deflate: false });
    const { api } = clientOf(server, { mode: "production" });
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    await opened(room);
    const highWaterMark = 1024 * 1024;
    // Frames under the server's 1 MiB maxPayloadLength, queued faster than
    // the socket drains them (the server shares this event loop, so it reads
    // nothing until the loop below ends). The kernel takes the first few
    // MiB, how many depends on the machine, so frames are queued until the
    // socket's own buffer holds twice the mark, not a fixed count: a fixed 40
    // (20 MiB, deflated, each echoed back) outlasted the test's 5 s under
    // load. `quiet` has no reply, so nothing comes back.
    const big = "x".repeat(512 * 1024);
    let frames = 0;
    while (room.bufferedAmount < 2 * highWaterMark && frames < 200) {
      room.send("quiet", { text: big });
      frames++;
    }
    expect(room.bufferedAmount).toBeGreaterThanOrEqual(2 * highWaterMark);
    let sentAt = -1;
    await room.sendWhenReady("say", { text: "small" }).then(() => {
      sentAt = room.bufferedAmount;
    });
    expect(sentAt).toBeLessThan(highWaterMark + 100);
    await until(() => server.texts.length === 1, 10_000);
    expect(server.texts).toEqual(["small"]);
    expect(server.seen).toEqual([
      ...Array.from({ length: frames }, () => "quiet"),
      "say",
    ]);
  });
});

describe("channel(): handles", () => {
  it("two channels on one URL share one socket; it closes with the last", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const a = kept(channel(api, chat, { params: { room: "lobby" } }));
    const b = kept(channel(api, chat, { params: { room: "lobby" } }));
    const other = kept(channel(api, chat, { params: { room: "other" } }));
    await opened(a);
    await opened(other);
    expect(b.state).toBe("open");
    expect(server.opens).toBe(2);
    const heardA: unknown[] = [];
    const heardB: unknown[] = [];
    a.on("someoneTyping", (data) => void heardA.push(data));
    b.on("someoneTyping", (data) => void heardB.push(data));
    a.send("typing");
    await until(() => heardA.length === 1 && heardB.length === 1);
    a.close();
    expect(a.state).toBe("closed");
    expect(b.state).toBe("open");
    expect(() => a.send("typing")).toThrow(ChannelClosedError);
    b.send("typing");
    await until(() => server.seen.length === 2);
    b.close();
    await until(() => server.sockets.size === 1);
  });

  it("close() rejects its waiting requests and ends its iterators", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    await opened(room);
    const waiting = room
      .request("quiet", { text: "x" })
      .catch((e: unknown) => e);
    const iterator = room.messages("someoneTyping");
    const next = iterator.next();
    await until(() => server.seen.length === 1);
    room.close();
    expect(await waiting).toBeInstanceOf(ChannelClosedError);
    expect(await next).toEqual({ value: undefined, done: true });
  });

  it("messages(type) yields one type's data in order", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(channel(api, chat, { params: { room: "lobby" } }));
    const got: unknown[] = [];
    const done = (async () => {
      for await (const data of room.messages("someoneTyping")) {
        got.push(data);
        if (got.length === 2) break;
      }
    })();
    room.send("typing");
    room.send("say", { text: "not a push of that type" });
    room.send("typing");
    await done;
    expect(got).toEqual([{ by: "lobby" }, { by: "lobby" }]);
  });

  it("refuses a contract with a message type starting with $", () => {
    const api = createClient({ baseUrl: "http://127.0.0.1:1" });
    const bad = channelContract({
      path: "/x",
      receives: { $go: null },
      sends: {},
    });
    expect(() => channel(api, bad)).toThrow(TypeError);
  });

  it("builds the URL like a call's (params encoded, the query serialised, http → ws) and needs an absolute base", async () => {
    const seen: string[] = [];
    const adapter = new BunHttpAdapter(0, {
      logger: createTestLogger().logger,
    });
    const plain = channelContract({ path: "/q/:id", receives: {}, sends: {} });
    const ch = defineChannel(plain);
    adapter.ws(
      ch.path,
      ch.checks(),
      ch.handler({}),
      ch.options((req) => {
        seen.push(req.originalUrl);
        return undefined;
      }),
    );
    servers.push(adapter);
    const bound = await adapter.listen(0);
    const api = createClient({ baseUrl: `http://127.0.0.1:${bound.port}` });
    const room = kept(
      channel(api, plain, {
        params: { id: "a b" },
        query: { page: 2, tag: ["x", "y"] },
      }),
    );
    await opened(room);
    expect(seen).toEqual(["/q/a%20b?page=2&tag=x&tag=y"]);
    expect(() =>
      channel(createClient(), plain, { params: { id: "1" } }),
    ).toThrow(/relative/);
  });
});

describe("channel(): codecs and generated descriptors", () => {
  it("a custom codec reads and writes another envelope", async () => {
    const frames: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        message(ws, message) {
          frames.push(String(message));
          const [type, data] = JSON.parse(String(message)) as [
            string,
            unknown,
            string?,
          ];
          if (type === "hello") ws.send(JSON.stringify(["welcome", data]));
        },
      },
    });
    try {
      const api = createClient({ baseUrl: `http://127.0.0.1:${server.port}` });
      const descriptor: ChannelDescriptor<{
        params: Record<never, never>;
        receives: { hello: { name: string } };
        sends: { welcome: { name: string } };
        replies: Record<never, never>;
      }> = { path: "/" };
      const room = kept(
        channel(api, descriptor, {
          codec: {
            encode: (message) => JSON.stringify([message.type, message.data]),
            decode: (data) => {
              const [type, payload] = JSON.parse(data as string) as [
                string,
                unknown,
              ];
              return { type, data: payload };
            },
          },
        }),
      );
      const welcomed: unknown[] = [];
      room.on("welcome", (data) => void welcomed.push(data));
      room.send("hello", { name: "ada" });
      await until(() => welcomed.length === 1);
      expect(frames).toEqual(['["hello",{"name":"ada"}]']);
      expect(welcomed).toEqual([{ name: "ada" }]);
    } finally {
      await server.stop(true);
    }
  });

  it("a generated descriptor is checked by the schema source's channelSchemas", async () => {
    const server = await serve();
    interface Entry {
      params: { room: string };
      receives: { say: { text: string; at?: string }; typing: undefined };
      sends: {
        said: { by: string; text: string; at: string };
        someoneTyping: { by: string };
      };
      replies: { say: "said" };
    }
    const descriptor: ChannelDescriptor<Entry> = {
      path: "/rooms/:room",
      replies: { say: "said" },
    };
    const { api, warnings } = clientOf(server, {
      schemas: async () => ({
        schemas: {},
        channelSchemas: {
          "/rooms/:room": {
            receives: {
              say: z.looseObject({ text: z.string().min(1) }),
              typing: null,
            },
            sends: {
              said: z.looseObject({ text: z.string() }),
              someoneTyping: z.looseObject({ by: z.literal("nobody") }),
            },
          },
        },
      }),
    });
    const room = kept(channel(api, descriptor, { params: { room: "lobby" } }));
    const typed: unknown[] = [];
    room.on("someoneTyping", (data) => void typed.push(data));
    const refused = await room
      .request("say", { text: "" })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ValidationError);
    expect(await room.request("say", { text: "ok" })).toMatchObject({
      text: "ok",
    });
    room.send("typing");
    await until(() => typed.length === 1);
    expect(warnings).toEqual([
      expect.stringContaining("receive failed validation: data.by"),
    ]);
  });

  it("a BYO schema runs after the built-in one; replace runs it alone; false turns a type off", async () => {
    const server = await serve();
    const { api } = clientOf(server);
    const room = kept(
      channel(api, chat, {
        params: { room: "lobby" },
        validate: {
          send: {
            say: { custom: z.object({ text: z.string().max(3) }) },
            quiet: {
              custom: z.object({ text: z.literal("ok") }),
              replace: true,
            },
          },
        },
      }),
    );
    await opened(room);
    await until(() => {
      try {
        room.send("say", { text: "" });
        return false;
      } catch (error) {
        return error instanceof ValidationError;
      }
    });
    const both = (() => {
      try {
        room.send(
          "say",
          { text: "" },
          { validate: { custom: z.object({ text: z.string().min(5) }) } },
        );
      } catch (error) {
        return (error as ValidationError).issues.map((issue) => issue.source);
      }
    })();
    expect(both).toEqual(["builtin", "custom"]);
    expect(() => room.send("say", { text: "toolong" })).toThrow(
      ValidationError,
    );
    expect(() => room.send("quiet", { text: "no" })).toThrow(ValidationError);
    room.send("quiet", { text: "ok" });
    room.send("say", { text: "" }, { validate: false });
    await until(() => server.seen.length === 1);
  });
});
