import process from "node:process";
import { defineHandler } from "../../../lib/index";

/**
 * Writes to both pipes, so run-log capture has something to split into lines.
 *
 * `out` and `err` say how many lines to write to each; `tail` appends a final
 * chunk with no trailing newline, which capture must still store as a line.
 */
export default defineHandler<
  { out?: number; err?: number; tail?: string },
  { out: number; err: number }
>((ctx) => {
  const out = ctx.args?.out ?? 0;
  const err = ctx.args?.err ?? 0;

  for (let index = 1; index <= out; index++) {
    process.stdout.write(`out ${index}\n`);
  }

  for (let index = 1; index <= err; index++) {
    process.stderr.write(`err ${index}\n`);
  }

  if (ctx.args?.tail !== undefined) {
    process.stdout.write(ctx.args.tail);
  }

  return { out, err };
});
