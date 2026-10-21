/**
 * The extension point, proven: a UDP transport adapter (`udp.ts`, port 0 on
 * loopback) gets typed, validated handlers from the core alone (plan §4.2,
 * the spike's C1–C6).
 */
import type { GuardOptions } from "../../lib/contract/model";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ContractError, createReceiver } from "../../lib/contract/guard";
import { createTestLogger } from "../../lib/logging";
import { serveUdp, udp, udpClient } from "./udp";

const chat = udp.contract({
  inbound: {
    "chat.post": {
      payload: z.object({
        room: z.string(),
        text: z.string().max(20),
        at: z.coerce.date(),
      }),
    },
  },
  outbound: { "chat.ack": { payload: z.object({ seq: z.number().int() }) } },
});

const good = {
  type: "chat.post",
  payload: { room: "r1", text: "hi", at: "2026-10-17T00:00:00Z" },
};
const bad = {
  type: "chat.post",
  payload: { room: "r1", text: "x".repeat(30), at: "2026-10-17T00:00:00Z" },
};

/** Serves `chat` under `options`, sends `message` raw, and reports what the handler saw and what came back. */
async function round(options: GuardOptions, message: unknown) {
  const seen: unknown[] = [];
  let seq = 0;
  const server = await serveUdp(
    chat,
    (m) => {
      seen.push(m);
      return { type: "chat.ack", payload: { seq: ++seq } };
    },
    options,
  );
  const client = await udpClient(chat, server.port, { policy: "off" });
  try {
    return { reply: await client.raw(message), seen };
  } finally {
    client.close();
    server.close();
  }
}

describe("a UDP adapter on the contract core", () => {
  it("C1: hands a valid datagram to the handler parsed, and checks the reply", async () => {
    const { reply, seen } = await round({ policy: "error" }, good);
    expect(reply).toEqual({ type: "chat.ack", payload: { seq: 1 } });
    expect(seen).toHaveLength(1);
    expect((seen[0] as { payload: { at: unknown } }).payload.at).toBeInstanceOf(
      Date,
    );
  });

  it("C2: answers an invalid datagram with an error frame and never calls the handler", async () => {
    const { reply, seen } = await round({ policy: "error" }, bad);
    expect(seen).toHaveLength(0);
    expect(reply).toEqual({
      type: "error",
      payload: {
        issues: [
          {
            target: "payload",
            key: "chat.post",
            path: "text",
            message: expect.any(String),
          },
        ],
      },
    });
  });

  it("C3: under warn, logs once and hands on the raw message", async () => {
    const { logger, events } = createTestLogger();
    const { seen } = await round({ policy: "warn", logger }, bad);
    expect(seen).toHaveLength(1);
    expect(typeof (seen[0] as { payload: { at: unknown } }).payload.at).toBe(
      "string",
    );
    expect(events.filter((e) => e.level === "warn")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("x".repeat(30));
  });

  it("C4: under off, never calls the schema", () => {
    let calls = 0;
    const counted = z.object({ text: z.string() });
    const original = counted["~standard"].validate;
    Object.defineProperty(counted["~standard"], "validate", {
      value: (x: unknown) => {
        calls++;
        return original(x);
      },
    });
    const c = udp.contract({ inbound: { m: { payload: counted } } });
    const off = createReceiver(c, "inbound", { policy: "off" });
    const on = createReceiver(c, "inbound", { policy: "error" });
    expect(off.checks).toBe(false);
    void off({ type: "m", payload: { text: 1 } });
    expect(calls).toBe(0);
    void on({ type: "m", payload: { text: 1 } });
    expect(calls).toBe(1);
  });

  it("C5: reports an undeclared type on the key field, without echoing it", async () => {
    const { reply } = await round(
      { policy: "error" },
      { type: "chat.delete-SECRET", payload: {} },
    );
    expect(reply).toMatchObject({
      type: "error",
      payload: { issues: [{ target: "type", path: "" }] },
    });
    expect(JSON.stringify(reply)).not.toContain("SECRET");
  });

  it("C6: the typed client refuses an invalid request before sending it", async () => {
    let handled = 0;
    const server = await serveUdp(chat, () => {
      handled++;
      return { type: "chat.ack", payload: { seq: 0 } };
    });
    const client = await udpClient(chat, server.port);
    try {
      const r = await client.request({
        type: "chat.post",
        payload: { room: "r", text: "y".repeat(30), at: new Date() },
      });
      expect(r).toBeInstanceOf(ContractError);
      expect((r as ContractError).issues).toMatchObject([
        { target: "payload", path: "text", key: "chat.post" },
      ]);
      expect(handled).toBe(0);
    } finally {
      client.close();
      server.close();
    }
  });
});
