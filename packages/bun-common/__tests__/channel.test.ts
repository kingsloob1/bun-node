/**
 * `defineChannel` (lib/channel.ts), served for real: a good frame reaches its
 * handler parsed; a bad one is answered with a value-free error frame and the
 * socket stays open (unless `closeOnInvalid`); a socket's frames are handled
 * one at a time, in order, sends included; the upgrade's request side refuses
 * a bad request with a 400 before the 101; `send`/`publish` are typed and
 * checked under the out policy. The pure half (lib/contract/channel.ts) is
 * covered in __tests__/contract/channel.test.ts.
 */
import type { ServerWebSocket } from "bun";
import type { Channel, ChannelHandlers } from "../lib/channel";
import type { WebSocketClientData } from "../lib/BunWebSocket";
import type { ChannelSpec } from "../lib/contract/channel";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import type { RawResponseHead } from "./helpers";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { defineChannel } from "../lib/channel";
import { describeContract } from "../lib/contract/describe";
import { ContractError } from "../lib/contract/guard";
import { getContract } from "../lib/contract/transport";
import { createTestLogger } from "../lib/logging";
import { negotiatedProtocol, rawUpgrade } from "./helpers";

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(10);
  }
}

/** The values of every `name` header in `head`, in wire order. */
function values(head: RawResponseHead, name: string): string[] {
  return head.headers.filter(([key]) => key === name).map(([, v]) => v);
}

/** Opens a client and resolves once the socket is open, with its frames (each parsed as JSON) and their raw text. */
async function openClient(url: string) {
  const client = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  const raw: string[] = [];
  client.onmessage = (event) => {
    raw.push(String(event.data));
    frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  };
  await new Promise<void>((resolve, reject) => {
    client.onopen = () => resolve();
    client.onerror = (event) =>
      reject(new Error(`WebSocket ${url} failed to open`, { cause: event }));
  });
  return { client, frames, raw };
}

/**
 * Starts an adapter serving `channel` — the checks route before the ws route —
 * and listens on an OS-assigned port.
 */
async function serve<S extends ChannelSpec>(
  channel: Channel<S>,
  handlers: ChannelHandlers<S["receives"]>,
  setup?: (adapter: BunHttpAdapter) => void,
): Promise<{ adapter: BunHttpAdapter; port: number }> {
  const { logger } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger });
  adapter.get(channel.path, channel.checks());
  adapter.ws(channel.path, channel.handler(handlers), channel.options());
  setup?.(adapter);
  const server = await adapter.listen(0);
  return { adapter, port: Number(server.port) };
}

/** `say` data, with a coercion so output ≠ input. */
const Say = z.object({ text: z.string(), at: z.coerce.date() });
/** `said`, the server's answer. */
const Said = z.object({ by: z.string(), text: z.string() });
/** The upgrade's params: a room is a lower-case slug. */
const RoomParams = z.object({ room: z.string().regex(/^[a-z][a-z0-9-]*$/) });

/** A value no error frame or issue may ever quote (its capitals also fail the room check). */
const SECRET = "Hunter2-Room-Secret";

/** The instant the good frames carry. */
const AT = "2026-10-23T00:00:00.000Z";

/** The chat channel the suite serves, fresh per test (`handler()` captures its table per instance). */
function makeChat() {
  return defineChannel({
    path: "/rooms/:room",
    request: { params: RoomParams },
    receives: { say: Say, typing: null },
    sends: { said: Said },
  });
}

/** A `say` frame's wire text. */
function sayFrame(data: unknown, id?: string): string {
  return JSON.stringify({
    type: "say",
    ...(id === undefined ? {} : { id }),
    data,
  });
}

/** The good `say` data. */
function sayData(text: string) {
  return { text, at: AT };
}

/** The room of a connection, from the route's params (a channel handler's `ws.data` is `never`). */
function roomOf(ws: ServerWebSocket<never>): string {
  return String((ws.data as WebSocketClientData).params?.room);
}

describe("defineChannel: incoming frames", () => {
  it("a good frame reaches its handler with the schema's parsed output (a coercion included)", async () => {
    const chat = makeChat();
    const seen: { text: string; at: Date }[] = [];
    const { adapter, port } = await serve(chat, {
      say(_ws, msg) {
        seen.push(msg);
      },
    });
    try {
      const { client, frames } = await openClient(
        `ws://127.0.0.1:${port}/rooms/general`,
      );
      client.send(sayFrame(sayData("hello"), "m-1"));
      await until(() => seen.length === 1);
      client.close();
      expect(seen).toEqual([{ text: "hello", at: new Date(AT) }]);
      expect(seen[0].at).toBeInstanceOf(Date);
      // A good frame is answered with nothing.
      expect(frames).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("an invalid frame is answered VALIDATION — the issues value-free — and the socket stays open", async () => {
    const chat = makeChat();
    const seen: unknown[] = [];
    const { adapter, port } = await serve(chat, {
      say(_ws, msg) {
        seen.push(msg);
      },
    });
    try {
      const { client, frames, raw } = await openClient(
        `ws://127.0.0.1:${port}/rooms/general`,
      );
      client.send(sayFrame({ text: 42, at: SECRET }, "m-1"));
      await until(() => frames.length === 1);
      expect(frames[0]).toMatchObject({
        type: "error",
        id: "m-1",
        code: "VALIDATION",
        status: 400,
      });
      const issues = frames[0].issues as Record<string, unknown>[];
      expect(Array.isArray(issues)).toBe(true);
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(issue.target).toBe("data");
        expect(issue.key).toBe("say");
        // Value-free: a message and a path, never the offending value.
        expect(Object.keys(issue).sort()).toEqual([
          "key",
          "message",
          "path",
          "target",
        ]);
      }
      expect(raw[0]).not.toContain(SECRET);
      // The socket stays open, and a good frame still reaches the handler.
      expect(client.readyState).toBe(WebSocket.OPEN);
      client.send(sayFrame(sayData("after")));
      await until(() => seen.length === 1);
      client.close();
      expect(seen).toEqual([{ text: "after", at: new Date(AT) }]);
    } finally {
      await adapter.close();
    }
  });

  it("an unknown type is answered UNKNOWN_MESSAGE, echoing the frame's id", async () => {
    const chat = makeChat();
    const { adapter, port } = await serve(chat, {});
    try {
      const { client, frames } = await openClient(
        `ws://127.0.0.1:${port}/rooms/general`,
      );
      client.send(JSON.stringify({ type: "nope", id: "m-9", data: {} }));
      await until(() => frames.length === 1);
      client.close();
      expect(frames).toEqual([
        {
          type: "error",
          id: "m-9",
          code: "UNKNOWN_MESSAGE",
          status: 400,
          detail: "Unknown message type (declared: say, typing)",
        },
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("a null receives entry passes with no data, and one with data is answered VALIDATION", async () => {
    const chat = makeChat();
    const typingCalls: unknown[][] = [];
    const { adapter, port } = await serve(chat, {
      typing(_ws, ...rest: unknown[]) {
        typingCalls.push(rest);
      },
    });
    try {
      const { client, frames } = await openClient(
        `ws://127.0.0.1:${port}/rooms/general`,
      );
      client.send(JSON.stringify({ type: "typing" }));
      await until(() => typingCalls.length === 1);
      client.send(JSON.stringify({ type: "typing", data: { at: AT } }));
      await until(() => frames.length === 1);
      client.close();
      // The handler is passed the socket, and `undefined` for the absent data.
      expect(typingCalls).toEqual([[undefined]]);
      expect(frames).toEqual([
        {
          type: "error",
          code: "VALIDATION",
          status: 400,
          issues: [
            {
              target: "data",
              message: "No data is declared here",
              path: "",
              key: "typing",
            },
          ],
        },
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("a malformed JSON frame, and a non-object frame, are each answered VALIDATION, in order", async () => {
    const chat = makeChat();
    const { adapter, port } = await serve(chat, {});
    try {
      const { client, frames } = await openClient(
        `ws://127.0.0.1:${port}/rooms/general`,
      );
      client.send("{ not json");
      client.send(JSON.stringify([1, 2]));
      client.send("42");
      await until(() => frames.length === 3);
      client.close();
      expect(frames).toEqual([
        {
          type: "error",
          code: "VALIDATION",
          status: 400,
          issues: [
            {
              target: "data",
              message: "The message is not valid JSON",
              path: "",
            },
          ],
        },
        {
          type: "error",
          code: "VALIDATION",
          status: 400,
          issues: [
            {
              target: "data",
              message: "A frame is an object with a `type` and its data",
              path: "",
            },
          ],
        },
        {
          type: "error",
          code: "VALIDATION",
          status: 400,
          issues: [
            {
              target: "data",
              message: "A frame is an object with a `type` and its data",
              path: "",
            },
          ],
        },
      ]);
    } finally {
      await adapter.close();
    }
  });
});

describe("defineChannel: closeOnInvalid", () => {
  it("answers the error frame, then closes with 1007", async () => {
    const strict = defineChannel({
      path: "/strict",
      receives: { say: Say },
      sends: { said: Said },
      closeOnInvalid: true,
    });
    const { adapter, port } = await serve(strict, {});
    try {
      const { client, frames } = await openClient(
        `ws://127.0.0.1:${port}/strict`,
      );
      const closed = new Promise<number>((resolve) => {
        client.addEventListener("close", (event) => resolve(event.code), {
          once: true,
        });
      });
      client.send(sayFrame({ text: 42, at: AT }, "m-close"));
      const code = await closed;
      expect(frames).toEqual([
        {
          type: "error",
          id: "m-close",
          code: "VALIDATION",
          status: 400,
          issues: [
            {
              target: "data",
              path: "text",
              key: "say",
              message: "Invalid input: expected string, received number",
            },
          ],
        },
      ]);
      expect(code).toBe(1007);
    } finally {
      await adapter.close();
    }
  });
});

describe("defineChannel: binary frames", () => {
  it("a binary frame is refused UNSUPPORTED_DATA unless the channel declares binary", async () => {
    const chat = makeChat();
    const { adapter, port } = await serve(chat, {});
    try {
      const { client, frames } = await openClient(
        `ws://127.0.0.1:${port}/rooms/general`,
      );
      client.send(new TextEncoder().encode(sayFrame(sayData("bin"))));
      await until(() => frames.length === 1);
      client.close();
      expect(frames).toEqual([
        {
          type: "error",
          code: "UNSUPPORTED_DATA",
          status: 400,
          detail: "Binary frames are not declared on this channel",
        },
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("with binary: true, a binary frame is decoded and checked like a text frame", async () => {
    const binary = defineChannel({
      path: "/bin",
      receives: { say: Say },
      sends: { said: Said },
      binary: true,
    });
    const seen: { text: string; at: Date }[] = [];
    const { adapter, port } = await serve(binary, {
      say(_ws, msg) {
        seen.push(msg);
      },
    });
    try {
      const { client, frames } = await openClient(`ws://127.0.0.1:${port}/bin`);
      client.send(new TextEncoder().encode(sayFrame(sayData("bin"), "m-bin")));
      await until(() => seen.length === 1);
      client.close();
      expect(seen).toEqual([{ text: "bin", at: new Date(AT) }]);
      expect(seen[0].at).toBeInstanceOf(Date);
      expect(frames).toEqual([]);
    } finally {
      await adapter.close();
    }
  });
});

describe("defineChannel: a socket's frames one at a time, in order", () => {
  it("an async vendor cannot reorder two back-to-back frames, and the sends keep that order", async () => {
    // Longer for n=1 than for n=2: handled concurrently, frame 2's handler
    // would run first.
    const asyncN: StandardSchemaV1<unknown, { n: number }> = {
      "~standard": {
        version: 1,
        vendor: "test-async",
        validate: async (value) => {
          const n =
            typeof value === "object" && value !== null
              ? (value as { n?: unknown }).n
              : undefined;
          if (typeof n !== "number") {
            return {
              issues: [{ message: "Expected { n: number }", path: ["n"] }],
            };
          }
          await Bun.sleep(n === 1 ? 25 : 1);
          return { value: { n } };
        },
      },
    };
    const ticks = defineChannel({
      path: "/ticks",
      receives: { tick: asyncN },
      sends: { tock: z.object({ n: z.number() }) },
    });
    const order: number[] = [];
    const { adapter, port } = await serve(ticks, {
      tick(ws, msg) {
        order.push(msg.n);
        ticks.send(ws, "tock", { n: msg.n });
      },
    });
    try {
      const { client, frames } = await openClient(
        `ws://127.0.0.1:${port}/ticks`,
      );
      client.send(JSON.stringify({ type: "tick", data: { n: 1 } }));
      client.send(JSON.stringify({ type: "tick", data: { n: 2 } }));
      await until(() => frames.length === 2);
      client.close();
      expect(order).toEqual([1, 2]);
      expect(frames).toEqual([
        { type: "tock", data: { n: 1 } },
        { type: "tock", data: { n: 2 } },
      ]);
    } finally {
      await adapter.close();
    }
  });
});

describe("defineChannel: the upgrade's request side", () => {
  it("refuses an upgrade-shaped request whose params fail with a 400 before any socket", async () => {
    const chat = makeChat();
    const { logger } = createTestLogger();
    const adapter = new BunHttpAdapter(0, { logger });
    adapter.get(chat.path, chat.checks());
    adapter.ws(chat.path, chat.handler({}), chat.options());
    // Socket-free: an upgrade can never succeed here, but the checks route
    // answers a failing request itself — the upgrade is never attempted.
    const response = await adapter.fetch(`/rooms/${SECRET}`, {
      headers: {
        connection: "upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error?: unknown;
      issues?: Record<string, unknown>[];
    };
    expect(body.error).toBe("Validation failed");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues?.length).toBeGreaterThan(0);
    expect(body.issues?.[0]?.target).toBe("params");
    // Value-free here too: the offending room is never quoted.
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("passes a good request: the client connects, and the 101 carries the channel's subprotocol", async () => {
    const chat = defineChannel({
      path: "/proto/:room",
      request: { params: RoomParams },
      receives: { say: Say },
      sends: { said: Said },
      subprotocol: "chat.v1",
    });
    const { adapter, port } = await serve(chat, {});
    try {
      // A good request passes the checks and upgrades.
      expect(
        await negotiatedProtocol(`ws://127.0.0.1:${port}/proto/general`, [
          "chat.v1",
        ]),
      ).toBe("chat.v1");
      // The 101, read off the wire, carries the channel's subprotocol.
      const head = await rawUpgrade(port, "/proto/general", ["chat.v1"]);
      expect(head.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
      expect(values(head, "sec-websocket-protocol")).toEqual(["chat.v1"]);
      // A bad one is refused before the 101: no upgrade happens.
      await expect(
        negotiatedProtocol(`ws://127.0.0.1:${port}/proto/${SECRET}`, [
          "chat.v1",
        ]),
      ).rejects.toThrow("no upgrade");
    } finally {
      await adapter.close();
    }
  });

  it("a plain GET to the path is untouched — even one the upgrade check would refuse", async () => {
    const chat = makeChat();
    const { adapter, port } = await serve(chat, {}, (a) => {
      a.get(chat.path, (req, res) => {
        res.json({ room: req.params.room });
      });
    });
    try {
      for (const response of [
        await adapter.fetch(`/rooms/${SECRET}`),
        await fetch(`http://127.0.0.1:${port}/rooms/${SECRET}`),
      ]) {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ room: SECRET });
      }
    } finally {
      await adapter.close();
    }
  });
});

describe("defineChannel: send and publish", () => {
  it('send() under "error" throws a ContractError to the caller on a bad frame, and writes a good one', async () => {
    const chat = makeChat();
    const { logger } = createTestLogger();
    const adapter = new BunHttpAdapter(0, { logger });
    let serverSide: ServerWebSocket<never> | undefined;
    adapter.webSocketAdapter.on("open", (ws) => {
      if (ws.data.route === chat.path) {
        serverSide = ws as ServerWebSocket<never>;
      }
    });
    adapter.get(chat.path, chat.checks());
    adapter.ws(chat.path, chat.handler({}), chat.options());
    const server = await adapter.listen(0);
    try {
      const { client, frames } = await openClient(
        `ws://127.0.0.1:${Number(server.port)}/rooms/general`,
      );
      await until(() => serverSide !== undefined);
      const ws = serverSide as ServerWebSocket<never>;
      // A synchronous vendor (zod) under "error": the mismatch throws to the
      // caller, synchronously...
      const bad = () => chat.send(ws, "said", { by: 42, text: "x" } as never);
      expect(bad).toThrow(ContractError);
      expect(bad).toThrow(/websocket outbound said failed its contract/);
      // ...and nothing is queued or written for it.
      await Bun.sleep(25);
      expect(frames).toEqual([]);
      // A good frame is written.
      chat.send(ws, "said", { by: "server", text: "hello" });
      await until(() => frames.length === 1);
      client.close();
      expect(frames).toEqual([
        { type: "said", data: { by: "server", text: "hello" } },
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("publish() reaches the topic's other clients, not the sender", async () => {
    const chat = makeChat();
    const { adapter, port } = await serve(
      chat,
      {
        say(ws, msg) {
          chat.publish(ws, `room:${roomOf(ws)}`, "said", {
            by: "peer",
            text: msg.text,
          });
        },
      },
      (a) => {
        a.webSocketAdapter.on("open", (ws) => {
          if (ws.data.route === chat.path) {
            ws.subscribe(`room:${String(ws.data.params?.room)}`);
          }
        });
      },
    );
    try {
      const ada = await openClient(`ws://127.0.0.1:${port}/rooms/general`);
      const bob = await openClient(`ws://127.0.0.1:${port}/rooms/general`);
      ada.client.send(sayFrame(sayData("hello")));
      await until(() => bob.frames.length === 1);
      await Bun.sleep(25);
      ada.client.close();
      bob.client.close();
      expect(bob.frames).toEqual([
        { type: "said", data: { by: "peer", text: "hello" } },
      ]);
      expect(ada.frames).toEqual([]);
    } finally {
      await adapter.close();
    }
  });
});

describe("defineChannel: the contract it carries", () => {
  it("describeContract lists both sides' types, the implicit error frame included", () => {
    const chat = makeChat();
    const described = describeContract(chat.contract.contract);
    expect(described.transport).toBe("websocket");
    expect(described.meta).toEqual({ name: "/rooms/:room" });
    expect(described.sides.inbound).toEqual({
      declared: true,
      keys: ["say", "typing"],
    });
    expect(described.sides.outbound).toEqual({
      declared: true,
      keys: ["error", "said"],
    });
    const rows = described.entries.map(({ schema: _s, ...rest }) => rest);
    expect(rows).toEqual([
      {
        side: "inbound",
        keyName: "type",
        key: "say",
        part: "data",
        encoding: "body",
        kind: "value",
        vendor: "zod",
      },
      {
        side: "inbound",
        keyName: "type",
        key: "typing",
        part: "data",
        encoding: "body",
        kind: "value",
      },
      {
        side: "outbound",
        keyName: "type",
        key: "error",
        part: "data",
        encoding: "body",
        kind: "value",
        vendor: "bun-common/documented",
      },
      {
        side: "outbound",
        keyName: "type",
        key: "said",
        part: "data",
        encoding: "body",
        kind: "value",
        vendor: "zod",
      },
    ]);
  });

  it("the handler carries the contract", () => {
    const chat = makeChat();
    expect(getContract(chat.handler({}))).toBe(chat.contract.contract);
  });
});

describe("defineChannel: the typed surface", () => {
  it("send() takes only a declared type, with its data", () => {
    const chat = makeChat();
    // Never called: the assertions are the compiler's.
    const typecheck = (ws: ServerWebSocket<never>): void => {
      chat.send(ws, "said", { by: "server", text: "hi" });
      // @ts-expect-error — "said" data is { by: string; text: string }
      chat.send(ws, "said", { by: 42, text: "hi" });
      // @ts-expect-error — "nope" is not one of the channel's sends
      chat.send(ws, "nope", { by: "server", text: "hi" });
      // @ts-expect-error — the implicit "error" frame is not the app's to send
      chat.send(ws, "error", {});
    };
    expect(typecheck).toBeInstanceOf(Function);
  });
});
