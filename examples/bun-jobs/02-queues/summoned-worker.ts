/**
 * A summoned worker: `runSummoned(worker)` as the whole entry file of a
 * process a summoner started — run for real, in a child process, and stopped
 * the ways a platform stops one.
 *
 * ```bash
 * bun 02-queues/summoned-worker.ts
 * ```
 *
 * Each child is `02-queues/helpers/summoned-entry.ts`, started with the arguments a
 * summoner passes (`--bun-jobs-summon-id=`, `-namespace=`, `-queue=`, …). It
 * logs each decision as a JSON line, the last one carrying the `SummonedExit`
 * it exited with, and this tour reads that, the exit code and the backend.
 * The memory driver lives inside one process, so on memory the two share a
 * temporary SQLite file instead.
 *
 * The points that are easy to get wrong:
 *
 * - **Exit 0 is the rule**, for an idle stop, a signal, a parked worker:
 *   platforms restart a non-zero exit. Only a `run()` that failed — a
 *   backend it could not reach — is `1`, and a second SIGINT is `130`,
 *   Ctrl-C twice.
 * - **SIGTERM drains**: with the platform's grace to spare, a job in flight
 *   finishes before the process exits.
 * - **SIGTSTP stops claiming, SIGCONT resumes** — the same process, paused,
 *   not stopped.
 * - **A parked worker exits** after `idleFor`, whatever is waiting: an
 *   operator stopped it, and it only costs money.
 * - **`"in-invocation"` resolves** instead of exiting, for a Lambda handler,
 *   so its `SummonedExit` is simply returned.
 */
import type { DriverConfig, SummonedExit } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunJobs, runSummoned } from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("A summoned worker");

/** A generous ceiling for a child's start-up and anything a slow server stretches. */
const WAIT = { timeout: 30_000, interval: 20 };

const config = crossProcessDriver();
const namespace = exampleNamespace("summoned");
// The config, not an instance: the context then owns the driver it builds, and
// closing the context closes it too.
const jobs = new BunJobs({ namespace, driver: config });
const ENTRY = new URL("./helpers/summoned-entry.ts", import.meta.url).pathname;

/** One decision the child logged. */
interface Decision {
  /** The log line's message. */
  message: string;
  /** Its fields. */
  fields: Record<string, unknown>;
}

/**
 * Starts the entry file as a summoner would, for `queue`, and collects what
 * it logs. `extra` adds summon arguments (a grace, a mode).
 */
function summonChild(
  queue: string,
  extra: string[] = [],
  idleFor = 500,
  driver: DriverConfig = config,
) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      ENTRY,
      `--bun-jobs-summon-id=attempt-${queue}`,
      "--bun-jobs-summon-kind=example",
      `--bun-jobs-summon-namespace=${namespace}`,
      `--bun-jobs-summon-queue=${queue}`,
      ...extra,
    ],
    env: {
      ...process.env,
      SUMMONED_DRIVER: JSON.stringify(driver),
      SUMMONED_IDLE_FOR: String(idleFor),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const decisions: Decision[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line.startsWith("{")) {
          decisions.push(JSON.parse(line) as Decision);
        }
        end = buffer.indexOf("\n");
      }
    }
  })();
  return {
    child,
    decisions,
    /** The exit code, once the child has exited and its output is read. */
    exited: async () => {
      const code = await child.exited;
      await reading;
      return code;
    },
    /** The `SummonedExit` it logged on the way out, if it got that far. */
    stopped: () =>
      decisions.find((one) => one.message === "Summoned worker stopped")
        ?.fields,
  };
}

/** Waits until a job is `active`, so a signal lands while it is in flight. */
async function activeJob(queue: string, id: string) {
  await waitFor(
    `${queue}'s job to start`,
    async () => (await jobs.queue(queue).getJob(id))?.state === "active",
    WAIT,
  );
}

/** Waits until the queue's one worker record is up, and answers it. */
async function recordOf(queue: string) {
  await waitFor(
    `${queue}'s worker to report`,
    async () => (await jobs.queue(queue).listWorkers()).length === 1,
    WAIT,
  );
  return (await jobs.queue(queue).listWorkers())[0]!;
}

/* ------------------------------------------------------------------ */
step("Idle: it takes the queue's work, then exits 0 once nothing is left");

const idleQueue = jobs.queue("idle");
for (const n of [1, 2, 3]) {
  await idleQueue.add("quick", { n });
}
const idle = summonChild("idle");
const idleRecord = await recordOf("idle");
checkEqual(
  "its worker record says where it came from: the summon attempt and the summoner",
  [idleRecord.summon?.id, idleRecord.summon?.kind],
  ["attempt-idle", "example"],
);
const idleCode = await idle.exited();
show("it exited with", idle.stopped());
checkEqual(
  "exit 0, reason idle, all three completed and nothing failed",
  [
    idleCode,
    idle.stopped()?.reason,
    idle.stopped()?.completed,
    idle.stopped()?.failed,
    idle.stopped()?.code,
  ],
  [0, "idle", 3, 0, 0],
);
checkEqual(
  "the jobs are done, and its record went with it",
  [(await idleQueue.count()).completed, (await idleQueue.listWorkers()).length],
  [3, 0],
);

/* ------------------------------------------------------------------ */
step("SIGTERM: the job in flight finishes inside the grace, then exit 0");

const drainQueue = jobs.queue("drain");
const slow = await drainQueue.add("slow", { ms: 1_500 });
const drain = summonChild("drain", ["--bun-jobs-summon-grace-ms=10000"]);
await activeJob("drain", slow.id);
drain.child.kill("SIGTERM");
const drainCode = await drain.exited();
checkEqual(
  "exit 0 on the signal, a graceful close, with the slow job completed rather than abandoned",
  [
    drainCode,
    drain.decisions.some(
      (one) => one.message === "Summoned worker closing gracefully",
    ),
    drain.stopped()?.reason,
    drain.stopped()?.signal,
    drain.stopped()?.completed,
    (await drainQueue.getJob(slow.id))?.state,
  ],
  [0, true, "signal", "SIGTERM", 1, "completed"],
);

/* ------------------------------------------------------------------ */
step("A second SIGINT: exit 130 at once, drain or no drain");

const stuckQueue = jobs.queue("stuck");
const hang = await stuckQueue.add("hang", {});
const stuck = summonChild("stuck", ["--bun-jobs-summon-grace-ms=60000"]);
await activeJob("stuck", hang.id);
stuck.child.kill("SIGINT");
// The first SIGINT starts a drain that would wait out the job: noted.
await waitFor(
  "the first SIGINT to start the drain",
  () =>
    stuck.decisions.some(
      (one) => one.message === "Summoned worker closing gracefully",
    ),
  WAIT,
);
stuck.child.kill("SIGINT");
const stuckCode = await stuck.exited();
checkEqual(
  "the second one exits at once with 130, and says why",
  [
    stuckCode,
    stuck.decisions.some(
      (one) => one.message === "Second SIGINT: exiting at once",
    ),
  ],
  [130, true],
);

/* ------------------------------------------------------------------ */
step("SIGTSTP stops claiming, SIGCONT resumes it");

const pausedQueue = jobs.queue("paused");
const held = summonChild("paused", [], 60_000);
await recordOf("paused");
held.child.kill("SIGTSTP");
await waitFor(
  "the worker to report itself paused",
  async () => (await pausedQueue.listWorkers())[0]?.paused === true,
  WAIT,
);
const waiting = await pausedQueue.add("quick", {});
// A paused worker claims nothing: the job waits for as long as it stays
// paused, here half a second.
await Bun.sleep(500);
checkEqual(
  "paused: the job added meanwhile is not taken",
  (await pausedQueue.getJob(waiting.id))?.state,
  "waiting",
);
held.child.kill("SIGCONT");
await waitFor(
  "the job to run once claiming resumes",
  async () => (await pausedQueue.getJob(waiting.id))?.state === "completed",
  WAIT,
);
held.child.kill("SIGTERM");
checkEqual(
  "resumed by SIGCONT, and a SIGTERM still exits 0",
  [await held.exited(), held.stopped()?.reason, held.stopped()?.completed],
  [0, "signal", 1],
);

/* ------------------------------------------------------------------ */
step("Parked by an operator: it exits, whatever is waiting");

const parkedQueue = jobs.queue("parked");
const parked = summonChild("parked", [], 800);
const parkedRecord = await recordOf("parked");
await jobs.workers.controller("parked").stop({ id: parkedRecord.id });
// The stop is an instruction the worker takes up on its own cadence; wait
// until it reports itself stopped, so the work below arrives after the park.
await waitFor(
  "the worker to report itself stopped",
  async () => (await parkedQueue.listWorkers())[0]?.state === "stopped",
  WAIT,
);
// Work arrives after it was parked: a parked worker still takes none.
const unclaimed = await parkedQueue.add("quick", {});
const parkedCode = await parked.exited();
checkEqual(
  'exit 0, reason "parked", and the job left for a worker that will run it',
  [
    parkedCode,
    parked.stopped()?.reason,
    (await parkedQueue.getJob(unclaimed.id))?.state,
  ],
  [0, "parked", "waiting"],
);

/* ------------------------------------------------------------------ */
step("A run() that fails: the one exit that is not 0");

// A backend it cannot reach: a SQLite file in a directory that does not exist.
const unreachable = summonChild("unreachable", [], 500, {
  type: "sql",
  url: "sqlite:///nonexistent-bun-jobs-example/jobs.db",
});
checkEqual(
  'exit 1, reason "error": the one a platform should treat as a crash',
  [
    await unreachable.exited(),
    unreachable.stopped()?.reason,
    unreachable.stopped()?.code,
  ],
  [1, "error", 1],
);

/* ------------------------------------------------------------------ */
step('"in-invocation": resolves with the SummonedExit, no process exit');

const invocationQueue = jobs.queue("invocation");
await invocationQueue.add("quick", { n: 1 });
await invocationQueue.add("quick", { n: 2 });
const inline = jobs.worker<unknown, string>(
  "invocation",
  async (job) => `${job.name} done`,
  { pollInterval: 20 },
);
const result: SummonedExit = await runSummoned(inline, {
  mode: "in-invocation",
  idleFor: 300,
  idleCheckInterval: 50,
});
show("runSummoned resolved with", result);
checkEqual(
  "idle, both jobs completed, nothing failed, code 0, no signal",
  [result.reason, result.completed, result.failed, result.code, result.signal],
  ["idle", 2, 0, 0, undefined],
);
check(
  "and it ran for at least idleFor",
  result.ranForMs >= 300,
  result.ranForMs,
);

/* ------------------------------------------------------------------ */
step("Clean up");

await jobs.purge();
await jobs.close();
summary();
