/**
 * `postgresStore` beyond the kit (PR-D2): the change sequence under
 * concurrent commits — a transaction that took its number first and commits
 * last is never skipped by a reader, with the naive store (no serialising
 * lock) as the negative control that does skip it; the pushed feed (`LISTEN`,
 * a gap on a reconnect, polling when `LISTEN` cannot be set up); the engine
 * following a policy kept in Postgres; and `syncSchema` after drift.
 */
import type { SecurityPolicy, Security, Decision } from "../../lib/index";
import type { SecurityStoreDriver } from "../../lib/store/index";
import { SQL } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import {
  AUDIT_GENESIS_HASH,
  postgresStore,
  storeTables,
} from "../../lib/store/index";
import { changeChannel, postgresInit } from "../../lib/store/postgres";
import { sqlSecurityStore } from "../../lib/store/sql";
import { facts } from "../helpers";
import {
  dropStore,
  freshPrefix,
  POSTGRES_URL,
  postgresAvailable,
} from "./pgBackend";

/** Waits until `check` holds, checking every 10 ms, at most 5 s. */
async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

if (await postgresAvailable()) {
  /** Stores and engines to close, and prefixes to drop, when the case ends. */
  const open: { close: () => unknown }[] = [];
  const prefixes: string[] = [];
  afterEach(async () => {
    for (const item of open.splice(0).reverse()) await item.close();
    for (const prefix of prefixes.splice(0)) await dropStore(prefix);
  });

  /** A fresh prefix, dropped when the case ends. */
  const prefixed = (): string => {
    const prefix = freshPrefix();
    prefixes.push(prefix);
    return prefix;
  };

  /**
   * A store whose first change waits, inside its transaction and after its
   * sequence number is taken, until `release()`: the interleaving a slow
   * writer makes. `serialize: false` is the naive store, with no lock.
   */
  function gated(serialize: boolean) {
    const prefix = prefixed();
    const base = postgresInit({ url: POSTGRES_URL, prefix, max: 4 });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => {};
    const recorded = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let held = false;
    const store = sqlSecurityStore({
      ...base,
      ...(serialize ? {} : { serialize: undefined }),
      afterChange: async (tx, seq) => {
        await base.afterChange?.(tx, seq);
        if (!held) {
          held = true;
          reached();
          await gate;
        }
      },
    });
    open.push(store);
    return { store, release, recorded };
  }

  describe("postgres: the change sequence under concurrent commits", () => {
    it("negative control: without the lock, a change that commits after a later one is skipped by a reader at the head", async () => {
      const { store, release, recorded } = gated(false);
      await store.connect();
      // A takes the first number and waits inside its transaction.
      const slow = store.put("service", "a", {}, null);
      await recorded;
      // B takes the second and commits.
      const fast = await store.put("service", "b", {}, null);
      expect(fast.ok).toBe(true);
      const first = await store.changesSince(0n, 100);
      expect(first.changes.map((change) => change.id)).toEqual(["b"]);
      // A reader carries on from the head it saw; then A commits.
      release();
      const late = await slow;
      expect(late.ok && fast.ok && late.seq < fast.seq).toBe(true);
      const next = await store.changesSince(first.head, 100);
      // A's change is behind the cursor: lost to this reader for good.
      expect(next.changes).toEqual([]);
    });

    it("with the lock, the later writer waits, and a reader at the head sees every change, in order", async () => {
      const { store, release, recorded } = gated(true);
      await store.connect();
      const slow = store.put("service", "a", {}, null);
      await recorded;
      let fastDone = false;
      const fast = store.put("service", "b", {}, null).then((result) => {
        fastDone = true;
        return result;
      });
      // B is held at the lock, so the reader sees nothing yet.
      await Bun.sleep(100);
      expect(fastDone).toBe(false);
      const first = await store.changesSince(0n, 100);
      expect(first.changes).toEqual([]);
      release();
      const [a, b] = await Promise.all([slow, fast]);
      expect(a.ok && b.ok && a.seq < b.seq).toBe(true);
      const next = await store.changesSince(first.head, 100);
      expect(next.changes.map((change) => change.id)).toEqual(["a", "b"]);
    });

    it("many writers on several clients at once: the feed read from the head as they commit misses nothing", async () => {
      const prefix = prefixed();
      const writers = Array.from({ length: 4 }, () =>
        postgresStore({ url: POSTGRES_URL, prefix, max: 2 }),
      );
      const reader = postgresStore({ url: POSTGRES_URL, prefix, max: 1 });
      open.push(...writers, reader);
      await Promise.all([...writers, reader].map((store) => store.connect()));
      const seen: string[] = [];
      let cursor = 0n;
      const state = { writing: true };
      const reading = (async () => {
        while (state.writing) {
          const { changes } = await reader.changesSince(cursor, 1_000);
          for (const change of changes) {
            seen.push(change.id);
            cursor = change.seq;
          }
          await Bun.sleep(1);
        }
      })();
      await Promise.all(
        writers.map(async (store, w) => {
          for (let i = 0; i < 25; i++) {
            expect(
              (await store.put("service", `w${w}-${i}`, {}, null)).ok,
            ).toBe(true);
          }
        }),
      );
      state.writing = false;
      await reading;
      const { changes } = await reader.changesSince(cursor, 1_000);
      seen.push(...changes.map((change) => change.id));
      expect(new Set(seen).size).toBe(100);
      expect(seen).toHaveLength(100);
    });
  });

  describe("postgres: the audit chain takes the same lock", () => {
    /** An audit entry on the genesis. */
    const firstEntry = () => ({
      hash: "1".repeat(64),
      prevHash: AUDIT_GENESIS_HASH,
      at: 1,
      actor: "alice",
      action: "service.put",
      scope: "service:a",
      entry: { k: 1 },
    });
    /** A checkpoint (the store keeps it; signatures are the log's business). */
    const checkpoint = {
      n: 1,
      hash: "1".repeat(64),
      at: 2,
      keyId: "ak",
      signature: "c2ln",
    };

    for (const serialize of [true, false]) {
      it(`${serialize ? "with" : "negative control: without"} the lock, an audit append, a checkpoint, a counter, a claim and a ban ${serialize ? "wait for" : "pass"} a change held in its transaction`, async () => {
        const { store, release, recorded } = gated(serialize);
        await store.connect();
        const slow = store.put("service", "a", {}, null);
        await recorded;
        let appended = false;
        let checkpointed = false;
        const append = store.appendAudit(firstEntry(), null).then((result) => {
          appended = true;
          return result;
        });
        const stored = store.appendCheckpoint(checkpoint).then(() => {
          checkpointed = true;
        });
        // The break-glass state's writes take it too.
        let counted = false;
        let claimed = false;
        const counter = store
          .incrementCounter("bg:failures", 60_000)
          .then(() => {
            counted = true;
          });
        const claim = store.claimKey("bg:code:1", 60_000).then(() => {
          claimed = true;
        });
        // And a ban's.
        let banned = false;
        const ban = store
          .upsertBan({
            scope: "global",
            subject: { type: "ip", value: "203.0.113.7" },
            action: "ban",
            reason: "test",
            source: "manual",
            expiresAt: null,
          })
          .then(() => {
            banned = true;
          });
        try {
          if (serialize) {
            // Held at the lock for as long as the change is held.
            await Bun.sleep(300);
            expect([appended, checkpointed, counted, claimed, banned]).toEqual([
              false,
              false,
              false,
              false,
              false,
            ]);
          } else {
            // Through while the change is still held (however long a new
            // connection takes on a busy machine).
            await Promise.race([
              Promise.all([append, stored, counter, claim, ban]),
              Bun.sleep(5_000),
            ]);
            expect([appended, checkpointed, counted, claimed, banned]).toEqual([
              true,
              true,
              true,
              true,
              true,
            ]);
          }
        } finally {
          // Never leave the held transaction open for the next case.
          release();
        }
        const [put, audit] = await Promise.all([
          slow,
          append,
          stored,
          counter,
          claim,
          ban,
        ]);
        expect(put.ok && audit.ok).toBe(true);
        // With the lock, the feed numbers the audit change after the held one.
        if (serialize && put.ok && audit.ok)
          expect(audit.seq > put.seq).toBe(true);
      }, 15_000);
    }
  });

  describe("postgres: the pushed feed", () => {
    it("pushes the head on LISTEN's acknowledgement and on each change", async () => {
      const prefix = prefixed();
      const store = postgresStore({ url: POSTGRES_URL, prefix });
      open.push(store);
      await store.connect();
      const heard: bigint[] = [];
      const stop = store.subscribe!(
        (head) => heard.push(head),
        () => {},
      );
      await until("the first push", () => heard.length > 0);
      const written = await store.put("service", "a", {}, null);
      await until("the change's push", () =>
        heard.some((head) => written.ok && head >= written.seq),
      );
      stop();
    });

    it("a dropped LISTEN connection reports a gap, and pushes again once Bun reconnects", async () => {
      const prefix = prefixed();
      const store = postgresStore({ url: POSTGRES_URL, prefix });
      open.push(store);
      await store.connect();
      const heard: bigint[] = [];
      let gaps = 0;
      const stop = store.subscribe!(
        (head) => heard.push(head),
        () => {
          gaps += 1;
        },
      );
      await until("the first push", () => heard.length > 0);
      const admin = new SQL(POSTGRES_URL!);
      try {
        const killed = await admin.unsafe(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE $1",
          [`%listen%${changeChannel(prefix)}%`],
        );
        expect(killed.length).toBe(1);
      } finally {
        await admin.close();
      }
      await until("the gap", () => gaps > 0);
      const written = await store.put("service", "after", {}, null);
      await until("a push after the reconnect", () =>
        heard.some((head) => written.ok && head >= written.seq),
      );
      stop();
    });

    it("polls, after reporting a gap, when LISTEN cannot be set up", async () => {
      const prefix = prefixed();
      const store = sqlSecurityStore(
        postgresInit(
          { url: POSTGRES_URL, prefix, pollIntervalMs: 20 },
          { listen: false },
        ),
      );
      open.push(store);
      await store.connect();
      const heard: bigint[] = [];
      let gaps = 0;
      const stop = store.subscribe!(
        (head) => heard.push(head),
        () => {
          gaps += 1;
        },
      );
      await until("the gap", () => gaps === 1);
      await Bun.sleep(50);
      const written = await store.put("service", "a", {}, null);
      await until("the polled head", () =>
        heard.some((head) => written.ok && head >= written.seq),
      );
      stop();
    });
  });

  describe("postgres: the engine following a policy", () => {
    /** A policy blocking one address. */
    const blocking = (ip: string): SecurityPolicy => ({
      service: "pg",
      lists: [{ ip, action: "block" }],
    });

    /** Publishes `policy` as the next version of `checkout`. */
    async function publish(
      store: SecurityStoreDriver,
      policy: SecurityPolicy,
    ): Promise<void> {
      const head = await store.get("policy", "checkout");
      const number =
        head === undefined ? 0 : (head.doc as { number: number }).number;
      const result = await store.appendVersion(
        "checkout",
        { id: `v${number + 1}`, policy },
        head === undefined ? null : (head.doc as { head: string }).head,
      );
      expect(result.ok).toBe(true);
    }

    /** What the engine decides for a request from `client`. */
    const action = (security: Security, client: string): string =>
      (security.evaluate(facts({ client })) as Decision).action;

    it("loads the head, and follows a publish from another process by the pushed feed", async () => {
      const prefix = prefixed();
      const writer = postgresStore({ url: POSTGRES_URL, prefix });
      const store = postgresStore({ url: POSTGRES_URL, prefix });
      open.push(writer, store);
      await publish(writer, blocking("203.0.113.5"));
      // The reconcile is an hour away: only the push can deliver the next one.
      const security = createSecurity({
        policy: { store, id: "checkout", reconcileIntervalMs: 3_600_000 },
      });
      open.push(security);
      await security.ready();
      expect(action(security, "203.0.113.5")).toBe("block");
      await publish(writer, blocking("198.51.100.7"));
      await until(
        "the pushed version",
        () => action(security, "198.51.100.7") === "block",
      );
      expect(security.status().policySource).toMatchObject({
        store: "postgres",
        version: "v2",
      });
    });
  });

  describe("postgres: schema sync", () => {
    it("reports drift as a plan, repairs it, and the code-point indexes are part of the baseline", async () => {
      const prefix = prefixed();
      const first = postgresStore({ url: POSTGRES_URL, prefix });
      await first.connect();
      expect(await first.syncSchema!({ dryRun: true })).toEqual([]);
      await first.close();
      const admin = new SQL(POSTGRES_URL!);
      try {
        await admin.unsafe(`DROP INDEX ix_${prefix}docs_id`);
        await admin.unsafe(
          `CREATE INDEX ix_${prefix}docs_retired ON ${storeTables(prefix).docs} (revision)`,
        );
      } finally {
        await admin.close();
      }
      const second = postgresStore({ url: POSTGRES_URL, prefix });
      open.push(second);
      const plan = await second.syncSchema!({ dryRun: true });
      expect(plan.map((change) => [change.kind, change.target]).sort()).toEqual(
        [
          ["create-index", `ix_${prefix}docs_id`],
          ["drop-index", `ix_${prefix}docs_retired`],
        ],
      );
      await second.syncSchema!();
      expect(await second.syncSchema!({ dryRun: true })).toEqual([]);
    });

    it("lists ids by code point, whatever the database's locale", async () => {
      const prefix = prefixed();
      const store = postgresStore({ url: POSTGRES_URL, prefix });
      open.push(store);
      for (const id of ["b", "B", "a", "A", "_x", "Z9"]) {
        await store.put("group", id, {}, null);
      }
      const page = await store.list("group", { limit: 10 });
      expect(page.items.map((doc) => doc.id)).toEqual(
        ["b", "B", "a", "A", "_x", "Z9"].sort(),
      );
    });

    it("refuses options without a connection", () => {
      expect(() => postgresStore({})).toThrow(
        "needs either a url or a connection",
      );
      expect(() =>
        postgresStore({ url: POSTGRES_URL, pollIntervalMs: 0 }),
      ).toThrow("pollIntervalMs");
    });
  });
}
