/**
 * The numbers and events an analytics page reads, from the engine's
 * decisions: `analyticsHook` feeding the minute counters and the event ring,
 * with a redacted sample of each request, and the counters rolled up into
 * hours, all on a fake clock.
 *
 * ```bash
 * bun 21-analytics/analytics.ts
 * ```
 *
 * - **`createAnalyticsRecorder`** counts each minute by action, route, rule,
 *   status class and latency, and keeps each minute's most refused subjects
 *   (`top.refused`, space-saving top-K: exact while there are no more
 *   subjects than K, an overestimate bounded by the minute's smallest count
 *   past it), and the exact refusals per subject per day; `flush()` answers
 *   the closed minutes' rows, which an agent sends to the control plane.
 * - **`createEventRing`** keeps every refusal (and one `allow` in a
 *   thousand) as an event, within caps per subject and rule.
 * - **`createRedactor`** is what an event keeps of the request: credential
 *   headers and query values, and anything that looks like a token, become
 *   `[redacted]`.
 * - **`analyticsMaintenance(store).run()`** rolls the stored minutes into
 *   hours once an hour has closed and settled (5 minutes' grace), and
 *   deletes by retention: a host's scheduled job.
 */
import { createSecurity } from "@kingsleyweb/bun-security";
import {
  analyticsHook,
  analyticsMaintenance,
  createAnalyticsRecorder,
  createEventRing,
  createRedactor,
} from "@kingsleyweb/bun-security/analytics";
import { memoryStore } from "@kingsleyweb/bun-security/store";
import { check, checkEqual, summary } from "../shared/check";
import { fakeClock, facts } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("analytics: counters, events, redaction, rollups");

const MINUTE = 60_000;
const HOUR = 3_600_000;
const clock = fakeClock(Date.UTC(2026, 10, 19, 9, 0, 0));

const recorder = createAnalyticsRecorder({
  service: "api",
  now: clock.now,
  topK: 3,
});
const ring = createEventRing({
  service: "api",
  recorder,
  now: clock.now,
  // No allow is sampled here, so the events are the refusals alone.
  random: () => 0.999,
  logger: () => {},
});
const security = createSecurity({
  policy: {
    lists: [{ id: "scanners", ip: "203.0.113.0/24", action: "block" }],
  },
  secret: "a-keying-secret-for-the-analytics-example-0123",
  now: clock.now,
  onDecision: analyticsHook({ recorder, ring, redactor: createRedactor() }),
  logger: () => {},
});

/* ------------------------------------------------------------------ */
step("a minute of traffic: ordinary clients and a scanner range");

for (let i = 0; i < 6; i++) {
  await security.evaluate(facts(`198.51.100.${i + 1}`, { path: "/products" }));
}
const leaky = {
  path: "/admin/export?token=demo-export-token-not-a-real-secret&page=2",
  headers: {
    authorization:
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcHMifQ.c2lnbmF0dXJl",
    "user-agent": "scanner/2.1",
  },
};
for (let i = 0; i < 5; i++)
  await security.evaluate(facts("203.0.113.7", leaky));
for (let i = 0; i < 2; i++)
  await security.evaluate(facts("203.0.113.9", leaky));
await security.evaluate(facts("203.0.113.44", leaky));

/* ------------------------------------------------------------------ */
step("the events: one per refusal, its request redacted");

const events = ring.take(100);
checkEqual(
  "eight events, every one a block",
  [events.length, events.every((event) => event.action === "block")],
  [8, true],
);
const sample = events[0].sample as {
  path: string;
  query?: Record<string, unknown>;
  headers: Record<string, unknown>;
};
show("what an event keeps", sample);
checkEqual("the bearer token", sample.headers.authorization, "[redacted]");
checkEqual(
  "an ordinary header is kept",
  sample.headers["user-agent"],
  "scanner/2.1",
);
check(
  "the token in the query is redacted, an ordinary value kept",
  JSON.stringify(sample).includes("[redacted]") &&
    !JSON.stringify(sample).includes("demo-export-token") &&
    JSON.stringify(sample).includes('"2"'),
  sample,
);

/* ------------------------------------------------------------------ */
step("the minute's counters, once it has closed");

// The exact refusals per subject per day go at once; the open minute waits.
const early = recorder.flush();
checkEqual(
  "an open minute is not flushed yet",
  early.filter((row) => row.tier === undefined).length,
  0,
);
check(
  "the exact refusals per subject per day are flushed at once",
  early.some(
    (row) =>
      row.metric === "refused" &&
      row.tier === "day" &&
      row.dims?.subject === "203.0.113.44" &&
      row.value === 1,
  ),
  early,
);
clock.advance(MINUTE);
const rows = recorder.flush();
/** The minute rows of `metric`, as `dims → value`. */
const counted = (metric: string) =>
  Object.fromEntries(
    rows
      .filter((row) => row.metric === metric && row.tier === undefined)
      .map((row) => [JSON.stringify(row.dims ?? {}), row.value]),
  );
show("requests", counted("requests"));
checkEqual("requests by action", counted("requests"), {
  '{"action":"allow"}': 6,
  '{"action":"block"}': 8,
});
const top = rows
  .filter((row) => row.metric === "top.refused")
  .sort((a, b) => b.value - a.value)
  .map((row) => [row.dims?.subject, row.value]);
show("top.refused", top);
checkEqual("the minute's most refused addresses (top-K, K = 3)", top, [
  ["203.0.113.7", 5],
  ["203.0.113.9", 2],
  ["203.0.113.44", 1],
]);
/* ------------------------------------------------------------------ */
step("stored, and rolled up into an hour by the maintenance job");

const store = memoryStore({ now: clock.now });
await store.addCounters!([...early, ...rows]);
// A second minute's traffic, later in the hour.
clock.advance(20 * MINUTE);
await security.evaluate(facts("203.0.113.7", leaky));
clock.advance(MINUTE);
await store.addCounters!(recorder.flush());
const maintenance = analyticsMaintenance(store, { now: clock.now });
checkEqual(
  "within the hour, nothing to roll up",
  (await maintenance.run()).rolledUp["minute>hour"],
  0,
);
clock.advance(HOUR);
const report = await maintenance.run();
check(
  "an hour and its grace later, the hour's minutes rolled up",
  report.rolledUp["minute>hour"] > 0,
  report,
);
const hourly = await store.series!({
  tier: "hour",
  metric: "requests",
  from: Date.UTC(2026, 10, 19, 9),
  to: Date.UTC(2026, 10, 19, 10),
});
show("the hour's requests", hourly);
checkEqual(
  "the hour holds both minutes: 6 + 8 + 1",
  hourly.reduce((sum, point) => sum + point.value, 0),
  15,
);

summary();
