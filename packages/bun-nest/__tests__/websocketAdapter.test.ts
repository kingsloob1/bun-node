import type { WebSocketClient } from "@kingsleyweb/bun-common";
import type { WsMessageHandler } from "@nestjs/common";
import { describe, expect, it } from "bun:test";
import { of } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunNestWebsocketAdapter,
  BunWebSocketAdapter,
  MessageEventTypes,
} from "../lib/BunWebSocketAdapter";

/** A fake client that records everything sent to it. */
function makeFakeClient() {
  const sent: string[] = [];
  const client = {
    send(message: string) {
      sent.push(message);
    },
  } as unknown as WebSocketClient;
  return { client, sent, parsed: () => sent.map((m) => JSON.parse(m)) };
}

/** rxjs-style transform NestJS supplies to `bindMessageHandlers`. */
const transform = (result: unknown) => of(result);

/**
 * Builds a {@link WsMessageHandler} from a loosely-typed test callback. NestJS
 * types `callback` as returning `Observable | Promise`, but the adapter
 * tolerates any return (it normalises via `transform`), so we cast here.
 */
function wsHandler(
  message: string,
  callback: (...args: any[]) => unknown,
): WsMessageHandler<string> {
  return {
    message,
    callback: callback as WsMessageHandler<string>["callback"],
  };
}

describe("BunWebSocketAdapter: construction", () => {
  it("builds from an http adapter", () => {
    const httpAdapter = new BunHttpAdapter(10000);
    const adapter = new BunNestWebsocketAdapter({ httpAdapter });
    expect(adapter).toBeInstanceOf(BunNestWebsocketAdapter);
    expect(adapter).toBeInstanceOf(BunWebSocketAdapter);
  });

  it("exposes a websocket handler with lifecycle hooks", () => {
    const httpAdapter = new BunHttpAdapter(10000);
    const adapter = new BunNestWebsocketAdapter({ httpAdapter });
    expect(typeof adapter.wsHandler.message).toBe("function");
    expect(typeof adapter.wsHandler.open).toBe("function");
  });
});

describe("MessageEventTypes", () => {
  it("matches the socket.io packet type ordinals", () => {
    expect(MessageEventTypes.CONNECT).toBe(0);
    expect(MessageEventTypes.DISCONNECT).toBe(1);
    expect(MessageEventTypes.EVENT).toBe(2);
    expect(MessageEventTypes.ACK).toBe(3);
    expect(MessageEventTypes.ERROR).toBe(4);
    expect(MessageEventTypes.BINARY_EVENT).toBe(5);
    expect(MessageEventTypes.BINARY_ACK).toBe(6);
  });
});

describe("BunWebSocketAdapter: client binding", () => {
  it("invokes the connect callback when a client connects", () => {
    const httpAdapter = new BunHttpAdapter(10000);
    const adapter = new BunNestWebsocketAdapter({ httpAdapter });

    let connected = false;
    adapter.bindClientConnect(undefined, () => {
      connected = true;
    });
    adapter.emit("connect", {} as never);
    expect(connected).toBe(true);
  });

  it("invokes the disconnect callback when a client disconnects", () => {
    const httpAdapter = new BunHttpAdapter(10000);
    const adapter = new BunNestWebsocketAdapter({ httpAdapter });

    let disconnected = false;
    // The hook is scoped to this exact client, so emit the disconnect for the
    // same object (NestJS binds the disconnect hook per connection).
    const client = {} as never;
    adapter.bindClientDisconnect(client, () => {
      disconnected = true;
    });
    adapter.emit("disconnect", client, 1000 as never, "bye" as never);
    expect(disconnected).toBe(true);
  });
});

describe("BunWebSocketAdapter: bindMessageHandlers", () => {
  const newAdapter = () =>
    new BunNestWebsocketAdapter({ httpAdapter: new BunHttpAdapter(10000) });

  const emitMessage = (
    adapter: BunNestWebsocketAdapter,
    client: WebSocketClient,
    packet: unknown,
  ) => adapter.emit("message", client, JSON.stringify(packet) as never);

  it("dispatches an EVENT packet to the matching handler with its payload", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    const received: unknown[] = [];
    const handlers: WsMessageHandler<string>[] = [
      wsHandler("chat", (data) => received.push(data)),
      wsHandler("other", () => received.push("WRONG")),
    ];
    adapter.bindMessageHandlers(client, handlers, transform);

    emitMessage(adapter, client, {
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: ["chat", { text: "hi" }],
    });

    expect(received).toEqual([{ text: "hi" }]);
  });

  it("sends a handler's WsResponse back to the client as an EVENT packet", () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();

    adapter.bindMessageHandlers(
      client,
      [wsHandler("ping", () => ({ event: "pong", data: 42 }))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.EVENT,
      namespace: "/ns",
      data: ["ping", null],
    });

    expect(parsed()).toEqual([
      {
        type: MessageEventTypes.EVENT,
        namespace: "/ns",
        data: ["pong", 42],
      },
    ]);
  });

  it("does not send anything when a handler returns nothing", () => {
    const adapter = newAdapter();
    const { client, sent } = makeFakeClient();

    adapter.bindMessageHandlers(
      client,
      [wsHandler("fire", () => undefined)],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: ["fire", "x"],
    });

    expect(sent).toEqual([]);
  });

  it("routes a CONNECT packet to a 'connect' handler", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    let connected = false;
    adapter.bindMessageHandlers(
      client,
      [wsHandler("connect", () => (connected = true))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.CONNECT,
      namespace: "/",
    });

    expect(connected).toBe(true);
  });

  it("routes a DISCONNECT packet to a 'disconnect' handler", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    let left = false;
    adapter.bindMessageHandlers(
      client,
      [wsHandler("disconnect", () => (left = true))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.DISCONNECT,
      namespace: "/",
    });

    expect(left).toBe(true);
  });

  it("routes an ERROR packet to an 'error' handler with the error payload", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    const errors: unknown[] = [];
    adapter.bindMessageHandlers(
      client,
      [wsHandler("error", (data) => errors.push(data))],
      transform,
    );

    emitMessage(adapter, client, {
      type: MessageEventTypes.ERROR,
      namespace: "/",
      data: "boom",
    });

    expect(errors).toEqual(["boom"]);
  });

  it("echoes an ACK packet back to the client", () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();

    adapter.bindMessageHandlers(client, [], transform);

    emitMessage(adapter, client, {
      type: MessageEventTypes.ACK,
      id: 7,
      namespace: "/",
      data: ["evt"],
    });

    expect(parsed()).toEqual([
      {
        type: MessageEventTypes.ACK,
        id: 7,
        namespace: "/",
        data: ["evt"],
      },
    ]);
  });

  it("emits an ERROR packet and notifies the error handler on a malformed packet", () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();

    let errorHandled = false;
    adapter.bindMessageHandlers(
      client,
      [wsHandler("error", () => (errorHandled = true))],
      transform,
    );

    adapter.emit("message", client, "not-json" as never);

    expect(errorHandled).toBe(true);
    expect(parsed()[0]?.type).toBe(MessageEventTypes.ERROR);
  });

  it("resolves a handler that returns a Promise without a transform", async () => {
    const adapter = newAdapter();
    const { client, parsed } = makeFakeClient();

    adapter.bindMessageHandlers(client, [
      {
        message: "ask",
        callback: async () => ({ event: "answer", data: "later" }),
      },
    ]);

    emitMessage(adapter, client, {
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: ["ask", null],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(parsed()).toEqual([
      {
        type: MessageEventTypes.EVENT,
        namespace: "/",
        data: ["answer", "later"],
      },
    ]);
  });

  it("stops dispatching messages after the client disconnects", () => {
    const adapter = newAdapter();
    const { client } = makeFakeClient();

    let calls = 0;
    adapter.bindMessageHandlers(
      client,
      [wsHandler("tick", () => (calls += 1))],
      transform,
    );

    const packet = {
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: ["tick", null],
    };
    emitMessage(adapter, client, packet);
    expect(calls).toBe(1);

    adapter.emit("disconnect", client, 1000 as never, "bye" as never);
    emitMessage(adapter, client, packet);
    expect(calls).toBe(1);
  });
});
