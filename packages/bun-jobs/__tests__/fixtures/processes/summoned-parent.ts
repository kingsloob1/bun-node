import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  BunQueue,
  BunQueueWorker,
  MemoryDriver,
  summonedFromArgs,
} from "../../../lib/index";
import { spawnProbe } from "./spawnProbe";

/**
 * A summoned process, started by `summon-provenance.test.ts` with
 * `--bun-jobs-summon-id=attempt-1` on its command line **and**
 * `BUN_JOBS_SUMMON_ID=attempt-1` in its environment (what the draft's env
 * channel would have set). It reads its provenance, deletes the variable (as
 * a careful env reader would), and then spawns descendants three ways, with
 * `Bun.spawn` and no `env`: from the main thread, from an in-process
 * processor, and from a worker-thread target's thread. Prints one JSON line.
 */

const self = summonedFromArgs() ?? null;
delete process.env.BUN_JOBS_SUMMON_ID;
const envAfterDelete = process.env.BUN_JOBS_SUMMON_ID ?? null;

const mainThread = await spawnProbe();

/** Runs one job on a fresh worker and returns its result. */
async function runOne(
  processor: ConstructorParameters<typeof BunQueueWorker>[1],
  target: "in-process" | "worker-thread",
): Promise<unknown> {
  const driver = new MemoryDriver();
  const namespace = `summoned-${target}`;
  const queue = new BunQueue("probe", { namespace, driver });
  const worker = new BunQueueWorker("probe", processor, {
    namespace,
    driver,
    target,
    pollInterval: 10,
    waitToExit: false,
    logger: noopLogger,
  });
  void worker.run();
  const job = await queue.add("probe", {}, { removeOnComplete: false });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const stored = await queue.getJob(job.id);
    if (stored?.state === "completed") {
      await worker.close({ force: true });
      await queue.close();
      return stored.returnValue;
    }
    if (stored?.state === "dead" || Date.now() > deadline) {
      throw new Error(`probe job ended ${stored?.state ?? "missing"}`);
    }
    await Bun.sleep(10);
  }
}

const inProcess = await runOne(async () => spawnProbe(), "in-process");
const workerThread = await runOne(
  join(import.meta.dir, "..", "handlers", "job-summon-probe.ts"),
  "worker-thread",
);

process.stdout.write(
  `${JSON.stringify({ self, envAfterDelete, mainThread, inProcess, workerThread })}\n`,
);
process.exit(0);
