/* eslint-disable no-console -- the console is what this file exercises: capture patches it. */
// Not the package root: a fresh worker or child loads this file for every run,
// and the root takes 200 to 800 ms to import where this module takes 2 ms
// (measured at load 30 to 70). The tests' 5 s ran out on that at load 40 and up.
import { defineHandler } from "../../../lib/runner/types";

/**
 * Says each of `lines` three ways — `console.log` (stdout), `console.error`
 * (stderr) and `ctx.log()` (the `log` stream) — so a redaction test can check
 * every stream a secret can reach the store by. `fields`, when given, rides on
 * the `ctx.log()` call as structured fields.
 */
export default defineHandler<
  { lines: string[]; fields?: Record<string, unknown> },
  number
>((ctx) => {
  for (const line of ctx.args.lines) {
    console.log(line);
    console.error(line);
    ctx.log(line, ctx.args.fields ? { fields: ctx.args.fields } : undefined);
  }
  return ctx.args.lines.length;
});
