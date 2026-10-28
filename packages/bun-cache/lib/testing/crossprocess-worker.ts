/**
 * The child half of the conformance kit's two-process pass (plan §6.2): the
 * kit spawns this file with a JSON job, it builds the same driver the kit is
 * testing — from the job's module path, export and options — and connects it,
 * prints `{"ready":true}`, and waits at the start barrier (its stdin closing)
 * so that its operation and the kit's own side start together. Then it
 * performs the operation and prints the result as one JSON line on stdout.
 *
 * Not a public API: it exists so `runCacheDriverConformance` can check
 * `multiProcess` drivers (increment, lock and stamp visibility from two
 * processes).
 */
import process from "node:process";
import type { CacheDriver } from "../core/types";

/** The job the kit passes on the command line. */
export interface CrossProcessJob {
  /** The absolute path of the module to import for the driver factory. */
  module: string;
  /** The export the factory lives under; defaults to `"default"`. */
  export?: string;
  /** The options passed to the factory. */
  options?: unknown;
  /** What to do. */
  op: "increment" | "lock" | "stamps";
  /** The namespace to work in. */
  ns: string;
  /** The key (for `increment` and `lock`). */
  key?: string;
  /** The tag (for `stamps`). */
  tag?: string;
  /** How many increments or lock attempts to make. */
  count?: number;
  /** The owner prefix for lock attempts (the parent uses another). */
  ownerPrefix?: string;
}

/** Builds the job's driver. */
async function buildDriver(job: CrossProcessJob): Promise<CacheDriver> {
  const mod = (await import(job.module)) as Record<string, unknown>;
  const factory = mod[job.export ?? "default"] as (
    options?: unknown,
  ) => CacheDriver;
  return factory(job.options ?? {});
}

/** Prints one JSON line on stdout, flushed before it resolves. */
async function emit(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, `${JSON.stringify(value)}\n`);
}

/** Performs the job and prints its result as one JSON line. */
async function main(): Promise<void> {
  const job = JSON.parse(process.argv[2] ?? "{}") as CrossProcessJob;
  const driver = await buildDriver(job);
  try {
    await driver.connect?.();
    // The start barrier: the kit releases every side at once by closing stdin.
    await emit({ ready: true });
    await Bun.stdin.text();
    switch (job.op) {
      case "increment": {
        if (driver.increment === undefined || job.key === undefined) {
          throw new Error("the driver has no increment, or the job has no key");
        }
        // Ten waves, yielding between them — the kit's own side has the same
        // shape (`incrementInWaves`), so the two genuinely interleave.
        const count = job.count ?? 100;
        const perWave = Math.ceil(count / 10);
        const results: number[] = [];
        for (let done = 0; done < count; done += perWave) {
          const wave = Math.min(perWave, count - done);
          results.push(
            ...(await Promise.all(
              Array.from({ length: wave }, async () =>
                driver.increment!(job.ns, job.key!, 1, null),
              ),
            )),
          );
          await Bun.sleep(0);
        }
        await emit({ results });
        return;
      }
      case "lock": {
        if (driver.acquireLock === undefined || job.key === undefined) {
          throw new Error("the driver has no locks, or the job has no key");
        }
        const prefix = job.ownerPrefix ?? "c-";
        const outcomes = await Promise.all(
          Array.from({ length: job.count ?? 25 }, async (_, index) => {
            const owner = `${prefix}${index}`;
            return (await driver.acquireLock!(job.ns, job.key!, owner, 60_000))
              ? owner
              : undefined;
          }),
        );
        const winners = outcomes.filter(
          (owner): owner is string => owner !== undefined,
        );
        await emit({ acquired: winners.length, winners });
        return;
      }
      case "stamps": {
        if (job.tag === undefined) {
          throw new Error("the job has no tag");
        }
        const now = Date.now();
        await driver.setStamps(job.ns, [job.tag], now, now + 60_000);
        await emit({ stamped: job.tag, at: now });
        return;
      }
      default:
        throw new Error(`unknown op ${JSON.stringify(job.op)}`);
    }
  } finally {
    await driver.close();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
