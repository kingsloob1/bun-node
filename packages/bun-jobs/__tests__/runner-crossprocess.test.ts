import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { makeTmpDir, testNamespace } from "./helpers";
import { runBun } from "./helpers/spawnBun";

/**
 * A `single`-mode runner across real processes.
 *
 * Two `BunRunner` instances in one process would still share a heap and an
 * event loop, so the interesting failure modes never appear. These tests
 * spawn genuine `bun` processes whose only common ground is a directory, and
 * assert what a cluster actually needs: one run at a time, no lost demand,
 * and a lock that a crash cannot hold forever.
 */

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** The script a spawned runner process runs. */
const INSTANCE = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "runner-instance.ts",
);

/** The handler that records each run to a shared file. */
const HANDLER = join(import.meta.dir, "fixtures", "handlers", "append.ts");

/** A temp directory plus the run log both processes append to. */
async function makeWorkspace(): Promise<{ root: string; log: string }> {
  const tmp = await makeTmpDir("bun-jobs-xproc");
  cleanups.push(tmp.cleanup);

  const log = join(tmp.path, "runs.log");
  await writeFile(log, "");

  return { root: join(tmp.path, "driver"), log };
}

/** How many runs the handler recorded. */
async function runCount(log: string): Promise<string[]> {
  const contents = await readFile(log, "utf8");
  return contents.split("\n").filter(Boolean);
}

describe("runner across processes", () => {
  it("runs in exactly one process when both trigger at once", async () => {
    const { root, log } = await makeWorkspace();
    const namespace = testNamespace();

    const env = (marker: string) => ({
      RUNNER_ID: "cleanup",
      NAMESPACE: namespace,
      DRIVER_ROOT: root,
      HANDLER_FILE: HANDLER,
      RUN_LOG: log,
      MARKER: marker,
    });

    const [first, second] = await Promise.all([
      runBun<{ event: string; outcome?: { outcome: string; reason?: string } }>(
        INSTANCE,
        env("a"),
      ),
      runBun<{ event: string; outcome?: { outcome: string; reason?: string } }>(
        INSTANCE,
        env("b"),
      ),
    ]);

    expect([first.exitCode, first.stderr]).toEqual([0, ""]);
    expect([second.exitCode, second.stderr]).toEqual([0, ""]);

    const outcomes = [first, second].map(
      (result) =>
        result.lines.find((line) => line.event === "trigger")?.outcome?.outcome,
    );

    // One started; the other found the lock held and, not queueing, skipped.
    expect(outcomes.filter((outcome) => outcome === "started")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "skipped")).toHaveLength(1);

    const skipped = [first, second]
      .flatMap((result) => result.lines)
      .find((line) => line.outcome?.outcome === "skipped");
    expect(skipped?.outcome?.reason).toBe("lock-held");

    expect(await runCount(log)).toHaveLength(1);
  }, 30_000);

  it("queues the loser's demand, and the lock holder drains it", async () => {
    const { root, log } = await makeWorkspace();
    const namespace = testNamespace();

    const env = (marker: string, extra: Record<string, string> = {}) => ({
      RUNNER_ID: "sync",
      NAMESPACE: namespace,
      DRIVER_ROOT: root,
      HANDLER_FILE: HANDLER,
      RUN_LOG: log,
      MARKER: marker,
      QUEUE_RUNS: "1",
      ...extra,
    });

    // The holder's run lasts long enough for the second process to arrive
    // while the lock is genuinely held, and it stays alive afterwards to
    // notice what that process queued.
    const holder = runBun<{ event: string; queued?: number }>(
      INSTANCE,
      env("holder", { RUN_MS: "1200", DRAIN_MS: "2000" }),
    );
    await Bun.sleep(400);
    const other = await runBun<{
      event: string;
      outcome?: { outcome: string; position?: number };
    }>(INSTANCE, env("other"));

    const queued = other.lines.find((line) => line.event === "trigger");
    expect(queued?.outcome?.outcome).toBe("queued");

    const holderResult = await holder;
    expect(holderResult.exitCode).toBe(0);

    const holderDone = holderResult.lines.find(
      (line) => line.event === "done",
    ) as { stats?: { success?: number }; queued?: number } | undefined;
    const otherDone = other.lines.find((line) => line.event === "done") as
      | { stats?: { success?: number } }
      | undefined;

    // Two runs happened, and both executed in the holder's process — the one
    // that owns the lock is the one that does the work.
    expect(await runCount(log)).toHaveLength(2);
    expect(holderDone?.stats?.success).toBe(2);
    expect(otherDone?.stats?.success).toBe(0);

    // The queued run kept the *requester's* arguments, not the holder's:
    // whoever asked for the run decides what it runs with.
    const markers = (await runCount(log)).map((line) => line.split(":")[0]);
    expect(markers.sort()).toEqual(["holder", "other"]);

    // Nothing was left behind for someone else to pick up.
    expect(holderDone?.queued).toBe(0);
  }, 30_000);

  it("lets another process take over a lock left by a crash", async () => {
    const { root, log } = await makeWorkspace();
    const namespace = testNamespace();

    // A lock file written by a process that is long gone, already expired.
    const lockDir = join(root, namespace, "runners", "abandoned");
    await Bun.write(
      join(lockDir, "lock.json"),
      JSON.stringify({
        token: "ghost:999999:dead",
        expiresAt: Date.now() - 60_000,
      }),
    );

    const result = await runBun<{
      event: string;
      outcome?: { outcome: string };
    }>(INSTANCE, {
      RUNNER_ID: "abandoned",
      NAMESPACE: namespace,
      DRIVER_ROOT: root,
      HANDLER_FILE: HANDLER,
      RUN_LOG: log,
      MARKER: "taker",
    });

    expect(result.exitCode).toBe(0);
    expect(
      result.lines.find((line) => line.event === "trigger")?.outcome?.outcome,
    ).toBe("started");
    expect(await runCount(log)).toHaveLength(1);
  }, 30_000);

  it("keeps the same runner id in two namespaces independent", async () => {
    const { root, log } = await makeWorkspace();

    const env = (namespace: string, marker: string) => ({
      RUNNER_ID: "same-id",
      NAMESPACE: namespace,
      DRIVER_ROOT: root,
      HANDLER_FILE: HANDLER,
      RUN_LOG: log,
      MARKER: marker,
    });

    const [first, second] = await Promise.all([
      runBun<{ event: string; outcome?: { outcome: string } }>(
        INSTANCE,
        env(testNamespace("alpha"), "alpha"),
      ),
      runBun<{ event: string; outcome?: { outcome: string } }>(
        INSTANCE,
        env(testNamespace("beta"), "beta"),
      ),
    ]);

    // Different namespaces are different runners, however alike their ids.
    for (const result of [first, second]) {
      expect(
        result.lines.find((line) => line.event === "trigger")?.outcome?.outcome,
      ).toBe("started");
    }
    expect(await runCount(log)).toHaveLength(2);
  }, 30_000);
});
