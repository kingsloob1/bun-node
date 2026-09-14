/**
 * A process whose only work is a scheduled runner — started by
 * `runner-options.ts` to show `waitToExit`.
 *
 * `WAIT_TO_EXIT=1` keeps the schedule's timer referenced, so the process
 * stays alive for the next tick; anything else unrefs it, so the process has
 * nothing to do and exits. It prints `runner-started` once `start()` resolves.
 */
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunRunner } from "@kingsleyweb/bun-jobs";

const runner = new BunRunner({
  id: "keepalive",
  namespace: "wait-to-exit",
  file: new URL("./runner-work.ts", import.meta.url),
  executionMode: "in-process",
  schedule: 3_600_000,
  waitToExit: process.env.WAIT_TO_EXIT === "1",
  logger: noopLogger,
});

// Not a top-level await: the process's lifetime is exactly what is observed.
void runner.start().then(() => {
  console.log("runner-started");
});
