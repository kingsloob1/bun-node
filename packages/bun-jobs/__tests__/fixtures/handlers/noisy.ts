import process from "node:process";

/** What `noisy` is asked to write. */
interface NoisyArgs {
  /** How many lines. */
  lines: number;
  /** The width of each line's filler. Defaults to 100. */
  width?: number;
  /** How long to wait after writing, in milliseconds. */
  holdMs?: number;
  /**
   * The filler character, repeated `width` times. Defaults to `"x"`; a
   * multi-byte one (`"é"`, two bytes in UTF-8) puts a character boundary
   * that is not a byte boundary next to wherever an output limit cuts.
   */
  fill?: string;
}

/**
 * Writes `lines` lines to stdout, then waits, so a test can tell an output
 * limit's kill from the handler finishing. Each line carries a `password=`
 * pair, so a test can see redaction survive the limit.
 *
 * A runner handler and a queue processor at once: it reads its arguments from
 * a run's `ctx.args` or a job's `data`, whichever it was called with.
 */
export default async function noisy(input: {
  args?: NoisyArgs;
  data?: NoisyArgs;
}): Promise<string> {
  const {
    lines,
    width = 100,
    holdMs = 0,
    fill = "x",
  } = input.data ?? input.args ?? { lines: 0 };
  for (let i = 0; i < lines; i++) {
    process.stdout.write(
      `${String(i).padStart(6, "0")} password=hunter2 ${fill.repeat(width)}\n`,
    );
  }
  await Bun.sleep(holdMs);
  return "finished";
}
