/**
 * bun-validate V6 in a gateway: `StandardSchemaPipe` on `@MessageBody()`,
 * a `SchemaDto` message under `StandardValidationPipe` (in `@UsePipes`, and
 * global, which only Nest 12 applies to gateways), and
 * `ValidationExceptionFilter` with `@UseFilters` (Nest applies no global
 * filter to gateways), over bun-nest's `BunWebSocketAdapter`.
 *
 * The control is the same gateway without the filter: the pipe's error is
 * not a `WsException`, so Nest answers `Internal server error`, as it does
 * for its own `ValidationPipe` in a gateway.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication } from "@nestjs/common";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { WsTestClient } from "./helpers";
import { Module, UseFilters, UsePipes } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SocketModule } from "@nestjs/websockets/socket-module.js";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as yup from "yup";
import { z } from "zod";
import {
  BunHttpAdapter,
  SchemaDto,
  StandardSchemaPipe,
  StandardValidationPipe,
  ValidationExceptionFilter,
} from "../lib";
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";
import "reflect-metadata";

const { EVENT } = MessageEventTypes;

/**
 * Whether Nest applies global pipes to gateways: Nest 12's
 * `SocketModule.getContextCreator(container, config, …)` hands the
 * application config to the ws pipes context; Nest 11's takes the container
 * alone, so `useGlobalPipes` and `APP_PIPE` never reach a gateway there.
 * Read from that capability (its parameters), never a version.
 */
const GLOBAL_PIPES_REACH_GATEWAYS =
  (
    SocketModule.prototype as unknown as {
      getContextCreator: (...args: unknown[]) => unknown;
    }
  ).getContextCreator.length >= 2;

const Chat = z.object({ room: z.string().min(1), text: z.string() });
type ChatMessage = StandardSchemaV1.InferOutput<typeof Chat>;
class ChatDto extends SchemaDto(Chat) {}
const Count = yup.object({ n: yup.number().required() });

/** The gateway's handlers, shared by both gateways below. */
class ChatHandlers {
  @SubscribeMessage("piped")
  piped(@MessageBody(new StandardSchemaPipe(Chat)) msg: ChatMessage) {
    return { event: "piped", data: msg };
  }

  @SubscribeMessage("dto")
  dto(@MessageBody() msg: ChatDto) {
    return { event: "dto", data: msg };
  }

  @SubscribeMessage("dto-scoped")
  @UsePipes(StandardValidationPipe)
  dtoScoped(@MessageBody() msg: ChatDto) {
    return { event: "dto-scoped", data: msg };
  }

  @SubscribeMessage("count")
  count(@MessageBody(new StandardSchemaPipe(Count)) msg: { n: number }) {
    return { event: "count", data: { n: msg.n, typeofN: typeof msg.n } };
  }
}

@WebSocketGateway({ path: "/filtered" })
@UseFilters(ValidationExceptionFilter)
class FilteredGateway extends ChatHandlers {}

@WebSocketGateway({ path: "/bare" })
class BareGateway extends ChatHandlers {}

@Module({ providers: [FilteredGateway, BareGateway] })
class AppModule {}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const httpAdapter = new BunHttpAdapter(0);
  app = await NestFactory.create(AppModule, httpAdapter, { logger: false });
  app.useGlobalPipes(new StandardValidationPipe());
  app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
  await app.listen(0);
  base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;
});

afterAll(async () => {
  await app?.close();
});

/**
 * Sends one event and resolves with the first frame after it that answers
 * it or is an `exception` (frames already received do not count).
 */
async function reply(
  client: WsTestClient,
  event: string,
  data: unknown,
): Promise<unknown> {
  const before = client.received.length;
  client.send({ type: EVENT, namespace: "/", data: [event, data] });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const frame = client.received
      .slice(before)
      .map((raw) => JSON.parse(raw) as { data?: unknown[] })
      .find((m) => m.data?.[0] === event || m.data?.[0] === "exception");
    if (frame) return frame.data;
    await Bun.sleep(5);
  }
  throw new Error(`no reply to ${event}`);
}

describe("gateways: the pipes, and the filter with @UseFilters", () => {
  let filtered: WsTestClient;
  let bare: WsTestClient;
  beforeAll(async () => {
    filtered = await connectWs(`${base}/filtered`);
    bare = await connectWs(`${base}/bare`);
  });
  afterAll(async () => {
    await filtered?.close();
    await bare?.close();
  });

  it("StandardSchemaPipe hands the handler the parsed message", async () => {
    expect(await reply(filtered, "piped", { room: "a", text: "hi" })).toEqual([
      "piped",
      { room: "a", text: "hi" },
    ]);
  });

  it("the filter answers a refused message with { status, code: 'VALIDATION', issues }", async () => {
    expect(await reply(filtered, "piped", { room: "", text: 1 })).toEqual([
      "exception",
      {
        status: 400,
        code: "VALIDATION",
        issues: [
          {
            target: "body",
            message: "Too small: expected string to have >=1 characters",
            path: "room",
          },
          {
            target: "body",
            message: "Invalid input: expected string, received number",
            path: "text",
          },
        ],
      },
    ]);
  });

  it("StandardValidationPipe in @UsePipes (built by Nest) checks a SchemaDto message", async () => {
    expect(
      await reply(filtered, "dto-scoped", { room: "r", text: "t" }),
    ).toEqual(["dto-scoped", { room: "r", text: "t" }]);
    const refused = (await reply(filtered, "dto-scoped", { room: "r" })) as [
      string,
      { status: number; code: string; issues: { path: string }[] },
    ];
    expect(refused[0]).toBe("exception");
    expect(refused[1].status).toBe(400);
    expect(refused[1].code).toBe("VALIDATION");
    expect(refused[1]).not.toHaveProperty("error");
    expect(refused[1].issues.map((i) => i.path)).toEqual(["text"]);
  });

  it(`the global StandardValidationPipe ${GLOBAL_PIPES_REACH_GATEWAYS ? "checks" : "never sees (Nest 11)"} a SchemaDto message`, async () => {
    const answered = (await reply(filtered, "dto", { room: "r" })) as [
      string,
      unknown,
    ];
    // Nest 12 runs global pipes in gateways; Nest 11 does not.
    expect(answered[0]).toBe(GLOBAL_PIPES_REACH_GATEWAYS ? "exception" : "dto");
  });

  it("an async vendor (yup) in a gateway", async () => {
    expect(await reply(filtered, "count", { n: "3" })).toEqual([
      "count",
      { n: 3, typeofN: "number" },
    ]);
    const refused = (await reply(filtered, "count", {})) as [
      string,
      { issues: unknown[] },
    ];
    expect(refused[0]).toBe("exception");
    expect(refused[1].issues).toEqual([
      { target: "body", message: "n is a required field", path: "n" },
    ]);
  });

  it("control: without the filter, Nest answers 'Internal server error'", async () => {
    expect(await reply(bare, "piped", { room: "", text: "x" })).toEqual([
      "exception",
      {
        status: "error",
        message: "Internal server error",
        cause: { pattern: "piped", data: { room: "", text: "x" } },
      },
    ]);
  });
});
