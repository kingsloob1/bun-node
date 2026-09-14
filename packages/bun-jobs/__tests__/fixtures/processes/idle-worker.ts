import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunQueueWorker, MemoryDriver } from "../../../lib/index";

/**
 * A process whose only work is a worker on an empty queue — a worker service,
 * reduced to its shape. It never calls `process.exit`: whether it stays up, and
 * whether it goes away once closed, is exactly what is being tested.
 */

const worker = new BunQueueWorker("idle", async () => null, {
  namespace: "idle-worker",
  driver: new MemoryDriver(),
  logger: noopLogger,
  pollInterval: 25,
  ...(process.env.WAIT_TO_EXIT === "false" ? { waitToExit: false } : {}),
});

process.once("SIGTERM", () => {
  void worker.close().then(() => {
    console.log(JSON.stringify({ event: "closed" }));
  });
});

console.log(JSON.stringify({ event: "started" }));

// Not a top-level `await`. Bun spins on a top-level await that never settles,
// which would keep this process alive whatever the worker did — and whether the
// worker keeps it alive is the thing under test.
void worker.run().then(() => {
  console.log(JSON.stringify({ event: "run-returned" }));
});
