/**
 * PR-AN's reads and the false-positive flag at the control plane: a series
 * grouped by service, bounded and scoped; the distinct count; the highest
 * offence scores; the new metrics under CP5's rules (a viewer sees rule and
 * pattern ids redacted, an account kind needs events:read); the flag (one
 * per event, counted against every rule it hit, audited intent-first,
 * events:read on its service, shown per event only to events:read); intel
 * status in the heartbeat. Each with its negative control.
 */
import { describe, expect, it } from "bun:test";
import { isHeartbeat } from "../../lib/control/agentRoutes";
import { fullEvent, liveApi, SECRET_SUBJECTS, T0 } from "./liveFixtures";

const HOUR = 3_600_000;
const RANGE = { from: T0, to: T0 + HOUR };

/** A query string. */
const qs = (params: Record<string, string | number>) =>
  new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  ).toString();

describe("a series grouped by service", () => {
  it("one point per service, the scope's services only; the control ungrouped sums them", async () => {
    const { store, call } = await liveApi();
    await store.addCounters!([
      {
        service: "pay",
        at: T0,
        metric: "requests",
        dims: { action: "block" },
        value: 2,
      },
      {
        service: "shop",
        at: T0,
        metric: "requests",
        dims: { action: "block" },
        value: 5,
      },
    ]);
    const grouped = await call(
      "GET",
      `/analytics/series?${qs({ metric: "requests", groupBy: "service", tier: "minute", ...RANGE })}`,
    );
    expect(grouped.status).toBe(200);
    expect(grouped.body.points.map((p: any) => [p.service, p.value])).toEqual([
      ["pay", 2],
      ["shop", 5],
    ]);
    const scoped = await call(
      "GET",
      `/analytics/series?${qs({ metric: "requests", groupBy: "service", scope: "group:payments", tier: "minute", ...RANGE })}`,
    );
    expect(scoped.body.points.map((p: any) => p.service)).toEqual(["pay"]);
    const summed = await call(
      "GET",
      `/analytics/series?${qs({ metric: "requests", tier: "minute", ...RANGE })}`,
    );
    expect(summed.body.points).toEqual([
      { at: T0, dims: { action: "block" }, value: 7 },
    ]);
  });
});

describe("the distinct count", () => {
  it("distinct refused addresses for a scope; an account kind needs events:read", async () => {
    const { store, call } = await liveApi();
    await store.addCounters!(
      ["192.0.2.1", "192.0.2.2", "192.0.2.1"].map((subject, i) => ({
        service: i === 2 ? "shop" : "pay",
        tier: "day" as const,
        at: T0 - (T0 % 86_400_000),
        metric: "refused",
        dims: { kind: "ip", subject },
        value: 1,
      })),
    );
    const day = {
      from: T0 - (T0 % 86_400_000),
      to: T0 - (T0 % 86_400_000) + 86_400_000,
    };
    const all = await call(
      "GET",
      `/analytics/distinct?${qs({ metric: "refused", kind: "ip", tier: "day", ...day })}`,
      undefined,
      "vic",
    );
    expect(all.body).toEqual({ count: 2, other: false });
    const pay = await call(
      "GET",
      `/analytics/distinct?${qs({ metric: "refused", kind: "ip", tier: "day", scope: "service:shop", ...day })}`,
      undefined,
      "vic",
    );
    expect(pay.body).toEqual({ count: 1, other: false });
    expect(
      (
        await call(
          "GET",
          `/analytics/distinct?${qs({ metric: "refused", kind: "user", tier: "day", ...day })}`,
          undefined,
          "vic",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "GET",
          `/analytics/distinct?${qs({ metric: "refused", kind: "user", tier: "day", ...day })}`,
          undefined,
          "ann",
        )
      ).status,
    ).toBe(200);
  });
});

describe("the highest offence scores", () => {
  it("each address's highest score its events carried, the highest first", async () => {
    const { store, call } = await liveApi();
    await store.appendEvents!("b", [
      fullEvent("e1", "pay", { score: 4, subjects: { ip: "192.0.2.1" } }),
      fullEvent("e2", "pay", {
        score: 9,
        at: T0 + 10,
        subjects: { ip: "192.0.2.1" },
      }),
      fullEvent("e3", "shop", { score: 6, subjects: { ip: "192.0.2.2" } }),
      fullEvent("e4", "shop", { subjects: { ip: "192.0.2.3" } }),
    ]);
    const scores = await call(
      "GET",
      `/analytics/scores?${qs(RANGE)}`,
      undefined,
      "vic",
    );
    expect(scores.body).toEqual({
      rows: [
        { subject: "192.0.2.1", score: 9, at: T0 + 10 },
        { subject: "192.0.2.2", score: 6, at: T0 },
      ],
      truncated: false,
    });
    const scoped = await call(
      "GET",
      `/analytics/scores?${qs({ ...RANGE, scope: "group:payments" })}`,
      undefined,
      "vic",
    );
    expect(scoped.body.rows.map((r: any) => r.subject)).toEqual(["192.0.2.1"]);
    // The event's score is in its view, a viewer's too.
    const page = await call("GET", "/analytics/events", undefined, "vic");
    expect(page.body.items.find((e: any) => e.id === "e2").score).toBe(9);
  });
});

describe("the new metrics under CP5's rules", () => {
  it("a viewer sees rule ids in rules.falsePositive and pattern ids in patterns as viewer rules; an analyst whole", async () => {
    const { store, call } = await liveApi();
    await store.addCounters!([
      {
        service: "pay",
        at: T0,
        metric: "rules.false-positive",
        dims: { rule: `apiKey:${SECRET_SUBJECTS.apiKey}` },
        value: 1,
      },
      {
        service: "pay",
        at: T0,
        metric: "patterns",
        dims: { pattern: `user:${SECRET_SUBJECTS.user}` },
        value: 1,
      },
    ]);
    for (const metric of ["rules.false-positive", "patterns"]) {
      const viewer = await call(
        "GET",
        `/analytics/top?${qs({ metric, ...RANGE })}`,
        undefined,
        "vic",
      );
      expect(JSON.stringify(viewer.body)).not.toContain("SECRET");
      expect(JSON.stringify(viewer.body)).toContain("[redacted]");
      const analyst = await call(
        "GET",
        `/analytics/top?${qs({ metric, ...RANGE })}`,
        undefined,
        "ann",
      );
      expect(JSON.stringify(analyst.body)).toContain("SECRET");
    }
  });

  it("a subject metric names its kind; the hourly refused tier and top.pattern read an address for a viewer", async () => {
    const { store, call } = await liveApi();
    await store.addCounters!([
      {
        service: "pay",
        tier: "hour",
        at: T0,
        metric: "refused.hourly",
        dims: { kind: "ip", subject: "192.0.2.1" },
        value: 3,
      },
      {
        service: "pay",
        at: T0,
        metric: "top.pattern",
        dims: { pattern: "disposable", kind: "ip", subject: "192.0.2.1" },
        value: 2,
      },
    ]);
    const hourly = await call(
      "GET",
      `/analytics/series?${qs({ metric: "refused.hourly", kind: "ip", subject: "192.0.2.1", tier: "hour", ...RANGE })}`,
      undefined,
      "vic",
    );
    expect(hourly.body.points.map((p: any) => p.value)).toEqual([3]);
    expect(
      (
        await call(
          "GET",
          `/analytics/top?${qs({ metric: "top.pattern", kind: "ip", pattern: "disposable", ...RANGE })}`,
          undefined,
          "vic",
        )
      ).body.rows,
    ).toEqual([
      {
        dims: { pattern: "disposable", kind: "ip", subject: "192.0.2.1" },
        value: 2,
      },
    ]);
    // The controls: no kind is a 400; an account kind is the analyst's.
    expect(
      (
        await call(
          "GET",
          `/analytics/top?${qs({ metric: "refused.hourly", ...RANGE })}`,
          undefined,
          "vic",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          "GET",
          `/analytics/top?${qs({ metric: "refused.hourly", kind: "user", ...RANGE })}`,
          undefined,
          "vic",
        )
      ).status,
    ).toBe(403);
  });
});

describe("the false-positive flag", () => {
  it("counts once against every rule the event hit, audited intent-first; a repeat says already", async () => {
    const { store, call } = await liveApi();
    await store.appendEvents!("b", [fullEvent("e1", "pay")]);
    const first = await call(
      "POST",
      "/events/e1/false-positive",
      undefined,
      "ann",
    );
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      already: false,
      rules: [`apiKey:${SECRET_SUBJECTS.apiKey}`, "r-plain"],
    });
    const again = await call(
      "POST",
      "/events/e1/false-positive",
      undefined,
      "ann",
    );
    expect(again.body.already).toBe(true);
    const top = await call(
      "GET",
      `/analytics/top?${qs({ metric: "rules.false-positive", from: T0, to: Date.now() + HOUR, tier: "minute" })}`,
      undefined,
      "ann",
    );
    expect(
      top.body.rows.map((r: any) => [r.dims.rule, r.value]).sort(),
    ).toEqual([
      [`apiKey:${SECRET_SUBJECTS.apiKey}`, 1],
      ["r-plain", 1],
    ]);
    const audit = (await call("GET", "/audit?limit=200")).body.items.filter(
      (e: any) => e.action === "event.falsePositive",
    );
    expect(audit.map((e: any) => e.phase).sort()).toEqual([
      "done",
      "done",
      "intent",
      "intent",
    ]);
    expect(audit.find((e: any) => e.phase === "intent").actor).toBe("ann");
  });

  it("needs events:read on the event's service; an unknown event is a 404", async () => {
    const { store, call } = await liveApi();
    await store.appendEvents!("b", [fullEvent("e1", "shop")]);
    expect(
      (await call("POST", "/events/e1/false-positive", undefined, "vic"))
        .status,
    ).toBe(403);
    // gina is an analyst of payments only.
    expect(
      (await call("POST", "/events/e1/false-positive", undefined, "gina"))
        .status,
    ).toBe(403);
    expect(
      (await call("POST", "/events/nope/false-positive", undefined, "ann"))
        .status,
    ).toBe(404);
    expect(
      (await call("POST", "/events/e1/false-positive", undefined, "ann"))
        .status,
    ).toBe(200);
  });

  it("the per-event flag is shown to events:read only", async () => {
    const { store, call } = await liveApi();
    await store.appendEvents!("b", [
      fullEvent("e1", "pay"),
      fullEvent("e2", "pay", { at: T0 + 1 }),
    ]);
    await call("POST", "/events/e1/false-positive", undefined, "ann");
    const analyst = await call("GET", "/analytics/events", undefined, "ann");
    expect(
      analyst.body.items.map((e: any) => [e.id, e.falsePositive === true]),
    ).toEqual([
      ["e2", false],
      ["e1", true],
    ]);
    expect(
      (await call("GET", "/analytics/events/e1", undefined, "ann")).body
        .falsePositive,
    ).toBe(true);
    const viewer = await call("GET", "/analytics/events", undefined, "vic");
    expect(
      viewer.body.items.every((e: any) => e.falsePositive === undefined),
    ).toBe(true);
  });
});

describe("intel status in the heartbeat", () => {
  const beat = (intel: unknown) => ({
    route: "heartbeat",
    sentAt: 1,
    agentVersion: "1",
    bundle: null,
    bans: { seq: "0", count: 0 },
    health: "ok",
    intel,
  });
  const feed = {
    id: "tor",
    size: 1200,
    refreshedAt: 10,
    attemptedAt: 20,
    error: "x".repeat(200),
  };
  it("at most 32 feeds of id, size, times and a failure of at most 200 characters", () => {
    expect(
      isHeartbeat(beat({ feeds: Array.from({ length: 32 }, () => feed) })),
    ).toBe(true);
    expect(
      isHeartbeat(
        beat({ feeds: [{ ...feed, refreshedAt: null, attemptedAt: null }] }),
      ),
    ).toBe(true);
    expect(
      isHeartbeat(beat({ feeds: Array.from({ length: 33 }, () => feed) })),
    ).toBe(false);
    expect(
      isHeartbeat(beat({ feeds: [{ ...feed, error: "x".repeat(201) }] })),
    ).toBe(false);
    expect(isHeartbeat(beat({ feeds: [{ ...feed, url: "https://x" }] }))).toBe(
      false,
    );
    expect(isHeartbeat(beat({ feeds: [], extra: 1 }))).toBe(false);
  });
});

describe("the documents", () => {
  it("document the new reads and the flag", async () => {
    const { call } = await liveApi();
    const paths = Object.keys((await call("GET", "/openapi.json")).body.paths);
    for (const path of [
      "/analytics/distinct",
      "/analytics/scores",
      "/events/{id}/false-positive",
    ]) {
      expect(paths).toContain(path);
    }
  });
});
