import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunNestWebsocketAdapter,
  BunWebSocketAdapter,
  MessageEventTypes,
} from "../lib/BunWebSocketAdapter";

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
    adapter.bindClientDisconnect({} as never, () => {
      disconnected = true;
    });
    adapter.emit("disconnect", {} as never, 1000 as never, "bye" as never);
    expect(disconnected).toBe(true);
  });
});
