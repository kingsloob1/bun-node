/**
 * WebSocket message limits (layers.md L9.5), on the engine:
 * `security.socket(facts).message()`. A token bucket per connection (burst
 * 2× by default), limits per subject across connections, a dropped message
 * on a breach and a close on a second breach within the window, dry run,
 * the allow and internal lists, a failing shared store; and the section's
 * policy checks.
 */
import { describe, expect, it } from "bun:test";
import {
  compilePolicy,
  createSecurity,
  SecurityPolicyError,
} from "../../lib/index";
import type {
  MessageDecision,
  MessagePolicy,
  Security,
  SocketLimiter,
} from "../../lib/index";
import { facts, fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";
import { fleet, quiet } from "../stores/fleet";

/** An engine with `messages`, on a fake clock. */
function engine(
  messages: MessagePolicy,
  clock: FakeClock = fakeClock(),
  extra: object = {},
): Security {
  return createSecurity({
    policy: { messages, ...extra },
    now: clock.now,
    logger: quiet,
  });
}

/** `message()`, required to be synchronous. */
function send(socket: SocketLimiter): MessageDecision {
  const decision = socket.message();
  if (decision instanceof Promise) throw new Error("expected synchronous");
  return decision;
}

/** The actions of `n` messages. */
function burst(socket: SocketLimiter, n: number): string[] {
  return Array.from({ length: n }, () => send(socket).action);
}

describe("the per-connection bucket", () => {
  it("lets a burst of 2× the rate through, then drops, then closes on a second breach within 10 s", () => {
    const clock = fakeClock();
    const security = engine(
      { perConnection: { limit: 5, window: "1s" } },
      clock,
    );
    const socket = security.socket(facts());
    expect(burst(socket, 10).every((action) => action === "allow")).toBe(true);
    const dropped = send(socket);
    expect(dropped.action).toBe("drop");
    expect(dropped.hits[0]).toMatchObject({
      rule: "message:per-connection",
      action: "block",
    });
    // Refilled at 5 per second: one more after 200 ms.
    clock.advance(200);
    expect(send(socket).action).toBe("allow");
    const closed = send(socket);
    expect(closed).toMatchObject({
      action: "close",
      code: 1008,
      reason: "rate_limited",
    });
  });

  it("drops again, without closing, once the breach window has passed", () => {
    const clock = fakeClock();
    const security = engine(
      { perConnection: { limit: 1, window: "1s" }, burst: 1, breach: "2s" },
      clock,
    );
    const socket = security.socket(facts());
    expect(burst(socket, 2)).toEqual(["allow", "drop"]);
    clock.advance(2_000);
    // The first breach after the window drops; the next one within it closes.
    expect(burst(socket, 3)).toEqual(["allow", "drop", "close"]);
  });

  it("is per connection: another connection from the same address has its own", () => {
    const security = engine({
      perConnection: { limit: 1, window: "1s" },
      burst: 1,
    });
    const one = security.socket(facts());
    const two = security.socket(facts());
    expect(burst(one, 2)).toEqual(["allow", "drop"]);
    expect(burst(two, 1)).toEqual(["allow"]);
  });

  it("in dry run records the breach and lets every message through", () => {
    const security = engine({
      perConnection: { limit: 1, window: "1s" },
      burst: 1,
      mode: "dryRun",
    });
    const socket = security.socket(facts());
    send(socket);
    const decision = send(socket);
    expect(decision.action).toBe("allow");
    expect(decision.hits[0]).toMatchObject({
      action: "log",
      wouldHaveBeen: "block",
    });
  });
});

describe("limits per subject across connections", () => {
  it("count every connection of the subject together, closing with the section's code", () => {
    const security = engine({
      limits: [{ id: "per-ip", limit: 3, window: "1m", code: "too_chatty" }],
      closeCode: 4008,
    });
    const one = security.socket(facts({ client: "198.51.100.1" }));
    const two = security.socket(facts({ client: "198.51.100.1" }));
    const other = security.socket(facts({ client: "198.51.100.2" }));
    expect([send(one).action, send(two).action, send(one).action]).toEqual([
      "allow",
      "allow",
      "allow",
    ]);
    expect(send(two).action).toBe("drop");
    expect(send(two)).toMatchObject({
      action: "close",
      code: 4008,
      reason: "too_chatty",
    });
    expect(send(other).action).toBe("allow");
  });

  it("skip an allow-listed client, and an internal one on an address key", () => {
    const security = engine(
      { limits: [{ id: "per-ip", limit: 1, window: "1m" }] },
      fakeClock(),
      { lists: [{ ip: "198.51.100.9", action: "allow" }] },
    );
    const allowed = security.socket(facts({ client: "198.51.100.9" }));
    expect(burst(allowed, 3)).toEqual(["allow", "allow", "allow"]);
    const internal = security.socket(facts({ client: "10.1.2.3" }));
    expect(burst(internal, 3)).toEqual(["allow", "allow", "allow"]);
  });

  it("key on the caller from the upgrade's identity", () => {
    const security = engine({
      limits: [{ id: "per-user", limit: 1, window: "1m", key: "user" }],
    });
    const alice1 = security.socket(facts({ identity: { user: "alice" } }));
    const alice2 = security.socket(
      facts({ client: "198.51.100.3", identity: { user: "alice" } }),
    );
    const anonymous = security.socket(facts());
    expect(send(alice1).action).toBe("allow");
    expect(send(alice2).action).toBe("drop");
    expect(burst(anonymous, 2)).toEqual(["allow", "allow"]);
  });

  it("hold across engines sharing a store; a failing store with onStoreError closed closes 1013", async () => {
    const f = fleet(2, {
      messages: {
        limits: [
          { id: "per-ip", limit: 2, window: "1m" },
          { id: "strict", limit: 100, window: "1m", onStoreError: "closed" },
        ],
      },
    });
    const [a, b] = f.members.map((member) => member.security);
    if (a === undefined || b === undefined) throw new Error("two");
    const sa = a.socket(facts({ client: "198.51.100.4" }));
    const sb = b.socket(facts({ client: "198.51.100.4" }));
    expect((await sa.message()).action).toBe("allow");
    expect((await sb.message()).action).toBe("allow");
    expect((await sa.message()).action).toBe("drop");
    f.driver.setFaults({ down: true });
    const closed = await sb.message();
    expect(closed).toMatchObject({ action: "close", code: 1013 });
    await f.close();
  });
});

describe("the engine's state", () => {
  it("allows everything with no section, after the policy turns it off, and once closed", () => {
    const none = engine({});
    expect(send(none.socket(facts())).action).toBe("allow");
    const security = engine({
      perConnection: { limit: 1, window: "1s" },
      burst: 1,
    });
    const socket = security.socket(facts());
    expect(burst(socket, 2)).toEqual(["allow", "drop"]);
    security.load({
      messages: { mode: "off", perConnection: { limit: 1, window: "1s" } },
    });
    expect(burst(socket, 3)).toEqual(["allow", "allow", "allow"]);
    security.close();
    expect(() => security.socket(facts())).toThrow("closed");
    expect(send(socket).action).toBe("allow");
  });
});

describe("the messages section's checks", () => {
  it("refuses bad values, naming each", () => {
    const issues = (messages: unknown): string[] => {
      try {
        compilePolicy({ messages } as never);
        return [];
      } catch (error) {
        if (!(error instanceof SecurityPolicyError)) throw error;
        return error.issues.map((issue) => issue.path.join("."));
      }
    };
    expect(issues({ perConnection: { limit: 0, window: "1s" } })).toEqual([
      "messages.perConnection.limit",
    ]);
    expect(issues({ perConnection: { limit: 1, window: 1 } })).toEqual([
      "messages.perConnection.window",
    ]);
    expect(issues({ perConnection: { limit: 1, window: "100ms" } })).toEqual([
      "messages.perConnection.window",
    ]);
    expect(issues({ burst: 0.5 })).toEqual(["messages.burst"]);
    expect(issues({ breach: "10ms" })).toEqual(["messages.breach"]);
    expect(issues({ closeCode: 1000 })).toEqual(["messages.closeCode"]);
    expect(issues({ closeCode: 4000 })).toEqual([]);
    expect(issues({ limits: [{ id: "a", limit: 1 }] })).toEqual([
      "messages.limits.0.window",
    ]);
    expect(
      issues({
        limits: [
          { id: "a", limit: 1, window: "1m" },
          { id: "a", limit: 1, window: "1m" },
        ],
      }),
    ).toEqual(["messages.limits.1.id"]);
    expect(issues({ nope: true })).toEqual(["messages.nope"]);
  });
});
