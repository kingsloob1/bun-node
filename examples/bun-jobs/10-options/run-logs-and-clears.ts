/**
 * Option tour: run logs, and the two clear actions — a job's log and a
 * runner's history — through the library and the management API.
 *
 * ```bash
 * bun 10-options/run-logs-and-clears.ts
 * EXAMPLE_DRIVER=sqlite bun 10-options/run-logs-and-clears.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://127.0.0.1:6379/13 \
 *   bun 10-options/run-logs-and-clears.ts
 * ```
 *
 * Every backend stores run logs and implements both clears, so the same
 * checks run on all eight.
 *
 * The points that are easy to get wrong:
 *
 * - **Where a line comes from depends on the execution mode.** A `spawn` run
 *   is captured from its pipes, so `process.stdout.write` lands too; a
 *   `worker` or `in-process` run has no pipes, so its `console` is captured
 *   instead and a raw write escapes. `ctx.log()` lands everywhere.
 * - **An in-process run shares the host's console**, so capture is attributed
 *   by async context: two runs at once each get their own lines, and the
 *   host's own `console.log` is never captured.
 * - **`dropped` and `lastSeq` belong to the run, not to the page**: a
 *   `?stream=` or `?since=` filter never changes them, which is what makes a
 *   filtered tail resume correctly. `capped` is `dropped` in the present
 *   tense: true only while the run is live.
 * - **The `logs` event is a hint**, `{ runId, lastSeq }` with no text, only
 *   published with `publish` on, throttled to one per `RUN_LOG_HINT_MS`.
 * - **Clearing refuses what is still running.** A job's log cannot be
 *   cleared while it is active (409 `JOB_ACTIVE`), and a runner's history
 *   clear keeps every run still in progress, record and log whole.
 */
import type {
  BunRunner,
  BunRunnerOptions,
  ExecutionMode,
  RunLogRedactOptions,
  RunRecord,
} from "@kingsleyweb/bun-jobs";
import type {
  RunLogLineDto,
  RunLogPageDto,
} from "@kingsleyweb/bun-jobs/api/contract";
import type { RunLogArgs, RunLogResult } from "./handlers/runlog-writer";
import { hostname } from "node:os";
import process from "node:process";
import { BunRouter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createDriver,
  createJobsApi,
  createRedactor,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_REPLACEMENT,
  DEFAULT_STALE_RUN_AFTER,
  EXECUTION_MODES,
  planHistoryClear,
  RUN_LOG_HINT_MS,
  runnerKey,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { SECRET_LINES } from "./handlers/runlog-writer";

title("Option tour: run logs and the clear actions");

/** Generous ceiling for anything a busy machine or a slow server stretches. */
const WAIT = { timeout: 30_000, interval: 10 };

const config = exampleDriver();
const namespace = exampleNamespace("tour-runlogs");
/** One driver both contexts share, so the second one is "another process". */
const driver = createDriver(config);

const jobs = new BunJobs({
  namespace,
  driver,
  logger: createTestLogger().logger,
  // A driver instance cannot cross into a spawned child; its config can.
  runnerDefaults: { childDriver: config },
});

const handler = new URL("./handlers/runlog-writer.ts", import.meta.url);

/* ------------------------------------------------------------------ *
 * The management API, mounted the way a host would.
 * ------------------------------------------------------------------ */

/** What one request answered. */
interface Answer {
  /** The HTTP status. */
  status: number;
  /** The parsed JSON body, or `undefined` for an empty one. */
  body: any;
}

/** Mounts an API over `context`, with every action it is given. */
function mount(
  context: BunJobs,
  overrides: Partial<Parameters<typeof createJobsApi>[0]> = {},
) {
  const api = createJobsApi({
    jobs: context,
    basePath: "/admin/jobs",
    logger: createTestLogger().logger,
    authorize: () => true,
    ...overrides,
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);

  return async (method: string, path: string): Promise<Answer> => {
    const response = await root.fetch(`/admin/jobs${path}`, { method });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
    };
  };
}

const call = mount(jobs);

/** Reads a page of one run's log through the API. */
async function readLog(
  runnerId: string,
  runId: string,
  query = "",
): Promise<RunLogPageDto> {
  const answer = await call(
    "GET",
    `/runners/${runnerId}/runs/${runId}/logs${query}`,
  );
  if (answer.status !== 200) {
    throw new Error(
      `log read answered ${answer.status}: ${JSON.stringify(answer.body)}`,
    );
  }
  return answer.body as RunLogPageDto;
}

/* ------------------------------------------------------------------ *
 * Runs: started, held, and waited on.
 * ------------------------------------------------------------------ */

/** Run ids whose handler has sent `"held"`. */
const held = new Set<string>();

/** A runner on the writer handler, which reports when a run is held. */
function writer(
  id: string,
  options: Partial<
    Omit<BunRunnerOptions<RunLogArgs>, "id" | "namespace" | "file">
  > = {},
): BunRunner<RunLogArgs, RunLogResult> {
  const runner = jobs.runner<RunLogArgs, RunLogResult>({
    id,
    file: handler,
    executionMode: "in-process",
    ...options,
  });
  runner.on("message", (run, data) => {
    if (data === "held") {
      held.add(run.runId);
    }
  });
  return runner;
}

/** Triggers a run and answers its id. */
async function start(
  runner: BunRunner<RunLogArgs, RunLogResult>,
  args: RunLogArgs,
): Promise<string> {
  const outcome = await runner.trigger({ args });
  if (outcome.outcome !== "started") {
    throw new Error(`trigger answered ${JSON.stringify(outcome)}`);
  }
  return outcome.runId;
}

/** Waits for a run's record to settle, and answers it. */
async function settled(
  runner: BunRunner<RunLogArgs, RunLogResult>,
  runId: string,
): Promise<RunRecord> {
  let record: RunRecord | undefined;
  await waitFor(
    `run ${runId} of ${runner.id} to settle`,
    async () => {
      record = (await runner.history()).find((run) => run.runId === runId);
      return record !== undefined && record.status !== "running";
    },
    WAIT,
  );
  return record!;
}

/** Runs to completion and answers the settled record. */
async function runToEnd(
  runner: BunRunner<RunLogArgs, RunLogResult>,
  args: RunLogArgs,
): Promise<RunRecord> {
  return await settled(runner, await start(runner, args));
}

/** The texts of the lines on one stream. */
function texts(page: RunLogPageDto, stream: RunLogLineDto["stream"]): string[] {
  return page.items
    .filter((line) => line.stream === stream)
    .map((line) => line.message);
}

/* ------------------------------------------------------------------ */
step("What is captured, per execution mode");

for (const mode of EXECUTION_MODES as readonly ExecutionMode[]) {
  const runner = writer(`writer-${mode}`, { executionMode: mode });
  /** `log` events, whose message is the `ctx.log()` text. */
  const logEvents: string[] = [];
  /** `output` chunks, from a piped child only. */
  let output = "";
  runner.on("log", (_run, _level, message) => logEvents.push(message));
  runner.on("output", (_run, _stream, chunk) => {
    output += chunk;
  });
  await runner.start();

  const record = await runToEnd(runner, { tag: mode, raw: true });
  const page = await readLog(runner.id, record.runId, "?limit=100");
  show(
    `${mode}: stored lines`,
    page.items.map((line) => `${line.stream}: ${line.message}`),
  );

  checkEqual(`${mode}: the run succeeded`, record.status, "success");
  const logLine = page.items.find((line) => line.stream === "log");
  checkEqual(
    `${mode}: ctx.log() is the log stream, with its fields rendered as key=value`,
    [logLine?.message, logLine?.level],
    [`${mode} started mode=${mode} note="a b"`, "info"],
  );
  check(
    `${mode}: console.log and console.info are stdout`,
    texts(page, "stdout").includes(`${mode} console.log`) &&
      texts(page, "stdout").includes(`${mode} console.info`),
    texts(page, "stdout"),
  );
  check(
    `${mode}: console.warn and console.error are stderr`,
    texts(page, "stderr").includes(`${mode} console.warn`) &&
      texts(page, "stderr").includes(`${mode} console.error`),
    texts(page, "stderr"),
  );
  checkEqual(
    `${mode}: process.stdout.write is captured ${mode === "spawn" ? "from the pipe" : "nowhere: it escapes"}`,
    texts(page, "stdout").includes(`${mode} process.stdout.write`),
    mode === "spawn",
  );
  checkEqual(
    `${mode}: the record's logLines is what the store holds`,
    [record.logLines, record.logsDropped],
    [page.lastSeq, 0],
  );
  if (mode !== "in-process") {
    check(
      `${mode}: ctx.log() also surfaces as the runner's log event`,
      logEvents.includes(`${mode} started`),
      logEvents,
    );
  }
  checkEqual(
    `${mode}: the output event carries ${mode === "spawn" ? "the piped chunks" : "nothing: captured console lines are not output"}`,
    output.includes(`${mode} console.log`),
    mode === "spawn",
  );
}

/* ------------------------------------------------------------------ */
step("Two in-process runs at once, and the host, each keep their own lines");

const pair = writer("writer-pair", { runMode: "parallel" });
await pair.start();
const [runA, runB] = await Promise.all([
  start(pair, { tag: "A", lines: 5, lineGap: 5 }),
  start(pair, { tag: "B", lines: 5, lineGap: 5 }),
]);
console.log("HOST a line the host application wrote while both ran");
await settled(pair, runA);
await settled(pair, runB);

for (const [tag, runId] of [
  ["A", runA],
  ["B", runB],
] as const) {
  const lines = texts(await readLog(pair.id, runId, "?limit=100"), "stdout");
  check(
    `run ${tag} holds only its own console lines (${lines.length})`,
    lines.length === 7 && lines.every((text) => text.startsWith(`${tag} `)),
    lines,
  );
}

/* ------------------------------------------------------------------ */
step("The logs hint, and a tail that follows it");

const hinting = writer("writer-hint", { publish: true });
const quiet = writer("writer-quiet");
/** `logs` payloads heard for each runner, in order. */
const hints: Record<string, { runId: string; lastSeq: number }[]> = {
  [hinting.id]: [],
  [quiet.id]: [],
};
const unsubscribers = await Promise.all(
  [hinting.id, quiet.id].map(
    async (id) =>
      await driver.subscribe(namespace, "runner", id, (event) => {
        if (event.type === "logs") {
          hints[id]!.push(event.payload);
        }
      }),
  ),
);
await hinting.start();
await quiet.start();

const hinted = await runToEnd(hinting, { tag: "hint", lines: 25, lineGap: 60 });
await runToEnd(quiet, { tag: "quiet", lines: 3 });
await waitFor(
  "the final hint, carrying the run's last line",
  () => hints[hinting.id]!.some((hint) => hint.lastSeq === hinted.logLines),
  WAIT,
);
show("hints heard", hints[hinting.id]);

const heard = hints[hinting.id]!;
check(
  "each hint names the run and a position, and carries no text",
  heard.every(
    (hint) =>
      hint.runId === hinted.runId &&
      Object.keys(hint).sort().join() === "lastSeq,runId",
  ),
  heard,
);
check(
  "lastSeq only moves forward",
  heard.every(
    (hint, index) => index === 0 || hint.lastSeq >= heard[index - 1]!.lastSeq,
  ),
  heard,
);
check(
  `throttled to one per ${RUN_LOG_HINT_MS}ms: fewer hints than lines (${heard.length} < ${hinted.logLines})`,
  heard.length >= 1 && heard.length < (hinted.logLines ?? 0),
  { hints: heard.length, lines: hinted.logLines },
);
checkEqual("a runner without publish sends no hint", hints[quiet.id], []);

// A tail: keep the last seq held, and read `since` it until nothing is left.
const tailed: number[] = [];
let cursor = 0;
for (;;) {
  const page = await readLog(
    hinting.id,
    hinted.runId,
    `?since=${cursor}&limit=7`,
  );
  if (page.items.length === 0) {
    break;
  }
  tailed.push(...page.items.map((line) => line.seq));
  cursor = page.items.at(-1)!.seq;
}
checkEqual(
  "a tail with ?since= never repeats a line and never skips one",
  tailed,
  Array.from({ length: hinted.logLines ?? 0 }, (_, index) => index + 1),
);

/* ------------------------------------------------------------------ */
step(
  "Caps: maxLines drops the oldest, maxLineBytes truncates, capped while live",
);

const capped = writer("writer-caps", {
  captureLogs: { maxLines: 5, maxLineBytes: 64 },
});
await capped.start();
const cappedRun = await start(capped, {
  tag: "caps",
  lines: 12,
  longLine: 200,
  hold: true,
});
await waitFor("the capped run to hold", () => held.has(cappedRun), WAIT);

const live = await readLog(capped.id, cappedRun);
show("while live", { ...live, items: live.items.map((line) => line.seq) });
// 5 lines from the handler's preamble, 12 numbered, 1 long: 18 in all.
checkEqual(
  "while it runs: 5 kept, 13 dropped, live and capped",
  [live.items.length, live.dropped, live.lastSeq, live.live, live.capped],
  [5, 13, 18, true, true],
);
const long = live.items.at(-1)!;
check(
  "the long line is cut to maxLineBytes and marked truncated",
  long.truncated === true &&
    new TextEncoder().encode(long.message).length <= 64 &&
    long.message.startsWith("caps LLLL"),
  long,
);

const stderrOnly = await readLog(capped.id, cappedRun, "?stream=stderr");
checkEqual(
  "?stream=stderr finds nothing kept, yet dropped and lastSeq stay the run's own",
  [stderrOnly.items.length, stderrOnly.dropped, stderrOnly.lastSeq],
  [0, live.dropped, live.lastSeq],
);
const logOnly = await readLog(capped.id, cappedRun, "?stream=log");
checkEqual(
  "?stream=log: the same two figures again",
  [logOnly.dropped, logOnly.lastSeq],
  [live.dropped, live.lastSeq],
);

capped.send("go", cappedRun);
const cappedRecord = await settled(capped, cappedRun);
const after = await readLog(capped.id, cappedRun);
checkEqual(
  "once settled: still a tail, no longer live, so no longer capped",
  [after.items.length, after.dropped, after.live, after.capped],
  [5, 14, false, false],
);
checkEqual(
  "the record's counters agree with the log",
  [cappedRecord.logLines, cappedRecord.logsDropped],
  [5, after.dropped],
);

/* ------------------------------------------------------------------ */
step("maxBytes and the captureBytes ceiling");

const byBytes = writer("writer-bytes", {
  captureLogs: { maxLines: 0, maxBytes: 60 },
});
await byBytes.start();
const byBytesRun = await runToEnd(byBytes, { tag: "b", lines: 20 });
const byBytesLog = await readLog(byBytes.id, byBytesRun.runId, "?limit=100");
check(
  "maxBytes: the text kept is at most 60 bytes, the oldest lines gone",
  byBytesLog.items.reduce(
    (sum, line) => sum + new TextEncoder().encode(line.message).length,
    0,
  ) <= 60 &&
    byBytesLog.dropped > 0 &&
    byBytesLog.items.at(-1)?.message === "b line 20",
  byBytesLog,
);

const ceiling = writer("writer-ceiling", {
  captureLogs: { captureBytes: 120 },
});
await ceiling.start();
const ceilingRun = await runToEnd(ceiling, { tag: "c", lines: 40 });
const ceilingLog = await readLog(ceiling.id, ceilingRun.runId, "?limit=100");
const notice = ceilingLog.items.at(-1);
show("the last line stored", notice);
check(
  "captureBytes: capture stops and stores one last log line saying so",
  notice?.stream === "log" &&
    notice.message.startsWith("[bun-jobs] run log capture stopped") &&
    ceilingLog.items.length < 40,
  ceilingLog.items.length,
);
checkEqual(
  "the run itself is unaffected",
  [ceilingRun.status, ceilingRun.result],
  ["success", { tag: "c", mode: "in-process" }],
);

await checkRejects(
  "a negative cap is a ConfigError at construction",
  () => writer("writer-bad", { captureLogs: { maxLines: -1 } }),
  { name: "ConfigError" },
);

/* ------------------------------------------------------------------ */
step("Redaction: the built-in rules, your own, and off");

checkEqual(
  "DEFAULT_REDACT_REPLACEMENT",
  DEFAULT_REDACT_REPLACEMENT,
  "[REDACTED]",
);
check(
  "DEFAULT_REDACT_KEYS match by substring; key alone is not one",
  DEFAULT_REDACT_KEYS.includes("password") &&
    !(DEFAULT_REDACT_KEYS as readonly string[]).includes("key"),
  DEFAULT_REDACT_KEYS,
);

/** Each redaction setting, and what it stores for each of `SECRET_LINES`. */
const redactions: {
  id: string;
  redact: boolean | RunLogRedactOptions;
  expected: string[];
}[] = [
  {
    id: "redact-default",
    redact: true,
    expected: [
      "DB_PASSWORD=[REDACTED] user=ada",
      "Authorization: Bearer [REDACTED]",
      "connecting to postgres://app:[REDACTED]@db.internal/prod",
      // A documented false positive: `tokens` contains `token`.
      "max_tokens=[REDACTED]",
      "charge sk_live_4eC39Hq ssn=123-45-6789",
    ],
  },
  {
    id: "redact-custom",
    redact: { keys: ["ssn"], patterns: [/sk_live_\w+/] },
    expected: [
      "DB_PASSWORD=[REDACTED] user=ada",
      "Authorization: Bearer [REDACTED]",
      "connecting to postgres://app:[REDACTED]@db.internal/prod",
      "max_tokens=[REDACTED]",
      "charge [REDACTED] ssn=[REDACTED]",
    ],
  },
  {
    id: "redact-own",
    redact: { defaults: false, patterns: [/sk_live_\w+/], replacement: "***" },
    expected: [
      "DB_PASSWORD=hunter2 user=ada",
      "Authorization: Bearer abc123def",
      "connecting to postgres://app:s3cret@db.internal/prod",
      "max_tokens=100",
      "charge *** ssn=123-45-6789",
    ],
  },
  { id: "redact-off", redact: false, expected: [...SECRET_LINES] },
];

for (const { id, redact, expected } of redactions) {
  const runner = writer(id, { captureLogs: { redact } });
  await runner.start();
  const record = await runToEnd(runner, { tag: "r", secrets: true });
  const stored = texts(
    await readLog(id, record.runId, "?limit=100"),
    "stdout",
  ).filter((text) => !text.startsWith("r "));
  checkEqual(`${id}: what is stored`, stored, expected);

  // The same rules, on their own: what capture runs on every line.
  const redactor = createRedactor(redact);
  checkEqual(
    `${id}: createRedactor() gives the same answer`,
    SECRET_LINES.map((line) => redactor?.(line) ?? line),
    expected,
  );
}

/* ------------------------------------------------------------------ */
step("Reading errors");

const unknownRun = await call(
  "GET",
  `/runners/${capped.id}/runs/no-such-run/logs`,
);
checkEqual(
  "an unknown run is 404 RUN_NOT_FOUND",
  [unknownRun.status, unknownRun.body?.code],
  [404, "RUN_NOT_FOUND"],
);
const unknownRunner = await call("GET", "/runners/no-such-runner/runs/x/logs");
checkEqual(
  "an unknown runner is 404 RUNNER_NOT_FOUND",
  [unknownRunner.status, unknownRunner.body?.code],
  [404, "RUNNER_NOT_FOUND"],
);

/* ------------------------------------------------------------------ */
step("Clearing a job's log: refused while active, then cleared");

/** Resolves the held job's processor. */
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const queue = jobs.queue<{ hold: boolean }>("logged");
const worker = jobs.worker<{ hold: boolean }>("logged", async (job) => {
  for (let line = 1; line <= 5; line++) {
    await job.log(`step ${line}`);
  }
  if (job.data.hold) {
    await gate;
  }
  return "done";
});
void worker.run();

/** What `keepLogs: 3` leaves of the five lines the processor writes. */
const KEPT_LINES = ["step 3", "step 4", "step 5"];

const logged = await queue.add("logged", { hold: true }, { keepLogs: 3 });
// Wait for the exact three lines, never for a count of three: with five lines
// written and `keepLogs: 3`, a count of three is reached **twice** — once
// mid-write, when lines 1 to 3 are in and nothing has been trimmed yet, and
// again once the cap has trimmed the fifth write back. Waiting on the count
// therefore proceeds at the first crossing, two lines early, and the reads
// below then race the rest of the writing.
//
// They can also catch a transient fourth row: a driver appends the line and
// trims the cap in two statements, so between the fifth insert and its trim
// the log really does hold four lines. That is expected and must not be
// asserted against — it is what once failed here on MySQL, about one run in
// eight, with ["step 2", "step 3", "step 4", "step 5"].
await waitFor(
  "the job to be active with only the lines keepLogs keeps",
  async () => {
    const job = await queue.getJob(logged.id);
    if (job?.state !== "active") {
      return false;
    }
    return Bun.deepEquals((await job.getLogs()).logs, KEPT_LINES);
  },
  WAIT,
);

checkEqual(
  "queue.clearJobLogs() on an active job: { status: 'active' }",
  await queue.clearJobLogs(logged.id),
  { status: "active" },
);
checkEqual(
  "job.clearLogs() says the same",
  await (await queue.getJob(logged.id))!.clearLogs(),
  { status: "active" },
);
const refused = await call("DELETE", `/queues/logged/jobs/${logged.id}/logs`);
checkEqual(
  "DELETE /queues/:queue/jobs/:id/logs is 409 JOB_ACTIVE",
  [refused.status, refused.body?.code],
  [409, "JOB_ACTIVE"],
);
checkEqual(
  "and nothing was removed",
  (await (await queue.getJob(logged.id))!.getLogs()).logs,
  KEPT_LINES,
);

release();
await waitFor(
  "the job to complete",
  async () => (await queue.getJob(logged.id))?.state === "completed",
  WAIT,
);
const countsBefore = await queue.count();

checkEqual(
  "once settled: cleared, and removed counts only the lines keepLogs kept",
  await queue.clearJobLogs(logged.id),
  { status: "cleared", removed: 3 },
);
const cleared = (await queue.getJob(logged.id))!;
checkEqual(
  "the log reads as one never written",
  (await cleared.getLogs()).count,
  0,
);
checkEqual(
  "the next line logged is line 1",
  await cleared.log("after the clear"),
  1,
);
await cleared.log("and another");
checkEqual(
  "the job itself is untouched",
  [cleared.state, cleared.returnValue],
  ["completed", "done"],
);
checkEqual("no counter moved", await queue.count(), countsBefore);

const viaApi = await call("DELETE", `/queues/logged/jobs/${logged.id}/logs`);
checkEqual(
  "over the API: 200 { removed }",
  [viaApi.status, viaApi.body],
  [200, { removed: 2 }],
);
checkEqual(
  "job.clearLogs() on an empty log removes nothing",
  await cleared.clearLogs(),
  { status: "cleared", removed: 0 },
);

checkEqual(
  "an unknown id: { status: 'missing' }",
  await queue.clearJobLogs("no-such-job"),
  { status: "missing" },
);
const missing = await call("DELETE", "/queues/logged/jobs/no-such-job/logs");
checkEqual(
  "and 404 JOB_NOT_FOUND over the API",
  [missing.status, missing.body?.code],
  [404, "JOB_NOT_FOUND"],
);

const readOnly = mount(jobs, { readOnly: true });
const pruned = await readOnly(
  "DELETE",
  `/queues/logged/jobs/${logged.id}/logs`,
);
checkEqual(
  "readOnly removes the route (both clears are mutations)",
  [pruned.status, pruned.body?.code],
  [404, "ROUTE_NOT_FOUND"],
);
const narrow = mount(jobs, { actions: ["jobs.read", "jobs.logs"] });
const unnamed = await narrow("DELETE", `/queues/logged/jobs/${logged.id}/logs`);
checkEqual(
  "an actions list must name jobs.clearLogs",
  [unnamed.status, unnamed.body?.code],
  [404, "ROUTE_NOT_FOUND"],
);

/* ------------------------------------------------------------------ */
step("Clearing a runner's history: runs in progress are kept");

const history = writer("history", { runMode: "parallel" });
await history.start();
for (let run = 0; run < 3; run++) {
  await runToEnd(history, { tag: `done-${run}` });
}
const liveRun = await start(history, { tag: "live", hold: true });
await waitFor("the live run to hold", () => held.has(liveRun), WAIT);

// Two records no process is executing: a crash two days ago, and one an hour
// old. Only age can vouch for them, and only the young one passes.
const orphan = (runId: string, age: number): RunRecord => ({
  runId,
  runnerId: history.id,
  attempt: 1,
  source: "manual",
  mode: "in-process",
  host: hostname(),
  pid: process.pid,
  startedAt: Date.now() - age,
  status: "running",
});
await driver.appendHistory(
  namespace,
  runnerKey(history.id),
  orphan("crashed", 2 * DEFAULT_STALE_RUN_AFTER),
  50,
);
await driver.appendHistory(
  namespace,
  runnerKey(history.id),
  orphan("young", 3_600_000),
  50,
);

const records = await history.history();
const plan = planHistoryClear({
  records,
  local: history.activeRuns,
  now: Date.now(),
  staleAfter: DEFAULT_STALE_RUN_AFTER,
});
show("planHistoryClear() preview", plan);
checkEqual(
  "the preview keeps the live run and the young record, newest first",
  plan.keep,
  ["young", liveRun],
);
checkEqual(
  "and removes the three finished runs and the crash",
  plan.remove.length,
  4,
);

const statsBefore = await history.stats();
await checkRejects(
  "staleAfter: -1 is a ConfigError",
  () => history.clearHistory({ staleAfter: -1 }),
  { name: "ConfigError" },
);
const result = await history.clearHistory();
checkEqual("clearHistory(): what it removed and kept", result, {
  removed: 4,
  kept: ["young", liveRun],
});
checkEqual(
  "the history is exactly the kept runs",
  (await history.history()).map((run) => run.runId),
  ["young", liveRun],
);
checkEqual("stats() is untouched", await history.stats(), statsBefore);
checkEqual(
  "the live run's log is whole: it still starts at line 1",
  (await readLog(history.id, liveRun, "?limit=1")).items[0]?.seq,
  1,
);

history.send("go", liveRun);
const liveRecord = await settled(history, liveRun);
const liveLog = await readLog(history.id, liveRun, "?limit=100");
checkEqual(
  "it settles as usual, and its log kept growing after the clear",
  [liveRecord.status, liveLog.items.at(-1)?.message, liveLog.items[0]?.seq],
  ["success", "live released", 1],
);

/* ------------------------------------------------------------------ */
step("Clearing from another process: RunnerController and the API");

// A second context on the same backend registers no runner: an admin service.
const admin = new BunJobs({
  namespace,
  driver,
  logger: createTestLogger().logger,
});
const remote = await admin.runners.controller("history");
checkEqual("the admin holds no local runner", remote.isLocal, false);

const secondLive = await start(history, { tag: "second", hold: true });
await waitFor("the second live run to hold", () => held.has(secondLive), WAIT);
const remoteResult = await remote.clearHistory();
checkEqual(
  "remote.clearHistory() works with no owner reachable; the running record is kept by its age",
  remoteResult,
  { removed: 1, kept: [secondLive, "young"] },
);
await checkRejects(
  "a remote runner the backend does not know",
  () => admin.runners.controller("no-such-runner"),
  { name: "RunnerNotFoundError" },
);

const adminCall = mount(admin);
const tooLow = await adminCall(
  "DELETE",
  "/runners/history/history?staleAfter=1000",
);
checkEqual(
  "the API cannot lower staleAfter below a day: 400 VALIDATION",
  [tooLow.status, tooLow.body?.code],
  [400, "VALIDATION"],
);
const tooHigh = await adminCall(
  "DELETE",
  `/runners/history/history?staleAfter=${31 * DEFAULT_STALE_RUN_AFTER}`,
);
checkEqual(
  "nor raise it past thirty days",
  [tooHigh.status, tooHigh.body?.code],
  [400, "VALIDATION"],
);
history.send("go", secondLive);
await settled(history, secondLive);
const overApi = await adminCall(
  "DELETE",
  `/runners/history/history?staleAfter=${2 * DEFAULT_STALE_RUN_AFTER}`,
);
checkEqual(
  "DELETE /runners/:runner/history from the admin's API: 200 { removed, kept }",
  [overApi.status, overApi.body],
  [200, { removed: 1, kept: ["young"] }],
);
const noRunner = await adminCall("DELETE", "/runners/no-such-runner/history");
checkEqual(
  "an unknown runner is 404 RUNNER_NOT_FOUND",
  [noRunner.status, noRunner.body?.code],
  [404, "RUNNER_NOT_FOUND"],
);

/* ------------------------------------------------------------------ */
step("Clean up");

await Promise.all(
  unsubscribers.map(async (unsubscribe) => await unsubscribe()),
);
await jobs.purge();
await admin.close();
await jobs.close();
await driver.close();
summary();
