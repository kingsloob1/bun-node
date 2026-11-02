/**
 * The `./react` bundle-safety check's negative control: the React entry
 * beside a value from bun-common, which a browser bundle must never carry.
 * Built by `bundleSafety.test.ts`, never imported by a test.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { createApiHooks } from "../../lib/react";

export const router = new BunRouter();
export { createApiHooks };
