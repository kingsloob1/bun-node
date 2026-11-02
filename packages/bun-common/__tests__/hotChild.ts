/**
 * Runs a fixture module in a child `bun` process, under `bun --hot` or not,
 * and rewrites it to make `--hot` re-evaluate it. Shared by bun-common's and
 * bun-nest's `--hot` tests.
 *
 * The fixture reports on stdout, one JSON object per line with an `event`
 * field (`listening`, `failed`, …); everything else it prints is kept for the
 * failure message. Every wait is bounded and fails with the child's output.
 */
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** The longest any wait in these tests takes, in milliseconds. */
export const HOT_WAIT_MS = 15_000;

/** One line the fixture printed as JSON. */
export interface HotEvent {
  /** What happened: `listening`, `failed`, `closed`, … */
  event: string;
  /** The fixture version that printed it (the string the test rewrites). */
  version?: string;
  /** The port the server listens on, for `listening`. */
  port?: number;
  /** The error's `code`, for `failed` (`EADDRINUSE`). */
  code?: string;
  /** Anything else the fixture reports. */
  [key: string]: unknown;
}

/** A running fixture. */
export interface HotChild {
  /** The child's PID, for the failure message. */
  readonly pid: number;
  /** Every JSON event printed so far, in order. */
  readonly events: HotEvent[];
  /** Everything printed on stderr so far. */
  stderr: () => string;
  /**
   * Resolves the first event (at or after index `from`) matching `predicate`;
   * rejects after {@link HOT_WAIT_MS} with the child's output.
   */
  waitForEvent: (
    predicate: (event: HotEvent) => boolean,
    what: string,
    from?: number,
  ) => Promise<HotEvent>;
  /**
   * Polls `check` every 50 ms until it returns `true`; rejects after
   * {@link HOT_WAIT_MS} with the child's output and `check`'s last note.
   */
  waitUntil: (
    check: () => Promise<boolean | string>,
    what: string,
  ) => Promise<void>;
  /**
   * Replaces the fixture's source in place, which a `--hot` child
   * re-evaluates. In place, not an atomic save (a sibling file renamed over
   * it): Bun 1.4.4 misses a rename onto an entry file outside the child's
   * cwd (oven-sh/bun#47787), and the fixture lives in a temporary directory so the tests never
   * write into the repository.
   */
  rewrite: (source: string) => void;
  /** Resolves the child's exit code once it exits on its own. */
  exited: () => Promise<number>;
  /** Kills the child by its PID, waits for it to exit, removes its directory. */
  stop: () => Promise<void>;
}

/** Options for {@link startChild}. */
export interface StartChildOptions {
  /** The fixture's first source. */
  source: string;
  /** Runs it under `bun --hot` when `true`; a plain `bun` run otherwise. */
  hot: boolean;
  /**
   * The child's working directory, whose `tsconfig.json` Bun reads (bun-nest
   * needs the decorator options) and whose `node_modules` it resolves from.
   */
  cwd: string;
}

/** Reads `stream` as text into `onChunk`, until it ends. */
async function readText(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    onChunk(decoder.decode(chunk, { stream: true }));
  }
}

/**
 * Writes `source` to a fresh temporary directory and runs it in a child
 * `bun` (`process.execPath`), with `--hot` when asked.
 */
export function startChild(options: StartChildOptions): HotChild {
  const dir = mkdtempSync(join(tmpdir(), "bun-node-hot-"));
  const file = join(dir, "fixture.ts");
  writeFileSync(file, options.source);

  const child: Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [process.execPath, ...(options.hot ? ["--hot"] : []), file],
    { cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );

  const events: HotEvent[] = [];
  let stdout = "";
  let pending = "";
  let stderr = "";
  const reading = Promise.all([
    readText(child.stdout, (text) => {
      stdout += text;
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line.startsWith("{")) {
          try {
            const parsed = JSON.parse(line) as HotEvent;
            if (typeof parsed.event === "string") {
              events.push(parsed);
            }
          } catch {
            // Not one of the fixture's events; kept in `stdout`.
          }
        }
        newline = pending.indexOf("\n");
      }
    }),
    readText(child.stderr, (text) => {
      stderr += text;
    }),
  ]).catch(() => undefined);

  const describe = (what: string, note?: string) =>
    [
      `timed out after ${HOT_WAIT_MS} ms waiting for ${what} (child pid ${child.pid}${options.hot ? ", bun --hot" : ""})`,
      ...(note === undefined ? [] : [`last check: ${note}`]),
      `stdout:\n${stdout || "(empty)"}`,
      `stderr:\n${stderr || "(empty)"}`,
    ].join("\n");

  let stopped = false;

  return {
    pid: child.pid,
    events,
    stderr: () => stderr,
    async waitForEvent(predicate, what, from = 0) {
      const deadline = Date.now() + HOT_WAIT_MS;
      for (;;) {
        const found = events.slice(from).find(predicate);
        if (found) {
          return found;
        }
        if (Date.now() > deadline) {
          throw new Error(describe(what));
        }
        await Bun.sleep(20);
      }
    },
    async waitUntil(check, what) {
      const deadline = Date.now() + HOT_WAIT_MS;
      let note: string | undefined;
      for (;;) {
        const result = await check();
        if (result === true) {
          return;
        }
        note = typeof result === "string" ? result : undefined;
        if (Date.now() > deadline) {
          throw new Error(describe(what, note));
        }
        await Bun.sleep(50);
      }
    },
    rewrite(source) {
      writeFileSync(file, source);
    },
    async exited() {
      const code = await Promise.race([
        child.exited,
        Bun.sleep(HOT_WAIT_MS).then(() => undefined),
      ]);
      if (code === undefined) {
        throw new Error(describe("the child to exit"));
      }
      await reading;
      return code;
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      // By PID: `kill()` signals this child alone.
      child.kill();
      await child.exited;
      await reading;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * GETs `url` and resolves its body, or `undefined` when nothing answers
 * (refused, reset, or no answer within 2 s).
 */
export async function bodyAt(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return await response.text();
  } catch {
    return undefined;
  }
}
