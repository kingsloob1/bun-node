/**
 * Summoning a worker: a `SummonController` watches a queue and, when it has
 * work and no worker, calls a summoner that starts one.
 *
 * ```bash
 * bun 02-queues/summon-controller.ts
 * ```
 *
 * The summoner here starts the worker as a child process, passing the
 * request's `argv` to `02-queues/helpers/summoned-entry.ts` — the same entry
 * file `summoned-worker.ts` runs — which works the queue with `runSummoned`
 * and exits once idle. A real summoner makes one call to a platform instead;
 * nothing else changes. Summoning needs a backend another process can reach,
 * so on the memory driver this runs on a temporary SQLite file.
 *
 * The points that are easy to get wrong:
 *
 * - **An attempt is released by the worker, not by the summoner.** The
 *   summoner answering `started` only means the platform took the request;
 *   the attempt counts as a worker on its way until the summoned worker's
 *   first heartbeat carries its id, and the controller then reports it
 *   `registered`.
 * - **Every trigger off is the one-shot form**: nothing happens until
 *   `check()`, which is what a cron or a scheduled function calls.
 * - **Failures back off and then open a circuit**, shared by every controller
 *   on the queue; `status()` reads it and `reset()` clears it.
 * - **A worker seen running is still watched.** Its attempt leaves `pending`
 *   when it registers, so it is never counted twice, and the registration
 *   resets `failures`; but if that worker then crashes — gone without
 *   `runSummoned` stopping it, whatever its exit code, even a bare
 *   `process.exit(0)` — the attempt is reported `lost` late, for the same
 *   id, with detail `died`, once its grace has passed (no sooner than its
 *   `bootBudget` plus 5 s). The loss counts every failure since the last
 *   proven success — a clean exit, or a watch that ends clean — so a crash
 *   loop opens the circuit even though each registration resets the count.
 *   (`exited-with-error` needs a code-1 exit mark, which `runSummoned`
 *   writes only for a failed start, before the attempt is claimed: a
 *   registered attempt never gets one.)
 * - **`maxWorkers` × `jobsPerWorker` decide the count**: enough workers for
 *   the backlog at `jobsPerWorker` each, never more than `maxWorkers`.
 * - **A controller in a summoned process is inert**, so a config module the
 *   worker shares cannot make it summon more workers.
 */
import type {
  SummonEventPayload,
  SummonRequest,
  SummonStatus,
} from "@kingsleyweb/bun-jobs";
import type { Subprocess } from "bun";
import process from "node:process";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { BunJobs, defineSummoner } from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Summoning a worker");

/** A generous ceiling for a child's start-up and anything a slow server stretches. */
const WAIT = { timeout: 30_000, interval: 20 };
/** Every trigger off: the controller checks only when told to. */
const ONE_SHOT = { onAdd: false, events: false, poll: false } as const;

/** With it, a `vanish` job ends the worker with a bare exit: see `helpers/summoned-entry.ts`. */
const VANISH = { SUMMONED_VANISH: "1" };
/**
 * The boot budget of the queues whose workers crash, in ms. A crash is
 * declared no sooner than 5 s after it, so it is short; long enough that a
 * worker is seen running well before its watch could end on time alone.
 */
const CRASH_BOOT_BUDGET = 2_000;

const config = crossProcessDriver();
const namespace = exampleNamespace("summon");
const ENTRY = new URL("./helpers/summoned-entry.ts", import.meta.url).pathname;

/**
 * Every child this tour started, killed if still alive when it exits, so a
 * failed run leaves no worker behind.
 */
const children = new Set<Subprocess>();
process.on("exit", () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

/** The worker processes the spawning summoners started, by attempt id. */
const started = new Map<string, Subprocess>();
/** When each of those processes exited, epoch ms, by attempt id. */
const exitedAt = new Map<string, Promise<number>>();

/**
 * A summoner that starts the worker on this machine: the request's `argv`
 * carries the summon's identity, the queue and the namespace; the backend
 * travels in the environment, as a platform's task definition would carry it.
 * The worker exits once idle for `idleFor` ms; `env` is added to its
 * environment.
 */
function spawnWorkerIdling(idleFor: number, env: Record<string, string> = {}) {
  return defineSummoner({
    kind: "example-spawn",
    invoke: async (request: SummonRequest) => {
      const child = Bun.spawn({
        cmd: [process.execPath, ENTRY, ...request.argv],
        env: {
          ...process.env,
          ...request.env,
          SUMMONED_DRIVER: JSON.stringify(config),
          SUMMONED_IDLE_FOR: String(idleFor),
          ...env,
        },
        stdout: "ignore",
        stderr: "inherit",
      });
      children.add(child);
      started.set(request.id, child);
      exitedAt.set(
        request.id,
        child.exited.then(() => Date.now()),
      );
      return { status: "started", handles: [`pid:${child.pid}`] };
    },
  });
}

/** Requests a recording summoner was handed, by queue. */
const recorded = new Map<string, SummonRequest[]>();

/** A summoner that starts nothing: it records the request and says `started`. */
const recording = defineSummoner({
  kind: "example-record",
  invoke: async (request: SummonRequest) => {
    recorded.set(request.queue, [
      ...(recorded.get(request.queue) ?? []),
      request,
    ]);
    return { status: "started", handles: [] };
  },
});

/** A summoner whose platform is down: every call throws. */
const failing = defineSummoner({
  kind: "example-down",
  invoke: async () => {
    throw new Error("the platform is down");
  },
});

/**
 * What the controllers log: every decision, including the summoner's
 * failures, which a real deployment would want to see. Collected here, so
 * the tour can check them rather than print their stack traces.
 */
const { logger, events: logged } = createTestLogger();

const jobs = new BunJobs({
  namespace,
  driver: config,
  logger,
  summon: {
    // A worker on demand: the add itself triggers the check, 50 ms after
    // the last add, and a poll notices the worker registering. The poll is
    // kept well behind the add, since whichever check comes first claims the
    // attempt and names it: a fast poll would sometimes win.
    // Its worker idles 3 s, long enough for the tour to watch it working.
    emails: {
      summoner: spawnWorkerIdling(3_000),
      triggers: { poll: 1_000, debounce: 50 },
    },
    // Its worker is gone 200 ms after its job. Only the add checks on its
    // own: no poll and no worker events, so the next check is the one the
    // tour makes once that worker has exited, however quick the backend.
    fast: {
      summoner: spawnWorkerIdling(200),
      triggers: { poll: false, events: false, debounce: 50 },
    },
    reports: { summoner: recording, triggers: ONE_SHOT },
    flaky: {
      summoner: failing,
      triggers: ONE_SHOT,
      cooldown: 0,
      backoff: { initial: 1, max: 1 },
      circuit: { failures: 2, resetAfter: 60_000 },
    },
    // Its workers idle a minute: each ends the way the tour asks it to, a
    // `vanish` job (a bare exit) or a SIGTERM.
    crashing: {
      summoner: spawnWorkerIdling(60_000, VANISH),
      triggers: ONE_SHOT,
      cooldown: 0,
      backoff: { initial: 1, max: 1 },
      circuit: { failures: 2, resetAfter: 60_000 },
      bootBudget: CRASH_BOOT_BUDGET,
    },
    backlog: {
      summoner: recording,
      triggers: ONE_SHOT,
      maxWorkers: 5,
      jobsPerWorker: 10,
    },
    flood: {
      summoner: recording,
      triggers: ONE_SHOT,
      maxWorkers: 5,
      jobsPerWorker: 10,
    },
  },
});

/** What a controller reported, by queue, in order. */
function watch(queue: string): SummonEventPayload[] {
  const events: SummonEventPayload[] = [];
  jobs.summonController(queue).on("summon", (event) => events.push(event));
  return events;
}

/* ------------------------------------------------------------------ */
step("On demand: adding jobs summons a worker, which works them and exits");

const emailEvents = watch("emails");
const emails = jobs.queue("emails");
for (const to of ["ada", "grace", "edsger"]) {
  await emails.add("quick", { to });
}
await waitFor(
  "the summoned worker to register",
  () => emailEvents.some((event) => event.outcome === "registered"),
  WAIT,
);
show("summon events", emailEvents);
const attempt = emailEvents[0]!;
checkEqual(
  "one attempt: started by the add, then registered once its worker reported",
  [
    emailEvents.map((event) => event.outcome),
    attempt.kind,
    attempt.reason,
    started.size,
  ],
  [["started", "registered"], "example-spawn", "add", 1],
);
await waitFor(
  "the three jobs to be done",
  async () => (await emails.count()).completed === 3,
  WAIT,
);
const worker = started.get(attempt.id)!;
checkEqual(
  "the worker works the queue, then exits 0 once idle, its record gone",
  [
    await worker.exited,
    (await emails.count()).completed,
    (await emails.listWorkers()).length,
  ],
  [0, 3, 0],
);
checkEqual(
  "and nothing summons another: the queue has no demand left",
  [emailEvents.length, started.size],
  [2, 1],
);

/* ------------------------------------------------------------------ */
step("A worker gone between two checks is still registered");

// Its first start claimed the attempt, and that claim outlives the worker's
// record: so a check after it exited still counts it registered rather than
// lost — and nothing counts against the backoff or the circuit.
const fast = jobs.summonController("fast");
const fastSeen: SummonEventPayload[] = [];
fast.on("summon", (event) => {
  fastSeen.push(event);
});
await jobs.queue("fast").add("quick", { n: 1 });
/** Waits up to `ms` for a condition, without throwing, so a miss is a check. */
async function within(
  ms: number,
  condition: () => boolean | Promise<boolean>,
  interval = 20,
): Promise<void> {
  const until = Date.now() + ms;
  while (!(await condition()) && Date.now() < until) {
    await Bun.sleep(interval);
  }
}
await within(10_000, () => fastSeen.length > 0);
const fastAttempt = fastSeen[0];
// When its worker exited, or `undefined` if it has not within 10 s.
const fastExit = fastAttempt
  ? await Promise.race([
      exitedAt.get(fastAttempt.id),
      Bun.sleep(10_000).then(() => undefined),
    ])
  : undefined;
const fastCheck = await fast.check();
show("the check after the worker exited", fastCheck.action);
show(
  "the fast worker's attempt",
  fastSeen.map(({ outcome, reason }) => ({ outcome, reason })),
);
checkEqual(
  "started, then registered by a check made after its worker had exited",
  [
    fastExit !== undefined,
    fastSeen.map((event) => event.outcome),
    (await fast.status()).failures,
  ],
  [true, ["started", "registered"], 0],
);

/* ------------------------------------------------------------------ */
step("One-shot: every trigger off, nothing happens until check()");

const reportEvents = watch("reports");
const reports = jobs.queue("reports");
await reports.add("render", { id: 1 });
const quiet = recorded.get("reports")?.length ?? 0;
const result = await jobs.summonController("reports").check();
checkEqual(
  "the add summoned nothing; check() summons, and reports what the summoner said",
  [
    quiet,
    result.action,
    result.action === "summoned" ? result.outcome : null,
    recorded.get("reports")?.length,
    reportEvents.map((event) => event.outcome),
  ],
  [0, "summoned", "started", 1, ["started"]],
);
const again = await jobs.summonController("reports").check();
checkEqual(
  "checked again while that worker is on its way: skipped, pending",
  [again.action, again.action === "skipped" ? again.reason : null],
  ["skipped", "pending"],
);

/* ------------------------------------------------------------------ */
step("A failing summoner backs off, then opens the circuit; reset() clears it");

const flaky = jobs.summonController("flaky");
await jobs.queue("flaky").add("run", {});
/** Checks once, after the 1 ms backoff has certainly run out. */
async function checkFlaky() {
  await Bun.sleep(10);
  return await flaky.check();
}
const first = await checkFlaky();
const second = await checkFlaky();
const third = await checkFlaky();
checkEqual(
  "two failed attempts open the circuit; the third check is held back",
  [
    first.action === "summoned" ? first.outcome : first.action,
    second.action === "summoned" ? second.outcome : second.action,
    third.action,
    third.action === "skipped" ? third.reason : null,
  ],
  ["failed", "failed", "skipped", "circuit-open"],
);
const open: SummonStatus = await flaky.status();
show("status()", {
  failures: open.failures,
  circuitOpenUntil: open.circuitOpenUntil,
  last: open.last,
});
check(
  "status() shows two failures and the circuit open for the next minute",
  open.failures === 2 &&
    open.circuitOpenUntil !== undefined &&
    open.circuitOpenUntil > Date.now() + 30_000,
  open,
);
checkEqual(
  "each failure is logged as an error, and so is the circuit opening",
  [
    logged.filter(
      (event) =>
        event.level === "error" && event.message === "summoner call failed",
    ).length,
    logged.some(
      (event) =>
        event.level === "error" &&
        event.message.startsWith("summon circuit open"),
    ),
  ],
  [2, true],
);
await flaky.reset();
const cleared = await flaky.status();
const afterReset = await checkFlaky();
checkEqual(
  "reset() clears the failures and the circuit, and the next check tries again",
  [
    cleared.failures,
    cleared.circuitOpenUntil ?? null,
    afterReset.action === "summoned" ? afterReset.outcome : afterReset.action,
  ],
  [0, null, "failed"],
);

/* ------------------------------------------------------------------ */
step("A worker seen running that then crashes is lost late: died");

// Its first report registers the attempt, which leaves `pending`: the live
// worker now counts as the queue's worker, and is never counted twice. The
// controller keeps watching the attempt, though, until the claim says how
// its worker left. This one exits without closing — a bare
// `process.exit(0)`, no `runSummoned` stop — so it leaves no exit mark: a
// crash. A missing record alone proves nothing while a worker may still be
// starting, so it is declared dead only once its grace has passed: the later
// of its claim's `until` (one record lifetime) and the attempt's
// (`bootBudget`), plus 5 s for the two processes' clocks.
const crashing = jobs.summonController("crashing");
const crashingEvents = watch("crashing");

/**
 * Summons one worker for `crashing`, with a `quick` job for it, and checks
 * once its record is listed, so that check registers it: the attempt's id.
 */
async function summonRegistered(): Promise<string> {
  await jobs.queue("crashing").add("quick", {});
  // Past the 1 ms backoff a failure leaves.
  await Bun.sleep(10);
  const summoned = await crashing.check();
  if (summoned.action !== "summoned") {
    throw new Error(`expected a summon, got ${summoned.action}`);
  }
  await waitFor(
    "the summoned worker's record",
    async () =>
      (await jobs.queue("crashing").listWorkers()).some(
        (one) => one.summon?.id === summoned.id,
      ),
    WAIT,
  );
  await crashing.check();
  return summoned.id;
}

/** The exit code of an attempt's worker, or `undefined` if it has not exited within 30 s. */
async function exitCode(id: string): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      started.get(id)!.exited,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, 30_000, undefined);
      }),
    ]);
  } finally {
    // Cleared, so a timer left running cannot hold the tour open at the end.
    clearTimeout(timer);
  }
}

/**
 * Crashes an attempt's worker with a `vanish` job, then checks until the
 * attempt is reported lost: the worker's exit code, and when the loss was
 * reported (epoch ms), or `undefined` if not within 30 s.
 */
async function crash(
  id: string,
): Promise<{ code: number | undefined; lostAt: number | undefined }> {
  await jobs.queue("crashing").add("vanish", {});
  const code = await exitCode(id);
  // Its record outlives it by up to a record lifetime, and a check while it
  // is still listed reads the worker as running.
  await waitFor(
    "the crashed worker's record to lapse",
    async () =>
      !(await jobs.queue("crashing").listWorkers()).some(
        (one) => one.summon?.id === id,
      ),
    WAIT,
  );
  let lostAt: number | undefined;
  await within(
    30_000,
    async () => {
      await crashing.check();
      if (
        crashingEvents.some(
          (event) => event.id === id && event.outcome === "lost",
        )
      ) {
        lostAt = Date.now();
      }
      return lostAt !== undefined;
    },
    100,
  );
  return { code, lostAt };
}

/** One attempt's outcomes, in order, each with its detail where it has one. */
function outcomesOf(events: SummonEventPayload[], id: string): string[] {
  return events
    .filter((event) => event.id === id)
    .map((event) =>
      event.detail === undefined
        ? event.outcome
        : `${event.outcome}: ${event.detail}`,
    );
}

const crashSummonedAt = Date.now();
const crashed = await summonRegistered();
const crashWatched = await crashing.status();
const crashRegistered = outcomesOf(crashingEvents, crashed);
const { code: crashCode, lostAt: crashLostAt } = await crash(crashed);
// Checked again: the loss is reported once. Only a lower bound on when is
// asserted below — never a window — since the grace may only grow.
await crashing.check();
const afterCrash = await crashing.status();
show("the crashed worker's attempt", {
  outcomes: outcomesOf(crashingEvents, crashed),
  lostAfterMs: crashLostAt === undefined ? null : crashLostAt - crashSummonedAt,
});
checkEqual(
  "registered by its first report, then off the pending count: no failure yet",
  [crashRegistered, crashWatched.pending.length, crashWatched.failures],
  [["started", "registered"], 0, 0],
);
checkEqual(
  "it exits 0 with no close: the same attempt is reported lost, died, once",
  [crashCode, crashingEvents.slice(2)],
  [
    0,
    [
      {
        id: crashed,
        outcome: "lost",
        kind: "example-spawn",
        count: 1,
        detail: "died",
      },
    ],
  ],
);
check(
  "not before its grace: its boot budget plus 5 s after it was summoned",
  crashLostAt !== undefined &&
    crashLostAt - crashSummonedAt >= CRASH_BOOT_BUDGET + 5_000,
  { lostAfterMs: crashLostAt && crashLostAt - crashSummonedAt },
);
checkEqual(
  "one failure is counted, and status().last names the attempt and how it was lost",
  [
    afterCrash.failures,
    afterCrash.last && {
      id: afterCrash.last.id,
      outcome: afterCrash.last.outcome,
      detail: afterCrash.last.detail,
    },
  ],
  [1, { id: crashed, outcome: "lost", detail: "died" }],
);

/* ------------------------------------------------------------------ */
step("A worker that stops cleanly ends its watch quietly");

// A registration resets `failures`, as always. A late loss counts from what
// the controller last *proved*, though: a worker that left a clean exit
// mark, or a watch that ended clean. This one proves it — the next step's
// first loss counts 1, not 2.
const clean = await summonRegistered();
const cleanWatched = await crashing.status();
const cleanRegistered = outcomesOf(crashingEvents, clean);
// A platform stopping it: `runSummoned` drains and exits 0, marked clean.
started.get(clean)!.kill("SIGTERM");
const cleanCode = await exitCode(clean);
await crashing.check();
const cleanEnded = await crashing.status();
checkEqual(
  "registered: the registration resets failures to 0",
  [cleanRegistered, cleanWatched.failures],
  [["started", "registered"], 0],
);
checkEqual(
  "stopped, it exits 0: the next check reports nothing more, failures stay 0",
  [
    cleanCode,
    outcomesOf(crashingEvents, clean),
    cleanEnded.failures,
    cleanEnded.last?.outcome,
  ],
  [0, ["started", "registered"], 0, "registered"],
);

/* ------------------------------------------------------------------ */
step("A crash loop opens the circuit, though each registration resets it");

// Worker after worker registers and then crashes. Each registration sets
// `failures` back to 0, but each late loss raises it to the failures since
// the last proven success, which no registration resets: `crashing` opens
// its circuit at two.
const loop: {
  id: string;
  atRegistration: number;
  afterLoss: number;
  code: number | undefined;
}[] = [];
for (let round = 0; round < 2; round++) {
  const id = await summonRegistered();
  const atRegistration = (await crashing.status()).failures;
  const { code } = await crash(id);
  loop.push({
    id,
    atRegistration,
    afterLoss: (await crashing.status()).failures,
    code,
  });
}
// There is work again, and no worker for it.
await jobs.queue("crashing").add("quick", {});
await Bun.sleep(10);
const heldBack = await crashing.check();
show(
  "the loop",
  loop.map(({ id, atRegistration, afterLoss }) => ({
    outcomes: outcomesOf(crashingEvents, id),
    atRegistration,
    afterLoss,
  })),
);
checkEqual(
  "each registered with failures back at 0, then crashed and was lost late, died",
  [
    loop.map(({ code }) => code),
    loop.map(({ id }) => outcomesOf(crashingEvents, id)),
    loop.map(({ atRegistration }) => atRegistration),
  ],
  [
    [0, 0],
    [
      ["started", "registered", "lost: died"],
      ["started", "registered", "lost: died"],
    ],
    [0, 0],
  ],
);
checkEqual(
  "the losses count 1, then 2 — the streak since the clean end — and the next check is held back",
  [
    loop.map(({ afterLoss }) => afterLoss),
    heldBack.action,
    heldBack.action === "skipped" ? heldBack.reason : null,
  ],
  [[1, 2], "skipped", "circuit-open"],
);

/* ------------------------------------------------------------------ */
step("How many: maxWorkers × jobsPerWorker");

// 32 jobs at 10 per worker want 4 workers; 100 want 10, capped at 5.
await jobs
  .queue("backlog")
  .addBulk(
    Array.from({ length: 32 }, (_, n) => ({ name: "row", data: { n } })),
  );
await jobs
  .queue("flood")
  .addBulk(
    Array.from({ length: 100 }, (_, n) => ({ name: "row", data: { n } })),
  );
await jobs.summonController("backlog").check();
await jobs.summonController("flood").check();
checkEqual(
  "32 jobs ask for 4 workers; 100 ask for 10 and get the cap, 5",
  [recorded.get("backlog")?.[0]?.count, recorded.get("flood")?.[0]?.count],
  [4, 5],
);

/* ------------------------------------------------------------------ */
step("Inside a summoned process, a controller is inert");

const inertQueue = "inert";
await jobs.queue(inertQueue).add("run", {});
const probe = Bun.spawn({
  cmd: [
    process.execPath,
    new URL("./helpers/summon-inert.ts", import.meta.url).pathname,
    "--bun-jobs-summon-id=attempt-inert",
  ],
  env: {
    ...process.env,
    SUMMONED_DRIVER: JSON.stringify(config),
    SUMMON_NAMESPACE: namespace,
    SUMMON_QUEUE: inertQueue,
  },
  stdout: "pipe",
  stderr: "inherit",
});
children.add(probe);
const probed = JSON.parse(
  (await new Response(probe.stdout).text()).trim().split("\n").at(-1)!,
) as {
  inert: boolean;
  inertReason: string | null;
  check: { action: string; reason?: string };
  called: boolean;
};
await probe.exited;
checkEqual(
  "a queue with work, but the controller summons nothing: inert, in a summoned process",
  [
    probed.inert,
    probed.inertReason,
    probed.check.action,
    probed.check.reason,
    probed.called,
  ],
  [true, "summoned-process", "skipped", "inert", false],
);

/* ------------------------------------------------------------------ */
step("Clean up");

// Every worker the tour started has exited on its own by now. One still
// running means a check above went wrong: it is stopped here, rather than
// holding the tour open until it idles out.
const running = [...children].filter(
  (child) => child.exitCode === null && child.signalCode === null,
);
checkEqual("every worker the tour started has exited", running.length, 0);
for (const child of running) {
  child.kill("SIGKILL");
}
await jobs.purge();
await jobs.close();
summary();
