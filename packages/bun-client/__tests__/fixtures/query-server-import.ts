/**
 * The `./query` bundle-safety check's negative control: the query entry
 * beside a value from bun-common, which a browser bundle must never carry.
 * Built by `bundleSafety.test.ts`, never imported by a test.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { queries } from "../../lib/query";

export const router = new BunRouter();
export { queries };
