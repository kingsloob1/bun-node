/**
 * End-to-end WebSocket adapter tests over a *real* Bun server + real
 * `WebSocket` client, with no dependency on `@nestjs/websockets`. The adapter
 * is driven exactly as NestJS's `WebSocketsController` drives it:
 *   - the connected socket is pre-bound as the handler's first argument
 *     (`callback.bind(instance, client)`), so payload lands at arg 1;
 *   - `bindMessageHandlers` receives the same `transform` NestJS supplies
 *     (`data => from(pickResult(data)).pipe(mergeAll())`).
 */
import type { WebSocketClient } from "@kingsleyweb/bun-common";
import type { WsMessageHandler } from "@nestjs/common";
import { afterEach, describe, expect, it } from "bun:test";
import { from, isObservable, of } from "rxjs";
import { mergeAll } from "rxjs/operators";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";

/** Replicates NestJS's `WsContextCreator` result normalisation. */
async function pickResult(deferred: unknown) {
  const result = await deferred;
  if (isObservable(result)) {
    return result;
  }
  if (result instanceof Promise) {
    return from(result);
  }
  return of(result);
}
const transform = (data: unknown) => from(pickResult(data)).pipe(mergeAll());

/** A gateway-method-like handler keyed by its `@SubscribeMessage` name. */
type GatewayHandler = (
  client: WebSocketClient,
  payload: unknown,
  ack: (...args: unknown[]) => void,
) => unknown;

const servers: BunHttpAdapter[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()?.close();
  }
});

/**
 * Boots a real HTTP+WS server and wires `handlers` the NestJS way: on every
 * connection each handler is pre-bound with the client and registered via
 * `bindMessageHandlers`.
 */
async function startServer(handlers: Record<string, GatewayHandler>) {
  const httpAdapter = new BunHttpAdapter(30000);
  httpAdapter.registerParserMiddleware(undefined, true);
  await httpAdapter.listen(0);
  servers.push(httpAdapter);

  const wsAdapter = httpAdapter.webSocketAdapter;
  wsAdapter.create(0, { namespace: "/*", transport: [] });

  wsAdapter.bindClientConnect(undefined, (client) => {
    // Mirror NestJS's `WebSocketsController.subscribeMessages`: pre-bind the
    // socket as the handler's first arg. (NestJS types `callback` as returning
    // an Observable/Promise; the adapter tolerates any return, so we cast.)
    const bound = Object.entries(handlers).map(([message, fn]) => ({
      message,
      callback: (fn as GatewayHandler).bind(null, client as WebSocketClient),
    })) as unknown as WsMessageHandler<string>[];
    wsAdapter.bindMessageHandlers(client as WebSocketClient, bound, transform);
  });

  const base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;
  return { httpAdapter, wsAdapter, base };
}

const EVENT = MessageEventTypes.EVENT;

describe("BunWebSocketAdapter e2e: EVENT round-trips", () => {
  it("dispatches an EVENT and returns the handler's WsResponse to the client", async () => {
    const { base } = await startServer({
      echo: (_client, data) => ({ event: "echoed", data }),
    });
    const client = await connectWs(`${base}/ws`);

    client.send({ type: EVENT, namespace: "/", data: ["echo", "hello"] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "echoed");

    expect(reply).toEqual({
      type: EVENT,
      namespace: "/",
      data: ["echoed", "hello"],
    });
    await client.close();
  });

  it("injects the connected socket as arg 0 and payload as arg 1 (WsParamsFactory)", async () => {
    const seen: { hasClient: boolean; payload: unknown }[] = [];
    const { base } = await startServer({
      probe: (client, payload) => {
        seen.push({ hasClient: typeof client?.send === "function", payload });
        return { event: "ok", data: null };
      },
    });
    const client = await connectWs(`${base}/ws`);

    client.send({ type: EVENT, namespace: "/", data: ["probe", { a: 1 }] });
    await client.waitFor((m) => m?.data?.[0] === "ok");

    expect(seen).toEqual([{ hasClient: true, payload: { a: 1 } }]);
    await client.close();
  });

  it("exposes the split-url fields + originalUrl on client.data", async () => {
    const { base } = await startServer({
      whoami: (client) => ({
        event: "whoami",
        data: {
          path: client.data?.path,
          search: client.data?.search,
          hash: client.data?.hash,
          host: client.data?.host,
          originalUrl: client.data?.originalUrl,
        },
      }),
    });
    const client = await connectWs(`${base}/rooms/42?x=1&y=2`);

    client.send({ type: EVENT, namespace: "/", data: ["whoami", null] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "whoami");

    const data = reply.data[1];
    expect(data.path).toBe("/rooms/42");
    expect(data.search).toBe("?x=1&y=2");
    expect(data.hash).toBe("");
    expect(data.originalUrl).toBe("/rooms/42?x=1&y=2");
    expect(typeof data.host).toBe("string");
    await client.close();
  });

  it("streams every emission of an Observable handler back as EVENT packets", async () => {
    const { base } = await startServer({
      ticks: () =>
        of(
          { event: "tick", data: 1 },
          { event: "tick", data: 2 },
          {
            event: "tick",
            data: 3,
          },
        ),
    });
    const client = await connectWs(`${base}/ws`);

    client.send({ type: EVENT, namespace: "/", data: ["ticks", null] });
    await client.waitFor((m) => m?.data?.[0] === "tick" && m?.data?.[1] === 3);

    const ticks = client.received
      .map((r) => JSON.parse(r))
      .filter((m) => m.data?.[0] === "tick")
      .map((m) => m.data[1]);
    expect(ticks).toEqual([1, 2, 3]);
    await client.close();
  });

  it("resolves a Promise-returning handler", async () => {
    const { base } = await startServer({
      slow: async (_client, data) => ({ event: "resolved", data }),
    });
    const client = await connectWs(`${base}/ws`);

    client.send({ type: EVENT, namespace: "/", data: ["slow", "v"] });
    const reply = await client.waitFor((m) => m?.data?.[0] === "resolved");

    expect(reply.data[1]).toBe("v");
    await client.close();
  });

  it("sends nothing back when the handler returns undefined", async () => {
    const { base } = await startServer({
      sink: () => undefined,
      mark: () => ({ event: "mark", data: "done" }),
    });
    const client = await connectWs(`${base}/ws`);

    client.send({ type: EVENT, namespace: "/", data: ["sink", "x"] });
    // Use a follow-up event we *do* answer to prove ordering / no sink reply.
    client.send({ type: EVENT, namespace: "/", data: ["mark", null] });
    await client.waitFor((m) => m?.data?.[0] === "mark");

    expect(client.received.some((r) => r.includes("sink"))).toBe(false);
    await client.close();
  });
});

describe("BunWebSocketAdapter e2e: ack support (WsParamtype.ACK)", () => {
  it("passes an ack callback that replies with an ACK packet of the same id", async () => {
    const { base } = await startServer({
      needsAck: (_client, _payload, ack) => {
        ack("acked!");
      },
    });
    const client = await connectWs(`${base}/ws`);

    client.send({
      type: EVENT,
      namespace: "/",
      id: 77,
      data: ["needsAck", "ping"],
    });
    const ack = await client.waitFor((m) => m?.type === MessageEventTypes.ACK);

    expect(ack).toEqual({
      type: MessageEventTypes.ACK,
      id: 77,
      namespace: "/",
      data: ["acked!"],
    });
    await client.close();
  });
});

describe("BunWebSocketAdapter e2e: protocol packets & errors", () => {
  it("routes CONNECT / DISCONNECT / ERROR packets to reserved handlers", async () => {
    const { base } = await startServer({
      connect: () => ({ event: "connected", data: "hi" }),
      error: (_client, payload) => ({ event: "errack", data: payload }),
    });
    const client = await connectWs(`${base}/ws`);

    client.send({ type: MessageEventTypes.CONNECT, namespace: "/" });
    const connected = await client.waitFor((m) => m?.data?.[0] === "connected");
    expect(connected.data[1]).toBe("hi");

    client.send({
      type: MessageEventTypes.ERROR,
      namespace: "/",
      data: "boom",
    });
    const errack = await client.waitFor((m) => m?.data?.[0] === "errack");
    expect(errack.data[1]).toBe("boom");
    await client.close();
  });

  it("replies with an ERROR packet on a malformed frame", async () => {
    const { base } = await startServer({});
    const client = await connectWs(`${base}/ws`);

    client.send("this-is-not-json");
    const err = await client.waitFor(
      (m) => m?.type === MessageEventTypes.ERROR,
    );

    expect(err.type).toBe(MessageEventTypes.ERROR);
    await client.close();
  });

  it("ignores an EVENT with no registered handler without crashing the socket", async () => {
    const { base } = await startServer({
      ping: () => ({ event: "pong", data: null }),
    });
    const client = await connectWs(`${base}/ws`);

    client.send({ type: EVENT, namespace: "/", data: ["unknown", "x"] });
    // The socket must still work afterwards.
    client.send({ type: EVENT, namespace: "/", data: ["ping", null] });
    const pong = await client.waitFor((m) => m?.data?.[0] === "pong");

    expect(pong.data[0]).toBe("pong");
    await client.close();
  });
});
