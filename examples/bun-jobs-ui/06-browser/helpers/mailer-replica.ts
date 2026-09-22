/**
 * A second process of the `mailer` service, for `06-browser/workers.ts`: one
 * worker on `emails` named `send`, so its stable key is `mailer.emails.send`
 * like the parent's own mailer worker, on another pid. The Workers page then
 * groups the mailer service into two servers, and the worker page lists two
 * live instances of one key.
 *
 * ```bash
 * bun 06-browser/helpers/mailer-replica.ts <file-driver root> <namespace>
 * ```
 *
 * It prints `ready <worker id>` once its worker runs, and closes when its
 * stdin ends: the parent holds the pipe, so the replica goes when the parent
 * does, however the parent ends.
 */
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs } from "@kingsleyweb/bun-jobs";

const [root, namespace] = process.argv.slice(2);
if (root === undefined || namespace === undefined) {
  throw new Error("usage: mailer-replica.ts <file-driver root> <namespace>");
}

const jobs = new BunJobs({
  namespace,
  service: "mailer",
  driver: { type: "file", root },
  logger: noopLogger,
});
const worker = jobs.worker("emails", async () => "sent", {
  name: "send",
  concurrency: 1,
  reportInterval: 500,
  pollInterval: 20,
  waitToExit: false,
  logger: noopLogger,
});
void worker.run();
console.log(`ready ${worker.id}`);

// Read stdin to its end: the parent closing the pipe (or dying) ends it.
for await (const _chunk of Bun.stdin.stream()) {
  // Nothing is sent; the pipe exists only to end.
}
await worker.close({ force: true });
await jobs.close();
process.exit(0);
