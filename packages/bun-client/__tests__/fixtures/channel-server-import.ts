/**
 * The `./channel` bundle-safety check's negative control: the channel
 * client beside a value from bun-common, which a browser bundle must never
 * carry. Built by `bundleSafety.test.ts`, never imported by a test.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { channel } from "../../lib/channel";

export const router = new BunRouter();
export { channel };
