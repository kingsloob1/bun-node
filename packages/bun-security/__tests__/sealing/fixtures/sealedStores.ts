/**
 * The stores the sealing suites run the kit against: `sqliteStore` and
 * `postgresStore` with a codec that seals every top-level field of every
 * document, policy and bundle. A module of its own so the kit's
 * cross-process child builds the same store from a path, an export and
 * JSON options (a codec is not JSON).
 */
import type { SealedFieldPaths } from "../../../lib/sealing/index";
import type {
  PostgresStoreOptions,
  SecurityStoreDriver,
  SqliteStoreOptions,
} from "../../../lib/store/index";
import { sealedFields } from "../../../lib/sealing/index";
import {
  DOC_KINDS,
  postgresStore,
  sqliteStore,
} from "../../../lib/store/index";

/** Two ring keys: the first seals. Test keys only. */
export const TEST_KEYS = [
  { id: "2026-11", key: new Uint8Array(32).fill(7) },
  { id: "2026-10", key: new Uint8Array(32).fill(8) },
];

/** Every top-level field of every body. */
export const EVERY_FIELD: SealedFieldPaths = {
  doc: Object.fromEntries(DOC_KINDS.map((kind) => [kind, ["*"]])),
  policy: ["*"],
  bundle: ["*"],
};

/** `sqliteStore` sealing every field. */
export function sealedSqliteStore(
  options: SqliteStoreOptions,
): SecurityStoreDriver {
  return sqliteStore({
    ...options,
    codec: sealedFields({ keys: TEST_KEYS, fields: EVERY_FIELD }),
  });
}

/** `postgresStore` sealing every field. */
export function sealedPostgresStore(
  options: PostgresStoreOptions,
): SecurityStoreDriver {
  return postgresStore({
    ...options,
    codec: sealedFields({ keys: TEST_KEYS, fields: EVERY_FIELD }),
  });
}
