/**
 * MongoDB's half of a schema sync (`@kingsleyweb/bun-sql/mongo`), lifted from
 * bun-jobs' MongoDB driver (`#syncSchema`) and bun-cache's, which each kept
 * their own (bun-security plan, storage.md §4.2, §7).
 *
 * MongoDB has no column types, so nothing here can rewrite a collection and
 * `alterColumns` has nothing to mean: every change is safe by construction.
 * `createIndex` is idempotent, which is why connecting already does most of
 * this; the value of calling it explicitly is the report, and `dryRun` in
 * particular.
 *
 * **An index is dropped only when it is on the caller's `retired` list.**
 * MongoDB names an index after its key pattern, so one a driver no longer
 * defines is indistinguishable from one an operator added by hand (CLAUDE.md,
 * "Schema sync"); a broader rule would eventually delete somebody's index.
 *
 * The types are structural, so nothing here imports `mongodb`: a caller hands
 * in its database. {@link loadMongoClient} loads the optional peer for a
 * caller that opens its own client, lazily, so a service that never uses
 * MongoDB never needs the package.
 */
import type { SchemaChange, SchemaSyncOptions } from "../sync/types";
import { resolveSyncOptions } from "../sync/types";

/** One index a driver defines on a collection. */
export interface MongoIndexDefinition {
  /** The collection's name. */
  readonly collection: string;
  /** The key pattern, in order. MongoDB names the index after it (`a_1_b_-1`). */
  readonly key: Readonly<Record<string, 1 | -1>>;
  /** For a TTL index: seconds after the indexed date a document expires. Absent for any other. */
  readonly expireAfterSeconds?: number;
}

/** An index an earlier version of a driver created and this one no longer defines. */
export interface RetiredMongoIndex {
  /** The collection it is on. */
  readonly collection: string;
  /** Its name, as MongoDB derived it from the key pattern. */
  readonly name: string;
}

/** What {@link syncMongoIndexes} reconciles a database with. */
export interface MongoIndexSchema {
  /** Every index the driver defines. */
  readonly indexes: readonly MongoIndexDefinition[];
  /** The only indexes a sync may drop. Empty by default. */
  readonly retired?: readonly RetiredMongoIndex[];
}

/** A collection, as far as an index sync uses one: a real `mongodb` `Collection` fits. */
export interface MongoIndexCollection {
  /** The collection's indexes, each with its name. */
  indexes: () => Promise<readonly { readonly name?: unknown }[]>;
  /** Creates one index; idempotent. */
  createIndex: (
    key: Record<string, 1 | -1>,
    options?: { expireAfterSeconds?: number },
  ) => Promise<unknown>;
  /** Drops one index by name. */
  dropIndex: (name: string) => Promise<unknown>;
}

/** A database, as far as an index sync uses one: a real `mongodb` `Db` fits. */
export interface MongoIndexDb {
  /** A collection by name; `options` passed through (a read preference). */
  collection: (name: string, options?: never) => MongoIndexCollection;
}

/** Options for {@link syncMongoIndexes}. */
export interface MongoIndexSyncOptions extends SchemaSyncOptions {
  /**
   * Passed to every `db.collection(name, options)` call: bun-jobs reads every
   * collection from the primary (`{ readPreference: "primary" }`).
   */
  readonly collectionOptions?: Record<string, unknown>;
}

/** MongoDB's own name for an index on `key`, which is what `indexes()` reports back. */
function indexName(key: Readonly<Record<string, 1 | -1>>): string {
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");
}

/**
 * Reconciles `db` with the indexes `schema` defines, and reports every
 * difference found, each marked with whether it was applied:
 *
 * - a defined index the collection lacks is a `create-index`, applied unless
 *   `add` and `indexes` are both off;
 * - a retired index the collection still has is a `drop-index`, applied
 *   unless `indexes` is off;
 * - `dryRun` applies nothing, which makes the list a plan.
 *
 * A collection whose indexes cannot be read (it does not exist yet) reads as
 * having none. A drop that fails (the index went in the meantime) is ignored.
 */
export async function syncMongoIndexes(
  db: MongoIndexDb,
  schema: MongoIndexSchema,
  options: MongoIndexSyncOptions = {},
): Promise<SchemaChange[]> {
  const resolved = resolveSyncOptions(options);
  const collectionOptions = options.collectionOptions as never;
  const collection = (name: string): MongoIndexCollection =>
    options.collectionOptions === undefined
      ? db.collection(name)
      : db.collection(name, collectionOptions);
  const changes: SchemaChange[] = [];

  /** The index names each collection already has. */
  const existing = new Map<string, Set<string>>();
  for (const name of new Set([
    ...schema.indexes.map((index) => index.collection),
    ...(schema.retired ?? []).map((index) => index.collection),
  ])) {
    const names = await collection(name)
      .indexes()
      .then((found) => new Set(found.map((index) => String(index.name))))
      .catch(() => new Set<string>());
    existing.set(name, names);
  }

  for (const { collection: table, key } of schema.indexes) {
    const name = indexName(key);
    if (existing.get(table)?.has(name)) {
      continue;
    }
    changes.push({
      kind: "create-index",
      table,
      target: name,
      statement: `createIndex(${JSON.stringify(key)})`,
      reason: "the driver defines it and the collection does not have it",
      blocking: false,
      applied: false,
    });
  }

  for (const { collection: table, name } of schema.retired ?? []) {
    if (!existing.get(table)?.has(name)) {
      continue;
    }
    changes.push({
      kind: "drop-index",
      table,
      target: name,
      statement: `dropIndex(${JSON.stringify(name)})`,
      reason:
        "the driver no longer defines it, and it costs a write per document",
      blocking: false,
      applied: false,
    });
  }

  if (resolved.dryRun) {
    return changes;
  }

  for (const change of changes) {
    if (change.kind === "create-index") {
      if (!(resolved.add || resolved.indexes)) {
        continue;
      }
      const definition = schema.indexes.find(
        (index) =>
          index.collection === change.table &&
          indexName(index.key) === change.target,
      );
      if (definition) {
        const key = { ...definition.key };
        await (definition.expireAfterSeconds === undefined
          ? collection(change.table).createIndex(key)
          : collection(change.table).createIndex(key, {
              expireAfterSeconds: definition.expireAfterSeconds,
            }));
        change.applied = true;
      }
      continue;
    }
    if (!resolved.indexes) {
      continue;
    }
    await collection(change.table)
      .dropIndex(change.target)
      .catch(() => undefined);
    change.applied = true;
  }

  return changes;
}

/** A connected client, as far as a caller of {@link loadMongoClient} needs one. */
export interface MongoClientLike {
  /** Connects. */
  connect: () => Promise<unknown>;
  /** A database by name, the URL's when omitted. */
  db: (name?: string) => unknown;
  /** Closes the client. */
  close: (force?: boolean) => Promise<void>;
}

/** The `MongoClient` constructor, structurally. */
export type MongoClientConstructor = new (
  url: string,
  options?: Record<string, unknown>,
) => MongoClientLike;

/**
 * The `mongodb` package's `MongoClient`, loaded on first call: the optional
 * peer is needed only by a caller that uses MongoDB. Throws an `Error` naming
 * `what` and the install command when the package is missing.
 */
export async function loadMongoClient(
  what: string,
): Promise<MongoClientConstructor> {
  try {
    // A `string`-typed specifier, so the compiler does not resolve it: a
    // literal `import("mongodb")` is a TS2307 site for a consumer without the
    // optional peer, just as a static import is. Both export shapes, since no
    // literal means no CommonJS interop analysis.
    const specifier: string = "mongodb";
    const loaded = (await import(specifier)) as {
      MongoClient?: MongoClientConstructor;
      default?: { MongoClient?: MongoClientConstructor };
    };
    const constructor = loaded.MongoClient ?? loaded.default?.MongoClient;
    if (typeof constructor !== "function") {
      throw new TypeError("mongodb did not export MongoClient");
    }
    return constructor;
  } catch (error) {
    throw new Error(
      `${what} needs the "mongodb" package (an optional peer): install it with \`bun add mongodb\``,
      { cause: error },
    );
  }
}
