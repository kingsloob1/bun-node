/**
 * Alerting (README §9.3, PR-CP6): rules evaluated over the store (a
 * threshold, per group and by prefix, a rate, a baseline anomaly, a ban
 * storm, a silent agent), raised once while open; the three channels
 * (a signed webhook, Slack, email); the per-channel limits and digests;
 * retries with backoff, dead letters and their replay; the control plane's
 * own alerts routed by kind; and channel secrets sealed at rest.
 */
import type {
  AlertChannelSpec,
  AlertRuleSpec,
  JobsQueueLike,
} from "../../lib/control/index";
import { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { SECURITY_ALERT_KINDS } from "../../lib/control/contract/index";
import {
  ALERT_RATE_LIMITS,
  ALERT_RETRY,
  alertRulePreset,
  jobsDeliveryQueue,
  memoryDeliveryQueue,
  retryDelay,
  signWebhook,
} from "../../lib/control/index";
import { sealedFields } from "../../lib/sealing/index";
import { sqliteStore, storeTables } from "../../lib/store/index";
import { testApi } from "./helpers";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const dir = mkdtempSync(join(tmpdir(), "bun-security-alerts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** A recording `fetch`: answers `status()` (200 by default). */
function fakeFetch() {
  const calls: {
    url: string;
    headers: Record<string, string>;
    body: string;
  }[] = [];
  let status = 200;
  return {
    calls,
    setStatus: (next: number) => {
      status = next;
    },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: typeof init.body === "string" ? init.body : "",
      });
      return new Response("", { status });
    },
  };
}

const WEBHOOK: AlertChannelSpec = {
  id: "hook",
  name: "Ops webhook",
  type: "webhook",
  url: "https://hooks.example.com/ops",
  secret: "a-webhook-secret-of-at-least-32-bytes!",
};

/** An API with alerting on a fake fetch and email, its timers off, a group and two services. */
async function alertingApi(extra: Parameters<typeof testApi>[0] = {}) {
  const net = fakeFetch();
  const emails: { to: readonly string[]; subject: string; text: string }[] = [];
  const test = testApi({
    alerts: {
      timers: false,
      fetch: net.fetch,
      email: async (message) => {
        emails.push(message);
      },
      queue: (deliver) =>
        memoryDeliveryQueue({
          deliver,
          now: () => test.clock.now(),
          timers: false,
          random: () => 0.5,
        }),
    },
    ...extra,
  });
  const alerts = test.api.alerts!;
  closers.push(() => alerts.close());
  await test.call("POST", "/groups", { id: "payments", name: "Payments" });
  await test.call("POST", "/services", {
    id: "pay",
    name: "Pay",
    groups: ["payments"],
  });
  await test.call("POST", "/services", { id: "shop", name: "Shop" });
  const { store } = test;
  const channel = async (spec: AlertChannelSpec) => {
    await store.put("alertChannel", spec.id, spec, null);
  };
  const rule = async (spec: AlertRuleSpec) => {
    await store.put("alertRule", spec.id, spec, null);
  };
  const work = async () => {
    await (alerts.queue as ReturnType<typeof memoryDeliveryQueue>).work();
  };
  return { ...test, alerts, net, emails, channel, rule, work };
}

/** A counter row of `service` now. */
const row = (
  at: number,
  service: string,
  metric: string,
  value: number,
  dims?: Record<string, string>,
) => ({
  service,
  at,
  metric,
  value,
  ...(dims === undefined ? {} : { dims }),
});

describe("rules", () => {
  it("a threshold raises once while it holds, closes when it stops, and raises again", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await t.rule({
      id: "blocks",
      title: "Many blocks",
      scope: "global",
      severity: "warning",
      channels: ["hook"],
      condition: {
        type: "threshold",
        metric: "requests",
        dims: { action: "block" },
        windowMs: 5 * MINUTE,
        value: 10,
      },
    });
    const now = t.clock.now();
    await t.store.addCounters!([
      row(now - MINUTE, "pay", "requests", 12, { action: "block" }),
    ]);
    expect(await t.alerts.evaluate()).toMatchObject({
      rules: 1,
      raised: 1,
      closed: 0,
    });
    expect(await t.alerts.evaluate()).toMatchObject({ raised: 0 });
    await t.work();
    expect(t.net.calls).toHaveLength(1);
    expect(JSON.parse(t.net.calls[0]!.body)).toMatchObject({
      type: "alert",
      kind: "rule:blocks",
      severity: "warning",
      facts: { value: 12, threshold: 10, windowMs: 5 * MINUTE },
    });
    t.clock.advance(10 * MINUTE);
    expect(await t.alerts.evaluate()).toMatchObject({ raised: 0, closed: 1 });
    await t.store.addCounters!([
      row(t.clock.now() - MINUTE, "pay", "requests", 20, { action: "block" }),
    ]);
    t.clock.advance(2 * MINUTE);
    expect(await t.alerts.evaluate()).toMatchObject({ raised: 1 });
  });

  it("a scope reads what is under it: a group's rule sees its service, not another", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await t.rule({
      id: "group",
      title: "Group blocks",
      scope: "group:payments",
      severity: "warning",
      channels: ["hook"],
      condition: {
        type: "threshold",
        metric: "requests",
        windowMs: 5 * MINUTE,
        value: 5,
      },
    });
    await t.store.addCounters!([
      row(t.clock.now() - MINUTE, "shop", "requests", 50),
    ]);
    expect((await t.alerts.evaluate()).raised).toBe(0);
    await t.store.addCounters!([
      row(t.clock.now() - MINUTE, "pay", "requests", 5),
    ]);
    expect((await t.alerts.evaluate()).raised).toBe(1);
  });

  it("per group, by prefix: each canary rule raises its own critical alert; an account's rule id is redacted", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await t.rule(
      alertRulePreset("canaryUsed", {
        id: "canary",
        scope: "global",
        channels: ["hook"],
      }),
    );
    await t.rule({
      ...alertRulePreset("ruleTripped", {
        id: "tripped",
        scope: "global",
        channels: ["hook"],
      }),
    });
    const at = t.clock.now() - MINUTE;
    await t.store.addCounters!([
      row(at, "pay", "rules", 1, {
        rule: "canary:aws-key",
        action: "ban",
        dryRun: "false",
      }),
      row(at, "pay", "rules", 2, {
        rule: "canary:admin-url",
        action: "ban",
        dryRun: "false",
      }),
      row(at, "pay", "rules", 9, {
        rule: "apiKey:SECRETHMAC",
        action: "block",
        dryRun: "false",
      }),
      row(at, "pay", "rules", 1, {
        rule: "quiet",
        action: "block",
        dryRun: "false",
      }),
    ]);
    const report = await t.alerts.evaluate();
    // Two canary rules hit at all; one rule hit 5 times or more.
    expect(report.raised).toBe(3);
    expect(
      t.alerts
        .open()
        .map((o) => o.key)
        .sort(),
    ).toEqual([
      "rule:canary:canary:admin-url",
      "rule:canary:canary:aws-key",
      "rule:tripped:apiKey:SECRETHMAC",
    ]);
    await t.work();
    const bodies = t.net.calls.map((c) => JSON.parse(c.body));
    expect(bodies.filter((b) => b.severity === "critical")).toHaveLength(2);
    // The alert's text never names the key; its key (internal) does.
    const text = JSON.stringify(bodies);
    expect(text).not.toContain("SECRETHMAC");
    expect(text).toContain("apiKey:[redacted]");
  });

  it("a rate: the average per minute over the window", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await t.rule({
      id: "rate",
      title: "Request rate",
      scope: "global",
      severity: "info",
      channels: ["hook"],
      condition: {
        type: "rate",
        metric: "requests",
        windowMs: 10 * MINUTE,
        value: 100,
      },
    });
    await t.store.addCounters!([
      row(t.clock.now() - MINUTE, "pay", "requests", 900),
    ]);
    expect((await t.alerts.evaluate()).raised).toBe(0);
    await t.store.addCounters!([
      row(t.clock.now() - 2 * MINUTE, "pay", "requests", 200),
    ]);
    expect((await t.alerts.evaluate()).raised).toBe(1);
  });

  it("a baseline: the blocked share 3× its 7-day average at this hour; not when it is ordinary", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await t.rule(
      alertRulePreset("blockRateSpike", {
        id: "spike",
        scope: "global",
        channels: ["hook"],
      }),
    );
    const now = t.clock.now();
    const hour = Math.floor(now / HOUR) * HOUR;
    // Seven earlier days at this hour: 2% blocked.
    const history = [];
    for (let day = 1; day <= 7; day++) {
      history.push(
        {
          ...row(hour - day * DAY, "pay", "requests", 98, { action: "allow" }),
          tier: "hour" as const,
        },
        {
          ...row(hour - day * DAY, "pay", "requests", 2, { action: "block" }),
          tier: "hour" as const,
        },
      );
    }
    await t.store.addCounters!(history);
    // The control: 3% blocked now is ordinary.
    await t.store.addCounters!([
      row(now - MINUTE, "pay", "requests", 1_940, { action: "allow" }),
      row(now - MINUTE, "pay", "requests", 60, { action: "block" }),
    ]);
    expect((await t.alerts.evaluate()).raised).toBe(0);
    // 30% blocked is a spike.
    await t.store.addCounters!([
      row(now - MINUTE, "pay", "requests", 800, { action: "block" }),
    ]);
    expect((await t.alerts.evaluate()).raised).toBe(1);
  });

  it("sustained (crawlerLimited): a crawler limited in each of the last 24 complete hours, across services; clears after an hour with none", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await t.rule(
      alertRulePreset("crawlerLimited", {
        id: "crawler-limited",
        scope: "global",
        channels: ["hook"],
      }),
    );
    // Ten minutes into an hour; the 24 complete hours before it.
    t.clock.advance(HOUR - (t.clock.now() % HOUR) + 10 * MINUTE);
    const hour = Math.floor(t.clock.now() / HOUR) * HOUR;
    const limited = (at: number, service: string, crawler: string) =>
      row(at, service, "crawlers", 1, { crawler, outcome: "limited" });
    const rows = [];
    for (let h = 1; h <= 24; h++) {
      const at = hour - h * HOUR + 5 * MINUTE;
      // Google: limited every hour, alternating between two services'
      // agents (each alone covers half the day: the fleet's sum fires).
      rows.push(limited(at, h % 2 === 0 ? "pay" : "shop", "google"));
      // Bing: every hour but one (the control).
      if (h !== 7) rows.push(limited(at, "pay", "bing"));
      // Requests are not limits.
      rows.push(
        row(at, "pay", "crawlers", 50, {
          crawler: "apple",
          outcome: "request",
        }),
      );
    }
    // Hours older than 24 are rolled up; recent ones only per minute: both
    // are read. Move the oldest twelve to the hour tier.
    await t.store.addCounters!(
      rows.map((r) =>
        r.at < hour - 12 * HOUR
          ? { ...r, at: Math.floor(r.at / HOUR) * HOUR, tier: "hour" as const }
          : r,
      ),
    );
    expect(await t.alerts.evaluate()).toMatchObject({ raised: 1 });
    await t.work();
    expect(t.net.calls).toHaveLength(1);
    expect(JSON.parse(t.net.calls[0].body)).toMatchObject({
      kind: "rule:crawler-limited",
      severity: "warning",
      facts: { crawler: "google", hours: 24, value: 24 },
    });
    // The current, incomplete hour is not read: an hour with none ends it.
    t.clock.advance(HOUR);
    expect(await t.alerts.evaluate()).toMatchObject({ raised: 0, closed: 1 });
  });

  it("sustained checks its hours and groupBy", async () => {
    const t = await alertingApi();
    const put = (condition: Record<string, unknown>) =>
      t.call("PUT", "/alerts/rules/s", {
        title: "s",
        scope: "global",
        severity: "info",
        condition: { type: "sustained", metric: "crawlers", ...condition },
        channels: [],
        revision: null,
      });
    expect((await put({ hours: 0 })).status).toBe(400);
    expect((await put({ hours: 169 })).status).toBe(400);
    expect((await put({ hours: 1.5 })).status).toBe(400);
    expect((await put({ hours: 24, groupBy: "a b" })).status).toBe(400);
    // The control: a well-formed one is taken.
    expect((await put({ hours: 24, groupBy: "crawler" })).status).toBe(201);
  });

  it("a ban storm: bans created in the window", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await t.rule({
      id: "storm",
      title: "Ban storm",
      scope: "global",
      severity: "warning",
      channels: ["hook"],
      condition: {
        type: "banStorm",
        windowMs: 5 * MINUTE,
        value: 3,
        source: "manual",
      },
    });
    for (const ip of ["203.0.113.1", "203.0.113.2"]) {
      await t.call("POST", "/bans", { scope: "service:pay", ip, reason: "x" });
    }
    expect((await t.alerts.evaluate()).raised).toBe(0);
    await t.call("POST", "/bans", {
      scope: "service:pay",
      ip: "203.0.113.3",
      reason: "x",
    });
    expect((await t.alerts.evaluate()).raised).toBe(1);
  });

  it("an agent silent for its window, once per agent", async () => {
    const t = await alertingApi({ agents: { allowEphemeralStore: true } });
    await t.channel(WEBHOOK);
    await t.rule(
      alertRulePreset("agentSilent", {
        id: "silent",
        scope: "global",
        channels: ["hook"],
      }),
    );
    expect(
      (await t.call("POST", "/agents", { id: "pay-1", service: "pay" })).status,
    ).toBe(201);
    await t.store.put(
      "agentHealth",
      "pay-1",
      { firstSeen: t.clock.now(), lastSeen: t.clock.now(), reported: null },
      null,
    );
    expect((await t.alerts.evaluate()).raised).toBe(0);
    t.clock.advance(3 * MINUTE);
    expect((await t.alerts.evaluate()).raised).toBe(1);
    expect(t.alerts.open().map((o) => o.key)).toEqual(["rule:silent:pay-1"]);
  });

  it("a rule that fails to evaluate is reported, and does not stop the others", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await t.store.put(
      "alertRule",
      "broken",
      {
        id: "broken",
        title: "x",
        scope: "global",
        severity: "info",
        channels: [],
        condition: { type: "nonsense" },
      },
      null,
    );
    await t.rule({
      id: "ok",
      title: "ok",
      scope: "global",
      severity: "info",
      channels: ["hook"],
      condition: {
        type: "threshold",
        metric: "requests",
        windowMs: MINUTE,
        value: 1,
      },
    });
    await t.store.addCounters!([
      row(t.clock.now() - 1_000, "pay", "requests", 1),
    ]);
    const report = await t.alerts.evaluate();
    expect(report.failed.map((f) => f.rule)).toEqual(["broken"]);
    expect(report.raised).toBe(1);
  });
});

describe("channels", () => {
  /** Raises one alert to a channel. */
  const one = async (
    t: Awaited<ReturnType<typeof alertingApi>>,
    channels: string[],
  ) => {
    await t.alerts.raise(
      {
        kind: "k",
        key: "k1",
        severity: "warning",
        scope: "global",
        title: "A title",
        at: t.clock.now(),
        facts: { value: 3 },
      },
      channels,
    );
    await t.work();
  };

  it("a webhook is signed as CP3's sink: HMAC of timestamp.body", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await one(t, ["hook"]);
    const [call] = t.net.calls;
    expect(call?.url).toBe(WEBHOOK.url);
    const timestamp = call!.headers["x-bun-security-timestamp"]!;
    expect(call!.headers["x-bun-security-signature"]).toBe(
      `sha256=${signWebhook(WEBHOOK.type === "webhook" ? WEBHOOK.secret : "", timestamp, call!.body)}`,
    );
    // The control: another secret's signature differs.
    expect(call!.headers["x-bun-security-signature"]).not.toBe(
      `sha256=${signWebhook("x".repeat(32), timestamp, call!.body)}`,
    );
  });

  it("Slack gets { text }; email goes through the host's hook", async () => {
    const t = await alertingApi();
    await t.channel({
      id: "slack",
      name: "Slack",
      type: "slack",
      url: "https://hooks.slack.example/T0/B0/TOKEN",
    });
    await t.channel({
      id: "mail",
      name: "Mail",
      type: "email",
      to: ["ops@example.com"],
    });
    await one(t, ["slack", "mail"]);
    expect(JSON.parse(t.net.calls[0]!.body)).toEqual({
      text: expect.stringContaining("A title"),
    });
    expect(t.emails).toEqual([
      {
        to: ["ops@example.com"],
        subject: "[warning] A title (global)",
        text: expect.stringContaining("value: 3"),
      },
    ]);
  });

  it("retries with backoff, then a dead letter, visible and replayable", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    t.net.setStatus(503);
    await one(t, ["hook"]);
    for (let attempt = 1; attempt < ALERT_RETRY.attempts; attempt++) {
      expect(t.alerts.deadLetters()).toHaveLength(0);
      t.clock.advance(retryDelay(attempt, () => 0.5));
      await t.work();
    }
    expect(t.net.calls).toHaveLength(ALERT_RETRY.attempts);
    const [letter] = t.alerts.deadLetters();
    expect(letter).toMatchObject({
      channelId: "hook",
      attempts: 6,
      reason: "the channel answered 503",
    });
    expect(t.alerts.stats()).toMatchObject({ dead: 1, failures: 6, sent: 0 });
    t.net.setStatus(200);
    expect(await t.alerts.queue.replay(letter!.id)).toBe(true);
    await t.work();
    expect(t.alerts.deadLetters()).toHaveLength(0);
    expect(t.alerts.stats().sent).toBe(1);
  });

  it("the backoff doubles from 30 s to an hour, with jitter in its upper half", () => {
    expect([1, 2, 3, 8].map((a) => retryDelay(a, () => 1))).toEqual([
      30_000, 60_000, 120_000, 3_600_000,
    ]);
    expect(retryDelay(1, () => 0)).toBe(15_000);
  });

  it("channel secrets and URLs are sealed at rest, and deliveries still go", async () => {
    const path = join(dir, "sealed.sqlite");
    const t = await alertingApi({
      store: sqliteStore({
        path,
        codec: sealedFields({
          keys: [{ id: "k1", key: new Uint8Array(32).fill(5) }],
        }),
      }),
    });
    await t.channel(WEBHOOK);
    const raw = new SQL({ url: `sqlite://${path}` });
    const rows = JSON.stringify(
      await raw.unsafe(
        `SELECT doc FROM ${storeTables("bun_security_").docs} WHERE kind = 'alertChannel'`,
      ),
    );
    await raw.close();
    expect(rows).not.toContain("hooks.example.com");
    expect(rows).not.toContain("a-webhook-secret");
    await one(t, ["hook"]);
    expect(t.net.calls[0]?.url).toBe(WEBHOOK.url);
  });
});

describe("rate limits and digests", () => {
  /** An alert of `kind` at `severity`. */
  const alert = (
    t: Awaited<ReturnType<typeof alertingApi>>,
    kind: string,
    severity: "info" | "warning" | "critical" = "warning",
  ) => ({
    kind,
    key: `${kind}:${Math.random()}`,
    severity,
    scope: "global" as const,
    title: kind,
    at: t.clock.now(),
    facts: {},
  });

  it("one message a minute per kind; the rest held for a digest every 15 minutes", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    for (let i = 0; i < 5; i++)
      await t.alerts.raise(alert(t, "flood"), ["hook"]);
    await t.alerts.raise(alert(t, "other"), ["hook"]);
    await t.work();
    expect(t.net.calls.map((c) => JSON.parse(c.body).kind)).toEqual([
      "flood",
      "other",
    ]);
    expect(await t.alerts.flush()).toBe(0);
    t.clock.advance(ALERT_RATE_LIMITS.digestMs);
    expect(await t.alerts.flush()).toBe(1);
    await t.work();
    expect(JSON.parse(t.net.calls.at(-1)!.body)).toMatchObject({
      type: "digest",
      held: [{ kind: "flood", count: 4, severity: "warning" }],
    });
    // A minute later the kind is sent again.
    t.clock.advance(MINUTE);
    await t.alerts.raise(alert(t, "flood"), ["hook"]);
    await t.work();
    expect(JSON.parse(t.net.calls.at(-1)!.body).kind).toBe("flood");
  });

  it("60 messages an hour a channel; past it only critical goes through", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    for (let i = 0; i < 70; i++)
      await t.alerts.raise(alert(t, `k${i}`), ["hook"]);
    await t.alerts.raise(alert(t, "urgent", "critical"), ["hook"]);
    await t.work();
    expect(t.net.calls).toHaveLength(ALERT_RATE_LIMITS.perHour + 1);
    expect(JSON.parse(t.net.calls.at(-1)!.body).severity).toBe("critical");
  });

  it("a channel's limits are its own", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await t.channel({
      ...WEBHOOK,
      id: "hook2",
      url: "https://hooks.example.com/two",
    });
    await t.alerts.raise(alert(t, "flood"), ["hook"]);
    await t.alerts.raise(alert(t, "flood"), ["hook2"]);
    await t.work();
    expect(t.net.calls.map((c) => c.url).sort()).toEqual([
      "https://hooks.example.com/ops",
      "https://hooks.example.com/two",
    ]);
  });
});

describe("the control plane's own alerts", () => {
  it("reach the channels that receive their kind at their severity", async () => {
    const t = await alertingApi();
    await t.channel({
      ...WEBHOOK,
      id: "all",
      receives: { kinds: ["*"], minSeverity: "warning" },
    });
    await t.channel({
      ...WEBHOOK,
      id: "glass",
      url: "https://hooks.example.com/glass",
      receives: { kinds: ["breakGlass.login"] },
    });
    await t.channel({
      ...WEBHOOK,
      id: "none",
      url: "https://hooks.example.com/none",
    });
    t.api.plane.alert({
      kind: "breakGlass.login",
      severity: "critical",
      message: "break-glass login",
      detail: {},
    });
    t.api.plane.alert({
      kind: "checkpoint.sinkFailed",
      severity: "info",
      message: "a sink failed",
      detail: {},
    });
    await Bun.sleep(10);
    await t.work();
    const byUrl = t.net.calls.map((c) => [c.url, JSON.parse(c.body).kind]);
    expect(byUrl.sort()).toEqual([
      ["https://hooks.example.com/glass", "breakGlass.login"],
      ["https://hooks.example.com/ops", "breakGlass.login"],
    ]);
  });
});

describe("queues", () => {
  it("a bounded in-process queue counts what it drops", async () => {
    const queue = memoryDeliveryQueue({
      deliver: async () => {},
      now: () => 0,
      timers: false,
      maxPending: 2,
    });
    for (let i = 0; i < 5; i++)
      await queue.enqueue("c", { type: "digest", at: 0, held: [] });
    expect(queue.stats()).toMatchObject({ pending: 2, dropped: 3 });
    await queue.work();
    expect(queue.stats()).toMatchObject({ pending: 0, sent: 2 });
    queue.close();
  });

  it("on bun-jobs: one job per delivery, with the retry policy as attempts and backoff", async () => {
    const added: Parameters<JobsQueueLike["add"]>[] = [];
    const queue = jobsDeliveryQueue({
      queue: {
        add: async (...args) => {
          added.push(args);
        },
      },
      deadLetter: "alerts-dead",
      now: () => 0,
    });
    await queue.enqueue("hook", { type: "digest", at: 0, held: [] });
    expect(added).toHaveLength(1);
    expect(added[0]![0]).toBe("bun-security.alert");
    expect(added[0]![1]).toMatchObject({ channelId: "hook", attempts: 0 });
    expect(added[0]![2]).toEqual({
      attempts: 6,
      backoff: {
        type: "exponential",
        delay: 30_000,
        max: 3_600_000,
        jitter: 0.5,
      },
      deadLetter: "alerts-dead",
    });
  });
});

describe("what an alert may carry (the user's rule, 2026-11-17)", () => {
  const USER = "USERHMAC0f3a9";
  const KEY = "KEYHMAC7c21e";
  const IP = "198.51.100.7";
  const OTHER_IP = "203.0.113.99";

  it("every kind's body holds no user or API-key subject, and an address only on the alert about it", async () => {
    const emails: string[] = [];
    const posted: { url: string; body: string }[] = [];
    const t = await alertingApi({
      alerts: {
        timers: false,
        fetch: async (url, init) => {
          posted.push({
            url,
            body: typeof init.body === "string" ? init.body : "",
          });
          return new Response("", { status: 200 });
        },
        email: async (message) => {
          emails.push(`${message.subject}\n${message.text}`);
        },
        uiUrl: "https://security.example.com/ui",
        queue: (deliver) =>
          memoryDeliveryQueue({
            deliver,
            now: () => t.clock.now(),
            timers: false,
          }),
      },
    });
    const all = { kinds: ["*"] };
    await t.channel({ ...WEBHOOK, receives: all });
    await t.channel({
      id: "slack",
      name: "Slack",
      type: "slack",
      url: "https://hooks.slack.example/T0/B0/X",
      receives: all,
    });
    await t.channel({
      id: "mail",
      name: "Mail",
      type: "email",
      to: ["ops@example.com"],
      receives: all,
    });
    const channels = ["hook", "slack", "mail"];
    const presets = [
      "ruleTripped",
      "subjectRefusedHeavily",
      "canaryUsed",
      "eventCapReached",
      "banStorm",
    ] as const;
    for (const name of presets)
      await t.rule(
        alertRulePreset(name, { id: name, scope: "global", channels }),
      );
    // A rule grouping account subjects (an analyst might write one).
    await t.rule({
      id: "accounts",
      title: "Accounts refused",
      scope: "global",
      severity: "warning",
      channels,
      condition: {
        type: "threshold",
        metric: "top.refused",
        groupBy: "subject",
        windowMs: 3_600_000,
        value: 1,
      },
    });
    const at = t.clock.now() - 60_000;
    await t.store.addCounters!([
      row(at, "pay", "rules", 9, {
        rule: `user:${USER}`,
        action: "block",
        dryRun: "false",
      }),
      row(at, "pay", "rules", 9, {
        rule: `apiKey:${KEY}`,
        action: "block",
        dryRun: "false",
      }),
      row(at, "pay", "rules", 1, {
        rule: "canary:aws",
        action: "ban",
        dryRun: "false",
      }),
      row(at, "pay", "top.refused", 1_500, { kind: "ip", subject: IP }),
      row(at, "pay", "top.refused", 5, { kind: "user", subject: USER }),
      row(at, "pay", "top.refused", 5, { kind: "apiKey", subject: KEY }),
      row(at, "pay", "events.capped", 1, { cap: "day" }),
    ]);
    for (let i = 0; i < 3; i++) {
      await t.call("POST", "/bans", {
        scope: "service:pay",
        ip: `192.0.2.${i}`,
        reason: "x",
      });
    }
    await t.rule({
      id: "storm",
      title: "Storm",
      scope: "global",
      severity: "warning",
      channels,
      condition: { type: "banStorm", windowMs: 300_000, value: 1 },
    });
    await t.alerts.evaluate();
    // Every control-plane alert kind, its detail naming subjects.
    for (const kind of SECURITY_ALERT_KINDS) {
      t.api.plane.alert({
        kind,
        severity: "critical",
        message: `${kind} happened`,
        detail: { user: USER, apiKey: KEY, ip: OTHER_IP, service: "pay" },
      });
    }
    await Bun.sleep(10);
    await t.work();
    // The negative control: the subjects were in hand (the open alerts' internal keys).
    const keys = t.alerts
      .open()
      .map((o) => o.key)
      .join(" ");
    expect(keys).toContain(USER);
    expect(keys).toContain(KEY);
    const webhooks = posted
      .filter((c) => c.url === WEBHOOK.url)
      .map((c) => c.body);
    const slack = posted
      .filter((c) => c.url.includes("slack"))
      .map((c) => c.body);
    const bodies = [...webhooks, ...slack, ...emails];
    expect(webhooks.length).toBeGreaterThanOrEqual(
      presets.length + SECURITY_ALERT_KINDS.length,
    );
    expect(slack).toHaveLength(webhooks.length);
    expect(emails).toHaveLength(webhooks.length);
    for (const body of bodies) {
      expect(body).not.toContain(USER);
      expect(body).not.toContain(KEY);
      expect(body).not.toContain(OTHER_IP);
      expect(body).toContain("https://security.example.com/ui/alerts");
    }
    // The address appears, and only on the alerts about it: the two rules
    // grouping refused subjects, each for that address's group.
    const withIp = webhooks
      .filter((b) => b.includes(IP))
      .map((b) => JSON.parse(b));
    expect(withIp.map((b) => b.kind).sort()).toEqual([
      "rule:accounts",
      "rule:subjectRefusedHeavily",
    ]);
    for (const b of withIp)
      expect(b.facts).toMatchObject({ ip: IP, value: 1_500 });
    // Each control-plane kind arrived, with its service.
    for (const kind of SECURITY_ALERT_KINDS) {
      expect(
        webhooks.map((b) => JSON.parse(b)).find((b) => b.kind === kind),
      ).toMatchObject({ facts: { service: "pay" } });
    }
  });

  it("the renderer keeps only the allowed facts: a planted subject is dropped, a planted address on a fact named ip shows (the scanner's control)", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await t.alerts.raise(
      {
        kind: "k",
        key: "k",
        severity: "info",
        scope: "global",
        title: "t",
        at: t.clock.now(),
        facts: {
          user: USER,
          apiKey: KEY,
          subject: KEY,
          ip: OTHER_IP,
          value: 1,
        },
      },
      ["hook"],
    );
    await t.work();
    const body = t.net.calls[0]!.body;
    expect(body).not.toContain(USER);
    expect(body).not.toContain(KEY);
    expect(body).toContain(OTHER_IP);
  });
});

describe("route templates in alert content", () => {
  it("grouping by route carries the template; a raw path planted as a fact is dropped", async () => {
    const t = await alertingApi();
    await t.channel(WEBHOOK);
    await t.rule({
      id: "hot-route",
      title: "A route refused heavily",
      scope: "global",
      severity: "warning",
      channels: ["hook"],
      condition: {
        type: "threshold",
        metric: "routes",
        dims: { action: "block" },
        groupBy: "route",
        windowMs: 300_000,
        value: 10,
      },
    });
    await t.store.addCounters!([
      row(t.clock.now() - 60_000, "pay", "routes", 12, {
        route: "POST /login",
        action: "block",
      }),
    ]);
    expect((await t.alerts.evaluate()).raised).toBe(1);
    await t.alerts.raise(
      {
        kind: "planted",
        key: "p",
        severity: "info",
        scope: "global",
        title: "t",
        at: t.clock.now(),
        facts: { path: "/reset?token=SECRET1", value: 1 },
      },
      ["hook"],
    );
    await t.alerts.raise(
      {
        kind: "planted2",
        key: "p2",
        severity: "info",
        scope: "global",
        title: "t",
        at: t.clock.now(),
        facts: { route: "/reset?token=SECRET2", value: 1 },
      },
      ["hook"],
    );
    await t.work();
    const bodies = t.net.calls.map((c) => JSON.parse(c.body));
    expect(bodies.find((b) => b.kind === "rule:hot-route").facts).toMatchObject(
      { route: "POST /login", value: 12 },
    );
    const planted = JSON.stringify(
      bodies.filter((b) => b.kind !== "rule:hot-route"),
    );
    expect(planted).not.toContain("SECRET1");
    expect(planted).not.toContain("SECRET2");
    expect(planted).not.toContain("/reset");
  });
});
