/**
 * Option tour: the exported helpers — cron, schedules and tickers, repeats,
 * job options, backoff registries, JSON, ids, keys, connections, logging, the
 * child protocol, date parsers, limits support, events and every default.
 *
 * ```bash
 * bun 10-options/utilities.ts
 * ```
 *
 * These are the functions the classes are built from, exported because a
 * custom driver, handler or admin tool needs them too. Each check is taken
 * from the helper's own JSDoc, edge cases included.
 *
 * The points worth knowing:
 *
 * - **Pin `from` and `tz` when you preview a schedule.** Every date check
 *   here is computed from a fixed instant and a named zone, so it means the
 *   same thing on any host, any day.
 * - **Six-field cron is wall-clock aligned.** `*\/10 * * * * *` fires on the
 *   ten-second marks, not ten seconds after it started; `{ every: 10_000 }`
 *   is the way to ask for the latter.
 * - **An interval series is anchored to its creation**, so two `add` calls a
 *   millisecond apart agree on the next occurrence — that is what makes a
 *   repeat idempotent.
 * - Not exported from the package, so not covered: `nextBackoff`,
 *   `sweepWindows`, `supportsWindowSweep`, `DEBOUNCE_PREFIX`,
 *   `THROTTLE_PREFIX` and `DEFAULT_LIMITS_REFRESH_MS` live in `queue/` but
 *   `lib/index.ts` does not re-export them.
 */
import type { LogFields, RepeatRecord } from "@kingsleyweb/bun-jobs";
import { hostname } from "node:os";
import process from "node:process";
import {
  assertDateParser,
  assertJsonSafe,
  assertNamespace,
  assertSegment,
  BackoffStrategies,
  BUILT_IN_BACKOFFS,
  CHILD_ENV,
  CHRONO_VERSION_RANGE,
  createDriver,
  createJobsLogger,
  createTicker,
  databaseFromUrl,
  DEFAULT_CLOSE_TIMEOUT,
  DEFAULT_JOB_BACKOFF,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_KEEP_HISTORY,
  DEFAULT_KEEP_LOGS,
  DEFAULT_KEEP_STACKTRACES,
  DEFAULT_KEY_PREFIX,
  DEFAULT_KILL_TIMEOUT,
  DEFAULT_LOCK_DURATION,
  DEFAULT_LOCK_TTL,
  DEFAULT_MAX_BLOCK,
  DEFAULT_MAX_QUEUED_RUNS,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_MAX_STALLED,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_RESULT_TTL,
  DEFAULT_STALLED_INTERVAL,
  DEFAULT_START_TIMEOUT,
  DEFAULT_SYNC_INTERVAL,
  HOST,
  isRunnerChild,
  newId,
  newToken,
  nextCronDate,
  nextFireDate,
  nextOccurrence,
  normalizeSchedule,
  parseCron,
  parseToken,
  PROTOCOL_VERSION,
  queueKey,
  QueueLimiter,
  repeatJobId,
  repeatKeyFor,
  resolveConnectionUrl,
  resolveJobOptions,
  resolveLogger,
  resolveNames,
  resolveRunAt,
  resolveRunnerOptions,
  retentionExpiry,
  runnerEvent,
  runnerKey,
  safeJsonParse,
  stringifyBounded,
  toConnectionUrl,
  toRepeatRecord,
  validateCron,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: utilities");

const namespace = exampleNamespace("tour-utilities");
const driver = createDriver(exampleDriver());
await driver.connect();

/** A ConfigError check, which every bad input in this tour raises. */
async function checkConfig(
  label: string,
  run: () => unknown,
  message: RegExp,
): Promise<Error | undefined> {
  return await checkRejects(label, run, {
    name: "ConfigError",
    code: "CONFIG",
    message,
  });
}

/** Epoch milliseconds for an ISO instant, for readable expectations. */
function at(iso: string): number {
  return new Date(iso).getTime();
}

/** An ISO string, or `null`, for comparing dates by value. */
function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/* ------------------------------------------------------------------ */
step("Constants: every default, named once");

const defaults = {
  DEFAULT_KEY_PREFIX,
  DEFAULT_LOCK_TTL,
  DEFAULT_CLOSE_TIMEOUT,
  DEFAULT_KILL_TIMEOUT,
  DEFAULT_START_TIMEOUT,
  DEFAULT_KEEP_HISTORY,
  DEFAULT_MAX_QUEUED_RUNS,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_SYNC_INTERVAL,
  DEFAULT_LOCK_DURATION,
  DEFAULT_STALLED_INTERVAL,
  DEFAULT_MAX_STALLED,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_MAX_BLOCK,
  DEFAULT_RESULT_TTL,
  DEFAULT_KEEP_STACKTRACES,
  DEFAULT_KEEP_LOGS,
  DEFAULT_JOB_BACKOFF,
};
show("defaults", defaults);

checkEqual("the documented values", defaults, {
  DEFAULT_KEY_PREFIX: "bun-jobs",
  DEFAULT_LOCK_TTL: 30_000, // BunRunnerOptions.lockTtl: "Defaults to 30000"
  DEFAULT_CLOSE_TIMEOUT: 5_000, // closeTimeout: "Defaults to 5000"
  DEFAULT_KILL_TIMEOUT: 2_000, // killTimeout: "Defaults to 2000"
  DEFAULT_START_TIMEOUT: 10_000,
  DEFAULT_KEEP_HISTORY: 50, // keepHistory: "Defaults to 50"
  DEFAULT_MAX_QUEUED_RUNS: 100, // maxQueuedRuns: "Defaults to 100"
  DEFAULT_MAX_RESULT_BYTES: 16_384, // maxResultBytes: "Defaults to 16384"
  DEFAULT_SYNC_INTERVAL: 30_000, // syncInterval: "Defaults to 30000"
  DEFAULT_LOCK_DURATION: 30_000,
  DEFAULT_STALLED_INTERVAL: 30_000,
  DEFAULT_MAX_STALLED: 1,
  DEFAULT_POLL_INTERVAL: 1_000,
  DEFAULT_MAX_BLOCK: 5_000,
  DEFAULT_RESULT_TTL: 86_400_000, // one day
  DEFAULT_KEEP_STACKTRACES: 5,
  DEFAULT_KEEP_LOGS: 1_000,
  DEFAULT_JOB_BACKOFF: {
    type: "exponential",
    delay: 1_000,
    max: 300_000,
    jitter: 0.1,
  },
});

// The runner applies them: resolve a runner's options and compare.
const { resolved: runnerDefaults } = resolveRunnerOptions({
  id: "defaults",
  namespace,
  driver,
  file: new URL("./helpers/errors-wait-for-stop.ts", import.meta.url),
});
checkEqual(
  "resolveRunnerOptions applies them",
  [
    runnerDefaults.lockTtl,
    runnerDefaults.closeTimeout,
    runnerDefaults.killTimeout,
    runnerDefaults.spawn.startTimeout,
    runnerDefaults.keepHistory,
    runnerDefaults.maxQueuedRuns,
    runnerDefaults.maxResultBytes,
    runnerDefaults.syncInterval,
  ],
  [
    DEFAULT_LOCK_TTL,
    DEFAULT_CLOSE_TIMEOUT,
    DEFAULT_KILL_TIMEOUT,
    DEFAULT_START_TIMEOUT,
    DEFAULT_KEEP_HISTORY,
    DEFAULT_MAX_QUEUED_RUNS,
    DEFAULT_MAX_RESULT_BYTES,
    DEFAULT_SYNC_INTERVAL,
  ],
);
checkEqual(
  "and the documented non-numeric defaults",
  [
    runnerDefaults.executionMode,
    runnerDefaults.runMode,
    runnerDefaults.waitToExit,
    runnerDefaults.autostart,
    runnerDefaults.onLockLost,
    runnerDefaults.name,
    runnerDefaults.schedule,
  ],
  ["spawn", "single", true, false, "abort", "defaults", null],
);
checkEqual(
  "heartbeatInterval defaults to a third of lockTtl",
  runnerDefaults.heartbeatInterval,
  DEFAULT_LOCK_TTL / 3,
);
await checkConfig(
  "resolveRunnerOptions: maxConcurrency 0",
  () => {
    return resolveRunnerOptions({
      id: "x",
      namespace,
      driver,
      file: import.meta.path,
      maxConcurrency: 0,
    });
  },
  /maxConcurrency must be at least 1/,
);

/* ------------------------------------------------------------------ */
step("parseCron / validateCron: five fields, six with seconds first");

checkEqual("five fields", parseCron("  0 9 * * MON-FRI "), {
  expression: "0 9 * * MON-FRI",
  seconds: null,
  minuteExpression: "0 9 * * MON-FRI",
});
checkEqual("six fields", parseCron("*/15 30 * * * *", { tz: "UTC" }), {
  expression: "*/15 30 * * * *",
  seconds: [0, 15, 30, 45],
  minuteExpression: "30 * * * *",
  tz: "UTC",
});
checkEqual(
  "a bare value with a step runs to the end",
  parseCron("5/20 * * * * *").seconds,
  [5, 25, 45],
);
checkEqual(
  "ranges and lists, sorted and de-duplicated",
  parseCron("50,10-12,10 * * * * *").seconds,
  [10, 11, 12, 50],
);
checkEqual(
  "a nickname goes to Bun.cron as-is",
  parseCron("@hourly").minuteExpression,
  "@hourly",
);

await checkConfig(
  "empty",
  () => {
    return parseCron("   ");
  },
  /A cron expression is required/,
);
await checkConfig(
  "seven fields",
  () => {
    return parseCron("0 0 0 * * * *");
  },
  /has 7 fields — expected 5, or 6 with seconds first/,
);
await checkConfig(
  "second 60",
  () => {
    return parseCron("60 * * * * *");
  },
  /Invalid seconds field "60"/,
);
await checkConfig(
  "a negative second is not the range 0-1",
  () => {
    return parseCron("-1 * * * * *");
  },
  /Invalid seconds field "-1"/,
);
await checkConfig(
  "a zero step",
  () => {
    return parseCron("*/0 * * * * *");
  },
  /Invalid step "0"/,
);
await checkConfig(
  "an empty list entry",
  () => {
    return parseCron("1,,2 * * * * *");
  },
  /Empty entry in the seconds field/,
);
await checkConfig(
  "minute 61",
  () => {
    return parseCron("61 * * * *");
  },
  /Invalid cron expression "61 \* \* \* \*"/,
);
await checkConfig(
  "an unknown time zone",
  () => {
    return parseCron("0 9 * * *", { tz: "Mars/Olympus_Mons" });
  },
  /Invalid cron expression/,
);

checkEqual(
  "validateCron",
  [
    "*/15 * * * *",
    "30 */10 * * * *",
    "0 0 30 2 *",
    "61 * * * *",
    "every tuesday",
    "",
  ].map((expression) => validateCron(expression)),
  // "0 0 30 2 *" is valid — it just never fires.
  [true, true, true, false, false, false],
);
checkEqual(
  "validateCron checks the zone too",
  validateCron("0 9 * * *", { tz: "Nowhere/Special" }),
  false,
);

/* ------------------------------------------------------------------ */
step("nextCronDate: strictly after a fixed `from`, in pinned zones");

// A Tuesday, 07.5 seconds past 10:00 UTC. New York is on EDT (UTC-4) since 8 March.
const from = new Date("2026-03-10T10:00:07.500Z");

checkEqual(
  "six fields: the next ten-second mark of the wall clock",
  iso(nextCronDate("*/10 * * * * *", from)),
  "2026-03-10T10:00:10.000Z",
);
checkEqual(
  "six fields: a later second in this minute",
  iso(nextCronDate("5,35 * * * * *", from)),
  "2026-03-10T10:00:35.000Z",
);
checkEqual(
  "six fields: the first second of the next matching minute",
  iso(nextCronDate("15 30 * * * *", from)),
  "2026-03-10T10:30:15.000Z",
);
checkEqual(
  "six fields: strictly after a match",
  iso(nextCronDate("*/10 * * * * *", new Date("2026-03-10T10:00:10.000Z"))),
  "2026-03-10T10:00:20.000Z",
);
checkEqual(
  "five fields, no zone: every minute is zone-independent",
  iso(nextCronDate("* * * * *", from)),
  "2026-03-10T10:01:00.000Z",
);
checkEqual(
  "09:00 in UTC",
  iso(nextCronDate("0 9 * * *", from, { tz: "UTC" })),
  "2026-03-11T09:00:00.000Z",
);
checkEqual(
  "09:00 in New York (EDT)",
  iso(nextCronDate("0 9 * * *", from, { tz: "America/New_York" })),
  "2026-03-10T13:00:00.000Z",
);
checkEqual(
  "09:00 in Tokyo",
  iso(nextCronDate("0 9 * * *", from, { tz: "Asia/Tokyo" })),
  "2026-03-11T00:00:00.000Z",
);
checkEqual(
  "strictly after: from exactly on a fire",
  iso(
    nextCronDate("0 9 * * *", new Date("2026-03-11T09:00:00.000Z"), {
      tz: "UTC",
    }),
  ),
  "2026-03-12T09:00:00.000Z",
);

const newYork = parseCron("0 9 * * *", { tz: "America/New_York" });
checkEqual(
  "a ParsedCron keeps its zone",
  iso(nextCronDate(newYork, from)),
  "2026-03-10T13:00:00.000Z",
);
checkEqual(
  "options.tz overrides the parsed zone",
  iso(nextCronDate(newYork, from, { tz: "UTC" })),
  "2026-03-11T09:00:00.000Z",
);
checkEqual(
  "a six-field ParsedCron in a zone",
  iso(nextCronDate(parseCron("30 0 9 * * *", { tz: "Asia/Tokyo" }), from)),
  "2026-03-11T00:00:30.000Z",
);
checkEqual("30 February never comes", nextCronDate("0 0 30 2 *", from), null);
check(
  "from defaults to now",
  (nextCronDate("* * * * * *")?.getTime() ?? 0) > Date.now() - 1,
  nextCronDate("* * * * * *"),
);

/* ------------------------------------------------------------------ */
step("normalizeSchedule: every accepted shape, validated eagerly");

checkEqual(
  "the shapes",
  [
    normalizeSchedule("  0 * * * * "),
    normalizeSchedule({ cron: "0 6 * * *", tz: "Africa/Lagos" }),
    normalizeSchedule(90_000),
    normalizeSchedule({ every: 1_500.7 }),
    normalizeSchedule({
      every: 3_600_000,
      anchor: new Date("2026-01-01T00:00:00Z"),
    }),
    normalizeSchedule(new Date("2026-12-25T00:00:00Z")),
    normalizeSchedule({ at: at("2026-12-25T00:00:00Z") }),
    normalizeSchedule(null),
    normalizeSchedule(undefined),
  ],
  [
    { cron: "0 * * * *" },
    { cron: "0 6 * * *", tz: "Africa/Lagos" },
    { every: 90_000 },
    { every: 1_500 },
    { every: 3_600_000, anchor: at("2026-01-01T00:00:00Z") },
    { at: at("2026-12-25T00:00:00Z") },
    { at: at("2026-12-25T00:00:00Z") },
    null,
    null,
  ],
);

await checkConfig(
  "every: 0",
  () => {
    return normalizeSchedule({ every: 0 });
  },
  /schedule\.every must be a positive number of ms/,
);
await checkConfig(
  "a negative interval",
  () => {
    return normalizeSchedule(-5);
  },
  /schedule\.every must be a positive number of ms/,
);
await checkConfig(
  "an invalid Date",
  () => {
    return normalizeSchedule(new Date("not a date"));
  },
  /schedule\.at must be a valid date or timestamp/,
);
await checkConfig(
  "an invalid anchor",
  () => {
    return normalizeSchedule({ every: 1_000, anchor: Number.NaN });
  },
  /schedule\.anchor must be a valid date or timestamp/,
);
await checkConfig(
  "an unknown shape",
  () => {
    return normalizeSchedule({ hourly: true } as never);
  },
  /Unrecognised schedule/,
);
await checkConfig(
  "a bad cron string",
  () => {
    return normalizeSchedule("61 * * * *");
  },
  /Invalid cron expression/,
);

/* ------------------------------------------------------------------ */
step("nextFireDate: the next fire strictly after `from`");

const fromMs = from.getTime();
checkEqual("manual only", nextFireDate(null, from), null);
checkEqual(
  "cron with a zone",
  iso(nextFireDate({ cron: "0 9 * * *", tz: "America/New_York" }, from)),
  "2026-03-10T13:00:00.000Z",
);
checkEqual(
  "an interval without an anchor is measured from `from`",
  nextFireDate({ every: 1_000 }, from)?.getTime(),
  fromMs + 1_000,
);
checkEqual(
  "an anchored interval stays on its grid",
  nextFireDate({ every: 1_000, anchor: fromMs - 2_500 }, from)?.getTime(),
  fromMs + 500,
);
checkEqual(
  "on the grid exactly: the next point",
  nextFireDate({ every: 1_000, anchor: fromMs - 2_000 }, from)?.getTime(),
  fromMs + 1_000,
);
checkEqual(
  "an anchor in the future: its first grid point after `from`",
  nextFireDate({ every: 1_000, anchor: fromMs + 5_000 }, from)?.getTime(),
  fromMs + 1_000,
);
checkEqual(
  "a one-shot still ahead",
  nextFireDate({ at: fromMs + 1 }, from)?.getTime(),
  fromMs + 1,
);
checkEqual(
  "a one-shot exactly at `from` is past",
  nextFireDate({ at: fromMs }, from),
  null,
);
checkEqual(
  "a one-shot in the past",
  nextFireDate({ at: fromMs - 1 }, from),
  null,
);

/* ------------------------------------------------------------------ */
step("createTicker: start, next, stop");

const manual = createTicker(null, () => {}, { keepAlive: true });
checkEqual("a manual-only ticker has no next", manual.next(), null);
manual.stop();

/** Fire times an interval ticker reported, and when each actually ran. */
const intervalTicks: { scheduled: number; ranAt: number }[] = [];
const interval = createTicker(
  { every: 100 },
  (scheduledAt) => {
    intervalTicks.push({ scheduled: scheduledAt.getTime(), ranAt: Date.now() });
  },
  { keepAlive: true },
);
const firstNext = interval.next();
check(
  "next() is ahead before the first tick",
  (firstNext?.getTime() ?? 0) > Date.now() - 100,
  firstNext,
);

await waitFor("three interval ticks", () => intervalTicks.length >= 3, {
  timeout: 5_000,
});
const grid = intervalTicks.map(
  (tick) => tick.scheduled - intervalTicks[0]!.scheduled,
);
check(
  "ticks stay on the 100ms grid (drift-free)",
  grid.every((offset) => offset % 100 === 0) &&
    grid.slice(1).every((offset, index) => offset > grid[index]!),
  grid,
);
check(
  "no tick runs before its scheduled time",
  intervalTicks.every((tick) => tick.ranAt >= tick.scheduled),
  intervalTicks,
);
const upcoming = interval.next()?.getTime() ?? 0;
check(
  "next() is a later grid point",
  upcoming > intervalTicks.at(-1)!.scheduled &&
    (upcoming - intervalTicks[0]!.scheduled) % 100 === 0,
  { upcoming, ticks: intervalTicks },
);

interval.stop();
interval.stop(); // idempotent
const ticksAtStop = intervalTicks.length;
checkEqual("next() is null once stopped", interval.next(), null);
// Watching for something that must NOT happen needs a window: three intervals.
await Bun.sleep(350);
checkEqual("no ticks after stop()", intervalTicks.length, ticksAtStop);

const oneShotAt = Date.now() + 120;
/** When the one-shot fired, as scheduled. */
const oneShotTicks: number[] = [];
const oneShot = createTicker(
  { at: oneShotAt },
  (scheduledAt) => {
    oneShotTicks.push(scheduledAt.getTime());
  },
  { keepAlive: true },
);
checkEqual(
  "a one-shot's next() is its instant",
  oneShot.next()?.getTime(),
  oneShotAt,
);
await waitFor("the one-shot to fire", () => oneShotTicks.length === 1, {
  timeout: 5_000,
});
checkEqual("it fired at its instant", oneShotTicks, [oneShotAt]);
checkEqual("and has nothing left", oneShot.next(), null);
oneShot.stop();

/** Seconds-cron fire times. */
const secondTicks: number[] = [];
const everySecond = createTicker(
  { cron: "* * * * * *", tz: "UTC" },
  (scheduledAt) => {
    secondTicks.push(scheduledAt.getTime());
  },
  { keepAlive: false },
);
await waitFor("two seconds-cron ticks", () => secondTicks.length >= 2, {
  timeout: 5_000,
});
everySecond.stop();
check(
  "six-field ticks land on whole seconds, a second apart or more",
  secondTicks.every((ms) => ms % 1_000 === 0) &&
    secondTicks[1]! - secondTicks[0]! >= 1_000,
  secondTicks,
);

// Five-field cron is handed to Bun.cron itself; nothing fires here for a year.
const yearly = createTicker({ cron: "0 0 1 1 *", tz: "UTC" }, () => {}, {
  keepAlive: false,
});
const newYear = yearly.next();
check(
  "a five-field ticker's next() is the coming 1 January 00:00 UTC",
  newYear !== null &&
    newYear.getTime() > Date.now() &&
    newYear.getUTCMonth() === 0 &&
    newYear.getUTCDate() === 1 &&
    newYear.getUTCHours() === 0,
  newYear,
);
yearly.stop();

/* ------------------------------------------------------------------ */
step("Repeat helpers: ids, series keys, next occurrences, stored records");

checkEqual(
  "repeatJobId",
  repeatJobId("report|every:60000|", 1_700_000_000_000),
  "repeat:report|every:60000|:1700000000000",
);
checkEqual(
  "repeatKeyFor",
  [
    repeatKeyFor("report", { cron: "0 9 * * *", tz: "UTC" }),
    repeatKeyFor("report", { cron: "0 9 * * *" }),
    repeatKeyFor("report", { every: 60_000, startAt: 5 }),
    repeatKeyFor("report", { key: "my-series", every: 60_000 }),
  ],
  [
    "report|0 9 * * *@UTC|",
    "report|0 9 * * *|",
    "report|every:60000|5",
    "my-series",
  ],
);

const created = at("2026-03-10T10:00:00Z");
/** A series definition, as `nextOccurrence` reads one. */
type Series = Parameters<typeof nextOccurrence>[0];
const minutely: Series = { every: 60_000, count: 0, createdAt: created };

checkEqual(
  "every: the grid from creation",
  nextOccurrence(minutely, created + 90_000),
  created + 120_000,
);
checkEqual(
  "every: one interval after creation",
  nextOccurrence(minutely, created),
  created + 60_000,
);
checkEqual(
  "every: two callers a millisecond apart agree",
  nextOccurrence(minutely, created + 1),
  nextOccurrence(minutely, created + 2),
);
const startsLater = at("2026-12-01T00:00:00Z");
checkEqual(
  "every: a series runs on its startAt, not one interval later",
  nextOccurrence(
    {
      every: 2 * 86_400_000,
      startAt: startsLater,
      count: 0,
      createdAt: created,
    },
    created,
  ),
  startsLater,
);
checkEqual(
  "cron: the next 09:00 UTC",
  nextOccurrence(
    { cron: "0 9 * * *", tz: "UTC", count: 0, createdAt: created },
    created,
  ),
  at("2026-03-11T09:00:00Z"),
);
checkEqual(
  "cron: not before startAt",
  nextOccurrence(
    {
      cron: "0 9 * * *",
      tz: "UTC",
      startAt: at("2026-04-01T00:00:00Z"),
      count: 0,
      createdAt: created,
    },
    created,
  ),
  at("2026-04-01T09:00:00Z"),
);
checkEqual(
  "limit reached",
  nextOccurrence({ ...minutely, limit: 3, count: 3 }, created),
  null,
);
checkEqual(
  "limit not yet reached",
  nextOccurrence({ ...minutely, limit: 3, count: 2 }, created),
  created + 60_000,
);
checkEqual(
  "past its endAt",
  nextOccurrence({ ...minutely, endAt: created + 100_000 }, created + 90_000),
  null,
);
checkEqual(
  "exactly on its endAt still runs",
  nextOccurrence({ ...minutely, endAt: created + 120_000 }, created + 90_000),
  created + 120_000,
);
await checkConfig(
  "neither cron nor every",
  () => {
    return nextOccurrence(
      { count: 0, createdAt: created } as Pick<
        RepeatRecord,
        "count" | "createdAt"
      >,
      created,
    );
  },
  /A repeat needs either a cron expression or every/,
);

const ref = { ns: namespace, queue: "reports" };
const opts = resolveJobOptions(undefined, undefined);
const now = at("2026-03-10T10:00:00Z");

checkEqual(
  "toRepeatRecord: a duration",
  toRepeatRecord(ref, "report", { to: "ops" }, opts, { every: "2 hours" }, now),
  {
    key: "report|every:7200000|",
    name: "report",
    data: { to: "ops" },
    opts,
    every: 7_200_000,
    count: 0,
    nextRunAt: null,
    nextJobId: null,
    createdAt: now,
    updatedAt: now,
  },
);
const fromCronWords = toRepeatRecord(
  ref,
  "report",
  null,
  opts,
  { every: "0 9 * * *", tz: "UTC" },
  now,
);
checkEqual(
  "toRepeatRecord: a cron expression in every",
  [
    fromCronWords.cron,
    fromCronWords.tz,
    fromCronWords.every,
    fromCronWords.key,
  ],
  ["0 9 * * *", "UTC", undefined, "report|0 9 * * *@UTC|"],
);
checkEqual(
  "toRepeatRecord: 'every 90 seconds'",
  toRepeatRecord(ref, "report", null, opts, { every: "every 90 seconds" }, now)
    .every,
  90_000,
);
checkEqual(
  "toRepeatRecord: startAt in words, from `now`",
  toRepeatRecord(
    ref,
    "report",
    null,
    opts,
    { every: 60_000, startAt: "in 10 minutes" },
    now,
  ).startAt,
  now + 600_000,
);
const limited = toRepeatRecord(
  ref,
  "report",
  null,
  opts,
  { every: 60_000, limit: 5, catchUp: true, key: "nightly" },
  now,
);
checkEqual(
  "toRepeatRecord: limit, catchUp and key",
  [limited.limit, limited.catchUp, limited.key],
  [5, true, "nightly"],
);
checkEqual(
  "toRepeatRecord: catchUp false is stored as false",
  toRepeatRecord(
    ref,
    "report",
    null,
    opts,
    { every: 60_000, catchUp: false },
    now,
  ).catchUp,
  false,
);
check(
  "toRepeatRecord: an unset catchUp is left out",
  !(
    "catchUp" in
    toRepeatRecord(ref, "report", null, opts, { every: 60_000 }, now)
  ),
);
await checkConfig(
  "toRepeatRecord: two different cron expressions",
  () => {
    return toRepeatRecord(
      ref,
      "report",
      null,
      opts,
      { cron: "0 9 * * *", every: "0 10 * * *" },
      now,
    );
  },
  /was given two cron expressions/,
);
await checkConfig(
  "toRepeatRecord: nothing to repeat on",
  () => {
    return toRepeatRecord(ref, "report", null, opts, {}, now);
  },
  /A repeat needs either a cron expression or every/,
);

/* ------------------------------------------------------------------ */
step("Job options: defaults, merging, validation, run times, retention");

checkEqual("DEFAULT_JOB_OPTIONS", DEFAULT_JOB_OPTIONS, {
  priority: 0,
  attempts: 1,
  backoff: DEFAULT_JOB_BACKOFF,
  timeout: 0,
  removeOnComplete: { ttl: DEFAULT_RESULT_TTL },
  removeOnFail: false,
  keepStacktraces: DEFAULT_KEEP_STACKTRACES,
});
checkEqual(
  "nothing given: the defaults",
  resolveJobOptions(undefined, undefined),
  DEFAULT_JOB_OPTIONS,
);

const merged = resolveJobOptions(
  { attempts: 3, priority: 5, timeout: 1_000 },
  { priority: 1 },
);
checkEqual(
  "the call wins over the queue's defaults",
  [merged.attempts, merged.priority, merged.timeout],
  [3, 1, 1_000],
);
checkEqual(
  "priority is clamped, not rejected",
  [
    resolveJobOptions(undefined, { priority: 1e9 }).priority,
    resolveJobOptions(undefined, { priority: -1e9 }).priority,
  ],
  [1_048_576, -1_048_576],
);
check(
  "keepLogs and deadLetter only appear when given",
  !("keepLogs" in merged) && !("deadLetter" in merged),
  merged,
);
checkEqual(
  "keepLogs 0 and a deadLetter queue",
  [
    resolveJobOptions(undefined, { keepLogs: 0 }).keepLogs,
    resolveJobOptions(undefined, { deadLetter: "failed-mail" }).deadLetter,
  ],
  [0, "failed-mail"],
);

await checkConfig(
  "attempts 0",
  () => {
    return resolveJobOptions(undefined, { attempts: 0 });
  },
  /attempts must be a whole number of at least 1/,
);
await checkConfig(
  "attempts 1.5",
  () => {
    return resolveJobOptions({ attempts: 1.5 }, undefined);
  },
  /attempts must be a whole number of at least 1/,
);
await checkConfig(
  "priority NaN",
  () => {
    return resolveJobOptions(undefined, { priority: Number.NaN });
  },
  /priority must be a number/,
);
await checkConfig(
  "keepLogs -1",
  () => {
    return resolveJobOptions(undefined, { keepLogs: -1 });
  },
  /keepLogs must be a whole number of zero or more/,
);
await checkConfig(
  "a deadLetter name with a separator",
  () => {
    return resolveJobOptions(undefined, { deadLetter: "mail:dead" });
  },
  /deadLetter queue name may only contain/,
);

checkEqual(
  "resolveRunAt",
  [
    resolveRunAt(undefined, now),
    resolveRunAt({ delay: 500 }, now),
    resolveRunAt({ runAt: new Date(now + 9_000) }, now),
    resolveRunAt({ runAt: now - 1_000 }, now), // the past is allowed: due at once
    resolveRunAt({ runAt: now + 1, delay: 60_000 }, now), // runAt wins
  ],
  [now, now + 500, now + 9_000, now - 1_000, now + 1],
);
await checkConfig(
  "resolveRunAt: an invalid runAt",
  () => {
    return resolveRunAt({ runAt: new Date("nope") }, now);
  },
  /runAt must be a valid date or timestamp/,
);
await checkConfig(
  "resolveRunAt: a negative delay",
  () => {
    return resolveRunAt({ delay: -1 }, now);
  },
  /delay must be a non-negative number of ms/,
);

checkEqual(
  "retentionExpiry: only a positive ttl expires",
  [
    retentionExpiry({ ttl: 1_000 }, now),
    retentionExpiry({ ttl: 0 }, now),
    retentionExpiry({ count: 10 }, now),
    retentionExpiry(true, now),
    retentionExpiry(false, now),
    retentionExpiry(5, now),
  ],
  [now + 1_000, null, null, null, null, null],
);

/* ------------------------------------------------------------------ */
step("Backoff: the built-ins, and a registry of named strategies");

checkEqual(
  "BUILT_IN_BACKOFFS",
  [...BUILT_IN_BACKOFFS],
  [
    "fixed",
    "exponential",
    "linear",
    "fibonacci",
    "full-jitter",
    "decorrelated-jitter",
  ],
);

/** A strategy that waits thirty seconds per attempt. */
function slowRamp({ attempt }: { attempt: number }): number {
  return attempt * 30_000;
}
/** A strategy that gives up at once. */
function giveUp(): false {
  return false;
}

const strategies = new BackoffStrategies();
check(
  "define() chains",
  strategies.define("slowRamp", slowRamp).define("giveUp", giveUp) ===
    strategies,
);
checkEqual(
  "get / has / names",
  [
    strategies.get("slowRamp") === slowRamp,
    strategies.has("giveUp"),
    strategies.has("nope"),
    strategies.get("nope"),
    strategies.names(),
  ],
  [true, true, false, undefined, ["slowRamp", "giveUp"]],
);
strategies.define("slowRamp", giveUp);
check(
  "defining a name again replaces it",
  strategies.get("slowRamp") === giveUp,
);

const builtInError = await checkConfig(
  "a built-in name",
  () => {
    return strategies.define("exponential", slowRamp);
  },
  /"exponential" is a built-in backoff strategy; choose another name/,
);
/** The context a built-in-name refusal carries. */
interface BuiltInRefusal {
  /** What the error was constructed with. */
  context?: {
    /** The names that cannot be redefined. */
    builtIn?: unknown;
  };
}
const refusal = builtInError as BuiltInRefusal | undefined;
checkEqual(
  "its context lists the built-ins",
  refusal?.context?.builtIn,
  BUILT_IN_BACKOFFS,
);
await checkConfig(
  "an empty name",
  () => {
    return strategies.define("", slowRamp);
  },
  /A backoff strategy needs a name/,
);
await checkConfig(
  "not a function",
  () => {
    return strategies.define("broken", 5 as never);
  },
  /The backoff strategy "broken" is not a function/,
);

check(
  "from(): an existing registry is used as-is",
  BackoffStrategies.from(strategies) === strategies,
);
checkEqual(
  "from(): a plain object, and nothing",
  [
    BackoffStrategies.from({ slowRamp }).names(),
    BackoffStrategies.from().names(),
  ],
  [["slowRamp"], []],
);
await checkConfig(
  "from(): a plain object shadowing a built-in",
  () => {
    return BackoffStrategies.from({ fixed: slowRamp });
  },
  /"fixed" is a built-in backoff strategy/,
);

/* ------------------------------------------------------------------ */
step("JSON at the boundary: assertJsonSafe, safeJsonParse, stringifyBounded");

const original = {
  when: new Date(0),
  missing: undefined,
  count: 1,
  nested: { list: [1, 2] },
};
const cloned = assertJsonSafe(original, "payload");
checkEqual("assertJsonSafe: what JSON would give back", cloned as unknown, {
  when: "1970-01-01T00:00:00.000Z",
  count: 1,
  nested: { list: [1, 2] },
});
check(
  "assertJsonSafe: a copy, not the original",
  (cloned as unknown) !== original && cloned.nested !== original.nested,
);
const bigintError = await checkRejects(
  "assertJsonSafe: a BigInt",
  () => {
    return assertJsonSafe({ id: 1n }, "payload.id");
  },
  {
    name: "SerializationError",
    code: "SERIALIZATION",
    message: /payload\.id is not JSON-serialisable/,
  },
);
checkEqual(
  "assertJsonSafe: the error names the field",
  (bigintError as { context?: unknown } | undefined)?.context,
  { what: "payload.id" },
);

checkEqual(
  "safeJsonParse",
  [
    safeJsonParse('{"a":1}', null),
    safeJsonParse("{nope", "fallback"),
    safeJsonParse(null, 1),
    safeJsonParse(undefined, 2),
    safeJsonParse("", 3),
    safeJsonParse("null", 4),
  ],
  [{ a: 1 }, "fallback", 1, 2, 3, null],
);

checkEqual(
  "stringifyBounded: under the limit, unchanged",
  stringifyBounded({ a: 1 }, 100),
  '{"a":1}',
);
const big = "x".repeat(1_000);
const truncated = JSON.parse(stringifyBounded(big, 200)) as {
  __truncated: boolean;
  bytes: number;
  preview: string;
};
checkEqual(
  "stringifyBounded: over the limit, a marker",
  [truncated.__truncated, truncated.bytes, truncated.preview],
  [true, 1_002, JSON.stringify(big).slice(0, 136)],
);
checkEqual(
  "stringifyBounded: bytes, not characters",
  (JSON.parse(stringifyBounded("é".repeat(100), 150)) as { bytes: number })
    .bytes,
  202,
);
checkEqual(
  "stringifyBounded: 0 and negative mean no limit",
  [stringifyBounded(big, 0).length, stringifyBounded(big, -1).length],
  [1_002, 1_002],
);
checkEqual(
  "stringifyBounded: unserialisable becomes a marker",
  JSON.parse(stringifyBounded({ id: 1n }, 0)),
  { __unserializable: true, preview: "[object Object]" },
);
checkEqual(
  "stringifyBounded: undefined is null",
  stringifyBounded(undefined, 10),
  "null",
);

/* ------------------------------------------------------------------ */
step("Ids and lock tokens");

const uuidV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const firstId = newId();
await Bun.sleep(2); // a later millisecond, so the ids differ in their time part
const secondId = newId();
check("newId: a UUIDv7", uuidV7.test(firstId) && uuidV7.test(secondId), [
  firstId,
  secondId,
]);
check("newId: sorts by creation time", firstId < secondId, [firstId, secondId]);

checkEqual("HOST is this host's name", HOST, hostname());
const token = newToken();
const scoped = newToken("worker-1");
check(
  "newToken: host, pid, id",
  token.startsWith(`${HOST}:${process.pid}:`) &&
    uuidV7.test(token.split(":")[2] ?? ""),
  token,
);
check("newToken: a scope goes last", scoped.endsWith(":worker-1"), scoped);

checkEqual("parseToken: round trip", parseToken(token), {
  host: HOST,
  pid: process.pid,
  id: token.split(":")[2]!,
});
checkEqual("parseToken: a scope", parseToken(scoped)?.scope, "worker-1");
checkEqual(
  "parseToken: a scope containing colons",
  parseToken("box:42:abc:queue:mail"),
  { host: "box", pid: 42, id: "abc", scope: "queue:mail" },
);
checkEqual(
  "parseToken: not ours",
  [
    parseToken("nope"),
    parseToken("box:notapid:abc"),
    parseToken(":42:abc"),
    parseToken("box:42:"),
  ],
  [null, null, null, null],
);

/* ------------------------------------------------------------------ */
step("Keys: namespaces and segments");

checkEqual(
  "assertNamespace: returns a valid one",
  assertNamespace("billing-eu.v2_1"),
  "billing-eu.v2_1",
);
checkEqual(
  "assertSegment: 200 characters is the limit",
  assertSegment("a".repeat(200), "queue name").length,
  200,
);
await checkConfig(
  "a separator",
  () => {
    return assertNamespace("billing:eu");
  },
  /^namespace may only contain letters, digits, "_", "\." and "-"$/,
);
await checkConfig(
  "a slash",
  () => {
    return assertSegment("a/b", "runner id");
  },
  /^runner id may only contain/,
);
await checkConfig(
  "empty",
  () => {
    return assertSegment("", "queue name");
  },
  /^queue name is required$/,
);
await checkConfig(
  "201 characters",
  () => {
    return assertSegment("a".repeat(201), "queue name");
  },
  /^queue name is longer than 200 characters$/,
);
await checkConfig(
  "a dot-dot",
  () => {
    return assertNamespace("..");
  },
  /^namespace may not be "\." or "\.\."$/,
);
checkEqual(
  "queueKey / runnerKey",
  [queueKey("mail"), runnerKey("nightly")],
  ["q:mail", "r:nightly"],
);

/* ------------------------------------------------------------------ */
step("Connections: URLs from fields, and names from prefixes");

checkEqual(
  "toConnectionUrl: credentials are encoded",
  toConnectionUrl(
    { host: "db", user: "us er", password: "p@ss:w/rd", database: "jobs" },
    { scheme: "postgres", port: 5432 },
  ),
  "postgres://us%20er:p%40ss%3Aw%2Frd@db:5432/jobs",
);
checkEqual(
  "toConnectionUrl: defaults",
  [
    toConnectionUrl({}, { scheme: "redis", port: 6379 }),
    toConnectionUrl({ user: "u" }, { scheme: "mongodb", host: "localhost" }),
  ],
  ["redis://127.0.0.1:6379/", "mongodb://u@localhost/"],
);
checkEqual(
  "toConnectionUrl: tls with a scheme of its own",
  toConnectionUrl(
    { tls: true, database: 2 },
    { scheme: "redis", tlsScheme: "rediss", port: 6379 },
  ),
  "rediss://127.0.0.1:6379/2",
);
checkEqual(
  "toConnectionUrl: tls without one becomes a parameter",
  toConnectionUrl(
    { tls: true, params: { sslmode: "require", retry: true } },
    { scheme: "postgres", port: 5432 },
  ),
  "postgres://127.0.0.1:5432/?sslmode=require&retry=true&tls=true",
);
checkEqual(
  "toConnectionUrl: an explicit tls parameter is kept",
  toConnectionUrl(
    { tls: true, params: { tls: "false" } },
    { scheme: "postgres" },
  ),
  "postgres://127.0.0.1/?tls=false",
);
checkEqual(
  "toConnectionUrl: several hosts, each with the default port unless given",
  toConnectionUrl(
    {
      host: "a",
      port: 1,
      hosts: [{ host: "b" }, { host: "c", port: 3 }],
      database: "jobs",
    },
    { scheme: "mongodb", port: 27_017 },
  ),
  "mongodb://a:1,b:27017,c:3/jobs",
);
checkEqual(
  "toConnectionUrl: a database outside the path",
  toConnectionUrl(
    { database: "jobs", params: { db: "jobs" } },
    { scheme: "x", databaseInPath: false },
  ),
  "x://127.0.0.1/?db=jobs",
);

const pgDefaults = { scheme: "postgres", port: 5432 };
checkEqual(
  "resolveConnectionUrl: a URL wins; fields otherwise",
  [
    resolveConnectionUrl(
      { url: "postgres://env/jobs", connection: { host: "file" } },
      pgDefaults,
      "sql",
    ),
    resolveConnectionUrl({ connection: { host: "file" } }, pgDefaults, "sql"),
  ],
  ["postgres://env/jobs", "postgres://file:5432/"],
);
const neither = await checkConfig(
  "resolveConnectionUrl: neither",
  () => {
    return resolveConnectionUrl({}, pgDefaults, "The sql driver");
  },
  /^The sql driver needs either a url or a connection object$/,
);
checkEqual(
  "its context",
  (neither as { context?: unknown } | undefined)?.context,
  { what: "The sql driver" },
);

checkEqual(
  "databaseFromUrl",
  [
    "postgres://u:p@h:5432/jobs",
    "redis://h:6379/13",
    "mongodb://h/my%20db?authSource=admin",
    "postgres://h",
    "postgres://h/",
    "not a url",
  ].map((url) => databaseFromUrl(url)),
  ["jobs", "13", "my db", undefined, undefined, undefined],
);

checkEqual(
  "resolveNames",
  [
    resolveNames(["jobs", "runs"], { defaultPrefix: "bun_jobs_" }),
    resolveNames(["jobs", "runs"], {
      prefix: "app_",
      defaultPrefix: "bun_jobs_",
    }),
    resolveNames(["jobs", "runs"], {
      prefix: "",
      overrides: { runs: "legacy_runs" },
      defaultPrefix: "bun_jobs_",
    }),
  ],
  [
    { jobs: "bun_jobs_jobs", runs: "bun_jobs_runs" },
    { jobs: "app_jobs", runs: "app_runs" },
    { jobs: "jobs", runs: "legacy_runs" },
  ],
);
await checkConfig(
  "resolveNames: an empty override",
  () => {
    return resolveNames(["jobs", "runs"], {
      overrides: { runs: "" },
      defaultPrefix: "bun_jobs_",
    });
  },
  /The name for "runs" cannot be empty/,
);

/* ------------------------------------------------------------------ */
step("Logging: createJobsLogger and resolveLogger");

/** One record a sink received. */
interface RecordedLog {
  /** The level it was logged at. */
  level: string;
  /** The message. */
  message: string;
  /** Fields passed at the call site. */
  fields: LogFields;
  /** Fields bound to the logger. */
  bindings: LogFields;
  /** The logger's name. */
  name?: string;
  /** The error lifted out of the fields, when there was one. */
  error?: Error;
}

const records: RecordedLog[] = [];
const jobsLogger = createJobsLogger(
  (event: RecordedLog) => {
    records.push(event);
  },
  { namespace, queue: "mail" },
  "worker:mail",
);
jobsLogger.warn("slow claim", { ms: 250 });
jobsLogger.error("claim failed", { error: new Error("connection reset") });

checkEqual(
  "a sink function receives structured records",
  records.map((record) => [
    record.level,
    record.message,
    record.fields.ms,
    record.bindings,
    record.name,
  ]),
  [
    ["warn", "slow claim", 250, { namespace, queue: "mail" }, "worker:mail"],
    [
      "error",
      "claim failed",
      undefined,
      { namespace, queue: "mail" },
      "worker:mail",
    ],
  ],
);
checkEqual(
  "an error in the fields is lifted onto the record",
  records[1]?.error?.message,
  "connection reset",
);
check(
  "resolveLogger: a Logger comes back as-is",
  resolveLogger(jobsLogger) === jobsLogger,
);
const fallback = resolveLogger(undefined);
check(
  "resolveLogger: nothing gives a working logger",
  typeof fallback.info === "function" &&
    typeof fallback.child === "function" &&
    typeof fallback.isLevelEnabled === "function",
);

/* ------------------------------------------------------------------ */
step("The child protocol: CHILD_ENV, PROTOCOL_VERSION, isRunnerChild");

checkEqual(
  "CHILD_ENV",
  { ...CHILD_ENV },
  {
    marker: "BUN_JOBS_CHILD",
    mode: "BUN_JOBS_MODE",
    namespace: "BUN_JOBS_NAMESPACE",
    runnerId: "BUN_JOBS_RUNNER_ID",
    runId: "BUN_JOBS_RUN_ID",
    file: "BUN_JOBS_FILE",
  },
);
checkEqual("PROTOCOL_VERSION", PROTOCOL_VERSION, 1);
checkEqual("isRunnerChild() in this process", isRunnerChild(), false);

/** Runs `isRunnerChild()` in a fresh process whose marker is `marker`. */
function childSays(marker: string): string {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      'import { isRunnerChild } from "@kingsleyweb/bun-jobs"; console.log(isRunnerChild());',
    ],
    cwd: import.meta.dir,
    env: { ...process.env, [CHILD_ENV.marker]: marker },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return result.stdout.toString().trim() || result.stderr.toString().trim();
}
checkEqual(
  "isRunnerChild() with the marker set to 1, and to anything else",
  [childSays("1"), childSays("true")],
  ["true", "false"],
);

/* ------------------------------------------------------------------ */
step("Date parsers: assertDateParser and CHRONO_VERSION_RANGE");

/** The installed chrono-node's version, read from its manifest. */
const chronoVersion = (
  (await Bun.file(
    new URL("../../../node_modules/chrono-node/package.json", import.meta.url),
  ).json()) as { version: string }
).version;
show("chrono-node", {
  installed: chronoVersion,
  required: CHRONO_VERSION_RANGE,
});
check(
  "the installed chrono-node satisfies CHRONO_VERSION_RANGE",
  Bun.semver.satisfies(chronoVersion, CHRONO_VERSION_RANGE),
  { chronoVersion, CHRONO_VERSION_RANGE },
);

const parser = {
  parse: () => [],
  parseDate: () => null,
};
check(
  "a parser-shaped object is returned as-is",
  assertDateParser(parser) === parser,
);
check(
  "parseDate is optional",
  assertDateParser({ parse: () => [] }) !== undefined,
);
await checkConfig(
  "no parse()",
  () => {
    return assertDateParser({ parseDate: () => null });
  },
  /^dateParser is not a date parser/,
);
await checkConfig(
  "a parseDate that is not a function",
  () => {
    return assertDateParser(
      { parse: () => [], parseDate: "soon" },
      "queue.dateParser",
    );
  },
  /^queue\.dateParser is not a date parser/,
);
const nullParser = await checkConfig(
  "null",
  () => {
    return assertDateParser(null);
  },
  /is not a date parser/,
);
checkEqual(
  "its context describes what it got",
  (nullParser as { context?: unknown } | undefined)?.context,
  { received: "null" },
);

/* ------------------------------------------------------------------ */
step("QueueLimiter.supports: can a driver hold shared limits?");

checkEqual(`the ${driver.name} driver`, QueueLimiter.supports(driver), true);
checkEqual(
  "a driver without queue state",
  QueueLimiter.supports({} as never),
  false,
);
checkEqual(
  "one with only half of it",
  QueueLimiter.supports({ getQueueState: () => null } as never),
  false,
);

/* ------------------------------------------------------------------ */
step("runnerEvent: a runner event envelope, checked against its name");

const error = { name: "Error", message: "boom" };
checkEqual(
  "an event about a run carries its id",
  runnerEvent(
    { ns: namespace, target: "nightly", type: "failed", origin: "tok", at: 5 },
    { runId: "r1", error },
  ),
  {
    v: 1,
    ns: namespace,
    kind: "runner",
    target: "nightly",
    type: "failed",
    id: "r1",
    at: 5,
    origin: "tok",
    payload: { runId: "r1", error },
  },
);
const before = Date.now();
const skipped = runnerEvent(
  { ns: namespace, target: "nightly", type: "skipped", origin: "tok" },
  { reason: "paused" },
);
check("an event about no run has no id", !("id" in skipped), skipped);
check(
  "at defaults to now",
  skipped.at >= before && skipped.at <= Date.now(),
  skipped.at,
);

/* ------------------------------------------------------------------ */
step("Clean up");

await driver.purge(namespace);
await driver.close();

summary();
