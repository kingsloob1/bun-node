/**
 * The bundle-safety test's negative control: a client entry that also
 * imports a value from bun-common, which a browser bundle must never carry.
 * Built by `bundleSafety.test.ts`, never imported by a test.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { createClient } from "../../lib/index";

export const api = createClient();
export const router = new BunRouter();
