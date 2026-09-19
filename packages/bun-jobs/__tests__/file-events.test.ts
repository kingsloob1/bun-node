import type { DriverEvent } from "../lib/index";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { FileDriver } from "../lib/index";
import { queueEvent, runnerEvent } from "../lib/shared/events";
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

  /*
   * Event pruning must never drop an event younger than the retention window.
   *
   * A publish kicks off a sweep of its namespace. The sweep used to start
   * *before* the publish appended its line, and judged each log by two
   * separate `stat`s — age, then size — with a missing file reading as
   * modified at the epoch. So a log whose directory had just been made read as
   * ancient, then (the append having landed) as non-empty, and was emptied of
   * the event that had just been written. It showed up as the driver-options
   * example losing its "fresh" event about one run in five.
   *
   * Each namespace gets exactly one due sweep per interval, so these use many
   * namespaces to turn a timing race into a near certainty. Without the fix,
   * a fresh log lost its first event in roughly one namespace in seven, and a
   * stale log its new one in roughly one in fifty.
   */
  describe("pruning keeps events younger than the retention window", () => {
    /** Namespaces per test: enough that the unfixed race cannot slip by. */
    const NAMESPACES = 100;

    /** A runner event carrying `id`, so a log can be searched for it. */
    const runner = (ns: string, id: string, target = "log"): DriverEvent =>
      runnerEvent(
        { ns, target, type: "started", origin: "test" },
        { runId: id },
      );

    /** The ids one runner's log in a namespace holds right now. */
    async function logged(
      root: string,
      ns: string,
      target = "log",
    ): Promise<string[]> {
      const path = join(root, ns, "runners", target, "events.jsonl");
      const text = await readFile(path, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            ((JSON.parse(line) as DriverEvent).payload as { runId: string })
              .runId,
        );
    }

    it("keeps the first event of a log whose sweep is due", async () => {
      const { path: root, cleanup } = await makeTmpDir();
      cleanups.push(cleanup);
      const driver = new FileDriver({ root, eventRetentionMs: 1_000 });
      const namespaces = Array.from({ length: NAMESPACES }, (_, i) => `n${i}`);

      try {
        // A namespace's first publish always finds its sweep due.
        for (const ns of namespaces) {
          await driver.publish(runner(ns, "first"));
        }
        await Bun.sleep(300); // the sweeps are not awaited by publish

        const lost = [];
        for (const ns of namespaces) {
          if (!(await logged(root, ns)).includes("first")) {
            lost.push(ns);
          }
        }
        expect(lost).toEqual([]);
      } finally {
        await driver.close();
      }
    });

    it("keeps an event another publish is appending while a sweep runs", async () => {
      const { path: root, cleanup } = await makeTmpDir();
      cleanups.push(cleanup);
      const driver = new FileDriver({ root, eventRetentionMs: 1_000 });
      const namespaces = Array.from({ length: NAMESPACES }, (_, i) => `c${i}`);

      try {
        // Two logs at once: one publish's sweep finds the other's directory
        // made and its line not yet written.
        for (const ns of namespaces) {
          await Promise.all([
            driver.publish(runner(ns, "first", "a")),
            driver.publish(runner(ns, "first", "b")),
          ]);
        }
        await Bun.sleep(300);

        const lost = [];
        for (const ns of namespaces) {
          for (const target of ["a", "b"]) {
            if (!(await logged(root, ns, target)).includes("first")) {
              lost.push(`${ns}/${target}`);
            }
          }
        }
        expect(lost).toEqual([]);
      } finally {
        await driver.close();
      }
    });

    it("keeps an event appended to a log the same sweep finds stale", async () => {
      const { path: root, cleanup } = await makeTmpDir();
      cleanups.push(cleanup);
      const driver = new FileDriver({ root, eventRetentionMs: 1_000 });
      // This interleaving is rarer than a missing log's, so it gets more tries.
      const namespaces = Array.from(
        { length: NAMESPACES * 5 },
        (_, i) => `s${i}`,
      );

      try {
        for (const ns of namespaces) {
          await driver.publish(runner(ns, "old"));
        }
        // Past the window and the one-second sweep interval, so the next
        // publish to each log both finds it stale and triggers a sweep.
        await Bun.sleep(1_100);
        for (const ns of namespaces) {
          await driver.publish(runner(ns, "new"));
        }
        await Bun.sleep(300);

        const lost = [];
        for (const ns of namespaces) {
          if (!(await logged(root, ns)).includes("new")) {
            lost.push(ns);
          }
        }
        expect(lost).toEqual([]);
      } finally {
        await driver.close();
      }
    });
  });
});
