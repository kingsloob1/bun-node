import process from "node:process";
import { defineHandler } from "../../../lib/index";

/**
 * Writes one very long line of multi-byte text, so capture's per-line byte cap
 * has to cut it — and has to cut it on a character boundary.
 *
 * `char` is repeated `count` times; the default is a 3-byte character, so the
 * cut lands mid-character unless capture walks back over the continuation
 * bytes.
 */
export default defineHandler<{ char?: string; count?: number }, number>(
  (ctx) => {
    const char = ctx.args?.char ?? "あ";
    const count = ctx.args?.count ?? 1000;
    process.stdout.write(`${char.repeat(count)}\n`);
    return count;
  },
);
