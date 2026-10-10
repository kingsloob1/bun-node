import type {
  DriverConfig,
  Summoner,
  SummonReleaseRequest,
  SummonRequest,
} from "../../lib/index";
import type { SpawnedUnit } from "../../lib/provider/testing/spawn";
import { join } from "node:path";
import { defineSummoner } from "../../lib/index";
import { unitLines, unitSpawner } from "../../lib/provider/testing/spawn";

/**
 * A spawning summoner: a real `Summoner` that starts
 * `fixtures/summoned-worker.ts` as a separate `bun` process, with the
 * request's `argv`, against a shared driver — so the whole handoff runs with
 * no cloud: claim, call, boot, register, release, drain, exit.
 *
 * Built on the conformance kit's handoff half (`unitSpawner` in
 * `lib/provider/testing/spawn.ts`), which starts the kit's own fixture
 * worker the same way. Test-only; it was called `fakePlatform` until the kit
 * took that name for its HTTP fake (plugins §12.4).
 *
 * Failure injection covers what §11.1 lists: a throw, `unavailable`, a start
 * that never registers, a worker that crashes holding a job, and a slow boot
 * (`coldStartMs` past the policy's `bootBudget`).
 */

/** The summoned worker every spawning summoner starts. */
export const SUMMONED_WORKER = join(
  import.meta.dir,
  "..",
  "fixtures",
  "summoned-worker.ts",
);

/** How a spawning summoner behaves. */
export interface SpawningSummonerOptions {
  /** The driver config the summoned worker builds, which must reach the controller's backend. */
  driver: DriverConfig;
  /** Delay between the call and the process starting, in ms. Defaults to `0`. */
  coldStartMs?: number;
  /** Answer every call this way instead of starting anything. */
  fail?: "throw" | "unavailable";
  /** Accept the call and start nothing, so no worker ever registers. */
  neverRegister?: boolean;
  /**
   * The **first** worker started takes a job and exits 1 this long after
   * starting, holding it; later ones behave. So a test can watch the orphan
   * it leaves summon a replacement that recovers the job.
   */
  crashAfterMs?: number;
  /** How the platform passes identity. Defaults to `"argv"`. */
  passes?: "argv" | "none";
  /** The summoner's style. Defaults to `"launch"`. */
  style?: "launch" | "scale" | "wake";
  /** The declared boot budget, in ms. Defaults to `20_000`. */
  bootBudget?: number;
  /** Extra test-control environment for the worker (never identity). */
  env?: Record<string, string>;
  /**
   * The script each process runs. Defaults to {@link SUMMONED_WORKER};
   * `fixtures/summoned-unit.ts` for a shared unit's.
   */
  worker?: string;
  /**
   * Start every unit twice, with the same argv: a platform's double start
   * (a retried launch). Defaults to `false`.
   */
  startTwice?: boolean;
}

/** A spawning summoner, and what it saw. */
export interface SpawningSummoner {
  /** The summoner to hand a controller. */
  summoner: Summoner;
  /** Every request it was called with, in order. */
  calls: SummonRequest[];
  /** Every release it was asked for. */
  releases: SummonReleaseRequest[];
  /** Every process it started. */
  spawned: SpawnedUnit[];
  /** Resolves once every process started so far (and any still cold-starting) has exited. */
  settled: () => Promise<void>;
  /** Kills every process it started, and waits for them. */
  kill: () => Promise<void>;
}

/** Builds a spawning summoner. */
export function spawningSummoner(
  options: SpawningSummonerOptions,
): SpawningSummoner {
  const calls: SummonRequest[] = [];
  const releases: SummonReleaseRequest[] = [];
  const spawner = unitSpawner(options.worker ?? SUMMONED_WORKER, {
    SUMMON_TEST_DRIVER: JSON.stringify(options.driver),
    ...options.env,
  });
  let n = 0;
  let first = true;

  /** Starts the request's workers once the cold start has passed. */
  const start = (request: SummonRequest): void => {
    const argv = options.passes === "none" ? [] : [...request.argv];
    for (let unit = 0; unit < request.count; unit++) {
      const env: Record<string, string> = {
        SUMMON_TEST_NAMESPACE: request.namespace,
        SUMMON_TEST_QUEUE: request.queue,
        // Only the first worker crashes, so its replacement recovers the job.
        ...(options.crashAfterMs === undefined || !first
          ? {}
          : { SUMMON_TEST_CRASH_AFTER_MS: String(options.crashAfterMs) }),
        ...options.env,
      };
      first = false;
      for (let copy = 0; copy < (options.startTwice ? 2 : 1); copy++) {
        void spawner.start({ argv, env }, options.coldStartMs ?? 0);
      }
    }
  };

  const summoner = defineSummoner({
    kind: "fake",
    style: options.style ?? "launch",
    passes: options.passes ?? "argv",
    bootBudget: options.bootBudget ?? 20_000,
    invoke: async (request) => {
      calls.push(request);
      if (options.fail === "throw") {
        throw new Error("the fake platform refused");
      }
      if (options.fail === "unavailable") {
        return { status: "unavailable", reason: "no capacity" };
      }
      const handles = Array.from(
        { length: request.count },
        () => `fake-${++n}`,
      );
      if (!options.neverRegister) {
        start(request);
      }
      return { status: "started", handles };
    },
    ...(options.style === "scale"
      ? {
          release: async (request: SummonReleaseRequest) => {
            releases.push(request);
          },
        }
      : {}),
  });

  return {
    summoner,
    calls,
    releases,
    spawned: spawner.spawned,
    settled: spawner.settled,
    kill: async () => await spawner.kill("SIGKILL"),
  };
}

/** The JSON lines a summoned worker printed. */
export async function workerLines(
  proc: SpawnedUnit,
): Promise<Record<string, unknown>[]> {
  return await unitLines(proc);
}
