/**
 * The security store kit against `sqliteStore()` with `sealedFields`
 * sealing every field of every body (storage.md §8, §9): the codec changes
 * nothing the kit can see, the two-process race included.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { runSecurityStoreConformance } from "../../lib/testing/index";
import { sealedSqliteStore } from "./fixtures/sealedStores";

const dir = mkdtempSync(join(tmpdir(), "bun-security-sealed-sqlite-"));
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
let files = 0;
/** The file of the case running now. */
let current = "";

await runSecurityStoreConformance(
  "sqlite, sealed",
  () => {
    files += 1;
    current = join(dir, `store-${files}.sqlite`);
    const path = current;
    return {
      store: sealedSqliteStore({ path }),
      cleanup: () => {
        for (const suffix of ["", "-wal", "-shm"]) {
          rmSync(`${path}${suffix}`, { force: true });
        }
      },
    };
  },
  {
    crossProcess: {
      module: new URL("./fixtures/sealedStores.ts", import.meta.url).pathname,
      export: "sealedSqliteStore",
      options: () => ({ path: current }),
    },
  },
);
