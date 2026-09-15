/**
 * A custom WebSocket adapter: subclass `BunNestWebsocketAdapter`, override the
 * methods NestJS calls, and install it — once riding the HTTP server, once on
 * a port of its own.
 *
 * ```bash
 * bun 04-websockets/custom-adapter.ts
 * ```
 *
 * The adapter NestJS drives is whichever you pass to `app.useWebSocketAdapter`,
 * but the traffic it sees comes from the `Bun.serve` server — and the HTTP
 * server hands WebSocket events to the adapter active on its router. Keep the
 * two the same instance:
 *
 * ```ts
 * httpAdapter.webSocketAdapter = new MyAdapter({ httpAdapter }); // active on the router
 * app.useWebSocketAdapter(httpAdapter.webSocketAdapter);         // the same instance
 * ```
 *
 * Constructing an adapter over `httpAdapter` already makes it the router's
 * active one; assigning it to `httpAdapter.webSocketAdapter` as well keeps
 * that property honest. Install it before `app.listen()` — NestJS connects
 * gateways to whatever adapter is installed at that moment, and warns (then
 * ignores the new one) afterwards.
 *
 * What each override is for:
 *
 * - `create(port, { namespace })` — called per gateway server and namespace.
 * - `bindClientConnect(server, callback)` — once per gateway; the callback runs
 *   per connection. Greet, reject, count.
 * - `bindMessageHandlers(client, handlers, transform)` — per connection; wrap
 *   handlers to log, time or authorise every message.
 * - `dispose()` — NestJS's last shutdown call, after `close(server)`.
 */
import type { JsonValue } from "@kingsleyweb/bun-common";
import type {
  BunWebSocketGatewayOptions,
  BunWebSocketServerType,
  WebSocketClient,
} from "@kingsleyweb/bun-nest";
import type { WsMessageHandler } from "@nestjs/common";
import type { WsResponse } from "@nestjs/websockets";
import { getPort } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunNestWebsocketAdapter,
  MessageEventTypes,
} from "@kingsleyweb/bun-nest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { show, step, title, waitFor } from "../shared/console";
import { connect } from "./fixtures/ws-client";
import "reflect-metadata";

/** One message the adapter saw dispatched. */
interface MessageLogEntry {
  /** The path the client connected to — its namespace. */
  path: string;
  /** The `@SubscribeMessage` name of the handler that ran. */
  message: string;
}

/** The `transform` NestJS passes to `bindMessageHandlers`. */
type Transform = Parameters<BunNestWebsocketAdapter["bindMessageHandlers"]>[2];

/** Greets every connection, and records namespaces, connections and messages. */
class AuditedWebSocketAdapter extends BunNestWebsocketAdapter {
  /** The namespace of every `create()` call, in order. */
  readonly namespaces: string[] = [];

  /** Connections that reached a gateway. */
  connections = 0;

  /** Every message dispatched to a handler. */
  readonly messages: MessageLogEntry[] = [];

  /** Whether NestJS has called `dispose()`. */
  disposed = false;

  override create(port: number, options?: BunWebSocketGatewayOptions) {
    this.namespaces.push(options?.namespace ?? "/");
    return super.create(port, options);
  }

  override bindClientConnect(
    server: BunWebSocketServerType | undefined,
    callback: (
      client: WebSocketClient,
      server: BunWebSocketServerType | undefined,
    ) => void,
  ): void {
    super.bindClientConnect(server, (client, liveServer) => {
      this.connections++;
      client.send(
        JSON.stringify({
          type: MessageEventTypes.EVENT,
          namespace: client.data.path,
          data: ["hello", { path: client.data.path }],
        }),
      );
      return callback(client, liveServer);
    });
  }

  override bindMessageHandlers(
    client: WebSocketClient,
    handlers: WsMessageHandler<string>[],
    transform?: Transform,
  ): void {
    const audited = handlers.map((handler) => {
      return {
        ...handler,
        // Forwards whatever NestJS passes (payload, ack) to the real handler.
        callback: (...args: unknown[]) => {
          this.messages.push({
            path: client.data.path,
            message: handler.message,
          });
          return handler.callback(...args);
        },
      };
    });
    super.bindMessageHandlers(client, audited, transform);
  }

  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }
}

@WebSocketGateway()
class EchoGateway {
  @SubscribeMessage("echo")
  echo(@MessageBody() body: JsonValue): WsResponse<JsonValue> {
    return { event: "echo", data: body };
  }
}

@WebSocketGateway({ namespace: "/shout" })
class ShoutGateway {
  @SubscribeMessage("shout")
  shout(@MessageBody() text: string): WsResponse<string> {
    return { event: "shout", data: text.toUpperCase() };
  }
}

// Order does not matter: each gateway is bound to its own namespace, so the
// default-namespace EchoGateway may come after the namespaced ShoutGateway.
@Module({ providers: [ShoutGateway, EchoGateway] })
class AppModule {}

@Module({ providers: [EchoGateway] })
class OwnPortModule {}

title("Custom adapter");

/* ------------------------------------------------------------------ */
step("A subclass riding the HTTP server");

const httpAdapter = new BunHttpAdapter();
const audited = new AuditedWebSocketAdapter({ httpAdapter });
httpAdapter.webSocketAdapter = audited;

const app = await NestFactory.create(AppModule, httpAdapter, {
  logger: false,
});
app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
await app.listen(0);

show(
  "httpAdapter.webSocketAdapter is the subclass",
  httpAdapter.webSocketAdapter === audited,
);
show(
  "active on the router",
  httpAdapter.instance.getBunWebsocket() === audited,
);
show("create() namespaces", audited.namespaces);

const base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;
const echoClient = await connect(`${base}/`);
const shoutClient = await connect(`${base}/shout`);

show("greeting on /", await echoClient.nextEvent("hello"));
show("greeting on /shout", await shoutClient.nextEvent("hello"));

echoClient.emit("echo", "through the subclass");
shoutClient.emit("shout", "quiet please");
show("echo", await echoClient.nextEvent("echo"));
show("shout", await shoutClient.nextEvent("shout"));

show("connections", audited.connections);
show("messages", audited.messages);

await echoClient.close();
await shoutClient.close();
await app.close();
show("dispose() called on shutdown", audited.disposed);

/* ------------------------------------------------------------------ */
step("The same subclass on a port of its own (`newInstance: true`)");

const ownPort = await getPort();
const secondHttp = new BunHttpAdapter();
const ownServer = new AuditedWebSocketAdapter({
  newInstance: true,
  listen: { port: ownPort },
  // No `router` given: it uses this HTTP adapter's, so gateways register there.
  httpAdapter: secondHttp,
});
secondHttp.webSocketAdapter = ownServer;

const secondApp = await NestFactory.create(OwnPortModule, secondHttp, {
  logger: false,
});
secondApp.useWebSocketAdapter(secondHttp.webSocketAdapter);
await secondApp.listen(0);

show("router is the HTTP adapter's", ownServer.router === secondHttp.instance);
show("HTTP port", secondHttp.listeningPort);
show("WebSocket port", ownServer.getServer()?.port);

const ownClient = await connect(`ws://127.0.0.1:${ownPort}/`);
ownClient.emit("echo", { on: "its own port" });
show("echo", await ownClient.nextEvent("echo"));
await waitFor(
  "the message to be logged",
  () => ownServer.messages.length === 1,
);

await ownClient.close();
// NestJS closes the adapter's server, then calls dispose().
await secondApp.close();
show("dispose() called on shutdown", ownServer.disposed);
