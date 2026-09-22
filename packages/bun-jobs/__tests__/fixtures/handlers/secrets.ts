/* eslint-disable no-console -- the console is what this file exercises: capture patches it. */
import { defineHandler } from "../../../lib/index";

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
