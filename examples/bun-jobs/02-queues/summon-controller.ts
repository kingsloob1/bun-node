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

/** The worker processes the spawning summoner started, by attempt id. */
const started = new Map<string, Subprocess>();

/**
 * A summoner that starts the worker on this machine: the request's `argv`
 * carries the summon's identity, the queue and the namespace; the backend
 * travels in the environment, as a platform's task definition would carry it.
 */
const spawnWorker = defineSummoner({
  kind: "example-spawn",
  invoke: async (request: SummonRequest) => {
    const child = Bun.spawn({
      cmd: [process.execPath, ENTRY, ...request.argv],
      env: {
        ...process.env,
        ...request.env,
        SUMMONED_DRIVER: JSON.stringify(config),
        // Idle long enough to be seen: an attempt is registered by a check
        // that finds the worker's record, and a worker gone before the next
        // poll is never seen at all.
        SUMMONED_IDLE_FOR: "3000",
      },
      stdout: "ignore",
      stderr: "inherit",
    });
    children.add(child);
    started.set(request.id, child);
    return { status: "started", handles: [`pid:${child.pid}`] };
  },
});

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
    emails: {
      summoner: spawnWorker,
      triggers: { poll: 1_000, debounce: 50 },
    },
    reports: { summoner: recording, triggers: ONE_SHOT },
    flaky: {
      summoner: failing,
      triggers: ONE_SHOT,
      cooldown: 0,
      backoff: { initial: 1, max: 1 },
      circuit: { failures: 2, resetAfter: 60_000 },
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

await jobs.purge();
await jobs.close();
summary();
