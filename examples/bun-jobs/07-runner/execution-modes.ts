/**
 * Execution modes — the same handler in a child process, a `Worker`, and
 * in-process.
 *
 * ```bash
 * bun 07-runner/execution-modes.ts
 * ```
 *
 * | Mode | Isolation | Start-up cost | Can be force-killed |
 * |---|---|---|---|
 * | `spawn` (default) | its own process: a crash, a leak or `process.exit` cannot touch the parent | a new `bun` process | yes — close → `SIGTERM` → `SIGKILL` |
 * | `worker` | its own thread and module graph, shared process | a thread | yes — `worker.terminate()` |
 * | `in-process` | none: the parent's thread, modules and memory | nothing | no — it can only be *asked* via `ctx.signal` |
 *
 * Pick `spawn` for anything long, heavy or untrusted; `in-process` for small,
 * frequent, well-behaved work where start-up cost dominates.
 */
import type { ExecutionMode } from "@kingsleyweb/bun-jobs";
import type { WhoAmI } from "./handlers/whoami";
import process from "node:process";
import { BunRunner } from "@kingsleyweb/bun-jobs";
import { exampleNamespace } from "../shared/backend";
import { show, step, title } from "../shared/console";

title("Execution modes");

show("parent pid", process.pid);

const modes: ExecutionMode[] = ["in-process", "worker", "spawn"];

for (const mode of modes) {
  step(mode);

  const runner = new BunRunner<{ greeting: string }, WhoAmI>({
    id: `whoami-${mode}`,
    namespace: exampleNamespace("modes"),
    file: new URL("./handlers/whoami.ts", import.meta.url),
    executionMode: mode,
    // Options for the mode in use; the others are ignored.
    spawn: { env: { FEATURE_FLAG: "on" }, stdout: "inherit" },
    worker: { smol: true, name: "whoami-worker" },
    inProcess: { reloadOnEachRun: false },
  });

  const done = new Promise<WhoAmI>((resolve, reject) => {
    runner.once("finished", (_run, result) => resolve(result));
    runner.once("failed", (_run, error) => reject(error));
  });

  await runner.start();
  const startedAt = performance.now();
  await runner.trigger({ args: { greeting: `hello from ${mode}` } });
  const result = await done;

  show("result", {
    ...result,
    sameProcess: result.pid === process.pid,
  });
  show("round trip", `${(performance.now() - startedAt).toFixed(1)}ms`);

  await runner.stop();
}
