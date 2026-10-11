import { existsSync } from "node:fs";
import process from "node:process";
import { FileDriver } from "../../../lib/drivers/file-driver";

/**
 * A process that takes a file driver lock and stays inside it, for
 * `file-driver-lock-liveness.test.ts` to pause, kill or inspect from outside.
 *
 * It runs one compare-and-set (`setQueueState`) on `NAME` in `ROOT`, and holds
 * it at the write: `Bun.write` is wrapped so the first state write — between
 * the compare-and-set's read and its rename, under the entry's lock — prints a
 * `holding` line naming the lock file and then waits for the file at `GO` to
 * exist before writing. With `GO` unset it waits for ever, for a test that
 * kills it there.
 *
 * Its event loop stays alive while it waits (a poll of `GO`), so a test sees
 * what a live holder does; a test that wants it frozen sends `SIGSTOP`.
 *
 * It prints JSON lines: `{ holding, lock, pid }`, then `{ won }` with the
 * version its compare-and-set returned (`null` when it lost).
 */

const root = process.env.ROOT!;
const go = process.env.GO;
const name = process.env.NAME ?? "counter";
const q = { ns: process.env.NS!, queue: "lock-liveness" };

/** Whether the test has said to go on: `GO` is set and exists. */
function released(): boolean {
  return go !== undefined && existsSync(go);
}

const write = Bun.write;
let held = false;

Reflect.set(
  Bun,
  "write",
  async (...args: Parameters<typeof Bun.write>): Promise<number> => {
    const [destination] = args;
    if (
      !held &&
      typeof destination === "string" &&
      destination.includes("/state/") &&
      destination.endsWith(".tmp")
    ) {
      held = true;
      const lock = `${destination.slice(0, destination.indexOf(".json."))}.lock`;
      process.stdout.write(
        `${JSON.stringify({ holding: true, lock, pid: process.pid })}\n`,
      );
      while (!released()) {
        await Bun.sleep(10);
      }
    }
    return await write(...args);
  },
);

const driver = new FileDriver({ root });
await driver.ensureQueue(q);

const current = await driver.getQueueState(q, name);
const won = await driver.setQueueState(
  q,
  name,
  "holder",
  current?.version ?? null,
);
process.stdout.write(`${JSON.stringify({ won })}\n`);

await driver.close();
