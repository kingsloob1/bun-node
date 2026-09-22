/* eslint-disable no-console -- the console is what this file exercises: capture patches it. */
import type { BunRunnerOptions, RunContext, RunRecord } from "../lib/index";
import type { ConsoleSink } from "../lib/runner/consolePatch";
import type { ExecutorStartOptions } from "../lib/runner/executors/executor";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  BunRunner,
  InProcessExecutor,
  MemoryDriver,
  runnerKey,
} from "../lib/index";
import {
  consoleCaptureHolds,
  isConsoleCaptureInstalled,
} from "../lib/runner/consoleCapture";
import { patchConsole } from "../lib/runner/consolePatch";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * In-process runs keep one console patch for the runner's lifetime (fix round
 * A5).
 *
 * The patch used to be installed and removed around every run — five console
 * methods rewritten twice per run. Now the executor's first capturing run
 * installs it and `stop()` (or the executor being replaced) removes it;
 * between runs it passes through, since no async context carries a sink.
 */

let dir: { path: string; cleanup: () => Promise<void> };
/** Logs one line; waits first on the global promise named by `args.gate`, if any. */
let talker: string;

beforeAll(async () => {
  dir = await makeTmpDir("fix-runner-inprocess");
  talker = join(dir.path, "talker.ts");
  await Bun.write(
    talker,
    `export default async function handler(ctx) {
      const gate = ctx.args?.gate;
      if (gate) await globalThis[gate];
      console.log("line", ctx.args?.tag ?? "");
      return 1;
    }\n`,
  );
});

afterAll(async () => {
  await dir.cleanup();
});

const started: BunRunner<any, any>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    started.splice(0).map((r) => r.stop({ force: true })),
  );
});

/** An in-process runner over `driver` running the talker. */
function makeRunner(
  id: string,
  driver = new MemoryDriver(),
  extra: Partial<BunRunnerOptions<any>> = {},
): BunRunner<any, any> {
  const runner = new BunRunner({
    id,
    namespace: testNamespace("inproc"),
    file: talker,
    executionMode: "in-process",
    waitToExit: false,
    logger: noopLogger,
    syncInterval: 0,
    driver,
    ...extra,
  } as BunRunnerOptions<any>);
  started.push(runner);
  return runner;
}

/** Triggers one run and resolves its settled record. */
async function runOnce(
  runner: BunRunner<any, any>,
  args?: Record<string, unknown>,
): Promise<RunRecord> {
  const settled = new Promise<RunRecord>((resolve) => {
    runner.once("finished", resolve);
    runner.once("failed", resolve);
  });
  await runner.trigger(args === undefined ? undefined : { args });
  return await settled;
}

describe("in-process console patch lifetime", () => {
  it("stays installed between runs, the same patch, and is removed on stop", async () => {
    // Holds, not global state: another file's live runner may hold one too.
    const holds = consoleCaptureHolds();
    const runner = makeRunner("lifetime");
    await runner.start();

    expect((await runOnce(runner, { tag: "1" })).status).toBe("success");
    expect(consoleCaptureHolds()).toBe(holds + 1);
    const patched = console.log;

    expect((await runOnce(runner, { tag: "2" })).status).toBe("success");
    // Not re-installed, and no second hold: the very same wrapper.
    expect(consoleCaptureHolds()).toBe(holds + 1);
    expect(console.log).toBe(patched);

    await runner.stop();
    expect(consoleCaptureHolds()).toBe(holds);
  });

  it("passes output from outside any run through unchanged, and captures none of it", async () => {
    // What reaches the console: the patch forwards the exact call to what was
    // beneath it when there is no current sink. Checked on a patch of its own
    // over a spy, so it does not depend on what else holds the real console.
    const saved = console.warn;
    const printed: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      printed.push(args);
    };
    const hostObject = { host: true, nested: { n: 1 } };
    const sunk: string[] = [];
    let sink: ConsoleSink | undefined;
    const unpatch = patchConsole(() => sink);
    try {
      console.warn("HOST idle", hostObject);
      sink = (_stream, text) => sunk.push(text);
      console.warn("RUN line");
      sink = undefined;
    } finally {
      unpatch();
      console.warn = saved;
    }
    expect(printed).toEqual([["HOST idle", hostObject], ["RUN line"]]);
    expect(printed[0]![1]).toBe(hostObject);
    expect(sunk).toEqual(["RUN line\n"]);

    // What is captured, through a real runner whose patch stays installed:
    // host calls while it is idle and during a run are in no run's log.
    const gate = `__fixRunnerGate_${crypto.randomUUID().replaceAll("-", "")}`;
    let open!: () => void;
    (globalThis as Record<string, unknown>)[gate] = new Promise<void>(
      (resolve) => {
        open = resolve;
      },
    );
    try {
      const runner = makeRunner("outside");
      await runner.start();
      const first = await runOnce(runner, { tag: "x" });
      expect(isConsoleCaptureInstalled()).toBe(true);

      // Idle: the runner is alive, the patch installed, no run live.
      console.log("HOST idle (expected in test output)");

      // During a run, from code outside that run's async context.
      const settled = new Promise<RunRecord>((resolve) => {
        runner.once("finished", resolve);
        runner.once("failed", resolve);
      });
      await runner.trigger({ args: { tag: "y", gate } });
      await Bun.sleep(20);
      console.log("HOST during a run (expected in test output)");
      open();
      const second = await settled;
      await runner.stop();

      const driver = runner.driver as MemoryDriver;
      for (const [record, line] of [
        [first, "line x"],
        [second, "line y"],
      ] as const) {
        const page = await driver.getRunLog(
          runner.namespace,
          runnerKey(runner.id),
          record.runId,
          { offset: 0, limit: 100, order: "asc" },
        );
        expect(page.lines.map((entry) => entry.text)).toEqual([line]);
      }
    } finally {
      delete (globalThis as Record<string, unknown>)[gate];
    }
  });

  it("is held while any runner still needs it", async () => {
    const holds = consoleCaptureHolds();
    const a = makeRunner("hold-a");
    const b = makeRunner("hold-b");
    await a.start();
    await b.start();
    await runOnce(a);
    await runOnce(b);
    expect(consoleCaptureHolds()).toBe(holds + 2);

    await a.stop();
    expect(consoleCaptureHolds()).toBe(holds + 1);
    expect(isConsoleCaptureInstalled()).toBe(true);
    await b.stop();
    expect(consoleCaptureHolds()).toBe(holds);
  });

  it("is released by close() only once the live capturing run settles", async () => {
    const holds = consoleCaptureHolds();
    const executor = new InProcessExecutor();
    const gate = `__fixRunnerGate_${crypto.randomUUID().replaceAll("-", "")}`;
    let open!: () => void;
    (globalThis as Record<string, unknown>)[gate] = new Promise<void>(
      (resolve) => {
        open = resolve;
      },
    );
    const seen: string[] = [];
    const options = {
      context: {
        runId: "r1",
        args: { gate, tag: "live" },
      } as unknown as RunContext,
      file: talker,
      timeout: 0,
      closeTimeout: 1000,
      killTimeout: 1000,
      waitToExit: false,
      forwardLogs: false,
      captureConsole: true,
      events: {
        onProgress: () => {},
        onMessage: () => {},
        onLog: () => {},
        onOutput: () => {},
        onConsole: (_stream, text) => seen.push(text),
        onPid: () => {},
      },
    } satisfies ExecutorStartOptions;

    try {
      const handle = executor.start(options);
      executor.close();
      // Closed, but the run is live: it still owns the patch, and is captured.
      expect(consoleCaptureHolds()).toBe(holds + 1);
      open();
      const outcome = await handle.done;
      expect(outcome.status).toBe("success");
      expect(seen).toEqual(["line live\n"]);
      expect(consoleCaptureHolds()).toBe(holds);

      // A capturing run after close takes the hold again.
      const again = executor.start({
        ...options,
        context: {
          runId: "r2",
          args: { tag: "again" },
        } as unknown as RunContext,
      });
      await again.done;
      expect(consoleCaptureHolds()).toBe(holds + 1);
      executor.close();
      expect(consoleCaptureHolds()).toBe(holds);
    } finally {
      delete (globalThis as Record<string, unknown>)[gate];
    }
  });
});
