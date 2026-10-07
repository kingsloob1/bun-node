import type { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type {
  BunJobs,
  DriverConfig,
  SummonOption,
} from "@kingsleyweb/bun-jobs";
import type { Fault } from "./compute/platform";
import process from "node:process";
import { LocalCompute } from "./compute/platform";
import { localCompute, storeSecret } from "./compute/provider";

/**
 * Summoning and compute providers: a queue nobody serves until a worker is
 * **summoned** for it, by a compute provider whose platform starts real
 * processes on this machine.
 *
 * | Piece | What it is |
 * |---|---|
 * | `compute/platform.ts` | "Local Compute", a made-up platform served under `/local-compute` on the playground's port; each unit is a `bun compute/worker.ts` process |
 * | `compute/provider.ts` | its provider, made with `defineComputeProvider` |
 * | `compute/worker.ts` | what a unit runs: a worker under `runSummoned` |
 *
 * Three instances of the provider are configured, one per state the
 * Providers screen (`/jobs/providers`) can show:
 *
 * | Id | Config | Readiness | Test connection |
 * |---|---|---|---|
 * | `…~1` (`local-1`) | token from the slow secret store | **pending** for 12 s, then **ready** | ok, with a `warn` check |
 * | `…~2` (`local-2`) | a token the platform does not know | ready | `auth`, `InvalidToken` |
 * | `…~3` (`local-2`, pool `gpu`) | a secret the store does not hold | pending, then **failed** | `misconfigured`, `invalid config: apiTokenSecret` |
 *
 * `…~1` is the summoner of `renders` and `transcodes`, one policy written
 * once for both as a **summon group** (the context's `summon` option), which
 * still gives each queue a controller of its own. Neither has an always-on
 * worker: a burst of jobs arrives every `PLAYGROUND_SUMMON_EVERY_MS` (default
 * 60 s), each queue's controller summons a worker (two for a big `renders`
 * burst), it registers on the Workers page under `compute` with its summon
 * provenance, drains its queue, and exits after 10 s idle — back to zero
 * until the next burst. The same `compute/worker.ts` serves both queues.
 *
 * Before some bursts a **fault** is queued on the platform, so the Summon
 * panel shows how each answer is counted; the cycle is in {@link FAULT_CYCLE},
 * `PLAYGROUND_SUMMON_FAULTS=off` turns it off, and `/local-compute` queues
 * any fault by hand.
 */

/** Options for {@link createSummoning}. */
export interface SummoningOptions {
  /**
   * The origin the platform's API is called at, `http://127.0.0.1:<port>`:
   * the address the playground listens on (`localhost` may resolve to `::1`,
   * where nothing listens). Needed before it listens, because the providers,
   * and the summon group naming one, exist before the context does.
   */
  origin: string;
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
   * The context's `summon` option: one group, `renders` and `transcodes`.
   * `undefined` on the memory driver, which cannot summon.
   */
  summon: SummonOption | undefined;
  /** Mounts the platform's routes (`/local-compute`) on the adapter. */
  mount: (app: BunHttpAdapter) => void;
  /** Starts the bursts, on the context built with {@link summon}. */
  start: (jobs: BunJobs) => void;
  /** Stops the bursts and every unit still running. */
  stop: () => Promise<void>;
  /** `SIGKILL`s every unit still running, for a synchronous `exit` handler. */
  killAll: () => void;
}

/** The token Local Compute accepts: made up. A declared secret. */
const TOKEN = "lc_live_9f3b7c21e4d85a60";

/** The fault queued before each burst, in turn; `undefined` for none. */
const FAULT_CYCLE: readonly (Fault | undefined)[] = [
  undefined,
  "throttled",
  undefined,
  "auth",
  undefined,
  "crash",
  undefined,
  "die",
];

/** Scenes a render job renders. */
const SCENES = ["hero-banner", "product-spin", "intro-titles", "map-flyover"];

/** A random integer in [min, max]. */
function between(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Configures the providers and the summon group, and returns how to mount the
 * platform and start and stop the rest.
 */
export function createSummoning(options: SummoningOptions): Summoning {
  const platform = new LocalCompute({
    tokens: [TOKEN],
    entry: new URL("./compute/worker.ts", import.meta.url).pathname,
    maxUnits: 4,
  });
  const url = `${options.origin}${platform.basePath}`;
  storeSecret("local-compute/token", TOKEN);

  // Kept here for the process's life: the provider registry behind
  // `GET /providers` holds them weakly, so one nobody references can drop out
  // of the list. Configured in this order, so their ids are `~1`, `~2`, `~3`.
  const providers = [
    // ~1: pending while the secret store answers, then ready.
    localCompute({
      url,
      region: "local-1",
      pool: "renders",
      apiTokenSecret: "local-compute/token",
    }),
    // ~2: ready at once, but its token is not one the platform knows.
    localCompute({
      url,
      region: "local-2",
      pool: "renders",
      apiToken: "lc_live_revoked_0000",
    }),
    // ~3: names a secret the store does not hold: pending, then failed.
    localCompute({
      url,
      region: "local-2",
      pool: "gpu",
      apiTokenSecret: "local-compute/gpu-token",
    }),
  ];
  let burst: ReturnType<typeof setInterval> | undefined;

  const summon: SummonOption | undefined =
    options.driver === undefined
      ? undefined
      : [
          {
            // One policy written once for both queues: still a controller,
            // a marker, a budget and a circuit for each.
            queues: ["renders", "transcodes"],
            summoner: providers[0]!,
            // A big burst gets a second worker.
            maxWorkers: 2,
            jobsPerWorker: 8,
            // Tighter than the defaults, so a playground session sees the
            // whole cycle: a check every 5 s, a retry within seconds, and a
            // circuit that closes again after a minute.
            triggers: { poll: 5_000 },
            cooldown: 5_000,
            backoff: { initial: 5_000, max: 30_000 },
            circuit: { failures: 3, resetAfter: 60_000 },
            budget: { perHour: 240, perDay: 2_000 },
            maxLifetime: 600_000,
            // Static, the same for every attempt: how a unit reaches the
            // backend.
            env: { PLAYGROUND_SUMMON_DRIVER: JSON.stringify(options.driver) },
            // Transcodes are few: one worker is always enough.
            overrides: { transcodes: { maxWorkers: 1 } },
          },
        ];

  return {
    summon,
    mount: (app) => platform.mount(app),
    start: (jobs) => {
      if (summon === undefined) {
        return;
      }
      const renders = jobs.queue("renders");
      const transcodes = jobs.queue("transcodes");

      const every = Number(process.env.PLAYGROUND_SUMMON_EVERY_MS ?? 60_000);
      const faults = process.env.PLAYGROUND_SUMMON_FAULTS !== "off";
      let round = 0;
      const addBurst = async (): Promise<void> => {
        const fault = faults
          ? FAULT_CYCLE[round % FAULT_CYCLE.length]
          : undefined;
        round++;
        // One fault at a time: a fault is spent only by the next start, so
        // while none happens (a worker still draining, backoff, the circuit
        // open) queuing more would fire them back to back later.
        if (fault !== undefined && platform.pendingFaults.length === 0) {
          platform.inject(fault);
        }
        const count = between(4, 16);
        await renders.addBulk(
          Array.from({ length: count }, () => ({
            name: "render",
            data: {
              scene: SCENES[between(0, SCENES.length - 1)]!,
              frames: between(4, 10),
            },
          })),
        );
        await transcodes.addBulk(
          Array.from({ length: between(1, 3) }, () => ({
            name: "transcode",
            data: {
              scene: SCENES[between(0, SCENES.length - 1)]!,
              frames: between(4, 10),
            },
          })),
        );
      };
      const tick = (): void => {
        addBurst().catch((error: unknown) => {
          console.error("playground summoning:", error);
        });
      };
      tick();
      if (every > 0) {
        burst = setInterval(tick, every);
      }
    },
    stop: async () => {
      clearInterval(burst);
      await platform.stop();
    },
    killAll: () => platform.killAll(),
  };
}
