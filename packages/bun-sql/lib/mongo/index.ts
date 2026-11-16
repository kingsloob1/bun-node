/**
 * MongoDB's index sync: `@kingsleyweb/bun-sql/mongo`. Drops only what the
 * caller's `retired` list names; `mongodb` is loaded only by
 * {@link loadMongoClient}, on first call.
 *
 * ```ts
 * const changes = await syncMongoIndexes(db, {
 *   indexes: [{ collection: "audit", key: { tenant: 1, at: -1 } }],
 *   retired: [{ collection: "audit", name: "at_1" }],
 * }, { dryRun: true });
 * ```
 */
export { loadMongoClient, syncMongoIndexes } from "./mongo";
export type {
  MongoClientConstructor,
  MongoClientLike,
  MongoIndexCollection,
  MongoIndexDb,
  MongoIndexDefinition,
  MongoIndexSchema,
  MongoIndexSyncOptions,
  RetiredMongoIndex,
} from "./mongo";
