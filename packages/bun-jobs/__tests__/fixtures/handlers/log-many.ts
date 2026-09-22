import { defineHandler } from "../../../lib/index";

/**
 * Writes `count` lines through `ctx.log()` — the quiet way to give capture a
 * lot of lines, since nothing reaches the process's own stdio.
 *
 * `text` prefixes each line, so a byte-cap test can make them multi-byte.
 */
export default defineHandler<{ count?: number; text?: string }, number>(
  (ctx) => {
    const count = ctx.args?.count ?? 1;
    const text = ctx.args?.text ?? "line";

    for (let index = 1; index <= count; index++) {
      ctx.log(`${text} ${index}`);
    }

    return count;
  },
);
