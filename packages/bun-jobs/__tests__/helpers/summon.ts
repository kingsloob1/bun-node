import type {
  DriverConfig,
  Summoner,
  SummonReleaseRequest,
  SummonRequest,
} from "../../lib/index";
import type { SpawnedProcess } from "./spawnBun";
import { join } from "node:path";
import { defineSummoner } from "../../lib/index";
import { spawnBun } from "./spawnBun";

/**
 * A fake platform: a real `Summoner` that starts
 * `fixtures/summoned-worker.ts` as a separate `bun` process, with the
 * request's `argv`, against a shared driver — so the whole handoff runs with
 * no cloud: claim, call, boot, register, release, drain, exit.
 *
 * Failure injection covers what §11.1 lists: a throw, `unavailable`, a start
 * that never registers, a worker that crashes holding a job, and a slow boot
 * (`coldStartMs` past the policy's `bootBudget`).
 */

/** The summoned worker every fake platform starts. */
export const SUMMONED_WORKER = join(
  import.meta.dir,
  "..",
  "fixtures",
  "summoned-worker.ts",
);

/** How a fake platform behaves. */
export interface FakePlatformOptions {
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
}

/** A fake platform, and what it saw. */
export interface FakePlatform {
  /** The summoner to hand a controller. */
  summoner: Summoner;
  /** Every request it was called with, in order. */
  calls: SummonRequest[];
  /** Every release it was asked for. */
  releases: SummonReleaseRequest[];
  /** Every process it started. */
  spawned: SpawnedProcess[];
  /** Resolves once every process started so far (and any still cold-starting) has exited. */
  settled: () => Promise<void>;
  /** Kills every process it started, and waits for them. */
  kill: () => Promise<void>;
}

/** Builds a fake platform. */
export function fakePlatform(options: FakePlatformOptions): FakePlatform {
  const calls: SummonRequest[] = [];
  const releases: SummonReleaseRequest[] = [];
  const spawned: SpawnedProcess[] = [];
  const starting: Promise<void>[] = [];
  let n = 0;

  const start = (request: SummonRequest): void => {
    const args = options.passes === "none" ? [] : [...request.argv];
    const env: Record<string, string> = {
      SUMMON_TEST_DRIVER: JSON.stringify(options.driver),
      SUMMON_TEST_NAMESPACE: request.namespace,
      SUMMON_TEST_QUEUE: request.queue,
      ...(options.crashAfterMs === undefined || spawned.length > 0
        ? {}
        : { SUMMON_TEST_CRASH_AFTER_MS: String(options.crashAfterMs) }),
      ...options.env,
    };
    for (let unit = 0; unit < request.count; unit++) {
      spawned.push(spawnBun(SUMMONED_WORKER, env, args));
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
        starting.push(
          (async () => {
            await Bun.sleep(options.coldStartMs ?? 0);
            start(request);
          })(),
        );
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
    spawned,
    settled: async () => {
      await Promise.all(starting);
      await Promise.all(spawned.map(async (proc) => await proc.exited));
    },
    kill: async () => {
      await Promise.all(starting);
      for (const proc of spawned) {
        proc.proc.kill("SIGKILL");
      }
      await Promise.all(spawned.map(async (proc) => await proc.exited));
    },
  };
}

/** The JSON lines a summoned worker printed. */
export async function workerLines(
  proc: SpawnedProcess,
): Promise<Record<string, unknown>[]> {
  return (await proc.output)
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
