/**
 * Alerts from the control plane: a preset rule raising on the counters the
 * agents report, delivered to a webhook on a local receiver that checks the
 * signature, and a channel's rate limit holding a flood for a digest.
 *
 * ```bash
 * bun 22-alerts/alerts.ts
 * ```
 *
 * - **Rules** are kept in the store (`PUT /alerts/rules/:id`); a preset
 *   (`alertRulePreset`) is a ready one: `ruleTripped` raises when one rule
 *   hits 5 times or more in an hour. `alerts.evaluate()` runs the rules
 *   (every minute, on a timer, unless `timers: false`).
 * - **A webhook channel** (`POST /alerts/channels`) gets a signing secret,
 *   shown once. Each message carries `x-bun-security-timestamp` and
 *   `x-bun-security-signature: sha256=<hex>`, the HMAC-SHA256 of
 *   `<timestamp>.<body>` (`signWebhook`), which the receiver recomputes. A
 *   loopback `http://` URL is accepted; any other must be `https://`.
 * - **Per channel**, one message a minute per kind and 60 an hour (only
 *   critical past it); the rest is held and sent as one digest every 15
 *   minutes (`ALERT_RATE_LIMITS`).
 * - Deliveries go through a queue with retries (`memoryDeliveryQueue`, or
 *   bun-jobs' with `jobsDeliveryQueue`); here its timers are off and the
 *   example works it by hand, on a fake clock.
 */
import { Buffer } from "node:buffer";
import { generateKeyPairSync, timingSafeEqual } from "node:crypto";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import {
  ALERT_RATE_LIMITS,
  alertRulePreset,
  createSecurityApi,
  memoryDeliveryQueue,
  signWebhook,
} from "@kingsleyweb/bun-security/control";
import type { MemoryDeliveryQueue } from "@kingsleyweb/bun-security/control";
import { memoryStore } from "@kingsleyweb/bun-security/store";
import { check, checkEqual, summary } from "../shared/check";
import { fakeClock } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("alerts: a preset rule, a signed webhook, limits and a digest");

const MINUTE = 60_000;

/* ------------------------------------------------------------------ */
step("a local receiver, as a pager or chat bridge would be");

/** What the receiver was sent. */
const received: { headers: Headers; body: string }[] = [];
const receiver = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    received.push({ headers: request.headers, body: await request.text() });
    return new Response(null, { status: 204 });
  },
});

const clock = fakeClock();
const store = memoryStore({ now: clock.now });
let queue: MemoryDeliveryQueue | undefined;
const api = createSecurityApi({
  store,
  authenticate: () => ({ id: "alice", name: "Alice" }),
  owners: ["alice"],
  allowWithoutStepUp: true,
  signing: {
    keyId: "sk_example",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  },
  audit: {
    signing: {
      keyId: "ak_example",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    },
    allowNoExternalCheckpoints: true,
  },
  bans: { secret: "fleet-keying-secret-for-the-example-0123456789" },
  alerts: {
    // The example runs the rules and the queue itself.
    timers: false,
    queue: (deliver) => {
      queue = memoryDeliveryQueue({ deliver, now: clock.now, timers: false });
      return queue;
    },
  },
  now: clock.now,
  logger: () => {},
});
const app = new BunHttpAdapter(0, { logger: () => {} });
app.use(api.basePath, api.router);
const alerts = api.alerts!;

/** Calls the API: the status and the parsed body. */
async function call(method: string, route: string, body?: unknown) {
  const response = await app.fetch(`${api.basePath}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-bun-security-csrf": "1",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? undefined : JSON.parse(text)) as Record<
      string,
      unknown
    >,
  };
}

/* ------------------------------------------------------------------ */
step("a webhook channel and the ruleTripped preset");

const channel = await call("POST", "/alerts/channels", {
  id: "ops",
  name: "Ops pager",
  type: "webhook",
  url: `http://127.0.0.1:${receiver.port}/hook`,
});
checkEqual("201, with the signing secret shown once", channel.status, 201);
const secret = channel.body.secret as string;
check("a secret of 32 characters or more", secret.length >= 32, secret);

const { id: _id, ...preset } = alertRulePreset("ruleTripped", {
  id: "tripped",
  scope: "global",
  channels: ["ops"],
});
show("the preset", preset);
checkEqual(
  "the rule, saved",
  (await call("PUT", "/alerts/rules/tripped", { ...preset, revision: null }))
    .status,
  201,
);

/* ------------------------------------------------------------------ */
step("the agents report a rule hitting 6 times: the rule raises");

await store.addCounters!([
  {
    service: "checkout",
    at: clock.now() - MINUTE,
    metric: "rules",
    dims: { rule: "no-sqlmap", action: "ban", dryRun: "false" },
    value: 6,
  },
]);
const report = await alerts.evaluate();
checkEqual("one alert raised", report.raised, 1);
await queue!.work();
checkEqual("the receiver got one message", received.length, 1);
const message = received[0];
show("the message", JSON.parse(message.body));

/* ------------------------------------------------------------------ */
step("the receiver checks the signature");

const timestamp = message.headers.get("x-bun-security-timestamp")!;
const signature = message.headers.get("x-bun-security-signature")!;
/** Whether `signature` is `sha256=` and the HMAC of `timestamp.body` under `key`, compared in constant time. */
const valid = (key: string, body: string) => {
  const expected = Buffer.from(`sha256=${signWebhook(key, timestamp, body)}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
};
check("signed with the channel's secret", valid(secret, message.body));
check(
  "negative control: another secret does not verify",
  !valid("an-attacker-guessing-at-the-secret-0123456789", message.body),
);
check(
  "negative control: a changed body does not verify",
  !valid(secret, message.body.replace("no-sqlmap", "nothing-to-see")),
);
checkEqual(
  "what it says",
  (({ kind, severity, title: heading }) => ({ kind, severity, heading }))(
    JSON.parse(message.body) as {
      kind: string;
      severity: string;
      title: string;
    },
  ),
  {
    kind: "rule:tripped",
    severity: "warning",
    heading: "A rule tripped repeatedly",
  },
);

/* ------------------------------------------------------------------ */
step("a flood of one kind: one message a minute, the rest held for a digest");

show("ALERT_RATE_LIMITS", ALERT_RATE_LIMITS);
received.length = 0;
for (let i = 0; i < 5; i++) {
  await alerts.raise(
    {
      kind: "flood",
      key: `flood:${i}`,
      severity: "warning",
      scope: "global",
      title: "Something noisy",
      at: clock.now(),
      facts: {},
    },
    ["ops"],
  );
}
await queue!.work();
checkEqual("one sent now", received.length, 1);
checkEqual("no digest before its interval", await alerts.flush(), 0);
clock.advance(ALERT_RATE_LIMITS.digestMs);
checkEqual("a digest at its interval", await alerts.flush(), 1);
await queue!.work();
const digest = JSON.parse(received.at(-1)!.body) as {
  type: string;
  held: { kind: string; count: number }[];
};
show("the digest", digest);
checkEqual(
  "a digest naming the four held",
  [digest.type, digest.held.map(({ kind, count }) => ({ kind, count }))],
  ["digest", [{ kind: "flood", count: 4 }]],
);

alerts.close();
api.close();
await receiver.stop(true);
summary();
