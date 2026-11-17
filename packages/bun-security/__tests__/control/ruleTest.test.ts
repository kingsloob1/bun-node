/**
 * `POST /rules/test` (PR-CP7): a described request through a service's
 * effective policy, or a scope's draft in its place, on a throwaway engine.
 * It reads the active bans for its subjects and writes nothing; account ids
 * are keyed and shown as keys; assumed limit counts and scores apply;
 * `rules:test` is an analyst's, and a draft needs `policy:read`; 30 tests a
 * minute an operator across the instances. Each with its negative control.
 */
import { describe, expect, it } from "bun:test";
import { memoryStore } from "../../lib/store/index";
import { fakeClock } from "../helpers";
import { testApi } from "./helpers";

/** An API with group payments, services pay (in it) and shop, and a published global policy. */
async function setup(extra: Parameters<typeof testApi>[0] = {}) {
  const t = testApi(extra);
  if (
    extra.store === undefined ||
    (await t.store.get("group", "payments")) === undefined
  ) {
    await t.call("POST", "/groups", { id: "payments", name: "Payments" });
    await t.call("POST", "/services", {
      id: "pay",
      name: "Pay",
      groups: ["payments"],
    });
    await t.call("POST", "/services", { id: "shop", name: "Shop" });
  }
  return t;
}

/** Publishes `policy` at `scope`. */
async function publish(
  t: Awaited<ReturnType<typeof setup>>,
  scope: string,
  policy: unknown,
) {
  const head = await t.call("GET", `/policies/${scope}`);
  const draft = await t.call("PUT", `/policies/${scope}/draft`, {
    policy,
    revision: head.body?.draft?.revision ?? null,
  });
  expect(draft.status).toBeLessThan(300);
  const published = await t.call("POST", `/policies/${scope}/publish`, {
    expectedHead: head.body?.head?.id ?? null,
    confirm: scope,
  });
  expect(published.status).toBeLessThan(300);
}

/** Saves `policy` as `scope`'s draft. */
async function draft(
  t: Awaited<ReturnType<typeof setup>>,
  scope: string,
  policy: unknown,
) {
  const head = await t.call("GET", `/policies/${scope}`);
  const saved = await t.call("PUT", `/policies/${scope}/draft`, {
    policy,
    revision: head.body?.draft?.revision ?? null,
  });
  expect(saved.status).toBeLessThan(300);
}

const REQUEST = {
  service: "pay",
  method: "GET",
  path: "/orders?x=1",
  peer: "203.0.113.5",
};

describe("test a request", () => {
  it("decides by the published policy: a listed address is blocked, another is not", async () => {
    const t = await setup();
    await publish(t, "global", {
      lists: [{ ip: "203.0.113.5", action: "block" }],
    });
    const blocked = await t.call("POST", "/rules/test", REQUEST);
    expect(blocked.status).toBe(200);
    expect(blocked.body.decision.action).toBe("block");
    expect(blocked.body.decision.hits.map((h: any) => h.layer)).toContain("L3");
    expect(blocked.body.client).toMatchObject({
      address: "203.0.113.5",
      source: "socket",
    });
    expect(blocked.body.steps.length).toBeGreaterThan(0);
    expect(blocked.body.policy.draft).toBeNull();
    const other = await t.call("POST", "/rules/test", {
      ...REQUEST,
      peer: "203.0.113.6",
    });
    expect(other.body.decision.action).toBe("allow");
  });

  it("a scope's draft stands in for its published policy; a scope not above the service is refused", async () => {
    const t = await setup();
    await draft(t, "group:payments", {
      lists: [{ ip: "203.0.113.5", action: "block" }],
    });
    const withDraft = await t.call("POST", "/rules/test", {
      ...REQUEST,
      draft: "group:payments",
    });
    expect(withDraft.body.decision.action).toBe("block");
    expect(withDraft.body.policy.versions).toContain("group:payments@draft");
    // The control: the published policy allows it.
    expect(
      (await t.call("POST", "/rules/test", REQUEST)).body.decision.action,
    ).toBe("allow");
    // shop is not under payments.
    const wrong = await t.call("POST", "/rules/test", {
      ...REQUEST,
      service: "shop",
      draft: "group:payments",
    });
    expect(wrong.status).toBe(400);
  });

  it("writes nothing: a tight limit never trips, no ban is made, the store's feed does not move", async () => {
    const t = await setup();
    await publish(t, "global", {
      limits: [{ id: "tight", limit: 1, window: "1m" }],
      countedRules: [
        {
          id: "flood",
          event: "request",
          threshold: 2,
          window: "1m",
          duration: "1h",
        },
      ],
    });
    const head = (await t.store.changesSince(0n, 1)).head;
    const bans = (await t.store.listBans({ limit: 100 })).items.length;
    for (let i = 0; i < 5; i++) {
      const tested = await t.call("POST", "/rules/test", REQUEST);
      expect(tested.status).toBe(200);
      expect(tested.body.decision.action).toBe("allow");
    }
    expect((await t.store.changesSince(0n, 1)).head).toBe(head);
    expect((await t.store.listBans({ limit: 100 })).items).toHaveLength(bans);
  });

  it("assumes limit counts: as if the address had sent 5 under a limit of 5; an unknown limit is a 400", async () => {
    const t = await setup();
    await publish(t, "global", {
      limits: [{ id: "five", limit: 5, window: "1m" }],
    });
    const assumed = await t.call("POST", "/rules/test", {
      ...REQUEST,
      assume: { limits: { five: 5 } },
    });
    expect(assumed.body.decision.action).not.toBe("allow");
    expect(assumed.body.decision.hits.map((h: any) => h.rule)).toContain(
      "limit:five",
    );
    // The control: 4 counted, the fifth goes through.
    const under = await t.call("POST", "/rules/test", {
      ...REQUEST,
      assume: { limits: { five: 4 } },
    });
    expect(under.body.decision.action).toBe("allow");
    const unknown = await t.call("POST", "/rules/test", {
      ...REQUEST,
      assume: { limits: { nope: 1 } },
    });
    expect(unknown.status).toBe(400);
  });

  it("assumes a score: a honeypot's weight on top of it reaches the ladder's ban", async () => {
    const t = await setup();
    await publish(t, "global", {
      ladder: {
        weights: { "honeypot.hit": 4 },
        steps: [{ score: 10, action: "ban", duration: "1h" }],
      },
      deception: { honeypots: { paths: ["/.env"], answer: "not-found" } },
    });
    const probe = { ...REQUEST, path: "/.env" };
    const plain = await t.call("POST", "/rules/test", probe);
    expect(plain.body.decision.action).not.toBe("ban");
    const assumed = await t.call("POST", "/rules/test", {
      ...probe,
      assume: { score: 9 },
    });
    expect(
      assumed.body.steps.some(
        (s: any) => s.rule === "ladder" && /reaching 10/.test(s.outcome),
      ),
    ).toBe(true);
    // The control above: no assumed score, no step reached.
    expect(
      plain.body.steps.some(
        (s: any) => s.rule === "ladder" && /reaching/.test(s.outcome),
      ),
    ).toBe(false);
  });

  it("keys account ids as the engines do: a user list matches, and the answer shows the key", async () => {
    const t = await setup();
    await publish(t, "global", { lists: [{ user: "alice", action: "block" }] });
    const tested = await t.call("POST", "/rules/test", {
      ...REQUEST,
      identity: { user: "alice" },
    });
    expect(tested.body.decision.action).toBe("block");
    expect(tested.body.decision.subject.user).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(tested.body)).not.toContain("alice");
    const bob = await t.call("POST", "/rules/test", {
      ...REQUEST,
      identity: { user: "bob" },
    });
    expect(bob.body.decision.action).toBe("allow");
  });

  it("reads the active bans for its subjects (address, range, user); never another's", async () => {
    const t = await setup();
    expect(
      (
        await t.call("POST", "/bans", {
          scope: "service:pay",
          ip: "203.0.113.5",
          reason: "x",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await t.call("POST", "/bans", {
          scope: "global",
          ip: "198.51.100.0/24",
          reason: "x",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await t.call("POST", "/bans", {
          scope: "global",
          user: "mallory",
          reason: "x",
        })
      ).status,
    ).toBe(201);
    const ip = await t.call("POST", "/rules/test", REQUEST);
    expect(ip.body.decision.action).toBe("ban");
    const range = await t.call("POST", "/rules/test", {
      ...REQUEST,
      peer: "198.51.100.77",
    });
    expect(range.body.decision.action).toBe("ban");
    const user = await t.call("POST", "/rules/test", {
      ...REQUEST,
      peer: "192.0.2.1",
      identity: { user: "mallory" },
    });
    expect(user.body.decision.action).toBe("ban");
    // The controls: another address, another user, another service's ban.
    const clean = await t.call("POST", "/rules/test", {
      ...REQUEST,
      peer: "192.0.2.1",
      identity: { user: "alice" },
    });
    expect(clean.body.decision.action).toBe("allow");
    const shop = await t.call("POST", "/rules/test", {
      ...REQUEST,
      service: "shop",
    });
    expect(shop.body.decision.action).toBe("allow");
  });

  it("resolves the client through trusted proxies as the service would", async () => {
    const t = await setup();
    const via = {
      ...REQUEST,
      peer: "10.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.9" },
    };
    const trusted = await t.call("POST", "/rules/test", {
      ...via,
      trustProxy: ["10.0.0.0/8"],
    });
    expect(trusted.body.client).toMatchObject({
      address: "203.0.113.9",
      source: "trusted-proxy",
    });
    const off = await t.call("POST", "/rules/test", via);
    expect(off.body.client).toMatchObject({
      address: "10.0.0.1",
      source: "socket",
    });
    expect(
      (await t.call("POST", "/rules/test", { ...via, trustProxy: { x: 1 } }))
        .status,
    ).toBe(400);
  });

  it("assumes an address's country; says what it did not evaluate", async () => {
    const t = await setup();
    await publish(t, "global", { lists: [{ country: "RU", action: "block" }] });
    const ru = await t.call("POST", "/rules/test", {
      ...REQUEST,
      intel: { country: "RU" },
    });
    expect(ru.body.decision.action).toBe("block");
    expect(ru.body.notEvaluated).toEqual(["crawler.rdns"]);
    const none = await t.call("POST", "/rules/test", REQUEST);
    expect(none.body.decision.action).toBe("allow");
    expect(none.body.notEvaluated).toEqual(["crawler.rdns", "intel"]);
  });
});

describe("who may test", () => {
  it("rules:test is an analyst's, on the service's scope; a draft needs policy:read too", async () => {
    const t = await setup();
    await t.call("POST", "/role-bindings", {
      operator: "vic",
      role: "viewer",
      scope: "global",
    });
    await t.call("POST", "/role-bindings", {
      operator: "ann",
      role: "analyst",
      scope: "service:pay",
    });
    expect((await t.call("POST", "/rules/test", REQUEST, "vic")).status).toBe(
      403,
    );
    expect((await t.call("POST", "/rules/test", REQUEST, "ann")).status).toBe(
      200,
    );
    expect(
      (
        await t.call(
          "POST",
          "/rules/test",
          { ...REQUEST, service: "shop" },
          "ann",
        )
      ).status,
    ).toBe(403);
    await draft(t, "group:payments", { lists: [] });
    // ann reads no policy at the group.
    expect(
      (
        await t.call(
          "POST",
          "/rules/test",
          { ...REQUEST, draft: "group:payments" },
          "ann",
        )
      ).status,
    ).toBe(403);
    await t.call("POST", "/role-bindings", {
      operator: "ann",
      role: "viewer",
      scope: "group:payments",
    });
    expect(
      (
        await t.call(
          "POST",
          "/rules/test",
          { ...REQUEST, draft: "group:payments" },
          "ann",
        )
      ).status,
    ).toBe(200);
  });

  it("30 tests a minute an operator, across two instances on one store", async () => {
    const clock = fakeClock();
    const store = memoryStore({ now: clock.now });
    const a = await setup({ store, now: clock.now });
    const b = await setup({ store, now: clock.now });
    for (let i = 0; i < 15; i++) {
      expect((await a.call("POST", "/rules/test", REQUEST)).status).toBe(200);
      expect((await b.call("POST", "/rules/test", REQUEST)).status).toBe(200);
    }
    const over = await b.call("POST", "/rules/test", REQUEST);
    expect([over.status, over.body.code]).toEqual([429, "rate_limited"]);
    // Another operator is counted apart; a new minute starts afresh.
    await a.call("POST", "/role-bindings", {
      operator: "ann",
      role: "analyst",
      scope: "global",
    });
    expect((await a.call("POST", "/rules/test", REQUEST, "ann")).status).toBe(
      200,
    );
    clock.advance(60_000);
    expect((await a.call("POST", "/rules/test", REQUEST)).status).toBe(200);
  });
});
