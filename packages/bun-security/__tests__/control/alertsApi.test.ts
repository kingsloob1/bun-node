/**
 * The alerts routes (PR-CP6), on the user's decisions of 2026-11-17:
 * `alerts:read` (analyst and up) reads rules, the open alerts, the
 * delivery log and dead letters; `alerts:write` (admin) changes rules and
 * channels, reads channels, tests and replays. A channel's secret is shown
 * once and its URL answered as scheme and host, in answers and in the
 * audit log alike; the log and dead letters keep 30 days, 10,000 a
 * channel. Each refusal has its negative control.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  ALERT_RETENTION,
  memoryDeliveryQueue,
  signWebhook,
} from "../../lib/control/index";
import { isHeartbeat } from "../../lib/control/agentRoutes";
import { testApi } from "./helpers";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const HOOK_URL = "https://hooks.example.com/services/T0/SECRETPATH?token=abc";

/** An API with alerting, fake fetch, its timers off; mia an analyst, vic a viewer, ada an admin. */
async function setup() {
  const calls: {
    url: string;
    headers: Record<string, string>;
    body: string;
  }[] = [];
  let status = 200;
  const test = testApi({
    alerts: {
      timers: false,
      fetch: async (url, init) => {
        calls.push({
          url,
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          body: typeof init.body === "string" ? init.body : "",
        });
        return new Response("", { status });
      },
      queue: (deliver) =>
        memoryDeliveryQueue({
          deliver,
          now: () => test.clock.now(),
          timers: false,
          random: () => 0.5,
        }),
    },
  });
  const alerts = test.api.alerts!;
  closers.push(() => alerts.close());
  for (const [operator, role] of [
    ["vic", "viewer"],
    ["mia", "analyst"],
    ["ada", "admin"],
  ] as const) {
    await test.call("POST", "/role-bindings", {
      operator,
      role,
      scope: "global",
    });
  }
  const work = async () =>
    await (alerts.queue as ReturnType<typeof memoryDeliveryQueue>).work();
  return {
    ...test,
    alerts,
    calls,
    work,
    setStatus: (next: number) => {
      status = next;
    },
  };
}

/** A webhook channel made by ada; its answer. */
async function webhook(t: Awaited<ReturnType<typeof setup>>, id = "ops") {
  return await t.call(
    "POST",
    "/alerts/channels",
    { id, name: "Ops", type: "webhook", url: HOOK_URL },
    "ada",
  );
}

const RULE = {
  title: "Many blocks",
  scope: "global",
  severity: "warning",
  condition: {
    type: "threshold",
    metric: "requests",
    windowMs: 300_000,
    value: 10,
  },
  channels: ["ops"],
  revision: null,
};

describe("permissions", () => {
  it("alerts:write is admin's; alerts:read analyst's, not a viewer's", async () => {
    const t = await setup();
    // Channels: an analyst may not make one; an admin may.
    expect(
      (
        await t.call(
          "POST",
          "/alerts/channels",
          {
            id: "x",
            name: "x",
            type: "slack",
            url: "https://hooks.example.com/x",
          },
          "mia",
        )
      ).status,
    ).toBe(403);
    expect((await webhook(t)).status).toBe(201);
    // Channels are read by an analyst (redacted), not by a viewer.
    const listed = await t.call("GET", "/alerts/channels", undefined, "mia");
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([
      {
        id: "ops",
        name: "Ops",
        type: "webhook",
        url: "https://hooks.example.com",
        revision: 1,
      },
    ]);
    expect(
      (await t.call("GET", "/alerts/channels/ops", undefined, "mia")).status,
    ).toBe(200);
    expect(
      (await t.call("GET", "/alerts/channels", undefined, "vic")).status,
    ).toBe(403);
    expect(
      (
        await t.call(
          "PUT",
          "/alerts/channels/ops",
          { name: "x", revision: 1 },
          "mia",
        )
      ).status,
    ).toBe(403);
    // Rules: an analyst reads them but may not write one.
    expect(
      (await t.call("PUT", "/alerts/rules/blocks", RULE, "mia")).status,
    ).toBe(403);
    expect(
      (await t.call("PUT", "/alerts/rules/blocks", RULE, "ada")).status,
    ).toBe(201);
    expect(
      (await t.call("GET", "/alerts/rules", undefined, "mia")).body.items,
    ).toHaveLength(1);
    expect(
      (await t.call("GET", "/alerts/rules/blocks", undefined, "mia")).status,
    ).toBe(200);
    // A viewer sees no rule and no log.
    expect(
      (await t.call("GET", "/alerts/rules", undefined, "vic")).body.items,
    ).toHaveLength(0);
    expect(
      (await t.call("GET", "/alerts/rules/blocks", undefined, "vic")).status,
    ).toBe(403);
    expect(
      (await t.call("GET", "/alerts/deliveries", undefined, "vic")).status,
    ).toBe(403);
    expect(
      (await t.call("GET", "/alerts/dead-letters", undefined, "vic")).status,
    ).toBe(403);
    expect(
      (await t.call("GET", "/alerts/deliveries", undefined, "mia")).status,
    ).toBe(200);
    expect(
      (await t.call("GET", "/alerts/dead-letters", undefined, "mia")).status,
    ).toBe(200);
    // Test and replay are admin's.
    expect(
      (await t.call("POST", "/alerts/channels/ops/test", undefined, "mia"))
        .status,
    ).toBe(403);
    expect(
      (await t.call("POST", "/alerts/channels/ops/test", undefined, "ada"))
        .status,
    ).toBe(202);
  });

  it("the built-in roles carry the two permissions", async () => {
    const t = await setup();
    const of = async (op: string) =>
      (await t.call("GET", "/meta/permissions", undefined, op)).body
        .permissions as Record<string, boolean>;
    expect(await of("vic")).toMatchObject({
      "alerts:read": false,
      "alerts:write": false,
    });
    expect(await of("mia")).toMatchObject({
      "alerts:read": true,
      "alerts:write": false,
    });
    expect(await of("ada")).toMatchObject({
      "alerts:read": true,
      "alerts:write": true,
    });
  });
});

describe("rules", () => {
  it("are checked: a bad condition or an unknown channel is a 400; a stale revision a 409", async () => {
    const t = await setup();
    await webhook(t);
    const bad = await t.call(
      "PUT",
      "/alerts/rules/r",
      {
        ...RULE,
        condition: {
          type: "threshold",
          metric: "requests",
          windowMs: -1,
          value: 1,
        },
      },
      "ada",
    );
    expect(bad.status).toBe(400);
    const missing = await t.call(
      "PUT",
      "/alerts/rules/r",
      { ...RULE, channels: ["nope"] },
      "ada",
    );
    expect(missing.status).toBe(400);
    const made = await t.call("PUT", "/alerts/rules/r", RULE, "ada");
    expect(made.body).toMatchObject({ id: "r", enabled: true, revision: 1 });
    expect((await t.call("PUT", "/alerts/rules/r", RULE, "ada")).status).toBe(
      409,
    );
    const updated = await t.call(
      "PUT",
      "/alerts/rules/r",
      { ...RULE, enabled: false, revision: 1 },
      "ada",
    );
    expect(updated.body).toMatchObject({ enabled: false, revision: 2 });
    // A channel a rule sends to cannot be deleted; once the rule is gone it can.
    expect(
      (
        await t.call(
          "DELETE",
          "/alerts/channels/ops?revision=1",
          undefined,
          "ada",
        )
      ).status,
    ).toBe(409);
    expect(
      (await t.call("DELETE", "/alerts/rules/r?revision=1", undefined, "ada"))
        .status,
    ).toBe(409);
    expect(
      (await t.call("DELETE", "/alerts/rules/r?revision=2", undefined, "ada"))
        .status,
    ).toBe(204);
    expect(
      (
        await t.call(
          "DELETE",
          "/alerts/channels/ops?revision=1",
          undefined,
          "ada",
        )
      ).status,
    ).toBe(204);
    const audit = (await t.call("GET", "/audit?limit=200")).body.items.map(
      (e: any) => `${e.action}:${e.phase}`,
    );
    expect(audit).toContain("alertRule.put:intent");
    expect(audit).toContain("alertRule.delete:intent");
    expect(audit).toContain("alertChannel.delete:intent");
  });

  it("the open alerts answer the rule and scope, never the key", async () => {
    const t = await setup();
    await webhook(t);
    await t.call(
      "PUT",
      "/alerts/rules/per-subject",
      {
        ...RULE,
        condition: {
          type: "threshold",
          metric: "top.refused",
          dims: { kind: "apiKey" },
          groupBy: "subject",
          windowMs: 3_600_000,
          value: 1,
        },
      },
      "ada",
    );
    await t.store.addCounters!([
      {
        service: "pay",
        at: t.clock.now() - 60_000,
        metric: "top.refused",
        value: 5,
        dims: { kind: "apiKey", subject: "KEYHMAC123" },
      },
    ]);
    expect((await t.alerts.evaluate()).raised).toBe(1);
    // The control: the key held the subject internally.
    expect(t.alerts.open()[0]!.key).toContain("KEYHMAC123");
    const open = await t.call("GET", "/alerts/open", undefined, "mia");
    expect(open.body.items).toEqual([
      { rule: "per-subject", scope: "global", since: t.clock.now() },
    ]);
    expect(JSON.stringify(open.body)).not.toContain("KEYHMAC123");
  });
});

describe("channel secrets and URLs are write-only", () => {
  it("a webhook's secret is shown once; its URL as scheme and host; neither in the audit log", async () => {
    const t = await setup();
    const made = await webhook(t);
    const secret = made.body.secret as string;
    expect(secret.length).toBeGreaterThanOrEqual(43);
    expect(made.body.channel).toEqual({
      id: "ops",
      name: "Ops",
      type: "webhook",
      url: "https://hooks.example.com",
      revision: 1,
    });
    const read = JSON.stringify([
      (await t.call("GET", "/alerts/channels", undefined, "ada")).body,
      (await t.call("GET", "/alerts/channels/ops", undefined, "ada")).body,
      (await t.call("GET", "/audit?limit=200")).body,
    ]);
    expect(read).not.toContain(secret);
    expect(read).not.toContain("SECRETPATH");
    expect(read).not.toContain("token=abc");
    // The control: the stored channel holds both, and signs with the secret.
    const stored = (await t.store.get("alertChannel", "ops"))!.doc as {
      url: string;
      secret: string;
    };
    expect(stored).toMatchObject({ url: HOOK_URL, secret });
    await t.call("POST", "/alerts/channels/ops/test", undefined, "ada");
    await t.work();
    const call = t.calls[0]!;
    expect(call.url).toBe(HOOK_URL);
    expect(call.headers["x-bun-security-signature"]).toBe(
      `sha256=${signWebhook(secret, call.headers["x-bun-security-timestamp"]!, call.body)}`,
    );
  });

  it("rotating gives a new secret once, and signing uses it", async () => {
    const t = await setup();
    const first = (await webhook(t)).body.secret as string;
    const rotated = await t.call(
      "POST",
      "/alerts/channels/ops/secret",
      { revision: 1 },
      "ada",
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).not.toBe(first);
    expect(rotated.body.channel.revision).toBe(2);
    await t.call("POST", "/alerts/channels/ops/test", undefined, "ada");
    await t.work();
    const call = t.calls[0]!;
    const ts = call.headers["x-bun-security-timestamp"]!;
    expect(call.headers["x-bun-security-signature"]).toBe(
      `sha256=${signWebhook(rotated.body.secret, ts, call.body)}`,
    );
    expect(call.headers["x-bun-security-signature"]).not.toBe(
      `sha256=${signWebhook(first, ts, call.body)}`,
    );
  });

  it("an update keeps the URL unless one is given; URLs must be https or loopback, without credentials", async () => {
    const t = await setup();
    await webhook(t);
    const renamed = await t.call(
      "PUT",
      "/alerts/channels/ops",
      { name: "Ops 2", revision: 1 },
      "ada",
    );
    expect(renamed.body).toMatchObject({
      name: "Ops 2",
      url: "https://hooks.example.com",
    });
    expect(
      ((await t.store.get("alertChannel", "ops"))!.doc as { url: string }).url,
    ).toBe(HOOK_URL);
    for (const url of [
      "http://hooks.example.com/x",
      "https://u:p@hooks.example.com/x",
      "ftp://x.example.com/",
    ]) {
      expect(
        (
          await t.call(
            "POST",
            "/alerts/channels",
            { id: "bad", name: "b", type: "slack", url },
            "ada",
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await t.call(
          "POST",
          "/alerts/channels",
          {
            id: "local",
            name: "l",
            type: "slack",
            url: "http://127.0.0.1:9/x",
          },
          "ada",
        )
      ).status,
    ).toBe(201);
    // Slack and email have no secret.
    const mail = await t.call(
      "POST",
      "/alerts/channels",
      { id: "mail", name: "m", type: "email", to: ["ops@example.com"] },
      "ada",
    );
    expect(mail.body).toEqual({
      channel: {
        id: "mail",
        name: "m",
        type: "email",
        to: ["ops@example.com"],
        revision: 1,
      },
    });
  });
});

describe("the delivery log and dead letters", () => {
  it("show each try's outcome, never the message; a dead letter replays", async () => {
    const t = await setup();
    await webhook(t);
    t.setStatus(500);
    await t.alerts.raise(
      {
        kind: "k",
        key: "k",
        severity: "critical",
        scope: "global",
        title: "TITLE-TEXT",
        at: t.clock.now(),
        facts: { value: 1 },
      },
      ["ops"],
    );
    for (let i = 0; i < 6; i++) {
      await t.work();
      t.clock.advance(3_600_000);
    }
    const log = (
      await t.call("GET", "/alerts/deliveries?channel=ops", undefined, "mia")
    ).body.items;
    expect(log.map((e: any) => e.outcome)).toEqual([
      "dead",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    const dead = (await t.call("GET", "/alerts/dead-letters", undefined, "mia"))
      .body.items;
    expect(dead).toEqual([
      expect.objectContaining({
        channelId: "ops",
        kind: "k",
        severity: "critical",
        attempts: 6,
        reason: "the channel answered 500",
      }),
    ]);
    expect(JSON.stringify([log, dead])).not.toContain("TITLE-TEXT");
    t.setStatus(200);
    expect(
      (
        await t.call(
          "POST",
          `/alerts/dead-letters/${dead[0].id}/replay`,
          undefined,
          "mia",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await t.call(
          "POST",
          `/alerts/dead-letters/${dead[0].id}/replay`,
          undefined,
          "ada",
        )
      ).status,
    ).toBe(202);
    expect(
      (
        await t.call(
          "POST",
          `/alerts/dead-letters/${dead[0].id}/replay`,
          undefined,
          "ada",
        )
      ).status,
    ).toBe(404);
    await t.work();
    expect(
      (await t.call("GET", "/alerts/deliveries?limit=1", undefined, "mia")).body
        .items[0],
    ).toMatchObject({ outcome: "sent", attempts: 1 });
  });

  it("keep 30 days and at most 10,000 a channel", async () => {
    const t = await setup();
    await webhook(t);
    const delivery = (n: number) => ({
      id: `d${n}`,
      channelId: "ops",
      message: { type: "digest" as const, at: 0, held: [] },
      attempts: 1,
      queuedAt: 0,
    });
    await t.alerts.deliver(delivery(0));
    t.clock.advance(ALERT_RETENTION.maxAgeMs - 1_000);
    expect(t.alerts.deliveries("ops")).toHaveLength(1);
    t.clock.advance(2_000);
    // The control above: just under 30 days it is kept; just over, gone.
    expect(t.alerts.deliveries("ops")).toHaveLength(0);
    for (let n = 1; n <= ALERT_RETENTION.perChannel + 5; n++)
      await t.alerts.deliver(delivery(n));
    const kept = t.alerts.deliveries("ops");
    expect(kept).toHaveLength(ALERT_RETENTION.perChannel);
    expect(kept.some((e) => e.id === "d1")).toBe(false);
    expect(kept.some((e) => e.id === "d6")).toBe(true);
  });

  it("dead letters: per channel and by age", async () => {
    let now = 0;
    const queue = memoryDeliveryQueue({
      deliver: async () => {
        throw new Error("down");
      },
      now: () => now,
      timers: false,
      maxDeadLetters: 2,
      retainMs: 1_000,
      random: () => 0,
    });
    for (const channel of ["a", "a", "a", "b"])
      await queue.enqueue(channel, { type: "digest", at: 0, held: [] });
    for (let i = 0; i < 6; i++) {
      await queue.work();
      now += 4_000_000;
    }
    const letters = queue.deadLetters();
    // Expired: all of them, the last ones having died long ago.
    expect(letters).toHaveLength(0);
    queue.close();
    let clock = 0;
    const kept = memoryDeliveryQueue({
      deliver: async () => {
        throw new Error("down");
      },
      now: () => clock,
      timers: false,
      maxDeadLetters: 2,
      random: () => 0,
    });
    for (const channel of ["a", "a", "a", "b"])
      await kept.enqueue(channel, { type: "digest", at: 0, held: [] });
    for (let i = 0; i < 6; i++) {
      await kept.work();
      clock += 4_000_000;
    }
    expect(
      kept
        .deadLetters()
        .map((l) => l.channelId)
        .sort(),
    ).toEqual(["a", "a", "b"]);
    expect(kept.stats().dropped).toBe(1);
    kept.close();
  });
});

describe("heartbeat warnings are bounded", () => {
  const beat = (warnings: unknown) => ({
    route: "heartbeat",
    sentAt: 1,
    agentVersion: "1",
    bundle: null,
    bans: { seq: "0", count: 0 },
    health: "ok",
    warnings,
  });
  it("at most 16, each a kind, since and share only", () => {
    const one = { kind: "store.unavailable", since: 1, share: 1 };
    expect(isHeartbeat(beat(Array.from({ length: 16 }, () => one)))).toBe(true);
    expect(isHeartbeat(beat(Array.from({ length: 17 }, () => one)))).toBe(
      false,
    );
    expect(isHeartbeat(beat([{ ...one, message: "x" }]))).toBe(false);
    expect(isHeartbeat(beat([{ ...one, share: 2 }]))).toBe(false);
    expect(isHeartbeat(beat([{ ...one, kind: "Not A Kind" }]))).toBe(false);
    const { warnings: _w, ...older } = beat(undefined);
    expect(isHeartbeat(older)).toBe(true);
  });
});

describe("minting a webhook secret needs a step-up", () => {
  it("refused while the hook says no, allowed once fresh; Slack and email mint nothing and need none", async () => {
    let fresh = false;
    const t = testApi({
      allowWithoutStepUp: undefined,
      stepUp: { verify: () => fresh, challenge: () => "/mfa" },
      alerts: { timers: false },
    });
    closers.push(() => t.api.alerts!.close());
    const body = { id: "ops", name: "Ops", type: "webhook", url: HOOK_URL };
    const asked = await t.call("POST", "/alerts/channels", body);
    expect([asked.status, asked.body.code]).toEqual([401, "step_up_required"]);
    expect(await t.store.get("alertChannel", "ops")).toBeUndefined();
    const slack = await t.call("POST", "/alerts/channels", {
      id: "sl",
      name: "S",
      type: "slack",
      url: "https://hooks.example.com/s",
    });
    expect(slack.status).toBe(201);
    fresh = true;
    expect((await t.call("POST", "/alerts/channels", body)).status).toBe(201);
    fresh = false;
    const rotate = await t.call("POST", "/alerts/channels/ops/secret", {
      revision: 1,
    });
    expect(rotate.status).toBe(401);
    fresh = true;
    expect(
      (await t.call("POST", "/alerts/channels/ops/secret", { revision: 1 }))
        .status,
    ).toBe(200);
  });

  it("under two-person approvals with no hook, it is refused", async () => {
    const t = testApi({
      allowWithoutStepUp: undefined,
      approvals: "two-person",
      alerts: { timers: false },
    });
    closers.push(() => t.api.alerts!.close());
    const made = await t.call("POST", "/alerts/channels", {
      id: "ops",
      name: "Ops",
      type: "webhook",
      url: HOOK_URL,
    });
    expect(made.status).toBe(403);
    // The control: a channel that mints no secret is made.
    expect(
      (
        await t.call("POST", "/alerts/channels", {
          id: "mail",
          name: "M",
          type: "email",
          to: ["ops@example.com"],
        })
      ).status,
    ).toBe(201);
  });
});
