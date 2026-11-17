/**
 * The security store kit against `postgresStore()` with `sealedFields`
 * sealing every field of every body (storage.md §8, §9), each case on
 * tables of its own, with the two-process race.
 */
import { runSecurityStoreConformance } from "../../lib/testing/index";
import {
  dropStore,
  freshPrefix,
  POSTGRES_URL,
  postgresAvailable,
} from "../store/pgBackend";
import { sealedPostgresStore } from "./fixtures/sealedStores";

if (await postgresAvailable()) {
  /** The prefix of the case running now. */
  let current = "";
  await runSecurityStoreConformance(
    "postgres, sealed",
    () => {
      current = freshPrefix();
      const prefix = current;
      return {
        store: sealedPostgresStore({ url: POSTGRES_URL!, prefix, max: 4 }),
        cleanup: () => dropStore(prefix),
      };
    },
    {
      crossProcess: {
        module: new URL("./fixtures/sealedStores.ts", import.meta.url).pathname,
        export: "sealedPostgresStore",
        options: () => ({ url: POSTGRES_URL, prefix: current, max: 2 }),
      },
    },
  );
}
