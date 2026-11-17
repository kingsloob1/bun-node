/**
 * The security store kit against `postgresStore()` (storage.md §9), each
 * case on tables of its own, with the two-process pass: a child process
 * opens the same tables and races the test for one document and one
 * policy's head.
 */
import { postgresStore } from "../../lib/store/index";
import { runSecurityStoreConformance } from "../../lib/testing/index";
import {
  dropStore,
  freshPrefix,
  POSTGRES_URL,
  postgresAvailable,
} from "./pgBackend";

if (await postgresAvailable()) {
  /** The prefix of the case running now. */
  let current = "";
  await runSecurityStoreConformance(
    "postgres",
    () => {
      current = freshPrefix();
      const prefix = current;
      return {
        store: postgresStore({ url: POSTGRES_URL, prefix, max: 4 }),
        cleanup: () => dropStore(prefix),
      };
    },
    {
      crossProcess: {
        module: new URL("../../lib/store/postgres.ts", import.meta.url)
          .pathname,
        export: "postgresStore",
        options: () => ({ url: POSTGRES_URL, prefix: current, max: 2 }),
      },
    },
  );
}
