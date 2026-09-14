/**
 * A runner handler that ends its own process before reporting anything — the
 * case `ChildExitError` describes. Used by `10-options/errors.ts` in `spawn`
 * mode; not meant to be run alone.
 */
import process from "node:process";
import { defineHandler } from "@kingsleyweb/bun-jobs";

export default defineHandler(() => {
  // No result is sent: the process is simply gone, with exit code 3.
  process.exit(3);
});
