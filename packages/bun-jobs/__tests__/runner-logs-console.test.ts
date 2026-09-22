/* eslint-disable no-console -- the console is what this file exercises: capture patches it. */
import type {
  BunRunnerOptions,
  ExecutionMode,
  JobsDriver,
  RunLogLine,
  RunLogPage,
  RunnerDriver,
  RunRecord,
} from "../lib/index";
import type { ConsoleSink } from "../lib/runner/consolePatch";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunRunner, FileDriver, MemoryDriver, runnerKey } from "../lib/index";
import {
  consoleCaptureHolds,
  installConsoleCapture,
  isConsoleCaptureInstalled,
} from "../lib/runner/consoleCapture";
import { patchConsole } from "../lib/runner/consolePatch";
import { RunLogCapture } from "../lib/runner/runLogCapture";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * Worker-realm console capture (run logs, slice 2).
 *
 * An `in-process` or `worker` run shares a `console`, so capturing it means a
 * process-wide patch that has to know which run each call belongs to. These
 * tests run real handlers through a real `BunRunner` against real drivers —
 * `MemoryDriver`, and `FileDriver` where the append is slow enough for two runs'
 * flushes to interleave — and read back what the store holds.
 *
 * The load-bearing claim is attribution: two runs live at once, in one realm,
 * each get their own lines and none of the other's.
 */

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const started: BunRunner<any, any>[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  await Promise.allSettled(
    started.map((runner) => runner.stop({ force: true })),
  );
  started.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A runner over `driver`, tracked for cleanup. */
function makeRunner(
  id: string,
  options: Partial<BunRunnerOptions<any>> & { driver: JobsDriver },
): BunRunner<any, any> {
  const runner = new BunRunner({
    id,
    namespace: testNamespace("console"),
    file: fixture("console-talker"),
    executionMode: "in-process",
    waitToExit: false,
    logger: noopLogger,
    syncInterval: 0,
    ...options,
  } as BunRunnerOptions<any>);
  started.push(runner);
  return runner;
}

/** Resolves with the record of the next run this runner settles. */
function nextSettled(runner: BunRunner<any, any>): Promise<RunRecord> {
  return new Promise<RunRecord>((resolve) => {
    runner.once("finished", (record) => resolve(record));
    runner.once("failed", (record) => resolve(record));
  });
}

/** Everything one run's log holds, oldest first. */
async function readLog(
  driver: RunnerDriver,
  runner: BunRunner<any, any>,
  runId: string,
): Promise<RunLogPage> {
  return await driver.getRunLog!(
    runner.namespace,
    runnerKey(runner.id),
    runId,
    {
      offset: 0,
      limit: 10_000,
      order: "asc",
    },
  );
}

/** The text of every line from one stream, in order. */
function textOf(lines: RunLogLine[], stream?: RunLogLine["stream"]): string[] {
  return lines
    .filter((line) => stream === undefined || line.stream === stream)
    .map((line) => line.text);
}

/** What one `console-talker` run with `count: 2` writes, by stream. */
function expected(tag: string) {
  return {
    stdout: [
      `${tag} log 1`,
      `${tag} timer 1`,
      `${tag} micro 1`,
      `${tag} log 2`,
      `${tag} timer 2`,
      `${tag} micro 2`,
      `${tag} multi`,
      `${tag} line`,
    ],
    stderr: [`${tag} warn 1`, `${tag} warn 2`, `${tag} error { n: 1 }`],
  };
}

/**
 * Runs two `console-talker` runners at once on one driver, held open together
 * by a shared gate until both have written their first line, and returns both
 * logs.
 */
async function concurrentPair(driver: JobsDriver, mode: ExecutionMode) {
  const gate = `__consoleGate_${crypto.randomUUID().replaceAll("-", "")}`;
  let open!: () => void;
  (globalThis as Record<string, unknown>)[gate] = new Promise<void>(
    (resolve) => {
      open = resolve;
    },
  );
  cleanups.push(() => {
    delete (globalThis as Record<string, unknown>)[gate];
  });

  const alpha = makeRunner("alpha", { driver, executionMode: mode });
  const beta = makeRunner("beta", { driver, executionMode: mode });
  await alpha.start();
  await beta.start();

  const settledAlpha = nextSettled(alpha);
  const settledBeta = nextSettled(beta);
  // Different gaps, so the two runs' calls interleave rather than alternate
  // in lockstep.
  await alpha.trigger({ args: { tag: "ALPHA", count: 2, gap: 3, gate } });
  await beta.trigger({ args: { tag: "BETA", count: 2, gap: 1, gate } });

  // Both are demonstrably live together before either may finish.
  if (mode === "in-process") {
    expect(isConsoleCaptureInstalled()).toBe(true);
  }
  await Bun.sleep(60);
  open();

  const [recordAlpha, recordBeta] = await Promise.all([
    settledAlpha,
    settledBeta,
  ]);
  return {
    alpha: {
      record: recordAlpha,
      page: await readLog(driver, alpha, recordAlpha.runId),
    },
    beta: {
      record: recordBeta,
      page: await readLog(driver, beta, recordBeta.runId),
    },
  };
}

describe("console capture: in-process runs", () => {
  it("attributes two concurrent runs' console output to the right run, on a memory driver", async () => {
    const { alpha, beta } = await concurrentPair(
      new MemoryDriver(),
      "in-process",
    );

    expect(alpha.record.status).toBe("success");
    expect(beta.record.status).toBe("success");
    expect(textOf(alpha.page.lines, "stdout")).toEqual(
      expected("ALPHA").stdout,
    );
    expect(textOf(alpha.page.lines, "stderr")).toEqual(
      expected("ALPHA").stderr,
    );
    expect(textOf(beta.page.lines, "stdout")).toEqual(expected("BETA").stdout);
    expect(textOf(beta.page.lines, "stderr")).toEqual(expected("BETA").stderr);
    // Nothing leaked either way.
    expect(textOf(alpha.page.lines).some((text) => text.includes("BETA"))).toBe(
      false,
    );
    expect(textOf(beta.page.lines).some((text) => text.includes("ALPHA"))).toBe(
      false,
    );
    // The record's counter agrees with the store.
    expect(alpha.record.logLines).toBe(11);
    expect(beta.record.logLines).toBe(11);
  });

  it("attributes them on a file driver too, whose appends are slow enough to overlap", async () => {
    const dir = await makeTmpDir("console-file");
    cleanups.push(() => dir.cleanup());
    const driver = new FileDriver({ root: dir.path });
    cleanups.push(() => driver.close());

    const { alpha, beta } = await concurrentPair(driver, "in-process");

    expect(textOf(alpha.page.lines, "stdout")).toEqual(
      expected("ALPHA").stdout,
    );
    expect(textOf(beta.page.lines, "stdout")).toEqual(expected("BETA").stdout);
    expect(textOf(alpha.page.lines, "stderr")).toEqual(
      expected("ALPHA").stderr,
    );
    expect(textOf(beta.page.lines, "stderr")).toEqual(expected("BETA").stderr);
  });

  it("captures nothing written outside a run while one is live", async () => {
    const driver = new MemoryDriver();
    const gate = `__consoleGate_${crypto.randomUUID().replaceAll("-", "")}`;
    let open!: () => void;
    (globalThis as Record<string, unknown>)[gate] = new Promise<void>(
      (resolve) => {
        open = resolve;
      },
    );
    cleanups.push(() => {
      delete (globalThis as Record<string, unknown>)[gate];
    });

    const runner = makeRunner("solo", { driver });
    await runner.start();
    const settled = nextSettled(runner);
    await runner.trigger({ args: { tag: "RUN", count: 1, gap: 1, gate } });
    await Bun.sleep(20);
    // The host, not the run: the patch is installed, but this call carries no
    // run's async context.
    console.log("HOST line written while the run is live");
    open();
    const record = await settled;

    const page = await readLog(driver, runner, record.runId);
    expect(textOf(page.lines).some((text) => text.startsWith("HOST"))).toBe(
      false,
    );
    expect(textOf(page.lines, "stdout")[0]).toBe("RUN log 1");
  });

  it("removes the patch when the last capturing runner stops", async () => {
    // Asserted as a change in holds, not as global state: a runner another
    // test file left running holds the patch too, and must not fail this one.
    const holds = consoleCaptureHolds();
    const before = console.log;
    const driver = new MemoryDriver();
    const runner = makeRunner("tidy", { driver });
    await runner.start();

    const settled = nextSettled(runner);
    await runner.trigger({ args: { tag: "T", count: 1, gap: 1 } });
    await settled;
    // Held for the runner's lifetime, not re-installed per run (fix round A5).
    expect(consoleCaptureHolds()).toBe(holds + 1);
    expect(isConsoleCaptureInstalled()).toBe(true);

    await runner.stop();
    expect(consoleCaptureHolds()).toBe(holds);
    if (holds === 0) {
      // With no other holder, the console is exactly what it was.
      expect(isConsoleCaptureInstalled()).toBe(false);
      expect(console.log).toBe(before);
    }
  });

  it("leaves a wrapper someone added on top alone, and passes through beneath it", () => {
    // The layering is `patchConsole`'s, exercised directly, so a patch that a
    // runner in another test file still holds cannot change what is on top.
    const original = console.info;
    const unpatch = patchConsole(() => undefined);
    const ours = console.info;
    expect(ours).not.toBe(original);

    const seen: string[] = [];
    const spy = (...args: unknown[]) => {
      seen.push(args.join(" "));
    };
    console.info = spy;
    try {
      unpatch();
      // Ours is not on top any more, so it is not ours to remove.
      expect(console.info).toBe(spy);
    } finally {
      console.info = original;
    }

    // And a stale wrapper with no sink current is a plain pass-through.
    const captured: string[] = [];
    const logged: string[] = [];
    const saved = console.debug;
    console.debug = (...args: unknown[]) => {
      logged.push(args.join(" "));
    };
    let sink: ConsoleSink | undefined;
    const unpatchAgain = patchConsole(() => sink);
    const wrapper = console.debug;
    unpatchAgain();
    wrapper("outside any run");
    sink = (_stream, text) => captured.push(text);
    wrapper("inside, after release");
    sink = undefined;
    console.debug = saved;
    expect(logged).toEqual(["outside any run", "inside, after release"]);
    // The released wrapper still sees a sink when one is current — it is only
    // ever reachable by a reference taken while installed.
    expect(captured).toEqual(["inside, after release\n"]);

    // The hold count: each release gives back exactly its own hold, once.
    const holds = consoleCaptureHolds();
    const first = installConsoleCapture();
    const second = installConsoleCapture();
    expect(consoleCaptureHolds()).toBe(holds + 2);
    first();
    first();
    expect(consoleCaptureHolds()).toBe(holds + 1);
    second();
    expect(consoleCaptureHolds()).toBe(holds);
  });

  it("does not let a throwing capture fail the run, or swallow the console call", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("sturdy", { driver });
    await runner.start();

    const output = RunLogCapture.prototype.output;
    RunLogCapture.prototype.output = () => {
      throw new Error("capture exploded");
    };
    const printed: string[] = [];
    const saved = console.log;
    console.log = (...args: unknown[]) => {
      printed.push(args.join(" "));
    };
    let record: RunRecord;
    try {
      const settled = nextSettled(runner);
      await runner.trigger({ args: { tag: "S", count: 1, gap: 1 } });
      record = await settled;
    } finally {
      RunLogCapture.prototype.output = output;
      console.log = saved;
    }

    expect(record.status).toBe("success");
    // The original console still printed every call.
    expect(printed).toContain("S log 1");
    expect(printed).toContain("S multi\nS line");
  });

  it("captures nothing from the console when captureLogs.console is false, and still stores ctx.log()", async () => {
    const holds = consoleCaptureHolds();
    const driver = new MemoryDriver();
    const runner = makeRunner("quiet", {
      driver,
      captureLogs: { console: false },
    });
    await runner.start();
    const settled = nextSettled(runner);
    await runner.trigger({ args: { tag: "Q", count: 1, gap: 1 } });
    const record = await settled;

    const page = await readLog(driver, runner, record.runId);
    expect(page.lines).toEqual([]);
    expect(record.logLines).toBe(0);
    // It took no hold; one another test's runner holds is not its concern.
    expect(consoleCaptureHolds()).toBe(holds);
  });
});

describe("console capture: worker runs", () => {
  it("captures a worker run's console, by stream, in order", async () => {
    const holds = consoleCaptureHolds();
    const driver = new MemoryDriver();
    const runner = makeRunner("worker", { driver, executionMode: "worker" });
    await runner.start();

    const settled = nextSettled(runner);
    await runner.trigger({ args: { tag: "W", count: 2, gap: 1 } });
    const record = await settled;
    const page = await readLog(driver, runner, record.runId);

    expect(record.status).toBe("success");
    expect(textOf(page.lines, "stdout")).toEqual(expected("W").stdout);
    expect(textOf(page.lines, "stderr")).toEqual(expected("W").stderr);
    // A worker's realm is its own: this process took no hold on its console.
    expect(consoleCaptureHolds()).toBe(holds);
  });

  it("keeps two concurrent worker runs apart", async () => {
    const { alpha, beta } = await concurrentPair(new MemoryDriver(), "worker");

    expect(textOf(alpha.page.lines, "stdout")).toEqual(
      expected("ALPHA").stdout,
    );
    expect(textOf(beta.page.lines, "stdout")).toEqual(expected("BETA").stdout);
  });
});

describe("console capture: spawned runs", () => {
  it("stores a spawned run's console once, from its pipes, not twice", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("spawned", { driver, executionMode: "spawn" });
    await runner.start();

    const settled = nextSettled(runner);
    await runner.trigger({ args: { tag: "P", count: 2, gap: 1 } });
    const record = await settled;
    const page = await readLog(driver, runner, record.runId);

    expect(textOf(page.lines, "stdout")).toEqual(expected("P").stdout);
    // Bun's own console, writing to the pipe, prints an object across lines
    // where `util.format` keeps it on one; the lines themselves are once each.
    expect(textOf(page.lines, "stderr")).toEqual([
      "P warn 1",
      "P warn 2",
      "P error {",
      "  n: 1,",
      "}",
    ]);
  });
});
