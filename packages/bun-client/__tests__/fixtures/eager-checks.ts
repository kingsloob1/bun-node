/**
 * The lazy-load proof's negative control (`bundleSafety.test.ts`): a client
 * entry that imports the checks module statically, as the client would if
 * its `import()` were a plain import. Its entry chunk must then carry
 * bun-contract, which the check must see. Built by the test, never imported.
 */
import { createChecks } from "../../lib/validation";

export { createClient } from "../../lib/index";
export const checks = createChecks;
