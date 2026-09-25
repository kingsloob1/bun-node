/**
 * Option tour: the read APIs a management UI needs — `list`, `page`,
 * `getJobs`, `listWorkers`, `getThroughput` and `getQueueSummaries` — with
 * every option and every edge asserted.
 *
 * ```bash
 * bun 10-options/read-apis.ts
 * EXAMPLE_DRIVER=sqlite bun 10-options/read-apis.ts
 * ```
 *
 * Worth knowing:
 *
 * - A `search` is taken **literally** on every engine: `%`, `_`, `!`, quotes,
 *   backslashes and regular-expression characters match themselves. Each one
 *   below has a job whose name contains it and a near-twin that would match if
 *   the search were read as a pattern.
 * - Case is folded for ASCII everywhere. Beyond ASCII it follows the engine,
 *   and SQLite's `LOWER` folds ASCII only — so this tour asserts the
 *   difference rather than skipping it.
 * - Every driver method behind these reads is **optional**. The sections on a
 *   wrapped driver hide them one at a time and assert the fallback gives the
 *   same answer. Only throughput has no fallback.
 * - A worker writes one heartbeat per `reportInterval`, never per job, and its
 *   record lapses three intervals after the last write. The tour waits for
 *   records rather than sleeping, except where it has to prove a negative.
 * - **`rssBytes` on a worker's record is the *process's* resident memory, not
 *   the worker's.** Two workers in one process report the same number, so a
 *   column of it must never be summed — `fleetRss` below is the right total,
 *   one row per `host`+`pid`.
 * - **`heartbeatRttMs` is how long the heartbeat *write* took at the driver**,
 *   not a network ping, and it is the last sample — in fact the previous
 *   write's, since a write cannot time itself — so it is absent on a worker's
 *   first record.
 * - Both are optional, and a record that lacks them (an older worker's) leaves
 *   them **out**: absent, never `0`.
 * - **`sweeps` is the housekeeping half of a worker's `maintenance` option and
 *   only that half** — whether it *takes part in* the minute pass that prunes
 *   expired results, heals repeat series and sweeps stale queue state. Taking
 *   part is not performing it: the field says nothing about *which* worker
 *   swept on a given pass, so `true` never means this one did the work. A
 *   reader who needs to know who swept cannot learn it here, whatever the
 *   fleet does. It says nothing about liveness. It has three states, not
 *   two: `true`, `false`, and absent on a worker too old to say — so it takes
 *   the same `Object.hasOwn` care as the two samples, and absent is never
 *   `false`.
 */
import type {
  JobsDriver,
  ListJobsOptions,
  NotSupportedError,
  WorkerInfo,
} from "@kingsleyweb/bun-jobs";
import process from "node:process";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  createDriver,
  HOST,
  MAX_TIMER_MS,
  registerWorkerRecord,
  THROUGHPUT_BUCKET_MS,
} from "@kingsleyweb/bun-jobs";
import {
  crossProcessDriver,
  exampleBackend,
  exampleDriver,
  exampleNamespace,
} from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Read APIs: search, paging, workers, throughput");

const backend = exampleBackend();
const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("read-apis");

/** How long to wait for anything a busy server might slow down. */
const LONG = { timeout: 30_000 };

/**
 * The same driver with some optional methods hidden, as a driver written
 * before them would be. Methods are bound to the real driver so its private
 * state still works.
 */
function without(real: JobsDriver, methods: (keyof JobsDriver)[]): JobsDriver {
  return new Proxy(real, {
    get(target, property) {
      if (methods.includes(property as keyof JobsDriver)) {
        return undefined;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Waits out a window in which something must *not* happen. The only sleep in
 * the tour: a negative cannot be waited for.
 */
async function quietWindow(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

/* ------------------------------------------------------------------ */
step("Seed: one job per awkward character, plus near-twins");

/**
 * The search seed. Ids are limited to letters, digits, `_`, `.` and `-`, so
 * the characters a backend might read as a pattern live in the **name** —
 * which is searched just as the id is. Each tricky entry has a twin with the
 * character replaced by `X`, so a search read as a pattern would match both.
 */
const seed: { id: string; name: string }[] = [
  { id: "inv-001", name: "sendEmail" },
  { id: "inv-002", name: "SendEmail" },
  { id: "INV-003", name: "report" },
  { id: "under_1", name: "plain" },
  { id: "underX1", name: "plain" },
  { id: "dot.star", name: "plain" },
  { id: "dotXstar", name: "plain" },
  { id: "pct-1", name: "pct%1" },
  { id: "pct-2", name: "pctX1" },
  { id: "bang-1", name: "bang!1" },
  { id: "back-1", name: "back\\slash" },
  { id: "quote-1", name: "it's" },
  { id: "dq-1", name: 'say "hi"' },
  { id: "brack-1", name: "brack[et]" },
  { id: "caret-1", name: "caret^$" },
  { id: "accent-1", name: "CAFÉ" },
];

const reads = new BunQueue(`reads`, { namespace, driver });

await reads.addBulk(
  seed.map((entry) => ({
    name: entry.name,
    // Every payload holds the characters a search must never find.
    data: { note: "needle %_ in the payload only" },
    opts: { jobId: entry.id },
  })),
);

/** Matching ids, sorted, so an assertion does not depend on the order. */
const ids = async (options: ListJobsOptions): Promise<string[]> =>
  (await reads.list("waiting", { limit: 100, ...options }))
    .map((job) => job.id)
    .sort();

/** Matching ids in the order the driver returned them. */
const ordered = async (options: ListJobsOptions): Promise<string[]> =>
  (await reads.list("waiting", { limit: 100, ...options })).map(
    (job) => job.id,
  );

checkEqual(
  "the seed is all waiting",
  await reads.count("waiting"),
  seed.length,
);

/* ------------------------------------------------------------------ */
step("search: every character taken literally");

checkEqual("% is a per cent sign, not a wildcard", await ids({ search: "%" }), [
  "pct-1",
]);
checkEqual(
  "_ is an underscore, not any character",
  await ids({ search: "r_1" }),
  ["under_1"],
);
checkEqual(
  "! — the escape character SQL LIKE uses",
  await ids({ search: "!" }),
  ["bang-1"],
);
checkEqual("a backslash", await ids({ search: "\\" }), ["back-1"]);
checkEqual("a single quote", await ids({ search: "'" }), ["quote-1"]);
checkEqual("a double quote", await ids({ search: '"' }), ["dq-1"]);
checkEqual("…and a quoted phrase", await ids({ search: 'say "h' }), ["dq-1"]);
// As a character class this would match every name holding an `e` or a `t`.
checkEqual("square brackets", await ids({ search: "[et]" }), ["brack-1"]);
// As a pattern, `^$` matches the empty string — that is, everything.
checkEqual("a caret and a dollar", await ids({ search: "^$" }), ["caret-1"]);
// As a pattern, `.` matches any character, so `dotXstar` would match too.
checkEqual("a dot", await ids({ search: "t.s" }), ["dot.star"]);

/* ------------------------------------------------------------------ */
step("search: case, and what is never searched");

checkEqual("folds ASCII case, matching ids", await ids({ search: "INV" }), [
  "INV-003",
  "inv-001",
  "inv-002",
]);
checkEqual("…and names", await ids({ search: "sendemail" }), [
  "inv-001",
  "inv-002",
]);
checkEqual("…in either direction", await ids({ search: "REPORT" }), [
  "INV-003",
]);
checkEqual("never the payload", await ids({ search: "needle" }), []);
checkEqual(
  "…not even its awkward characters",
  await ids({ search: "in the payload" }),
  [],
);
checkEqual(
  "an empty search is no search at all",
  (await ids({ search: "" })).length,
  seed.length,
);

// Beyond ASCII the engine decides. SQLite's `LOWER` folds ASCII only, so `É`
// stays `É` and never matches `é`; every other backend here folds it.
const foldsBeyondAscii = backend !== "sqlite";
checkEqual(
  foldsBeyondAscii
    ? `${backend}: case is folded beyond ASCII too, so "café" matches "CAFÉ"`
    : `${backend}: LOWER folds ASCII only, so "café" does not match "CAFÉ"`,
  await ids({ search: "café" }),
  foldsBeyondAscii ? ["accent-1"] : [],
);
checkEqual(
  "…while the ASCII part of that same name matches everywhere",
  await ids({ search: "caf" }),
  ["accent-1"],
);

/* ------------------------------------------------------------------ */
step("name: exact, one or several");

checkEqual("one name, exactly", await ids({ name: "sendEmail" }), ["inv-001"]);
// `SendEmail` is a different name: a name filter never folds case.
checkEqual("…case and all", await ids({ name: "SendEmail" }), ["inv-002"]);
checkEqual("several names", await ids({ name: ["sendEmail", "report"] }), [
  "INV-003",
  "inv-001",
]);
checkEqual("an empty array matches nothing", await ids({ name: [] }), []);
checkEqual("a name nobody used", await ids({ name: "nope" }), []);
checkEqual(
  "a name and a search compose",
  await ids({ name: ["plain"], search: "r_1" }),
  ["under_1"],
);

/* ------------------------------------------------------------------ */
step("offset, limit and order, with a filter");

const allPlain = await ordered({ name: "plain" });
checkEqual("the four jobs named plain", allPlain.length, 4);

checkEqual(
  "offset and limit count matches, not jobs",
  await ordered({ name: "plain", offset: 1, limit: 2 }),
  allPlain.slice(1, 3),
);
checkEqual(
  "order: desc is the same jobs, reversed",
  await ordered({ name: "plain", order: "desc" }),
  [...allPlain].reverse(),
);
checkEqual(
  "…and desc pages from the other end",
  await ordered({ name: "plain", order: "desc", offset: 1, limit: 2 }),
  [...allPlain].reverse().slice(1, 3),
);
checkEqual(
  "an offset past the last match is empty",
  await ordered({ name: "plain", offset: 99 }),
  [],
);
checkEqual(
  "a search pages the same way",
  await ordered({ search: "inv", offset: 1, limit: 1 }),
  (await ordered({ search: "inv" })).slice(1, 2),
);

/* ------------------------------------------------------------------ */
step("page: the slice and the total together");

const filtered = await reads.page("waiting", {
  name: "plain",
  offset: 1,
  limit: 2,
});
checkEqual(
  "page: the slice asked for",
  filtered.jobs.map((job) => job.id),
  allPlain.slice(1, 3),
);
checkEqual(
  "page: the total is every match, ignoring offset and limit",
  filtered.total,
  allPlain.length,
);

const searched = await reads.page("waiting", { search: "inv", limit: 1 });
checkEqual(
  "page: a searched total",
  [searched.jobs.length, searched.total],
  [1, 3],
);

const unfiltered = await reads.page("waiting", { limit: 5 });
checkEqual(
  "page: an unfiltered total is the states' counts",
  [unfiltered.jobs.length, unfiltered.total],
  [5, seed.length],
);
checkEqual(
  "page: several states total together",
  (await reads.page(["waiting", "completed"], { limit: 2 })).total,
  seed.length,
);
checkEqual(
  "page: nothing matched",
  await reads.page("waiting", { search: "no-such-thing" }),
  {
    jobs: [],
    total: 0,
  },
);

/* ------------------------------------------------------------------ */
step("getJobs: ids in, jobs out, in that order");

const got = await reads.getJobs(["dot.star", "missing", "inv-001", "dot.star"]);

checkEqual(
  "one entry per id, in the order asked, null for a missing one",
  got.map((job) => job?.id ?? null),
  ["dot.star", null, "inv-001", "dot.star"],
);
checkEqual("…carrying the job itself", got[2]?.name, "sendEmail");
check(
  "a repeated id is answered twice, as its own job",
  got[0] !== got[3] && got[0]?.id === got[3]?.id,
  { first: got[0]?.id, second: got[3]?.id, same: got[0] === got[3] },
);
checkEqual("no ids, no jobs", await reads.getJobs([]), []);
checkEqual("every id missing", await reads.getJobs(["nope-1", "nope-2"]), [
  null,
  null,
]);

/* ------------------------------------------------------------------ */
step("The fallbacks: the same answers from a driver without the methods");

// `findJobs` and `getJobs` are optional on the contract. Hidden, the queue
// pages through `listJobs` and filters, and reads ids one at a time.
const olderDriver = without(driver, ["findJobs", "getJobs"]);
const older = new BunQueue(`reads`, { namespace, driver: olderDriver });

checkEqual(
  "without findJobs: the scan fallback filters the same way",
  (await older.list("waiting", { search: "%", limit: 100 })).map(
    (job) => job.id,
  ),
  ["pct-1"],
);
const olderPage = await older.page("waiting", {
  name: "plain",
  offset: 1,
  limit: 2,
});
checkEqual(
  "without findJobs: the same page and total",
  [olderPage.jobs.map((job) => job.id), olderPage.total],
  [allPlain.slice(1, 3), allPlain.length],
);
checkEqual(
  "without findJobs: an unfiltered read still goes to listJobs",
  (await older.list("waiting", { limit: 3 })).map((job) => job.id),
  (await reads.list("waiting", { limit: 3 })).map((job) => job.id),
);
checkEqual(
  "without getJobs: read one id at a time, same answer",
  (await older.getJobs(["dot.star", "missing", "inv-001"])).map(
    (job) => job?.id ?? null,
  ),
  ["dot.star", null, "inv-001"],
);

await older.close();

/* ------------------------------------------------------------------ */
step("listWorkers: every field of a live worker's record");

/** Holds a job until it is released, so a worker can be seen busy. */
const held = Promise.withResolvers<void>();
const workersQueue = new BunQueue("workers", { namespace, driver });

const worker = new BunQueueWorker("workers", async () => await held.promise, {
  namespace,
  driver,
  id: "reader-1",
  concurrency: 3,
  // Short only so the tour does not wait ten seconds for the first heartbeat.
  reportInterval: 200,
  pollInterval: 25,
});
void worker.run();

// The first report is deliberately not awaited inside `run()`: a worker is
// listed moments after `ready`, not necessarily by it.
await waitFor(
  "the worker to report",
  async () => (await workersQueue.listWorkers()).length === 1,
  LONG,
);

const [listed] = await workersQueue.listWorkers();
checkEqual(
  "WorkerInfo: who and where",
  {
    id: listed?.id,
    queue: listed?.queue,
    host: listed?.host,
    pid: listed?.pid,
    concurrency: listed?.concurrency,
    active: listed?.active,
    paused: listed?.paused,
  },
  {
    id: "reader-1",
    queue: "workers",
    host: HOST,
    pid: process.pid,
    concurrency: 3,
    active: 0,
    paused: false,
  },
);
check(
  "startedAt is when it began consuming, heartbeatAt when it last reported",
  !!listed &&
    listed.startedAt <= listed.heartbeatAt &&
    listed.heartbeatAt <= Date.now(),
  listed,
);
// `sweeps` is what the worker's `maintenance` option settled on, read off the
// worker rather than off the option, so a record cannot claim what the worker
// does not do. This one took the default, so it takes part in the queue's
// housekeeping — which is not the same as having done a pass: the field says
// who is willing, never who swept. It says so with the field *present*, which
// is the half of the answer a reader must not get from falsiness.
check(
  "sweeps: a default worker reports it present and true",
  !!listed && Object.hasOwn(listed, "sweeps") && listed.sweeps === true,
  { sweeps: listed?.sweeps, keys: Object.keys(listed ?? {}).sort() },
);
checkEqual(
  "expiresAt is three report intervals past the heartbeat",
  listed!.expiresAt - listed!.heartbeatAt,
  3 * 200,
);
// Where its attempts run, as the worker resolved its `target` option: this one
// took the default and was given a function, so `"in-process"` running a
// `"function"`. A worker given a processor file reports `"file"`, and one on
// another thread or in a child process `"worker-thread"` / `"child-process"`.
checkEqual(
  "target: the default, in-process, running a function",
  listed?.target,
  { kind: "in-process", processor: "function" },
);

/* ------------------------------------------------------------------ */
step("listWorkers: the record follows the worker");

await workersQueue.add("held", {});
await waitFor("the job to be picked up", () => worker.activeCount === 1, LONG);
await worker.pause();
await waitFor(
  "the pause to be reported",
  async () => (await workersQueue.listWorkers())[0]?.paused === true,
  LONG,
);
checkEqual(
  "…with the job still in flight",
  (await workersQueue.listWorkers())[0]?.active,
  1,
);

worker.concurrency = 5;
await waitFor(
  "a concurrency change to be reported",
  async () => (await workersQueue.listWorkers())[0]?.concurrency === 5,
  LONG,
);

worker.resume();
await waitFor(
  "the resume to be reported",
  async () => (await workersQueue.listWorkers())[0]?.paused === false,
  LONG,
);

held.resolve();
await worker.close();
checkEqual(
  "a worker that closes removes its record at once",
  await workersQueue.listWorkers(),
  [],
);

/* ------------------------------------------------------------------ */
step("listWorkers: rssBytes and heartbeatRttMs, the samples the write carries");

// Both ride the heartbeat write the worker makes anyway — no timer of their
// own, no driver call of their own — and both are optional, so what matters is
// where each number comes from rather than that a number arrived.

/**
 * One worker's record, waited for until `ready` holds.
 *
 * Prints every record it saw before giving up, so a timeout names what was
 * actually there rather than only what was wanted.
 */
async function recordWhen(
  queue: BunQueue,
  id: string,
  what: string,
  ready: (info: WorkerInfo) => boolean,
): Promise<WorkerInfo> {
  let seen: WorkerInfo[] = [];
  let found: WorkerInfo | undefined;

  try {
    await waitFor(
      what,
      async () => {
        seen = await queue.listWorkers();
        found = seen.find((info) => info.id === id && ready(info));
        return found !== undefined;
      },
      LONG,
    );
  } catch (error) {
    show(`records seen while waiting for ${what}`, seen);
    throw error;
  }

  return found!;
}

// A long report interval, so exactly one write has happened when the record
// first appears — which is the case where there is no round trip to report yet.
const samplesQueue = new BunQueue("samples", { namespace, driver });
const sampled = new BunQueueWorker("samples", async () => undefined, {
  namespace,
  driver,
  id: "sampled-1",
  reportInterval: 30_000,
  pollInterval: 25,
});
void sampled.run();

const firstReport = await recordWhen(
  samplesQueue,
  "sampled-1",
  "the worker's first heartbeat record",
  () => true,
);

check(
  "rssBytes is on the very first record: whole bytes, and a real process's",
  Number.isInteger(firstReport.rssBytes) && firstReport.rssBytes! > 1_000_000,
  { rssBytes: firstReport.rssBytes },
);
// A write cannot time itself, so the first record has no round trip to carry —
// and it says so by leaving the field out, not by reporting `0`.
check(
  "heartbeatRttMs is absent on the first record, not 0",
  !Object.hasOwn(firstReport, "heartbeatRttMs") &&
    firstReport.heartbeatRttMs === undefined,
  {
    heartbeatRttMs: firstReport.heartbeatRttMs,
    keys: Object.keys(firstReport).sort(),
  },
);

// A pause reports at once, whatever the interval, so the second write happens
// now rather than in thirty seconds — and it carries the *first* write's time.
await sampled.pause();
const secondReport = await recordWhen(
  samplesQueue,
  "sampled-1",
  "a record carrying a round trip",
  (info) => info.heartbeatRttMs !== undefined,
);
check(
  "the next record carries the previous write's round trip",
  Number.isFinite(secondReport.heartbeatRttMs) &&
    secondReport.heartbeatRttMs! >= 0,
  { heartbeatRttMs: secondReport.heartbeatRttMs },
);
// It measures the driver's work — a Redis script, a SQL upsert, a MongoDB
// replace, a file rename — plus whatever was queued in front of it, not a
// network ping. Under a millisecond in memory and a few milliseconds against a
// local server; a figure near a whole report interval is the one worth an
// alert, so that is the bound asserted rather than a fixed number.
check(
  "…and it is a driver round trip, not a report interval",
  secondReport.heartbeatRttMs! < 10_000,
  { heartbeatRttMs: secondReport.heartbeatRttMs },
);
show(`heartbeatRttMs on ${backend} (ms)`, secondReport.heartbeatRttMs);

await sampled.close();

/* ------------------------------------------------------------------ */
step(
  "rssBytes is the process's memory, so a column of it must never be summed",
);

/**
 * The resident memory of a fleet of workers, in bytes.
 *
 * `rssBytes` is whatever `process.memoryUsage.rss()` answered, so **every
 * worker in one process reports the same number** and nothing apportions it
 * between them. Summing the column counts a process once per worker it runs.
 * The right total takes one row per process — `host` and `pid` together name
 * one — and adds those. A row without the field is skipped rather than read as
 * zero.
 */
function fleetRss(workers: WorkerInfo[]): number {
  const perProcess = new Map<string, number>();

  for (const info of workers) {
    if (info.rssBytes === undefined) {
      continue;
    }
    perProcess.set(`${info.host ?? "?"}:${info.pid ?? "?"}`, info.rssBytes);
  }

  return [...perProcess.values()].reduce((total, bytes) => total + bytes, 0);
}

/**
 * What this process reports while the section runs.
 *
 * Pinned only so the claim can be exact: the two records must carry *the same*
 * number, and a live reading drifts between two reports, which would prove
 * nothing either way. Restored below, and nothing else in the tour reads it.
 */
const PINNED_RSS = 512 * 1024 * 1024;
const realRss = process.memoryUsage.rss;
process.memoryUsage.rss = () => PINNED_RSS;

const pairQueue = new BunQueue("pair", { namespace, driver });
const pair = ["pair-a", "pair-b"].map((id) => {
  const instance = new BunQueueWorker("pair", async () => undefined, {
    namespace,
    driver,
    id,
    reportInterval: 150,
    pollInterval: 25,
  });
  void instance.run();
  return instance;
});

const pairRecords = await Promise.all(
  pair.map(
    async (instance) =>
      await recordWhen(
        pairQueue,
        instance.id,
        `${instance.id}'s record`,
        (info) => info.rssBytes !== undefined,
      ),
  ),
);

checkEqual(
  "two workers in one process report the same rssBytes — the process's",
  pairRecords.map((info) => info.rssBytes),
  [PINNED_RSS, PINNED_RSS],
);
checkEqual(
  "…which is the same process: one host, one pid",
  pairRecords.map((info) => `${info.host}:${info.pid}`),
  [`${HOST}:${process.pid}`, `${HOST}:${process.pid}`],
);

// A second process, on another host, running two workers of its own: what a
// fleet actually looks like to a reader of the list.
const OTHER_RSS = 300 * 1024 * 1024;
const remoteAt = Date.now();
for (const id of ["remote-a", "remote-b"]) {
  await registerWorkerRecord(driver, pairQueue.ref, {
    id,
    queue: "pair",
    host: "another-host",
    pid: 9999,
    concurrency: 1,
    active: 0,
    paused: false,
    startedAt: remoteAt - 1_000,
    heartbeatAt: remoteAt,
    expiresAt: remoteAt + 60_000,
    rssBytes: OTHER_RSS,
  });
}

// Waited for rather than read straight away: the two live workers report every
// 150ms, so a record could be mid-write, and this section is about the
// arithmetic rather than about timing.
let fleet: WorkerInfo[] = [];
try {
  await waitFor(
    "all four records to be listed",
    async () => {
      fleet = await pairQueue.listWorkers();
      return fleet.length === 4;
    },
    LONG,
  );
} catch (error) {
  show("records listed while waiting for four", fleet);
  throw error;
}

checkEqual("four workers, on two processes", fleet.length, 4);
checkEqual(
  "summing the column counts each process once per worker it runs",
  fleet.reduce((total, info) => total + (info.rssBytes ?? 0), 0),
  2 * PINNED_RSS + 2 * OTHER_RSS,
);
checkEqual(
  "…while one row per host+pid is the fleet's real resident memory",
  fleetRss(fleet),
  PINNED_RSS + OTHER_RSS,
);

await Promise.all(pair.map(async (instance) => await instance.close()));
process.memoryUsage.rss = realRss;

/* ------------------------------------------------------------------ */
step("Both samples are absent, never 0, on a record that lacks them");

// What a worker from before these fields wrote — and what every backend here
// gives back: the field is not present at all. A reader's `?? 0` would turn
// "did not report" into "reported nothing", which reads as a healthy process
// using no memory and a write that took no time.
const olderQueue = new BunQueue("older-record", { namespace, driver });
await olderQueue.connect();

const olderAt = Date.now();
await registerWorkerRecord(driver, olderQueue.ref, {
  id: "older-1",
  queue: "older-record",
  host: "another-host",
  pid: 4242,
  concurrency: 1,
  active: 0,
  paused: false,
  startedAt: olderAt - 5_000,
  heartbeatAt: olderAt,
  expiresAt: olderAt + 60_000,
});

const [olderRecord] = await olderQueue.listWorkers();
checkEqual(
  "read back with neither field present — not present, not zero",
  [
    Object.hasOwn(olderRecord!, "rssBytes"),
    Object.hasOwn(olderRecord!, "heartbeatRttMs"),
  ],
  [false, false],
);
checkEqual(
  "…so a reader sees undefined, which is a different answer from 0",
  [olderRecord!.rssBytes, olderRecord!.heartbeatRttMs],
  [undefined, undefined],
);
checkEqual(
  "and fleetRss skips it rather than adding a zero",
  fleetRss(await olderQueue.listWorkers()),
  0,
);

/* ------------------------------------------------------------------ */
step("sweeps: false is an answer, absent is not");

// The same care as the two samples above, for a different reason: `sweeps` has
// three states and a reader that treats it as two gets the wrong one. `false`
// is a worker saying it deliberately takes no part in the queue's
// housekeeping; absent is a worker too old to have the field, which has said
// nothing at all.
//
// A queue counts as having no sweeper only when at least one live worker
// reports `false` and none reports `true`. A queue whose live workers all omit
// the field has said nothing — warning about it would make every fleet that has
// not upgraded read as broken. Even then it is "may be nobody": a worker too
// old to say may be sweeping unseen.

/**
 * What a reader may honestly say about a queue's housekeeping, from its live
 * workers' records — the rule above, as code.
 *
 * `"unknown"` is the case worth the care: it is what a fleet of older workers
 * looks like, and `!info.sweeps` would report it as `"may-be-nobody"`.
 */
function sweeperVerdict(
  workers: WorkerInfo[],
): "swept" | "may-be-nobody" | "unknown" {
  if (workers.some((info) => info.sweeps === true)) {
    return "swept";
  }

  return workers.some((info) => info.sweeps === false)
    ? "may-be-nobody"
    : "unknown";
}

const sweepsQueue = new BunQueue("sweeps", { namespace, driver });
const optedOut = new BunQueueWorker("sweeps", async () => undefined, {
  namespace,
  driver,
  id: "opted-out",
  // The one thing this turns off is the housekeeping the record reports.
  maintenance: false,
  reportInterval: 150,
  pollInterval: 25,
});
void optedOut.run();

const optedOutRecord = await recordWhen(
  sweepsQueue,
  "opted-out",
  "the opted-out worker's record",
  () => true,
);
checkEqual(
  "a worker that opted out of housekeeping reports sweeps present and false",
  [Object.hasOwn(optedOutRecord, "sweeps"), optedOutRecord.sweeps],
  [true, false],
);

// Beside it, what a worker from before the field wrote: nothing in that slot.
const unknownAt = Date.now();
await registerWorkerRecord(driver, sweepsQueue.ref, {
  id: "too-old-to-say",
  queue: "sweeps",
  host: "another-host",
  pid: 4343,
  concurrency: 1,
  active: 0,
  paused: false,
  startedAt: unknownAt - 5_000,
  heartbeatAt: unknownAt,
  expiresAt: unknownAt + 60_000,
});
const olderSweeps = (await sweepsQueue.listWorkers()).find(
  (info) => info.id === "too-old-to-say",
);
checkEqual(
  "…while an older worker's record reads back absent, not false",
  [Object.hasOwn(olderSweeps ?? {}, "sweeps"), olderSweeps?.sweeps],
  [false, undefined],
);

// The two records together, and the older one on its own: absence alone is
// never the warning, and one `false` beside it is only ever "may be".
checkEqual(
  "the rule: a fleet that has said nothing is 'unknown', not 'no sweeper'",
  [
    sweeperVerdict([olderSweeps!]),
    sweeperVerdict([optedOutRecord]),
    sweeperVerdict(await sweepsQueue.listWorkers()),
  ],
  ["unknown", "may-be-nobody", "may-be-nobody"],
);
// And one worker reporting `true` settles it for the whole queue, however many
// of its siblings opted out or are too old to say.
checkEqual(
  "…and one worker reporting true answers for the queue",
  sweeperVerdict([
    ...(await sweepsQueue.listWorkers()),
    { ...optedOutRecord, id: "sweeper", sweeps: true },
  ]),
  "swept",
);

await optedOut.close();

/* ------------------------------------------------------------------ */
step("completed and failed on the record are per incarnation");

// The counts ride the same write, so a workers table has throughput per
// instance with no analytics read at all. They are the *incarnation's*: a
// restart starts them again, while the queue's own counters keep going.
const restartsQueue = new BunQueue("restarts", { namespace, driver });

/**
 * Runs one incarnation of the same worker — two completions and one failed
 * attempt — and answers the record it left, once its counts have been
 * reported.
 */
async function incarnation(): Promise<WorkerInfo> {
  const instance = new BunQueueWorker(
    "restarts",
    async (job) => {
      if (job.name === "bad") {
        throw new Error("no");
      }
      return "ok";
    },
    {
      namespace,
      driver,
      // The stable identity, shared by every incarnation; the per-incarnation
      // id is assigned for each one.
      key: "restarts.sender",
      reportInterval: 150,
      pollInterval: 25,
    },
  );
  void instance.run();

  await restartsQueue.addBulk([
    { name: "ok", data: {} },
    { name: "ok", data: {} },
    { name: "bad", data: {}, opts: { attempts: 1 } },
  ]);

  const record = await recordWhen(
    restartsQueue,
    instance.id,
    `${instance.id}'s counts`,
    (info) => info.completed === 2 && info.failed === 1,
  );
  await instance.close();
  return record;
}

const firstLife = await incarnation();
const secondLife = await incarnation();

check(
  "each incarnation has its own id, under one stable key",
  firstLife.id !== secondLife.id && firstLife.key === secondLife.key,
  {
    first: { id: firstLife.id, key: firstLife.key },
    second: { id: secondLife.id, key: secondLife.key },
  },
);
checkEqual(
  "the counts start again on the restart: per incarnation, not per key",
  [secondLife.completed, secondLife.failed],
  [2, 1],
);
// The queue's running totals are a different question, and the throughput
// counters answer it: they carry both incarnations' work.
const acrossRestarts = await restartsQueue.getThroughput({ minutes: 5 });
checkEqual(
  "…while the queue's totals keep counting across the restart",
  [acrossRestarts.completed, acrossRestarts.failed],
  [4, 2],
);

/* ------------------------------------------------------------------ */
step("reportInterval: the default, and 0");

const defaultsQueue = new BunQueue("defaults", { namespace, driver });
const defaultWorker = new BunQueueWorker("defaults", async () => undefined, {
  namespace,
  driver,
  id: "default-1",
  pollInterval: 25,
});
void defaultWorker.run();

await waitFor(
  "the default worker to report",
  async () => (await defaultsQueue.listWorkers()).length === 1,
  LONG,
);
const [byDefault] = await defaultsQueue.listWorkers();
checkEqual(
  "reportInterval defaults to 10s, so a record stands for 30s",
  byDefault!.expiresAt - byDefault!.heartbeatAt,
  30_000,
);
await defaultWorker.close();

const silentQueue = new BunQueue("silent", { namespace, driver });
const silentWorker = new BunQueueWorker("silent", async () => undefined, {
  namespace,
  driver,
  id: "silent-1",
  reportInterval: 0,
  pollInterval: 25,
});
void silentWorker.run();
await waitFor("the silent worker to run", () => silentWorker.isRunning, LONG);
await quietWindow(200);
checkEqual(
  "reportInterval: 0 writes no record at all",
  await silentQueue.listWorkers(),
  [],
);
await silentWorker.close();

await checkRejects(
  "a negative reportInterval is refused",
  () =>
    new BunQueueWorker("silent", async () => undefined, {
      namespace,
      driver,
      reportInterval: -1,
    }),
  { name: "ConfigError", code: "CONFIG" },
);

/* ------------------------------------------------------------------ */
step("listWorkers: a record lapses three intervals after its last heartbeat");

const lapsedQueue = new BunQueue("lapsed", { namespace, driver });
await lapsedQueue.connect();

// A worker on another host that died: nothing removes its record, so it
// stands until it lapses — three of its report intervals after its last
// heartbeat, which is how a dead worker leaves the list.
const interval = 150;
const wrote = Date.now();
const crashed: WorkerInfo = {
  id: "crashed-1",
  queue: "lapsed",
  host: "another-host",
  pid: 4242,
  concurrency: 2,
  active: 1,
  paused: false,
  startedAt: wrote - 5_000,
  heartbeatAt: wrote,
  expiresAt: wrote + 3 * interval,
};
await registerWorkerRecord(lapsedQueue.driver, lapsedQueue.ref, crashed);

checkEqual(
  "a record written by another process is listed",
  (await lapsedQueue.listWorkers()).map((worker_) => worker_.id),
  ["crashed-1"],
);

await waitFor(
  "the lapsed record to drop out of the list",
  async () => (await lapsedQueue.listWorkers()).length === 0,
  LONG,
);
check(
  "…and not before its three intervals were up",
  Date.now() - wrote >= 3 * interval,
  { waited: Date.now() - wrote, needed: 3 * interval },
);

/* ------------------------------------------------------------------ */
step("listWorkers: the queue-state fallback, and when there is none");

// Without the three worker methods, records live in queue state instead.
const stateDriver = without(driver, [
  "registerWorker",
  "removeWorker",
  "listWorkers",
]);
const stateQueue = new BunQueue("state-workers", {
  namespace,
  driver: stateDriver,
});
const stateWorker = new BunQueueWorker("state-workers", async () => undefined, {
  namespace,
  driver: stateDriver,
  id: "state-1",
  reportInterval: 200,
  pollInterval: 25,
});
void stateWorker.run();

await waitFor(
  "the queue-state record to appear",
  async () => (await stateQueue.listWorkers()).length === 1,
  LONG,
);
checkEqual(
  "without a worker registry, records are kept in queue state",
  (await stateQueue.listWorkers()).map((worker_) => worker_.id),
  ["state-1"],
);
await stateWorker.close();
checkEqual(
  "…and removed on close just the same",
  await stateQueue.listWorkers(),
  [],
);
await stateQueue.close();

// With neither a registry nor queue state there is no inventory to give, and
// an empty list would read as "no workers" — so it says so instead.
const noWorkersDriver = without(driver, [
  "registerWorker",
  "removeWorker",
  "listWorkers",
  "getQueueState",
  "setQueueState",
  "listQueueState",
]);
const noWorkersQueue = new BunQueue("workers", {
  namespace,
  driver: noWorkersDriver,
});
const notSupported = await checkRejects(
  "listWorkers on a driver that can keep no records",
  () => noWorkersQueue.listWorkers(),
  { name: "NotSupportedError", code: "CONFIG" },
);
checkEqual(
  "…naming the driver, the method and what it needed",
  (notSupported as NotSupportedError | undefined)?.context,
  {
    driver: driver.name,
    method: "listWorkers",
    needs: "listWorkers()",
  },
);

const noWorkersJobs = new BunJobs({ namespace, driver: noWorkersDriver });
await checkRejects(
  "jobs.listWorkers() answers the same way, not with an empty list",
  () => noWorkersJobs.listWorkers(),
  { name: "NotSupportedError", code: "CONFIG" },
);
await noWorkersJobs.close();
await noWorkersQueue.close();

/* ------------------------------------------------------------------ */
step("getThroughput: the minutes bound");

const throughputQueue = new BunQueue("throughput", { namespace, driver });

for (const minutes of [0, 1.5, 1441, Number.NaN]) {
  await checkRejects(
    `minutes: ${String(minutes)} is refused`,
    () => throughputQueue.getThroughput({ minutes }),
    { name: "ConfigError", code: "CONFIG", message: /1 to 1440/ },
  );
}

checkEqual(
  "minutes: 1 is the current minute alone",
  (await throughputQueue.getThroughput({ minutes: 1 })).buckets.length,
  1,
);
checkEqual(
  "minutes: 1440 is a full day of buckets",
  (await throughputQueue.getThroughput({ minutes: 1440 })).buckets.length,
  1440,
);
checkEqual(
  "minutes defaults to 60",
  (await throughputQueue.getThroughput()).buckets.length,
  60,
);

/* ------------------------------------------------------------------ */
step("getThroughput: buckets, completions and every failed attempt");

await throughputQueue.addBulk([
  { name: "ok", data: {} },
  { name: "ok", data: {} },
  // Three attempts, no wait between them: three failures, then dead.
  { name: "bad", data: {}, opts: { attempts: 3, backoff: 0 } },
]);

const counter = new BunQueueWorker(
  "throughput",
  async (job) => {
    if (job.name === "bad") {
      throw new Error("no");
    }
    return "done";
  },
  { namespace, driver, concurrency: 3, pollInterval: 25 },
);
void counter.run();

await waitFor(
  "two completions and one buried job",
  async () =>
    (await throughputQueue.count("completed")) === 2 &&
    (await throughputQueue.count("dead")) === 1,
  LONG,
);

// A reader in this process sees its own counts: the drivers that gather counts
// in memory write what is pending before answering.
const measured = await throughputQueue.getThroughput({ minutes: 5 });

checkEqual("interval is one minute", measured.interval, THROUGHPUT_BUCKET_MS);
checkEqual("minutes asked for is buckets returned", measured.buckets.length, 5);
checkEqual(
  "from and to are the first and last bucket",
  [measured.from, measured.to],
  [measured.buckets[0]!.at, measured.buckets.at(-1)!.at],
);
check(
  "buckets are consecutive minutes, oldest first",
  measured.buckets.every(
    (bucket, index) =>
      index === 0 ||
      bucket.at - measured.buckets[index - 1]!.at === THROUGHPUT_BUCKET_MS,
  ),
  measured.buckets.map((bucket) => bucket.at),
);
checkEqual(
  "the newest bucket is the current minute",
  measured.to,
  Math.floor(Date.now() / THROUGHPUT_BUCKET_MS) * THROUGHPUT_BUCKET_MS,
);
checkEqual("completed counts the jobs that finished", measured.completed, 2);
// The job that died failed three times, and every attempt counts — not just
// the last one.
checkEqual(
  "failed counts every attempt, the retried ones included",
  measured.failed,
  3,
);
checkEqual(
  "the totals are the buckets summed",
  [
    measured.buckets.reduce((sum, bucket) => sum + bucket.completed, 0),
    measured.buckets.reduce((sum, bucket) => sum + bucket.failed, 0),
  ],
  [measured.completed, measured.failed],
);
check(
  "minutes with nothing in them are still there, as zeros",
  measured.buckets.filter(
    (bucket) => bucket.completed === 0 && bucket.failed === 0,
  ).length >= 3,
  measured.buckets,
);

await counter.close();

/* ------------------------------------------------------------------ */
step("getThroughput: a closing worker writes what it gathered");

// MySQL, MariaDB, SQLite, MongoDB and the file driver gather counts in memory
// and write them about once a second; Redis, Postgres and memory count inside
// the completion itself. Either way, closing writes what is pending — even on
// a driver the worker does not own. Two driver instances on one backend show
// it: the reader has no memory of the writer's counts.
const sharedConfig = crossProcessDriver();
const writerDriver = createDriver(sharedConfig);
const readerDriver = createDriver(sharedConfig);

const flushQueue = new BunQueue("flush", { namespace, driver: writerDriver });
const flushWorker = new BunQueueWorker("flush", async () => "ok", {
  namespace,
  driver: writerDriver,
  pollInterval: 25,
});
void flushWorker.run();

await flushQueue.add("n", {});
await waitFor(
  "the job to complete",
  async () => (await flushQueue.count("completed")) === 1,
  LONG,
);

// The worker does not own this driver — the tour built it — and still flushes.
await flushWorker.close();

const readerQueue = new BunQueue("flush", { namespace, driver: readerDriver });
checkEqual(
  "another reader sees the count as soon as the worker has closed",
  (await readerQueue.getThroughput({ minutes: 5 })).completed,
  1,
);

await readerQueue.close();
await flushQueue.close();
await writerDriver.purge(namespace);
await Promise.all([writerDriver.close(), readerDriver.close()]);

/* ------------------------------------------------------------------ */
step("getThroughput: the one read with no fallback");

// Counts that were never kept cannot be rebuilt from jobs retention removed,
// so this is the only read here that refuses rather than falling back. It
// carries the `CONFIG` code, as every configuration mistake does.
const noCountsQueue = new BunQueue("throughput", {
  namespace,
  driver: without(driver, ["getThroughput"]),
});
await checkRejects(
  "getThroughput on a driver that keeps no counts",
  () => noCountsQueue.getThroughput(),
  { code: "CONFIG", message: /getThroughput/ },
);
await noCountsQueue.close();

/* ------------------------------------------------------------------ */
step("getQueueSummaries: every queue in the namespace");

const summaryNamespace = exampleNamespace("read-apis-summary");
const jobs = new BunJobs({ namespace: summaryNamespace, driver });

await jobs.queue("mail").add("send", {});
await jobs.queue("mail").add("send", {}, { delay: 60_000 });
await jobs.queue("images").add("resize", {});
await jobs.queue("images").pause();

const summaries = await jobs.getQueueSummaries();

checkEqual(
  "ordered by name",
  summaries.map((entry) => entry.name),
  ["images", "mail"],
);
checkEqual(
  "counts, total and the cluster-wide pause flag",
  summaries.map((entry) => ({
    name: entry.name,
    total: entry.total,
    paused: entry.paused,
    waiting: entry.counts.waiting,
    delayed: entry.counts.delayed,
  })),
  [
    { name: "images", total: 1, paused: true, waiting: 1, delayed: 0 },
    { name: "mail", total: 2, paused: false, waiting: 1, delayed: 1 },
  ],
);
checkEqual(
  "counts carry every state, zeros included",
  Object.keys(summaries[0]!.counts).sort(),
  [
    "active",
    "completed",
    "dead",
    "delayed",
    "failed",
    "waiting",
    "waiting-children",
  ],
);
checkEqual(
  "total is the counts summed",
  summaries.map((entry) =>
    Object.values(entry.counts).reduce((sum, count) => sum + count, 0),
  ),
  summaries.map((entry) => entry.total),
);
// The tour's other namespace holds many more queues, and none of them is here.
check(
  "nothing outside the namespace is counted",
  summaries.every((entry) => ["images", "mail"].includes(entry.name)),
  summaries.map((entry) => entry.name),
);

// `countJobsByQueue` is optional too: without it, each queue is counted on its
// own and the answer is the same.
const fallbackJobs = new BunJobs({
  namespace: summaryNamespace,
  driver: without(driver, ["countJobsByQueue"]),
});
checkEqual(
  "without countJobsByQueue: counted queue by queue, same answer",
  (await fallbackJobs.getQueueSummaries()).map((entry) => [
    entry.name,
    entry.total,
    entry.paused,
  ]),
  summaries.map((entry) => [entry.name, entry.total, entry.paused]),
);
await fallbackJobs.close();

/* ------------------------------------------------------------------ */
step("MAX_TIMER_MS");

// Exported from the package root, so a caller scheduling far ahead can clamp
// a delay to what a timer can hold rather than discovering the limit.
checkEqual(
  "MAX_TIMER_MS is the longest a timer can be set for",
  MAX_TIMER_MS,
  2_147_483_647,
);

/* ------------------------------------------------------------------ */
step("Cleanup");

show("backend", backend);

await jobs.purge();
await jobs.close();
await Promise.all([
  reads.close(),
  workersQueue.close(),
  samplesQueue.close(),
  pairQueue.close(),
  olderQueue.close(),
  restartsQueue.close(),
  defaultsQueue.close(),
  silentQueue.close(),
  lapsedQueue.close(),
  throughputQueue.close(),
]);
await driver.purge(namespace);
await driver.close();

summary();
