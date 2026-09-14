/**
 * Returns a result of a chosen size, so `maxResultBytes` can be shown
 * truncating what is stored while leaving what the `finished` event carries.
 */
import { defineHandler } from "@kingsleyweb/bun-jobs";

/** Arguments the big-result handler accepts. */
export interface BigResultArgs {
  /** How many characters the payload holds. */
  bytes: number;
}

/** What it returns. */
export interface BigResult {
  /** `bytes` characters of `x`. */
  payload: string;
}

export default defineHandler<BigResultArgs, BigResult>((ctx) => {
  return { payload: "x".repeat(ctx.args.bytes) };
});
