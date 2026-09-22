import type {
  BunRunnerOptions,
  JobsDriver,
  RunLogPage,
  RunnerDriver,
  RunRecord,
} from "../lib/index";
import type { RunnerDriverEvent } from "../lib/shared/events";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunRunner,
  DEFAULT_RUN_LOG_MAX_LINE_BYTES,
  FileDriver,
  MemoryDriver,
  RUN_LOG_HINT_MS,
  runnerKey,
} from "../lib/index";
import { RunLogCapture } from "../lib/runner/runLogCapture";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * The `logs` hint: a runner event announcing that a run's stored log grew, so
 * a tail subscribed to `runner/{runner}` can re-read with `?since=` instead of
 * polling blind.
 *
 * Three things are asserted, each against a real driver's event stream:
 * - the hint carries the run and the store's newest `lastSeq`, and the last
 *   one a run sends equals what the store reports;
 * - it is throttled to one per `RUN_LOG_HINT_MS` per run, however fast the
 *   log grows;
 * - it carries **no log content** — the payload is exactly `{ runId,
 *   lastSeq }`, and no line's text appears anywhere in the event.
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

/** A publishing runner over `driver`, tracked for cleanup. */
function makeRunner(
  handler: string,
  options: Partial<BunRunnerOptions<any>> & { driver: JobsDriver },
): BunRunner<any, any> {
  const runner = new BunRunner({
    id: "hinted",
    namespace: testNamespace("hint"),
    file: fixture(handler),
    executionMode: "in-process",
    waitToExit: false,
    logger: noopLogger,
    syncInterval: 0,
    publish: true,
    ...options,
  } as BunRunnerOptions<any>);
  started.push(runner);
  return runner;
}

/** Every runner event the driver delivers for `runner`, with arrival times. */
async function record(
  driver: JobsDriver,
  runner: BunRunner<any, any>,
): Promise<{ event: RunnerDriverEvent; at: number }[]> {
  const seen: { event: RunnerDriverEvent; at: number }[] = [];
  const unsubscribe = await driver.subscribe(
    runner.namespace,
    "runner",
    runner.id,
    (event) => {
      seen.push({ event, at: Date.now() });
    },
  );
  cleanups.push(() => unsubscribe());
  return seen;
}

/** Only the `logs` hints, in arrival order. */
function hintsOf(seen: { event: RunnerDriverEvent; at: number }[]) {
  return seen.filter(
    (
      entry,
    ): entry is {
      event: Extract<RunnerDriverEvent, { type: "logs" }>;
      at: number;
    } => entry.event.type === "logs",
  );
}

/** Triggers one run and resolves with its record once it has settled. */
async function runOnce(
  runner: BunRunner<any, any>,
  args?: unknown,
): Promise<RunRecord> {
  const settled = new Promise<RunRecord>((resolve) => {
    runner.once("finished", (entry) => resolve(entry));
    runner.once("failed", (entry) => resolve(entry));
  });
  await runner.start();
  await runner.trigger({ args });
  return await settled;
}

/** Everything one run's log holds. */
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

/** Waits until `check` holds, or fails after `ms`. */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await Bun.sleep(5);
  }
}

describe("the logs hint: what it carries", () => {
  it("announces the run and its lastSeq, ending on exactly what the store holds", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("drip", { driver });
    const seen = await record(driver, runner);

    const run = await runOnce(runner, { count: 12, gap: 40, text: "drip" });
    await until(() =>
      hintsOf(seen).some((entry) => entry.event.payload.lastSeq === 12),
    );

    const hints = hintsOf(seen);
    const page = await readLog(driver, runner, run.runId);
    expect(page.lastSeq).toBe(12);
    expect(hints.length).toBeGreaterThan(0);
    for (const { event } of hints) {
      expect(event.kind).toBe("runner");
      expect(event.target).toBe(runner.id);
      expect(event.id).toBe(run.runId);
      expect(event.payload.runId).toBe(run.runId);
    }
    // Strictly increasing, and the last one is the store's own figure.
    const seqs = hints.map(({ event }) => event.payload.lastSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.at(-1)).toBe(page.lastSeq);
  });

  it("carries no log content: the payload is the run and a number, nothing else", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("drip", { driver });
    const seen = await record(driver, runner);
    const marker = `CONTENT-MARKER-${crypto.randomUUID()}`;

    await runOnce(runner, { count: 5, gap: 5, text: marker });
    await until(() => hintsOf(seen).length > 0);

    for (const { event } of hintsOf(seen)) {
      expect(Object.keys(event.payload).sort()).toEqual(["lastSeq", "runId"]);
      expect(typeof event.payload.lastSeq).toBe("number");
      expect(JSON.stringify(event)).not.toContain(marker);
      expect(JSON.stringify(event)).not.toContain("CONTENT-MARKER");
    }
  });

  it("is not published by a runner that does not publish", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("drip", { driver, publish: false });
    const seen = await record(driver, runner);

    await runOnce(runner, { count: 5, gap: 5 });
    await Bun.sleep(RUN_LOG_HINT_MS + 100);

    expect(hintsOf(seen)).toEqual([]);
  });

  it("reaches a subscriber on a file driver, whose events travel through the filesystem", async () => {
    const dir = await makeTmpDir("hint-file");
    cleanups.push(() => dir.cleanup());
    const driver = new FileDriver({ root: dir.path });
    cleanups.push(() => driver.close());
    const runner = makeRunner("drip", { driver });
    const seen = await record(driver, runner);

    const run = await runOnce(runner, { count: 4, gap: 5 });
    await until(
      () => hintsOf(seen).some((entry) => entry.event.payload.lastSeq === 4),
      5000,
    );
    expect(hintsOf(seen).at(-1)!.event.payload).toEqual({
      runId: run.runId,
      lastSeq: 4,
    });
  });
});

describe("the logs hint: the throttle", () => {
  it("sends at most one per window while a log grows steadily, plus the final one", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("drip", { driver });
    const seen = await record(driver, runner);

    // ~1.5 s of a line every 15 ms: capture flushes on its own 250 ms timer,
    // six times or so; the hint may go out at most once per 500 ms of that.
    const begun = Date.now();
    const run = await runOnce(runner, { count: 100, gap: 15 });
    const elapsed = Date.now() - begun;
    await until(() =>
      hintsOf(seen).some((entry) => entry.event.payload.lastSeq === 100),
    );

    const hints = hintsOf(seen);
    // One leading hint per window, and the one `close()` sends at settle.
    expect(hints.length).toBeLessThanOrEqual(
      Math.ceil(elapsed / RUN_LOG_HINT_MS) + 2,
    );
    expect(hints.length).toBeGreaterThanOrEqual(2);
    // Every hint but the settle one is at least a window after the previous.
    // (A little slack for delivery jitter; the timer itself is exact.)
    for (let index = 1; index < hints.length - 1; index++) {
      expect(hints[index]!.at - hints[index - 1]!.at).toBeGreaterThanOrEqual(
        RUN_LOG_HINT_MS - 50,
      );
    }
    expect(hints.at(-1)!.event.payload.lastSeq).toBe(100);
    expect(run.logLines).toBe(100);
  });

  it("collapses a burst of flushes into one leading and one trailing hint", async () => {
    const driver = new MemoryDriver();
    const hints: number[] = [];
    const capture = new RunLogCapture({
      driver,
      namespace: testNamespace("hint"),
      key: runnerKey("unit"),
      runId: "run-burst",
      caps: { maxLines: 0, maxBytes: 0, keepRuns: 10 },
      options: {
        enabled: true,
        maxLines: 0,
        maxBytes: 0,
        maxLineBytes: DEFAULT_RUN_LOG_MAX_LINE_BYTES,
        captureBytes: 0,
        console: false,
        redact: null,
      },
      logger: noopLogger,
      hint: (lastSeq) => hints.push(lastSeq),
    });

    // Ten flushes back to back, well inside one window.
    for (let batch = 1; batch <= 10; batch++) {
      capture.line(`line ${batch}`);
      await capture.flush();
    }
    expect(hints).toEqual([1]);

    // The trailing hint arrives once the window is up, with the newest value.
    await until(() => hints.length === 2, RUN_LOG_HINT_MS * 3);
    expect(hints).toEqual([1, 10]);

    // Nothing new, nothing announced — close adds no duplicate.
    await capture.close();
    expect(hints).toEqual([1, 10]);
  });

  it("announces the last lastSeq at close without waiting out the window", async () => {
    const hints: number[] = [];
    const capture = new RunLogCapture({
      driver: new MemoryDriver(),
      namespace: testNamespace("hint"),
      key: runnerKey("unit"),
      runId: "run-close",
      caps: { maxLines: 0, maxBytes: 0, keepRuns: 10 },
      options: {
        enabled: true,
        maxLines: 0,
        maxBytes: 0,
        maxLineBytes: DEFAULT_RUN_LOG_MAX_LINE_BYTES,
        captureBytes: 0,
        console: false,
        redact: null,
      },
      logger: noopLogger,
      hint: (lastSeq) => hints.push(lastSeq),
    });

    capture.line("first");
    await capture.flush();
    capture.line("second");
    capture.line("third");
    const begun = Date.now();
    await capture.close();

    expect(hints).toEqual([1, 3]);
    expect(Date.now() - begun).toBeLessThan(RUN_LOG_HINT_MS);
  });

  it("sends a trailing hint still waiting on the window at close, with nothing new to flush", async () => {
    const hints: number[] = [];
    const capture = new RunLogCapture({
      driver: new MemoryDriver(),
      namespace: testNamespace("hint"),
      key: runnerKey("unit"),
      runId: "run-trailing",
      caps: { maxLines: 0, maxBytes: 0, keepRuns: 10 },
      options: {
        enabled: true,
        maxLines: 0,
        maxBytes: 0,
        maxLineBytes: DEFAULT_RUN_LOG_MAX_LINE_BYTES,
        captureBytes: 0,
        console: false,
        redact: null,
      },
      logger: noopLogger,
      hint: (lastSeq) => hints.push(lastSeq),
    });

    capture.line("first");
    await capture.flush();
    capture.line("second");
    // Stored, but inside the window: its hint is waiting on the timer.
    await capture.flush();
    expect(hints).toEqual([1]);

    // Nothing is buffered, so close appends nothing — it is close itself that
    // must send the waiting hint rather than leave it to the timer.
    const begun = Date.now();
    await capture.close();
    expect(hints).toEqual([1, 2]);
    expect(Date.now() - begun).toBeLessThan(RUN_LOG_HINT_MS);

    // And the timer it replaced does not send it a second time.
    await Bun.sleep(RUN_LOG_HINT_MS + 50);
    expect(hints).toEqual([1, 2]);
  });

  it("never lets a throwing hint cost a line or the run", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("hint");
    const capture = new RunLogCapture({
      driver,
      namespace,
      key: runnerKey("unit"),
      runId: "run-throws",
      caps: { maxLines: 0, maxBytes: 0, keepRuns: 10 },
      options: {
        enabled: true,
        maxLines: 0,
        maxBytes: 0,
        maxLineBytes: DEFAULT_RUN_LOG_MAX_LINE_BYTES,
        captureBytes: 0,
        console: false,
        redact: null,
      },
      logger: noopLogger,
      hint: () => {
        throw new Error("subscriber exploded");
      },
    });

    capture.line("one");
    await capture.flush();
    capture.line("two");
    const totals = await capture.close();

    expect(totals.count).toBe(2);
    const page = await driver.getRunLog!(
      namespace,
      runnerKey("unit"),
      "run-throws",
      { offset: 0, limit: 10, order: "asc" },
    );
    expect(page.lines.map((line) => line.text)).toEqual(["one", "two"]);
  });
});
