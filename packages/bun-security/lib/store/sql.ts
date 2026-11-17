/**
 * The security store over SQL, written once over bun-sql's dialect, schema
 * and sync (storage.md §4): `sqliteStore` is this with SQLite's dialect, and
 * `postgresStore` (PR-D2) will be this with Postgres'. Three tables under a
 * prefix: `docs` (kind, id, revision, body, time), `versions` (each policy's
 * published versions, numbered) and `changes` (the feed, an auto-increment
 * sequence). Every mutation and its change row run in one transaction
 * (`dialect.transaction`), so the feed is an outbox: no write without its
 * change.
 *
 * Revisions are compared in the statement itself (`UPDATE … WHERE revision =
 * ?`, an insert that ignores a taken key), and the transaction makes the
 * conflict's answer — the document as it is now — the one that refused the
 * write.
 */
import type { SQL } from "bun";
import type {
  SchemaChange,
  SchemaDefinition,
  SchemaSyncOptions,
  SqlDialect,
} from "@kingsleyweb/bun-sql";
import type {
  AppendAuditResult,
  AppendResult,
  AuditCheckpoint,
  AuditHead,
  AuditRecord,
  BundleInput,
  Change,
  ChangeKind,
  DocKind,
  ListQuery,
  Page,
  PolicyVersionInput,
  PolicyVersionRecord,
  PutBundleResult,
  PutResult,
  SecurityStoreCapabilities,
  SecurityStoreDriver,
  StoreCodec,
  StoredBundle,
  StoredDoc,
} from "./types";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  createSchema,
  keysetAfter,
  readColumns,
  resolveSyncOptions,
  syncSqlSchema,
} from "@kingsleyweb/bun-sql";
import {
  auditCursor,
  auditPosition,
  bundleEtag,
  checkAuditInput,
  checkCheckpoint,
  checkCounter,
  checkpointCursor,
  checkpointPosition,
  checkBundleInput,
  checkFeedRead,
  checkId,
  checkKind,
  checkRevision,
  checkVersionInput,
  docCursor,
  docPosition,
  jsonBody,
  refuseClosed,
  refusePolicyWrite,
  resolveAuditQuery,
  resolveQuery,
  versionCursor,
  versionPosition,
} from "./shared";

/** What a table prefix may be: letters, digits and `_`, starting with a letter or `_`. */
const PREFIX = /^[a-z_]\w{0,39}$/i;

/** The default table prefix. */
export const DEFAULT_STORE_PREFIX = "bun_security_";

/** The store's table names under a prefix. */
export function storeTables(prefix: string): {
  /** The documents. */
  docs: string;
  /** The policy versions. */
  versions: string;
  /** The change feed. */
  changes: string;
  /** Each service's signed bundle. */
  bundles: string;
  /** The audit chain's entries (append-only; control-plane.md §6.2). */
  audit: string;
  /** The audit chain's head, one row. */
  auditHead: string;
  /** The audit chain's signed checkpoints. */
  checkpoints: string;
  /** Short-lived counters and claims shared by control-plane instances. */
  counters: string;
} {
  return {
    docs: `${prefix}docs`,
    versions: `${prefix}versions`,
    changes: `${prefix}changes`,
    bundles: `${prefix}bundles`,
    audit: `${prefix}audit`,
    auditHead: `${prefix}audit_head`,
    checkpoints: `${prefix}audit_checkpoints`,
    counters: `${prefix}counters`,
  };
}

/** The store's schema under `prefix`, in `dialect`'s types. */
export function storeSchema(
  prefix: string,
  dialect: SqlDialect,
): SchemaDefinition {
  const {
    docs,
    versions,
    changes,
    bundles,
    audit,
    auditHead,
    checkpoints,
    counters,
  } = storeTables(prefix);
  const { idType, nameType, jsonType, timeType, serialType, longTextType } =
    dialect;
  return {
    tables: [
      {
        name: docs,
        primaryKey: ["kind", "id"],
        columns: [
          { name: "kind", type: idType, suffix: "NOT NULL" },
          { name: "id", type: idType, suffix: "NOT NULL" },
          { name: "revision", type: "INTEGER", suffix: "NOT NULL" },
          { name: "doc", type: jsonType, suffix: "NOT NULL" },
          { name: "updated_at", type: timeType, suffix: "NOT NULL" },
        ],
      },
      {
        name: versions,
        primaryKey: ["policy_id", "number"],
        columns: [
          { name: "policy_id", type: idType, suffix: "NOT NULL" },
          { name: "number", type: "INTEGER", suffix: "NOT NULL" },
          { name: "id", type: idType, suffix: "NOT NULL" },
          { name: "policy", type: jsonType, suffix: "NOT NULL" },
          { name: "created_at", type: timeType, suffix: "NOT NULL" },
          { name: "created_by", type: nameType },
          { name: "message", type: longTextType },
        ],
      },
      {
        name: bundles,
        primaryKey: ["service_id"],
        columns: [
          { name: "service_id", type: idType, suffix: "NOT NULL" },
          { name: "version", type: "INTEGER", suffix: "NOT NULL" },
          { name: "bundle", type: jsonType, suffix: "NOT NULL" },
          { name: "updated_at", type: timeType, suffix: "NOT NULL" },
        ],
      },
      {
        name: audit,
        primaryKey: ["n"],
        columns: [
          { name: "n", type: "INTEGER", suffix: "NOT NULL" },
          { name: "prev_hash", type: idType, suffix: "NOT NULL" },
          { name: "hash", type: idType, suffix: "NOT NULL" },
          { name: "at", type: timeType, suffix: "NOT NULL" },
          { name: "actor", type: idType, suffix: "NOT NULL" },
          { name: "action", type: idType, suffix: "NOT NULL" },
          { name: "scope", type: idType, suffix: "NOT NULL" },
          { name: "entry", type: jsonType, suffix: "NOT NULL" },
        ],
      },
      {
        name: auditHead,
        primaryKey: ["id"],
        columns: [
          { name: "id", type: "INTEGER", suffix: "NOT NULL" },
          { name: "n", type: "INTEGER", suffix: "NOT NULL" },
          { name: "hash", type: idType, suffix: "NOT NULL" },
        ],
      },
      {
        name: checkpoints,
        primaryKey: ["n"],
        columns: [
          { name: "n", type: "INTEGER", suffix: "NOT NULL" },
          { name: "hash", type: idType, suffix: "NOT NULL" },
          { name: "at", type: timeType, suffix: "NOT NULL" },
          { name: "key_id", type: idType, suffix: "NOT NULL" },
          { name: "signature", type: longTextType, suffix: "NOT NULL" },
        ],
      },
      {
        name: counters,
        primaryKey: ["name"],
        columns: [
          { name: "name", type: idType, suffix: "NOT NULL" },
          { name: "count", type: "INTEGER", suffix: "NOT NULL" },
          { name: "expires_at", type: timeType, suffix: "NOT NULL" },
        ],
      },
      {
        name: changes,
        primaryKey: [],
        columns: [
          { name: "seq", type: serialType, retype: false },
          { name: "kind", type: idType, suffix: "NOT NULL" },
          { name: "id", type: idType, suffix: "NOT NULL" },
          { name: "revision", type: "INTEGER", suffix: "NOT NULL" },
          { name: "deleted", type: "INTEGER", suffix: "NOT NULL DEFAULT 0" },
          { name: "at", type: timeType, suffix: "NOT NULL" },
        ],
      },
    ],
    indexes: [
      {
        name: `ix_${prefix}docs_updated`,
        table: docs,
        columns: [
          "kind",
          "updated_at",
          dialect.codePointCollation === null
            ? "id"
            : { name: "id", collation: dialect.codePointCollation },
        ],
      },
      // Where ids sort in the database's locale (Postgres), a list by id is
      // ordered by code point, and needs its own index to read in that order.
      ...(dialect.codePointCollation === null
        ? []
        : [
            {
              name: `ix_${prefix}docs_id`,
              table: docs,
              columns: [
                "kind",
                { name: "id", collation: dialect.codePointCollation },
              ],
            },
          ]),
      {
        name: `ix_${prefix}audit_at`,
        table: audit,
        columns: ["at", "n"],
      },
      {
        name: `ix_${prefix}audit_actor`,
        table: audit,
        columns: ["actor", "n"],
      },
      {
        name: `ix_${prefix}versions_id`,
        table: versions,
        columns: ["policy_id", "id"],
      },
    ],
  };
}

/** What {@link sqlSecurityStore} is built from. */
export interface SqlSecurityStoreInit {
  /** The driver's name in messages: `sqlite`, `postgres`. */
  readonly name: string;
  /** The engine's dialect. */
  readonly dialect: SqlDialect;
  /** Opens the client; called once, on connect. */
  readonly open: () => SQL;
  /** The table prefix. */
  readonly prefix: string;
  /** What the driver can do. */
  readonly capabilities: SecurityStoreCapabilities;
  /** Run `syncSchema` on connect, with these options (`true`: the defaults). */
  readonly syncSchema?: boolean | SchemaSyncOptions;
  /** The clock, epoch milliseconds. */
  readonly now: () => number;
  /** Encodes every stored body and decodes it on the way out (storage.md §8's seam). Default: as given. */
  readonly codec?: StoreCodec;
  /**
   * Runs first in every mutating transaction, before any row is touched:
   * where an engine whose writers commit in parallel serialises them, so
   * change sequence numbers commit in order (Postgres: a transaction-scoped
   * advisory lock). Absent where the engine has one writer (SQLite).
   */
  readonly serialize?: (tx: SQL) => Promise<void>;
  /**
   * Runs in the transaction after each change row, with its sequence number:
   * where Postgres notifies the feed's listeners (delivered on commit).
   */
  readonly afterChange?: (tx: SQL, seq: bigint) => Promise<void>;
  /** The pushed change feed, where the engine has one. */
  readonly subscribe?: SecurityStoreDriver["subscribe"];
  /** Runs once the store is closed: where a listener's client is closed. */
  readonly onClose?: () => Promise<void>;
}

/** A stored row of the docs table. */
interface DocRow {
  kind: string;
  id: string;
  revision: number | bigint;
  doc: unknown;
  updated_at: number | bigint;
}

/** A stored row of the versions table. */
interface VersionRow {
  policy_id: string;
  number: number | bigint;
  id: string;
  policy: unknown;
  created_at: number | bigint;
  created_by: string | null;
  message: string | null;
}

/** A stored row of the changes table. */
/** A row of the bundles table. */
interface BundleRow {
  /** The service. */
  service_id: string;
  /** The bundle's version. */
  version: number | bigint;
  /** The bundle, as the dialect returns JSON. */
  bundle: unknown;
  /** When it was stored. */
  updated_at: number | bigint;
}

/** A row of the audit table. */
interface AuditRow {
  /** The entry's number. */
  n: number | bigint;
  /** Its predecessor's hash. */
  prev_hash: string;
  /** Its hash. */
  hash: string;
  /** When. */
  at: number | bigint;
  /** Who. */
  actor: string;
  /** What. */
  action: string;
  /** Where. */
  scope: string;
  /** The entry, as the dialect returns JSON. */
  entry: unknown;
}

/** A row of the checkpoints table. */
interface CheckpointRow {
  /** The entry it covers. */
  n: number | bigint;
  /** That entry's hash. */
  hash: string;
  /** When it was signed. */
  at: number | bigint;
  /** The audit key's id. */
  key_id: string;
  /** The signature. */
  signature: string;
}

interface ChangeRow {
  seq: number | bigint;
  kind: string;
  id: string;
  revision: number | bigint;
  deleted: number | bigint | boolean;
}

/** A statement's parameters, numbered in the order they are bound. */
class Params {
  /** The values, in order. */
  readonly values: unknown[] = [];
  constructor(
    /** The dialect whose placeholders are written. */
    private readonly dialect: SqlDialect,
  ) {}

  /** Binds a value; answers its placeholder. */
  readonly bind = (value: unknown): string => {
    this.values.push(value);
    return this.dialect.placeholder(this.values.length);
  };
}

/** The security store over a SQL engine; see the module's description. */
export function sqlSecurityStore(
  init: SqlSecurityStoreInit,
): SecurityStoreDriver {
  const { dialect, name, now } = init;
  if (!PREFIX.test(init.prefix)) {
    throw new ConfigError(
      `${name} security store: the table prefix must be letters, digits and _ (at most 40), starting with a letter or _; got "${init.prefix}"`,
      { prefix: init.prefix },
    );
  }
  if (!dialect.supportsReturning) {
    throw new ConfigError(
      `${name} security store: the ${dialect.name} engine is not supported yet`,
    );
  }
  const tables = storeTables(init.prefix);
  // Ids are ordered by code point on every engine, as the memory store
  // orders them: Postgres' TEXT sorts by the database's locale otherwise.
  const idOrder =
    dialect.codePointCollation === null
      ? "id"
      : `id COLLATE ${dialect.codePointCollation}`;
  const codec: StoreCodec = init.codec ?? {
    seal: (body) => body,
    open: (stored) => stored,
  };
  const definition = storeSchema(init.prefix, dialect);
  let client: SQL | undefined;
  let opening: Promise<SQL> | undefined;
  let closed = false;

  const backend = (sql: SQL) => ({
    all: async <T>(text: string, params: unknown[]) =>
      (await sql.unsafe(text, params)) as T[],
    run: async (text: string) => await sql.unsafe(text),
  });

  /** Brings the schema in line; answers every change. */
  const sync = async (
    sql: SQL,
    options: SchemaSyncOptions | boolean | undefined,
  ): Promise<SchemaChange[]> =>
    await syncSqlSchema(
      backend(sql),
      dialect,
      definition,
      resolveSyncOptions(options),
    );

  /** Opens the client and creates the schema; once. */
  const open = async (): Promise<SQL> => {
    const sql = init.open();
    try {
      for (const pragma of dialect.pragmas) {
        await sql.unsafe(pragma);
      }
      const existing = await readColumns(
        backend(sql),
        dialect,
        definition.tables.map((table) => table.name),
      );
      for (const statement of createSchema(definition, dialect, {
        existing: new Set(existing.keys()),
      })) {
        try {
          await sql.unsafe(statement);
        } catch (error) {
          if (
            !dialect.isDuplicateIndex(error) &&
            !dialect.isConcurrentCreate(error)
          ) {
            throw error;
          }
        }
      }
      if (init.syncSchema !== undefined && init.syncSchema !== false) {
        await sync(sql, init.syncSchema);
      }
      return sql;
    } catch (error) {
      await sql.close().catch(() => undefined);
      throw error;
    }
  };

  /** The client, opening it on first use; a failed open is not remembered. */
  const connection = async (): Promise<SQL> => {
    refuseClosed(name, closed);
    if (client !== undefined) return client;
    opening ??= open();
    try {
      client = await opening;
      return client;
    } finally {
      opening = undefined;
    }
  };

  /** A row of the docs table, as a document. */
  const docOf = (row: DocRow): StoredDoc =>
    Object.freeze({
      kind: row.kind as DocKind,
      id: row.id,
      revision: Number(row.revision),
      doc: codec.open(dialect.jsonOut(row.doc, null), {
        field: "doc",
        kind: row.kind as DocKind,
        id: row.id,
      }),
      updatedAt: Number(row.updated_at),
    });

  /** A row of the versions table, as a record. */
  const versionOf = (row: VersionRow): PolicyVersionRecord =>
    Object.freeze({
      policyId: row.policy_id,
      id: row.id,
      number: Number(row.number),
      policy: codec.open(dialect.jsonOut(row.policy, null), {
        field: "policy",
        kind: "policy",
        id: row.policy_id,
        version: row.id,
      }),
      createdAt: Number(row.created_at),
      createdBy: row.created_by ?? undefined,
      message: row.message ?? undefined,
    });

  /** Reads one document with `sql` (a transaction's, or the client). */
  const read = async (
    sql: SQL,
    kind: DocKind,
    id: string,
  ): Promise<StoredDoc | undefined> => {
    const p = new Params(dialect);
    const rows = (await sql.unsafe(
      `SELECT kind, id, revision, doc, updated_at FROM ${tables.docs}
        WHERE kind = ${p.bind(kind)} AND id = ${p.bind(id)}`,
      p.values,
    )) as DocRow[];
    return rows[0] === undefined ? undefined : docOf(rows[0]);
  };

  /** Appends a change row with `sql`; answers its sequence number. */
  /** The audit chain's head row. */
  const readAuditHead = async (sql: SQL): Promise<AuditHead | null> => {
    const rows = (await sql.unsafe(
      `SELECT n, hash FROM ${tables.auditHead} WHERE id = 1`,
    )) as {
      n: number | bigint;
      hash: string;
    }[];
    return rows[0] === undefined
      ? null
      : Object.freeze({ n: Number(rows[0].n), hash: rows[0].hash });
  };

  const record = async (
    sql: SQL,
    kind: ChangeKind,
    id: string,
    revision: number,
    deleted: boolean,
  ): Promise<bigint> => {
    const p = new Params(dialect);
    const rows = (await sql.unsafe(
      `INSERT INTO ${tables.changes} (kind, id, revision, deleted, at)
       VALUES (${p.bind(kind)}, ${p.bind(id)}, ${p.bind(revision)}, ${p.bind(deleted ? 1 : 0)}, ${p.bind(now())})
       RETURNING seq`,
      p.values,
    )) as { seq: number | bigint }[];
    const seq = BigInt(rows[0]!.seq);
    await init.afterChange?.(sql, seq);
    return seq;
  };

  /** Writes a document's new body and revision with `sql`. */
  const write = async (
    sql: SQL,
    kind: DocKind,
    id: string,
    body: unknown,
    ifRevision: number | null,
  ): Promise<boolean> => {
    const p = new Params(dialect);
    if (ifRevision === null) {
      const values = [
        p.bind(kind),
        p.bind(id),
        p.bind(1),
        p.bind(dialect.jsonIn(codec.seal(body, { field: "doc", kind, id }))),
        p.bind(now()),
      ];
      const result = await sql.unsafe(
        dialect.insertIgnore(
          tables.docs,
          ["kind", "id", "revision", "doc", "updated_at"],
          values,
        ),
        p.values,
      );
      return (await dialect.affectedRows(result, sql)) === 1;
    }
    const result = await sql.unsafe(
      `UPDATE ${tables.docs}
          SET doc = ${p.bind(dialect.jsonIn(codec.seal(body, { field: "doc", kind, id })))}, revision = revision + 1,
              updated_at = ${p.bind(now())}
        WHERE kind = ${p.bind(kind)} AND id = ${p.bind(id)}
          AND revision = ${p.bind(ifRevision)}`,
      p.values,
    );
    return (await dialect.affectedRows(result, sql)) === 1;
  };

  const store: SecurityStoreDriver = {
    name,
    capabilities: init.capabilities,
    connect: async () => {
      await connection();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      const open = client ?? (await opening?.catch(() => undefined));
      client = undefined;
      await init.onClose?.();
      await open?.close();
    },
    syncSchema: async (options) => await sync(await connection(), options),
    get: async (kind, id) => {
      checkKind(kind);
      checkId(id);
      return await read(await connection(), kind, id);
    },
    list: async (kind, query: ListQuery): Promise<Page<StoredDoc>> => {
      checkKind(kind);
      const resolved = resolveQuery(query);
      const after = docPosition(kind, resolved);
      const sql = await connection();
      const p = new Params(dialect);
      const where = [`kind = ${p.bind(kind)}`];
      if (resolved.prefix !== "") {
        where.push(
          `substr(id, 1, ${resolved.prefix.length}) = ${p.bind(resolved.prefix)}`,
        );
      }
      const dir = resolved.direction === "asc" ? "ASC" : "DESC";
      if (after !== undefined) {
        where.push(
          resolved.sort === "id"
            ? `${idOrder} ${resolved.direction === "asc" ? ">" : "<"} ${p.bind(after.id)}`
            : keysetAfter(dialect, p.bind, {
                columns: ["updated_at"],
                values: [after.value as number],
                idColumn: idOrder,
                id: after.id,
                direction: resolved.direction,
              }),
        );
      }
      const order =
        resolved.sort === "id"
          ? `${idOrder} ${dir}`
          : `updated_at ${dir}, ${idOrder} ${dir}`;
      const rows = (await sql.unsafe(
        `SELECT kind, id, revision, doc, updated_at FROM ${tables.docs}
          WHERE ${where.join(" AND ")}
          ORDER BY ${order}
          LIMIT ${resolved.limit + 1}`,
        p.values,
      )) as DocRow[];
      const items = rows.slice(0, resolved.limit).map(docOf);
      const last = items.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        ...(rows.length > resolved.limit && last !== undefined
          ? { next: docCursor(kind, resolved, last) }
          : {}),
      });
    },
    put: async (kind, id, doc, ifRevision): Promise<PutResult> => {
      checkKind(kind);
      checkId(id);
      checkRevision(ifRevision, true);
      refusePolicyWrite(kind, "put()");
      const body = jsonBody(doc, "a document");
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        if (!(await write(tx, kind, id, body, ifRevision))) {
          return Object.freeze({
            ok: false as const,
            conflict: await read(tx, kind, id),
          });
        }
        const revision = (ifRevision ?? 0) + 1;
        return Object.freeze({
          ok: true as const,
          revision,
          seq: await record(tx, kind, id, revision, false),
        });
      });
    },
    delete: async (kind, id, ifRevision) => {
      checkKind(kind);
      checkId(id);
      checkRevision(ifRevision, false);
      refusePolicyWrite(kind, "delete()");
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        const p = new Params(dialect);
        const result = await tx.unsafe(
          `DELETE FROM ${tables.docs}
            WHERE kind = ${p.bind(kind)} AND id = ${p.bind(id)}
              AND revision = ${p.bind(ifRevision)}`,
          p.values,
        );
        if ((await dialect.affectedRows(result, tx)) !== 1) return false;
        await record(tx, kind, id, ifRevision, true);
        return true;
      });
    },
    appendVersion: async (
      policyId,
      version: PolicyVersionInput,
      expectedHead,
    ): Promise<AppendResult> => {
      checkId(policyId, "a policy id");
      if (expectedHead !== null) checkId(expectedHead, "a head");
      const input = checkVersionInput(version, now);
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        const current = await read(tx, "policy", policyId);
        const head =
          current === undefined ? null : (current.doc as { head: string }).head;
        const number =
          current === undefined
            ? 1
            : (current.doc as { number: number }).number + 1;
        const p = new Params(dialect);
        const taken = (await tx.unsafe(
          `SELECT id FROM ${tables.versions}
            WHERE policy_id = ${p.bind(policyId)} AND id = ${p.bind(input.id)}`,
          p.values,
        )) as unknown[];
        if (head !== expectedHead || taken.length > 0) {
          return Object.freeze({ ok: false as const, head });
        }
        const q = new Params(dialect);
        await tx.unsafe(
          `INSERT INTO ${tables.versions}
             (policy_id, number, id, policy, created_at, created_by, message)
           VALUES (${q.bind(policyId)}, ${q.bind(number)}, ${q.bind(input.id)},
                   ${q.bind(dialect.jsonIn(codec.seal(input.policy, { field: "policy", kind: "policy", id: policyId, version: input.id })))}, ${q.bind(input.createdAt)},
                   ${q.bind(input.createdBy ?? null)}, ${q.bind(input.message ?? null)})`,
          q.values,
        );
        const ifRevision = current?.revision ?? null;
        if (
          !(await write(
            tx,
            "policy",
            policyId,
            { head: input.id, number },
            ifRevision,
          ))
        ) {
          // Unreachable inside the transaction; refused rather than forked.
          throw new Error(
            `${name} security store: the head of "${policyId}" moved inside its own transaction`,
          );
        }
        return Object.freeze({
          ok: true as const,
          seq: await record(
            tx,
            "policy",
            policyId,
            (ifRevision ?? 0) + 1,
            false,
          ),
        });
      });
    },
    getVersion: async (policyId, versionId) => {
      checkId(policyId, "a policy id");
      checkId(versionId, "a version id");
      const sql = await connection();
      const p = new Params(dialect);
      const rows = (await sql.unsafe(
        `SELECT policy_id, number, id, policy, created_at, created_by, message
           FROM ${tables.versions}
          WHERE policy_id = ${p.bind(policyId)} AND id = ${p.bind(versionId)}`,
        p.values,
      )) as VersionRow[];
      return rows[0] === undefined ? undefined : versionOf(rows[0]);
    },
    listVersions: async (policyId, query) => {
      checkId(policyId, "a policy id");
      const resolved = resolveQuery(query);
      const after = versionPosition(policyId, resolved);
      const desc = resolved.direction === "desc";
      const sql = await connection();
      const p = new Params(dialect);
      const where = [`policy_id = ${p.bind(policyId)}`];
      if (after !== undefined) {
        where.push(`number ${desc ? "<" : ">"} ${p.bind(after)}`);
      }
      const rows = (await sql.unsafe(
        `SELECT policy_id, number, id, policy, created_at, created_by, message
           FROM ${tables.versions}
          WHERE ${where.join(" AND ")}
          ORDER BY number ${desc ? "DESC" : "ASC"}
          LIMIT ${resolved.limit + 1}`,
        p.values,
      )) as VersionRow[];
      const items = rows.slice(0, resolved.limit).map(versionOf);
      const last = items.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        ...(rows.length > resolved.limit && last !== undefined
          ? { next: versionCursor(policyId, resolved, last) }
          : {}),
      });
    },
    putBundle: async (
      serviceId,
      bundle: BundleInput,
      expectedVersion,
    ): Promise<PutBundleResult> => {
      checkId(serviceId, "a service id");
      const input = checkBundleInput(bundle, expectedVersion);
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        const p = new Params(dialect);
        const rows = (await tx.unsafe(
          `SELECT version FROM ${tables.bundles} WHERE service_id = ${p.bind(serviceId)}`,
          p.values,
        )) as { version: number | bigint }[];
        const stored = rows[0] === undefined ? null : Number(rows[0].version);
        if (stored !== expectedVersion || input.version <= (stored ?? 0)) {
          return Object.freeze({ ok: false as const, version: stored });
        }
        const body = dialect.jsonIn(
          codec.seal(input.bundle, {
            field: "bundle",
            kind: "bundle",
            id: serviceId,
          }),
        );
        const q = new Params(dialect);
        if (stored === null) {
          const result = await tx.unsafe(
            dialect.insertIgnore(
              tables.bundles,
              ["service_id", "version", "bundle", "updated_at"],
              [
                q.bind(serviceId),
                q.bind(input.version),
                q.bind(body),
                q.bind(now()),
              ],
            ),
            q.values,
          );
          if ((await dialect.affectedRows(result, tx)) !== 1) {
            return Object.freeze({ ok: false as const, version: null });
          }
        } else {
          const result = await tx.unsafe(
            `UPDATE ${tables.bundles}
                SET version = ${q.bind(input.version)}, bundle = ${q.bind(body)},
                    updated_at = ${q.bind(now())}
              WHERE service_id = ${q.bind(serviceId)} AND version = ${q.bind(stored)}`,
            q.values,
          );
          if ((await dialect.affectedRows(result, tx)) !== 1) {
            return Object.freeze({ ok: false as const, version: stored });
          }
        }
        return Object.freeze({
          ok: true as const,
          seq: await record(tx, "bundle", serviceId, input.version, false),
        });
      });
    },
    getBundle: async (serviceId, ifNoneMatch) => {
      checkId(serviceId, "a service id");
      const sql = await connection();
      const p = new Params(dialect);
      const rows = (await sql.unsafe(
        `SELECT service_id, version, bundle, updated_at FROM ${tables.bundles}
          WHERE service_id = ${p.bind(serviceId)}`,
        p.values,
      )) as BundleRow[];
      const row = rows[0];
      if (row === undefined) return undefined;
      const version = Number(row.version);
      const etag = bundleEtag(version);
      if (ifNoneMatch !== undefined && ifNoneMatch === etag)
        return "not-modified";
      return Object.freeze({
        serviceId: row.service_id,
        version,
        etag,
        bundle: codec.open(dialect.jsonOut(row.bundle, null), {
          field: "bundle",
          kind: "bundle",
          id: row.service_id,
        }),
        updatedAt: Number(row.updated_at),
      } satisfies StoredBundle);
    },
    ...(init.subscribe === undefined ? {} : { subscribe: init.subscribe }),
    appendAudit: async (
      input,
      expectedPrevHash,
    ): Promise<AppendAuditResult> => {
      const entry = checkAuditInput(input, expectedPrevHash);
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        // The store's write lock first (Postgres: an advisory lock), so two
        // hosts appending at once never fork the chain.
        await init.serialize?.(tx);
        const head = await readAuditHead(tx);
        if ((head?.hash ?? null) !== expectedPrevHash) {
          return Object.freeze({ ok: false as const, head });
        }
        const n = (head?.n ?? 0) + 1;
        const p = new Params(dialect);
        if (head === null) {
          const result = await tx.unsafe(
            dialect.insertIgnore(
              tables.auditHead,
              ["id", "n", "hash"],
              [p.bind(1), p.bind(n), p.bind(entry.hash)],
            ),
            p.values,
          );
          if ((await dialect.affectedRows(result, tx)) !== 1) {
            return Object.freeze({
              ok: false as const,
              head: await readAuditHead(tx),
            });
          }
        } else {
          const result = await tx.unsafe(
            `UPDATE ${tables.auditHead} SET n = ${p.bind(n)}, hash = ${p.bind(entry.hash)}
              WHERE id = 1 AND hash = ${p.bind(head.hash)}`,
            p.values,
          );
          if ((await dialect.affectedRows(result, tx)) !== 1) {
            return Object.freeze({
              ok: false as const,
              head: await readAuditHead(tx),
            });
          }
        }
        const q = new Params(dialect);
        await tx.unsafe(
          `INSERT INTO ${tables.audit} (n, prev_hash, hash, at, actor, action, scope, entry)
           VALUES (${q.bind(n)}, ${q.bind(entry.prevHash)}, ${q.bind(entry.hash)}, ${q.bind(entry.at)},
                   ${q.bind(entry.actor)}, ${q.bind(entry.action)}, ${q.bind(entry.scope)},
                   ${q.bind(dialect.jsonIn(codec.seal(entry.entry, { field: "doc", kind: "audit", id: String(n) })))})`,
          q.values,
        );
        return Object.freeze({
          ok: true as const,
          n,
          seq: await record(tx, "audit", String(n), n, false),
        });
      });
    },
    getAuditHead: async () => await readAuditHead(await connection()),
    listAudit: async (query) => {
      const resolved = resolveAuditQuery(query);
      const after = auditPosition(resolved);
      const f = resolved.filter;
      const desc = resolved.direction === "desc";
      const sql = await connection();
      const p = new Params(dialect);
      const where: string[] = [];
      if (f.actor !== "") where.push(`actor = ${p.bind(f.actor)}`);
      if (f.action !== "") where.push(`action = ${p.bind(f.action)}`);
      if (f.scope !== "") where.push(`scope = ${p.bind(f.scope)}`);
      if (f.scopes !== null)
        where.push(
          `scope IN (${f.scopes.map((scope) => p.bind(scope)).join(", ")})`,
        );
      if (f.since >= 0) where.push(`at >= ${p.bind(f.since)}`);
      if (f.until >= 0) where.push(`at < ${p.bind(f.until)}`);
      if (f.fromN >= 0) where.push(`n >= ${p.bind(f.fromN)}`);
      if (f.toN >= 0) where.push(`n <= ${p.bind(f.toN)}`);
      if (after !== undefined)
        where.push(`n ${desc ? "<" : ">"} ${p.bind(after)}`);
      const rows = (await sql.unsafe(
        `SELECT n, prev_hash, hash, at, actor, action, scope, entry FROM ${tables.audit}
          ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
          ORDER BY n ${desc ? "DESC" : "ASC"}
          LIMIT ${resolved.limit + 1}`,
        p.values,
      )) as AuditRow[];
      const items = rows.slice(0, resolved.limit).map((row): AuditRecord =>
        Object.freeze({
          n: Number(row.n),
          prevHash: row.prev_hash,
          hash: row.hash,
          at: Number(row.at),
          actor: row.actor,
          action: row.action,
          scope: row.scope,
          entry: codec.open(dialect.jsonOut(row.entry, null), {
            field: "doc",
            kind: "audit",
            id: String(row.n),
          }),
        }),
      );
      const last = items.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        ...(rows.length > resolved.limit && last !== undefined
          ? { next: auditCursor(resolved, last.n) }
          : {}),
      });
    },
    appendCheckpoint: async (checkpoint) => {
      const cp = checkCheckpoint(checkpoint);
      const sql = await connection();
      await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        const p = new Params(dialect);
        await tx.unsafe(
          dialect.insertIgnore(
            tables.checkpoints,
            ["n", "hash", "at", "key_id", "signature"],
            [
              p.bind(cp.n),
              p.bind(cp.hash),
              p.bind(cp.at),
              p.bind(cp.keyId),
              p.bind(cp.signature),
            ],
          ),
          p.values,
        );
      });
    },
    listCheckpoints: async (query) => {
      const direction = query.direction ?? "asc";
      const resolved = resolveQuery({ limit: query.limit, direction });
      const after = checkpointPosition(query.cursor, direction);
      const sql = await connection();
      const p = new Params(dialect);
      const rows = (await sql.unsafe(
        `SELECT n, hash, at, key_id, signature FROM ${tables.checkpoints}
          ${after === undefined ? "" : `WHERE n ${direction === "asc" ? ">" : "<"} ${p.bind(after)}`}
          ORDER BY n ${direction === "asc" ? "ASC" : "DESC"}
          LIMIT ${resolved.limit + 1}`,
        p.values,
      )) as CheckpointRow[];
      const items = rows.slice(0, resolved.limit).map((row): AuditCheckpoint =>
        Object.freeze({
          n: Number(row.n),
          hash: row.hash,
          at: Number(row.at),
          keyId: row.key_id,
          signature: row.signature,
        }),
      );
      const last = items.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        ...(rows.length > resolved.limit && last !== undefined
          ? { next: checkpointCursor(direction, last.n) }
          : {}),
      });
    },
    deleteAuditBefore: async (beforeN, limit) => {
      if (
        !Number.isSafeInteger(beforeN) ||
        !Number.isSafeInteger(limit) ||
        limit < 1
      ) {
        throw new ConfigError(
          "security store: deleteAuditBefore takes a number and a positive limit",
        );
      }
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        const p = new Params(dialect);
        const rows = (await tx.unsafe(
          `SELECT n FROM ${tables.audit} WHERE n < ${p.bind(beforeN)} ORDER BY n ASC LIMIT ${limit}`,
          p.values,
        )) as { n: number | bigint }[];
        if (rows.length === 0) return 0;
        const q = new Params(dialect);
        const result = await tx.unsafe(
          `DELETE FROM ${tables.audit} WHERE n >= ${q.bind(Number(rows[0]!.n))} AND n <= ${q.bind(Number(rows.at(-1)!.n))}`,
          q.values,
        );
        return await dialect.affectedRows(result, tx);
      });
    },
    // Counters and claims: one upsert each (RETURNING, on SQLite and
    // Postgres alike), under the store's write lock where the engine has one.
    incrementCounter: async (key, ttlMs) => {
      checkCounter(key, ttlMs);
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        const at = now();
        const p = new Params(dialect);
        const name = p.bind(key);
        const expires = p.bind(at + ttlMs);
        const live = p.bind(at);
        const rows = (await tx.unsafe(
          `INSERT INTO ${tables.counters} (name, count, expires_at) VALUES (${name}, 1, ${expires})
            ON CONFLICT (name) DO UPDATE SET
              count = CASE WHEN ${tables.counters}.expires_at > ${live} THEN ${tables.counters}.count + 1 ELSE 1 END,
              expires_at = excluded.expires_at
            RETURNING count, expires_at`,
          p.values,
        )) as { count: number | bigint; expires_at: number | bigint }[];
        const row = rows[0]!;
        return Object.freeze({
          count: Number(row.count),
          expiresAt: Number(row.expires_at),
        });
      });
    },
    getCounter: async (key) => {
      checkCounter(key);
      const sql = await connection();
      const p = new Params(dialect);
      const rows = (await sql.unsafe(
        `SELECT count, expires_at FROM ${tables.counters} WHERE name = ${p.bind(key)} AND expires_at > ${p.bind(now())}`,
        p.values,
      )) as { count: number | bigint; expires_at: number | bigint }[];
      const row = rows[0];
      return row === undefined
        ? undefined
        : Object.freeze({
            count: Number(row.count),
            expiresAt: Number(row.expires_at),
          });
    },
    resetCounter: async (key) => {
      checkCounter(key);
      const sql = await connection();
      await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        const p = new Params(dialect);
        await tx.unsafe(
          `DELETE FROM ${tables.counters} WHERE name = ${p.bind(key)}`,
          p.values,
        );
      });
    },
    claimKey: async (key, ttlMs) => {
      checkCounter(key, ttlMs);
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        const at = now();
        const p = new Params(dialect);
        const name = p.bind(key);
        const expires = p.bind(at + ttlMs);
        const live = p.bind(at);
        const rows = (await tx.unsafe(
          `INSERT INTO ${tables.counters} (name, count, expires_at) VALUES (${name}, 1, ${expires})
            ON CONFLICT (name) DO UPDATE SET count = 1, expires_at = excluded.expires_at
              WHERE ${tables.counters}.expires_at <= ${live}
            RETURNING name`,
          p.values,
        )) as unknown[];
        return rows.length === 1;
      });
    },
    changesSince: async (since, limit) => {
      checkFeedRead(since, limit);
      const sql = await connection();
      const p = new Params(dialect);
      const rows = (await sql.unsafe(
        `SELECT seq, kind, id, revision, deleted FROM ${tables.changes}
          WHERE seq > ${p.bind(since)}
          ORDER BY seq ASC
          LIMIT ${limit}`,
        p.values,
      )) as ChangeRow[];
      const [top] = (await sql.unsafe(
        `SELECT MAX(seq) AS head FROM ${tables.changes}`,
      )) as { head: number | bigint | null }[];
      return Object.freeze({
        changes: Object.freeze(
          rows.map((row): Change =>
            Object.freeze({
              seq: BigInt(row.seq),
              kind: row.kind as ChangeKind,
              id: row.id,
              revision: Number(row.revision),
              deleted: Boolean(Number(row.deleted)),
            }),
          ),
        ),
        head: top?.head == null ? 0n : BigInt(top.head),
      });
    },
  };
  return Object.freeze(store);
}
