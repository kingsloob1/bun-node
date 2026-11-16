/**
 * The security store kit against `sqliteStore()` (storage.md §9), each case
 * on a file of its own, with the two-process pass: a child process opens
 * the same file and races the test for one document and one policy's head.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteStore } from "../../lib/store/index";
import { runSecurityStoreConformance } from "../../lib/testing/index";

const dir = mkdtempSync(join(tmpdir(), "bun-security-sqlite-"));
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
let files = 0;
/** The file of the case running now. */
let current = "";

await runSecurityStoreConformance(
  "sqlite",
  () => {
    files += 1;
    current = join(dir, `store-${files}.sqlite`);
    const path = current;
    return {
      store: sqliteStore({ path }),
      cleanup: () => {
        for (const suffix of ["", "-wal", "-shm"]) {
          rmSync(`${path}${suffix}`, { force: true });
        }
      },
    };
  },
  {
    crossProcess: {
      module: new URL("../../lib/store/sqlite.ts", import.meta.url).pathname,
      export: "sqliteStore",
      options: () => ({ path: current }),
    },
  },
);
