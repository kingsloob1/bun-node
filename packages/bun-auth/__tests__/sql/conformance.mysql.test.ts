/**
 * better-auth's adapter conformance kit against bunSqlAdapter on mysql (see `conformance.ts`).
 */
import { registerConformance } from "./conformance";
import { forEachEngine } from "./helpers";

await forEachEngine(registerConformance, "mysql");
