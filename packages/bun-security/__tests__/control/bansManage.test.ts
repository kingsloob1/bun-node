/**
 * The bans endpoints of PR-U3 (ui.md §4.2): the list's filters, search and
 * orders; a ban's detail (its audit history, the events that led to it and
 * its hits since, under the reader's analytics permissions, its bans in
 * other scopes); extend, widen and bulk lift (a dry run, a step-up or an
 * approval); keyed account subjects (`userHash`, `apiKeyHash`); the
 * subject's country and ASN from its latest event; and the operator's
 * address on `/operators/me`.
 */
import { describe, expect, it } from "bun:test";
import { testApi } from "./helpers";
import { fullEvent, liveApi, T0 } from "./liveFixtures";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A query string. */
const qs = (params: Record<string, string | number | boolean>) =>
  new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  ).toString();

/** The intents of an audit page (each operation also writes its outcome). */
const intents = (page: { body: { items: { phase: string }[] } }) =>
  page.body.items.filter((entry) => entry.phase === "intent");

/** The ids of a page's bans. */
const ids = (page: { body: { items: { id: string }[] } }) =>
  page.body.items.map((ban) => ban.id);

describe("GET /bans: filters, search and orders", () => {
  it("filters by kind, source and rule, and an address finds the ranges holding it", async () => {
    const test = testApi();
    const { call, store } = test;
    const ip = (
      await call("POST", "/bans", { ip: "198.51.100.7", reason: "r" })
    ).body;
    const range = (
      await call("POST", "/bans", { ip: "198.51.100.0/24", reason: "r" })
    ).body;
    const other = (
      await call("POST", "/bans", { ip: "203.0.113.9", reason: "r" })
    ).body;
    const auto = await store.upsertBan({
      scope: "global",
      subject: { type: "ip", value: "192.0.2.4" },
      action: "ban",
      reason: "counted",
      source: "auto",
      expiresAt: null,
      rule: "counted:login",
    });
    expect(ids(await call("GET", `/bans?${qs({ kind: "cidr" })}`))).toEqual([
      range.id,
    ]);
    expect(ids(await call("GET", `/bans?${qs({ source: "auto" })}`))).toEqual([
      auto.id,
    ]);
    expect(
      ids(await call("GET", `/bans?${qs({ rule: "counted:login" })}`)),
    ).toEqual([auto.id]);
    expect(
      ids(await call("GET", `/bans?${qs({ search: "198.51.100.7" })}`)).sort(),
    ).toEqual([ip.id, range.id].sort());
    expect(
      ids(await call("GET", `/bans?${qs({ search: "198.51.100.0/25" })}`)),
    ).toEqual([range.id]);
    expect(
      ids(await call("GET", `/bans?${qs({ search: "203.0.113.9" })}`)),
    ).toEqual([other.id]);
    // A search never takes a raw account id.
    const raw = await call(
      "GET",
      `/bans?${qs({ search: "alice@example.com" })}`,
    );
    expect([raw.status, raw.body.code]).toEqual([400, "invalid_request"]);
  });

  it("sorts by end (a permanent ban last) and by start, the cursor bound to its order", async () => {
    const { call, clock } = testApi();
    const long = (
      await call("POST", "/bans", {
        ip: "192.0.2.1",
        reason: "r",
        duration: "7d",
      })
    ).body;
    clock.advance(MINUTE);
    const short = (
      await call("POST", "/bans", {
        ip: "192.0.2.2",
        reason: "r",
        duration: "1h",
      })
    ).body;
    clock.advance(MINUTE);
    const forever = (
      await call("POST", "/bans", {
        ip: "192.0.2.3",
        reason: "r",
        duration: null,
      })
    ).body;
    expect(ids(await call("GET", `/bans?${qs({ sort: "expires" })}`))).toEqual([
      short.id,
      long.id,
      forever.id,
    ]);
    const first = await call(
      "GET",
      `/bans?${qs({ sort: "created", direction: "desc", limit: 1 })}`,
    );
    expect(ids(first)).toEqual([forever.id]);
    const second = await call(
      "GET",
      `/bans?${qs({ sort: "created", direction: "desc", limit: 1, cursor: first.body.next })}`,
    );
    expect(ids(second)).toEqual([short.id]);
    const crossed = await call(
      "GET",
      `/bans?${qs({ sort: "expires", limit: 1, cursor: first.body.next })}`,
    );
    expect(crossed.status).toBe(400);
  });
});

describe("POST /bans: keyed subjects and the subject's facts", () => {
  it("takes a user's or an API key's key as it is, with nothing typed to echo", async () => {
    const { call } = testApi();
    const key = "0123456789abcdef0123456789abcdef";
    const user = await call("POST", "/bans", { userHash: key, reason: "r" });
    expect(user.status).toBe(201);
    expect(user.body.subject).toEqual({ type: "user", value: key });
    expect(user.body.entered).toBeUndefined();
    const apiKey = await call("POST", "/bans", {
      apiKeyHash: key,
      reason: "r",
    });
    expect(apiKey.body.subject).toEqual({ type: "apiKey", value: key });
    // The same account typed raw is keyed to something else: never the id itself.
    const typed = await call("POST", "/bans", { user: "u-42", reason: "r" });
    expect(typed.body.entered).toEqual({ user: "u-42" });
    expect(typed.body.subject.value).toMatch(/^[\da-f]{32}$/);
    expect(JSON.stringify((await call("GET", "/bans")).body)).not.toContain(
      "u-42",
    );
    for (const bad of [
      { userHash: "not-a-key", reason: "r" },
      { userHash: key, ip: "192.0.2.1", reason: "r" },
    ]) {
      expect((await call("POST", "/bans", bad)).status).toBe(400);
    }
  });

  it("records the subject's country and ASN from its latest event", async () => {
    const test = await liveApi();
    await test.store.appendEvents!("b1", [fullEvent("e1", "pay")], []);
    test.clock.advance(MINUTE);
    const ban = await test.call("POST", "/bans", {
      ip: "203.0.113.7",
      reason: "r",
    });
    expect(ban.body).toMatchObject({ country: "NG", asn: 64_500 });
    const unknown = await test.call("POST", "/bans", {
      ip: "192.0.2.77",
      reason: "r",
    });
    expect(unknown.body.country).toBeUndefined();
  });

  it("canonicalises an address, so one subject is one ban", async () => {
    const { call } = testApi();
    const upper = await call("POST", "/bans", {
      ip: "2001:DB8::1",
      reason: "r",
    });
    const lower = await call("POST", "/bans", {
      ip: "2001:db8::1",
      reason: "r",
    });
    expect(upper.body.subject.value).toBe("2001:db8::1");
    expect(lower.body.id).toBe(upper.body.id);
  });
});

describe("GET /bans/:id", () => {
  it("holds its history, the events that led to it and its hits since, for an analyst", async () => {
    const test = await liveApi();
    await test.store.appendEvents!(
      "b1",
      [fullEvent("e1", "pay"), fullEvent("e2", "pay", { at: T0 + 1 })],
      [],
    );
    test.clock.advance(MINUTE);
    const ban = (
      await test.call("POST", "/bans", { ip: "203.0.113.7", reason: "r" })
    ).body;
    await test.store.appendEvents!(
      "b2",
      [fullEvent("e3", "pay", { at: T0 + 2 * MINUTE })],
      [],
    );
    await test.call("POST", `/bans/${ban.id}/extend`, { duration: "7d" });
    const detail = await test.call("GET", `/bans/${ban.id}`, undefined, "ann");
    expect(detail.status).toBe(200);
    expect(detail.body.ban.id).toBe(ban.id);
    expect(detail.body.history.map((entry: any) => entry.action)).toEqual([
      "ban.extend",
      "ban.create",
    ]);
    expect(detail.body.historyTruncated).toBe(false);
    expect(detail.body.events.map((event: any) => event.id)).toEqual([
      "e2",
      "e1",
    ]);
    expect(detail.body.hitsSince).toBe(1);
    expect(detail.body.hitsSinceCapped).toBe(false);
    expect(detail.body.ladderStep).toBeUndefined();
  });

  it("an account's ban leaves its events out for a viewer (no events:read), and keeps them for an analyst", async () => {
    const test = await liveApi();
    const key = "00112233445566778899aabbccddeeff";
    await test.store.appendEvents!(
      "b1",
      [
        fullEvent("e1", "pay", {
          subjects: { ip: "203.0.113.7", apiKey: key },
        }),
      ],
      [],
    );
    test.clock.advance(MINUTE);
    const ban = (
      await test.call("POST", "/bans", { apiKeyHash: key, reason: "r" })
    ).body;
    expect(ban.subject).toEqual({ type: "apiKey", value: key });
    const viewer = await test.call("GET", `/bans/${ban.id}`, undefined, "vic");
    expect(viewer.status).toBe(200);
    expect(viewer.body.events).toBeUndefined();
    expect(viewer.body.hitsSince).toBeUndefined();
    const analyst = await test.call("GET", `/bans/${ban.id}`, undefined, "ann");
    expect(analyst.body.events.map((event: any) => event.id)).toEqual(["e1"]);
  });

  it("lists the subject's bans in the other scopes the reader may see", async () => {
    const test = await liveApi();
    const here = (
      await test.call("POST", "/bans", {
        ip: "192.0.2.5",
        reason: "r",
        scope: "service:pay",
      })
    ).body;
    const there = (
      await test.call("POST", "/bans", {
        ip: "192.0.2.5",
        reason: "r",
        scope: "service:shop",
      })
    ).body;
    const owner = await test.call("GET", `/bans/${here.id}`);
    expect(owner.body.otherBans.map((ban: any) => ban.id)).toEqual([there.id]);
    // gina reads group:payments only: pay's ban, but not shop's.
    const gina = await test.call("GET", `/bans/${here.id}`, undefined, "gina");
    expect(gina.status).toBe(200);
    expect(gina.body.otherBans).toEqual([]);
    expect(
      (await test.call("GET", `/bans/${there.id}`, undefined, "gina")).status,
    ).toBe(403);
    expect((await test.call("GET", "/bans/ban_missing")).status).toBe(404);
  });
});

describe("POST /bans/:id/extend", () => {
  it("lengthens, or makes permanent; never shortens; audited", async () => {
    const { call, clock } = testApi();
    const ban = (
      await call("POST", "/bans", {
        ip: "192.0.2.10",
        reason: "r",
        duration: "1h",
      })
    ).body;
    const longer = await call("POST", `/bans/${ban.id}/extend`, {
      duration: "1d",
    });
    expect(longer.status).toBe(200);
    expect(longer.body.expiresAt).toBe(clock.now() + 24 * HOUR);
    const shorter = await call("POST", `/bans/${ban.id}/extend`, {
      duration: "2h",
    });
    expect([shorter.status, shorter.body.code]).toEqual([409, "conflict"]);
    const forever = await call("POST", `/bans/${ban.id}/extend`, {
      duration: null,
    });
    expect(forever.body.expiresAt).toBeNull();
    expect(
      (await call("POST", `/bans/${ban.id}/extend`, { duration: null })).status,
    ).toBe(409);
    const audit = await call("GET", `/audit?${qs({ action: "ban.extend" })}`);
    expect(intents(audit)).toHaveLength(2);
  });

  it("works on a keyed account's ban with no raw id, and refuses a lifted one and a reader", async () => {
    const test = await liveApi();
    const key = "fedcba9876543210fedcba9876543210";
    const ban = (
      await test.call("POST", "/bans", { userHash: key, reason: "r" })
    ).body;
    const extended = await test.call("POST", `/bans/${ban.id}/extend`, {
      duration: "30d",
    });
    expect(extended.status).toBe(200);
    expect(extended.body.subject).toEqual({ type: "user", value: key });
    expect(
      (
        await test.call(
          "POST",
          `/bans/${ban.id}/extend`,
          { duration: "60d" },
          "vic",
        )
      ).status,
    ).toBe(403);
    await test.call("POST", `/bans/${ban.id}/lift`);
    expect(
      (await test.call("POST", `/bans/${ban.id}/extend`, { duration: "90d" }))
        .status,
    ).toBe(409);
  });
});

describe("POST /bans/:id/widen", () => {
  it("bans the /24 or /64 around an address with the same end, audited; a range does not widen", async () => {
    const { call } = testApi();
    const v4 = (
      await call("POST", "/bans", {
        ip: "198.51.100.77",
        reason: "scanner",
        duration: "2h",
      })
    ).body;
    const widened = await call("POST", `/bans/${v4.id}/widen`);
    expect(widened.status).toBe(201);
    expect(widened.body.subject).toEqual({
      type: "cidr",
      value: "198.51.100.0/24",
    });
    expect(widened.body.expiresAt).toBe(v4.expiresAt);
    expect(widened.body.reason).toBe("widened from 198.51.100.77: scanner");
    const v6 = (
      await call("POST", "/bans", { ip: "2001:db8:1:2::9", reason: "r" })
    ).body;
    expect(
      (await call("POST", `/bans/${v6.id}/widen`)).body.subject.value,
    ).toBe("2001:db8:1:2::/64");
    expect((await call("POST", `/bans/${widened.body.id}/widen`)).status).toBe(
      409,
    );
    const audit = await call("GET", `/audit?${qs({ action: "ban.widen" })}`);
    expect(intents(audit)).toHaveLength(2);
  });
});

describe("POST /bans/lift", () => {
  it("a dry run counts; a lift lifts what the filter matches and one entry audits it", async () => {
    const { call, clock, store } = testApi();
    for (let i = 1; i <= 3; i++) {
      await store.upsertBan({
        scope: "global",
        subject: { type: "ip", value: `192.0.2.${i}` },
        action: "ban",
        reason: "auto",
        source: "auto",
        expiresAt: null,
        rule: "counted:login",
      });
    }
    clock.advance(HOUR);
    const later = (
      await call("POST", "/bans", { ip: "192.0.2.50", reason: "manual" })
    ).body;
    const dry = await call("POST", "/bans/lift", {
      rule: "counted:login",
      dryRun: true,
    });
    expect(dry.body).toEqual({ dryRun: true, matched: 3, lifted: 0 });
    expect(
      ids(await call("GET", `/bans?${qs({ active: true })}`)),
    ).toHaveLength(4);
    // The window: only bans started in the last 30 minutes, so the manual one alone.
    const windowed = await call("POST", "/bans/lift", {
      createdFrom: clock.now() - 30 * MINUTE,
      dryRun: true,
    });
    expect(windowed.body.matched).toBe(1);
    const lifted = await call("POST", "/bans/lift", { rule: "counted:login" });
    expect(lifted.body).toEqual({ dryRun: false, matched: 3, lifted: 3 });
    expect(ids(await call("GET", `/bans?${qs({ active: true })}`))).toEqual([
      later.id,
    ]);
    const audit = await call("GET", `/audit?${qs({ action: "bans.lift" })}`);
    expect(intents(audit)).toHaveLength(1);
    expect((intents(audit)[0] as any).entry.before).toMatchObject({
      matched: 3,
    });
  });

  it("asks for a step-up (and never lifts without it), or opens an approval another operator carries out", async () => {
    let fresh = false;
    const hooked = testApi({
      allowWithoutStepUp: undefined,
      stepUp: { verify: () => fresh, challenge: () => "/mfa" },
    });
    await hooked.call("POST", "/bans", { ip: "192.0.2.9", reason: "r" });
    const asked = await hooked.call("POST", "/bans/lift", {});
    expect([asked.status, asked.body.code, asked.body.stepUpUrl]).toEqual([
      401,
      "step_up_required",
      "/mfa",
    ]);
    expect(
      ids(await hooked.call("GET", `/bans?${qs({ active: true })}`)),
    ).toHaveLength(1);
    // A dry run changes nothing, so it needs no step-up.
    expect(
      (await hooked.call("POST", "/bans/lift", { dryRun: true })).status,
    ).toBe(200);
    fresh = true;
    expect((await hooked.call("POST", "/bans/lift", {})).body.lifted).toBe(1);

    const approvals = testApi({
      allowWithoutStepUp: undefined,
      approvals: "two-person",
      owners: ["alice", "bob"],
    });
    await approvals.call("POST", "/bans", { ip: "192.0.2.9", reason: "r" });
    const opened = await approvals.call("POST", "/bans/lift", {});
    expect(opened.status).toBe(202);
    expect(opened.body.action).toBe("bans.lift");
    expect(
      ids(await approvals.call("GET", `/bans?${qs({ active: true })}`)),
    ).toHaveLength(1);
    const decided = await approvals.call(
      "POST",
      `/approvals/${opened.body.id}/approve`,
      { revision: opened.body.revision },
      "bob",
    );
    expect(decided.status).toBe(200);
    expect(
      ids(await approvals.call("GET", `/bans?${qs({ active: true })}`)),
    ).toEqual([]);
  });
});

describe("GET /operators/me", () => {
  it("names the request's client address as the API sees it", async () => {
    const { call } = testApi();
    const me = await call("GET", "/operators/me");
    expect(me.status).toBe(200);
    expect("address" in me.body).toBe(true);
  });
});
