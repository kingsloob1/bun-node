/* eslint-disable no-console -- the console is what this file exercises: capture patches it. */
import type {
  BunRunnerOptions,
  ExecutionMode,
  RunLogLine,
  RunRecord,
} from "../lib/index";
import { join } from "node:path";
import { format } from "node:util";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunRunner, MemoryDriver, runnerKey } from "../lib/index";
import { formatConsoleArgs } from "../lib/runner/consolePatch";
import { captureRealmConsole } from "../lib/runner/realmConsole";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * Console-capture formatting parity (fix round A4).
 *
 * Captured text used to come from `util.format` in every realm, which costs a
 * worker run a few milliseconds just to load `node:util`. `formatConsoleArgs`
 * formats plain arguments itself and hands anything else to `util.format`, so
 * what is stored must be byte-identical to what it was: these compare it with
 * `util.format` directly, and through real runs in both capturing modes.
 */

/** Argument lists covering the fast path, its edges, and every fallback. */
const CASES: unknown[][] = [
  [],
  [""],
  ["plain"],
  ["two", "strings"],
  ["multi\nline"],
  ["n", 1, -1, 0, -0, 1.5, 1e21, 1e-7, Number.NaN, Infinity, -Infinity],
  [-0],
  [0, "then string"],
  ["bool", true, false],
  ["nullish", null, undefined],
  [null],
  [undefined, "x"],
  ["big", 10n, -3n],
  [1n],
  ["%s is %d", "a", 3],
  ["100%"],
  ["%o", { a: 1 }],
  ["%%", 1],
  [1, "%s", "later"],
  ["obj", { n: 1 }],
  [{ nested: { deep: { deeper: { deepest: 1 } } } }],
  [[1, "two", { three: 3 }]],
  ["map", new Map([[1, { a: 2 }]]), new Set([1])],
  ["fn", () => 1, function named() {}],
  ["sym", Symbol("s")],
  [Symbol.iterator],
  ["date", new Date(0)],
  ["re", /x+/g],
  ["typed", new Uint8Array([1, 2])],
  ["err", new Error("boom")],
  ["cls", new (class Thing {})()],
];

describe("formatConsoleArgs", () => {
  it("is byte-identical to util.format", () => {
    for (const args of CASES) {
      expect(formatConsoleArgs(args)).toBe(format(...args));
    }
  });
});

describe("realm console capture", () => {
  it("tees each call to the sink, formatted as util.format does, and restores the console", () => {
    const original = console.log;
    const printed: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      printed.push(args);
    };
    const patchedFrom = console.log;
    const seen: string[] = [];
    try {
      const release = captureRealmConsole((stream, text) =>
        seen.push(`${stream}:${text}`),
      );
      console.log("a", { b: 1 });
      release();
      release();
      console.log("after");
      expect(console.log).toBe(patchedFrom);
    } finally {
      console.log = original;
    }
    expect(seen).toEqual([`stdout:${format("a", { b: 1 })}\n`]);
    expect(printed).toEqual([["a", { b: 1 }], ["after"]]);
  });
});

describe("captured text through real runs", () => {
  let dir: { path: string; cleanup: () => Promise<void> };
  let file: string;

  /** Every case the handler logs, less those that cannot cross to a worker as text. */
  const LOGGED = `[
    ["plain"],
    ["n", 1, -0, 1.5, NaN],
    ["nullish", null, undefined, true, 10n],
    ["%s is %d", "a", 3],
    ["100%"],
    ["obj", { n: 1 }],
    [{ nested: { deep: { deeper: { deepest: 1 } } } }],
    ["map", new Map([[1, { a: 2 }]])],
    ["fn", () => 1],
    ["sym", Symbol("s")],
  ]`;

  beforeAll(async () => {
    dir = await makeTmpDir("fix-runner-format");
    file = join(dir.path, "logger.ts");
    await Bun.write(
      file,
      `export default async function handler() {
        for (const args of ${LOGGED}) console.log(...args);
        console.error("err", { e: [1, 2] });
        return 1;
      }\n`,
    );
  });

  afterAll(async () => {
    await dir.cleanup();
  });

  /** The captured lines of one run in `mode`. */
  async function capturedLines(mode: ExecutionMode): Promise<RunLogLine[]> {
    const driver = new MemoryDriver();
    const runner = new BunRunner({
      id: `format-${mode}`,
      namespace: testNamespace("fmt"),
      file,
      executionMode: mode,
      waitToExit: false,
      logger: noopLogger,
      syncInterval: 0,
      driver,
    } as BunRunnerOptions<any>);
    await runner.start();
    try {
      const settled = new Promise<RunRecord>((resolve) => {
        runner.once("finished", resolve);
        runner.once("failed", resolve);
      });
      await runner.trigger();
      const record = await settled;
      expect(record.status).toBe("success");
      const page = await driver.getRunLog(
        runner.namespace,
        runnerKey(runner.id),
        record.runId,
        { offset: 0, limit: 1000, order: "asc" },
      );
      return page.lines;
    } finally {
      await runner.stop({ force: true });
    }
  }

  /** What util.format makes of the handler's calls, line by line, by stream. */
  function expectedLines(): { stream: RunLogLine["stream"]; text: string }[] {
    // eslint-disable-next-line no-new-func -- the same literal the handler logs, evaluated here.
    const logged = new Function(`return ${LOGGED}`)() as unknown[][];
    return [
      ...logged.flatMap((args) =>
        format(...args)
          .split("\n")
          .map((text) => ({ stream: "stdout" as const, text })),
      ),
      ...format("err", { e: [1, 2] })
        .split("\n")
        .map((text) => ({ stream: "stderr" as const, text })),
    ];
  }

  for (const mode of ["worker-thread", "in-process"] as const) {
    it(`stores exactly util.format's text for a ${mode} run`, async () => {
      const lines = await capturedLines(mode);
      const got = lines
        .filter((line) => line.stream !== "log")
        .map((line) => ({ stream: line.stream, text: line.text }));
      const want = expectedLines();
      // Each stream in its own order: the two streams are separate captures.
      for (const stream of ["stdout", "stderr"]) {
        expect(got.filter((line) => line.stream === stream)).toEqual(
          want.filter((line) => line.stream === stream),
        );
      }
    });
  }
});
