/**
 * A handler that writes to every place a run's log is captured from, for
 * `10-options/run-logs-and-clears.ts`.
 *
 * Every line it writes starts with its `tag`, so two runs at once can be told
 * apart in their logs, and a line the host wrote can be told from both.
 *
 * - `ctx.log()` — the `log` stream, with a level and fields;
 * - `console.log`/`info` — `stdout`; `console.warn`/`error` — `stderr`;
 * - `process.stdout.write` — captured only from a spawned run's pipe;
 * - optionally: numbered lines, lines holding secrets, one long line;
 * - optionally: a pause after flushing, until the parent sends `"go"`, so the
 *   parent can read (or clear) while the run is still in progress.
 */
import process from "node:process";
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Arguments the handler accepts. */
export interface RunLogArgs {
  /** Starts every line, so runs can be told apart. Defaults to `"run"`. */
  tag?: string;
  /** Write this many numbered `console.log` lines. Defaults to `0`. */
  lines?: number;
  /** Milliseconds to wait between numbered lines. Defaults to `0`. */
  lineGap?: number;
  /** Write lines holding secrets, for redaction. */
  secrets?: boolean;
  /** Write one `console.log` line this many characters long. */
  longLine?: number;
  /** Write one line with `process.stdout.write`. */
  raw?: boolean;
  /**
   * After writing, flush, send `"held"`, and wait for `"go"` before writing
   * one more line and returning.
   */
  hold?: boolean;
}

/** What a finished run reports. */
export interface RunLogResult {
  /** The `tag` it was given. */
  tag: string;
  /** Where it executed. */
  mode: string;
}

/** The lines `secrets` writes, each with the secret it hides. */
export const SECRET_LINES = [
  "DB_PASSWORD=hunter2 user=ada",
  "Authorization: Bearer abc123def",
  "connecting to postgres://app:s3cret@db.internal/prod",
  "max_tokens=100",
  "charge sk_live_4eC39Hq ssn=123-45-6789",
] as const;

export default defineHandler<RunLogArgs, RunLogResult>(async (ctx) => {
  const tag = ctx.args?.tag ?? "run";

  ctx.log(`${tag} started`, {
    level: "info",
    fields: { mode: ctx.mode, note: "a b" },
  });
  console.log(`${tag} console.log`);
  console.info(`${tag} console.info`);
  console.warn(`${tag} console.warn`);
  console.error(`${tag} console.error`);

  if (ctx.args?.raw) {
    process.stdout.write(`${tag} process.stdout.write\n`);
  }

  for (let line = 1; line <= (ctx.args?.lines ?? 0); line++) {
    console.log(`${tag} line ${line}`);
    if (ctx.args?.lineGap) {
      await Bun.sleep(ctx.args.lineGap);
    }
  }

  if (ctx.args?.secrets) {
    for (const line of SECRET_LINES) {
      console.log(line);
    }
  }

  if (ctx.args?.longLine) {
    console.log(`${tag} ${"L".repeat(ctx.args.longLine)}`);
  }

  if (ctx.args?.hold) {
    // Store what is written so far before telling the parent to look.
    await ctx.flushLogs();

    await new Promise<void>((resolve) => {
      const unsubscribe = ctx.onMessage((message) => {
        if (message === "go") {
          unsubscribe();
          resolve();
        }
      });
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      ctx.send("held");
    });

    ctx.log(`${tag} released`);
  }

  return { tag, mode: ctx.mode };
});
