import type { WorkerTargetFactory } from "../../../lib/index";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../../../lib/index";
import { FileTargetExecutor } from "../../../lib/queue/workerTarget";

/**
 * A process that closes its worker while a child-process attempt is still
 * alive, and then simply ends — the shape of #166. Whether that child outlives
 * this process, and how it ended, is what the test checks from outside it.
 *
 * It never calls `process.exit`: once `close()` returns there is nothing left
 * to keep it running, which is exactly when the child's kill timers (unref'd,
 * like the child) used to be lost.
 *
 * `SHAPE` picks how the attempt is still alive at `close()`:
 * - `timeout`: the job overran its deadline, so the worker has let go of it
 *   and only its kill sequence is left; `close()` comes straight after.
 * - `close-timeout`: the attempt is running normally, and `close({ timeout })`
 *   runs out of patience with it.
 * - `graceful`: as `close-timeout`, with a processor that unwinds when asked
 *   and has cleanup to do on the way out.
 * - `drain`: the attempt is running normally and ends on its own; a plain
 *   `close()` must wait for it rather than kill it.
 * - `exit-at-close`: the built-in executor is reached through a factory that
 *   returns it unchanged, and its `close()` is called directly, not awaited at
 *   the top level, with the worker not holding the process. Nothing but
 *   `close()` itself keeps the process alive until it resolves — which is
 *   what makes its grace timer's being ref'd matter.
 * - `force`: as `graceful`, closed with `close({ force: true })`: the caller
 *   asked not to wait, so the cleanup is skipped and the child killed at once.
 * - `exit-at-force`: the executor reached as in `exit-at-close`, its
 *   `close({ force: true })` called and not awaited, and `process.exit` on
 *   the very next line. Only a kill made synchronously inside `close()`
 *   survives that.
 *
 * Every processor but `graceful`'s and `force`'s spins and ignores its signal. It prints
 * JSON lines: `child` once it has seen the attempt's child alive (with `ps`'s
 * view of it, taken while it certainly is), then `closed`.
 */

const shape = process.env.SHAPE ?? "timeout";
const pidFile = process.env.PID_FILE!;
const spinMs = Number(process.env.SPIN_MS ?? 30_000);
const graceful = shape === "graceful" || shape === "force";
const reached = shape === "exit-at-close" || shape === "exit-at-force";

const driver = new MemoryDriver();
const namespace = `close-orphan-${process.pid}`;
const queue = new BunQueue("close-orphan", {
  namespace,
  driver,
  logger: noopLogger,
});
const processor = new URL(
  graceful
    ? "../handlers/job-graceful-report.ts"
    : "../handlers/job-spin-report.ts",
  import.meta.url,
);
// An escalation far longer than `close()`'s own deadline, so that deadline is
// what ends a runaway child here, never the executor's timers.
const childProcess = {
  kind: "child-process",
  closeTimeout: 10_000,
  killTimeout: 10_000,
} as const;

let executor: FileTargetExecutor | undefined;
/** The built-in executor, unchanged, but where this script can reach it. */
const direct: WorkerTargetFactory = (context) => {
  executor = new FileTargetExecutor(childProcess, fileURLToPath(processor), {
    namespace: context.namespace,
    queue: context.queue,
    workerId: context.workerId,
  });
  return executor;
};

const worker = new BunQueueWorker("close-orphan", processor, {
  namespace,
  driver,
  logger: noopLogger,
  pollInterval: 20,
  target: reached ? direct : childProcess,
  ...(reached ? { waitToExit: false } : {}),
});
void worker.run();

const job = await queue.add(
  "spin",
  graceful
    ? {
        pidFile,
        markerFile: process.env.MARKER_FILE!,
        exitFile: process.env.EXIT_FILE!,
        cleanupMs: Number(process.env.CLEANUP_MS ?? 300),
      }
    : { pidFile, spinMs },
  { attempts: 1, ...(shape === "timeout" ? { timeout: 3_000 } : {}) },
);

/** The child's own report, once it has written it. */
async function childReport(): Promise<{ pid: number; ppid: number }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await Bun.file(pidFile).text()) as {
        pid: number;
        ppid: number;
      };
    } catch {
      // Not written yet, or caught halfway through the write.
    }
    await Bun.sleep(10);
  }
  throw new Error(`the attempt's child never reported to ${pidFile}`);
}

const child = await childReport();
const ps = Bun.spawnSync(["ps", "-o", "ppid=,args=", "-p", String(child.pid)]);
console.log(
  JSON.stringify({
    event: "child",
    self: process.pid,
    ...child,
    ps: ps.stdout.toString().trim(),
  }),
);

if (shape === "exit-at-force") {
  // Not awaited, and nothing after it: the process ends here.
  void executor!.close({ force: true });
  process.exit(0);
}

if (shape === "exit-at-close") {
  const started = Date.now();
  // Deliberately not a top-level `await`: Bun keeps a process alive while
  // one is pending, which would hold it open whatever `close()` did. From
  // here the module is finished, and only `close()` can keep it running.
  void Promise.resolve(executor!.close()).then(() => {
    console.log(
      JSON.stringify({ event: "closed", closeMs: Date.now() - started }),
    );
  });
} else {
  if (shape === "timeout") {
    while ((await job.refresh())?.state !== "dead") {
      await Bun.sleep(10);
    }
  }

  const started = Date.now();
  await worker.close(
    shape === "force"
      ? { force: true }
      : shape === "close-timeout" || shape === "graceful"
        ? { timeout: 200 }
        : undefined,
  );
  const closeMs = Date.now() - started;
  const settled = await job.refresh();
  await queue.close();

  console.log(
    JSON.stringify({
      event: "closed",
      closeMs,
      state: settled?.state,
      returnValue: settled?.returnValue ?? null,
    }),
  );
}
