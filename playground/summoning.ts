import type { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunJobs, DriverConfig } from "@kingsleyweb/bun-jobs";
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
 * `…~1` is the summoner of `renders`, which has **no** always-on worker: a
 * burst of jobs arrives every `PLAYGROUND_SUMMON_EVERY_MS` (default 60 s),
 * the controller summons a worker (two for a big burst), it registers on the
 * Workers page under `compute` with its summon provenance, drains the queue,
 * and exits after 10 s idle — back to zero until the next burst.
 *
 * Before some bursts a **fault** is queued on the platform, so the Summon
 * panel shows how each answer is counted; the cycle is in {@link FAULT_CYCLE},
 * `PLAYGROUND_SUMMON_FAULTS=off` turns it off, and `/local-compute` queues
 * any fault by hand.
 */

/** Options for {@link startSummoning}. */
export interface SummoningOptions {
  /** The playground's adapter, where the platform's routes are mounted. */
  app: BunHttpAdapter;
  /**
   * The driver config a summoned worker opens: the playground's own, so it
   * reaches the same queues. `undefined` on the memory driver, which no other
   * process can reach: the providers are configured and listed, but nothing
   * is summoned.
   */
  driver: DriverConfig | undefined;
}

/** The summoning world, once started. */
export interface Summoning {
  /**
   * Configures the providers and the `renders` controller, and starts the
   * bursts. Needs the platform's URL, so it is called once the server
   * listens.
   */
  start: (origin: string) => void;
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

/** Mounts the platform and returns how to start and stop the rest. */
export function mountSummoning(
  jobs: BunJobs,
  options: SummoningOptions,
): Summoning {
  const platform = new LocalCompute({
    tokens: [TOKEN],
    entry: new URL("./compute/worker.ts", import.meta.url).pathname,
    maxUnits: 4,
  });
  platform.mount(options.app);

  // The providers are kept here for the process's life: the provider
  // registry behind `GET /providers` holds them weakly, so one nobody
  // references can drop out of the list.
  const providers: ReturnType<typeof localCompute>[] = [];
  let burst: ReturnType<typeof setInterval> | undefined;

  return {
    start: (origin) => {
      const url = `${origin}${platform.basePath}`;
      storeSecret("local-compute/token", TOKEN);

      // ~1: pending while the secret store answers, then ready.
      const primary = localCompute({
        url,
        region: "local-1",
        pool: "renders",
        apiTokenSecret: "local-compute/token",
      });
      // ~2: ready at once, but its token is not one the platform knows.
      const wrongToken = localCompute({
        url,
        region: "local-2",
        pool: "renders",
        apiToken: "lc_live_revoked_0000",
      });
      // ~3: names a secret the store does not hold: pending, then failed.
      const missingSecret = localCompute({
        url,
        region: "local-2",
        pool: "gpu",
        apiTokenSecret: "local-compute/gpu-token",
      });
      providers.push(primary, wrongToken, missingSecret);

      if (options.driver === undefined) {
        return;
      }

      const renders = jobs.queue("renders");
      jobs.summonController("renders", {
        summoner: primary,
        // A big burst gets a second worker.
        maxWorkers: 2,
        jobsPerWorker: 8,
        // Tighter than the defaults, so a playground session sees the whole
        // cycle: a check every 5 s, a retry within seconds, and a circuit
        // that closes again after a minute.
        triggers: { poll: 5_000 },
        cooldown: 5_000,
        backoff: { initial: 5_000, max: 30_000 },
        circuit: { failures: 3, resetAfter: 60_000 },
        budget: { perHour: 240, perDay: 2_000 },
        maxLifetime: 600_000,
        // Static, the same for every attempt: how a unit reaches the backend.
        env: { PLAYGROUND_SUMMON_DRIVER: JSON.stringify(options.driver) },
      });

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
