/**
 * The `./sse` bundle-safety check's negative control: the event-stream
 * entry beside a value from bun-common, which a browser bundle must never
 * carry. Built by `bundleSafety.test.ts`, never imported by a test.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { sse } from "../../lib/sse";

export const router = new BunRouter();
export { sse };
