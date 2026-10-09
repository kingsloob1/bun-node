import { mkdirSync } from "node:fs";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../../../lib/index";

/**
 * A worker in a process of its own, for a test to kill: runs one job of the
 * processor in `argv[2]` on a container target (the image in `argv[3]`, the
 * worker key in `argv[4]`, the target's extra options as JSON in `argv[5]`),
 * prints `STARTED` once `$MARKER_DIR/started` exists, then waits for ever.
 */
const [processor, image, key, extra] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const driver = new MemoryDriver();
const namespace = `i1proc${Math.random().toString(36).slice(2, 8)}`;
const queue = new BunQueue("boxed", { namespace, driver, logger: noopLogger });
const worker = new BunQueueWorker("boxed", processor, {
  namespace,
  driver,
  key,
  logger: noopLogger,
  pollInterval: 10,
  target: {
    kind: "container",
    image,
    pull: "never",
    ...(JSON.parse(extra) as object),
  },
});
void worker.run();
await queue.add("x", {}, { attempts: 1 });
const dir = process.env.MARKER_DIR!;
mkdirSync(dir, { recursive: true });
while (!(await Bun.file(`${dir}/started`).exists())) {
  await Bun.sleep(20);
}
// eslint-disable-next-line no-console -- the test reads it
console.log("STARTED");
await new Promise(() => {});
