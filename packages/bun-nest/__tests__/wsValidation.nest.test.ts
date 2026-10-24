/**
 * bun-validate V9 (`lib/wsValidation.ts`) against a real NestJS app:
 *
 * - `@ValidateMessage(schema)` checks the incoming payload (a failure is the
 *   filter's `exception` frame, the handler never runs) and writes the parsed
 *   value back, so `@MessageBody()` sees a coercion coerced;
 * - `@ValidateMessage(schema, { ack })` checks each non-nullish,
 *   non-`WsResponse` return against the ack schema: a match acks, a mismatch
 *   is the `exception` frame and no ack, a `WsResponse` is emitted unchecked;
 * - `@Emits(map)` checks a declared event's payload on `client.emit` (a sync
 *   vendor's mismatch throws to the caller — the filter's frame — and nothing
 *   is written; an async vendor's is logged and skipped, queued writes keeping
 *   their order), passes an undeclared event through, and rejects data for a
 *   `null` entry — composed with a gateway's own `handleConnection`.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import type { TypedSocket } from "../lib";
import type { WsTestClient } from "./helpers";
import { Logger, Module, UseFilters } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as yup from "yup";
import { z } from "zod";
import {
  BunHttpAdapter,
  Emits,
  ValidateMessage,
  ValidationExceptionFilter,
} from "../lib";
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";
import "reflect-metadata";

const { ACK, EVENT } = MessageEventTypes;

/* ------------------------------------------------------------------ *
 * The gateway under test: @ValidateMessage
 * ------------------------------------------------------------------ */

/** A string in, a `Date` out: the write-back is seen by `@MessageBody()`. */
const Stamp = z.object({ at: z.coerce.date() });

/** A payload whose refusal plants a secret the issues must never quote. */
const Vault = z.object({ word: z.string().min(30) });

const Ask = z.object({ q: z.string() });
const AskAck = z.object({ ok: z.boolean(), echo: z.string() });

/** The payloads the handlers actually received, per event. */
const receivedByHandler: Record<string, unknown[]> = {
  stamp: [],
  vault: [],
};

@WebSocketGateway({ path: "/validated" })
@UseFilters(ValidationExceptionFilter)
class ValidatedGateway {
  @SubscribeMessage("stamp")
  @ValidateMessage(Stamp)
  stamp(@MessageBody() msg: StandardSchemaV1.InferOutput<typeof Stamp>) {
    receivedByHandler.stamp.push(msg);
    return {
      event: "stamped",
      data: { isDate: msg.at instanceof Date, iso: msg.at.toISOString() },
    };
  }

  @SubscribeMessage("vault")
  @ValidateMessage(Vault)
  vault(@MessageBody() msg: StandardSchemaV1.InferOutput<typeof Vault>) {
    receivedByHandler.vault.push(msg);
    return { event: "leaked", data: msg };
  }

  @SubscribeMessage("ask")
  @ValidateMessage(Ask, { ack: AskAck })
  ask(@MessageBody() msg: StandardSchemaV1.InferOutput<typeof Ask>) {
    return { ok: true, echo: msg.q };
  }

  @SubscribeMessage("ask-async")
  @ValidateMessage(Ask, { ack: AskAck })
  async askAsync(@MessageBody() msg: StandardSchemaV1.InferOutput<typeof Ask>) {
    await Bun.sleep(5);
    return { ok: true, echo: msg.q };
  }

  @SubscribeMessage("ask-bad")
  @ValidateMessage(Ask, { ack: AskAck })
  askBad() {
    // A return the ack schema refuses, smuggled past the declared type.
    return {
      ok: "not-a-boolean",
      echo: "x",
    } as unknown as StandardSchemaV1.InferInput<typeof AskAck>;
  }

  @SubscribeMessage("ask-null")
  @ValidateMessage(Ask, { ack: AskAck })
  askNull() {
    return null;
  }

  @SubscribeMessage("announce")
  @ValidateMessage(Ask, { ack: AskAck })
  announce() {
    // Not an ack at all: a WsResponse is emitted, and never ack-checked
    // (this data would fail AskAck).
    return { event: "announcement", data: { not: "an ack" } };
  }

  @SubscribeMessage("sentinel")
  sentinel(@MessageBody() marker: string) {
    return { event: "sentinel", data: marker };
  }
}

/* ------------------------------------------------------------------ *
 * The gateway under test: @Emits
 * ------------------------------------------------------------------ */

const Said = z.object({ by: z.string(), text: z.string() });
/** An asynchronous vendor, so a `slow` emit's check queues behind a Promise. */
const SlowNote = yup.object({ note: yup.string().required() });

const chatEmits = {
  said: Said,
  typing: null,
  slow: SlowNote,
} as const;

/** The clients the gateway's own `handleConnection` saw. */
const connections: unknown[] = [];

/** `socket.emit` without the compile-time check, for the runtime-only paths. */
function unchecked(socket: TypedSocket<typeof chatEmits>) {
  return socket.emit as (event: string, data?: unknown) => boolean;
}

@WebSocketGateway({ path: "/emits" })
@UseFilters(ValidationExceptionFilter)
@Emits(chatEmits)
class EmitsGateway {
  handleConnection(client: unknown) {
    connections.push(client);
    // The checked emit is installed before the app's own hook runs.
    (client as TypedSocket<typeof chatEmits>).emit("typing");
  }

  @SubscribeMessage("emit-valid")
  emitValid(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>) {
    socket.emit("said", { by: "tester", text: "hello" });
  }

  @SubscribeMessage("emit-invalid")
  emitInvalid(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>) {
    // A payload the `said` schema refuses, smuggled past TypedSocket's check.
    const bad = { by: 42, text: "x" } as unknown as z.infer<typeof Said>;
    socket.emit("said", bad);
  }

  @SubscribeMessage("emit-undeclared")
  emitUndeclared(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>) {
    unchecked(socket)("free", { anything: true });
  }

  @SubscribeMessage("emit-null-with-data")
  emitNullWithData(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>) {
    unchecked(socket)("typing", {});
  }

  @SubscribeMessage("emit-null-ok")
  emitNullOk(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>) {
    socket.emit("typing");
  }

  @SubscribeMessage("emit-async-mix")
  emitAsyncMix(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>) {
    // The bad one is refused asynchronously (logged, skipped); the good one
    // queued behind it is still written. (yup casts: a number becomes a
    // string, so only a missing `note` fails.)
    unchecked(socket)("slow", {});
    socket.emit("slow", { note: "good" });
  }

  @SubscribeMessage("sentinel")
  sentinel(@MessageBody() marker: string) {
    return { event: "sentinel", data: marker };
  }
}

/* ------------------------------------------------------------------ *
 * The app
 * ------------------------------------------------------------------ */

@Module({ providers: [ValidatedGateway, EmitsGateway] })
class AppModule {}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const httpAdapter = new BunHttpAdapter(0);
  app = await NestFactory.create(AppModule, httpAdapter, { logger: false });
  app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
  await app.listen(0);
  base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;
});

afterAll(async () => {
  await app?.close();
});

/** A parsed packet from the server, loosely indexed for assertions. */
interface Frame {
  type?: number;
  id?: number;
  namespace?: string;
  data?: unknown[];
}

let markers = 0;

/**
 * Sends `packet`, then a sentinel, and resolves with every frame `packet`
 * produced (after a short settle for asynchronous acks and queued emits).
 */
async function framesFrom(
  client: WsTestClient,
  packet: Record<string, unknown>,
): Promise<Frame[]> {
  const before = client.received.length;
  const marker = `marker-${++markers}`;
  client.send({ type: EVENT, namespace: "/", ...packet });
  client.send({ type: EVENT, namespace: "/", data: ["sentinel", marker] });
  await client.waitFor(
    (m) => m?.data?.[0] === "sentinel" && m.data[1] === marker,
  );
  await Bun.sleep(30);
  return client.received
    .slice(before)
    .map((raw) => JSON.parse(raw) as Frame)
    .filter((m) => m?.data?.[0] !== "sentinel");
}

/** The `exception` frame's payload among `frames`, or undefined. */
function exceptionOf(frames: Frame[]):
  | {
      status: number;
      code: string;
      issues: Record<string, unknown>[];
    }
  | undefined {
  const frame = frames.find((f) => f.data?.[0] === "exception");
  return frame?.data?.[1] as
    | { status: number; code: string; issues: Record<string, unknown>[] }
    | undefined;
}

const ISO = "2026-01-02T03:04:05.000Z";
const SECRET = "Hunter2-Gateway-Secret";

describe("@ValidateMessage: the payload", () => {
  let client: WsTestClient;
  beforeAll(async () => {
    client = await connectWs(`${base}/validated`);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("a coercing schema's parsed value reaches @MessageBody() (the write-back)", async () => {
    expect(await framesFrom(client, { data: ["stamp", { at: ISO }] })).toEqual([
      {
        type: EVENT,
        namespace: "/",
        data: ["stamped", { isDate: true, iso: ISO }],
      },
    ]);
    expect(receivedByHandler.stamp).toHaveLength(1);
    const seen = receivedByHandler.stamp[0] as { at: unknown };
    expect(seen.at).toBeInstanceOf(Date);
  });

  it("a refused payload never reaches the handler and is the filter's exception frame, with value-free issues", async () => {
    const beforeRaw = client.received.length;
    const frames = await framesFrom(client, {
      data: ["vault", { word: SECRET }],
    });

    expect(receivedByHandler.vault).toEqual([]);
    expect(frames.some((f) => f.data?.[0] === "leaked")).toBe(false);

    expect(frames).toHaveLength(1);
    const exception = exceptionOf(frames);
    expect(exception?.status).toBe(400);
    expect(exception?.code).toBe("VALIDATION");
    expect(exception?.issues).toMatchObject([
      { target: "payload", key: "vault", path: "word" },
    ]);

    // The raw serialized frames never carry the received value.
    const raw = client.received.slice(beforeRaw).join("\n");
    expect(raw).not.toContain(SECRET);
  });
});

describe("@ValidateMessage: the ack", () => {
  let client: WsTestClient;
  beforeAll(async () => {
    client = await connectWs(`${base}/validated`);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("acks an EVENT packet's id with the handler's return", async () => {
    expect(
      await framesFrom(client, { id: 31, data: ["ask", { q: "ping" }] }),
    ).toEqual([
      {
        type: ACK,
        id: 31,
        namespace: "/",
        data: [{ ok: true, echo: "ping" }],
      },
    ]);
  });

  it("acks with a Promise's resolved value, checked the same", async () => {
    expect(
      await framesFrom(client, { id: 32, data: ["ask-async", { q: "pong" }] }),
    ).toEqual([
      {
        type: ACK,
        id: 32,
        namespace: "/",
        data: [{ ok: true, echo: "pong" }],
      },
    ]);
  });

  it("a return the ack schema refuses is the exception frame and no ack", async () => {
    const frames = await framesFrom(client, {
      id: 33,
      data: ["ask-bad", { q: "x" }],
    });
    expect(frames.some((f) => f.type === ACK)).toBe(false);
    expect(frames).toHaveLength(1);
    const exception = exceptionOf(frames);
    expect(exception?.status).toBe(400);
    expect(exception?.code).toBe("VALIDATION");
    expect(exception?.issues).toMatchObject([{ target: "ack", path: "ok" }]);
  });

  it("a nullish return is neither acked nor refused", async () => {
    expect(
      await framesFrom(client, { id: 34, data: ["ask-null", { q: "x" }] }),
    ).toEqual([]);
  });

  it("a WsResponse return is emitted as an event, never ack-checked", async () => {
    const frames = await framesFrom(client, {
      id: 35,
      data: ["announce", { q: "x" }],
    });
    expect(frames).toEqual([
      {
        type: EVENT,
        namespace: "/",
        data: ["announcement", { not: "an ack" }],
      },
    ]);
  });
});

describe("@Emits", () => {
  let client: WsTestClient;
  beforeAll(async () => {
    client = await connectWs(`${base}/emits`);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("stores the map under the bun:validate:emits metadata key", () => {
    expect(Reflect.getMetadata("bun:validate:emits", EmitsGateway)).toBe(
      chatEmits,
    );
  });

  it("composes with the gateway's own handleConnection, emits checked from it on", async () => {
    const beforeConnections = connections.length;
    const fresh = await connectWs(`${base}/emits`);
    try {
      // The hook's own `emit("typing")` (a null entry, no data) arrived.
      const welcome = await fresh.waitFor((m) => m?.data?.[0] === "typing");
      expect(welcome.data).toEqual(["typing"]);
      expect(connections).toHaveLength(beforeConnections + 1);
    } finally {
      await fresh.close();
    }
  });

  it("a valid emit reaches the client", async () => {
    expect(await framesFrom(client, { data: ["emit-valid", null] })).toEqual([
      {
        type: EVENT,
        namespace: "/emits",
        data: ["said", { by: "tester", text: "hello" }],
      },
    ]);
  });

  it("an invalid emit throws to the caller (the filter's exception frame) and writes nothing", async () => {
    const frames = await framesFrom(client, { data: ["emit-invalid", null] });
    expect(frames.some((f) => f.data?.[0] === "said")).toBe(false);
    expect(frames).toHaveLength(1);
    const exception = exceptionOf(frames);
    expect(exception?.status).toBe(400);
    expect(exception?.code).toBe("VALIDATION");
    expect(exception?.issues).toMatchObject([
      { target: "payload", key: "said", path: "by" },
    ]);
  });

  it("an undeclared event passes through unchecked", async () => {
    expect(
      await framesFrom(client, { data: ["emit-undeclared", null] }),
    ).toEqual([
      {
        type: EVENT,
        namespace: "/emits",
        data: ["free", { anything: true }],
      },
    ]);
  });

  it("a null entry rejects a payload", async () => {
    const frames = await framesFrom(client, {
      data: ["emit-null-with-data", null],
    });
    expect(frames.some((f) => f.data?.[0] === "typing")).toBe(false);
    expect(frames).toHaveLength(1);
    const exception = exceptionOf(frames);
    expect(exception?.status).toBe(400);
    expect(exception?.issues).toMatchObject([
      { target: "payload", message: "No data is declared here", path: "" },
    ]);
  });

  it("a null entry without data passes", async () => {
    expect(await framesFrom(client, { data: ["emit-null-ok", null] })).toEqual([
      { type: EVENT, namespace: "/emits", data: ["typing"] },
    ]);
  });

  it("an asynchronous vendor's mismatch is logged and skipped; queued emits keep their order", async () => {
    const spy = spyOn(Logger.prototype, "error").mockImplementation(() => {});
    try {
      const frames = await framesFrom(client, {
        data: ["emit-async-mix", null],
      });
      expect(frames.filter((f) => f.data?.[0] === "slow")).toEqual([
        { type: EVENT, namespace: "/emits", data: ["slow", { note: "good" }] },
      ]);
      const messages = spy.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some((m) => m.includes('emit "slow" failed its schema')),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("declaration errors", () => {
  /** The error `fn` throws, or a rethrown failure when it does not. */
  function errorOf(fn: () => unknown): unknown {
    try {
      fn();
    } catch (error) {
      return error;
    }
    throw new Error("did not throw");
  }

  it("ValidateMessage(42) throws a TypeError", () => {
    const error = errorOf(() => ValidateMessage(42 as never));
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      "@ValidateMessage: the schema must be a Standard Schema",
    );
  });

  it("ValidateMessage(schema, { ack: 42 }) throws a TypeError", () => {
    const error = errorOf(() => ValidateMessage(Ask, { ack: 42 as never }));
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      "@ValidateMessage: the ack must be a Standard Schema",
    );
  });

  it("Emits({ e: 'nope' }) throws a TypeError", () => {
    const error = errorOf(() => Emits({ e: "nope" } as never));
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain(
      '@Emits: the event "e" must be a Standard Schema or null',
    );
  });

  it("valid declarations do not throw", () => {
    expect(() => ValidateMessage(Ask)).not.toThrow();
    expect(() => ValidateMessage(Ask, { ack: AskAck })).not.toThrow();
    expect(() => Emits({ a: Ask, b: null })).not.toThrow();
  });
});
