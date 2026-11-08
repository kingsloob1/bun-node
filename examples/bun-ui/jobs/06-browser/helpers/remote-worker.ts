/**
 * Another process, for `06-browser/live-events.ts` and `06-browser/workers.ts`:
 * one publishing worker on a queue the parent's API has never seen, on the
 * same file-driver directory and namespace. To the parent's API that queue
 * is "created by another process": its notifier finds it only on its next
 * discovery pass, so the worker's first-start `state` event goes unheard and
 * the `workers` channel sends a `gap` with reason `queue-discovered` instead.
 *
 * ```bash
 * bun 06-browser/helpers/remote-worker.ts <file-driver root> <namespace> <queue> <service>
 * ```
 *
 * It prints `ready <worker id>` once the worker has started (its first
 * start announced). Each line on stdin is a command: `pause` or `resume`,
 * answered with `paused` / `resumed` once done. It closes when its stdin
 * ends: the parent holds the pipe, so this process goes when the parent
 * does, however the parent ends.
 */
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs } from "@kingsleyweb/bun-jobs";

const [root, namespace, queue, service] = process.argv.slice(2);
if (
  root === undefined ||
  namespace === undefined ||
  queue === undefined ||
  service === undefined
) {
  throw new Error(
    "usage: remote-worker.ts <file-driver root> <namespace> <queue> <service>",
  );
}

const jobs = new BunJobs({
  namespace,
  service,
  driver: { type: "file", root },
  logger: noopLogger,
  // Its worker's state changes reach the parent's socket only if published.
  publishEvents: true,
});
const worker = jobs.worker(queue, async () => "done", {
  concurrency: 1,
  reportInterval: 500,
  pollInterval: 20,
  waitToExit: false,
  logger: noopLogger,
});
worker.on("ready", () => console.log(`ready ${worker.id}`));
void worker.run();

// One command per line; the parent closing the pipe (or dying) ends it.
let pending = "";
for await (const chunk of Bun.stdin.stream()) {
  pending += new TextDecoder().decode(chunk);
  let newline = pending.indexOf("\n");
  while (newline !== -1) {
    const command = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (command === "pause") {
      await worker.pause();
      console.log("paused");
    } else if (command === "resume") {
      worker.resume();
      console.log("resumed");
    }
    newline = pending.indexOf("\n");
  }
}
await worker.close({ force: true });
await jobs.close();
process.exit(0);
