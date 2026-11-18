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
import type { ResolvedCounter, ResolvedCounterQuery } from "./analytics";
import type {
  AppendAuditResult,
  AuditAppended,
  AuditInput,
  BanRecord,
  AppendResult,
  AuditCheckpoint,
  AuditHead,
  AuditRecord,
  BundleInput,
  Change,
  ChangeKind,
  CounterRow,
  DocKind,
  EventFilter,
  EventListQuery,
  ListQuery,
  Page,
  PolicyVersionInput,
  PolicyVersionRecord,
  PutBundleResult,
  PutResult,
  RetainedTable,
  SecurityEvent,
  SecurityStoreCapabilities,
  SecurityStoreDriver,
  SeriesPoint,
  SeriesQuery,
  StoreCodec,
  StoredBundle,
  StoredDoc,
  Tier,
  TopKQuery,
  TopKRow,
  CounterQuery,
  DistinctCount,
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
  carryUp,
  checkDeleteBefore,
  checkRollup,
  checkTopKLimit,
  dimsOf,
  eventCursor,
  eventPosition,
  resolveCounterQuery,
  resolveCounters,
  resolveEventQuery,
  resolveEvents,
  retentionFloor,
  ROLLUPS,
  watermarkName,
  checkGroupBy,
  OTHER_DIM,
} from "./analytics";
import {
  auditCursor,
  auditTargetOf,
  auditPosition,
  bundleEtag,
  checkAuditInput,
  checkCheckpoint,
  banActive,
  banCursor,
  banId,
  banPosition,
  PERMANENT_SORT_KEY,
  checkBanInput,
  checkBanPurge,
  checkCounter,
  UNFED_KINDS,
  checkLift,
  mergeStoredBan,
  resolveBanQuery,
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
import { MAX_SERIES_POINTS, TIER_MS } from "./types";

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
  /** The analytics events. */
  events: string;
  /** The ingested event batches' ids, for idempotency. */
  eventBatches: string;
  /** The analytics counters, every tier. */
  analyticsCounters: string;
  /** The analytics state: each rollup's watermark. */
  analyticsState: string;
  /** Bans (storage.md §3.1), lifted ones kept. */
  bans: string;
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
    events: `${prefix}events`,
    eventBatches: `${prefix}event_batches`,
    analyticsCounters: `${prefix}analytics_counters`,
    analyticsState: `${prefix}analytics_state`,
    bans: `${prefix}bans`,
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
    events,
    eventBatches,
    analyticsCounters,
    analyticsState,
    bans,
  } = storeTables(prefix);
  const { idType, nameType, jsonType, timeType, serialType, longTextType } =
    dialect;
  // An id column in an index, ordered by code point where the engine's
  // default collation is a locale's (Postgres).
  const collatedId =
    dialect.codePointCollation === null
      ? "id"
      : { name: "id", collation: dialect.codePointCollation };
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
          // The entry's target, `<kind>:<id>` (`""` for none), for a
          // target's history; outside the hash chain, derived from the
          // entry (null on a row written before it, until `syncSchema`).
          { name: "target", type: idType },
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
        name: bans,
        primaryKey: ["id"],
        columns: [
          { name: "id", type: idType, suffix: "NOT NULL" },
          { name: "scope", type: idType, suffix: "NOT NULL" },
          { name: "expires_at", type: timeType },
          { name: "lifted_at", type: timeType },
          { name: "revision", type: "INTEGER", suffix: "NOT NULL" },
          { name: "updated_at", type: timeType, suffix: "NOT NULL" },
          { name: "ban", type: jsonType, suffix: "NOT NULL" },
          // What a ban list filters, sorts and searches by, copied from the
          // body when written (null on a row written before them, until
          // `syncSchema` fills them in).
          { name: "kind", type: idType },
          { name: "subject", type: idType },
          { name: "source", type: idType },
          { name: "rule", type: idType },
          { name: "created_at", type: timeType },
          { name: "expires_sort", type: timeType },
          { name: "country", type: idType },
          { name: "asn", type: timeType },
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
        name: events,
        primaryKey: ["id"],
        columns: [
          { name: "id", type: idType, suffix: "NOT NULL" },
          { name: "service", type: idType, suffix: "NOT NULL" },
          { name: "at", type: timeType, suffix: "NOT NULL" },
          { name: "action", type: idType, suffix: "NOT NULL" },
          { name: "rule", type: idType },
          { name: "route", type: idType },
          { name: "ip", type: idType },
          { name: "user_id", type: idType },
          { name: "api_key", type: idType },
          { name: "username", type: idType },
          { name: "country", type: idType },
          { name: "asn", type: timeType },
          { name: "dry_run", type: "INTEGER", suffix: "NOT NULL DEFAULT 0" },
          { name: "event", type: jsonType, suffix: "NOT NULL" },
        ],
      },
      {
        name: eventBatches,
        primaryKey: ["batch_id"],
        columns: [
          { name: "batch_id", type: idType, suffix: "NOT NULL" },
          { name: "received_at", type: timeType, suffix: "NOT NULL" },
        ],
      },
      {
        name: analyticsCounters,
        primaryKey: ["tier", "service", "metric", "bucket", "dims"],
        columns: [
          { name: "tier", type: idType, suffix: "NOT NULL" },
          { name: "service", type: idType, suffix: "NOT NULL" },
          { name: "metric", type: idType, suffix: "NOT NULL" },
          { name: "bucket", type: timeType, suffix: "NOT NULL" },
          { name: "dims", type: idType, suffix: "NOT NULL" },
          { name: "value", type: timeType, suffix: "NOT NULL" },
        ],
      },
      {
        name: analyticsState,
        primaryKey: ["name"],
        columns: [
          { name: "name", type: idType, suffix: "NOT NULL" },
          { name: "value", type: timeType, suffix: "NOT NULL" },
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
        name: `ix_${prefix}bans_scope`,
        table: bans,
        columns: ["scope", "id"],
      },
      // A ban list's keyset orders, and its search by subject value.
      {
        name: `ix_${prefix}bans_created`,
        table: bans,
        columns: ["created_at", collatedId],
      },
      {
        name: `ix_${prefix}bans_expires`,
        table: bans,
        columns: ["expires_sort", collatedId],
      },
      {
        name: `ix_${prefix}bans_subject`,
        table: bans,
        columns: ["subject"],
      },
      {
        name: `ix_${prefix}audit_target`,
        table: audit,
        columns: ["target", "n"],
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
      // Events read by service and time (the keyset order), by time alone
      // (every service, and retention), and by address (README §8.2).
      {
        name: `ix_${prefix}events_service`,
        table: events,
        columns: ["service", "at", collatedId],
      },
      {
        name: `ix_${prefix}events_at`,
        table: events,
        columns: ["at", collatedId],
      },
      { name: `ix_${prefix}events_ip`, table: events, columns: ["ip", "at"] },
      {
        name: `ix_${prefix}event_batches_at`,
        table: eventBatches,
        columns: ["received_at"],
      },
      // A tier's buckets by time, for rollups and retention.
      {
        name: `ix_${prefix}analytics_counters_bucket`,
        table: analyticsCounters,
        columns: ["tier", "bucket"],
      },
      // Every service's rows of one metric (a query without a service).
      {
        name: `ix_${prefix}analytics_counters_metric`,
        table: analyticsCounters,
        columns: ["tier", "metric", "bucket"],
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
  /**
   * Runs first in every analytics write: shared for adding counters,
   * exclusive for a rollup, so a counter added while a rollup moves its
   * watermark is either rolled up or carried up, never lost (Postgres: an
   * advisory lock of its own, apart from the change feed's). Absent where
   * the engine has one writer (SQLite).
   */
  readonly serializeAnalytics?: (tx: SQL, exclusive: boolean) => Promise<void>;
  /**
   * A test's seam: runs in a rollup's transaction after its rows are
   * written and before its watermark moves, where a test pauses it to show
   * what the analytics lock prevents. Absent in every real store.
   */
  readonly rollupWritten?: (tx: SQL) => Promise<void>;
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

/** The bans table's filter columns, in the order {@link banColumnValues} gives them. */
const BAN_COLUMNS = [
  "kind",
  "subject",
  "source",
  "rule",
  "created_at",
  "expires_sort",
  "country",
  "asn",
] as const;

/** A ban's filter columns' values, as {@link BAN_COLUMNS} names them. */
function banColumnValues(ban: BanRecord): (string | number | null)[] {
  return [
    ban.subject.type,
    ban.subject.value,
    ban.source,
    ban.rule ?? null,
    ban.createdAt,
    ban.expiresAt ?? PERMANENT_SORT_KEY,
    ban.country ?? null,
    ban.asn ?? null,
  ];
}

/** The events table's columns, in the order an insert binds them. */
const EVENT_COLUMNS = [
  "id",
  "service",
  "at",
  "action",
  "rule",
  "route",
  "ip",
  "user_id",
  "api_key",
  "username",
  "country",
  "asn",
  "dry_run",
  "event",
] as const;

/** Events per insert statement (14 parameters each, under every engine's limit). */
const EVENT_CHUNK = 200;

/** Counter rows per upsert statement (6 parameters each). */
const COUNTER_CHUNK = 500;

/** `text` with `LIKE`'s wildcards and its escape character escaped by `\`. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** `service IN (…)` over `services`, or a false condition for none. */
function inList(p: Params, services: readonly string[]): string {
  return services.length === 0
    ? "1 = 0"
    : `service IN (${services.map((service) => p.bind(service)).join(", ")})`;
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
  // The canonical dimensions ordered by code point, as the memory store
  // orders them.
  const dimsOrder =
    dialect.codePointCollation === null
      ? "dims"
      : `dims COLLATE ${dialect.codePointCollation}`;
  // A row's physical id, for a bounded delete.
  const rowId = dialect.name === "postgres" ? "ctid" : "rowid";

  /** A rollup's watermark, read with `sql`. */
  const readWatermark = async (
    sql: SQL,
    from: Tier,
    to: Tier,
  ): Promise<number> => {
    const p = new Params(dialect);
    const rows = (await sql.unsafe(
      `SELECT value FROM ${tables.analyticsState} WHERE name = ${p.bind(watermarkName(from, to))}`,
      p.values,
    )) as { value: number | bigint }[];
    return rows[0] === undefined ? 0 : Number(rows[0].value);
  };

  /** Adds checked counter rows with `tx`, carried up past the watermarks, under the shared analytics lock. */
  const addRows = async (
    tx: SQL,
    rows: readonly ResolvedCounter[],
  ): Promise<void> => {
    await init.serializeAnalytics?.(tx, false);
    const marks = new Map<string, number>();
    for (const [from, to] of ROLLUPS) {
      marks.set(watermarkName(from, to), await readWatermark(tx, from, to));
    }
    const carried = carryUp(
      rows,
      (from, to) => marks.get(watermarkName(from, to)) ?? 0,
    );
    for (let at = 0; at < carried.length; at += COUNTER_CHUNK) {
      const chunk = carried.slice(at, at + COUNTER_CHUNK);
      const p = new Params(dialect);
      const values = chunk.map(
        (row) =>
          `(${p.bind(row.tier)}, ${p.bind(row.service)}, ${p.bind(row.metric)}, ${p.bind(row.bucket)}, ${p.bind(row.dims)}, ${p.bind(row.value)})`,
      );
      await tx.unsafe(
        `INSERT INTO ${tables.analyticsCounters} (tier, service, metric, bucket, dims, value)
         VALUES ${values.join(", ")}
         ON CONFLICT (tier, service, metric, bucket, dims)
         DO UPDATE SET value = ${tables.analyticsCounters}.value + excluded.value`,
        p.values,
      );
    }
  };

  /** A counter query's `WHERE`, and its values. */
  const counterWhere = (
    query: ResolvedCounterQuery,
  ): { where: string; values: unknown[] } => {
    const p = new Params(dialect);
    const where = [
      `tier = ${p.bind(query.tier)}`,
      `metric = ${p.bind(query.metric)}`,
      `bucket >= ${p.bind(query.from)}`,
      `bucket < ${p.bind(query.to)}`,
    ];
    if (query.service !== undefined) {
      where.push(`service = ${p.bind(query.service)}`);
    }
    if (query.services !== undefined) where.push(inList(p, query.services));
    for (const needle of query.needles) {
      where.push(
        `('&' || dims || '&') LIKE ${p.bind(`%${escapeLike(needle)}%`)} ESCAPE '\\'`,
      );
    }
    return { where: where.join(" AND "), values: p.values };
  };
  let client: SQL | undefined;
  let opening: Promise<SQL> | undefined;
  let closed = false;

  const backend = (sql: SQL) => ({
    all: async <T>(text: string, params: unknown[]) =>
      (await sql.unsafe(text, params)) as T[],
    run: async (text: string) => await sql.unsafe(text),
  });

  /** Brings the schema in line; answers every change. */
  /**
   * Fills the bans table's filter columns of rows written before they
   * existed (null `kind`), from each row's body, a batch at a time; how
   * many it filled.
   */
  const backfillBans = async (sql: SQL): Promise<number> => {
    let filled = 0;
    for (;;) {
      const rows = (await sql.unsafe(
        `SELECT id, ban FROM ${tables.bans} WHERE kind IS NULL ORDER BY id LIMIT 500`,
      )) as { id: string; ban: unknown }[];
      if (rows.length === 0) return filled;
      for (const row of rows) {
        const ban = codec.open(dialect.jsonOut(row.ban, null), {
          field: "doc",
          kind: "ban",
          id: row.id,
        }) as BanRecord;
        const values = banColumnValues(ban);
        const p = new Params(dialect);
        await sql.unsafe(
          `UPDATE ${tables.bans} SET ${BAN_COLUMNS.map((column, i) => `${column} = ${p.bind(values[i] ?? null)}`).join(", ")}
            WHERE id = ${p.bind(row.id)}`,
          p.values,
        );
        filled++;
      }
    }
  };

  /** Fills the audit table's `target` of rows written before it (null), from each entry; how many. */
  const backfillAuditTargets = async (sql: SQL): Promise<number> => {
    let filled = 0;
    for (;;) {
      const rows = (await sql.unsafe(
        `SELECT n, entry FROM ${tables.audit} WHERE target IS NULL ORDER BY n LIMIT 500`,
      )) as { n: number | bigint | string; entry: unknown }[];
      if (rows.length === 0) return filled;
      for (const row of rows) {
        const n = Number(row.n);
        const entry = codec.open(dialect.jsonOut(row.entry, null), {
          field: "doc",
          kind: "audit",
          id: String(n),
        });
        const p = new Params(dialect);
        await sql.unsafe(
          `UPDATE ${tables.audit} SET target = ${p.bind(auditTargetOf(entry))} WHERE n = ${p.bind(n)}`,
          p.values,
        );
        filled++;
      }
    }
  };

  /** `syncSchema`: the schema's changes, then the bans' filter columns and the audit targets filled in (not on a dry run). */
  const sync = async (
    sql: SQL,
    options: SchemaSyncOptions | boolean | undefined,
  ): Promise<SchemaChange[]> => {
    const resolved = resolveSyncOptions(options);
    const changes = await syncSqlSchema(
      backend(sql),
      dialect,
      definition,
      resolved,
    );
    if (!resolved.dryRun) {
      await backfillBans(sql);
      await backfillAuditTargets(sql);
    }
    return changes;
  };

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
      } else {
        // A bans table from before its filter columns: writing to it would
        // fail, and a list would miss its rows. Say what fixes it.
        for (const [table, column] of [
          [tables.bans, "kind"],
          [tables.audit, "target"],
        ] as const) {
          const columns = existing.get(table);
          if (
            columns !== undefined &&
            !columns.some((found) => found.name.toLowerCase() === column)
          ) {
            throw new ConfigError(
              `security store: the table ${table} predates its ${column} column; open the store once with syncSchema: true (or call syncSchema()) to add and fill it`,
            );
          }
        }
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

  /**
   * Writes `entry` on `head` inside a serialised transaction: the head row
   * moved by compare-and-set, then the entry; a refusal when the head is no
   * longer `head`; the entry's number and change otherwise.
   */
  const writeAudit = async (
    tx: SQL,
    entry: AuditInput,
    head: AuditHead | null,
  ): Promise<AppendAuditResult> => {
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
      `INSERT INTO ${tables.audit} (n, prev_hash, hash, at, actor, action, scope, entry, target)
       VALUES (${q.bind(n)}, ${q.bind(entry.prevHash)}, ${q.bind(entry.hash)}, ${q.bind(entry.at)},
               ${q.bind(entry.actor)}, ${q.bind(entry.action)}, ${q.bind(entry.scope)},
               ${q.bind(dialect.jsonIn(codec.seal(entry.entry, { field: "doc", kind: "audit", id: String(n) })))},
               ${q.bind(auditTargetOf(entry.entry))})`,
      q.values,
    );
    return Object.freeze({
      ok: true as const,
      n,
      seq: await record(tx, "audit", String(n), n, false),
    });
  };

  /** A stored ban's body, opened. */
  const openBan = (id: string, body: unknown): BanRecord =>
    Object.freeze(
      codec.open(dialect.jsonOut(body, null), {
        field: "doc",
        kind: "ban",
        id,
      }) as BanRecord,
    );

  /** The ban `id`, read with `sql`. */
  const readBan = async (
    sql: SQL,
    id: string,
  ): Promise<BanRecord | undefined> => {
    const p = new Params(dialect);
    const rows = (await sql.unsafe(
      `SELECT ban FROM ${tables.bans} WHERE id = ${p.bind(id)}`,
      p.values,
    )) as { ban: unknown }[];
    return rows[0] === undefined ? undefined : openBan(id, rows[0].ban);
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
          seq: UNFED_KINDS.has(kind)
            ? 0n
            : await record(tx, kind, id, revision, false),
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
        if (!UNFED_KINDS.has(kind))
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
    appendEvents: async (
      batchId,
      batch: readonly SecurityEvent[],
      rows?: readonly CounterRow[],
    ) => {
      const checked = resolveEvents(batchId, batch);
      const resolvedRows = rows === undefined ? [] : resolveCounters(rows);
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        const p = new Params(dialect);
        const taken = await tx.unsafe(
          dialect.insertIgnore(
            tables.eventBatches,
            ["batch_id", "received_at"],
            [p.bind(batchId), p.bind(now())],
          ),
          p.values,
        );
        if ((await dialect.affectedRows(taken, tx)) !== 1) {
          return Object.freeze({ duplicate: true });
        }
        for (let at = 0; at < checked.length; at += EVENT_CHUNK) {
          const chunk = checked.slice(at, at + EVENT_CHUNK);
          const q = new Params(dialect);
          const values = chunk.map((event) => {
            const subjects = event.subjects ?? {};
            return `(${[
              event.id,
              event.service,
              event.at,
              event.action,
              event.rule ?? null,
              event.route ?? null,
              subjects.ip ?? null,
              subjects.user ?? null,
              subjects.apiKey ?? null,
              subjects.username ?? null,
              event.country ?? null,
              event.asn ?? null,
              event.dryRun === true ? 1 : 0,
              dialect.jsonIn(event),
            ]
              .map((value) => q.bind(value))
              .join(", ")})`;
          });
          await tx.unsafe(
            `INSERT INTO ${tables.events} (${EVENT_COLUMNS.join(", ")})
             VALUES ${values.join(", ")}
             ON CONFLICT DO NOTHING`,
            q.values,
          );
        }
        if (resolvedRows.length > 0) await addRows(tx, resolvedRows);
        return Object.freeze({ duplicate: false });
      });
    },
    addCounters: async (rows: readonly CounterRow[]) => {
      const resolved = resolveCounters(rows);
      if (resolved.length === 0) return;
      const sql = await connection();
      await dialect.transaction(sql, async (tx) => {
        await addRows(tx, resolved);
      });
    },
    listEvents: async (query: EventListQuery): Promise<Page<SecurityEvent>> => {
      const resolved = resolveEventQuery(query);
      const after = eventPosition(resolved);
      const sql = await connection();
      const p = new Params(dialect);
      const where: string[] = [];
      const filter = resolved.filter;
      const equal: [keyof EventFilter, string][] = [
        ["id", "id"],
        ["service", "service"],
        ["action", "action"],
        ["rule", "rule"],
        ["route", "route"],
        ["ip", "ip"],
        ["user", "user_id"],
        ["apiKey", "api_key"],
        ["username", "username"],
        ["country", "country"],
        ["asn", "asn"],
      ];
      for (const [field, column] of equal) {
        if (filter[field] !== undefined) {
          where.push(`${column} = ${p.bind(filter[field])}`);
        }
      }
      if (filter.services !== undefined) {
        where.push(inList(p, filter.services));
      }
      if (filter.dryRun !== undefined) {
        where.push(`dry_run = ${p.bind(filter.dryRun ? 1 : 0)}`);
      }
      if (filter.from !== undefined) where.push(`at >= ${p.bind(filter.from)}`);
      if (filter.to !== undefined) where.push(`at < ${p.bind(filter.to)}`);
      if (after !== undefined) {
        where.push(
          keysetAfter(dialect, p.bind, {
            columns: ["at"],
            values: [after.at],
            idColumn: idOrder,
            id: after.id,
            direction: resolved.direction,
          }),
        );
      }
      const dir = resolved.direction === "asc" ? "ASC" : "DESC";
      const rows = (await sql.unsafe(
        `SELECT event FROM ${tables.events}
          ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
          ORDER BY at ${dir}, ${idOrder} ${dir}
          LIMIT ${resolved.limit + 1}`,
        p.values,
      )) as { event: unknown }[];
      const items = rows.slice(0, resolved.limit).map((row) => {
        const event: unknown = dialect.jsonOut(row.event, null);
        return Object.freeze(event as SecurityEvent);
      });
      const last = items.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        ...(rows.length > resolved.limit && last !== undefined
          ? { next: eventCursor(resolved, last) }
          : {}),
      });
    },
    series: async (query: SeriesQuery): Promise<readonly SeriesPoint[]> => {
      const byService = checkGroupBy(query.groupBy) === "service";
      const { where, values } = counterWhere(resolveCounterQuery(query));
      const sql = await connection();
      const rows = (await sql.unsafe(
        `SELECT bucket, dims, ${byService ? "service, " : ""}SUM(value) AS value FROM ${tables.analyticsCounters}
          WHERE ${where}
          GROUP BY bucket, dims${byService ? ", service" : ""}
          ORDER BY bucket ASC, ${dimsOrder} ASC${byService ? ", service ASC" : ""}
          LIMIT ${MAX_SERIES_POINTS + 1}`,
        values,
      )) as {
        bucket: number | bigint;
        dims: string;
        service?: string;
        value: number | bigint | string;
      }[];
      if (rows.length > MAX_SERIES_POINTS) {
        throw new ConfigError(
          `security store: the series has more than ${MAX_SERIES_POINTS} points; narrow the range or the dims`,
        );
      }
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            at: Number(row.bucket),
            ...(byService ? { service: String(row.service) } : {}),
            dims: dimsOf(row.dims),
            value: Number(row.value),
          }),
        ),
      );
    },
    distinct: async (query: CounterQuery): Promise<DistinctCount> => {
      const { where, values } = counterWhere(resolveCounterQuery(query));
      const sql = await connection();
      // "(other)" is a constant of ours, never a value from a caller.
      const rows = (await sql.unsafe(
        `SELECT COUNT(DISTINCT CASE WHEN dims NOT LIKE '%${OTHER_DIM}%' THEN dims END) AS n,
                MAX(CASE WHEN dims LIKE '%${OTHER_DIM}%' THEN 1 ELSE 0 END) AS o
           FROM ${tables.analyticsCounters}
          WHERE ${where}`,
        values,
      )) as {
        n: number | bigint | string | null;
        o: number | bigint | string | null;
      }[];
      return Object.freeze({
        count: Number(rows[0]?.n ?? 0),
        other: Number(rows[0]?.o ?? 0) === 1,
      });
    },
    topK: async (query: TopKQuery): Promise<readonly TopKRow[]> => {
      const limit = checkTopKLimit(query);
      const { where, values } = counterWhere(resolveCounterQuery(query));
      const sql = await connection();
      const rows = (await sql.unsafe(
        `SELECT dims, SUM(value) AS value FROM ${tables.analyticsCounters}
          WHERE ${where}
          GROUP BY dims
          ORDER BY SUM(value) DESC, ${dimsOrder} ASC
          LIMIT ${limit}`,
        values,
      )) as { dims: string; value: number | bigint | string }[];
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({ dims: dimsOf(row.dims), value: Number(row.value) }),
        ),
      );
    },
    rollup: async (from: Tier, to: Tier, until: number) => {
      const end = checkRollup(from, to, until);
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        await init.serializeAnalytics?.(tx, true);
        const start = await readWatermark(tx, from, to);
        if (end <= start) return 0;
        const width = TIER_MS[to];
        const p = new Params(dialect);
        const result = await tx.unsafe(
          `INSERT INTO ${tables.analyticsCounters} (tier, service, metric, bucket, dims, value)
           SELECT ${p.bind(to)}, service, metric, (bucket / ${width}) * ${width}, dims, SUM(value)
             FROM ${tables.analyticsCounters}
            WHERE tier = ${p.bind(from)} AND bucket >= ${p.bind(start)} AND bucket < ${p.bind(end)}
            GROUP BY service, metric, (bucket / ${width}) * ${width}, dims
           ON CONFLICT (tier, service, metric, bucket, dims)
           DO UPDATE SET value = ${tables.analyticsCounters}.value + excluded.value`,
          p.values,
        );
        const written = await dialect.affectedRows(result, tx);
        await init.rollupWritten?.(tx);
        const q = new Params(dialect);
        await tx.unsafe(
          `INSERT INTO ${tables.analyticsState} (name, value)
           VALUES (${q.bind(watermarkName(from, to))}, ${q.bind(end)})
           ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
          q.values,
        );
        return written;
      });
    },
    deleteBefore: async (
      table: RetainedTable,
      before: number,
      limit: number,
    ) => {
      checkDeleteBefore(table, before, limit);
      const sql = await connection();
      const p = new Params(dialect);
      let target: string;
      let condition: string;
      if (table === "events") {
        target = tables.events;
        condition = `at < ${p.bind(before)}`;
      } else if (table === "batches") {
        target = tables.eventBatches;
        condition = `received_at < ${p.bind(before)}`;
      } else {
        const floor = retentionFloor(table);
        const bound =
          floor === undefined
            ? before
            : Math.min(before, await readWatermark(sql, floor[0], floor[1]));
        target = tables.analyticsCounters;
        condition = `tier = ${p.bind(table)} AND bucket < ${p.bind(bound)}`;
      }
      const result = await sql.unsafe(
        `DELETE FROM ${target} WHERE ${rowId} IN
           (SELECT ${rowId} FROM ${target} WHERE ${condition} LIMIT ${limit})`,
        p.values,
      );
      return await dialect.affectedRows(result, sql);
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
        return await writeAudit(tx, entry, head);
      });
    },
    appendAuditAtHead: async (make): Promise<AuditAppended> => {
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        // The head is read under the store's write lock, so no other
        // writer can move it before the entry is written on it (#846).
        await init.serialize?.(tx);
        const head = await readAuditHead(tx);
        const entry = checkAuditInput(make(head), head?.hash ?? null);
        const written = await writeAudit(tx, entry, head);
        if (!written.ok) {
          throw new Error(
            "security store: the audit head moved under the write lock",
          );
        }
        return Object.freeze({ n: written.n, seq: written.seq, entry });
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
      if (f.target !== "") where.push(`target = ${p.bind(f.target)}`);
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
    upsertBan: async (input) => {
      const ban = checkBanInput(input);
      const id = banId(ban.scope, ban.subject);
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        const existing = await readBan(tx, id);
        const merged = mergeStoredBan(existing, ban, now());
        const p = new Params(dialect);
        const values = [
          p.bind(merged.id),
          p.bind(merged.scope),
          p.bind(merged.expiresAt),
          p.bind(merged.liftedAt),
          p.bind(merged.revision),
          p.bind(merged.updatedAt),
          p.bind(
            dialect.jsonIn(
              codec.seal(merged, { field: "doc", kind: "ban", id }),
            ),
          ),
          ...banColumnValues(merged).map((value) => p.bind(value)),
        ];
        await tx.unsafe(
          `INSERT INTO ${tables.bans} (id, scope, expires_at, lifted_at, revision, updated_at, ban, ${BAN_COLUMNS.join(", ")})
            VALUES (${values.join(", ")})
            ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at, lifted_at = excluded.lifted_at,
              revision = excluded.revision, updated_at = excluded.updated_at, ban = excluded.ban,
              ${BAN_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}`,
          p.values,
        );
        await record(tx, "ban", id, merged.revision, false);
        return merged;
      });
    },
    liftBan: async (id, by, at) => {
      checkId(id, "a ban id");
      checkLift(by, at);
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        const current = await readBan(tx, id);
        if (current === undefined || !banActive(current, now())) return false;
        const lifted: BanRecord = Object.freeze({
          ...current,
          liftedAt: at,
          liftedBy: by,
          updatedAt: now(),
          revision: current.revision + 1,
        });
        const p = new Params(dialect);
        await tx.unsafe(
          `UPDATE ${tables.bans} SET lifted_at = ${p.bind(at)}, revision = ${p.bind(lifted.revision)},
            updated_at = ${p.bind(lifted.updatedAt)},
            ban = ${p.bind(dialect.jsonIn(codec.seal(lifted, { field: "doc", kind: "ban", id })))}
            WHERE id = ${p.bind(id)}`,
          p.values,
        );
        await record(tx, "ban", id, lifted.revision, false);
        return true;
      });
    },
    getBan: async (id) => {
      checkId(id, "a ban id");
      return await readBan(await connection(), id);
    },
    listBans: async (query) => {
      const resolved = resolveBanQuery(query);
      const after = banPosition(resolved);
      const desc = resolved.direction === "desc";
      const sql = await connection();
      const p = new Params(dialect);
      const where: string[] = [];
      if (resolved.scopes !== null) {
        where.push(
          `scope IN (${resolved.scopes.map((scope) => p.bind(scope)).join(", ")})`,
        );
      }
      if (resolved.active !== null) {
        const at = p.bind(now());
        const active = `(lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ${at}))`;
        where.push(resolved.active ? active : `NOT ${active}`);
      }
      if (resolved.kind !== null) where.push(`kind = ${p.bind(resolved.kind)}`);
      if (resolved.source !== null)
        where.push(`source = ${p.bind(resolved.source)}`);
      if (resolved.rule !== null) where.push(`rule = ${p.bind(resolved.rule)}`);
      if (resolved.values !== null) {
        where.push(
          `subject IN (${resolved.values.map((value) => p.bind(value)).join(", ")})`,
        );
      }
      const keyColumn =
        resolved.sort === "created"
          ? "created_at"
          : resolved.sort === "expires"
            ? "expires_sort"
            : undefined;
      const op = desc ? "<" : ">";
      if (after !== undefined) {
        if (keyColumn === undefined || after.key === undefined) {
          where.push(`id ${op} ${p.bind(after.id)}`);
        } else {
          const key = p.bind(after.key);
          where.push(
            `(${keyColumn} ${op} ${key} OR (${keyColumn} = ${p.bind(after.key)} AND id ${op} ${p.bind(after.id)}))`,
          );
        }
      }
      const direction = desc ? "DESC" : "ASC";
      const order =
        keyColumn === undefined
          ? `id ${direction}`
          : `${keyColumn} ${direction}, id ${direction}`;
      const rows = (await sql.unsafe(
        `SELECT id, ban FROM ${tables.bans}
          ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
          ORDER BY ${order} LIMIT ${resolved.limit + 1}`,
        p.values,
      )) as { id: string; ban: unknown }[];
      const items = rows
        .slice(0, resolved.limit)
        .map((row) => openBan(row.id, row.ban));
      const last = items.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        ...(rows.length > resolved.limit && last !== undefined
          ? { next: banCursor(resolved, last) }
          : {}),
      });
    },
    purgeBans: async (query) => {
      const { source, before, limit } = checkBanPurge(query);
      const sql = await connection();
      return await dialect.transaction(sql, async (tx) => {
        await init.serialize?.(tx);
        const p = new Params(dialect);
        const end = "COALESCE(lifted_at, expires_at)";
        const rows = (await tx.unsafe(
          `SELECT id, revision FROM ${tables.bans}
            WHERE source = ${p.bind(source)} AND ${end} IS NOT NULL AND ${end} < ${p.bind(before)}
            ORDER BY ${end} ASC, id ASC LIMIT ${limit}`,
          p.values,
        )) as { id: string; revision: number | string }[];
        for (const row of rows) {
          const q = new Params(dialect);
          await tx.unsafe(
            `DELETE FROM ${tables.bans} WHERE id = ${q.bind(row.id)}`,
            q.values,
          );
          await record(tx, "ban", row.id, Number(row.revision), true);
        }
        return rows.length;
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
