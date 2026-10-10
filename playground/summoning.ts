import type { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type {
  BunJobs,
  DriverConfig,
  SummonGroup,
  SummonOption,
} from "@kingsleyweb/bun-jobs";
import type { Fault } from "./compute/units";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { consoleSink, createLogger } from "@kingsleyweb/bun-common";
import { defineSummoner } from "@kingsleyweb/bun-jobs";
import { localCompute } from "@kingsleyweb/bun-jobs/provider";
import { unitsLogFile } from "./backend";
import { playgroundCgroup } from "./compute/cgroup";
import {
  stopRecordedUnits,
  UnitPidFile,
  unitPidFilePath,
} from "./compute/leftovers";
import { defineVaultCompute, storeSecret } from "./compute/provider";
import {
  ALL_PROVIDER_FAULTS,
  ALL_UNIT_FAULTS,
  UnitBoard,
} from "./compute/units";

/**
 * Summoning: queues nobody serves until a worker is **summoned** for them,
 * as a real child process started by the library's `localCompute()` (from
 * `@kingsleyweb/bun-jobs/provider`). README.md's "Summoning" section has the
 * table of use cases; in short:
 *
 * | Entry of `summon: [...]` | Queues | Summoner | Shows |
 * |---|---|---|---|
 * | the **media group** | `renders`, `transcodes`, `thumbnails`, `marathon`, `brittle` | `media`, a `localCompute()` | one policy for five queues, with one-level-merged `overrides`; one shared budget for the five (`group: { name: "media" }`); one entry file choosing its processor by queue; `maxUnits` answering `unavailable`; a lifetime ending units; a fault queue opening its circuit |
 * | a **record**, mixed in | `obinna-queue` | `obinna`, a `localCompute()` | the user's own worker, jobs sent with `.toQueue()` and `jobs.queue(name).schedule()`; `env: "inherit"`, output to a logger, `SIGINT` to stop |
 * | | `ledger` | `replicas`, a scale-style `defineSummoner` over a `localCompute()` | `scaleDown`: units that stay up until released |
 * | | `secure-exports` | Vault Compute `…~1` (`compute/provider.ts`), over the media `localCompute()` | a third-party provider: pending readiness, a declared secret, `throttled`/`auth`/… answers |
 *
 * `compute/units.ts` wraps each `localCompute()` instance's facet to record
 * its units and inject faults per queue (`/playground/compute`), and stops
 * every unit, awaiting its exit, when the playground stops.
 */

/** Options for {@link createSummoning}. */
export interface SummoningOptions {
  /**
   * The driver config a summoned worker opens: the playground's own, so it
   * reaches the same queues. `undefined` on the memory driver, which no other
   * process can reach: the providers are configured and listed, but nothing
   * is summoned.
   */
  driver: DriverConfig | undefined;
}

/** The summoning world. */
export interface Summoning {
  /**
   * The context's `summon` option: groups and records, mixed. `undefined` on
   * the memory driver, which cannot summon.
   */
  summon: SummonOption | undefined;
  /** Mounts the control page (`/playground/compute`) on the adapter. */
  mount: (app: BunHttpAdapter) => void;
  /** Where the control page is mounted. */
  basePath: string;
  /**
   * Every configured provider and summoner, held for the process's life: the
   * provider registry behind `GET /providers` holds them weakly, so one
   * nothing references could drop out of the Providers screen.
   */
  providers: readonly object[];
  /** Starts the bursts, on the context built with {@link summon}. */
  start: (jobs: BunJobs) => Promise<void>;
  /**
   * Stops the bursts, then every unit still running, and resolves once each
   * has exited; then removes the run's cgroup, if it made one. Resolves with
   * how many units were still running when it began.
   */
  stop: () => Promise<number>;
}

/** The token Vault Compute accepts: made up. A declared secret. */
const TOKEN = "vc_live_9f3b7c21e4d85a60";

/** One fault the cycle queues before a burst. */
interface CycleFault {
  /** The queue whose next start it goes to. */
  queue: string;
  /** The fault: one that queue takes (see the `addQueue` calls below). */
  kind: Fault;
}

/** The fault queued before each burst, for one queue, in turn; `undefined` for none. */
const FAULT_CYCLE: readonly (CycleFault | undefined)[] = [
  undefined,
  { queue: "renders", kind: "crash" },
  undefined,
  { queue: "secure-exports", kind: "throttled" },
  undefined,
  { queue: "transcodes", kind: "die" },
  undefined,
  { queue: "secure-exports", kind: "auth" },
  undefined,
  { queue: "renders", kind: "slow-boot" },
  undefined,
  { queue: "marathon", kind: "ignore-stop" },
];

/** What a job is about. */
const SUBJECTS = [
  "hero-banner",
  "product-spin",
  "intro-titles",
  "map-flyover",
  "acct-1042",
  "acct-2210",
];

/** A random integer in [min, max]. */
function between(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** A job's data on the group's queues: what `compute/worker.ts` reads. */
function work(min: number, max: number): { subject: string; steps: number } {
  return {
    subject: SUBJECTS[between(0, SUBJECTS.length - 1)]!,
    steps: between(min, max),
  };
}

/**
 * Configures the `localCompute()` instances, the vault provider and the
 * summon option, and returns how to mount the control page and start and stop
 * the rest. Makes the run's cgroup first, when `PLAYGROUND_CGROUP` asks.
 */
export async function createSummoning(
  options: SummoningOptions,
): Promise<Summoning> {
  const here = import.meta.dir;
  const groupEntry = new URL("./compute/worker.ts", import.meta.url);
  const obinnaEntry = new URL(
    "./compute/obinna-queue-worker.ts",
    import.meta.url,
  );
  // Every unit this run starts is recorded (pid, start time, command line) in
  // one file per checkout, so a later run can stop what a killed run, or a
  // `--watch` reload, left behind (`compute/leftovers.ts`). That happens
  // first, before anything is summoned; then the cgroup, sweeping what
  // earlier runs left in theirs.
  const pids = new UnitPidFile(unitPidFilePath(join(here, "..")), [
    fileURLToPath(groupEntry),
    fileURLToPath(obinnaEntry),
  ]);
  const leftover = await stopRecordedUnits(pids.file);
  if (leftover > 0) {
    console.warn(
      `playground: stopped ${leftover} summoned unit${leftover === 1 ? "" : "s"} an earlier run left running (killed, or a --watch reload)`,
    );
  }
  const board = new UnitBoard(() => pids.record());
  const cgroup = await playgroundCgroup();
  /** Every instance's units in the run's cgroup, when there is one, so `cgroup.kill` reaches them all. */
  const inCgroup = cgroup.path === undefined ? {} : { cgroup: cgroup.path };

  // Two host variables, for `env` and `passEnv` to choose between. Read live
  // at each spawn: localCompute() never hands a unit the startup environment.
  process.env.PLAYGROUND_REGION ??= "local-1";
  process.env.PLAYGROUND_HOST_SECRET ??= "hs_demo_not_for_units";

  // The instances, kept here for the process's life: the provider registry
  // behind `GET /providers` holds them weakly. In this order, so the
  // Providers screen lists them `…local@0.1.0~1` to `~4`.

  /**
   * `media`: the group's queues and the vault's. One entry serves them all;
   * five units at once across all of them; a unit must register within
   * 15 s; stopped with SIGTERM and killed 3 s later; its output appended to
   * `.data/units-<pid>.log`; the environment allowlist plus `PLAYGROUND_REGION`
   * and `PLAYGROUND_POOL`; and, with `PLAYGROUND_CGROUP`, a cgroup.
   */
  const media = localCompute({
    entry: groupEntry,
    cwd: here,
    args: ["--tier=standard"],
    maxUnits: 5,
    bootBudget: 15_000,
    shutdown: { signal: "SIGTERM", graceMs: 3_000 },
    // On the memory driver nothing is summoned, so nothing is written, and
    // `.data/` is not made either.
    output: options.driver === undefined ? "ignore" : { file: unitsLogFile() },
    env: { PLAYGROUND_POOL: "media" },
    passEnv: ["PLAYGROUND_REGION"],
    ...inCgroup,
  });

  /**
   * `obinna`: the user's own worker, one unit at a time. The whole host
   * environment (`env: "inherit"`), its output logged line by line to the
   * playground's terminal, stopped with SIGINT and 5 s of grace, and a cap of
   * 5 minutes on any unit's life that the policy's `maxLifetime` must fit.
   */
  const obinna = localCompute({
    entry: obinnaEntry,
    cwd: here,
    maxUnits: 1,
    ...inCgroup,
    maxLifetime: 300_000,
    shutdown: { signal: "SIGINT", graceMs: 5_000 },
    env: "inherit",
    output: {
      logger: createLogger({
        name: "obinna-units",
        level: "info",
        sink: consoleSink({ format: "pretty" }),
      }),
    },
  });

  /** `ledger`'s replicas: the same entry, two at most, output dropped. */
  const ledger = localCompute({
    entry: groupEntry,
    cwd: here,
    args: ["--tier=replica"],
    maxUnits: 2,
    ...inCgroup,
    shutdown: { signal: "SIGTERM", graceMs: 3_000 },
    output: "ignore",
    env: { PLAYGROUND_POOL: "ledger" },
    passEnv: ["PLAYGROUND_REGION"],
  });

  /**
   * An entry that was never built: it still configures (the schema checks no
   * file), and Test connection on its card fails the `entry` check. Nothing
   * summons with it; a summon would be a `misconfigured` ProviderError, which
   * opens a circuit at once.
   */
  const unbuilt = localCompute({
    entry: "compute/not-built-yet.ts",
    cwd: here,
    maxUnits: 1,
    ...inCgroup,
  });

  const mediaUnits = board.instrument(media, "media");
  const obinnaUnits = board.instrument(obinna, "obinna");
  const ledgerUnits = board.instrument(ledger, "ledger");

  // The third-party provider, whose starts go through the media instance.
  storeSecret("vault/token", TOKEN);
  const vaultCompute = defineVaultCompute({
    token: TOKEN,
    units: mediaUnits,
    board,
  });
  const vaults = [
    // ~1: pending while the secret store answers, then ready.
    vaultCompute({ region: "vault-1", apiTokenSecret: "vault/token" }),
    // ~2: ready at once, but its token is not one the vault knows.
    vaultCompute({ region: "vault-2", apiToken: "vc_live_revoked_0000" }),
    // ~3: names a secret the store does not hold: pending, then failed.
    vaultCompute({ region: "vault-2", apiTokenSecret: "vault/gpu-token" }),
  ];

  /**
   * A scale-style summoner over the `ledger` instance: told the count it
   * should run (`target`), it starts the difference; told to release, it
   * stops the extra units. Its units run `until-stopped`, so they stay up
   * after the queue drains until `scaleDown.after` has passed.
   */
  const replicas = defineSummoner({
    kind: "local-replicas",
    style: "scale",
    bootBudget: 20_000,
    shutdown: { signal: "SIGTERM", graceMs: 3_000 },
    describe: () => ({
      kind: "local-replicas",
      units: "localCompute() on this host (the ledger instance)",
    }),
    invoke: async (request, ctx) => {
      const running = await board.running("ledger", request.queue);
      const need = request.target - running.length;
      if (need <= 0) {
        return { status: "already-running", handles: running };
      }
      return await ledgerUnits.summon.summon({ ...request, count: need }, ctx);
    },
    release: async (request) => {
      const running = await board.running("ledger", request.queue);
      await board.cancel(
        "ledger",
        running.slice(0, Math.max(0, running.length - request.target)),
      );
    },
  });

  // The faults each queue takes: what its units' entry acts on, plus the
  // provider faults where the vault summons. `compute/worker.ts` knows all
  // four unit faults (on brittle, one replaces its override's `crash` for
  // that start); `obinna-queue-worker.ts` only `crash` and `die`.
  for (const queue of [
    "renders",
    "transcodes",
    "thumbnails",
    "marathon",
    "brittle",
    "ledger",
  ]) {
    board.addQueue(queue, ALL_UNIT_FAULTS);
  }
  board.addQueue("obinna-queue", ["crash", "die"]);
  board.addQueue("secure-exports", [
    ...ALL_UNIT_FAULTS,
    ...ALL_PROVIDER_FAULTS,
  ]);

  /** Static, the same for every attempt: how a unit reaches the backend. */
  const env: Record<string, string> =
    options.driver === undefined
      ? {}
      : { PLAYGROUND_SUMMON_DRIVER: JSON.stringify(options.driver) };

  const summon: SummonOption | undefined =
    options.driver === undefined
      ? undefined
      : [
          {
            // The media group: one policy written once for five queues, still
            // a controller, a marker, a budget and a circuit for each.
            queues: [
              "renders",
              "transcodes",
              "thumbnails",
              "marathon",
              "brittle",
            ],
            summoner: mediaUnits,
            // A big burst gets a second worker…
            maxWorkers: 2,
            jobsPerWorker: 8,
            // …but one attempt at a time per queue: while one is pending, no
            // second is made (a burst needing two workers asks for both in
            // one attempt, `count: 2`).
            maxPending: 1,
            // Tighter than the defaults, so a session sees the whole cycle: a
            // check every 10 s (and after every add), a retry within seconds,
            // and a circuit that half-opens again after a minute.
            triggers: { poll: 10_000 },
            cooldown: 5_000,
            backoff: { initial: 5_000, max: 30_000 },
            circuit: { failures: 3, resetAfter: 60_000 },
            budget: { perHour: 240, perDay: 2_000 },
            // …and one budget for the five together, under the summon
            // group's name, in whichever process charges it. Each queue's
            // own `budget` above is set, so it still binds on top; without
            // it a queue's own budget would be off, the group's the limit.
            group: { name: "media", budget: { perHour: 600, perDay: 5_000 } },
            maxLifetime: 600_000,
            env,
            // One level deep: an object here is merged field by field into
            // the group's; anything else replaces the group's value.
            overrides: {
              // A number replaces; `budget.perHour` replaces the group's and
              // keeps its `perDay` (2 000).
              transcodes: { maxWorkers: 1, budget: { perHour: 30 } },
              // Only the poll finds work: neither an add here nor an `added`
              // event wakes the controller. Merged into the group's triggers,
              // so its `poll: 10_000` is kept.
              thumbnails: {
                triggers: { onAdd: false, events: false },
                jobsPerWorker: 4,
              },
              // Units live 45 s, then runSummoned stops claiming and exits
              // (`deadline`), and the next check summons a fresh one.
              marathon: { maxWorkers: 1, maxLifetime: 45_000 },
              // Every unit crashes: the fault rides on the env, merged over
              // the group's (which keeps the driver). Two lost attempts open
              // the circuit (`failures` merged; `resetAfter` kept at 60 s),
              // and an attempt is lost after 8 s rather than 15.
              brittle: {
                env: { LOCAL_COMPUTE_FAULT: "crash" },
                circuit: { failures: 2 },
                bootBudget: 8_000,
              },
            },
          } satisfies SummonGroup,
          {
            // A record of policies by queue, mixed in with the group.
            "obinna-queue": {
              summoner: obinnaUnits,
              maxWorkers: 1,
              cooldown: 2_000,
              triggers: { poll: 10_000 },
              backoff: { initial: 5_000, max: 30_000 },
              circuit: { failures: 3, resetAfter: 60_000 },
              // Within the instance's own 5-minute cap.
              maxLifetime: 120_000,
              env,
            },
            ledger: {
              summoner: replicas,
              maxWorkers: 2,
              jobsPerWorker: 4,
              triggers: { poll: 5_000 },
              cooldown: 5_000,
              backoff: { initial: 5_000, max: 30_000 },
              // Released 20 s after the queue went idle.
              scaleDown: { after: 20_000 },
              env,
            },
            "secure-exports": {
              summoner: vaults[0]!,
              triggers: { poll: 5_000 },
              cooldown: 5_000,
              backoff: { initial: 5_000, max: 30_000 },
              circuit: { failures: 3, resetAfter: 60_000 },
              env,
            },
          },
        ];

  const timers: ReturnType<typeof setInterval>[] = [];
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  /** Runs `fn` once after `ms`, unless the playground stops first. */
  const later = (fn: () => Promise<void>, ms: number): void => {
    const timeout = setTimeout(() => {
      timeouts.delete(timeout);
      fn().catch((error: unknown) => {
        console.error("playground summoning:", error);
      });
    }, ms);
    timeouts.add(timeout);
  };

  return {
    summon,
    providers: [media, obinna, ledger, unbuilt, ...vaults, replicas],
    basePath: board.basePath,
    mount: (app) => board.mount(app),
    start: async (jobs) => {
      if (summon === undefined) {
        return;
      }
      // A defined name, so the registry's builder can send it on with
      // `.toQueue()`. Its handler never runs here: this context never calls
      // `jobs.start()`, and `.toQueue()` hands the job to obinna-queue,
      // whose summoned unit runs it.
      jobs.define(
        "ping-obinna",
        async () => {
          throw new Error("ping-obinna runs on obinna-queue's summoned unit");
        },
        // Not carried by `.toQueue()`: a definition's defaults stay with the
        // registry queue.
        { attempts: 5 },
      );
      let pings = 0;
      const nextData = (): { dataId: `data-${number}` } => ({
        dataId: `data-${++pings}`,
      });
      // A series on obinna-queue itself: every 2 minutes, one summon each.
      await jobs
        .queue("obinna-queue")
        .schedule("ping-obinna", { dataId: "data-0" })
        .every("2 minutes")
        .unique("obinna-heartbeat")
        .start();

      // Two brittle jobs, idempotent across restarts: nothing ever runs them,
      // so its controller keeps trying, and its circuit keeps opening.
      const brittle = jobs.queue("brittle");
      for (const id of ["brittle-1", "brittle-2"]) {
        await brittle.add("brittle", work(2, 4), { jobId: id });
      }

      const every = Number(process.env.PLAYGROUND_SUMMON_EVERY_MS ?? 60_000);
      const faults = process.env.PLAYGROUND_SUMMON_FAULTS !== "off";
      let round = 0;
      const addBurst = async (): Promise<void> => {
        const fault = faults
          ? FAULT_CYCLE[round % FAULT_CYCLE.length]
          : undefined;
        round++;
        // One fault per queue at a time: a fault is spent only by that
        // queue's next start, so while none happens (a worker still busy,
        // backoff, the circuit open) queuing more would fire them later.
        if (fault !== undefined && !board.hasPending(fault.queue)) {
          board.inject(fault.queue, fault.kind);
        }
        await jobs.queue("renders").addBulk(
          Array.from({ length: between(4, 16) }, () => ({
            name: "render",
            data: work(4, 10),
          })),
        );
        await jobs.queue("transcodes").addBulk(
          Array.from({ length: between(1, 3) }, () => ({
            name: "transcode",
            data: work(4, 10),
          })),
        );
        // 5 s after the burst, so they land between two of the controller's
        // polls: renders summon at once, thumbnails at the next poll.
        later(async () => {
          for (let index = between(2, 6); index > 0; index--) {
            await jobs.queue("thumbnails").add("thumbnail", work(3, 6));
          }
        }, 5_000);
        await jobs.queue("secure-exports").add("export", work(3, 6));
        // Every other burst: enough for two replicas.
        if (round % 2 === 1) {
          await jobs.queue("ledger").addBulk(
            Array.from({ length: between(4, 8) }, () => ({
              name: "post",
              data: work(3, 6),
            })),
          );
        }
        // Obinna's pings: one now through the registry's builder sent on with
        // `.toQueue()`, one in 20 s through `jobs.queue(name).schedule()`.
        await jobs
          .schedule("ping-obinna", nextData())
          .toQueue("obinna-queue")
          .start();
        await jobs
          .queue("obinna-queue")
          .schedule("ping-obinna", nextData())
          .in("20 seconds")
          .start();
      };
      const tick = (): void => {
        addBurst().catch((error: unknown) => {
          console.error("playground summoning:", error);
        });
      };
      tick();
      if (every > 0) {
        timers.push(setInterval(tick, every));
      }
      // A leg every 5 s: marathon never goes idle, so its units run to their
      // 45 s lifetime and are replaced.
      const leg = (): void => {
        jobs
          .queue("marathon")
          .add("leg", work(4, 6))
          .catch((error: unknown) => {
            console.error("playground summoning:", error);
          });
      };
      leg();
      timers.push(setInterval(leg, 5_000));
    },
    stop: async () => {
      for (const timer of timers) {
        clearInterval(timer);
      }
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
      try {
        const stopped = await board.stop();
        // Every unit has exited: nothing of this run's for a later one to stop.
        pids.forgetMine();
        return stopped;
      } finally {
        // Even when stopping the units failed: the cgroup's release kills
        // whatever is left in it before removing it.
        await cgroup.release();
      }
    },
  };
}
