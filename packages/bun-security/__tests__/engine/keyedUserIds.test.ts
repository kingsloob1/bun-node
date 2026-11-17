/**
 * User ids keyed like API key ids (#842): `identify()`'s `user` is kept,
 * shared and reported only as `HMAC(secret, "user|" + id)`, the same key in
 * `Decision.subject.user`, list hits, bans, the ban log, limit counters and
 * logs. The API still takes the id the app knows (`ban({ user })`,
 * `unban("user:<id>")`, `lists[].user`) and keys it; `ban({ userHash })`
 * takes a key as it is. An explicit list entry id is reported as written.
 */
import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { createLogger } from "@kingsleyweb/bun-common";
import type { LogEvent } from "@kingsleyweb/bun-common";
import { createCache, sqliteDriver } from "@kingsleyweb/bun-cache";
import { createSecurity } from "../../lib/index";
import type { Decision, SecurityPolicy } from "../../lib/index";
import { Keyring } from "../../lib/sensitive/keys";
import { cacheStore } from "../../lib/stores/index";
import { facts } from "../helpers";

const SECRET = "the-keyed-user-ids-test-secret-32b!!";
const RAW = "alice@example.com";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** An engine on `policy`; what it decided and logged. */
function engine(policy: SecurityPolicy, secret = SECRET) {
  const decisions: Decision[] = [];
  const logs: LogEvent[] = [];
  const security = createSecurity({
    secret,
    policy,
    logger: createLogger({ level: "trace", sink: (event) => logs.push(event) }),
    onDecision: (decision) => decisions.push(decision),
  });
  return { security, decisions, logs };
}

/** A request from `user`. */
const as = (user: string, client = "203.0.113.20") =>
  facts({
    client,
    path: "/api/orders",
    rawPath: "/api/orders",
    routeKey: "GET /api/orders",
    identity: { user },
  });

describe("user ids, keyed (#842)", () => {
  it("a list entry still matches, and the id reaches no decision, explanation or log", async () => {
    const { security, decisions, logs } = engine({
      lists: [{ user: RAW, action: "block" }],
    });
    const decision = await security.evaluate(as(RAW));
    expect(decision.action).toBe("block");
    const key = new Keyring(SECRET).user(RAW);
    expect(decision.subject.user).toBe(key);
    expect(decision.hits.map((hit) => hit.rule)).toEqual([`user:${key}`]);
    const explained = await security.explain(as(RAW));
    expect(explained.decision.hits.map((hit) => hit.rule)).toEqual([
      `user:${key}`,
    ]);
    for (const seen of [decision, decisions, explained, logs]) {
      expect(JSON.stringify(seen)).not.toContain(RAW);
    }
    expect((await security.evaluate(as("bob"))).action).toBe("allow");
    await security.close();
  });

  it("an explicit entry id is reported as written (the control: the checks above see a raw id when one is there)", async () => {
    const { security } = engine({
      lists: [{ id: `vip-block-${RAW}`, user: RAW, action: "block" }],
    });
    const decision = await security.evaluate(as(RAW));
    expect(decision.hits.map((hit) => hit.rule)).toEqual([`vip-block-${RAW}`]);
    expect(JSON.stringify(decision)).toContain(RAW);
    await security.close();
  });

  it("a ban by the id matches the user's requests, is held under the key, and lifts by the id or the key", async () => {
    const { security, logs } = engine({});
    const ban = security.ban({ user: RAW, duration: "1h" });
    const key = new Keyring(SECRET).user(RAW);
    expect(ban.id).toBe(`user:${key}`);
    expect(ban.subject).toEqual({ type: "user", value: key });
    const refused = await security.evaluate(as(RAW));
    expect(refused.action).toBe("ban");
    expect(refused.hits.map((hit) => hit.rule)).toEqual([`ban:user:${key}`]);
    expect(
      JSON.stringify({ refused, bans: security.bans(), logs }),
    ).not.toContain(RAW);
    // Lifted by the id the app knows.
    expect(security.unban(`user:${RAW}`)?.id).toBe(ban.id);
    expect((await security.evaluate(as(RAW))).action).toBe("allow");
    // And by the Ban.id from bans().
    const again = security.ban({ user: RAW });
    expect(security.unban(again.id)?.id).toBe(again.id);
    expect(security.bans()).toEqual([]);
    await security.close();
  });

  it("ban({ userHash }) takes a key as it is; a malformed one is refused", async () => {
    const { security } = engine({});
    const key = new Keyring(SECRET).user(RAW);
    expect(security.ban({ userHash: key }).id).toBe(`user:${key}`);
    expect((await security.evaluate(as(RAW))).action).toBe("ban");
    expect(() => security.ban({ userHash: RAW })).toThrow(/32 hex/);
    // Negative control: the key passed as an id is keyed twice and misses.
    const twice = engine({});
    twice.security.ban({ user: key });
    expect((await twice.security.evaluate(as(RAW))).action).toBe("allow");
    await security.close();
    await twice.security.close();
  });

  it("limits by user still count per user, under the key", async () => {
    const { security } = engine({
      limits: [{ id: "per-user", limit: 1, window: "1m", key: "user" }],
    });
    expect((await security.evaluate(as(RAW, "203.0.113.1"))).action).toBe(
      "allow",
    );
    // Another address, the same user: counted together.
    const limited = await security.evaluate(as(RAW, "203.0.113.2"));
    expect(limited.action).toBe("block");
    expect(JSON.stringify(limited)).not.toContain(RAW);
    expect((await security.evaluate(as("bob", "203.0.113.3"))).action).toBe(
      "allow",
    );
    await security.close();
  });

  it("two secrets, two keys: nothing to correlate across fleets", async () => {
    const one = engine({});
    const two = engine({}, "another-secret-of-at-least-32-bytes!!");
    const [a, b] = [
      await one.security.evaluate(as(RAW)),
      await two.security.evaluate(as(RAW)),
    ];
    expect(a.subject.user).toMatch(/^[0-9a-f]{32}$/);
    expect(b.subject.user).toMatch(/^[0-9a-f]{32}$/);
    expect(a.subject.user).not.toBe(b.subject.user);
    expect(one.security.ban({ user: RAW }).id).not.toBe(
      two.security.ban({ user: RAW }).id,
    );
    await one.security.close();
    await two.security.close();
  });

  it("the shared store's files hold the key, never the id: limit counters and the ban log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-security-keyed-users-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite");
    const cache = createCache({
      driver: sqliteDriver({ path }),
      logger: () => {},
    });
    const store = cacheStore(cache, { logger: () => {} });
    const security = createSecurity({
      secret: SECRET,
      store,
      policy: {
        limits: [{ id: "per-user", limit: 1, window: "1m", key: "user" }],
      },
      logger: () => {},
    });
    await security.ready();
    await security.evaluate(as(RAW));
    expect((await security.evaluate(as(RAW))).action).toBe("block");
    security.ban({ user: RAW, duration: "1h" });
    await security.flush();
    await security.close();
    await store.close();
    await cache.close();
    const bytes = Buffer.concat(
      [path, `${path}-wal`, `${path}-shm`]
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file)),
    );
    expect(bytes.includes(Buffer.from(RAW))).toBe(false);
    expect(bytes.includes(Buffer.from(new Keyring(SECRET).user(RAW)))).toBe(
      true,
    );
  });
});
