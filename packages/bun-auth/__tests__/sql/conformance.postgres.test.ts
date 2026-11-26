/**
 * better-auth's adapter conformance kit against bunSqlAdapter on postgres (see `conformance.ts`).
 */
import { registerConformance } from "./conformance";
import { forEachEngine } from "./helpers";

await forEachEngine(registerConformance, "postgres");
