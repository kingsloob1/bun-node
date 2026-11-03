/**
 * The AsyncAPI document against the wire: a `defineChannel` channel served
 * for real (port 0), every frame the server sends — a reply, a push, and each
 * error frame — and the frames the client sends, each validated (ajv, JSON
 * Schema 2020-12) against the payload of the message its direction's
 * operation names in `generateAsyncApi`'s document. A document that describes
 * a frame the runtime does not send fails here, whichever side drifted.
 *
 * The two mismatches this pins (found by the channel client, PR-W2):
 *
 * - **The error frame is flat**, `{ type: "error", id?, code, status,
 *   issues?, detail? }`, its id under `id` whatever the envelope's field
 *   (`channelErrorFrame`) — the document used to describe it as the envelope
 *   `{ type, <idField>?, data: { code, … } }`.
 * - **A type on both sides keeps both schemas**: `ping` differs by direction,
 *   and the document used to key messages by type alone, so the receive
 *   operation named the server's `ping` (`serverAt` required) and the
 *   client's own frame failed it.
 *
 * Negative controls (recorded in the PR): restoring the envelope payload for
 * the error frame fails the error frames' cases; restoring type-only message
 * ids fails the client `ping` case.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { z } from "zod";
import { BunHttpAdapter } from "../../lib/BunHttpAdapter";
import { defineChannel } from "../../lib/channel";
import { generateAsyncApi } from "../../lib/docs/index";
import { createTestLogger } from "../../lib/logging";

/** The channel: a custom envelope field, a replied type, and `ping` declared both ways with different schemas. */
function makeChannel() {
  return defineChannel({
    path: "/agree",
    receives: {
      say: z.object({ text: z.string() }),
      ping: z.object({ sentAt: z.number() }),
    },
    sends: {
      said: z.object({ by: z.string(), text: z.string() }),
      ping: z.object({ sentAt: z.number(), serverAt: z.number() }),
    },
    replies: { say: "said" },
    envelope: { idField: "correlation" },
    meta: { name: "agree" },
  });
}

/** A JSON object frame. */
type Frame = Record<string, unknown>;
/** A JSON Schema, as the document carries it. */
type Schema = Record<string, unknown>;
/** An operation of the document, as far as these checks read it. */
interface Operation {
  /** `send` or `receive`. */
  action: string;
  /** The channel message references. */
  messages: { $ref: string }[];
}

/** Resolves a local JSON pointer (`#/a/b`) in `document`. */
function resolve(document: unknown, ref: string): unknown {
  let node = document;
  for (const raw of ref.replace(/^#\//, "").split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Follows `$ref`s to the object they name. */
function follow(document: unknown, value: unknown): Record<string, unknown> {
  let node = value as Record<string, unknown>;
  while (typeof node.$ref === "string") {
    node = resolve(document, node.$ref) as Record<string, unknown>;
  }
  return node;
}

/** A copy of `schema` without `$schema` (ajv allows it only at a root). */
function withoutDialect(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutDialect);
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "$schema")
      .map(([key, child]) => [key, withoutDialect(child)]),
  );
}

describe("the AsyncAPI document describes the frames a channel sends and receives", () => {
  let adapter: BunHttpAdapter;
  /** The server's frames, in arrival order. */
  const received: Frame[] = [];
  /** The client's good frames, as sent. */
  const sent: Frame[] = [];
  let document: unknown;

  beforeAll(async () => {
    const built = makeChannel();
    const { logger } = createTestLogger();
    adapter = new BunHttpAdapter(0, { logger });
    adapter.ws(
      built.path,
      built.checks(),
      built.handler({
        say: (_ws, data) => ({ by: "server", text: data.text }),
        ping(ws, data) {
          void built.send(ws, "ping", { sentAt: data.sentAt, serverAt: 2 });
        },
      }),
      built.options(),
    );
    const server = await adapter.listen(0);
    document = generateAsyncApi(adapter, {
      title: "Agreement",
      version: "1.0.0",
    }).document;

    const client = new WebSocket(`ws://127.0.0.1:${server.port}/agree`);
    client.onmessage = (event) => {
      received.push(JSON.parse(String(event.data)) as Frame);
    };
    await new Promise<void>((resolveOpen, reject) => {
      client.onopen = () => resolveOpen();
      client.onerror = () => reject(new Error("the socket did not open"));
    });
    const good: Frame[] = [
      { type: "say", correlation: "r-1", data: { text: "hi" } },
      { type: "ping", data: { sentAt: 1 } },
    ];
    for (const frame of good) {
      sent.push(frame);
      client.send(JSON.stringify(frame));
    }
    // Each error frame: an unknown type and an invalid one (both carrying an
    // id under the envelope's field), a frame that is not JSON, a binary one.
    client.send(JSON.stringify({ type: "nope", correlation: "r-2" }));
    client.send(
      JSON.stringify({ type: "say", correlation: "r-3", data: { text: 5 } }),
    );
    client.send("not json");
    client.send(new Uint8Array([1, 2, 3]));
    const deadline = Date.now() + 5000;
    while (received.length < 6 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    client.close();
  });

  afterAll(async () => {
    await adapter.close();
  });

  /** The message of `action`'s operation on the channel whose payload's `type` is `type`. */
  const messageFor = (action: "send" | "receive", type: string): Schema => {
    const operations = Object.values(
      (document as { operations: Record<string, Operation> }).operations,
    ).filter((operation) => operation.action === action);
    const found = operations
      .flatMap((operation) => operation.messages)
      .map((ref) => follow(document, ref))
      .find(
        (message) =>
          (
            (message.payload as { properties?: { type?: { const?: string } } })
              .properties?.type ?? {}
          ).const === type,
      );
    if (found === undefined) {
      throw new Error(`no ${action} message of type "${type}" in the document`);
    }
    return found.payload as Schema;
  };

  /** The ajv verdict of `frame` against `payload`, and the frame's keys the payload does not declare. */
  const check = (payload: Schema, frame: Frame) => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(withoutDialect(payload) as Schema);
    const valid = validate(frame);
    const declared = Object.keys(payload.properties ?? {});
    return {
      valid,
      errors: validate.errors ?? [],
      undeclared: Object.keys(frame).filter((key) => !declared.includes(key)),
    };
  };

  it("received the reply, the push and four error frames", () => {
    expect(received.map((frame) => frame.type)).toEqual([
      "said",
      "ping",
      "error",
      "error",
      "error",
      "error",
    ]);
  });

  it("the reply and the push match their send-side messages", () => {
    for (const frame of received.filter((f) => f.type !== "error")) {
      const verdict = check(messageFor("send", String(frame.type)), frame);
      expect({ frame, ...verdict }).toEqual({
        frame,
        valid: true,
        errors: [],
        undeclared: [],
      });
    }
    // The reply echoes the request's id under the envelope's field.
    expect(received[0]).toEqual({
      type: "said",
      correlation: "r-1",
      data: { by: "server", text: "hi" },
    });
  });

  it("every error frame matches the error message: flat, its id under `id`", () => {
    const payload = messageFor("send", "error");
    const errors = received.filter((frame) => frame.type === "error");
    expect(errors.map((frame) => frame.code)).toEqual([
      "UNKNOWN_MESSAGE",
      "VALIDATION",
      "VALIDATION",
      "UNSUPPORTED_DATA",
    ]);
    // The runtime's shape, as channelErrorFrame builds it: `id`, not
    // `correlation`, and no `data`.
    expect(errors[0]).toMatchObject({ id: "r-2" });
    expect(errors[0]).not.toHaveProperty("correlation");
    expect(errors[1]).toMatchObject({ id: "r-3" });
    for (const frame of errors) {
      expect(frame).not.toHaveProperty("data");
      const verdict = check(payload, frame);
      expect({ frame, ...verdict }).toEqual({
        frame,
        valid: true,
        errors: [],
        undeclared: [],
      });
    }
  });

  it("the client's frames match their receive-side messages, `ping` its own", () => {
    for (const frame of sent) {
      const verdict = check(messageFor("receive", String(frame.type)), frame);
      expect({ frame, ...verdict }).toEqual({
        frame,
        valid: true,
        errors: [],
        undeclared: [],
      });
    }
    // Not vacuous: the client's `ping` is not the server's (`serverAt` is
    // required there), so the two directions are documented apart.
    const clientPing = sent.find((frame) => frame.type === "ping")!;
    expect(check(messageFor("send", "ping"), clientPing).valid).toBe(false);
  });
});
