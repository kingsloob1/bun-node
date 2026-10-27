import type { SpecDocument } from "../../../../app/api/docs";
import { readFileSync } from "node:fs";

/**
 * The AsyncAPI documents a REAL `createJobsApi` serves, recorded in
 * `fixtures/*.json` and kept fresh by `pkg/docs-ws.integration.test.ts`
 * (`UPDATE_WS_FIXTURES=1` rewrites them):
 *
 * - `both`: mode `both`, every channel family, no security schemes.
 * - `runner`: mode `runner`, so the queue channels and messages are pruned.
 * - `jobs-secured`: mode `jobs`, replay off, three schemes, and a
 *   requirement naming two of them (only in `x-bun-jobs-security`).
 */

/** The recorded configurations. */
export type WsFixtureName = "both" | "runner" | "jobs-secured";

/** A fresh copy of a recorded document. */
export function wsFixture(name: WsFixtureName): SpecDocument {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as SpecDocument;
}
