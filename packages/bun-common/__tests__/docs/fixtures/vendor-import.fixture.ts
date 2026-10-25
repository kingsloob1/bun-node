/**
 * The negative control for the lib/docs import-graph test: a module that
 * does import a vendor, which the test must catch. Not a test file — the
 * `.fixture.ts` suffix keeps it out of `bun test`'s discovery.
 */
import { z } from "zod";

export const fixture = z.string();
