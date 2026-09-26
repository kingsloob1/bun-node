import type {
  DriverConfig,
  JobsDriver,
  WorkerTargetFactory,
} from "../../../lib/index";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createDeferred, noopLogger } from "@kingsleyweb/bun-common";
import { BunQueue, BunQueueWorker, createDriver } from "../../../lib/index";
import { FileTargetExecutor } from "../../../lib/queue/workerTarget";

/**
 * A process that starts a graceful `worker.close()` while a child-process or
 * worker-thread attempt is spinning, escalates it with `close({ force: true
 * })`, and exits the moment both calls have resolved — the shape of a
 * shutdown whose second signal, or whose backstop, gives up on the graceful
 * close. Whether the attempt's child or thread outlived the close is what the
 * test checks, from here and from outside.
 *
 * Argument: JSON `{ config, namespace, kind, when, pidFile, beaconFile }`.
 * `when` is where the graceful close is when the force lands:
 * - `drain`: waiting on the attempt, with a long `timeout`;
 * - `target-close`: in the target's graceful `close()`, which asks the run to
 *   stop and would give it `TARGET_CLOSE_GRACE` (4000 ms) before killing it.
 *
 * Prints one JSON line, `closed`, then calls `process.exit(0)`.
 */

/** The scenario's argument. */
export interface CloseEscalationScenario {
  /** The backend, as a config. */
  config: DriverConfig;
  /** The namespace to work in. */
  namespace: string;
  /** Where the attempt runs. */
  kind: "child-process" | "worker-thread";
  /** Where the graceful close is when the force lands. */
  when: "drain" | "target-close";
  /** Where the processor writes who it is. */
  pidFile: string;
  /** Where the processor writes its beacon. */
  beaconFile: string;
}

/** What the scenario printed once both closes had resolved (or not). */
export interface CloseEscalationObservation {
  /** Always `"closed"`. */
  event: "closed";
  /** Milliseconds from the force to both calls having resolved, or null. */
  closeMs: number | null;
  /** Whether each call resolved within the scenario's bound. */
  resolved: { graceful: boolean; forced: boolean };
  /** The options of every target `close()` call, in order. */
  targetCloses: ("graceful" | "force")[];
  /** Whether the child was alive when the closes resolved (child-process). */
  aliveAtClose: boolean | null;
  /**
   * The beacon 200 ms after the closes resolved — time for a thread's
   * `terminate()`, which is asynchronous, to take — and 400 ms after that.
   */
  beacon: { settled: string; later: string };
}

/** How long each close is given before the scenario reports it pending. */
const BOUND_MS = 8_000;

/** The graceful close's `timeout` in the `drain` shape; no other timer uses it. */
const GRACE_MS = 43_217;

const scenario = JSON.parse(process.argv[2]!) as CloseEscalationScenario;

/** A process's `ps` status, or `""` when it is gone. */
function stat(pid: number): string {
  const { stdout } = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  return stdout.toString().trim();
}

/** Resolves once `file` exists, after at most 20 s. */
async function appears(file: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = await Bun.file(file)
      .text()
      .catch(() => "");
    if (text.length > 0) {
      return text;
    }
    await Bun.sleep(10);
  }
  throw new Error(`${file} never appeared`);
}

const graceArmed = createDeferred<void>();
if (scenario.when === "drain") {
  // Marks the moment the graceful close starts waiting on the attempt: the
  // one timer armed with its timeout.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (ms === GRACE_MS) {
      graceArmed.resolve();
    }
    return realSetTimeout(callback, ms, ...rest);
  }) as typeof setTimeout;
}

const processor = new URL("../handlers/job-spin-beacon.ts", import.meta.url);
const targetCloses: ("graceful" | "force")[] = [];
const gracefulTargetClose = createDeferred<void>();
/** The built-in executor, unchanged but for noting its `close()` calls. */
const target: WorkerTargetFactory = (context) => {
  const executor = new FileTargetExecutor(
    // An escalation far longer than the target's grace, so only a close can
    // end the run inside the scenario's bounds.
    scenario.kind === "child-process"
      ? { kind: "child-process", closeTimeout: 10_000, killTimeout: 10_000 }
      : { kind: "worker-thread", closeTimeout: 10_000 },
    fileURLToPath(processor),
    {
      namespace: context.namespace,
      queue: context.queue,
      workerId: context.workerId,
    },
  );
  const close = executor.close.bind(executor);
  executor.close = (options) => {
    targetCloses.push(options?.force ? "force" : "graceful");
    if (!options?.force) {
      gracefulTargetClose.resolve();
    }
    return close(options);
  };
  return executor;
};

// The memory driver has to be shared to be seen by both; any other is built
// by the worker from its config, the way a deployment would.
const driver: JobsDriver | DriverConfig =
  scenario.config.type === "memory"
    ? createDriver(scenario.config)
    : scenario.config;
const worker = new BunQueueWorker("close-esc", processor, {
  namespace: scenario.namespace,
  driver,
  logger: noopLogger,
  pollInterval: 20,
  lockDuration: 60_000,
  target,
});
worker.on("error", () => {});
const queue = new BunQueue("close-esc", {
  namespace: scenario.namespace,
  driver: worker.driver,
  logger: noopLogger,
});
void worker.run();

await queue.add(
  "spin",
  {
    pidFile: scenario.pidFile,
    beaconFile: scenario.beaconFile,
    beaconMs: 20,
    spinMs: 30_000,
  },
  { attempts: 1 },
);
const child = JSON.parse(await appears(scenario.pidFile)) as { pid: number };
await appears(scenario.beaconFile);

let graceful: Promise<void>;
if (scenario.when === "drain") {
  graceful = worker.close({ timeout: GRACE_MS });
  await graceArmed.promise;
} else {
  // Out of patience at once; the target's graceful close follows.
  graceful = worker.close({ timeout: 50 });
  await gracefulTargetClose.promise;
}

const forcedAt = Date.now();
const forced = worker.close({ force: true });
const resolved = { graceful: false, forced: false };
void graceful.then(() => {
  resolved.graceful = true;
});
void forced.then(() => {
  resolved.forced = true;
});
const both = await Promise.race([
  Promise.all([graceful, forced]).then(() => true),
  Bun.sleep(BOUND_MS).then(() => false),
]);
const closeMs = both ? Date.now() - forcedAt : null;

const aliveAtClose =
  scenario.kind === "child-process"
    ? !["", "Z"].includes(stat(child.pid).slice(0, 1))
    : null;
await Bun.sleep(200);
const settled = await Bun.file(scenario.beaconFile).text();
await Bun.sleep(400);
const later = await Bun.file(scenario.beaconFile).text();

// eslint-disable-next-line no-console -- stdout is how the scenario reports.
console.log(
  JSON.stringify({
    event: "closed",
    closeMs,
    resolved,
    targetCloses,
    aliveAtClose,
    beacon: { settled, later },
  } satisfies CloseEscalationObservation),
);
// No waiting for anything: whatever the close left running is orphaned now.
process.exit(0);
