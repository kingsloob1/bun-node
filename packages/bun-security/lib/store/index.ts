/**
 * The security store (`@kingsleyweb/bun-security/store`, storage.md §3, §5,
 * §6): where durable configuration lives, behind one interface —
 * `memoryStore()`, `sqliteStore({ path })` and the read-only
 * `policyFile(path)` — and the engine's way of following a policy in one.
 *
 * ```ts
 * import { createSecurity } from "@kingsleyweb/bun-security";
 * import { policyFile } from "@kingsleyweb/bun-security/store";
 *
 * const security = createSecurity({
 *   policy: { store: policyFile("./security.json"), lastKnownGood: "./.security-lkg.json" },
 * });
 * await security.ready(); // the file's policy is in force
 * ```
 */
export { policyFile } from "./file";
export type { PolicyFileOptions } from "./file";
export {
  DEFAULT_POLICY_POLL_MS,
  DEFAULT_POLICY_RECONCILE_MS,
  isPolicyFromStore,
} from "./follow";
export type { PolicyFromStore, PolicySourceStatus } from "./follow";
export { memoryStore } from "./memory";
export type { MemoryStoreOptions } from "./memory";
export { DEFAULT_STORE_PREFIX, storeSchema, storeTables } from "./sql";
export { sqliteStore } from "./sqlite";
export type { SqliteStoreOptions } from "./sqlite";
export { DOC_KINDS, MAX_PAGE_LIMIT } from "./types";
export type {
  AppendResult,
  Change,
  DocKind,
  ListQuery,
  Page,
  PolicyHead,
  PolicyVersionInput,
  PolicyVersionRecord,
  PutResult,
  SecurityStoreCapabilities,
  SecurityStoreDriver,
  StoreCodec,
  StoreCodecContext,
  StoredDoc,
} from "./types";
