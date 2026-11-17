/**
 * `@kingsleyweb/bun-security/sealing`: the durable store's secrets sealed
 * at rest (storage.md §8), the entry that needs `@kingsleyweb/bun-cache`
 * (an optional peer) for its envelope:
 *
 * - {@link sealedFields}: a `StoreCodec` for `sqliteStore` and
 *   `postgresStore` that seals the named fields of each body, bound to their
 *   row and field, with key rotation;
 * - {@link resealStore}: rewrites the documents sealed under an older key.
 */
export {
  DEFAULT_SEALED_FIELDS,
  type ResealResult,
  resealStore,
  type ResealStoreOptions,
  SEALED_MARKER,
  type SealedFieldFailure,
  SealedFieldError,
  type SealedFieldPaths,
  sealedFields,
  type SealedFieldsCodec,
  type SealedFieldsOptions,
  SEALING_PURPOSE,
} from "./fields";
