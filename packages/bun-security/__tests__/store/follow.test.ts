/**
 * The engine following a policy kept in a security store (storage.md §6):
 * `createSecurity({ policy: { store, id } })` with `policyFile` (pushed on
 * a file change), `sqliteStore` (polled) and `memoryStore` (pushed); a
 * refused version kept out, with the last known good in force and one
 * `policy.refused` warning; a failing store (`faultyStore`) warned once and
 * recovered from; the reconcile catching what the feed missed; the
 * last-known-good file written `0600` and read first at start; and close
 * stopping it all.
 */
import type {
  Decision,
  Security,
  SecurityPolicy,
  SecurityWarning,
} from "../../lib/index";
import type { SecurityStoreDriver } from "../../lib/store/index";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import { memoryStore, policyFile, sqliteStore } from "../../lib/store/index";
import { faultyStore } from "../../lib/testing/index";
import { facts } from "../helpers";

const dir = mkdtempSync(join(tmpdir(), "bun-security-follow-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
let names = 0;

/** A fresh path in the test's directory. */
const fresh = (suffix: string): string =>
  join(dir, `${(names += 1)}-${suffix}`);

/** A policy blocking one address. */
const blocking = (ip: string): SecurityPolicy => ({
  service: "follow",
  lists: [{ ip, action: "block" }],
});

/** What the engine decides for a request from `client`. */
const action = (security: Security, client: string): string =>
  (security.evaluate(facts({ client })) as Decision).action;

/** Waits until `check` holds, checking every 10 ms, at most 3 s. */
async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Engines and stores to close when the case ends. */
const open: { close: () => unknown }[] = [];
afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close();
});

/** Publishes `policy` as the next version of `id` in `store`. */
async function publish(
  store: SecurityStoreDriver,
  policy: SecurityPolicy | Record<string, unknown>,
  id = "default",
): Promise<string> {
  const head = await store.get("policy", id);
  const version = `v${(head === undefined ? 0 : (head.doc as { number: number }).number) + 1}`;
  const result = await store.appendVersion(
    id,
    { id: version, policy },
    head === undefined ? null : (head.doc as { head: string }).head,
  );
  expect(result.ok).toBe(true);
  return version;
}

describe("createSecurity({ policy: { store } })", () => {
  it("policyFile: in force once ready, and reloaded when the file changes", async () => {
    const path = fresh("policy.json");
    writeFileSync(path, JSON.stringify(blocking("203.0.113.5")));
    const store = policyFile(path, { debounceMs: 10 });
    const security = createSecurity({ policy: { store } });
    open.push(security, store);
    await security.ready();
    expect(action(security, "203.0.113.5")).toBe("block");
    expect(security.status().policySource).toMatchObject({
      store: store.name,
      id: "default",
      fromLastKnownGood: false,
      refused: undefined,
      unavailable: false,
    });
    writeFileSync(path, JSON.stringify(blocking("198.51.100.7")));
    await until(
      "the new file",
      () => action(security, "198.51.100.7") === "block",
    );
    expect(action(security, "203.0.113.5")).toBe("allow");
  });

  it("sqliteStore: followed by polling, ignoring other policies", async () => {
    const path = fresh("store.sqlite");
    const writer = sqliteStore({ path });
    const store = sqliteStore({ path });
    open.push(writer, store);
    await publish(writer, blocking("203.0.113.5"), "checkout");
    const security = createSecurity({
      policy: { store, id: "checkout", pollIntervalMs: 20 },
    });
    open.push(security);
    await security.ready();
    expect(action(security, "203.0.113.5")).toBe("block");
    await publish(writer, blocking("192.0.2.1"), "other");
    await publish(writer, blocking("198.51.100.7"), "checkout");
    await until(
      "the polled version",
      () => action(security, "198.51.100.7") === "block",
    );
    expect(security.status().policySource?.version).toBe("v2");
  });

  it("memoryStore: pushed", async () => {
    const store = memoryStore();
    open.push(store);
    await publish(store, blocking("203.0.113.5"));
    const security = createSecurity({ policy: { store } });
    open.push(security);
    await security.ready();
    await publish(store, blocking("198.51.100.7"));
    await until(
      "the pushed version",
      () => action(security, "198.51.100.7") === "block",
    );
  });

  it("starts empty until the store has a policy, then loads it", async () => {
    const store = memoryStore();
    open.push(store);
    const security = createSecurity({ policy: { store } });
    open.push(security);
    await security.ready();
    expect(action(security, "203.0.113.5")).toBe("allow");
    expect(security.status().policySource?.version).toBeUndefined();
    await publish(store, blocking("203.0.113.5"));
    await until(
      "the first version",
      () => action(security, "203.0.113.5") === "block",
    );
  });

  it("keeps the last known good when a version is refused, warns once, and loads the next good one", async () => {
    const store = memoryStore();
    open.push(store);
    await publish(store, blocking("203.0.113.5"));
    const warnings: SecurityWarning[] = [];
    const security = createSecurity({
      policy: { store, reconcileIntervalMs: 20 },
      onWarning: (warning) => warnings.push(warning),
    });
    open.push(security);
    await security.ready();
    const refused = await publish(store, {
      lists: [{ ip: "nope", action: "block" }],
    });
    await until("the refusal", () =>
      warnings.some((w) => w.kind === "policy.refused"),
    );
    expect(action(security, "203.0.113.5")).toBe("block");
    expect(security.status().policySource).toMatchObject({
      version: "v1",
      refused: { version: refused },
    });
    expect(
      warnings.find((w) => w.kind === "policy.refused")?.message,
    ).toContain(refused);
    // Reconciled several times over: the same refused version is not retried or re-warned.
    await Bun.sleep(120);
    expect(warnings.filter((w) => w.kind === "policy.refused")).toHaveLength(1);
    await publish(store, blocking("198.51.100.7"));
    await until("the fix", () => action(security, "198.51.100.7") === "block");
    expect(security.status().policySource?.refused).toBeUndefined();
  });

  it("warns once while the store fails, keeps the policy, and recovers", async () => {
    const inner = memoryStore();
    open.push(inner);
    await publish(inner, blocking("203.0.113.5"));
    let failing = false;
    const store = faultyStore(inner, {
      fail: () => (failing ? new Error("store down") : undefined),
    });
    const warnings: SecurityWarning[] = [];
    const security = createSecurity({
      policy: { store, reconcileIntervalMs: 20 },
      onWarning: (warning) => warnings.push(warning),
      logger: () => undefined,
    });
    open.push(security);
    await security.ready();
    failing = true;
    await until(
      "the outage",
      () => security.status().policySource?.unavailable === true,
    );
    await Bun.sleep(100);
    expect(
      warnings.filter((w) => w.kind === "policy.unavailable"),
    ).toHaveLength(1);
    expect(action(security, "203.0.113.5")).toBe("block");
    await publish(inner, blocking("198.51.100.7"));
    failing = false;
    await until(
      "the recovery",
      () => action(security, "198.51.100.7") === "block",
    );
    expect(security.status().policySource?.unavailable).toBe(false);
  });

  it("the reconcile loads what the feed never said", async () => {
    const inner = memoryStore();
    open.push(inner);
    await publish(inner, blocking("203.0.113.5"));
    // A polled store whose feed is always empty.
    const store: SecurityStoreDriver = {
      ...inner,
      capabilities: { ...inner.capabilities, changeFeed: "poll" },
      subscribe: undefined,
      changesSince: async () => ({ changes: [], head: 0n }),
    };
    const security = createSecurity({
      policy: { store, pollIntervalMs: 10, reconcileIntervalMs: 40 },
    });
    open.push(security);
    await security.ready();
    await publish(inner, blocking("198.51.100.7"));
    await until(
      "the reconcile",
      () => action(security, "198.51.100.7") === "block",
    );
  });

  it("writes the last known good 0600, and starts on it while the store is down", async () => {
    const lastKnownGood = fresh("lkg.json");
    const inner = memoryStore();
    open.push(inner);
    await publish(inner, blocking("203.0.113.5"));
    const first = createSecurity({ policy: { store: inner, lastKnownGood } });
    open.push(first);
    await first.ready();
    expect(statSync(lastKnownGood).mode & 0o777).toBe(0o600);
    first.close();

    const down = faultyStore(memoryStore(), {
      fail: () => new Error("store down"),
    });
    const warnings: SecurityWarning[] = [];
    const second = createSecurity({
      policy: { store: down, lastKnownGood },
      onWarning: (warning) => warnings.push(warning),
      logger: () => undefined,
    });
    open.push(second);
    // Before ready, already: the file is read synchronously at start.
    expect(action(second, "203.0.113.5")).toBe("block");
    await second.ready();
    expect(second.status().policySource).toMatchObject({
      version: "v1",
      fromLastKnownGood: true,
      unavailable: true,
    });
    expect(warnings.map((w) => w.kind)).toContain("policy.unavailable");
  });

  it("ignores a last-known-good file for another policy, or one that is broken", async () => {
    const lastKnownGood = fresh("lkg.json");
    const store = memoryStore();
    open.push(store);
    await publish(store, blocking("203.0.113.5"), "a");
    const first = createSecurity({ policy: { store, id: "a", lastKnownGood } });
    await first.ready();
    first.close();
    const down = faultyStore(memoryStore(), { fail: () => new Error("down") });
    const other = createSecurity({
      policy: { store: down, id: "b", lastKnownGood },
      logger: () => undefined,
    });
    open.push(other);
    expect(action(other, "203.0.113.5")).toBe("allow");
    writeFileSync(lastKnownGood, "{ broken");
    const broken = createSecurity({
      policy: { store: down, id: "a", lastKnownGood },
      logger: () => undefined,
    });
    open.push(broken);
    expect(action(broken, "203.0.113.5")).toBe("allow");
  });

  it("starts empty when the last known good no longer compiles", async () => {
    const lastKnownGood = fresh("lkg.json");
    writeFileSync(
      lastKnownGood,
      JSON.stringify({
        format: "bun-security.lkg/1",
        policyId: "default",
        version: "v9",
        policy: { lists: [{ ip: "nope", action: "block" }] },
      }),
    );
    const down = faultyStore(memoryStore(), { fail: () => new Error("down") });
    const security = createSecurity({
      policy: { store: down, lastKnownGood },
      logger: () => undefined,
    });
    open.push(security);
    expect(security.status().policySource).toMatchObject({
      version: undefined,
      fromLastKnownGood: false,
    });
  });

  it("stops following on close", async () => {
    const store = memoryStore();
    open.push(store);
    await publish(store, blocking("203.0.113.5"));
    const security = createSecurity({
      policy: { store, reconcileIntervalMs: 10 },
    });
    await security.ready();
    security.close();
    await publish(store, blocking("198.51.100.7"));
    await Bun.sleep(80);
    expect(security.status().policySource?.version).toBe("v1");
  });

  it("refuses a bad interval", () => {
    const store = memoryStore();
    expect(() =>
      createSecurity({ policy: { store, pollIntervalMs: 0 } }),
    ).toThrow("pollIntervalMs");
    expect(() =>
      createSecurity({ policy: { store, reconcileIntervalMs: 1.5 } }),
    ).toThrow("reconcileIntervalMs");
  });
});
