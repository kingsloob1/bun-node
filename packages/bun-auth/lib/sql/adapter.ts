/**
 * `bunSqlAdapter`: better-auth's database adapter on bun-sql, for Postgres,
 * MySQL, MariaDB and SQLite (`docs/plans/bun-auth/sql-adapter.md`).
 *
 * Built on better-auth's `createAdapterFactory`, which maps model and field
 * names, generates ids and converts values; this module runs the queries.
 * What differs between the engines is bun-sql's dialect, plus three choices
 * of the adapter's own:
 *
 * - **No `RETURNING` on MySQL and MariaDB.** A write that must hand back its
 *   row reads it again by id; the atomic `consumeOne` and `incrementOne`
 *   lock the row with `SELECT … FOR UPDATE` in a transaction first. On
 *   Postgres and SQLite each is one statement.
 * - **Values.** better-auth's factory turns booleans into `1`/`0` on MySQL,
 *   MariaDB and SQLite, dates into ISO 8601 text on SQLite, and every JSON
 *   value into its text; on Postgres that text is cast to JSON as it is bound
 *   (bun-sql's `jsonParameter`), or `JSONB` would store it as a JSON string.
 *   Numbers the client returns as text (Postgres's `BIGINT`) come back as
 *   numbers.
 * - **SQLite is one connection.** Every statement on a SQLite client runs
 *   under one lock, and a transaction holds it throughout, so another
 *   request's statement can never land inside it. A statement issued from
 *   inside the transaction's own async context runs on directly.
 */
import type { SQL } from "bun";
import type { SqlConnectionOptions } from "@kingsleyweb/bun-sql/connection";
import type { SqlAdapter, SqlDialect } from "@kingsleyweb/bun-sql/dialect";
import type { SchemaSyncOptions } from "@kingsleyweb/bun-sql/sync";
import type { BetterAuthOptions } from "better-auth";
import type {
  AdapterFactoryConfig,
  AdapterFactoryCustomizeAdapterCreator,
  CleanedWhere,
  CustomAdapter,
  DBAdapter,
  DBAdapterDebugLogOption,
  JoinConfig,
} from "better-auth/adapters";
import type { AuthSchema, AuthTable } from "./schema";
import type { AuthSchemaChange, SchemaRunner } from "./sync";
import type { Binder } from "./where";
import { AsyncLocalStorage } from "node:async_hooks";
import { ConfigError } from "@kingsleyweb/bun-common/lib/errors";
import { Mutex } from "@kingsleyweb/bun-common/lib/utils/native";
import { openSqlClient } from "@kingsleyweb/bun-sql/connection";
import { detectAdapter, dialectFor } from "@kingsleyweb/bun-sql/dialect";
import { createAdapterFactory } from "better-auth/adapters";
import { getAuthTables } from "better-auth/db";
import { quoteIdentifier } from "./identifiers";
import { buildAuthSchema } from "./schema";
import { renderScript, syncAuthSchema } from "./sync";
import { compileWhere, createBinder } from "./where";

/** Options for {@link bunSqlAdapter}. */
export interface BunSqlAdapterOptions {
  /**
   * An existing Bun `SQL` client to run on. The adapter never closes it.
   * Its engine is read from the client (`sql.options.adapter`) unless
   * {@link BunSqlAdapterOptions.adapter} says otherwise. Takes precedence
   * over `url` and `connection`.
   */
  sql?: SQL;
  /**
   * A connection URL: `postgres://…`, `mysql://…`, `mariadb://…`,
   * `sqlite://path`, `:memory:` or a file path. The adapter opens a client
   * for it and closes it in {@link BunSqlAdapter.close}. On MySQL and MariaDB
   * `allowPublicKeyRetrieval=true` is taken out of the URL and passed as the
   * client option Bun honours (bun-sql's `sqlClientOptions`).
   */
  url?: string;
  /** The connection as fields, used when `url` is absent; needs {@link BunSqlAdapterOptions.adapter}. */
  connection?: SqlConnectionOptions;
  /**
   * The engine: `postgres`, `mysql`, `mariadb` or `sqlite`. Detected from
   * the URL's scheme or the client when absent. A `mysql://` URL to a MariaDB
   * server needs `adapter: "mariadb"`, whose identifier collation differs.
   */
  adapter?: SqlAdapter;
  /**
   * Put before every table name: `"auth_"` makes better-auth's `user` table
   * `auth_user`. Default `""`, the model names as they are.
   */
  prefix?: string;
  /**
   * Create and sync better-auth's tables before the first query of each
   * better-auth instance: `true` for a default sync (adds what is missing,
   * changes nothing that rewrites a table), or bun-sql's
   * `SchemaSyncOptions`. Default `false`: run {@link BunSqlAdapter.syncSchema}
   * yourself, or the SQL better-auth's CLI `generate` writes.
   */
  syncSchema?: boolean | SchemaSyncOptions;
  /** better-auth's `usePlural`: table names end in `s`. Default `false`. */
  usePlural?: boolean;
  /**
   * Whether better-auth's multi-step writes run in a transaction (Bun SQL's
   * `begin` on Postgres, a reserved connection in `READ COMMITTED` on MySQL
   * and MariaDB, `BEGIN IMMEDIATE` on SQLite: bun-sql's dialects). Default
   * `true`.
   */
  transaction?: boolean;
  /** better-auth's adapter debug logs. Default off. */
  debugLogs?: DBAdapterDebugLogOption;
  /** Most connections a client the adapter opens pools. Bun's default when absent. */
  max?: number;
}

/**
 * The adapter: pass it as better-auth's `database`. Also syncs the schema
 * and closes the client it opened.
 */
export interface BunSqlAdapter {
  /** better-auth calls this with its options; it returns the adapter. */
  (options: BetterAuthOptions): DBAdapter<BetterAuthOptions>;
  /** The engine the adapter runs on. */
  readonly engine: SqlAdapter;
  /**
   * Creates better-auth's missing tables and syncs existing ones for
   * `options` (the same options given to `betterAuth`, so its plugins'
   * tables are included). Returns every change found; `{ dryRun: true }`
   * changes nothing. Bun-sql's rules: a column retype runs only with
   * `alterColumns`.
   */
  syncSchema: (
    options: BetterAuthOptions,
    sync?: SchemaSyncOptions | boolean,
  ) => Promise<AuthSchemaChange[]>;
  /** Closes the client the adapter opened from `url` or `connection`; a client passed as `sql` is left open. */
  close: () => Promise<void>;
}

/** Locks per SQLite client: one connection, so one statement or transaction at a time. */
const SQLITE_LOCKS = new WeakMap<SQL, Mutex>();

/** The SQLite client whose transaction the current async context is inside. */
const SQLITE_TRANSACTION = new AsyncLocalStorage<SQL>();

/** Everything the adapter's queries share. */
interface Context {
  /** The engine. */
  readonly engine: SqlAdapter;
  /** Its bun-sql dialect. */
  readonly dialect: SqlDialect;
  /** The table name prefix. */
  readonly prefix: string;
  /** better-auth's `usePlural`. */
  readonly usePlural: boolean;
  /** Runs `work` under the client's lock where the engine needs one. */
  readonly exclusive: <T>(client: SQL, work: () => Promise<T>) => Promise<T>;
}

/**
 * A joining column's value as a map key: ids and references arrive as text,
 * or as numbers (serial ids; Postgres's `BIGINT` as text), and both sides of
 * a join must key alike.
 */
function joinKey(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" || typeof value === "bigint"
    ? value.toString()
    : JSON.stringify(value);
}

/** Whether `value` is a non-negative safe integer, as a `LIMIT` or `OFFSET` must be. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The rows a statement returned, as plain records. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

/** Whether ids are the engine's auto-increment integers. */
function usesNumericIds(options: BetterAuthOptions): boolean {
  return options.advanced?.database?.generateId === "serial";
}

/**
 * The adapter's queries over one client: the pool, or a transaction's
 * connection (`inTransaction`), where nothing takes the SQLite lock or opens
 * a transaction of its own.
 */
function createQueries(
  context: Context,
  client: SQL,
  inTransaction: boolean,
  ready: (schema: AuthSchema) => Promise<void>,
): AdapterFactoryCustomizeAdapterCreator {
  const { engine, dialect, prefix, usePlural } = context;
  const q = (name: string) => quoteIdentifier(engine, name);
  const mysqlFamily = engine === "mysql" || engine === "mariadb";

  return ({ options, schema, getFieldName, getDefaultModelName }) => {
    const authSchema = buildAuthSchema(schema, {
      engine,
      dialect,
      prefix,
      usePlural,
      numericIds: usesNumericIds(options),
    });

    /** Runs one statement, under the lock where needed. */
    const run = async (
      text: string,
      params: readonly unknown[] = [],
      on: SQL = client,
    ): Promise<unknown> => {
      if (!inTransaction) {
        await ready(authSchema);
      }
      const query = async (): Promise<unknown> =>
        (await on.unsafe(text, [...params])) as unknown;
      return inTransaction || on !== client
        ? query()
        : context.exclusive(client, query);
    };

    /** Runs `work` in a transaction of its own, or in the one already open. */
    const atomically = async <T>(work: (tx: SQL) => Promise<T>): Promise<T> => {
      if (inTransaction) {
        return work(client);
      }
      await ready(authSchema);
      return transact(context, client, work);
    };

    /** The table for a model, by its name or its key in the schema. */
    const tableFor = (model: string, modelKey?: string): AuthTable => {
      const table =
        authSchema.byModel.get(model) ??
        authSchema.tables.find(
          (candidate) =>
            candidate.key === (modelKey ?? getDefaultModelName(model)),
        );
      if (!table) {
        throw new Error(
          `bun-auth's SQL adapter has no table for the model "${model}": it is not in better-auth's schema`,
        );
      }
      return table;
    };

    const binder = (): Binder => createBinder(dialect.placeholder);
    const where = (
      table: AuthTable,
      clauses: readonly CleanedWhere[] | undefined,
      bind: Binder,
    ): string => {
      const condition = compileWhere(engine, clauses, q, bind);
      return condition === "" ? "" : ` WHERE ${condition}`;
    };
    const and = (condition: string, extra: string): string =>
      condition === "" ? ` WHERE ${extra}` : `${condition} AND ${extra}`;

    /** Binds a value for a column, cast to JSON on Postgres where the column holds a document. */
    const bindValue = (
      table: AuthTable,
      column: string,
      value: unknown,
      bind: Binder,
    ): string => {
      const placeholder = bind.bind(value);
      const json = table.columns.find((c) => c.name === column)?.json === true;
      return json ? dialect.jsonParameter(placeholder) : placeholder;
    };

    /** `SET a = $1, b = b + $2` for an update's values and increments. */
    const assignments = (
      table: AuthTable,
      values: Record<string, unknown>,
      increments: Record<string, number>,
      bind: Binder,
    ): string[] => [
      ...Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(
          ([column, value]) =>
            `${q(column)} = ${bindValue(table, column, value, bind)}`,
        ),
      ...Object.entries(increments).map(
        ([column, delta]) =>
          `${q(column)} = ${q(column)} + ${bind.bind(delta)}`,
      ),
    ];

    /** Reads one row by id. */
    const byId = async (
      table: AuthTable,
      id: unknown,
      on: SQL = client,
    ): Promise<Record<string, unknown> | null> => {
      const bind = binder();
      const rows = rowsOf(
        await run(
          `SELECT * FROM ${q(table.name)} WHERE ${q("id")} = ${bind.bind(id)}`,
          bind.params,
          on,
        ),
      );
      return rows[0] ?? null;
    };

    /** The columns a `select` names, or every column. */
    const columnsOf = (modelKey: string, select?: readonly string[]): string =>
      select && select.length > 0
        ? select
            .map((field) => q(getFieldName({ model: modelKey, field })))
            .join(", ")
        : "*";

    /**
     * Fills each row's joined models (better-auth's `join`, with
     * `experimental.joins`): one query per joined model for all the rows,
     * by `IN` on the joining column, grouped back onto each row.
     */
    const attachJoins = async (
      rows: Record<string, unknown>[],
      join: JoinConfig | undefined,
    ): Promise<Record<string, unknown>[]> => {
      if (!join || rows.length === 0) {
        return rows;
      }
      for (const [joinModel, config] of Object.entries(join)) {
        const table = tableFor(joinModel, config.modelKey);
        const one = config.relation === "one-to-one";
        const limit = config.limit ?? 100;
        const keys = [
          ...new Set(
            rows
              .map((row) => row[config.on.from])
              .filter((value) => value !== null && value !== undefined)
              .map(joinKey),
          ),
        ];
        const groups = new Map<string, Record<string, unknown>[]>();
        for (let at = 0; at < keys.length; at += 500) {
          const chunk = keys.slice(at, at + 500);
          const bind = binder();
          const list = chunk.map((key) => bind.bind(key)).join(", ");
          const found = rowsOf(
            await run(
              `SELECT * FROM ${q(table.name)} WHERE ${q(config.on.to)} IN (${list}) ORDER BY ${q(config.on.to)}, ${q("id")}`,
              bind.params,
            ),
          );
          for (const row of found) {
            const key = joinKey(row[config.on.to]);
            const group = groups.get(key) ?? [];
            group.push(row);
            groups.set(key, group);
          }
        }
        for (const row of rows) {
          const value = row[config.on.from];
          const group =
            value === null || value === undefined
              ? []
              : (groups.get(joinKey(value)) ?? []);
          row[joinModel] = one ? (group[0] ?? null) : group.slice(0, limit);
        }
      }
      return rows;
    };

    const adapter: CustomAdapter = {
      create: async <T extends Record<string, unknown>>({
        model,
        modelKey,
        data,
      }: {
        model: string;
        modelKey?: string;
        data: T;
      }): Promise<T> => {
        const table = tableFor(model, modelKey);
        const entries = Object.entries(data).filter(
          ([, value]) => value !== undefined,
        );
        const bind = binder();
        const columns = entries.map(([column]) => q(column)).join(", ");
        const values = entries
          .map(([column, value]) => bindValue(table, column, value, bind))
          .join(", ");
        const insert =
          entries.length === 0
            ? mysqlFamily
              ? `INSERT INTO ${q(table.name)} () VALUES ()`
              : `INSERT INTO ${q(table.name)} DEFAULT VALUES`
            : `INSERT INTO ${q(table.name)} (${columns}) VALUES (${values})`;
        if (!mysqlFamily) {
          const rows = rowsOf(await run(`${insert} RETURNING *`, bind.params));
          return rows[0] as T;
        }
        const result = await run(insert, bind.params);
        const id =
          (data as Record<string, unknown>).id ??
          (result as { lastInsertRowid?: unknown }).lastInsertRowid;
        const row = await byId(table, id);
        if (!row) {
          throw new Error(
            `bun-auth's SQL adapter could not read back the row it inserted into "${table.name}"`,
          );
        }
        return row as T;
      },

      findOne: async <T>({
        model,
        modelKey,
        where: clauses,
        select,
        join,
      }: {
        model: string;
        modelKey?: string;
        where: CleanedWhere[];
        select?: string[];
        join?: JoinConfig;
      }): Promise<T | null> => {
        const table = tableFor(model, modelKey);
        const bind = binder();
        const rows = rowsOf(
          await run(
            `SELECT ${columnsOf(table.key, select)} FROM ${q(table.name)}${where(table, clauses, bind)} LIMIT 1`,
            bind.params,
          ),
        );
        const [row] = await attachJoins(rows, join);
        return (row ?? null) as T | null;
      },

      findMany: async <T>({
        model,
        modelKey,
        where: clauses,
        limit,
        select,
        sortBy,
        offset,
        join,
      }: {
        model: string;
        modelKey?: string;
        where?: CleanedWhere[];
        limit: number;
        select?: string[];
        sortBy?: { field: string; direction: "asc" | "desc" };
        offset?: number;
        join?: JoinConfig;
      }): Promise<T[]> => {
        const table = tableFor(model, modelKey);
        const bind = binder();
        let text = `SELECT ${columnsOf(table.key, select)} FROM ${q(table.name)}${where(table, clauses, bind)}`;
        // A stable order whenever a page is asked for: offset paging over an
        // unordered result can repeat or skip rows. The id breaks ties.
        if (sortBy) {
          const column = getFieldName({
            model: table.key,
            field: sortBy.field,
          });
          const direction = sortBy.direction === "desc" ? "DESC" : "ASC";
          text += ` ORDER BY ${q(column)} ${direction}`;
          if (column !== "id") {
            text += `, ${q("id")} ${direction}`;
          }
        } else if (isCount(offset) && offset > 0) {
          text += ` ORDER BY ${q("id")}`;
        }
        if (isCount(limit)) {
          text += ` LIMIT ${limit}`;
        } else if (isCount(offset) && offset > 0) {
          // MySQL and SQLite take an offset only after a limit.
          text += ` LIMIT ${Number.MAX_SAFE_INTEGER}`;
        }
        if (isCount(offset) && offset > 0) {
          text += ` OFFSET ${offset}`;
        }
        const rows = rowsOf(await run(text, bind.params));
        return (await attachJoins(rows, join)) as T[];
      },

      count: async ({ model, modelKey, where: clauses }) => {
        const table = tableFor(model, modelKey);
        const bind = binder();
        const [row] = rowsOf(
          await run(
            `SELECT COUNT(*) AS ${q("n")} FROM ${q(table.name)}${where(table, clauses, bind)}`,
            bind.params,
          ),
        );
        return Number(row?.n ?? 0);
      },

      update: async <T>({
        model,
        modelKey,
        where: clauses,
        update,
      }: {
        model: string;
        modelKey?: string;
        where: CleanedWhere[];
        update: T;
      }): Promise<T | null> => {
        if (clauses.length === 0) {
          return null;
        }
        const table = tableFor(model, modelKey);
        const values = update as Record<string, unknown>;
        const bind = binder();
        const set = assignments(table, values, {}, bind);
        if (!mysqlFamily && set.length > 0) {
          const rows = rowsOf(
            await run(
              `UPDATE ${q(table.name)} SET ${set.join(", ")}${where(table, clauses, bind)} RETURNING *`,
              bind.params,
            ),
          );
          return (rows[0] ?? null) as T | null;
        }
        // No RETURNING (or nothing to set): find the first match, update
        // every match, read the first back by id.
        const find = binder();
        const [first] = rowsOf(
          await run(
            `SELECT ${q("id")} FROM ${q(table.name)}${where(table, clauses, find)} LIMIT 1`,
            find.params,
          ),
        );
        if (!first) {
          return null;
        }
        if (set.length > 0) {
          await run(
            `UPDATE ${q(table.name)} SET ${set.join(", ")}${where(table, clauses, bind)}`,
            bind.params,
          );
        }
        return (await byId(table, first.id)) as T | null;
      },

      updateMany: async ({ model, modelKey, where: clauses, update }) => {
        const table = tableFor(model, modelKey);
        const bind = binder();
        const set = assignments(table, update, {}, bind);
        const count = async (on: SQL, lock: boolean): Promise<number> => {
          const counting = binder();
          const [row] = rowsOf(
            await run(
              `SELECT COUNT(*) AS ${q("n")} FROM ${q(table.name)}${where(table, clauses, counting)}${lock ? " FOR UPDATE" : ""}`,
              counting.params,
              on,
            ),
          );
          return Number(row?.n ?? 0);
        };
        if (set.length === 0) {
          return count(client, false);
        }
        const statement = `UPDATE ${q(table.name)} SET ${set.join(", ")}${where(table, clauses, bind)}`;
        if (!mysqlFamily) {
          return dialect.affectedRows(
            await run(statement, bind.params),
            client,
          );
        }
        // MySQL and MariaDB count rows *changed*, not matched, and Bun's
        // client cannot ask for matched: count the matches under lock first.
        return atomically(async (tx) => {
          const matched = await count(tx, true);
          await run(statement, bind.params, tx);
          return matched;
        });
      },

      delete: async ({ model, modelKey, where: clauses }) => {
        if (clauses.length === 0) {
          return;
        }
        const table = tableFor(model, modelKey);
        const bind = binder();
        await run(
          `DELETE FROM ${q(table.name)}${where(table, clauses, bind)}`,
          bind.params,
        );
      },

      deleteMany: async ({ model, modelKey, where: clauses }) => {
        const table = tableFor(model, modelKey);
        const bind = binder();
        const result = await run(
          `DELETE FROM ${q(table.name)}${where(table, clauses, bind)}`,
          bind.params,
        );
        return dialect.affectedRows(result, client);
      },

      consumeOne: async <T>({
        model,
        modelKey,
        where: clauses,
      }: {
        model: string;
        modelKey?: string;
        where: CleanedWhere[];
      }): Promise<T | null> => {
        const table = tableFor(model, modelKey);
        const bind = binder();
        if (!mysqlFamily) {
          // One statement: the outer condition is checked again on a row
          // another transaction changed or deleted while this one waited, so
          // two consumers of one row cannot both have it.
          const outer = where(table, clauses, bind);
          const inner = where(table, clauses, bind);
          const rows = rowsOf(
            await run(
              `DELETE FROM ${q(table.name)}${and(outer, `${q("id")} IN (SELECT ${q("id")} FROM ${q(table.name)}${inner} LIMIT 1)`)} RETURNING *`,
              bind.params,
            ),
          );
          return (rows[0] ?? null) as T | null;
        }
        return atomically(async (tx) => {
          const [row] = rowsOf(
            await run(
              `SELECT * FROM ${q(table.name)}${where(table, clauses, bind)} LIMIT 1 FOR UPDATE`,
              bind.params,
              tx,
            ),
          );
          if (!row) {
            return null;
          }
          const remove = binder();
          await run(
            `DELETE FROM ${q(table.name)} WHERE ${q("id")} = ${remove.bind(row.id)}`,
            remove.params,
            tx,
          );
          return row as T;
        });
      },

      incrementOne: async <T>({
        model,
        modelKey,
        where: clauses,
        increment,
        set,
      }: {
        model: string;
        modelKey?: string;
        where: CleanedWhere[];
        increment: Record<string, number>;
        set?: Record<string, unknown>;
      }): Promise<T | null> => {
        const table = tableFor(model, modelKey);
        const bind = binder();
        const changes = assignments(table, set ?? {}, increment, bind);
        if (!mysqlFamily) {
          const outer = where(table, clauses, bind);
          const inner = where(table, clauses, bind);
          const rows = rowsOf(
            await run(
              `UPDATE ${q(table.name)} SET ${changes.join(", ")}${and(outer, `${q("id")} IN (SELECT ${q("id")} FROM ${q(table.name)}${inner} LIMIT 1)`)} RETURNING *`,
              bind.params,
            ),
          );
          return (rows[0] ?? null) as T | null;
        }
        return atomically(async (tx) => {
          const find = binder();
          const [target] = rowsOf(
            await run(
              `SELECT ${q("id")} FROM ${q(table.name)}${where(table, clauses, find)} LIMIT 1 FOR UPDATE`,
              find.params,
              tx,
            ),
          );
          if (!target) {
            return null;
          }
          // The row is locked and matched the guard: change it by id.
          await run(
            `UPDATE ${q(table.name)} SET ${changes.join(", ")} WHERE ${q("id")} = ${bind.bind(target.id)}`,
            bind.params,
            tx,
          );
          return (await byId(table, target.id, tx)) as T | null;
        });
      },

      createSchema: async ({ file, tables }) => {
        const planned = buildAuthSchema(tables, {
          engine,
          dialect,
          prefix,
          usePlural,
          numericIds: usesNumericIds(options),
        });
        const changes = await syncAuthSchema(
          runnerFor(context, client),
          dialect,
          planned,
          { dryRun: true },
        );
        return {
          code: `-- better-auth's tables for ${engine}, written by @kingsleyweb/bun-auth/sql.\n-- The same changes bunSqlAdapter's syncSchema() would apply.\n\n${renderScript(changes)}`,
          path: file ?? "better-auth-schema.sql",
          overwrite: true,
        };
      },
    };
    return adapter;
  };
}

/**
 * Runs `work` in a transaction on `client` (bun-sql's dialect: `begin` on
 * Postgres, a reserved `READ COMMITTED` connection on MySQL and MariaDB,
 * retried on a deadlock, `BEGIN IMMEDIATE` on SQLite). On SQLite it holds the
 * client's lock throughout and marks its async context, so a statement issued
 * from inside it runs on rather than waiting for the lock it holds.
 */
async function transact<T>(
  context: Context,
  client: SQL,
  work: (tx: SQL) => Promise<T>,
): Promise<T> {
  return context.exclusive(client, async () =>
    context.dialect.transaction(client, async (tx) =>
      SQLITE_TRANSACTION.run(client, async () => work(tx)),
    ),
  );
}

/** A schema runner over `client`, under its lock where the engine needs one. */
function runnerFor(context: Context, client: SQL): SchemaRunner {
  return {
    sql: client,
    exclusive: async (work) => context.exclusive(client, work),
  };
}

/**
 * A SQLite URL Bun opens as SQLite: a bare path (`/data/auth.sqlite`,
 * `./auth.sqlite`) becomes `file:<path>`; anything with a scheme, and
 * `:memory:`, is left as it is.
 *
 * Workaround for kingsloob1/bun-node#886: bun-sql's `detectAdapter` reads a
 * bare path as SQLite, but `openSqlClient("sqlite", { url })` passes only the
 * URL to Bun, which opens a scheme-less URL as Postgres. Remove once that is
 * fixed.
 */
function sqliteFileUrl(
  engine: SqlAdapter,
  url: string | undefined,
): string | undefined {
  if (engine !== "sqlite" || url === undefined || url === ":memory:") {
    return url;
  }
  return /^[a-z][\d+.a-z-]*:/i.test(url) ? url : `file:${url}`;
}

/** Reads the engine of a client from its options, as Bun records it. */
function engineOfClient(sql: SQL): SqlAdapter | undefined {
  const adapter = (sql as unknown as { options?: { adapter?: unknown } })
    .options?.adapter;
  return adapter === "postgres" ||
    adapter === "mysql" ||
    adapter === "mariadb" ||
    adapter === "sqlite"
    ? adapter
    : undefined;
}

/**
 * better-auth's database adapter on bun-sql: Postgres, MySQL, MariaDB and
 * SQLite through Bun's own `SQL` client.
 *
 * ```ts
 * import { betterAuth } from "better-auth";
 * import { bunSqlAdapter } from "@kingsleyweb/bun-auth/sql";
 *
 * const database = bunSqlAdapter({ url: process.env.DATABASE_URL });
 * export const auth = betterAuth({ database, emailAndPassword: { enabled: true } });
 * await database.syncSchema(auth.options); // or `syncSchema: true`
 * ```
 *
 * Throws bun-common's `ConfigError` when neither `sql`, `url` nor
 * `connection` is given, or the engine cannot be told.
 */
export function bunSqlAdapter(options: BunSqlAdapterOptions): BunSqlAdapter {
  const engine =
    options.adapter ??
    (options.sql ? engineOfClient(options.sql) : undefined) ??
    (options.sql || options.url
      ? detectAdapter(options.url)
      : (() => {
          throw new ConfigError(
            "bunSqlAdapter needs a sql client, a url, or a connection with an adapter",
          );
        })());
  const dialect = dialectFor(engine);
  const owned = options.sql === undefined;
  const url = sqliteFileUrl(engine, options.url);
  const client =
    options.sql ??
    openSqlClient(
      engine,
      {
        ...(url === undefined ? {} : { url }),
        ...(options.connection === undefined
          ? {}
          : { connection: options.connection }),
      },
      "bunSqlAdapter",
      options.max === undefined ? {} : { max: options.max },
    );

  // SQLite: the dialect's pragmas (WAL, a short busy timeout) on a client the
  // adapter opened, before anything else runs; a client passed in is the
  // caller's to configure.
  let opened: Promise<void> | undefined;
  const open = async (): Promise<void> => {
    if (engine !== "sqlite" || !owned) {
      return;
    }
    opened ??= (async () => {
      for (const pragma of dialect.pragmas) {
        await client.unsafe(pragma);
      }
    })();
    await opened;
  };

  const context: Context = {
    engine,
    dialect,
    prefix: options.prefix ?? "",
    usePlural: options.usePlural ?? false,
    exclusive: async (sql, work) => {
      if (engine !== "sqlite" || SQLITE_TRANSACTION.getStore() === sql) {
        return work();
      }
      let lock = SQLITE_LOCKS.get(sql);
      if (!lock) {
        lock = new Mutex();
        SQLITE_LOCKS.set(sql, lock);
      }
      return lock.runExclusive(work);
    },
  };

  // The schema each better-auth configuration needs, synced at most once
  // (and again after a failure) when `syncSchema` is set.
  const synced = new Map<string, Promise<void>>();
  const ready = async (schema: AuthSchema): Promise<void> => {
    await open();
    if (!options.syncSchema) {
      return;
    }
    const key = JSON.stringify(schema.tables);
    let done = synced.get(key);
    if (!done) {
      done = syncAuthSchema(
        runnerFor(context, client),
        dialect,
        schema,
        options.syncSchema,
      ).then(() => undefined);
      synced.set(key, done);
      done.catch(() => synced.delete(key));
    }
    await done;
  };

  const configFor = (authOptions: BetterAuthOptions): AdapterFactoryConfig => {
    const config: AdapterFactoryConfig = {
      adapterId: "bun-sql",
      adapterName: `bun-sql (${engine})`,
      usePlural: options.usePlural ?? false,
      ...(options.debugLogs === undefined
        ? {}
        : { debugLogs: options.debugLogs }),
      supportsNumericIds: true,
      supportsUUIDs: false,
      supportsJSON: false,
      supportsArrays: false,
      supportsDates: engine !== "sqlite",
      supportsBooleans: engine === "postgres",
      // Postgres's BIGINT comes back as text: a number again. Not an id or a
      // reference to one, which better-auth hands out as a string (in serial
      // mode it describes the id as a number, and has just stringified it).
      customTransformOutput: ({ data, field, fieldAttributes }) => {
        const value: unknown = data;
        return field !== "id" &&
          fieldAttributes.references?.field !== "id" &&
          fieldAttributes.type === "number" &&
          typeof value === "string" &&
          value.trim() !== "" &&
          !Number.isNaN(Number(value))
          ? Number(value)
          : value;
      },
    };
    if (options.transaction === false) {
      return { ...config, transaction: false };
    }
    return {
      ...config,
      transaction: async (callback) => {
        // The schema first, outside the transaction: its DDL must not wait
        // on (or run inside) the transaction's own locks.
        await ready(
          buildAuthSchema(getAuthTables(authOptions), {
            engine,
            dialect,
            prefix: context.prefix,
            usePlural: context.usePlural,
            numericIds: usesNumericIds(authOptions),
          }),
        );
        return transact(context, client, async (tx) =>
          callback(
            createAdapterFactory({
              config: { ...config, transaction: false },
              adapter: createQueries(context, tx, true, ready),
            })(authOptions),
          ),
        );
      },
    };
  };

  const instance = ((authOptions: BetterAuthOptions) =>
    createAdapterFactory({
      config: configFor(authOptions),
      adapter: createQueries(context, client, false, ready),
    })(authOptions)) as BunSqlAdapter;

  Object.defineProperties(instance, {
    engine: { value: engine, enumerable: true },
    syncSchema: {
      enumerable: true,
      value: async (
        authOptions: BetterAuthOptions,
        sync?: SchemaSyncOptions | boolean,
      ): Promise<AuthSchemaChange[]> => {
        await open();
        return syncAuthSchema(
          runnerFor(context, client),
          dialect,
          buildAuthSchema(getAuthTables(authOptions), {
            engine,
            dialect,
            prefix: context.prefix,
            usePlural: context.usePlural,
            numericIds: usesNumericIds(authOptions),
          }),
          sync,
        );
      },
    },
    close: {
      enumerable: true,
      value: async () => {
        if (owned) {
          await client.close();
        }
      },
    },
  });
  return instance;
}
