/**
 * The analytics reads (ui.md §7, PR-CP5): series, top-N, the events and
 * one event, for a scope and what is under it; a viewer's pages hold no
 * request sample and no user, username or API-key subject (an analyst's
 * do, the negative control); an account's subjects are an analyst's to
 * filter and rank by; the bounds; and the routes in the OpenAPI document.
 */
import { describe, expect, it } from "bun:test";
import {
  counters,
  fullEvent,
  liveApi,
  SECRET_SUBJECTS,
  T0,
} from "./liveFixtures";

const HOUR = 3_600_000;

/** A fixture API with events and counters for `pay` (in the group) and `shop`. */
async function seeded() {
  const test = await liveApi();
  await test.store.appendEvents!(
    "b1",
    [fullEvent("e1", "pay"), fullEvent("e2", "shop", { at: T0 + 1 })],
    [...counters("pay", 2), ...counters("shop", 5)],
  );
  return test;
}

/** A query string. */
const qs = (params: Record<string, string | number>) =>
  new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  ).toString();

const RANGE = { from: T0, to: T0 + HOUR };

describe("GET /analytics/events", () => {
  it("a viewer's page: no sample, no account subject, an account's rule id redacted", async () => {
    const { call } = await seeded();
    const page = await call("GET", "/analytics/events", undefined, "vic");
    expect(page.status).toBe(200);
    expect(page.body.items.map((e: any) => e.id)).toEqual(["e2", "e1"]);
    expect(page.body.items[0].subjects).toEqual({ ip: "203.0.113.7" });
    expect(page.body.items[0].rule).toBe("apiKey:[redacted]");
    const text = JSON.stringify(page.body);
    for (const secret of [...Object.values(SECRET_SUBJECTS), "SAMPLE-SECRET"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("negative control: an analyst's page holds every subject and the sample", async () => {
    const { call } = await seeded();
    const text = JSON.stringify(
      (await call("GET", "/analytics/events", undefined, "ann")).body,
    );
    for (const secret of [...Object.values(SECRET_SUBJECTS), "SAMPLE-SECRET"]) {
      expect(text).toContain(secret);
    }
  });

  it("decides each event's detail on its own service: a group's analyst on the global page", async () => {
    const { call } = await seeded();
    await call("POST", "/role-bindings", {
      operator: "mia",
      role: "viewer",
      scope: "global",
    });
    await call("POST", "/role-bindings", {
      operator: "mia",
      role: "analyst",
      scope: "group:payments",
    });
    const page = await call("GET", "/analytics/events", undefined, "mia");
    const byService = Object.fromEntries(
      page.body.items.map((e: any) => [e.service, e]),
    );
    expect(byService.pay.subjects).toEqual({
      ip: "203.0.113.7",
      ...SECRET_SUBJECTS,
    });
    expect(JSON.stringify(byService.pay)).toContain("SAMPLE-SECRET");
    expect(byService.shop.subjects).toEqual({ ip: "203.0.113.7" });
    expect(JSON.stringify(byService.shop)).not.toContain("SAMPLE-SECRET");
    // The negative control: a viewer alone gets both stripped.
    const vic = await call("GET", "/analytics/events", undefined, "vic");
    expect(JSON.stringify(vic.body)).not.toContain("SAMPLE-SECRET");
  });

  it("filtering by an account is an analyst's; a group's analyst reads the group, not the rest", async () => {
    const { call } = await seeded();
    expect(
      (
        await call(
          "GET",
          `/analytics/events?apiKey=${SECRET_SUBJECTS.apiKey}`,
          undefined,
          "vic",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "GET",
          `/analytics/events?apiKey=${SECRET_SUBJECTS.apiKey}`,
          undefined,
          "ann",
        )
      ).body.items,
    ).toHaveLength(2);
    expect(
      (await call("GET", "/analytics/events", undefined, "gina")).status,
    ).toBe(403);
    const group = await call(
      "GET",
      "/analytics/events?scope=group:payments",
      undefined,
      "gina",
    );
    expect(group.body.items.map((e: any) => e.service)).toEqual(["pay"]);
    expect(
      (
        await call(
          "GET",
          "/analytics/events?scope=service:pay",
          undefined,
          "gina",
        )
      ).body.items,
    ).toHaveLength(1);
    expect(
      (
        await call(
          "GET",
          "/analytics/events?scope=service:shop",
          undefined,
          "gina",
        )
      ).status,
    ).toBe(403);
  });

  it("pages by cursor, at most 200 a page", async () => {
    const { call } = await seeded();
    const first = await call(
      "GET",
      "/analytics/events?limit=1",
      undefined,
      "vic",
    );
    expect(first.body.items.map((e: any) => e.id)).toEqual(["e2"]);
    const second = await call(
      "GET",
      `/analytics/events?limit=1&cursor=${first.body.next}`,
      undefined,
      "vic",
    );
    expect(second.body.items.map((e: any) => e.id)).toEqual(["e1"]);
    expect(second.body.next).toBeUndefined();
    expect(
      (await call("GET", "/analytics/events?limit=201", undefined, "vic"))
        .status,
    ).toBe(400);
  });

  it("one event by id: whole for an analyst of its service, refused to a viewer, 404 when unknown", async () => {
    const { call } = await seeded();
    const one = await call("GET", "/analytics/events/e1", undefined, "gina");
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).toContain("SAMPLE-SECRET");
    expect(
      (await call("GET", "/analytics/events/e2", undefined, "gina")).status,
    ).toBe(403);
    expect(
      (await call("GET", "/analytics/events/e1", undefined, "vic")).status,
    ).toBe(403);
    expect(
      (await call("GET", "/analytics/events/nope", undefined, "ann")).status,
    ).toBe(404);
  });
});

describe("GET /analytics/series and /analytics/top", () => {
  it("sums a scope's services: global, a group, a service", async () => {
    const { call } = await seeded();
    const sum = async (scope: string) =>
      (
        await call(
          "GET",
          `/analytics/series?${qs({ metric: "requests", action: "block", scope, ...RANGE })}`,
          undefined,
          "ann",
        )
      ).body;
    expect((await sum("global")).points).toEqual([
      { at: T0, dims: { action: "block" }, value: 7 },
    ]);
    expect((await sum("group:payments")).points[0].value).toBe(2);
    expect((await sum("service:shop")).points[0].value).toBe(5);
    expect((await sum("global")).tier).toBe("minute");
  });

  it("a subject metric names its kind: by address for a viewer, by API key for an analyst", async () => {
    const { call } = await seeded();
    const top = (kind: string | undefined, op: string) =>
      call(
        "GET",
        `/analytics/top?${qs({ metric: "top.refused", ...RANGE, ...(kind === undefined ? {} : { kind }) })}`,
        undefined,
        op,
      );
    expect((await top(undefined, "vic")).status).toBe(400);
    const byIp = await top("ip", "vic");
    expect(byIp.body.rows).toEqual([
      { dims: { kind: "ip", subject: "203.0.113.7" }, value: 7 },
    ]);
    expect((await top("apiKey", "vic")).status).toBe(403);
    // The negative control: an analyst ranks by API key.
    const byKey = await top("apiKey", "ann");
    expect(byKey.body.rows[0].dims.subject).toBe(SECRET_SUBJECTS.apiKey);
  });

  it("a viewer's rule dims redact an account's id; an analyst's do not", async () => {
    const { call } = await seeded();
    const rules = (op: string) =>
      call(
        "GET",
        `/analytics/series?${qs({ metric: "rules", ...RANGE })}`,
        undefined,
        op,
      );
    expect((await rules("vic")).body.points[0].dims.rule).toBe(
      "apiKey:[redacted]",
    );
    expect((await rules("ann")).body.points[0].dims.rule).toBe(
      `apiKey:${SECRET_SUBJECTS.apiKey}`,
    );
  });

  it("bounds: 400 days of range, 100 rows of top-N, 10,000 points of series", async () => {
    const { call, store } = await seeded();
    expect(
      (
        await call(
          "GET",
          `/analytics/series?${qs({ metric: "requests", from: T0, to: T0 + 401 * 24 * HOUR })}`,
          undefined,
          "vic",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          "GET",
          `/analytics/series?${qs({ metric: "requests", from: T0 + 1, to: T0 })}`,
          undefined,
          "vic",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          "GET",
          `/analytics/top?${qs({ metric: "requests", limit: 101, ...RANGE })}`,
          undefined,
          "vic",
        )
      ).status,
    ).toBe(400);
    await store.addCounters!(
      Array.from({ length: 10_001 }, (_, i) => ({
        service: "pay",
        at: T0,
        metric: "wide",
        dims: { route: `r${i}` },
        value: 1,
      })),
    );
    const wide = await call(
      "GET",
      `/analytics/series?${qs({ metric: "wide", ...RANGE })}`,
      undefined,
      "vic",
    );
    expect(wide.status).toBe(400);
    expect(wide.body.detail).toMatch(/10000 points/);
  });

  it("refuses an operator with no analytics permission", async () => {
    const { call } = await seeded();
    expect(
      (
        await call(
          "GET",
          `/analytics/series?${qs({ metric: "requests", ...RANGE })}`,
          undefined,
          "nobody",
        )
      ).status,
    ).toBe(403);
  });
});

describe("GET /analytics/bans", () => {
  it("counts bans created by source and lifted per bucket, and the active ones, for a scope", async () => {
    const test = await liveApi();
    const { call, clock } = test;
    const first = await call("POST", "/bans", {
      scope: "service:pay",
      ip: "203.0.113.9",
      reason: "x",
    });
    await call("POST", "/bans", {
      scope: "service:shop",
      ip: "198.51.100.1",
      reason: "y",
    });
    clock.advance(2 * HOUR);
    await call("POST", `/bans/${first.body.id}/lift`);
    const from = T0 - HOUR;
    const to = T0 + 4 * HOUR;
    const all = await call(
      "GET",
      `/analytics/bans?${qs({ from, to, bucket: "hour" })}`,
      undefined,
      "vic",
    );
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({
      bucketMs: HOUR,
      active: 1,
      truncated: false,
    });
    const created = all.body.points.reduce(
      (n: number, p: any) => n + (p.created.manual ?? 0),
      0,
    );
    const lifted = all.body.points.reduce(
      (n: number, p: any) => n + p.lifted,
      0,
    );
    expect([created, lifted]).toEqual([2, 1]);
    const group = await call(
      "GET",
      `/analytics/bans?${qs({ scope: "group:payments", from, to })}`,
      undefined,
      "gina",
    );
    expect(
      group.body.points.reduce(
        (n: number, p: any) => n + (p.created.manual ?? 0),
        0,
      ),
    ).toBe(1);
    expect(
      (
        await call(
          "GET",
          `/analytics/bans?${qs({ from, to })}`,
          undefined,
          "nobody",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "GET",
          `/analytics/bans?${qs({ from, to: from + 401 * 24 * HOUR })}`,
          undefined,
          "vic",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          "GET",
          `/analytics/bans?${qs({ from, to: from + 30 * 24 * HOUR, bucket: "minute" })}`,
          undefined,
          "vic",
        )
      ).status,
    ).toBe(400);
  });
});

describe("the documents", () => {
  it("document the analytics reads and the live channel", async () => {
    const { api, call } = await liveApi();
    const paths = Object.keys((await call("GET", "/openapi.json")).body.paths);
    for (const path of [
      "/analytics/series",
      "/analytics/top",
      "/analytics/events",
      "/analytics/events/{id}",
      "/live",
    ]) {
      expect(paths).toContain(path);
    }
    const asyncapi = api.asyncapi() as {
      channels: Record<string, any>;
      operations: Record<string, any>;
    };
    const text = JSON.stringify(asyncapi);
    for (const name of [
      "subscribe",
      "unsubscribe",
      "subscribed",
      "overview",
      "gap",
      "more",
    ]) {
      expect(text).toContain(name);
    }
    expect(Object.keys(asyncapi.channels).length).toBeGreaterThan(1);
  });
});
