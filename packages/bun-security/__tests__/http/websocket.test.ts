/**
 * `securityWebSocket` (layers.md L9.5) on a real bun-common WebSocket route:
 * a flooding client's messages are dropped and its connection closed 1008,
 * a polite client's all arrive, in order, also when a shared limit's answer
 * is awaited; the facts come from the upgrade (`ws.data.ip`, the route,
 * `identify`); the other handlers are kept.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { createSecurity } from "../../lib/index";
import type { MessageDecision, SecurityPolicy } from "../../lib/index";
import { securityWebSocket } from "../../lib/http/index";
import { fleet, quiet } from "../stores/fleet";

const listening: BunHttpAdapter[] = [];
afterEach(async () => {
  for (const adapter of listening.splice(0)) await adapter.close();
});

/** An adapter listening on port 0. */
async function listen(adapter: BunHttpAdapter): Promise<number> {
  listening.push(adapter);
  return Number((await adapter.listen(0, "127.0.0.1")).port);
}

/** A client: sends `count` messages at once, collects echoes, resolves on close or after `ms`. */
function client(
  port: number,
  count: number,
  ms = 1_000,
): Promise<{
  echoes: string[];
  closed: { code: number; reason: string } | undefined;
}> {
  return new Promise((resolve, reject) => {
    const echoes: string[] = [];
    let closed: { code: number; reason: string } | undefined;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/live`);
    const done = () => resolve({ echoes, closed });
    socket.onopen = () => {
      for (let i = 0; i < count; i++) socket.send(String(i));
      setTimeout(() => {
        socket.close();
        done();
      }, ms);
    };
    socket.onmessage = (event) => echoes.push(String(event.data));
    socket.onclose = (event) => {
      closed = { code: event.code, reason: event.reason };
      done();
    };
    socket.onerror = () => reject(new Error("socket error"));
  });
}

describe("securityWebSocket", () => {
  const policy: SecurityPolicy = {
    messages: { perConnection: { limit: 5, window: "1s" } },
  };

  it("passes a polite client's messages in order, and closes a flooding one 1008 after dropping", async () => {
    const security = createSecurity({ policy, logger: quiet });
    const refused: MessageDecision["action"][] = [];
    let opened = 0;
    const adapter = new BunHttpAdapter();
    adapter.ws(
      "/live",
      securityWebSocket(
        security,
        {
          open() {
            opened++;
          },
          message(ws, message) {
            ws.send(String(message));
          },
        },
        { onRefused: (_ws, decision) => refused.push(decision.action) },
      ),
    );
    const port = await listen(adapter);
    const polite = await client(port, 10, 200);
    expect(polite.echoes).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i)),
    );
    const flood = await client(port, 30);
    expect(flood.echoes).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i)),
    );
    expect(flood.closed).toEqual({ code: 1008, reason: "rate_limited" });
    expect(refused.slice(0, 2)).toEqual(["drop", "close"]);
    // The route's own open handler still ran.
    expect(opened).toBe(2);
  });

  it("keys on the upgrade's resolved address and identify(), and keeps order behind a shared limit", async () => {
    const f = fleet(1, {
      messages: {
        limits: [{ id: "per-user", limit: 3, window: "1m", key: "user" }],
      },
    });
    const [member] = f.members;
    if (member === undefined) throw new Error("one");
    const adapter = new BunHttpAdapter();
    const seen: string[] = [];
    adapter.ws(
      "/live",
      securityWebSocket(
        member.security,
        {
          message(ws, message) {
            seen.push(String(message));
            ws.send(String(message));
          },
        },
        {
          identify: (ws) => {
            expect(ws.data.ip).toBe("127.0.0.1");
            return { user: "alice" };
          },
        },
      ),
    );
    const port = await listen(adapter);
    const first = await client(port, 5, 300);
    // The shared store answers asynchronously; the three allowed arrive in order.
    expect(first.echoes).toEqual(["0", "1", "2"]);
    expect(first.closed?.code).toBe(1008);
    expect(seen).toEqual(["0", "1", "2"]);
    await f.close();
  });

  it("passes every message when the engine was closed before the connection opened", async () => {
    const security = createSecurity({ policy, logger: quiet });
    security.close();
    const adapter = new BunHttpAdapter();
    adapter.ws(
      "/live",
      securityWebSocket(security, {
        message(ws, message) {
          ws.send(String(message));
        },
      }),
    );
    const port = await listen(adapter);
    const result = await client(port, 20, 200);
    expect(result.echoes).toHaveLength(20);
  });
});
