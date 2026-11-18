/**
 * Canary credentials and request-rule conditions in the control plane
 * (PR-U3, the user's decision of 2026-11-17), the same rule as list
 * entries: a canary's `user`/`apiKey` and a rule's `{ user | apiKey }`
 * condition (`equals` or `in`) are keyed when a draft is saved, the ids
 * typed shown once; a pattern over ids is refused; reads never return a
 * raw id (keyed where they can be, `unkeyed` where they cannot, and always
 * `unkeyed` without a keyring); the engine still matches. Also the draft's
 * discard (`DELETE /policies/:scope/draft`) and a group's effective policy.
 */
import { describe, expect, it } from "bun:test";
import { createSecurity, verifyBundle } from "../../lib/index";
import type { SecurityPolicy } from "../../lib/index";
import { showAuditBody } from "../../lib/control/accountLists";
import { Keyring } from "../../lib/sensitive/keys";
import { DOC_KINDS } from "../../lib/store/index";
import type { SecurityStoreDriver } from "../../lib/store/index";
import { facts } from "../helpers";
import { FLEET_SECRET, testApi } from "./helpers";
import type { TestApi } from "./helpers";

const RAW_USER = "canary-user-5b1d@example.com";
const RAW_KEY = "canary_key_77ab";
const RAW_ADMIN = "rule-admin-91c2";
const keys = new Keyring(FLEET_SECRET);

/** A policy with a canary of each kind and account conditions. */
const POLICY = {
  deception: {
    canaries: [
      { id: "backup-2026-q3", user: RAW_USER },
      { id: "leaked-key", apiKey: RAW_KEY },
    ],
  },
  requestRules: {
    rules: [
      {
        id: "no-admin",
        when: {
          all: [
            { path: { prefix: "/admin" } },
            {
              any: [
                { user: { equals: RAW_ADMIN } },
                { apiKey: { in: [RAW_KEY] } },
              ],
            },
          ],
        },
        action: "block",
      },
    ],
  },
};

/** Whether `text` holds any of the raw ids. */
const holdsRaw = (text: string) =>
  [RAW_USER, RAW_KEY, RAW_ADMIN].some((id) => text.includes(id));

/** An API with service `pay`. */
async function setup(
  options: Parameters<typeof testApi>[0] = {},
): Promise<TestApi> {
  const t = testApi(options);
  expect(
    (await t.call("POST", "/services", { id: "pay", name: "Pay" })).status,
  ).toBe(201);
  return t;
}

/** Saves `policy` as `scope`'s draft. */
async function saveDraft(t: TestApi, scope: string, policy: unknown) {
  const read = await t.call("GET", `/policies/${scope}`);
  return await t.call("PUT", `/policies/${scope}/draft`, {
    policy,
    revision: read.body.draft?.revision ?? null,
  });
}

/** Publishes `scope`'s draft. */
async function publishDraft(t: TestApi, scope: string) {
  const read = await t.call("GET", `/policies/${scope}`);
  return await t.call("POST", `/policies/${scope}/publish`, {
    expectedHead: read.body.head?.id ?? null,
    confirm: scope,
  });
}

/** Every document, version and audit entry of a store, as text. */
async function dump(
  store: SecurityStoreDriver,
  scopes: readonly string[],
): Promise<string> {
  const out: unknown[] = [];
  for (const kind of DOC_KINDS)
    out.push((await store.list(kind, { limit: 1_000 })).items);
  for (const scope of scopes)
    out.push((await store.listVersions(scope, { limit: 1_000 })).items);
  out.push((await store.listAudit({ limit: 1_000 })).items);
  return JSON.stringify(out);
}

/** Every read an operator has of `scope` (and service `pay`). */
async function reads(t: TestApi, scope: string): Promise<string> {
  const policy = (await t.call("GET", `/policies/${scope}`)).body;
  const versions = (
    await t.call("GET", `/policies/${scope}/versions?limit=200`)
  ).body;
  const version =
    policy.head === null
      ? null
      : (await t.call("GET", `/policies/${scope}/versions/${policy.head.id}`))
          .body;
  const diff = (
    await t.call("GET", `/policies/${scope}/diff?from=head&to=draft`)
  ).body;
  const effective = (await t.call("GET", "/services/pay/effective")).body;
  const audit = (await t.call("GET", "/audit?limit=200")).body;
  return JSON.stringify({ policy, versions, version, diff, effective, audit });
}

describe("keyed on a write", () => {
  it("keys every canary and account condition, echoes the ids typed once, and stores no raw id", async () => {
    const t = await setup();
    const saved = await saveDraft(t, "global", POLICY);
    expect(saved.status).toBe(200);
    expect(saved.body.entered).toEqual([
      { section: "canaries", index: 0, user: RAW_USER },
      { section: "canaries", index: 1, apiKey: RAW_KEY },
      {
        section: "requestRules",
        index: 0,
        path: "requestRules.rules[0].when.all[1].any[0]",
        user: RAW_ADMIN,
      },
      {
        section: "requestRules",
        index: 0,
        path: "requestRules.rules[0].when.all[1].any[1]",
        apiKey: RAW_KEY,
      },
    ]);
    const policy = saved.body.policy;
    expect(policy.deception.canaries).toEqual([
      { id: "backup-2026-q3", userHash: keys.user(RAW_USER) },
      { id: "leaked-key", apiKeyHash: keys.apiKey(RAW_KEY) },
    ]);
    expect(policy.requestRules.rules[0].when.all[1].any).toEqual([
      { userHash: { equals: keys.user(RAW_ADMIN) } },
      { apiKeyHash: { in: [keys.apiKey(RAW_KEY)] } },
    ]);
    expect((await publishDraft(t, "global")).status).toBe(200);
    const shown = await reads(t, "global");
    expect(holdsRaw(shown)).toBe(false);
    expect(holdsRaw(await dump(t.store, ["global", "service:pay"]))).toBe(
      false,
    );
    const bundle = (await t.call("GET", "/services/pay/bundle")).body;
    expect(holdsRaw(JSON.stringify(bundle))).toBe(false);
    // The echo is the save's answer alone.
    expect((await t.call("GET", "/policies/global")).body.draft).toBe(null);
  });

  it("negative control: the store scan finds a raw id that is there", async () => {
    const t = await setup();
    await t.store.put(
      "policyDraft",
      "global",
      { policy: POLICY, baseHead: null, updatedBy: "old" },
      null,
    );
    expect(holdsRaw(await dump(t.store, ["global"]))).toBe(true);
  });

  it("refuses a pattern over account ids, a malformed id, a canary naming two accounts, and writes nothing", async () => {
    const t = await setup();
    for (const policy of [
      {
        requestRules: {
          rules: [
            { id: "r", when: { user: { prefix: "adm" } }, action: "block" },
          ],
        },
      },
      {
        requestRules: {
          rules: [
            {
              id: "r",
              when: { apiKey: { equals: "has space" } },
              action: "block",
            },
          ],
        },
      },
      {
        deception: { canaries: [{ id: "c", user: RAW_USER, apiKey: RAW_KEY }] },
      },
    ]) {
      const answer = await saveDraft(t, "global", policy);
      expect([answer.status, answer.body.code]).toEqual([
        400,
        "invalid_request",
      ]);
      expect(JSON.stringify(answer.body)).not.toContain(RAW_USER);
    }
    expect((await t.call("GET", "/policies/global")).body.draft).toBe(null);
  });

  it("takes keys as they are, with nothing to echo", async () => {
    const t = await setup();
    const policy = {
      deception: { canaries: [{ id: "c", userHash: keys.user(RAW_USER) }] },
      requestRules: {
        rules: [
          {
            id: "r",
            when: { apiKeyHash: { equals: keys.apiKey(RAW_KEY) } },
            action: "block",
          },
        ],
      },
    };
    const saved = await saveDraft(t, "global", policy);
    expect(saved.status).toBe(200);
    expect(saved.body.entered).toBeUndefined();
    expect(saved.body.policy).toMatchObject(policy);
  });
});

describe("a keyed canary and condition still match", () => {
  it("end to end: published, compiled into the bundle, enforced by an engine with the fleet's secret", async () => {
    const t = await setup();
    expect((await saveDraft(t, "service:pay", POLICY)).status).toBe(200);
    expect((await publishDraft(t, "service:pay")).status).toBe(200);
    const bundle = (await t.call("GET", "/services/pay/bundle")).body;
    expect(
      verifyBundle(bundle, { sk_test: t.publicKey }, { now: t.clock.now }).ok,
    ).toBe(true);
    const policy = bundle.effective as SecurityPolicy;
    // Each from its own address: a canary bans the address that used it.
    let host = 40;
    const request = (
      path: string,
      identity: { user?: string; apiKey?: string },
    ) => facts({ client: `203.0.113.${host++}`, path, identity });
    const fleet = createSecurity({
      secret: FLEET_SECRET,
      policy,
      logger: () => {},
    });
    const canary = await fleet.evaluate(request("/orders", { user: RAW_USER }));
    expect(canary.hits.map((hit) => hit.rule)).toContain(
      "canary:backup-2026-q3",
    );
    expect(canary.action).not.toBe("allow");
    const ruled = await fleet.evaluate(
      request("/admin/users", { user: RAW_ADMIN }),
    );
    expect(ruled.hits.map((hit) => hit.rule)).toContain("rule:no-admin");
    expect(
      (await fleet.evaluate(request("/admin/users", { user: "someone" })))
        .action,
    ).toBe("allow");
    await fleet.close();
    // The control: an engine under another secret matches none of the keys.
    const other = createSecurity({
      secret: "a-different-fleet-secret-32-bytes!!!",
      policy,
      logger: () => {},
    });
    expect(
      (await other.evaluate(request("/orders", { user: RAW_USER }))).action,
    ).toBe("allow");
    expect(
      (await other.evaluate(request("/admin/users", { user: RAW_ADMIN })))
        .action,
    ).toBe("allow");
    await other.close();
  });
});

describe("rows stored before the keying", () => {
  it("are keyed on every read; a pattern that cannot be keyed is shown unkeyed and still enforced", async () => {
    const t = await setup();
    const legacy = {
      ...POLICY,
      requestRules: {
        rules: [
          ...POLICY.requestRules.rules,
          {
            id: "admins",
            when: { user: { prefix: RAW_ADMIN } },
            action: "block",
          },
        ],
      },
    };
    await t.store.appendVersion(
      "global",
      { id: "pv_old", policy: legacy, createdBy: "old", message: "" },
      null,
    );
    expect(holdsRaw(await dump(t.store, ["global"]))).toBe(true);
    const shown = await reads(t, "global");
    expect(holdsRaw(shown)).toBe(false);
    const version = (await t.call("GET", "/policies/global/versions/pv_old"))
      .body;
    expect(version.policy.deception.canaries[0]).toEqual({
      id: "backup-2026-q3",
      userHash: keys.user(RAW_USER),
    });
    expect(version.policy.requestRules.rules[1].when).toEqual({
      unkeyed: "user",
    });
    // The engines still get what they enforce: the prefix stays in the policy compiled for them.
    const internal = await t.api.plane.effective("pay");
    expect(JSON.stringify(internal.policy)).toContain(RAW_ADMIN);
    const engine = createSecurity({
      secret: FLEET_SECRET,
      policy: internal.policy as SecurityPolicy,
      logger: () => {},
    });
    const hit = await engine.evaluate(
      facts({
        client: "203.0.113.41",
        path: "/x",
        identity: { user: `${RAW_ADMIN}-7` },
      }),
    );
    expect(hit.hits.map((h) => h.rule)).toContain("rule:admins");
    await engine.close();
  });

  it("without a keyring, are shown unkeyed: a raw id never leaves in a read, and a raw id is refused on a write", async () => {
    const t = await setup({ bans: { users: false, apiKeys: false } });
    const legacy = {
      lists: [{ user: RAW_USER, action: "block" }],
      ...POLICY,
    };
    await t.store.appendVersion(
      "global",
      { id: "pv_old", policy: legacy, createdBy: "old", message: "" },
      null,
    );
    await t.store.put(
      "policyDraft",
      "global",
      { policy: legacy, baseHead: "pv_old", updatedBy: "old" },
      null,
    );
    const shown = await reads(t, "global");
    expect(holdsRaw(shown)).toBe(false);
    const version = (await t.call("GET", "/policies/global/versions/pv_old"))
      .body;
    expect(version.policy.lists[0]).toEqual({
      unkeyed: "user",
      action: "block",
    });
    expect(version.policy.deception.canaries).toEqual([
      { id: "backup-2026-q3", unkeyed: "user" },
      { id: "leaked-key", unkeyed: "apiKey" },
    ]);
    const write = await saveDraft(t, "service:pay", {
      deception: { canaries: [{ id: "c", user: "u-1" }] },
    });
    expect(write.status).toBe(400);
  });

  it("an audit entry's diff of canaries and conditions is shown keyed, or unkeyed without a keyring", () => {
    const body = {
      after: {
        diff: [
          {
            path: "deception.canaries[id=c1].user",
            op: "replace",
            before: RAW_USER,
            after: "other-id",
          },
          {
            path: "deception.canaries[id=c2]",
            op: "add",
            after: { id: "c2", apiKey: RAW_KEY },
          },
          {
            path: "requestRules.rules[id=r1].when",
            op: "replace",
            after: { user: { equals: RAW_ADMIN } },
          },
        ],
      },
    };
    const keyed = showAuditBody(body, keys);
    expect(holdsRaw(JSON.stringify(keyed))).toBe(false);
    const changes = (keyed.after as { diff: Record<string, unknown>[] }).diff;
    expect(changes[0]).toMatchObject({
      path: "deception.canaries[id=c1].userHash",
      before: keys.user(RAW_USER),
    });
    expect(changes[1]!.after).toEqual({
      id: "c2",
      apiKeyHash: keys.apiKey(RAW_KEY),
    });
    expect(changes[2]!.after).toEqual({
      userHash: { equals: keys.user(RAW_ADMIN) },
    });
    const keyless = showAuditBody(body, undefined);
    expect(holdsRaw(JSON.stringify(keyless))).toBe(false);
    // The control: the body as written holds them.
    expect(holdsRaw(JSON.stringify(body))).toBe(true);
  });
});

describe("DELETE /policies/:scope/draft", () => {
  it("deletes the draft at its revision, leaves the head, and is audited", async () => {
    const t = await setup();
    expect((await saveDraft(t, "global", { mode: "enforce" })).status).toBe(
      200,
    );
    expect((await publishDraft(t, "global")).status).toBe(200);
    const saved = await saveDraft(t, "global", { mode: "dryRun" });
    const stale = await t.call(
      "DELETE",
      `/policies/global/draft?revision=${saved.body.revision + 1}`,
    );
    expect([stale.status, stale.body.code]).toEqual([409, "conflict"]);
    const gone = await t.call(
      "DELETE",
      `/policies/global/draft?revision=${saved.body.revision}`,
    );
    expect(gone.status).toBe(204);
    const read = (await t.call("GET", "/policies/global")).body;
    expect(read.draft).toBe(null);
    expect(read.head).not.toBe(null);
    expect(
      (await t.call("DELETE", "/policies/global/draft?revision=1")).status,
    ).toBe(404);
    const audit = (await t.call("GET", "/audit?action=policy.draft.discard"))
      .body;
    expect(
      audit.items.filter(
        (entry: { phase: string }) => entry.phase === "intent",
      ),
    ).toHaveLength(1);
  });

  it("needs policy:draft on the scope", async () => {
    const t = await setup();
    const saved = await saveDraft(t, "global", { mode: "enforce" });
    await t.call("POST", "/role-bindings", {
      operator: "vic",
      role: "viewer",
      scope: "global",
    });
    const refused = await t.call(
      "DELETE",
      `/policies/global/draft?revision=${saved.body.revision}`,
      undefined,
      "vic",
    );
    expect(refused.status).toBe(403);
    expect((await t.call("GET", "/policies/global")).body.draft).not.toBe(null);
  });
});

describe("GET /groups/:id/effective", () => {
  it("merges global's and the group's heads, each field with its origin", async () => {
    const t = await setup();
    expect(
      (await t.call("POST", "/groups", { id: "payments", name: "Payments" }))
        .status,
    ).toBe(201);
    await saveDraft(t, "global", {
      lists: [{ country: "KP", action: "drop", locked: true }],
    });
    await publishDraft(t, "global");
    await saveDraft(t, "group:payments", {
      lists: [{ asn: 64501, action: "block" }],
    });
    await publishDraft(t, "group:payments");
    const effective = await t.call("GET", "/groups/payments/effective");
    expect(effective.status).toBe(200);
    expect(effective.body.group).toBe("payments");
    expect(effective.body.policyVersions).toHaveLength(2);
    expect(effective.body.origins["lists[id=country:KP]"]).toBe("global");
    expect(effective.body.origins["lists[id=asn:64501]"]).toBe(
      "group:payments",
    );
    expect((await t.call("GET", "/groups/nope/effective")).status).toBe(404);
    // Someone with no role on the group may not read it.
    expect(
      (await t.call("GET", "/groups/payments/effective", undefined, "nobody"))
        .status,
    ).toBe(403);
  });
});
