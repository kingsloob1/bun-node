/**
 * Two control-plane instances on one store (T1's findings, in-process):
 *
 * - #846: the audit log appends at the head inside the store's serialised
 *   transaction (`appendAuditAtHead`), so two instances writing at once
 *   never refuse a change for a lost race on the chain's head. The control
 *   puts the old path back (the head read outside the lock, then a
 *   compare-and-set) and sees refusals.
 * - #847: a publish cut off between appending its version and writing its
 *   bundles is repaired by the bundle repair pass: once, by one instance,
 *   audited as a system action, and not while the publish may still be
 *   compiling.
 */
import { describe, expect, it } from "bun:test";
import { memoryStore } from "../../lib/store/index";
import type {
  AuditHead,
  AuditInput,
  SecurityStoreDriver,
} from "../../lib/store/index";
import { faultyStore } from "../../lib/testing/index";
import { fakeClock } from "../helpers";
import { testApi } from "./helpers";

/**
 * `store` with `appendAuditAtHead` done the old way (#846's cause): the
 * head read on its own, then a compare-and-set that another writer can win.
 */
function headReadOutsideTheLock(
  store: SecurityStoreDriver,
): SecurityStoreDriver {
  return Object.freeze({
    ...store,
    appendAuditAtHead: async (make: (head: AuditHead | null) => AuditInput) => {
      const head = await store.getAuditHead();
      const entry = make(head);
      const result = await store.appendAudit(entry, head?.hash ?? null);
      if (!result.ok) throw new Error("the audit head moved");
      return { n: result.n, seq: result.seq, entry };
    },
  });
}

/** Twelve bans at once over two instances of one store; the statuses. */
async function race(store: SecurityStoreDriver): Promise<number[]> {
  const a = testApi({ store, bundleRepair: false });
  const b = testApi({ store, bundleRepair: false });
  const answers = await Promise.all(
    Array.from({ length: 12 }, async (_, i) =>
      (i % 2 === 0 ? a : b).call("POST", "/bans", {
        ip: `192.0.2.${i + 1}`,
        reason: "race",
        duration: "1h",
      }),
    ),
  );
  const verify = await a.api.verifyAudit();
  expect(verify.problems).toEqual([]);
  return answers.map((answer) => answer.status);
}

describe("two instances writing at once (#846)", () => {
  it("every change lands, each with its intent and its done, in one chain", async () => {
    // A store a few milliseconds away, as a database on the network is.
    const store = faultyStore(memoryStore(), { delayMs: 3 });
    expect(await race(store)).toEqual(Array.from({ length: 12 }, () => 201));
    const verify = await testApi({
      store,
      bundleRepair: false,
    }).api.verifyAudit();
    expect(verify.ok).toBe(true);
    expect(verify.unconfirmed).toEqual([]);
  });

  it("the control: with the head read outside the lock, changes are refused", async () => {
    const store = headReadOutsideTheLock(
      faultyStore(memoryStore(), { delayMs: 3 }),
    );
    const statuses = await race(store);
    expect(statuses).toContain(503);
    expect(statuses.every((status) => status === 201 || status === 503)).toBe(
      true,
    );
  });
});

describe("the bundle repair pass (#847)", () => {
  /** Two instances on one store; `putBundle` fails while `cutOff` is set. */
  async function cutOffPublish() {
    const clock = fakeClock();
    const state = { cutOff: false };
    const store = faultyStore(memoryStore({ now: clock.now }), {
      fail: (operation) =>
        state.cutOff && operation === "putBundle"
          ? new Error("the instance died")
          : undefined,
    });
    // Every clock starts at the same time (fakeClock's start).
    const a = testApi({ store, bundleRepair: false });
    const b = testApi({ store, bundleRepair: false });
    await a.call("POST", "/services", { id: "checkout", name: "Checkout" });
    await a.call("PUT", "/policies/global/draft", {
      policy: {},
      revision: null,
    });
    await a.call("POST", "/policies/global/publish", { expectedHead: null });
    const head = (await a.call("GET", "/policies/global")).body.head.id;
    await a.call("PUT", "/policies/global/draft", {
      policy: { lists: [{ ip: "198.51.100.77", action: "block" }] },
      revision: null,
    });
    state.cutOff = true;
    const cut = await a.call("POST", "/policies/global/publish", {
      expectedHead: head,
    });
    state.cutOff = false;
    const newHead = (await a.call("GET", "/policies/global")).body.head
      .id as string;
    const bundleVersions = async () =>
      (await b.call("GET", "/services/checkout/bundle")).body
        .policyVersions as string[];
    return { a, b, clock, cut, head, newHead, bundleVersions, store };
  }

  it("a publish cut off before its bundles leaves them behind (the control), and the pass catches them up once, audited", async () => {
    const t = await cutOffPublish();
    expect(t.cut.status).toBe(500);
    expect(t.newHead).not.toBe(t.head);
    // Behind the head: nothing else repairs it.
    expect(await t.bundleVersions()).not.toContain(t.newHead);
    // Within the grace a publish may still be compiling: left alone.
    expect(await t.b.api.repairBundles()).toEqual([]);
    for (const api of [t.a, t.b]) api.clock.advance(31_000);
    // Both instances at once: one repairs it, the other's claim is refused.
    const [one, two] = await Promise.all([
      t.a.api.repairBundles(),
      t.b.api.repairBundles(),
    ]);
    expect([...one, ...two]).toHaveLength(1);
    expect(await t.bundleVersions()).toContain(t.newHead);
    // Caught up: the next pass has nothing to do.
    expect(await t.a.api.repairBundles()).toEqual([]);
    // Audited as a system action, intent and done.
    const entries = (
      await t.a.call("GET", "/audit?action=bundle.repair&limit=10")
    ).body.items as { phase: string; actor: string }[];
    expect(entries.map((entry) => entry.phase).sort()).toEqual([
      "done",
      "intent",
    ]);
    expect(entries.map((entry) => entry.actor)).toEqual(["system", "system"]);
  });

  it("a bundle already at its heads is never recompiled", async () => {
    const t = testApi({ bundleRepair: false });
    await t.call("POST", "/services", { id: "checkout", name: "Checkout" });
    await t.call("PUT", "/policies/global/draft", {
      policy: {},
      revision: null,
    });
    await t.call("POST", "/policies/global/publish", { expectedHead: null });
    const before = (await t.call("GET", "/services/checkout/bundle")).body
      .version;
    t.clock.advance(120_000);
    expect(await t.api.repairBundles()).toEqual([]);
    expect(
      (await t.call("GET", "/services/checkout/bundle")).body.version,
    ).toBe(before);
  });

  it("refuses a bundleRepair interval out of range, and false turns the pass off", () => {
    expect(() => testApi({ bundleRepair: { interval: "10ms" } })).toThrow(
      /bundleRepair.interval/,
    );
    expect(() => testApi({ bundleRepair: { interval: "2h" } })).toThrow(
      /bundleRepair.interval/,
    );
    const off = testApi({ bundleRepair: false });
    off.api.close();
    const on = testApi({ bundleRepair: { interval: "5s" } });
    on.api.close();
  });
});
