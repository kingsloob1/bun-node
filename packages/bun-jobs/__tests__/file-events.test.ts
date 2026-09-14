import type { DriverEvent } from "../lib/index";
import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { FileDriver } from "../lib/index";
import { queueEvent } from "../lib/shared/events";
import { makeTmpDir, waitFor } from "./helpers";

/**
 * A file-driver subscriber delivers an event whose line is caught half written.
 *
 * Each poll reads from its offset to the log's current size. It used to move
 * the offset to that size whatever it had read, so a line only partly there —
 * another process's append split across writes, or a short read under load —
 * failed to parse and was skipped, and the rest of it never began a line: the
 * event was gone for good. Written in two parts here, with polls in between.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/** The event log file under `root`, once one exists. */
async function eventLog(root: string): Promise<string | undefined> {
  const entries = (await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) as unknown as {
    name: string;
    parentPath?: string;
    path?: string;
    isFile: () => boolean;
  }[];

  const log = entries.find(
    (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
  );
  return log ? join(log.parentPath ?? log.path ?? root, log.name) : undefined;
}

describe("FileDriver events", () => {
  it("delivers an event whose line arrives in two parts, once", async () => {
    const { path: root, cleanup } = await makeTmpDir();
    cleanups.push(cleanup);
    const driver = new FileDriver({ root, pollInterval: 20 });
    const heard: string[] = [];
    const event = (id: string): DriverEvent =>
      queueEvent(
        { ns: "files", target: "orders", type: "added", origin: "test" },
        { id },
      );

    const unsubscribe = await driver.subscribe(
      "files",
      "queue",
      "orders",
      (received) => heard.push((received.payload as { id: string }).id),
    );

    try {
      await driver.publish(event("whole"));
      await waitFor(() => heard.includes("whole"), { timeout: 5_000 });

      const log = await eventLog(root);
      expect(log).toBeDefined();
      const line = `${JSON.stringify(event("torn"))}\n`;

      await appendFile(log!, line.slice(0, 40));
      await Bun.sleep(100); // several polls see only the first part
      await appendFile(log!, line.slice(40));

      await waitFor(() => heard.includes("torn"), {
        timeout: 5_000,
        message:
          "an event whose line was caught half written was never delivered",
      });
      await Bun.sleep(100);
      expect(heard).toEqual(["whole", "torn"]);
    } finally {
      await unsubscribe();
      await driver.close();
    }
  });
});
