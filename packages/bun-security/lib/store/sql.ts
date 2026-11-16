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
  AppendResult,
  Change,
  DocKind,
  ListQuery,
  Page,
  PolicyVersionInput,
  PolicyVersionRecord,
  PutResult,
  SecurityStoreCapabilities,
  SecurityStoreDriver,
  StoreCodec,
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
} {
  return {
    docs: `${prefix}docs`,
    versions: `${prefix}versions`,
    changes: `${prefix}changes`,
  };
}

/** The store's schema under `prefix`, in `dialect`'s types. */
export function storeSchema(
  prefix: string,
  dialect: SqlDialect,
): SchemaDefinition {
  const { docs, versions, changes } = storeTables(prefix);
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
        columns: ["kind", "updated_at", "id"],
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
  const record = async (
    sql: SQL,
    kind: DocKind,
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
    return BigInt(rows[0]!.seq);
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
            ? `id ${resolved.direction === "asc" ? ">" : "<"} ${p.bind(after.id)}`
            : keysetAfter(dialect, p.bind, {
                columns: ["updated_at"],
                values: [after.value as number],
                idColumn: "id",
                id: after.id,
                direction: resolved.direction,
              }),
        );
      }
      const order =
        resolved.sort === "id" ? `id ${dir}` : `updated_at ${dir}, id ${dir}`;
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
              kind: row.kind as DocKind,
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
