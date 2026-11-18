/**
 * `GET /policies/:scope/draft/effect` (PR-U4F): a scope's draft against each
 * service under it — each service's effective policy as published and with
 * the draft, as their differences. A service's own override hides a draft's
 * change; a draft that breaks a service says so on that service; only the
 * services under the scope; each needs `policy:read` (else skipped); at most
 * the bound's services and changes; account ids never leave raw; nothing is
 * written; it shares the impact estimate's per-operator budget (a `429` with
 * `Retry-After` past it). Each with its negative control.
 */
import { describe, expect, it } from "bun:test";
import { testApi } from "./helpers";
import type { TestApi } from "./helpers";

/** Saves `policy` as `scope`'s draft. */
async function saveDraft(t: TestApi, scope: string, policy: unknown) {
  const read = await t.call("GET", `/policies/${scope}`);
  const saved = await t.call("PUT", `/policies/${scope}/draft`, {
    policy,
    revision: read.body.draft?.revision ?? null,
  });
  expect(saved.status).toBe(200);
}

/** Publishes `scope`'s draft. */
async function publish(t: TestApi, scope: string) {
  const read = await t.call("GET", `/policies/${scope}`);
  const published = await t.call("POST", `/policies/${scope}/publish`, {
    expectedHead: read.body.head?.id ?? null,
    confirm: scope,
  });
  expect(published.status).toBe(200);
}

/** A control plane with group `payments` holding `pay` and `cards`, and `blog` outside it. */
async function setUp(options: Parameters<typeof testApi>[0] = {}) {
  const t = testApi(options);
  await t.call("POST", "/groups", { id: "payments", name: "Payments" });
  for (const [id, groups] of [
    ["pay", ["payments"]],
    ["cards", ["payments"]],
    ["blog", []],
  ] as const)
    await t.call("POST", "/services", { id, name: id, groups });
  await saveDraft(t, "global", {
    limits: [{ id: "per-ip", limit: 100, window: "1m" }],
  });
  await publish(t, "global");
  // `cards` overrides the limit itself.
  await saveDraft(t, "service:cards", { limits: [{ id: "per-ip", limit: 7 }] });
  await publish(t, "service:cards");
  return t;
}

describe("GET /policies/:scope/draft/effect", () => {
  it("shows each service's effective change; a service's own override hides it", async () => {
    const t = await setUp();
    await saveDraft(t, "global", {
      limits: [{ id: "per-ip", limit: 50, window: "1m" }],
    });
    const effect = await t.call("GET", "/policies/global/draft/effect");
    expect(effect.status).toBe(200);
    expect(effect.body).toEqual({
      scope: "global",
      services: [
        {
          service: "blog",
          changes: [
            { path: "limits[id=per-ip].limit", before: 100, after: 50 },
          ],
          more: 0,
        },
        { service: "cards", changes: [], more: 0 },
        {
          service: "pay",
          changes: [
            { path: "limits[id=per-ip].limit", before: 100, after: 50 },
          ],
          more: 0,
        },
      ],
      skipped: [],
      notCompared: 0,
    });
  });

  it("compares only the services under the scope", async () => {
    const t = await setUp();
    await saveDraft(t, "group:payments", { mode: "dryRun" });
    const effect = (
      await t.call("GET", "/policies/group:payments/draft/effect")
    ).body;
    expect(effect.services.map((s: { service: string }) => s.service)).toEqual([
      "cards",
      "pay",
    ]);
    expect(effect.services[1].changes).toEqual([
      { path: "mode", after: "dryRun" },
    ]);
  });

  it("names a service the draft breaks, and still compares the others", async () => {
    const t = await setUp();
    // Locked at global, then overridden by `cards`: a draft locking it breaks `cards`.
    await saveDraft(t, "global", {
      limits: [{ id: "per-ip", limit: 100, window: "1m", locked: true }],
    });
    const effect = (await t.call("GET", "/policies/global/draft/effect")).body;
    const cards = effect.services.find(
      (s: { service: string }) => s.service === "cards",
    );
    expect(cards.changes).toEqual([]);
    expect(cards.error).toContain("locked by global");
    const pay = effect.services.find(
      (s: { service: string }) => s.service === "pay",
    );
    expect(pay.changes).toEqual([
      { path: "limits[id=per-ip].locked", after: true },
    ]);
  });

  it("skips a service the operator may not read; a 403 without policy:read on the scope", async () => {
    const t = await setUp({
      owners: [],
      // Everything but reading service pay's policy.
      authorize: (_operator, permission, target) =>
        !(permission === "policy:read" && target.scope === "service:pay"),
    });
    await saveDraft(t, "global", { mode: "dryRun" });
    const effect = (await t.call("GET", "/policies/global/draft/effect")).body;
    expect(effect.skipped).toEqual([
      { service: "pay", reason: "no policy:read on it" },
    ]);
    expect(effect.services.map((s: { service: string }) => s.service)).toEqual([
      "blog",
      "cards",
    ]);
    const denied = testApi({ owners: [], authorize: () => false });
    expect(
      (await denied.call("GET", "/policies/global/draft/effect")).status,
    ).toBe(403);
  });

  it("404s without a draft", async () => {
    const t = await setUp();
    expect(
      (await t.call("GET", "/policies/group:payments/draft/effect")).status,
    ).toBe(404);
  });

  it("is bounded: past the services' bound they are counted, past the changes' the rest are", async () => {
    const t = await setUp();
    const { draftEffect } = await import("../../lib/control/draftEffect");
    await saveDraft(t, "global", {
      limits: [{ id: "per-ip", limit: 50, window: "1m" }],
      mode: "dryRun",
    });
    const operator = { id: "alice" };
    const bounded = await draftEffect(t.api.plane, "global", operator, {
      maxServices: 1,
      maxChanges: 1,
    });
    expect(bounded.services.map((s) => s.service)).toEqual(["blog"]);
    expect(bounded.notCompared).toBe(2);
    expect(bounded.services[0]).toMatchObject({ more: 1 });
    expect(bounded.services[0].changes).toHaveLength(1);
  });

  it("never shows a raw account id, and writes nothing", async () => {
    const t = await setUp({ bans: { users: false, apiKeys: false } });
    const RAW = "raw-user-4d2e@example.com";
    // A legacy draft row holding a raw account id (as before the keying).
    await t.store.put(
      "policyDraft",
      "global",
      {
        policy: {
          limits: [{ id: "per-ip", limit: 100, window: "1m" }],
          lists: [{ user: RAW, action: "block" }],
        },
        baseHead: null,
        updatedBy: "old",
      },
      null,
    );
    const before = JSON.stringify(await t.store.listAudit({ limit: 1_000 }));
    const effect = await t.call("GET", "/policies/global/draft/effect");
    expect(effect.status).toBe(200);
    expect(JSON.stringify(effect.body)).not.toContain(RAW);
    // Negative control: the draft does hold it.
    expect(
      JSON.stringify(await t.store.get("policyDraft", "global")),
    ).toContain(RAW);
    expect(JSON.stringify(await t.store.listAudit({ limit: 1_000 }))).toBe(
      before,
    );
  });

  it("past 6 a minute an operator, answers 429 with Retry-After; the next minute it answers again", async () => {
    const t = await setUp({ owners: ["alice", "bob"] });
    await saveDraft(t, "global", { mode: "dryRun" });
    for (let i = 0; i < 6; i++)
      expect(
        (await t.call("GET", "/policies/global/draft/effect")).status,
      ).toBe(200);
    const over = await t.call("GET", "/policies/global/draft/effect");
    expect([over.status, over.body.code]).toEqual([429, "rate_limited"]);
    const retry = Number(over.headers.get("retry-after"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    // Another operator has a budget of their own.
    expect(
      (await t.call("GET", "/policies/global/draft/effect", undefined, "bob"))
        .status,
    ).toBe(200);
    t.clock.advance(60_000);
    expect((await t.call("GET", "/policies/global/draft/effect")).status).toBe(
      200,
    );
  });

  it("shares the budget with the impact estimate", async () => {
    const t = await setUp();
    await saveDraft(t, "global", { mode: "dryRun" });
    for (let i = 0; i < 3; i++) {
      expect(
        (await t.call("GET", "/policies/global/draft/effect")).status,
      ).toBe(200);
      expect((await t.call("POST", "/policies/global/impact", {})).status).toBe(
        200,
      );
    }
    const impact = await t.call("POST", "/policies/global/impact", {});
    expect([impact.status, impact.headers.has("retry-after")]).toEqual([
      429,
      true,
    ]);
    const effect = await t.call("GET", "/policies/global/draft/effect");
    expect(effect.status).toBe(429);
  });

  it("is in the OpenAPI document", async () => {
    const t = testApi();
    const doc = (await t.call("GET", "/openapi.json")).body;
    expect(
      doc.paths["/policies/{scope}/draft/effect"].get.responses["200"],
    ).toBeDefined();
  });
});
