/**
 * The `./persist` bundle-safety check's negative control: the persister
 * entry beside a value from bun-common, which a browser bundle must never
 * carry. Built by `bundleSafety.test.ts`, never imported by a test.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { idbPersister } from "../../lib/persist";

export const router = new BunRouter();
export { idbPersister };
