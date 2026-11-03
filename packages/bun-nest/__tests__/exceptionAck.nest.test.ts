/**
 * An `exception` frame for an event that asked for an ack carries its id
 * (`ackId`), and bun-client's `"bun-nest"` codec rejects the waiting
 * `request()` with it at once instead of timing out (30 s by default),
 * against real gateways on bun-nest's adapters, port 0, with the real client
 * (as `channelClient.nest.test.ts`).
 *
 * Covered, each with the 5 s request timeout as the control (a rejection
 * inside 2 s is the frame, not the timeout):
 * - `ValidationExceptionFilter` (a refused payload, a refused ack);
 * - Nest's default filter: a thrown `WsException` (object and string), a
 *   thrown `Error` (answered `Internal server error`), a guard's refusal;
 * - a filter that extends `BaseWsExceptionFilter` and calls `super.catch`;
 * - an event with no ack id: the frame has no `ackId`;
 * - a frame the server sends for an event with an id, read raw off the wire.
 *
 * Not covered, by construction: a filter that overrides `catch` and calls
 * `handleError`/`client.emit("exception", …)` itself (no host to read the id
 * from), and the adapter's own `ERROR` packet (no Nest filter ran).
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { CanActivate, INestApplication } from "@nestjs/common";
import { Catch, Module, UseFilters, UseGuards } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  BaseWsExceptionFilter,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
  MessageBody,
} from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createClient } from "@kingsleyweb/bun-client";
import { channel, ChannelError } from "@kingsleyweb/bun-client/channel";
import { channelContract } from "@kingsleyweb/bun-common/contract";
import { z } from "zod";
import {
  BunHttpAdapter,
  ValidateMessage,
  ValidationExceptionFilter,
} from "../lib";
import "reflect-metadata";

const Say = z.object({ text: z.string().min(1) });
const SayAck = z.object({ ok: z.boolean(), length: z.number().int() });

/** Refuses every event it guards. */
class Deny implements CanActivate {
  /** Always refuses (Nest turns that into a `WsException`). */
  canActivate() {
    return false;
  }
}

/** Nest's filter, through `super.catch`. */
@Catch()
class Passing extends BaseWsExceptionFilter {}

/** A gateway whose handlers all fail, one way each, and one that works. */
@WebSocketGateway({ path: "/acks" })
@UseFilters(ValidationExceptionFilter)
class AckGateway {
  /** Acks with the text's length; its payload and ack are checked. */
  @SubscribeMessage("say")
  @ValidateMessage(Say, { ack: SayAck })
  say(@MessageBody() msg: { text: string }) {
    // A refused ack: `length` is not an integer.
    const length = msg.text === "bad ack" ? 1.5 : msg.text.length;
    return { ok: true, length };
  }

  /** Throws a `WsException` with an object. */
  @SubscribeMessage("object")
  object() {
    throw new WsException({ status: "error", message: "object refused" });
  }

  /** Throws a `WsException` with a string. */
  @SubscribeMessage("string")
  string() {
    throw new WsException("string refused");
  }

  /** Throws a plain error, after an await. */
  @SubscribeMessage("boom")
  async boom() {
    await Bun.sleep(5);
    throw new Error("secret detail");
  }

  /** Refused by its guard. */
  @SubscribeMessage("guarded")
  @UseGuards(Deny)
  guarded() {
    return { ok: true, length: 0 };
  }

  /** Throws, through a filter that extends Nest's. */
  @SubscribeMessage("subclass")
  @UseFilters(Passing)
  subclass() {
    throw new WsException("subclass refused");
  }
}

@Module({ providers: [AckGateway] })
class AckModule {}

/** The channel as the client reads it: every event a request with an ack. */
const acks = channelContract({
  path: "/acks",
  receives: {
    say: Say,
    object: null,
    string: null,
    boom: null,
    guarded: null,
    subclass: null,
  },
  sends: {
    "say ack": SayAck,
    exception: z.looseObject({
      status: z.any(),
      message: z.string().optional(),
    }),
  },
  replies: {
    say: "say ack",
    object: "say ack",
    string: "say ack",
    boom: "say ack",
    guarded: "say ack",
    subclass: "say ack",
  },
});

let app: INestApplication;
let port: number;

beforeAll(async () => {
  const adapter = new BunHttpAdapter(0);
  app = await NestFactory.create(AckModule, adapter, { logger: false });
  app.useWebSocketAdapter(adapter.webSocketAdapter);
  await app.listen(0);
  port = Number(adapter.listeningPort);
});

afterAll(async () => {
  await app?.close();
});

/** Opens the channel, runs `use`, closes it. */
async function withRoom<T>(use: (room: ReturnType<typeof open>) => Promise<T>) {
  const room = open();
  try {
    return await use(room);
  } finally {
    room.close();
  }
}

/** A client of the gateway on the bun-nest codec. */
function open() {
  const api = createClient({
    baseUrl: `http://127.0.0.1:${port}`,
    mode: "development",
    logger: { warn: () => {}, error: () => {}, debug: () => {} },
  });
  return channel(api, acks, { codec: "bun-nest" });
}

/** The error `request` rejects with, and how long it took. */
async function refusal(
  room: ReturnType<typeof open>,
  type: "say" | "object" | "string" | "boom" | "guarded" | "subclass",
  data: unknown,
) {
  const started = Date.now();
  const error = await (
    room.request as (
      type: string,
      data: unknown,
      options: object,
    ) => Promise<unknown>
  )(type, data, { validate: false, timeout: 5000 }).catch(
    (caught: unknown) => caught,
  );
  return { error, took: Date.now() - started };
}

describe("a failed acked event rejects its request at once", () => {
  it("ValidationExceptionFilter: a refused payload is a VALIDATION ChannelError", async () => {
    await withRoom(async (room) => {
      const { error, took } = await refusal(room, "say", { text: "" });
      expect(error).toBeInstanceOf(ChannelError);
      expect((error as ChannelError).code).toBe("VALIDATION");
      expect((error as ChannelError).status).toBe(400);
      expect((error as ChannelError).issues.length).toBeGreaterThan(0);
      expect(took).toBeLessThan(2000);
    });
  });

  it("ValidationExceptionFilter: a refused ack (a server fault) is a ChannelError too", async () => {
    await withRoom(async (room) => {
      const { error, took } = await refusal(room, "say", { text: "bad ack" });
      expect(error).toBeInstanceOf(ChannelError);
      expect(took).toBeLessThan(2000);
    });
  });

  it("a thrown WsException (object, string), a thrown Error and a guard's refusal are EXCEPTION ChannelErrors", async () => {
    await withRoom(async (room) => {
      const object = await refusal(room, "object", undefined);
      expect((object.error as ChannelError).code).toBe("EXCEPTION");
      expect((object.error as ChannelError).detail).toBe("object refused");
      const string = await refusal(room, "string", undefined);
      expect((string.error as ChannelError).detail).toBe("string refused");
      const boom = await refusal(room, "boom", undefined);
      expect(boom.error).toBeInstanceOf(ChannelError);
      // Nest's answer: the error's own message never leaves the server.
      expect((boom.error as ChannelError).detail).toBe("Internal server error");
      const guarded = await refusal(room, "guarded", undefined);
      expect((guarded.error as ChannelError).code).toBe("EXCEPTION");
      expect(guarded.error).toBeInstanceOf(ChannelError);
      for (const { took } of [object, string, boom, guarded]) {
        expect(took).toBeLessThan(2000);
      }
    });
  });

  it("a filter extending BaseWsExceptionFilter (super.catch) is covered", async () => {
    await withRoom(async (room) => {
      const { error, took } = await refusal(room, "subclass", undefined);
      expect((error as ChannelError).detail).toBe("subclass refused");
      expect(took).toBeLessThan(2000);
    });
  });

  it("the channel still works after a failure, and the next request is its own", async () => {
    await withRoom(async (room) => {
      await refusal(room, "object", undefined);
      expect(await room.request("say", { text: "ok" })).toEqual({
        ok: true,
        length: 2,
      });
    });
  });
});

describe("the frame on the wire", () => {
  /** Sends `packet`, returns the first `exception` frame the gateway answers with. */
  async function exceptionFor(
    packet: object,
  ): Promise<Record<string, unknown>> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/acks`);
    const frame = new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.onmessage = (event) => {
        const parsed = JSON.parse(String(event.data)) as {
          data?: unknown[];
        };
        if (parsed.data?.[0] === "exception")
          resolve(parsed.data[1] as Record<string, unknown>);
      };
      ws.onerror = () => reject(new Error("socket error"));
    });
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify(packet));
    try {
      return await frame;
    } finally {
      ws.close();
    }
  }

  it("carries the packet's id as ackId (number and string ids), VALIDATION and WsException alike", async () => {
    const validation = await exceptionFor({
      type: 2,
      namespace: "/",
      id: 7,
      data: ["say", { text: "" }],
    });
    expect(validation).toMatchObject({
      status: 400,
      code: "VALIDATION",
      ackId: 7,
    });
    const thrown = await exceptionFor({
      type: 2,
      namespace: "/",
      id: "abc",
      data: ["string"],
    });
    expect(thrown).toMatchObject({
      status: "error",
      message: "string refused",
      ackId: "abc",
    });
  });

  it("control: an event with no ack id gets a frame with no ackId", async () => {
    const validation = await exceptionFor({
      type: 2,
      namespace: "/",
      data: ["say", { text: "" }],
    });
    expect(validation.code).toBe("VALIDATION");
    expect("ackId" in validation).toBe(false);
    const thrown = await exceptionFor({
      type: 2,
      namespace: "/",
      data: ["string"],
    });
    expect("ackId" in thrown).toBe(false);
  });
});
