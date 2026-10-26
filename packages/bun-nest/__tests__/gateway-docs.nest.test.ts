/**
 * `gatewayAsyncApi(app)` (AD (e), plan §5.2): the AsyncAPI 3.0 document of a
 * booted app's gateways, discovered from their Nest metadata — the path +
 * namespace as the channel's address, the port as its server, each
 * `@SubscribeMessage` handler as a `receive` operation with the socket.io
 * `EVENT` envelope as its payload (the `@ValidateMessage` schema at
 * `data[1]`, `{}` for an undecorated handler — the control), the declared
 * `ack` as the operation's `reply` (an `ACK` packet), the `@Emits` map as
 * `send` operations, and the fixed lifecycle/`exception` frames.
 *
 * The negative control (per CLAUDE.md): the envelope wrapper — mutating
 * `lib/gateway-docs.ts` to document the bare payload (no `{ type: 2, data:
 * [event, …] }` wrapper) must fail "documents the EVENT envelope, the schema
 * at data[1]".
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import { ConfigError } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { gatewayAsyncApi } from "../lib/gateway-docs";
import { Emits, ValidateMessage } from "../lib/wsValidation";
import "reflect-metadata";

const Say = z.object({ text: z.string().min(1) });
const Said = z.object({ by: z.string(), text: z.string() });
const SayAck = z.object({ ok: z.boolean() });

@WebSocketGateway({ path: "/ws", namespace: "/chat" })
@Emits({ said: Said, typing: null })
class ChatGateway {
  @SubscribeMessage("say")
  @ValidateMessage(Say, { ack: SayAck })
  say(@MessageBody() msg: { text: string }) {
    return { ok: msg.text.length > 0 };
  }

  /** Undecorated: the payload documents `{}` (the control). */
  @SubscribeMessage("ping")
  ping() {
    return null;
  }
}

/** A dedicated-port gateway: its own server in the document. */
@WebSocketGateway({ port: 4199, namespace: "/admin" })
class AdminGateway {
  @SubscribeMessage("reload")
  reload() {
    return null;
  }
}

/** A wildcard gateway: unmappable — an AsyncAPI address is no glob. */
@WebSocketGateway({ path: "/wild/*" })
class WildcardGateway {
  @SubscribeMessage("anything")
  anything() {
    return null;
  }
}

@Module({ providers: [ChatGateway, AdminGateway, WildcardGateway] })
class AppModule {}

let app: INestApplication;

beforeAll(async () => {
  // No listen(): the explorer reads provider metadata, registered at create.
  const httpAdapter = new BunHttpAdapter(0);
  app = await NestFactory.create(AppModule, httpAdapter, { logger: false });
  app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
});

afterAll(async () => {
  await app?.close();
});

/* The document's pieces, typed loosely for the assertions. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

function generate() {
  return gatewayAsyncApi(app, { title: "Gateways", version: "1.0.0" });
}

describe("gatewayAsyncApi", () => {
  it("maps path + namespace to the channel address, port to the servers", () => {
    const { document } = generate();
    const channels = document.channels as Doc;
    expect(Object.keys(channels).sort()).toEqual(["admin", "wsChat"]);
    expect(channels.wsChat.address).toBe("/ws/chat");
    expect(channels.wsChat.title).toBe("ChatGateway");
    expect(channels.admin.address).toBe("/admin");
    const servers = document.servers as Doc;
    expect(Object.keys(servers).sort()).toEqual(["app", "port4199"]);
    expect(servers.app.host).toBe("{host}");
    expect(servers.port4199.host).toBe("localhost:4199");
    expect(channels.wsChat.servers).toEqual([{ $ref: "#/servers/app" }]);
    expect(channels.admin.servers).toEqual([{ $ref: "#/servers/port4199" }]);
    expect(channels.wsChat.bindings.ws.method).toBe("GET");
  });

  it("warns about the wildcard gateway and leaves it out (strict escalates)", () => {
    const { warnings } = generate();
    expect(
      warnings.some((w) => w.message.includes('the route "/wild/*"')),
    ).toBe(true);
    expect(() =>
      gatewayAsyncApi(app, {
        title: "Gateways",
        version: "1.0.0",
        strict: "strict",
      }),
    ).toThrow(ConfigError);
  });

  it("documents the EVENT envelope, the schema at data[1]", () => {
    const { document } = generate();
    const messages = (document.components as Doc).messages as Doc;
    const say = messages["wsChat.in.say"].payload;
    expect(say.properties.type.const).toBe(2);
    expect(say.properties.namespace.const).toBe("/chat");
    expect(say.properties.data.items[0]).toEqual({ const: "say" });
    expect(say.properties.data.items[1]).toMatchObject({
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
    });
    expect(say.required).toEqual(["type", "namespace", "data"]);
  });

  it("the control: an undecorated handler documents {}", () => {
    const { document } = generate();
    const messages = (document.components as Doc).messages as Doc;
    const ping = messages["wsChat.in.ping"].payload;
    expect(ping.properties.data.items[0]).toEqual({ const: "ping" });
    expect(ping.properties.data.items[1]).toEqual({});
    // And its operation has no reply (no ack declared).
    const operations = document.operations as Doc;
    expect(operations.receiveWsChatPing.reply).toBeUndefined();
  });

  it("the declared ack is the receive operation's reply, an ACK packet", () => {
    const { document } = generate();
    const operations = document.operations as Doc;
    const receive = operations.receiveWsChatSay;
    expect(receive.action).toBe("receive");
    expect(receive.reply.messages[0].$ref).toBe(
      "#/channels/wsChat/messages/in.say.ack",
    );
    const ack = (document.components as Doc).messages["wsChat.in.say.ack"];
    expect(ack.payload.properties.type.const).toBe(3);
    expect(ack.payload.properties.data.items[0]).toMatchObject({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
  });

  it("the @Emits map is the send operation's events, a null entry carrying no payload", () => {
    const { document } = generate();
    const operations = document.operations as Doc;
    const send = operations.sendWsChat;
    expect(send.action).toBe("send");
    expect(send.messages.map((m: Doc) => m.$ref).sort()).toEqual([
      "#/channels/wsChat/messages/error",
      "#/channels/wsChat/messages/exception",
      "#/channels/wsChat/messages/out.said",
      "#/channels/wsChat/messages/out.typing",
    ]);
    const messages = (document.components as Doc).messages as Doc;
    const said = messages["wsChat.out.said"].payload;
    expect(said.properties.type.const).toBe(2);
    expect(said.properties.data.items[0]).toEqual({ const: "said" });
    expect(said.properties.data.items[1]).toMatchObject({
      properties: { by: { type: "string" } },
    });
    // `typing: null` — the EVENT packet carries no payload argument.
    const typing = messages["wsChat.out.typing"].payload;
    expect(typing.properties.data.items).toEqual([{ const: "typing" }]);
  });

  it("the fixed frames: connect/disconnect on the lifecycle op, error/exception on the send op", () => {
    const { document } = generate();
    const operations = document.operations as Doc;
    expect(operations.lifecycleWsChat.messages.map((m: Doc) => m.$ref)).toEqual(
      [
        "#/channels/wsChat/messages/connect",
        "#/channels/wsChat/messages/disconnect",
      ],
    );
    const messages = (document.components as Doc).messages as Doc;
    expect(messages["wsChat.connect"].payload.properties.type.const).toBe(0);
    expect(messages["wsChat.disconnect"].payload.properties.type.const).toBe(1);
    expect(messages["wsChat.error"].payload.properties.type.const).toBe(4);
    // The exception frame: the EVENT packet `["exception", { status, message, cause? }]`.
    const exception = messages["wsChat.exception"].payload;
    expect(exception.properties.data.items[0]).toEqual({ const: "exception" });
    expect(exception.properties.data.items[1].required).toEqual([
      "status",
      "message",
    ]);
  });

  it("is deterministic: two calls deep-equal", () => {
    const first = generate();
    const second = generate();
    expect(JSON.stringify(second.document)).toBe(
      JSON.stringify(first.document),
    );
    expect(second.warnings).toEqual(first.warnings);
  });
});
