import type {
  BunRunnerOptions,
  ExecutionMode,
  RunLogLine,
  RunLogPage,
  RunnerDriver,
  RunRecord,
} from "../lib/index";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunRunner,
  DEFAULT_RUN_LOG_MAX_LINE_BYTES,
  FileDriver,
  MemoryDriver,
  RUN_LOG_FLUSH_LINES,
  RunLogCapture,
  runnerKey,
} from "../lib/index";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * Runner-side run-log capture.
 *
 * Everything here runs against a real driver — `MemoryDriver` and, where the
 * append has to be slow enough to race, `FileDriver` — because the behaviour
 * being asserted is the agreement between capture and the store: capture hands
 * over lines, the store numbers them, and the two have to end up describing the
 * same log. A stub that recorded calls would assert only that capture called
 * something.
 *
 * The rule the whole file exists for: **capture never changes a run's
 * outcome.** A store that throws, a driver that cannot store logs at all and a
 * run past its capture ceiling each drop lines quietly and let the run finish.
 */

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const started: BunRunner<any, any>[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.allSettled(
    started.map((runner) => runner.stop({ force: true })),
  );
  started.length = 0;
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  cleanups.length = 0;
});

/** A runner over `driver`, tracked for cleanup. */
function makeRunner(
  handler: string,
  options: Partial<BunRunnerOptions<any>> = {},
): BunRunner<any, any> {
  const runner = new BunRunner({
    id: "logs",
    namespace: testNamespace(),
    file: fixture(handler),
    executionMode: "in-process",
    driver: new MemoryDriver(),
    waitToExit: false,
    logger: noopLogger,
    ...options,
  } as BunRunnerOptions<any>);

  started.push(runner);
  return runner;
}

/** Runs one trigger to completion and reports the record it wrote. */
async function runOnce(
  runner: BunRunner<any, any>,
  args?: unknown,
): Promise<RunRecord> {
  const settled = new Promise<RunRecord>((resolve) => {
    runner.once("finished", (record) => resolve(record));
    runner.once("failed", (record) => resolve(record));
  });

  await runner.start();
  await runner.trigger({ args });
  return await settled;
}

/** Everything one run's log holds, oldest first. */
async function readLog(
  driver: RunnerDriver,
  namespace: string,
  runId: string,
  id = "logs",
): Promise<RunLogPage> {
  return await driver.getRunLog!(namespace, runnerKey(id), runId, {
    offset: 0,
    limit: 10_000,
    order: "asc",
  });
}

/** The text of every line from one stream, in order. */
function textOf(lines: RunLogLine[], stream?: RunLogLine["stream"]): string[] {
  return lines
    .filter((line) => stream === undefined || line.stream === stream)
    .map((line) => line.text);
}

describe("run-log capture: the spawned realms", () => {
  it("captures a child's stdout and stderr as lines, tagged and in order", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("chatty", { driver, executionMode: "spawn" });

    const record = await runOnce(runner, { out: 3, err: 2 });
    const page = await readLog(driver, runner.namespace, record.runId);

    expect(record.status).toBe("success");
    expect(textOf(page.lines, "stdout")).toEqual(["out 1", "out 2", "out 3"]);
    expect(textOf(page.lines, "stderr")).toEqual(["err 1", "err 2"]);
    // Every line is numbered by the store, 1-based and gapless.
    expect(page.lines.map((line) => line.seq)).toEqual(
      page.lines.map((_line, index) => index + 1),
    );
    expect(page.dropped).toBe(0);
  });

  it("stores a trailing chunk with no newline as an ordinary line", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("chatty", { driver, executionMode: "spawn" });

    const record = await runOnce(runner, { out: 1, tail: "no newline here" });
    const page = await readLog(driver, runner.namespace, record.runId);

    expect(textOf(page.lines, "stdout")).toEqual(["out 1", "no newline here"]);
    // Deliberately no `partial` flag: the reader is not told the difference,
    // because at end of stream there is none.
    expect(page.lines.every((line) => line.truncated === undefined)).toBe(true);
  });

  it("cuts an over-long line on a UTF-8 boundary and marks it truncated", async () => {
    const driver = new MemoryDriver();
    // The real cap's shape at a size the test can print: a piped stream is
    // written through to this process's own stdout as well as captured, so
    // asserting the 8 KiB default would put 8 KiB of it in the test output.
    // 64 is not a multiple of 3, so the cut still lands mid-character unless
    // capture walks back over the continuation bytes.
    const runner = makeRunner("wide", {
      driver,
      executionMode: "spawn",
      captureLogs: { maxLineBytes: 64 },
    });

    const record = await runOnce(runner, { char: "あ", count: 100 });
    const page = await readLog(driver, runner.namespace, record.runId);

    const line = page.lines[0]!;
    expect(line.truncated).toBe(true);
    expect(line.text).not.toContain("�");
    // 63 bytes, not 64: the 22nd character would have straddled the cap, and a
    // byte-exact cut would have decoded to a replacement character.
    expect(Buffer.byteLength(line.text, "utf8")).toBe(63);
    expect(line.text).toBe("あ".repeat(line.text.length));
    // One truncated line, not one per chunk the pipe delivered.
    expect(page.lines).toHaveLength(1);
  });

  it("captures ctx.log() from every realm, with and without a level", async () => {
    for (const mode of ["in-process", "worker", "spawn"] as ExecutionMode[]) {
      const driver = new MemoryDriver();
      const runner = makeRunner("talker", { driver, executionMode: mode });

      const record = await runOnce(runner, { flush: true });
      const page = await readLog(driver, runner.namespace, record.runId);
      const logs = page.lines.filter((line) => line.stream === "log");

      expect(logs.map((line) => [line.text, line.level])).toEqual([
        ["plain", mode === "in-process" ? undefined : "info"],
        ["levelled", "warn"],
        ["with fields count=3 ok=true", "debug"],
      ]);
    }
  });
});

describe("run-log capture: the caps", () => {
  it("drops the oldest lines past maxLines and reports how many", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("log-many", {
      driver,
      captureLogs: { maxLines: 5 },
    });

    const record = await runOnce(runner, { count: 20 });
    const page = await readLog(driver, runner.namespace, record.runId);

    expect(textOf(page.lines)).toEqual([
      "line 16",
      "line 17",
      "line 18",
      "line 19",
      "line 20",
    ]);
    expect(page.count).toBe(5);
    expect(page.dropped).toBe(15);
    expect(record.logLines).toBe(5);
    expect(record.logsDropped).toBe(15);
  });

  it("counts maxBytes in UTF-8 bytes, not characters", async () => {
    const driver = new MemoryDriver();
    // "あ 1" is 3 + 1 + 1 = 5 bytes; 16 bytes therefore keeps three lines,
    // where counting characters would have kept five.
    const runner = makeRunner("log-many", {
      driver,
      captureLogs: { maxBytes: 16 },
    });

    const record = await runOnce(runner, { count: 6, text: "あ" });
    const page = await readLog(driver, runner.namespace, record.runId);

    expect(textOf(page.lines)).toEqual(["あ 4", "あ 5", "あ 6"]);
    expect(record.logsDropped).toBe(3);
  });

  it("stops at the capture ceiling and says so in the log itself", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("log-many", {
      driver,
      // "line N" is 6 bytes, so 30 bytes is exactly five lines and the sixth
      // is what trips the ceiling.
      captureLogs: { captureBytes: 30 },
    });

    const record = await runOnce(runner, { count: 50 });
    const page = await readLog(driver, runner.namespace, record.runId);
    const texts = textOf(page.lines);

    expect(texts.slice(0, 5)).toEqual([
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
    ]);
    expect(texts.at(-1)).toContain("run log capture stopped");
    expect(page.lines.at(-1)!.level).toBe("warn");
    // The notice is the last thing stored: nothing after the ceiling.
    expect(texts).toHaveLength(6);
    // `logsDropped` stays the store's number, so the record and a log read
    // never disagree about what the caps dropped.
    expect(record.logsDropped).toBe(page.dropped);
  });
});

describe("run-log capture: failure is never the run's problem", () => {
  it("lets the run finish when the store throws, and warns once", async () => {
    const logger = createTestLogger();
    const driver = new MemoryDriver();
    let appends = 0;
    driver.appendRunLog = async () => {
      appends++;
      throw new Error("the log store is down");
    };

    const runner = makeRunner("log-many", {
      driver,
      logger: logger.logger,
      captureLogs: { maxLines: 1_000 },
    });

    // Enough lines to force several flushes, so "once, not per line" means
    // something.
    const record = await runOnce(runner, { count: RUN_LOG_FLUSH_LINES * 3 });

    expect(record.status).toBe("success");
    expect(record.error).toBeUndefined();
    expect(appends).toBe(1);
    const warnings = logger.events.filter(
      (event) =>
        event.level === "warn" && event.message.includes("run's log lines"),
    );
    expect(warnings).toHaveLength(1);
  });

  it("captures nothing, and still runs, on a driver without appendRunLog", async () => {
    const driver = new MemoryDriver();
    Object.defineProperty(driver, "appendRunLog", {
      value: undefined,
      configurable: true,
    });

    const runner = makeRunner("talker", { driver });
    const record = await runOnce(runner);

    expect(record.status).toBe("success");
    // Absent, not zero: `undefined` is how a reader is told this backend
    // stores no run logs at all.
    expect(record.logLines).toBeUndefined();
    expect(record.logsDropped).toBeUndefined();
  });

  it("captures nothing when captureLogs is off", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("talker", { driver, captureLogs: false });

    const record = await runOnce(runner);
    const page = await readLog(driver, runner.namespace, record.runId);

    expect(record.status).toBe("success");
    expect(record.logLines).toBeUndefined();
    expect(page.lines).toEqual([]);
    // And a spawned run keeps the stdio it always had.
    expect(runner.options.spawn.stdout).toBe("inherit");
  });

  it("reports 0, not absent, for a run that logged nothing", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("echo", { driver });

    const record = await runOnce(runner, { value: 1 });
    const page = await readLog(driver, runner.namespace, record.runId);

    expect(record.logLines).toBe(0);
    expect(record.logsDropped).toBe(0);
    expect(page).toEqual({ lines: [], count: 0, dropped: 0, lastSeq: 0 });
  });
});

describe("run-log capture: the run record", () => {
  it("writes the counters into the stored history row", async () => {
    const driver = new MemoryDriver();
    const runner = makeRunner("log-many", {
      driver,
      captureLogs: { maxLines: 4 },
    });

    await runOnce(runner, { count: 10 });
    const [stored] = await driver.listHistory(
      runner.namespace,
      runnerKey("logs"),
      1,
    );

    expect(stored!.logLines).toBe(4);
    expect(stored!.logsDropped).toBe(6);
  });
});

describe("run-log capture: flushing on demand", () => {
  it("stores what is buffered when flush() is awaited, before any threshold", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const capture = new RunLogCapture({
      driver,
      namespace,
      key: runnerKey("logs"),
      runId: "run-flush",
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
    });

    capture.line("early", { level: "info" });
    // One line is far short of every threshold, so without the flush the store
    // would hold nothing until `RUN_LOG_FLUSH_MS` or `close()`.
    expect((await readLog(driver, namespace, "run-flush")).lines).toHaveLength(
      0,
    );

    await capture.flush();

    const page = await readLog(driver, namespace, "run-flush");
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]).toMatchObject({
      seq: 1,
      stream: "log",
      text: "early",
      level: "info",
    });
  });
});

describe("run-log capture: ordering across flushes", () => {
  it("numbers a run's lines continuously over many appends", async () => {
    const { path, cleanup } = await makeTmpDir("run-logs");
    cleanups.push(cleanup);

    // A real file driver, deliberately: its append takes a lock and writes to
    // disk, so two appends in flight at once would genuinely interleave. On an
    // in-memory store they would not, and the test would pass either way.
    const driver = new FileDriver({ root: path });
    await driver.connect();
    cleanups.push(async () => await driver.close());

    const namespace = testNamespace();
    const runId = "run-ordering";
    const capture = new RunLogCapture({
      driver,
      namespace,
      key: runnerKey("logs"),
      runId,
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
    });

    const total = RUN_LOG_FLUSH_LINES * 6;
    for (let index = 1; index <= total; index++) {
      capture.output("stdout", `line ${index}\n`);
      // Lets a flush that the line threshold has already triggered start, so
      // the next batch is buffered while the previous one is still writing.
      if (index % RUN_LOG_FLUSH_LINES === 0) {
        await Bun.sleep(0);
      }
    }

    const totals = await capture.close();
    const page = await readLog(driver, namespace, runId);

    expect(totals.count).toBe(total);
    expect(page.lines).toHaveLength(total);
    expect(textOf(page.lines)).toEqual(
      Array.from({ length: total }, (_value, index) => `line ${index + 1}`),
    );
    expect(page.lines.map((line) => line.seq)).toEqual(
      Array.from({ length: total }, (_value, index) => index + 1),
    );
  });
});
