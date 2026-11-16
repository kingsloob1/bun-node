/**
 * The ban log over a shared store (lib/engine/banSync.ts), driven by hand:
 * several "processes" (a `BanSync` and a `BanTable` each) over one bun-cache
 * memory backend. Writes and reads in log order, holes held back for their
 * grace then skipped, the snapshot and its election, the reload that adds
 * and removes, a failed read that removes nothing, and a store found
 * emptied refilled from memory.
 */
import { describe, expect, it } from "bun:test";
import { noopLogger } from "@kingsleyweb/bun-common";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { faulty } from "@kingsleyweb/bun-cache/testing";
import type { FaultyDriver } from "@kingsleyweb/bun-cache/testing";
import { BanTable } from "../../lib/engine/bans";
import type { Ban, BanWrite } from "../../lib/engine/bans";
import {
  BanSync,
  COMPACT_EVERY,
  HOLE_GRACE,
  readBan,
  SNAPSHOT_PART,
} from "../../lib/engine/banSync";
import type { SharedStateStore } from "../../lib/engine/shared";
import { cacheStore } from "../../lib/stores/index";
import { fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";
import { quiet } from "./fleet";

/** One process: its table and its log. */
interface Process {
  readonly table: BanTable;
  readonly sync: BanSync;
  readonly store: SharedStateStore;
  /** Writes a ban here and logs it, as the engine does. */
  readonly ban: (write: BanWrite) => Ban;
  /** Lifts a ban here and logs it. */
  readonly lift: (id: string) => void;
  /** The ids held, sorted. */
  readonly ids: () => string[];
}

/** A backend shared by processes on one clock. */
function backend(clock: FakeClock = fakeClock()): {
  driver: FaultyDriver;
  clock: FakeClock;
  process: (keep?: (ban: Ban) => boolean) => Process;
} {
  const driver = faulty(memoryDriver());
  const process = (keep: (ban: Ban) => boolean = () => true): Process => {
    const store = cacheStore(createCache({ driver }), {
      timeout: "2s",
      logger: quiet,
      now: clock.now,
    });
    const table = new BanTable(() => 100_000);
    const sync: BanSync = new BanSync(
      store,
      {
        merge: (ban) => {
          table.merge(ban, clock.now());
        },
        remove: (id) => {
          table.remove(id);
        },
        reconcile: (set, complete) => {
          table.reconcile(set, complete, (id) => sync.pending(id), clock.now());
        },
        keep,
        scope: () => "shared",
        list: () => table.list(clock.now()),
      },
      clock.now,
      noopLogger,
      10_000,
    );
    return {
      table,
      sync,
      store,
      ban: (write) => {
        const ban = table.add(write, clock.now()).ban;
        if (ban === undefined) throw new Error("not written");
        sync.record({ op: "ban", ban });
        return ban;
      },
      lift: (id) => {
        table.lift(id, undefined, clock.now());
        sync.record({ op: "lift", id, at: clock.now() });
      },
      ids: () =>
        table
          .list(clock.now())
          .map((ban) => ban.id)
          .sort(),
    };
  };
  return { driver, clock, process };
}

/** A manual ban of `ip` for an hour. */
function ipBan(ip: string, clock: FakeClock, reason = "test"): BanWrite {
  return {
    subject: { type: "ip", value: ip },
    action: "ban",
    reason,
    source: "manual",
    expiresAt: clock.now() + 3_600_000,
  };
}

describe("the ban log", () => {
  it("carries bans and lifts from one process to another, in order", async () => {
    const { process } = backend();
    const a = process();
    const b = process();
    a.ban(ipBan("203.0.113.1", fakeClock()));
    a.ban(ipBan("203.0.113.2", fakeClock()));
    await a.sync.write();
    await b.sync.read();
    expect(b.ids()).toEqual(["ip:203.0.113.1", "ip:203.0.113.2"]);
    a.lift("ip:203.0.113.1");
    await a.sync.write();
    await b.sync.read();
    expect(b.ids()).toEqual(["ip:203.0.113.2"]);
    // The writer reads its own records back as no change.
    const before = a.table.get("ip:203.0.113.2");
    await a.sync.read();
    expect(a.table.get("ip:203.0.113.2")).toBe(before);
    expect(b.sync.status().cursor).toBe(3);
  });

  it("holds the cursor at a missing record for its grace, then skips it", async () => {
    const { process, clock } = backend();
    const a = process();
    const b = process();
    // A writer took number 1 and never wrote it.
    await a.store.increment("bans:seq", 1, null);
    a.ban(ipBan("203.0.113.3", clock));
    await a.sync.write();
    await b.sync.read();
    expect(b.ids()).toEqual([]);
    expect(b.sync.status().cursor).toBe(0);
    clock.advance(HOLE_GRACE - 1);
    await b.sync.read();
    expect(b.ids()).toEqual([]);
    clock.advance(1);
    await b.sync.read();
    expect(b.ids()).toEqual(["ip:203.0.113.3"]);
    expect(b.sync.status().cursor).toBe(2);
  });

  it("queues writes while the store fails and writes them once it answers", async () => {
    const { process, driver, clock } = backend();
    const a = process();
    const b = process();
    driver.setFaults({ down: true });
    a.ban(ipBan("203.0.113.4", clock));
    await a.sync.write();
    expect(a.sync.status().pending).toBe(1);
    expect(a.sync.pending("ip:203.0.113.4")).toBe(true);
    // Still enforced here.
    expect(a.ids()).toEqual(["ip:203.0.113.4"]);
    driver.setFaults({});
    // The store's circuit opened on the failure; it probes after its cooldown.
    clock.advance(30_000);
    await a.sync.write();
    expect(a.sync.status().pending).toBe(0);
    await b.sync.read();
    expect(b.ids()).toEqual(["ip:203.0.113.4"]);
  });

  it("drops the oldest queued write past the bound, and counts it", async () => {
    const { driver, clock } = backend();
    const store = cacheStore(createCache({ driver }), {
      timeout: "2s",
      logger: quiet,
      now: clock.now,
    });
    const table = new BanTable(() => 100);
    const sync = new BanSync(
      store,
      {
        merge: () => {},
        remove: () => {},
        reconcile: () => {},
        keep: () => true,
        scope: () => "shared",
        list: () => [],
      },
      clock.now,
      noopLogger,
      2,
    );
    driver.setFaults({ down: true });
    for (const ip of ["203.0.113.5", "203.0.113.6", "203.0.113.7"]) {
      const ban = table.add(ipBan(ip, clock), clock.now()).ban;
      if (ban) sync.record({ op: "ban", ban });
    }
    await sync.write();
    expect(sync.status()).toMatchObject({ pending: 2, dropped: 1 });
    expect(sync.pending("ip:203.0.113.5")).toBe(false);
  });
});

describe("the snapshot and the reload", () => {
  it("one process per period writes the snapshot, and a new process loads it with the log after it", async () => {
    const { process, clock } = backend();
    const a = process();
    const b = process();
    const count = SNAPSHOT_PART + 7;
    for (let i = 0; i < count; i++) {
      a.ban(ipBan(`10.${Math.floor(i / 250)}.${i % 250}.1`, clock));
    }
    await a.sync.write();
    await a.sync.reload();
    await b.sync.reload();
    // Both are due; the period's election lets one write.
    const wrote = [await a.sync.compact(), await b.sync.compact()];
    expect(wrote.filter(Boolean)).toHaveLength(1);
    // After the snapshot: one more ban and one lift.
    a.ban(ipBan("198.51.100.1", clock));
    a.lift("ip:10.0.0.1");
    await a.sync.write();
    const c = process();
    await c.sync.reload();
    expect(c.ids()).toEqual(a.ids());
    expect(c.ids()).toHaveLength(count);
    expect(c.sync.status().reconciledAt).toBe(clock.now());
    // Not due again within the period with nothing new.
    expect(await a.sync.compact()).toBe(false);
    clock.advance(COMPACT_EVERY);
    await c.sync.read();
    expect(await c.sync.compact()).toBe(true);
  });

  it("a whole reload removes what the store no longer has: a lift whose record was lost", async () => {
    const { process, clock, driver } = backend();
    const a = process();
    const b = process();
    a.ban(ipBan("203.0.113.8", clock));
    a.ban(ipBan("203.0.113.9", clock));
    await a.sync.write();
    await b.sync.read();
    expect(b.ids()).toHaveLength(2);
    // The lift is written, then its record is lost before b reads it.
    a.lift("ip:203.0.113.8");
    await a.sync.write();
    await a.sync.reload();
    await createCache({ driver })
      .namespace("bun-security")
      .delete("bans:log:3");
    clock.advance(HOLE_GRACE);
    await b.sync.read();
    // Skipped past its grace: b still holds the lifted ban.
    expect(b.ids()).toEqual(["ip:203.0.113.8", "ip:203.0.113.9"]);
    // a's snapshot has the truth; b's reload takes it.
    expect(await a.sync.compact()).toBe(true);
    await b.sync.reload();
    expect(b.ids()).toEqual(["ip:203.0.113.9"]);
  });

  it("writes a snapshot only after a whole reload, from every scope's bans, not this process's table", async () => {
    const { process, clock } = backend();
    const shared = (ban: Ban) => ban.scope !== "service";
    const ownB = (ban: Ban) => ban.scope === "service" && ban.service === "b";
    const x = process(shared);
    const y = process(ownB);
    x.ban(ipBan("203.0.113.60", clock));
    y.ban({
      ...ipBan("203.0.113.61", clock),
      service: "b",
      scope: "service",
    });
    await x.sync.write();
    await y.sync.write();
    await x.sync.read();
    // Never reloaded whole: it does not know the whole set, so writes none.
    expect(await x.sync.compact()).toBe(false);
    await x.sync.reload();
    expect(x.ids()).toEqual(["ip:203.0.113.60"]);
    expect(await x.sync.compact()).toBe(true);
    // A process of service b loads its ban from x's snapshot.
    const z = process(ownB);
    await z.sync.reload();
    expect(z.ids()).toEqual(["ip:203.0.113.61"]);
  });

  it("a reload keeps this process's queued writes, which the store does not have yet", async () => {
    const { process, driver, clock } = backend();
    const a = process();
    a.ban(ipBan("203.0.113.10", clock));
    await a.sync.write();
    driver.setFaults({ failOn: ["increment", "set"] });
    a.ban(ipBan("203.0.113.11", clock));
    await a.sync.write();
    driver.setFaults({});
    clock.advance(30_000);
    await a.sync.reload();
    expect(a.ids()).toEqual(["ip:203.0.113.10", "ip:203.0.113.11"]);
  });

  it("a read the store fails removes nothing; the cache alone would have answered it as a miss", async () => {
    const { process, driver, clock } = backend();
    const a = process();
    for (let i = 0; i < 3; i++) a.ban(ipBan(`203.0.113.${20 + i}`, clock));
    await a.sync.write();
    await a.sync.reload();
    expect(await a.sync.compact()).toBe(true);
    const b = process();
    await b.sync.reload();
    expect(b.ids()).toHaveLength(3);
    driver.setFaults({ failOn: ["get", "getMany"] });
    // The negative control: bun-cache's default policy answers the failed
    // read with a miss, which a naive reload would take for "no bans".
    const raw = createCache({ driver, logger: quiet }).namespace(
      "bun-security",
    );
    expect(await raw.get("bans:snap")).toBeUndefined();
    await expect(b.store.get("bans:snap")).rejects.toThrow();
    await b.sync.reload().catch(() => undefined);
    expect(b.ids()).toHaveLength(3);
  });

  it("a store found emptied is refilled from this process's bans", async () => {
    const { process, driver, clock } = backend();
    const a = process();
    a.ban(ipBan("203.0.113.30", clock));
    a.ban(ipBan("203.0.113.31", clock));
    await a.sync.write();
    await a.sync.read();
    // The backend is flushed: its counter and records are gone.
    await createCache({ driver }).namespace("bun-security").clear();
    await a.sync.read();
    const b = process();
    await b.sync.reload();
    expect(b.ids()).toEqual(["ip:203.0.113.30", "ip:203.0.113.31"]);
  });

  it("records a reader refuses (keep) are not taken: a removed counted rule's bans", async () => {
    const { process, clock } = backend();
    const a = process();
    const b = process((ban) => ban.rule !== "counted:gone");
    a.ban({
      ...ipBan("203.0.113.40", clock),
      source: "auto",
      rule: "counted:gone",
    });
    a.ban({
      ...ipBan("203.0.113.41", clock),
      source: "auto",
      rule: "counted:kept",
    });
    await a.sync.write();
    await b.sync.read();
    expect(b.ids()).toEqual(["ip:203.0.113.41"]);
    await b.sync.reload();
    expect(b.ids()).toEqual(["ip:203.0.113.41"]);
  });
});

describe("readBan: what comes out of the store is checked", () => {
  const good = {
    id: "ip:203.0.113.1",
    subject: { type: "ip", value: "203.0.113.1" },
    action: "ban",
    reason: "r",
    source: "auto",
    createdAt: 1,
    expiresAt: null,
    count: 1,
  };

  it("takes a ban and refuses anything else", () => {
    expect(readBan(good)?.id).toBe("ip:203.0.113.1");
    for (const bad of [
      null,
      "x",
      { ...good, id: "ip:203.0.113.2" },
      { ...good, action: "drop" },
      { ...good, source: "feed" },
      { ...good, count: 0 },
      { ...good, expiresAt: "soon" },
      { ...good, createdAt: Number.NaN },
      { ...good, subject: { type: "", value: "x" }, id: ":x" },
      { ...good, code: 5 },
    ]) {
      expect(readBan(bad)).toBeUndefined();
    }
  });
});
