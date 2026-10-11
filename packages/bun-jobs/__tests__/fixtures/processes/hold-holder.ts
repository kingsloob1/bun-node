import type { JobPatch } from "../../../lib/drivers/driver";
import { existsSync } from "node:fs";
import process from "node:process";
import { FileDriver } from "../../../lib/drivers/file-driver";

/**
 * A process that takes a job's marker out of the file driver's index (a hold)
 * and stays inside it, for `file-driver-hold-liveness.test.ts` to pause, kill
 * or race from outside.
 *
 * It runs one `updateJob` of job `ID` in queue `QUEUE` of namespace `NS` under
 * `ROOT`, with `PATCH` (JSON), and holds it at the write: `Bun.write` is
 * wrapped so the first job record write — the patch has the marker held and
 * has read the record it will change — prints a `holding` line and then waits
 * for the file at `GO` to exist before writing. With `GO` unset it waits for
 * ever, for a test that kills it there.
 *
 * Its event loop stays alive while it waits (a poll of `GO`), so a test sees
 * what a live holder does; a test that wants it frozen sends `SIGSTOP`.
 *
 * It prints JSON lines: `{ holding, pid }`, then `{ updated }` with the record
 * its `updateJob` answered (`null` when it changed nothing).
 */

const root = process.env.ROOT!;
const go = process.env.GO;
const id = process.env.ID!;
const patch = JSON.parse(process.env.PATCH ?? "{}") as JobPatch;
const q = { ns: process.env.NS!, queue: process.env.QUEUE! };

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
      destination.includes("/jobs/") &&
      destination.endsWith(".tmp")
    ) {
      held = true;
      process.stdout.write(
        `${JSON.stringify({ holding: true, pid: process.pid })}\n`,
      );
      while (!released()) {
        await Bun.sleep(10);
      }
    }
    return await write(...args);
  },
);

const driver = new FileDriver({ root });
const updated = await driver.updateJob(q, id, patch, Date.now());
process.stdout.write(`${JSON.stringify({ updated })}\n`);

await driver.close();
