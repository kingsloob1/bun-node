/**
 * Account list entries in the control plane (PR-U3, the user's decision of
 * 2026-11-17): a draft's `lists[].user` and `lists[].apiKey` are keyed with
 * the fleet's secret (`bans.secret`) into `userHash` and `apiKeyHash`
 * before anything is written, so no store row, audit entry, version,
 * bundle, live event, log or answer holds the id, the save answer's
 * `entered` alone excepted. A keyed entry still blocks, end to end. Rows
 * stored before this change are keyed on read. Each with its control.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { createLogger } from "@kingsleyweb/bun-common";
import type { LogEvent } from "@kingsleyweb/bun-common";
import { createSecurity, verifyBundle } from "../../lib/index";
import type { SecurityPolicy } from "../../lib/index";
import { diffPolicies } from "../../lib/control/merge";
import type { SecurityLiveEventDto } from "../../lib/control/contract/index";
import { Keyring } from "../../lib/sensitive/keys";
import { DOC_KINDS, memoryStore, sqliteStore } from "../../lib/store/index";
import type { SecurityStoreDriver } from "../../lib/store/index";
import { facts } from "../helpers";
import { FLEET_SECRET, testApi } from "./helpers";
import type { TestApi } from "./helpers";

const RAW_USER = "raw-user-7f3a@example.com";
const RAW_KEY = "key_raw_9c1e44";
const keys = new Keyring(FLEET_SECRET);
const USER_KEY = keys.user(RAW_USER);
const API_KEY_KEY = keys.apiKey(RAW_KEY);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory, removed after the file. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-security-lists-"));
  dirs.push(dir);
  return dir;
}

/** The draft with both account kinds and an address. */
const DRAFT = {
  lists: [
    { user: RAW_USER, action: "block" },
    { ip: "198.51.100.7", action: "block" },
    { apiKey: RAW_KEY, action: "block", reason: "leaked" },
  ],
};

/** An API with service `pay`; its live events and logs collected. */
async function setup(
  options: Parameters<typeof testApi>[0] = {},
): Promise<TestApi & { live: SecurityLiveEventDto[]; logs: LogEvent[] }> {
  const logs: LogEvent[] = [];
  const t = testApi({
    logger: createLogger({ level: "trace", sink: (event) => logs.push(event) }),
    ...options,
  });
  const live: SecurityLiveEventDto[] = [];
  t.api.plane.listen((event) => live.push(event));
  expect(
    (await t.call("POST", "/services", { id: "pay", name: "Pay" })).status,
  ).toBe(201);
  return { ...t, live, logs };
}

/** Saves `policy` as `scope`'s draft; the answer. */
async function saveDraft(t: TestApi, scope: string, policy: unknown) {
  const read = await t.call("GET", `/policies/${scope}`);
  return await t.call("PUT", `/policies/${scope}/draft`, {
    policy,
    revision: read.body?.draft?.revision ?? null,
  });
}

/** Publishes `scope`'s draft; the answer. */
async function publishDraft(t: TestApi, scope: string) {
  const read = await t.call("GET", `/policies/${scope}`);
  return await t.call("POST", `/policies/${scope}/publish`, {
    expectedHead: read.body.head?.id ?? null,
    confirm: scope,
  });
}

/** Every page of `GET path`'s items. */
async function allPages(t: TestApi, path: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor: string | undefined;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const page = await t.call(
      "GET",
      `${path}${sep}limit=200${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    expect(page.status).toBe(200);
    out.push(...page.body.items);
    cursor = page.body.next;
  } while (cursor !== undefined);
  return out;
}

/** Everything a store holds that the control plane writes, as one string. */
async function dump(store: SecurityStoreDriver): Promise<string> {
  const out: unknown[] = [];
  const scopes = new Set<string>();
  const services: string[] = [];
  for (const kind of DOC_KINDS) {
    let cursor: string | undefined;
    do {
      const page = await store.list(kind, {
        limit: 1_000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      out.push(page.items);
      for (const doc of page.items) {
        if (kind === "policy" || kind === "policyDraft") scopes.add(doc.id);
        if (kind === "service") services.push(doc.id);
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }
  for (const scope of scopes)
    out.push(await store.listVersions(scope, { limit: 1_000 }));
  for (const service of services) out.push(await store.getBundle(service));
  let cursor: string | undefined;
  do {
    const page = await store.listAudit({
      limit: 1_000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    out.push(page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  for (let seq = 0n; ;) {
    const feed = await store.changesSince(seq, 1_000);
    out.push(feed.changes);
    const last = feed.changes.at(-1);
    if (last === undefined) break;
    seq = last.seq;
  }
  return JSON.stringify(out, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/** A SQLite file's bytes, its write-ahead log's included, as text. */
function fileText(path: string): string {
  return [path, `${path}-wal`]
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file).toString("latin1"))
    .join("\n");
}

/** Whether `text` names either raw id. */
const holdsRaw = (text: string) =>
  text.includes(RAW_USER) || text.includes(RAW_KEY);

/** Saves DRAFT, publishes it, and reads back everything a policy reader sees. */
async function saveAndReadBack(t: Awaited<ReturnType<typeof setup>>) {
  const saved = await saveDraft(t, "global", DRAFT);
  expect(saved.status).toBe(200);
  const draftRead = await t.call("GET", "/policies/global");
  const diff = await t.call("GET", "/policies/global/diff?from=head&to=draft");
  const published = await publishDraft(t, "global");
  expect(published.status).toBe(200);
  const versionId = published.body.version.id as string;
  const reads = {
    draftRead: draftRead.body,
    diff: diff.body,
    published: published.body,
    head: (await t.call("GET", "/policies/global")).body,
    versions: await allPages(t, "/policies/global/versions"),
    version: (await t.call("GET", `/policies/global/versions/${versionId}`))
      .body,
    effective: (await t.call("GET", "/services/pay/effective")).body,
    bundle: (await t.call("GET", "/services/pay/bundle")).body,
    audit: await allPages(t, "/audit"),
    ruleTest: (
      await t.call("POST", "/rules/test", {
        service: "pay",
        method: "GET",
        path: "/orders",
        peer: "203.0.113.9",
        identity: { user: "someone-else" },
      })
    ).body,
    live: t.live,
    logs: t.logs,
  };
  return { saved, reads, versionId };
}

describe("a draft saved with account ids", () => {
  it("stores and serves only keys; what was typed comes back once, in the save answer", async () => {
    const t = await setup();
    const { saved, reads } = await saveAndReadBack(t);
    // The save answer: keyed entries, and what was typed, once.
    expect(saved.body.policy.lists).toEqual([
      { userHash: USER_KEY, action: "block" },
      { ip: "198.51.100.7", action: "block" },
      { apiKeyHash: API_KEY_KEY, action: "block", reason: "leaked" },
    ]);
    expect(saved.body.entered).toEqual([
      { index: 0, user: RAW_USER },
      { index: 2, apiKey: RAW_KEY },
    ]);
    // Nothing read afterwards holds a raw id or the echo.
    for (const [what, value] of Object.entries(reads)) {
      const text = JSON.stringify(value);
      expect({ what, raw: holdsRaw(text) }).toEqual({ what, raw: false });
      expect({ what, entered: text.includes('"entered"') }).toEqual({
        what,
        entered: false,
      });
    }
    // What was read holds the keys (the scan above read real policies).
    expect(JSON.stringify(reads.version)).toContain(USER_KEY);
    expect(JSON.stringify(reads.versions)).toContain(API_KEY_KEY);
    expect(reads.ruleTest.decision.action).toBe("allow");
    expect(reads.effective.policy.lists).toContainEqual(
      expect.objectContaining({ userHash: USER_KEY, action: "block" }),
    );
    expect(reads.bundle.effective.lists).toContainEqual(
      expect.objectContaining({ apiKeyHash: API_KEY_KEY }),
    );
    expect(
      verifyBundle(
        reads.bundle,
        { sk_test: t.publicKey },
        { now: t.clock.now },
      ),
    ).toMatchObject({ ok: true });
    const draftAudit = (reads.audit as { action: string; entry: unknown }[])
      .filter((entry) => entry.action === "policy.draft")
      .map((entry) => JSON.stringify(entry.entry));
    expect(draftAudit.some((text) => text.includes(USER_KEY))).toBe(true);
    // And the store: every document, version, bundle, audit entry and change.
    const stored = await dump(t.store);
    expect(holdsRaw(stored)).toBe(false);
    expect(stored).toContain(USER_KEY);
    expect(stored).not.toContain('"entered"');
  });

  it("the control: the same scans find a raw id when one is planted", async () => {
    const t = await setup();
    await t.store.put(
      "policyDraft",
      "service:pay",
      { policy: DRAFT, baseHead: null, updatedBy: "planted" },
      null,
    );
    expect(holdsRaw(await dump(t.store))).toBe(true);
    expect(holdsRaw(JSON.stringify({ logs: [RAW_USER] }))).toBe(true);
  });

  it("holds no raw id in a SQLite file's bytes (the control: a planted row's id is found)", async () => {
    const path = join(tempDir(), "cp.sqlite");
    const store = sqliteStore({ path });
    await store.connect();
    const t = await setup({ store });
    await saveAndReadBack(t);
    t.api.close();
    await store.close();
    const bytes = fileText(path);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes).toContain(USER_KEY);
    expect(holdsRaw(bytes)).toBe(false);
    // The control: a row written with a raw id is in the bytes.
    const planted = sqliteStore({ path });
    await planted.connect();
    await planted.put(
      "policyDraft",
      "service:pay",
      { policy: DRAFT, baseHead: null, updatedBy: "planted" },
      null,
    );
    await planted.close();
    expect(holdsRaw(fileText(path))).toBe(true);
    // And it is in the table, not a stray page.
    const db = new Database(path);
    const row = db
      .query(`SELECT doc FROM bun_security_docs WHERE kind = 'policyDraft'`)
      .get() as { doc: string };
    db.close();
    expect(row.doc).toContain(RAW_USER);
  });

  it("answers without entered when it keyed nothing", async () => {
    const t = await setup();
    const saved = await saveDraft(t, "global", {
      lists: [{ ip: "198.51.100.7", action: "block" }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body).not.toHaveProperty("entered");
    // A key given as it is is stored as it is, and not echoed.
    const keyed = await saveDraft(t, "global", {
      lists: [{ userHash: USER_KEY, action: "block" }],
    });
    expect(keyed.status).toBe(200);
    expect(keyed.body).not.toHaveProperty("entered");
    expect(keyed.body.policy.lists).toEqual([
      { userHash: USER_KEY, action: "block" },
    ]);
  });
});

describe("a keyed entry blocks", () => {
  it("end to end: typed in a draft, published, compiled into the bundle, refused by an engine with the fleet's secret", async () => {
    const t = await setup();
    expect((await saveDraft(t, "service:pay", DRAFT)).status).toBe(200);
    expect((await publishDraft(t, "service:pay")).status).toBe(200);
    const bundle = (await t.call("GET", "/services/pay/bundle")).body;
    expect(
      verifyBundle(bundle, { sk_test: t.publicKey }, { now: t.clock.now }).ok,
    ).toBe(true);
    const policy = bundle.effective as SecurityPolicy;
    const request = (identity: { user?: string; apiKey?: string }) =>
      facts({ client: "203.0.113.30", path: "/orders", identity });
    const fleet = createSecurity({
      secret: FLEET_SECRET,
      policy,
      logger: () => {},
    });
    const user = await fleet.evaluate(request({ user: RAW_USER }));
    expect(user.action).toBe("block");
    expect(user.hits.map((hit) => hit.rule)).toEqual([`user:${USER_KEY}`]);
    const key = await fleet.evaluate(request({ apiKey: RAW_KEY }));
    expect(key.action).toBe("block");
    expect(key.hits.map((hit) => hit.rule)).toEqual([`apiKey:${API_KEY_KEY}`]);
    expect((await fleet.evaluate(request({ user: "bob" }))).action).toBe(
      "allow",
    );
    await fleet.close();
    // The control: an engine under another secret does not match the keys.
    const other = createSecurity({
      secret: "a-different-fleet-secret-32-bytes!!!",
      policy,
      logger: () => {},
    });
    expect((await other.evaluate(request({ user: RAW_USER }))).action).toBe(
      "allow",
    );
    await other.close();
  });

  it("the rule test matches a keyed entry on the request's id, and shows only the key", async () => {
    const t = await setup();
    expect((await saveDraft(t, "global", DRAFT)).status).toBe(200);
    expect((await publishDraft(t, "global")).status).toBe(200);
    const tested = await t.call("POST", "/rules/test", {
      service: "pay",
      method: "GET",
      path: "/orders",
      peer: "203.0.113.9",
      identity: { user: RAW_USER },
    });
    expect(tested.status).toBe(200);
    expect(tested.body.decision.action).toBe("block");
    expect(tested.body.decision.hits.map((hit: any) => hit.rule)).toContain(
      `user:${USER_KEY}`,
    );
    expect(holdsRaw(JSON.stringify(tested.body))).toBe(false);
  });

  it("a raw entry and the key of the same account are one entry once keyed: merged as two entries for one account are, the later one's fields winning", async () => {
    const t = await setup();
    const saved = await saveDraft(t, "global", {
      lists: [
        { user: RAW_USER, action: "allow" },
        { userHash: USER_KEY, action: "block" },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.policy.lists).toEqual([
      { userHash: USER_KEY, action: "allow" },
      { userHash: USER_KEY, action: "block" },
    ]);
    expect((await publishDraft(t, "global")).status).toBe(200);
    const effective = (await t.call("GET", "/services/pay/effective")).body;
    expect(effective.policy.lists).toEqual([
      { userHash: USER_KEY, action: "block", scope: "global" },
    ]);
    expect(effective.origins[`lists[id=user:${USER_KEY}]`]).toBe("global");
    // The control: two accounts stay two entries.
    expect(
      (
        await saveDraft(t, "global", {
          lists: [
            { user: "someone-else", action: "allow" },
            { userHash: USER_KEY, action: "block" },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await publishDraft(t, "global")).status).toBe(200);
    expect(
      (await t.call("GET", "/services/pay/effective")).body.policy.lists,
    ).toHaveLength(2);
  });
});

describe("rows stored before account entries were keyed", () => {
  it("are keyed on read: the draft, the head, versions, the diff and the effective policy", async () => {
    const t = await setup();
    const raw = { lists: [{ user: RAW_USER, action: "block" }] };
    await t.store.appendVersion(
      "global",
      { id: "pv_legacy", policy: raw, createdBy: "old", message: "" },
      null,
    );
    await t.store.put(
      "policyDraft",
      "global",
      {
        policy: { lists: [{ apiKey: RAW_KEY, action: "block" }] },
        baseHead: "pv_legacy",
        updatedBy: "old",
      },
      null,
    );
    // The control: the store does hold the raw ids.
    expect(holdsRaw(await dump(t.store))).toBe(true);
    const reads = {
      policy: (await t.call("GET", "/policies/global")).body,
      versions: await allPages(t, "/policies/global/versions"),
      version: (await t.call("GET", "/policies/global/versions/pv_legacy"))
        .body,
      diff: (await t.call("GET", "/policies/global/diff?from=head&to=draft"))
        .body,
      effective: (await t.call("GET", "/services/pay/effective")).body,
    };
    for (const [what, value] of Object.entries(reads)) {
      expect({ what, raw: holdsRaw(JSON.stringify(value)) }).toEqual({
        what,
        raw: false,
      });
    }
    expect(reads.version.policy.lists).toEqual([
      { userHash: USER_KEY, action: "block" },
    ]);
    expect(reads.policy.draft.policy.lists).toEqual([
      { apiKeyHash: API_KEY_KEY, action: "block" },
    ]);
    expect(reads.effective.policy.lists).toContainEqual(
      expect.objectContaining({ userHash: USER_KEY }),
    );
    // Publishing the old draft, or rolling back to the old version, writes keys.
    expect((await publishDraft(t, "global")).status).toBe(200);
    const rolled = await t.call("POST", "/policies/global/rollback", {
      versionId: "pv_legacy",
      expectedHead: (await t.call("GET", "/policies/global")).body.head.id,
      confirm: "global",
    });
    expect(rolled.status).toBe(200);
    const versions = await t.store.listVersions("global", { limit: 10 });
    expect(versions.items).toHaveLength(3);
    for (const version of versions.items.filter((v) => v.id !== "pv_legacy")) {
      expect(holdsRaw(JSON.stringify(version.policy))).toBe(false);
    }
    expect(JSON.stringify(versions.items)).toContain(RAW_USER);
  });

  it("an audit entry's diff is keyed when shown, and the stored chain still verifies", async () => {
    const t = await setup();
    const diffs = [
      diffPolicies({}, { lists: [{ user: RAW_USER, action: "block" }] }),
      diffPolicies(
        { lists: [{ user: RAW_USER, action: "block" }] },
        { lists: [{ user: RAW_USER, action: "allow" }] },
      ),
      diffPolicies(
        { lists: [{ id: "vip", apiKey: "key_before_1", action: "block" }] },
        { lists: [{ id: "vip", apiKey: RAW_KEY, action: "block" }] },
      ),
      diffPolicies(
        { lists: [] },
        { lists: [{ apiKey: RAW_KEY, action: "block" }] },
      ),
    ];
    for (const diff of diffs) {
      await t.api.plane.audit.intent({
        action: "policy.draft",
        scope: "global",
        target: { kind: "policyDraft", id: "global", revision: 1 },
        after: { diff },
      });
    }
    // The control: the stored entries hold the raw ids.
    const stored = await t.store.listAudit({ limit: 100 });
    expect(holdsRaw(JSON.stringify(stored.items))).toBe(true);
    const shown = (await allPages(t, "/audit?action=policy.draft")) as {
      n: number;
      entry: { after: { diff: unknown[] } };
    }[];
    expect(shown).toHaveLength(4);
    expect(holdsRaw(JSON.stringify(shown))).toBe(false);
    const byPath = shown
      .flatMap((entry) => entry.entry.after.diff)
      .map(
        (change) =>
          change as { path: string; before?: unknown; after?: unknown },
      );
    expect(byPath).toContainEqual({
      path: "lists",
      after: [{ userHash: USER_KEY, action: "block" }],
    });
    expect(byPath).toContainEqual({
      path: `lists[id=user:${USER_KEY}].action`,
      before: "block",
      after: "allow",
    });
    expect(byPath).toContainEqual({
      path: "lists[id=vip].apiKeyHash",
      before: keys.apiKey("key_before_1"),
      after: API_KEY_KEY,
    });
    expect(byPath).toContainEqual({
      path: `lists[id=apiKey:${API_KEY_KEY}]`,
      after: { apiKeyHash: API_KEY_KEY, action: "block" },
    });
    // One entry by number too.
    const one = await t.call("GET", `/audit/${shown[0].n}`);
    expect(holdsRaw(JSON.stringify(one.body))).toBe(false);
    // Only what is shown changed: the stored chain is intact.
    expect((await t.call("GET", "/audit/verify")).body).toMatchObject({
      ok: true,
    });
  });

  it("a bundle compiled with raw ids is recompiled by the repair pass (the control: a clean one is left alone)", async () => {
    const t = await setup();
    await saveDraft(t, "global", {
      lists: [{ ip: "198.51.100.7", action: "block" }],
    });
    expect((await publishDraft(t, "global")).status).toBe(200);
    const current = await t.store.getBundle("pay");
    if (current === undefined || current === "not-modified")
      throw new Error("no bundle");
    t.clock.advance(120_000);
    // The control: an up-to-date, keyed bundle is not repaired.
    expect(await t.api.plane.repairBundles({ graceMs: 0 })).toEqual([]);
    const bundle = current.bundle as { effective: { lists: unknown[] } };
    const planted = {
      ...bundle,
      version: current.version + 1,
      effective: {
        ...bundle.effective,
        lists: [{ user: RAW_USER, action: "block" }],
      },
    };
    expect(
      (
        await t.store.putBundle(
          "pay",
          { version: current.version + 1, bundle: planted },
          current.version,
        )
      ).ok,
    ).toBe(true);
    const repaired = await t.api.plane.repairBundles({ graceMs: 0 });
    expect(repaired).toEqual([
      { service: "pay", version: current.version + 2 },
    ]);
    const served = (await t.call("GET", "/services/pay/bundle")).body;
    expect(holdsRaw(JSON.stringify(served))).toBe(false);
    expect(
      verifyBundle(served, { sk_test: t.publicKey }, { now: t.clock.now }).ok,
    ).toBe(true);
  });
});

describe("what cannot be keyed is refused, before anything is written", () => {
  /** Saves `entry` alone as the global draft; the answer, and whether any draft or draft audit was written. */
  async function attempt(
    t: Awaited<ReturnType<typeof setup>>,
    entry: Record<string, unknown>,
  ) {
    const saved = await saveDraft(t, "global", {
      lists: [{ action: "block", ...entry }],
    });
    const audit = await allPages(t, "/audit?action=policy.draft");
    const draft = (await t.call("GET", "/policies/global")).body.draft;
    return { saved, wrote: audit.length > 0 || draft !== null };
  }

  it("without bans.secret: both kinds are a 400 naming the setting (the control: an address entry saves)", async () => {
    const t = await setup({ bans: { apiKeys: false, users: false } });
    for (const [entry, setting] of [
      [{ user: RAW_USER }, "bans.users: false"],
      [{ apiKey: RAW_KEY }, "bans.apiKeys: false"],
    ] as const) {
      const { saved, wrote } = await attempt(t, entry);
      expect(saved.status).toBe(400);
      expect(saved.body.code).toBe("invalid_request");
      expect(saved.body.detail).toContain(setting);
      expect(saved.body.detail).toContain("bans.secret");
      expect(holdsRaw(JSON.stringify(saved.body))).toBe(false);
      expect(wrote).toBe(false);
    }
    expect(holdsRaw(await dump(t.store))).toBe(false);
    expect((await attempt(t, { ip: "198.51.100.7" })).saved.status).toBe(200);
  });

  it("with one kind off: that kind is a 400, the other is keyed, and a key is taken as it is", async () => {
    const t = await setup({ bans: { secret: FLEET_SECRET, users: false } });
    const user = await attempt(t, { user: RAW_USER });
    expect(user.saved.status).toBe(400);
    expect(user.saved.body.detail).toContain("bans.users: false");
    expect(user.wrote).toBe(false);
    const key = await attempt(t, { apiKey: RAW_KEY });
    expect(key.saved.status).toBe(200);
    expect(key.saved.body.policy.lists[0]).toEqual({
      apiKeyHash: API_KEY_KEY,
      action: "block",
    });
    const hash = await attempt(t, { userHash: USER_KEY });
    expect(hash.saved.status).toBe(200);
  });

  it("an entry naming two accounts, a malformed key or a malformed id is a 400 that echoes neither", async () => {
    const t = await setup();
    for (const entry of [
      { user: RAW_USER, userHash: USER_KEY },
      { apiKey: RAW_KEY, apiKeyHash: API_KEY_KEY },
      { user: RAW_USER, apiKeyHash: API_KEY_KEY },
      { userHash: RAW_USER },
      { apiKeyHash: USER_KEY.toUpperCase() },
      { userHash: `${USER_KEY}0` },
      { user: `${RAW_USER} with spaces` },
      { apiKey: `${RAW_KEY}${"x".repeat(300)}` },
      { user: 42 },
    ]) {
      const { saved, wrote } = await attempt(t, entry);
      expect({ entry, status: saved.status }).toEqual({ entry, status: 400 });
      expect(saved.body.detail).toMatch(/^lists\[0\]/);
      const text = JSON.stringify(saved.body);
      expect(holdsRaw(text)).toBe(false);
      expect(text).not.toContain(USER_KEY);
      expect(wrote).toBe(false);
    }
  });

  it("a publish keys its policy too, and refuses what it cannot key", async () => {
    const t = await setup();
    const outcome = await t.api.plane.publish(
      "global",
      { lists: [{ user: RAW_USER, action: "block" }] },
      { expectedHead: null, confirm: "global" },
      { id: "alice" },
    );
    expect(outcome.kind).toBe("published");
    const head = (await t.call("GET", "/policies/global")).body.head.id;
    const stored = await t.store.getVersion("global", head);
    expect(stored?.policy).toEqual({
      lists: [{ userHash: USER_KEY, action: "block" }],
    });
    expect(holdsRaw(await dump(t.store))).toBe(false);
    const off = await setup({ bans: { apiKeys: false, users: false } });
    await expect(
      off.api.plane.publish(
        "global",
        { lists: [{ user: RAW_USER, action: "block" }] },
        { expectedHead: null, confirm: "global" },
        { id: "alice" },
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    expect(holdsRaw(await dump(off.store))).toBe(false);
  });
});

describe("memoryStore", () => {
  it("the dump reads every document kind (the control for the scans above)", async () => {
    const store = memoryStore();
    await store.put("listEntry", "x", { user: RAW_USER }, null);
    expect(holdsRaw(await dump(store))).toBe(true);
  });
});
