/**
 * `createSecurityApi` (PR-CP2, control-plane.md §2–§5): its options,
 * authentication and CSRF, services, groups and identities with revisions,
 * drafts and publishing with inheritance and locked items, bundles,
 * dangerous changes (confirmation and two-person approvals), step-up,
 * rollback, the built-in RBAC, the live stream and the documents. Each
 * behaviour has its refusal beside it.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { ConfigError } from "@kingsleyweb/bun-common";
import { createSecurityApi } from "../../lib/control/index";
import { verifyBundle } from "../../lib/index";
import { memoryStore } from "../../lib/store/index";
import { testApi } from "./helpers";

/** A minimal valid option set, without the field under test. */
const base = () => ({
  store: memoryStore(),
  authenticate: () => ({ id: "x" }),
  owners: ["x"],
  allowWithoutStepUp: true,
  bans: { apiKeys: false, users: false },
  signing: { keyId: "k", sign: () => new Uint8Array(64) },
  audit: {
    signing: {
      keyId: "ak",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    },
    allowNoExternalCheckpoints: true,
  },
});

describe("createSecurityApi's options", () => {
  it("refuses a missing authenticate, owners without authorize, no step-up guard, a bad key, a read-only store", () => {
    const { authenticate: _a, ...noAuth } = base();
    expect(() => createSecurityApi(noAuth as never)).toThrow(
      /authenticate is required/,
    );
    expect(() => createSecurityApi({ ...base(), owners: [] })).toThrow(
      /owners must name/,
    );
    // With the host's own authorize, no owners are needed.
    expect(() =>
      createSecurityApi({ ...base(), owners: [], authorize: () => true }),
    ).not.toThrow();
    const { allowWithoutStepUp: _s, ...noGuard } = base();
    expect(() => createSecurityApi(noGuard)).toThrow(/step-up hook/);
    expect(() =>
      createSecurityApi({ ...noGuard, approvals: "two-person" }),
    ).not.toThrow();
    expect(() =>
      createSecurityApi({
        ...base(),
        signing: { keyId: "k", privateKey: "not a key" },
      }),
    ).toThrow(ConfigError);
    expect(() =>
      createSecurityApi({ ...base(), signing: undefined as never }),
    ).toThrow(/signing is required/);
    const readOnly = {
      ...memoryStore(),
      capabilities: { ...memoryStore().capabilities, readOnly: true },
    };
    expect(() => createSecurityApi({ ...base(), store: readOnly })).toThrow(
      /read-only/,
    );
    expect(() => createSecurityApi({ ...base(), basePath: "/" })).toThrow(
      /root/,
    );
  });
});

describe("authentication and CSRF", () => {
  it("answers 401 to nobody, 403 to a mutation without the CSRF header or from another site", async () => {
    const { call } = testApi();
    expect((await call("GET", "/meta", undefined, null)).status).toBe(401);
    expect((await call("GET", "/meta")).body).toMatchObject({
      csrfHeader: "x-bun-security-csrf",
      stepUp: "none",
      breakGlass: false,
    });
    const noHeader = await call(
      "POST",
      "/groups",
      { id: "g", name: "G" },
      "alice",
      { "x-bun-security-csrf": "" },
    );
    // An empty header is still present; a missing one is refused.
    expect(noHeader.status).toBe(201);
    const { call: call2, api } = testApi();
    const response = await (async () => {
      const app = new (await import("@kingsleyweb/bun-common")).BunHttpAdapter(
        0,
        { logger: () => {} },
      );
      app.use(api.basePath, api.router);
      return await app.fetch(`${api.basePath}/groups`, {
        method: "POST",
        headers: { "x-op": "alice", "content-type": "application/json" },
        body: JSON.stringify({ id: "g", name: "G" }),
      });
    })();
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("csrf");
    const crossSite = await call2(
      "POST",
      "/groups",
      { id: "g", name: "G" },
      "alice",
      {
        cookie: "sid=1",
        "sec-fetch-site": "cross-site",
      },
    );
    expect([crossSite.status, crossSite.body.code]).toEqual([403, "csrf"]);
  });
});

describe("services, groups and revisions", () => {
  it("creates, reads and updates by the revision read; a stale write is a 409 with the current document", async () => {
    const { call } = testApi();
    expect(
      (await call("POST", "/groups", { id: "payments", name: "Payments" }))
        .status,
    ).toBe(201);
    const created = await call("POST", "/services", {
      id: "checkout",
      name: "Checkout",
      groups: ["payments"],
    });
    expect(created.body).toMatchObject({
      id: "checkout",
      environment: "production",
      topology: "a",
      revision: 1,
    });
    expect(
      (await call("POST", "/services", { id: "checkout", name: "Again" }))
        .status,
    ).toBe(409);
    const updated = await call("PUT", "/services/checkout", {
      name: "Checkout 2",
      groups: ["payments"],
      revision: 1,
    });
    expect(updated.body.revision).toBe(2);
    const stale = await call("PUT", "/services/checkout", {
      name: "Lost",
      revision: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({
      name: "Checkout 2",
      revision: 2,
    });
    expect(
      (
        await call("POST", "/services", {
          id: "x",
          name: "X",
          groups: ["nope"],
        })
      ).status,
    ).toBe(404);
    expect((await call("DELETE", "/services/checkout?revision=1")).status).toBe(
      409,
    );
    expect((await call("DELETE", "/services/checkout?revision=2")).status).toBe(
      204,
    );
    expect((await call("GET", "/services/checkout")).status).toBe(404);
  });

  it("nests groups at most 4 deep, refuses a cycle, and keeps a group with members", async () => {
    const { call } = testApi();
    await call("POST", "/groups", { id: "a", name: "A" });
    await call("POST", "/groups", { id: "b", name: "B", parent: "a" });
    await call("POST", "/groups", { id: "c", name: "C", parent: "b" });
    await call("POST", "/groups", { id: "d", name: "D", parent: "c" });
    expect(
      (await call("POST", "/groups", { id: "e", name: "E", parent: "d" }))
        .status,
    ).toBe(422);
    const cycle = await call("PUT", "/groups/a", {
      name: "A",
      parent: "c",
      revision: 1,
    });
    expect(cycle.status).toBe(422);
    expect((await call("DELETE", "/groups/c?revision=1")).status).toBe(409);
    expect((await call("DELETE", "/groups/d?revision=1")).status).toBe(204);
  });

  it("lists a page at a time with an opaque cursor", async () => {
    const { call } = testApi();
    for (let i = 0; i < 5; i++)
      await call("POST", "/groups", { id: `g${i}`, name: `G${i}` });
    const first = await call("GET", "/groups?limit=2");
    expect(first.body.items.map((g: { id: string }) => g.id)).toEqual([
      "g0",
      "g1",
    ]);
    const second = await call(
      "GET",
      `/groups?limit=2&cursor=${encodeURIComponent(first.body.next)}`,
    );
    expect(second.body.items.map((g: { id: string }) => g.id)).toEqual([
      "g2",
      "g3",
    ]);
    expect((await call("GET", "/groups?limit=500")).status).toBe(400);
    // A cursor of another list, or a made-up one, is a 400, never read as page one.
    expect(
      (
        await call(
          "GET",
          `/services?cursor=${encodeURIComponent(first.body.next)}`,
        )
      ).status,
    ).toBe(400);
    expect((await call("GET", "/groups?cursor=garbage")).status).toBe(400);
  });
});

describe("drafts, publishing and inheritance", () => {
  /** An API with global, group payments and service checkout in it. */
  async function setUp(options: Parameters<typeof testApi>[0] = {}) {
    const t = testApi(options);
    await t.call("POST", "/groups", { id: "payments", name: "Payments" });
    await t.call("POST", "/services", {
      id: "checkout",
      name: "Checkout",
      groups: ["payments"],
      environment: "staging",
    });
    return t;
  }

  it("saves a draft by revision, publishes it on the expected head, and recompiles the bundles under it", async () => {
    const { call, publicKey } = await setUp();
    const draft = await call("PUT", "/policies/global/draft", {
      policy: { limits: [{ id: "per-ip-x", limit: 100, window: "1m" }] },
      revision: null,
    });
    expect(draft.body).toMatchObject({
      revision: 1,
      baseHead: null,
      updatedBy: "alice",
    });
    expect(
      (
        await call("PUT", "/policies/global/draft", {
          policy: {},
          revision: null,
        })
      ).status,
    ).toBe(409);
    const published = await call("POST", "/policies/global/publish", {
      expectedHead: null,
      message: "first",
    });
    expect(published.status).toBe(200);
    expect(published.body.version).toMatchObject({
      scope: "global",
      number: 1,
      message: "first",
      status: "published",
    });
    expect(published.body.bundles).toEqual([
      { service: "checkout", version: 2 },
    ]);
    // The draft is gone once published; the head moved.
    expect((await call("GET", "/policies/global")).body).toMatchObject({
      draft: null,
      head: { number: 1 },
    });
    // A publish on a stale head is refused.
    await call("PUT", "/policies/global/draft", { policy: {}, revision: null });
    expect(
      (await call("POST", "/policies/global/publish", { expectedHead: null }))
        .status,
    ).toBe(409);
    const bundle = await call("GET", "/services/checkout/bundle");
    const verdict = verifyBundle(bundle.body, { sk_test: publicKey });
    expect(verdict.ok).toBe(true);
    expect(bundle.headers.get("etag")).toBe('"2"');
    expect(
      (
        await call("GET", "/services/checkout/bundle", undefined, "alice", {
          "if-none-match": '"2"',
        })
      ).status,
    ).toBe(304);
  });

  it("merges global ← group ← service, with each field's origin, and refuses an override of a locked item", async () => {
    const { call } = await setUp();
    await call("PUT", "/policies/global/draft", {
      policy: {
        limits: [
          { id: "scanners", limit: 100, window: "1m", locked: true },
          { id: "per-route", limit: 50, window: "1m" },
        ],
        lists: [{ ip: "203.0.113.0/24", action: "block" }],
      },
      revision: null,
    });
    await call("POST", "/policies/global/publish", { expectedHead: null });
    const locked = await call("PUT", "/policies/group:payments/draft", {
      policy: { limits: [{ id: "scanners", mode: "off" }] },
      revision: null,
    });
    expect([locked.status, locked.body.code]).toEqual([422, "locked"]);
    expect(locked.body.detail).toContain("locked by global");
    await call("PUT", "/policies/group:payments/draft", {
      policy: {
        limits: [{ id: "per-route", limit: 10 }],
        lists: [{ ip: "198.51.100.0/24", action: "block" }],
      },
      revision: null,
    });
    await call("POST", "/policies/group:payments/publish", {
      expectedHead: null,
    });
    const effective = (await call("GET", "/services/checkout/effective")).body;
    expect(effective.policy.limits).toEqual([
      { id: "scanners", limit: 100, window: "1m", locked: true },
      { id: "per-route", limit: 10, window: "1m" },
    ]);
    // Lists union, each entry scoped by its layer.
    expect(effective.policy.lists).toEqual([
      { ip: "203.0.113.0/24", action: "block", scope: "global" },
      { ip: "198.51.100.0/24", action: "block", scope: "group" },
    ]);
    expect(effective.origins["limits[id=per-route]"]).toBe("group:payments");
    expect(effective.origins["limits[id=scanners]"]).toBe("global");
    // Each locked item and the scope that locked it (PR-AN2); the unlocked
    // one is not there.
    expect(effective.locked).toEqual({ "limits[id=scanners]": "global" });
    expect(effective.policy.service).toBe("checkout");
    const diff = await call("GET", "/policies/global/diff?from=head&to=head");
    expect(diff.body.changes).toEqual([]);
  });

  it("refuses a draft that does not compile over the scopes above it, naming the issue", async () => {
    const { call } = await setUp();
    const bad = await call("PUT", "/policies/service:checkout/draft", {
      policy: { limits: [{ id: "x", limit: 1, window: 60 }] },
      revision: null,
    });
    expect([bad.status, bad.body.code]).toEqual([422, "invalid_policy"]);
    expect(bad.body.issues[0].path).toEqual(["limits", 0, "window"]);
    expect(
      (
        await call("PUT", "/policies/service:nope/draft", {
          policy: {},
          revision: null,
        })
      ).status,
    ).toBe(404);
    expect((await call("GET", "/policies/planet:x")).status).toBe(400);
  });

  it("rolls back by publishing an older version's content as a new version", async () => {
    const { call } = await setUp();
    await call("PUT", "/policies/global/draft", {
      policy: { mode: "dryRun" },
      revision: null,
    });
    const v1 = (
      await call("POST", "/policies/global/publish", { expectedHead: null })
    ).body.version;
    await call("PUT", "/policies/global/draft", {
      policy: { mode: "enforce" },
      revision: null,
    });
    const v2 = (
      await call("POST", "/policies/global/publish", { expectedHead: v1.id })
    ).body.version;
    const rolled = await call("POST", "/policies/global/rollback", {
      versionId: v1.id,
      expectedHead: v2.id,
    });
    expect(rolled.body.version).toMatchObject({
      number: 3,
      policy: { mode: "dryRun" },
      message: `rollback to ${v1.id}`,
    });
    const versions = (await call("GET", "/policies/global/versions")).body
      .items;
    expect(
      versions.map((v: { number: number; status: string }) => [
        v.number,
        v.status,
      ]),
    ).toEqual([
      [3, "published"],
      [2, "superseded"],
      [1, "superseded"],
    ]);
  });
});

describe("dangerous changes", () => {
  /** A production service under a dry-run global rule. */
  async function setUp(options: Parameters<typeof testApi>[0] = {}) {
    const t = testApi(options);
    await t.call(
      "POST",
      "/services",
      { id: "checkout", name: "Checkout" },
      "alice",
    );
    await t.call(
      "PUT",
      "/policies/global/draft",
      {
        policy: {
          limits: [{ id: "x", limit: 10, window: "1m", mode: "dryRun" }],
        },
        revision: null,
      },
      "alice",
    );
    const head = (
      await t.call(
        "POST",
        "/policies/global/publish",
        { expectedHead: null, confirm: "global" },
        "alice",
      )
    ).body.version.id;
    await t.call(
      "PUT",
      "/policies/global/draft",
      {
        policy: { limits: [{ id: "x", limit: 10, window: "1m" }] },
        revision: null,
      },
      "alice",
    );
    return { ...t, head };
  }

  it("without approvals, needs the scope's name typed to enforce a dry-run rule on production", async () => {
    const { call, head } = await setUp();
    const refused = await call("POST", "/policies/global/publish", {
      expectedHead: head,
    });
    expect([refused.status, refused.body.code]).toEqual([
      428,
      "confirmation_required",
    ]);
    expect(refused.body.dangerous[0]).toContain(
      "service checkout: limits[id=x]: from dry run to enforced",
    );
    expect(
      (
        await call("POST", "/policies/global/publish", {
          expectedHead: head,
          confirm: "global",
        })
      ).status,
    ).toBe(200);
  });

  it("with two-person approvals, opens an approval a second operator approves, never its author", async () => {
    const { call, head } = await setUp({
      approvals: "two-person",
      owners: ["alice", "bob"],
      stepUp: { verify: () => true, challenge: () => "/mfa" },
    });
    const opened = await call("POST", "/policies/global/publish", {
      expectedHead: head,
      message: "enforce x",
    });
    expect(opened.status).toBe(202);
    expect(opened.body).toMatchObject({
      action: "policy.publish",
      status: "pending",
      author: "alice",
    });
    const self = await call(
      "POST",
      `/approvals/${opened.body.id}/approve`,
      { revision: 1 },
      "alice",
    );
    expect([self.status, self.body.code]).toEqual([403, "self_approval"]);
    const approved = await call(
      "POST",
      `/approvals/${opened.body.id}/approve`,
      { revision: 1, reason: "ok" },
      "bob",
    );
    expect(approved.status).toBe(200);
    expect(approved.body.approval).toMatchObject({
      status: "approved",
      decidedBy: "bob",
      reason: "ok",
    });
    expect(approved.body.result.version.number).toBe(2);
    expect(
      (
        await call(
          "POST",
          `/approvals/${opened.body.id}/approve`,
          { revision: 2 },
          "bob",
        )
      ).body.code,
    ).toBe("approval_closed");
  });

  it("an approval expires after 24 hours, and one whose head moved is stale", async () => {
    const { call, head, clock } = await setUp({
      approvals: "two-person",
      owners: ["alice", "bob"],
      stepUp: { verify: () => true, challenge: () => "/mfa" },
    });
    const first = (
      await call("POST", "/policies/global/publish", { expectedHead: head })
    ).body;
    clock.advance(24 * 3_600_000 + 1);
    expect((await call("GET", `/approvals/${first.id}`)).body.status).toBe(
      "expired",
    );
    expect(
      (
        await call(
          "POST",
          `/approvals/${first.id}/approve`,
          { revision: 1 },
          "bob",
        )
      ).status,
    ).toBe(409);
    const second = (
      await call("POST", "/policies/global/publish", { expectedHead: head })
    ).body;
    // Another publish moves the head meanwhile.
    await call("PUT", "/policies/global/draft", {
      policy: { mode: "dryRun" },
      revision: 1,
    });
    await call("POST", "/policies/global/publish", { expectedHead: head });
    const stale = await call(
      "POST",
      `/approvals/${second.id}/approve`,
      { revision: 1 },
      "bob",
    );
    expect(stale.status).toBe(409);
    expect((await call("GET", `/approvals/${second.id}`)).body.status).toBe(
      "stale",
    );
  });

  it("an emergency publishes at once and opens a review a second operator closes", async () => {
    const { call, head } = await setUp({
      approvals: "two-person",
      owners: ["alice", "bob"],
      stepUp: { verify: () => true, challenge: () => "/mfa" },
    });
    const done = await call("POST", "/policies/global/publish", {
      expectedHead: head,
      emergency: true,
    });
    expect(done.status).toBe(200);
    expect(done.body.review).toMatchObject({
      status: "review",
      author: "alice",
    });
    const closed = await call(
      "POST",
      `/approvals/${done.body.review.id}/approve`,
      { revision: 1 },
      "bob",
    );
    expect(closed.body.approval.status).toBe("approved");
    expect(closed.body.result).toBeUndefined();
  });

  it("a change that is not dangerous publishes at once, approvals or not", async () => {
    const t = testApi({
      approvals: "two-person",
      owners: ["alice", "bob"],
      allowWithoutStepUp: undefined,
      stepUp: { verify: () => true, challenge: () => "/mfa" },
    });
    await t.call("POST", "/services", { id: "s", name: "S" });
    await t.call("PUT", "/policies/global/draft", {
      policy: {
        limits: [{ id: "x", limit: 10, window: "1m", mode: "dryRun" }],
      },
      revision: null,
    });
    expect(
      (await t.call("POST", "/policies/global/publish", { expectedHead: null }))
        .status,
    ).toBe(200);
  });
});

describe("step-up", () => {
  it("answers 401 with the host's step-up URL, and goes ahead once the hook says yes", async () => {
    let fresh = false;
    const { call } = testApi({
      allowWithoutStepUp: undefined,
      stepUp: {
        verify: () => fresh,
        challenge: () => "https://idp.example/mfa?return=/security",
      },
    });
    await call("PUT", "/policies/global/draft", { policy: {}, revision: null });
    const asked = await call("POST", "/policies/global/publish", {
      expectedHead: null,
    });
    expect([asked.status, asked.body.code, asked.body.stepUpUrl]).toEqual([
      401,
      "step_up_required",
      "https://idp.example/mfa?return=/security",
    ]);
    fresh = true;
    expect(
      (await call("POST", "/policies/global/publish", { expectedHead: null }))
        .status,
    ).toBe(200);
  });

  it("without a hook, under two-person approvals, a guarded change opens an approval instead", async () => {
    const { call } = testApi({
      allowWithoutStepUp: undefined,
      approvals: "two-person",
      owners: ["alice", "bob"],
    });
    const identity = await call("POST", "/service-identities", {
      id: "pay-api",
      verifier: `sha256:${"a".repeat(64)}`,
    });
    expect([identity.status, identity.body.action]).toEqual([
      202,
      "serviceIdentity.put",
    ]);
    expect((await call("GET", "/service-identities/pay-api")).status).toBe(404);
    await call(
      "POST",
      `/approvals/${identity.body.id}/approve`,
      { revision: 1 },
      "bob",
    );
    expect(
      (await call("GET", "/service-identities/pay-api")).body,
    ).toMatchObject({ id: "pay-api", forwardsClientIp: false });
    const binding = await call("POST", "/role-bindings", {
      operator: "carol",
      role: "viewer",
      scope: "global",
    });
    expect([binding.status, binding.body.action]).toEqual([
      202,
      "roleBinding.create",
    ]);
  });

  it("a service flagged requireStepUp needs one for a draft too", async () => {
    let fresh = false;
    const { call } = testApi({
      allowWithoutStepUp: undefined,
      stepUp: { verify: () => fresh, challenge: () => "/mfa" },
    });
    await call("POST", "/services", {
      id: "pay",
      name: "Pay",
      requireStepUp: true,
    });
    expect(
      (
        await call("PUT", "/policies/service:pay/draft", {
          policy: {},
          revision: null,
        })
      ).status,
    ).toBe(401);
    fresh = true;
    expect(
      (
        await call("PUT", "/policies/service:pay/draft", {
          policy: {},
          revision: null,
        })
      ).status,
    ).toBe(200);
    // Under two-person approvals with no hook, the draft is saved; its
    // publish opens an approval.
    const approvals = testApi({
      allowWithoutStepUp: undefined,
      approvals: "two-person",
      owners: ["alice", "bob"],
    });
    await approvals.call("POST", "/services", {
      id: "pay",
      name: "Pay",
      requireStepUp: true,
    });
    expect(
      (
        await approvals.call("PUT", "/policies/service:pay/draft", {
          policy: {},
          revision: null,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await approvals.call("POST", "/policies/service:pay/publish", {
          expectedHead: null,
        })
      ).status,
    ).toBe(202);
  });
});

describe("service identities", () => {
  it("joins the effective policy of the services it may call, and refuses a token in place of a verifier", async () => {
    const { call } = testApi();
    await call("POST", "/services", { id: "account", name: "Account" });
    await call("POST", "/services", { id: "other", name: "Other" });
    const bad = await call("POST", "/service-identities", {
      id: "pay-api",
      verifier: "the-token-itself",
    });
    expect([bad.status, bad.body.code]).toEqual([422, "invalid_policy"]);
    const made = await call("POST", "/service-identities", {
      id: "pay-api",
      verifier: `sha256:${"b".repeat(64)}`,
      forwardsClientIp: true,
      services: ["account"],
    });
    expect(made.status).toBe(201);
    const account = (await call("GET", "/services/account/effective")).body
      .policy;
    expect(account.serviceIdentity.services).toEqual([
      {
        id: "pay-api",
        verifier: `sha256:${"b".repeat(64)}`,
        forwardsClientIp: true,
        exempt: ["lists", "bans", "countedRules", "globalLimits"],
      },
    ]);
    expect(
      (await call("GET", "/services/other/effective")).body.policy
        .serviceIdentity,
    ).toBeUndefined();
  });
});

describe("the built-in RBAC", () => {
  it("binds roles per scope; a group binding covers its services; /meta/permissions reports them", async () => {
    const { call } = testApi();
    await call("POST", "/groups", { id: "payments", name: "Payments" });
    await call("POST", "/services", {
      id: "checkout",
      name: "Checkout",
      groups: ["payments"],
    });
    await call("POST", "/services", { id: "blog", name: "Blog" });
    expect(
      (await call("GET", "/services/checkout", undefined, "dave")).status,
    ).toBe(403);
    await call("POST", "/role-bindings", {
      operator: "dave",
      role: "operator",
      scope: "group:payments",
    });
    expect(
      (await call("GET", "/services/checkout", undefined, "dave")).status,
    ).toBe(200);
    expect(
      (await call("GET", "/services/blog", undefined, "dave")).status,
    ).toBe(403);
    const permissions = (
      await call(
        "GET",
        "/meta/permissions?scope=service:checkout",
        undefined,
        "dave",
      )
    ).body.permissions;
    expect(permissions).toMatchObject({
      "policy:read": true,
      "policy:draft": true,
      "policy:publish": false,
      "roles:write": false,
    });
    expect(
      (
        await call(
          "PUT",
          "/policies/service:checkout/draft",
          { policy: {}, revision: null },
          "dave",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          "POST",
          "/policies/service:checkout/publish",
          { expectedHead: null },
          "dave",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "POST",
          "/role-bindings",
          { operator: "dave", role: "owner", scope: "global" },
          "dave",
        )
      ).status,
    ).toBe(403);
    const me = (await call("GET", "/operators/me", undefined, "dave")).body;
    expect(me).toMatchObject({
      id: "dave",
      name: "DAVE",
      roles: [{ role: "operator", scope: "group:payments", source: "binding" }],
    });
    expect((await call("GET", "/operators/me")).body.roles).toEqual([
      { role: "owner", scope: "global", source: "owners" },
    ]);
  });

  it("asks the host's own authorize instead, with the permission and the scope", async () => {
    const asked: string[] = [];
    const { call } = testApi({
      owners: [],
      authorize: (operator, permission, target) => {
        asked.push(`${operator.id} ${permission} ${target.scope}`);
        return permission.endsWith(":read");
      },
    });
    expect((await call("GET", "/groups")).status).toBe(200);
    expect((await call("POST", "/groups", { id: "g", name: "G" })).status).toBe(
      403,
    );
    expect(asked).toEqual([
      "alice groups:read global",
      "alice groups:write global",
    ]);
    expect((await call("GET", "/operators/me")).body.roles).toEqual([]);
  });
});

describe("the live stream", () => {
  it("streams policy, bundle and approval events to an operator who may read the scope", async () => {
    const { api, call } = testApi();
    const { BunHttpAdapter } = await import("@kingsleyweb/bun-common");
    const app = new BunHttpAdapter(0, { logger: () => {} });
    app.use(api.basePath, api.router);
    const response = await app.fetch(`${api.basePath}/live`, {
      headers: { "x-op": "alice" },
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    await call("POST", "/services", { id: "s", name: "S" });
    await call("PUT", "/policies/global/draft", { policy: {}, revision: null });
    await call("POST", "/policies/global/publish", { expectedHead: null });
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes("event: policy.published")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    expect(text).toContain("event: bundle.compiled");
    expect(text).toContain("event: policy.published");
  });
});

describe("the documents", () => {
  it("documents every route with its responses, and the live stream as an AsyncAPI channel", async () => {
    const { api, call } = testApi();
    const openapi = (await call("GET", "/openapi.json")).body;
    const paths = Object.keys(openapi.paths);
    for (const path of [
      "/meta",
      "/meta/permissions",
      "/operators/me",
      "/services",
      "/services/{id}",
      "/services/{id}/effective",
      "/services/{id}/bundle",
      "/groups",
      "/groups/{id}",
      "/service-identities",
      "/service-identities/{id}",
      "/policies/{scope}",
      "/policies/{scope}/draft",
      "/policies/{scope}/versions",
      "/policies/{scope}/versions/{id}",
      "/policies/{scope}/diff",
      "/policies/{scope}/publish",
      "/policies/{scope}/rollback",
      "/approvals",
      "/approvals/{id}",
      "/approvals/{id}/approve",
      "/approvals/{id}/reject",
      "/role-bindings",
      "/role-bindings/{id}",
      "/audit",
      "/audit/checkpoints",
      "/audit/verify",
      "/audit/export",
      "/audit/{n}",
      "/live",
    ]) {
      expect(paths).toContain(path);
    }
    // Every operation of every route declares its answers, problems included.
    for (const [path, item] of Object.entries(
      openapi.paths as Record<string, Record<string, any>>,
    )) {
      if (path.endsWith(".json")) continue;
      for (const operation of Object.values(item)) {
        expect(Object.keys(operation.responses)).toContain("401");
      }
    }
    expect(
      openapi.paths["/policies/{scope}/publish"].post.responses,
    ).toHaveProperty("428");
    const asyncapi = api.asyncapi() as { channels: Record<string, unknown> };
    expect(Object.keys(asyncapi.channels).length).toBeGreaterThan(0);
  });
});
