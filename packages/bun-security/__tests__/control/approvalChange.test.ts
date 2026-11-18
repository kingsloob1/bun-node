/**
 * An approval's policy change, for the approvals screen (PR-U5, ui.md §8;
 * the user's decision of 2026-11-18): `GET /approvals/:id/diff` (the
 * policy the approval would publish against the head it expects, shown as
 * a scope's diff is) and `POST /approvals/:id/impact` (that policy's
 * impact estimate). Both read the approval's own copy, never the scope's
 * draft, which may have moved on; both need `policy:read` on the scope
 * beside `approvals:read` (the estimate also `rules:test`); an approval
 * that changes no policy answers `404`. And a bulk lift's approval is
 * decided on `bans:write`, the permission the lift itself needs
 * (kingsloob1/bun-node#859).
 */
import type { SecurityApiPermission } from "../../lib/control/contract/index";
import type { SecurityEvent } from "../../lib/store/index";
import { describe, expect, it } from "bun:test";
import { testApi } from "./helpers";

/** Permissions each test operator lacks; anyone else may do anything. */
const LACKS: Record<string, readonly SecurityApiPermission[]> = {
  carol: ["policy:read"],
  dave: ["identities:write"],
  erin: ["bans:write"],
  frank: ["rules:test"],
};

/** Two-person approvals with no step-up hook (every guarded change opens one), a group and two services. */
async function setup() {
  const t = testApi({
    allowWithoutStepUp: undefined,
    approvals: "two-person",
    owners: [],
    authorize: (operator, permission) =>
      !(LACKS[operator.id] ?? []).includes(permission),
  });
  await t.call("POST", "/groups", { id: "payments", name: "Payments" });
  await t.call("POST", "/services", {
    id: "pay",
    name: "Pay",
    groups: ["payments"],
  });
  return t;
}

/** Saves `policy` as the group's draft. */
async function draft(t: Awaited<ReturnType<typeof setup>>, policy: unknown) {
  const head = await t.call("GET", "/policies/group:payments");
  const saved = await t.call("PUT", "/policies/group:payments/draft", {
    policy,
    revision: head.body?.draft?.revision ?? null,
  });
  expect(saved.status).toBeLessThan(300);
}

/** Opens a publish approval of the group's draft. */
async function openPublish(t: Awaited<ReturnType<typeof setup>>) {
  const opened = await t.call("POST", "/policies/group:payments/publish", {
    expectedHead: null,
    message: "block a scanner",
  });
  expect(opened.status).toBe(202);
  return opened.body.id as string;
}

/** `count` allowed events of service pay from 203.0.113.5, five minutes ago. */
function events(t: Awaited<ReturnType<typeof setup>>, count: number) {
  return Array.from({ length: count }, (_, i): SecurityEvent => ({
    id: `ev${i}`,
    at: t.clock.now() - 5 * 60_000,
    service: "pay",
    action: "allow",
    route: "GET /orders",
    subjects: { ip: "203.0.113.5" },
    sample: { method: "GET", path: "/orders", headers: {} },
  }));
}

describe("GET /approvals/:id/diff", () => {
  it("is the approval's own change, not the draft's after it moved on", async () => {
    const t = await setup();
    await draft(t, {
      lists: [{ id: "bad", ip: "203.0.113.5", action: "block" }],
    });
    const id = await openPublish(t);
    const pinned = await t.call(
      "GET",
      `/approvals/${id}/diff`,
      undefined,
      "bob",
    );
    expect(pinned.status).toBe(200);
    expect(pinned.body.from).toBe("none");
    expect(pinned.body.to).toBe(`approval:${id}`);
    // The same changes the scope's own diff showed when the approval opened.
    const scoped = await t.call("GET", "/policies/group:payments/diff");
    expect(pinned.body.changes).toEqual(scoped.body.changes);
    expect(JSON.stringify(pinned.body.changes)).toContain("203.0.113.5");
    // The draft moves on: the approval's diff does not.
    await draft(t, {
      lists: [{ id: "other", ip: "198.51.100.1", action: "block" }],
    });
    const after = await t.call(
      "GET",
      `/approvals/${id}/diff`,
      undefined,
      "bob",
    );
    expect(after.body.changes).toEqual(pinned.body.changes);
    // The control: the scope's diff did move.
    const moved = await t.call("GET", "/policies/group:payments/diff");
    expect(JSON.stringify(moved.body.changes)).toContain("198.51.100.1");
    expect(JSON.stringify(after.body.changes)).not.toContain("198.51.100.1");
  });

  it("names the head it expects; needs policy:read; 404 for an approval that changes no policy", async () => {
    const t = await setup();
    await draft(t, { lists: [{ id: "a", ip: "192.0.2.1", action: "block" }] });
    const first = await openPublish(t);
    const approved = await t.call(
      "POST",
      `/approvals/${first}/approve`,
      { revision: 1 },
      "bob",
    );
    expect(approved.status).toBe(200);
    const head = (await t.call("GET", "/policies/group:payments")).body.head.id;
    await draft(t, { lists: [{ id: "a", ip: "192.0.2.2", action: "block" }] });
    const opened = await t.call("POST", "/policies/group:payments/publish", {
      expectedHead: head,
    });
    const diff = await t.call(
      "GET",
      `/approvals/${opened.body.id}/diff`,
      undefined,
      "bob",
    );
    expect(diff.body.from).toBe(head);
    expect(diff.body.changes).toEqual([
      expect.objectContaining({ path: expect.stringContaining("lists") }),
    ]);
    const refused = await t.call(
      "GET",
      `/approvals/${opened.body.id}/diff`,
      undefined,
      "carol",
    );
    expect([refused.status, refused.body.code]).toEqual([403, "forbidden"]);
    // A bulk lift's approval changes no policy.
    await t.call("POST", "/bans", { ip: "192.0.2.9", reason: "r" });
    const lift = await t.call("POST", "/bans/lift", {});
    expect(lift.status).toBe(202);
    const none = await t.call(
      "GET",
      `/approvals/${lift.body.id}/diff`,
      undefined,
      "bob",
    );
    expect(none.status).toBe(404);
    const noImpact = await t.call(
      "POST",
      `/approvals/${lift.body.id}/impact`,
      {},
      "bob",
    );
    expect(noImpact.status).toBe(404);
    expect((await t.call("GET", "/approvals/nope/diff")).status).toBe(404);
  });
});

describe("POST /approvals/:id/impact", () => {
  it("estimates the approval's policy, not the draft's; needs rules:test and policy:read", async () => {
    const t = await setup();
    await t.store.appendEvents!("b1", events(t, 12));
    await draft(t, {
      lists: [{ id: "bad", ip: "203.0.113.5", action: "block" }],
    });
    const id = await openPublish(t);
    // The draft moves on to something that blocks nobody.
    await draft(t, {
      lists: [{ id: "bad", ip: "198.51.100.1", action: "block" }],
    });
    const impact = await t.call("POST", `/approvals/${id}/impact`, {}, "bob");
    expect(impact.status).toBe(200);
    expect(impact.body.transitions).toEqual([
      { from: "allow", to: "refuse", count: 12 },
    ]);
    // The control: the draft's own estimate sees no change.
    const drafted = await t.call(
      "POST",
      "/policies/group:payments/impact",
      {},
      "bob",
    );
    expect(drafted.body.transitions).toEqual([]);
    for (const who of ["carol", "frank"]) {
      const refused = await t.call("POST", `/approvals/${id}/impact`, {}, who);
      expect([who, refused.status]).toEqual([who, 403]);
    }
  });
});

describe("a bulk lift's approval", () => {
  it("is decided on bans:write, not identities:write", async () => {
    const t = await setup();
    await t.call("POST", "/bans", { ip: "192.0.2.9", reason: "r" });
    const opened = await t.call("POST", "/bans/lift", {});
    expect(opened.status).toBe(202);
    // The control: without bans:write, refused.
    const refused = await t.call(
      "POST",
      `/approvals/${opened.body.id}/approve`,
      { revision: opened.body.revision },
      "erin",
    );
    expect(refused.status).toBe(403);
    // Without identities:write, but with bans:write: decided.
    const decided = await t.call(
      "POST",
      `/approvals/${opened.body.id}/approve`,
      { revision: opened.body.revision },
      "dave",
    );
    expect(decided.status).toBe(200);
    expect(decided.body.approval.status).toBe("approved");
  });
});

describe("the document", () => {
  it("documents both routes with their answers and problems", async () => {
    const t = await setup();
    const openapi = (await t.call("GET", "/openapi.json")).body;
    const diff = openapi.paths["/approvals/{id}/diff"]?.get;
    const impact = openapi.paths["/approvals/{id}/impact"]?.post;
    for (const operation of [diff, impact]) {
      expect(operation.tags).toEqual(["approvals"]);
      expect(Object.keys(operation.responses)).toEqual(
        expect.arrayContaining(["200", "401", "403", "404"]),
      );
    }
    expect(Object.keys(impact.responses)).toEqual(
      expect.arrayContaining(["400", "429"]),
    );
    expect(impact.requestBody).toBeDefined();
    // The control: the scope's own routes are documented the same way.
    expect(
      openapi.paths["/policies/{scope}/diff"].get.responses,
    ).toHaveProperty("200");
  });
});
