import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { createDriver, runnerKey } from "../lib/index";
import { makeTmpDir, testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { runBun } from "./helpers/spawnBun";

/** One JSON line a runner process prints. */
interface Line {
  /** Which report this is. */
  event: string;
  /** What a trigger decided, on a `trigger` line. */
  outcome?: { outcome: string; reason?: string; position?: number };
  /** The runner's counters, on a `done` line. */
  stats?: { success?: number };
  /** How many triggers were still queued, on a `done` line. */
  queued?: number;
  /**
   * Runs that finished in that very process, on a `done` line — unlike
   * `stats`, whose counters the driver shares across every process.
   */
  localRuns?: number;
}

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

/**
 * Namespace purges, run before `cleanups`: the file and sqlite backends keep
 * their data in a temp directory that a cleanup removes.
 */
const purges: (() => Promise<void>)[] = [];

/** Shared with the queue suite, so neither can cover a backend the other misses. */
const READY = await crossProcessBackends({ cleanups });

afterAll(async () => {
  await Promise.allSettled(purges.map((purge) => purge()));
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

/**
 * A temp directory, the run log both processes append to, and the directory
 * each process marks once its trigger has decided.
 */
async function makeWorkspace(): Promise<{
  root: string;
  log: string;
  decided: string;
}> {
  const tmp = await makeTmpDir("bun-jobs-xproc");
  cleanups.push(tmp.cleanup);

  const log = join(tmp.path, "runs.log");
  await writeFile(log, "");

  const decided = join(tmp.path, "decided");
  await mkdir(decided);

  return { root: join(tmp.path, "driver"), log, decided };
}

/**
 * Holds the winner's run open until both processes have decided.
 *
 * "Both trigger at once" used to mean both were spawned at once, and the
 * winner's run lasted a fixed time. On a loaded machine the second process
 * sometimes started after that run had ended and released the lock, took the
 * free lock, and ran — correctly, one run after the other — and the test
 * counted two runs as two processes running at once. With the hold, the
 * loser always decides while the lock is held, so two runs here can only
 * mean two holders.
 */
function holdForBoth(decided: string): Record<string, string> {
  return { DECIDED_DIR: decided, PARTICIPANTS: "2" };
}

/**
 * The environments of a holder and a latecomer, ordered by handshake.
 *
 * The latecomer used to be spawned 400 ms after the holder, whose run lasted
 * 1,200 ms, and the holder stayed a fixed time afterwards to drain — three
 * bets on timing, each lost on a loaded machine the way "both trigger at
 * once" lost its own. Now each waits for the state it needs:
 * - the latecomer triggers only after the holder has decided (`started`);
 * - the holder's run is held until the latecomer has decided too;
 * - the holder stays until it has itself finished both runs.
 */
function holderAndLatecomer(decided: string): {
  holder: Record<string, string>;
  latecomer: Record<string, string>;
} {
  return {
    holder: { ...holdForBoth(decided), AWAIT_RUNS: "2" },
    latecomer: { ...holdForBoth(decided), AWAIT_DECIDED: "1" },
  };
}

/** How many runs the handler recorded. */
async function runCount(log: string): Promise<string[]> {
  const contents = await readFile(log, "utf8");
  return contents.split("\n").filter(Boolean);
}

describe("runner across processes", () => {
  it("runs in exactly one process when both trigger at once", async () => {
    const { root, log, decided } = await makeWorkspace();
    const namespace = testNamespace();

    const env = (marker: string) => ({
      RUNNER_ID: "cleanup",
      NAMESPACE: namespace,
      DRIVER_ROOT: root,
      HANDLER_FILE: HANDLER,
      RUN_LOG: log,
      MARKER: marker,
      ...holdForBoth(decided),
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
    const { root, log, decided } = await makeWorkspace();
    const namespace = testNamespace();
    const roles = holderAndLatecomer(decided);

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

    // The second process arrives while the lock is genuinely held, and the
    // holder stays alive until it has run what that process queued — each by
    // handshake (see `holderAndLatecomer`), not by timing.
    const holder = runBun<Line>(INSTANCE, env("holder", roles.holder));
    const other = await runBun<Line>(INSTANCE, env("other", roles.latecomer));

    const queued = other.lines.find((line) => line.event === "trigger");
    expect(queued?.outcome?.outcome).toBe("queued");

    const holderResult = await holder;
    expect(holderResult.exitCode).toBe(0);

    const holderDone = holderResult.lines.find((line) => line.event === "done");
    const otherDone = other.lines.find((line) => line.event === "done");

    // Two runs happened, and both executed in the holder's process — the one
    // that owns the lock is the one that does the work. `stats` is the
    // cluster's count, so `localRuns` is what says *where* they ran.
    expect(await runCount(log)).toHaveLength(2);
    expect(holderDone?.stats?.success).toBe(2);
    expect(otherDone?.stats?.success).toBe(0);
    expect(holderDone?.localRuns).toBe(2);
    expect(otherDone?.localRuns).toBe(0);

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

/**
 * The same guarantee, on every backend that claims to support it.
 *
 * The mechanisms could hardly differ more — an exclusive file create, a
 * conditional `UPDATE`, a conditional document update — so asserting the
 * behaviour once per backend is the only way to know they agree. The tests
 * above cover the file driver in more depth; these cover breadth.
 */
for (const { name: backendName, config, available } of READY) {
  describe.skipIf(!available)(`runner across processes: ${backendName}`, () => {
    /** The environment two competing runner processes share. */
    async function setup(options: { queueRuns?: boolean } = {}): Promise<{
      env: (
        marker: string,
        extra?: Record<string, string>,
      ) => Record<string, string>;
      log: string;
      namespace: string;
      decided: string;
    }> {
      const { log, decided } = await makeWorkspace();
      const namespace = testNamespace(backendName);

      // Everything the runner processes wrote under this namespace — lock,
      // state, history, metrics — goes when the file does. By then each
      // process has exited, so every runner has stopped and flushed what it
      // buffered: nothing can write the namespace back after the purge.
      purges.push(async () => {
        const janitor = createDriver(config);
        await janitor.connect();
        try {
          await janitor.purge(namespace);
        } finally {
          await janitor.close();
        }
      });

      return {
        log,
        namespace,
        decided,
        env: (marker, extra = {}) => ({
          RUNNER_ID: "cleanup",
          NAMESPACE: namespace,
          DRIVER_CONFIG: JSON.stringify(config),
          HANDLER_FILE: HANDLER,
          RUN_LOG: log,
          MARKER: marker,
          ...(options.queueRuns ? { QUEUE_RUNS: "1" } : {}),
          ...extra,
        }),
      };
    }

    it("runs in exactly one process when both trigger at once", async () => {
      const { env, log, decided } = await setup();

      const [first, second] = await Promise.all([
        runBun<Line>(INSTANCE, env("a", holdForBoth(decided))),
        runBun<Line>(INSTANCE, env("b", holdForBoth(decided))),
      ]);

      // Stderr is part of the assertion: a process that dies should say why
      // in the failure, not send the reader hunting for it.
      expect([first.exitCode, first.stderr]).toEqual([0, ""]);
      expect([second.exitCode, second.stderr]).toEqual([0, ""]);

      const outcomes = [first, second].map((result) => {
        const trigger = result.lines.find((line) => line.event === "trigger");
        return trigger?.outcome?.outcome;
      });

      expect(outcomes.filter((outcome) => outcome === "started")).toHaveLength(
        1,
      );
      expect(outcomes.filter((outcome) => outcome === "skipped")).toHaveLength(
        1,
      );
      expect(await runCount(log)).toHaveLength(1);
    }, 60_000);

    it("queues the loser's demand, and the lock holder drains it", async () => {
      const { env, log, decided } = await setup({ queueRuns: true });
      const roles = holderAndLatecomer(decided);

      const holder = runBun<Line>(INSTANCE, env("holder", roles.holder));
      const other = await runBun<Line>(INSTANCE, env("other", roles.latecomer));

      expect(
        other.lines.find((line) => line.event === "trigger")?.outcome?.outcome,
      ).toBe("queued");

      const holderResult = await holder;
      const holderDone = holderResult.lines.find(
        (line) => line.event === "done",
      );

      // Both runs happened, and both in the process that held the lock.
      expect(await runCount(log)).toHaveLength(2);
      expect(holderDone?.stats?.success).toBe(2);
      expect(holderDone?.queued).toBe(0);
      expect(holderDone?.localRuns).toBe(2);
      expect(other.lines.find((line) => line.event === "done")?.localRuns).toBe(
        0,
      );
    }, 60_000);

    it("lets another process take over a lock left by a crash", async () => {
      const { env, log, namespace } = await setup();

      // Plant a lock that expired long ago, as a killed process would leave.
      const driver = createDriver(config);
      await driver.connect();
      await driver.acquireLock(
        namespace,
        runnerKey("cleanup"),
        "ghost:999999:dead",
        1,
        Date.now() - 60_000,
      );
      await driver.close();

      const result = await runBun<Line>(INSTANCE, env("taker"));

      expect(result.exitCode).toBe(0);
      expect(
        result.lines.find((line) => line.event === "trigger")?.outcome?.outcome,
      ).toBe("started");
      expect(await runCount(log)).toHaveLength(1);
    }, 60_000);
  });
}
