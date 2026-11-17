/**
 * The security store's interface (storage.md §3): where durable
 * configuration lives — documents with revisions, policy versions with a
 * head moved by compare-and-set, and a monotonic change feed — whatever the
 * engine behind it. PR-D1 builds it with `memoryStore`, `sqliteStore` and the
 * read-only `policyFile`; `postgresStore` is PR-D2.
 *
 * Resource-oriented, not a key-value store: the screens need filtered,
 * sorted, paginated lists, and a policy needs compare-and-set. Every
 * mutation appends a {@link Change} in the same statement or transaction, so
 * {@link SecurityStoreDriver.changesSince} never misses a write (an outbox,
 * not a notification that can be lost).
 *
 * The control plane's records (bans, the audit chain, signed bundles and
 * analytics, storage.md §3.1) join this interface with the PRs that define
 * them; a driver built now gains them then.
 */
import type { SchemaChange, SchemaSyncOptions } from "@kingsleyweb/bun-sql";

/**
 * The kinds of document a store holds (storage.md §3.1). `policy` documents
 * are heads, moved only by {@link SecurityStoreDriver.appendVersion}.
 */
export type DocKind =
  | "service"
  | "group"
  | "policy"
  | "serviceIdentity"
  | "agentKey"
  | "agentHealth"
  | "operator"
  | "roleBinding"
  | "alertChannel"
  | "alertRule"
  | "listEntry"
  | "approval"
  | "policyDraft";

/** Every {@link DocKind}, in a fixed order. */
export const DOC_KINDS: readonly DocKind[] = Object.freeze([
  "service",
  "group",
  "policy",
  "serviceIdentity",
  "agentKey",
  "agentHealth",
  "operator",
  "roleBinding",
  "alertChannel",
  "alertRule",
  "listEntry",
  "approval",
  "policyDraft",
] as const);

/** What a driver can do (storage.md §3.3); the engine and the CP refuse a driver whose capabilities do not fit. */
export interface SecurityStoreCapabilities {
  /** Survives a restart. */
  readonly durable: boolean;
  /** Several processes on one host may share it. */
  readonly multiProcess: boolean;
  /** Several hosts may share it. */
  readonly multiHost: boolean;
  /** A mutation and its change row land atomically. */
  readonly transactions: boolean;
  /** How a follower learns of a change: `push` ({@link SecurityStoreDriver.subscribe}) or `poll` ({@link SecurityStoreDriver.changesSince}). */
  readonly changeFeed: "push" | "poll";
  /** Events, counters, rollups and range queries: the analytics operations of {@link SecurityStoreDriver} are present. */
  readonly analytics: boolean;
  /** An index answering "which entries contain this address". */
  readonly cidrQuery: boolean;
  /** Writes are refused: a source of reviewed configuration (`policyFile`). */
  readonly readOnly: boolean;
}

/** A document as stored. */
export interface StoredDoc {
  /** Its kind. */
  readonly kind: DocKind;
  /** Its id, unique within its kind. */
  readonly id: string;
  /** Its revision: 1 when created, one more on every write. */
  readonly revision: number;
  /** Its body, a JSON value. */
  readonly doc: unknown;
  /** When it was last written, epoch milliseconds. */
  readonly updatedAt: number;
}

/** What {@link SecurityStoreDriver.put} answers. */
export type PutResult =
  | {
      /** Written. */
      readonly ok: true;
      /** The document's new revision. */
      readonly revision: number;
      /** The change the write appended; `0n` for a kind kept out of the feed (`agentHealth`). */
      readonly seq: bigint;
    }
  | {
      /** Refused: the stored revision is not the one named. */
      readonly ok: false;
      /** The document as it is now (`undefined`: it does not exist). */
      readonly conflict: StoredDoc | undefined;
    };

/** What an append (a version, later an audit entry) answers. */
export type AppendResult =
  | {
      /** Appended. */
      readonly ok: true;
      /** The change the append wrote. */
      readonly seq: bigint;
    }
  | {
      /** Refused: the head is not the one named. */
      readonly ok: false;
      /** The head as it is now (`null`: none yet). */
      readonly head: string | null;
    };

/** A published version of a policy, as appended. */
export interface PolicyVersionInput {
  /** The version's id, unique within its policy (a content hash, a ULID). */
  readonly id: string;
  /** The policy, a JSON value (a `SecurityPolicy`). */
  readonly policy: unknown;
  /** Who published it. */
  readonly createdBy?: string;
  /** Why, in a line. */
  readonly message?: string;
  /** When, epoch milliseconds. Default: the store's clock. */
  readonly createdAt?: number;
}

/** A published version of a policy, as stored. */
export interface PolicyVersionRecord {
  /** The policy it belongs to. */
  readonly policyId: string;
  /** Its id, unique within the policy. */
  readonly id: string;
  /** Its number: 1 for the first, one more for each after. */
  readonly number: number;
  /** The policy, a JSON value. */
  readonly policy: unknown;
  /** When it was published, epoch milliseconds. */
  readonly createdAt: number;
  /** Who published it, when recorded. */
  readonly createdBy: string | undefined;
  /** Why, when recorded. */
  readonly message: string | undefined;
}

/** A policy's head document (kind `policy`): the version in force. */
export interface PolicyHead {
  /** The head version's id. */
  readonly head: string;
  /** The head version's number. */
  readonly number: number;
}

/** A service's signed bundle, as given to {@link SecurityStoreDriver.putBundle}. */
export interface BundleInput {
  /** Its version: higher than every bundle the service had before (control-plane.md §3.3). */
  readonly version: number;
  /** The signed bundle, a JSON value (`bun-security.bundle/1`). The store never signs or checks it. */
  readonly bundle: unknown;
}

/** A service's signed bundle, as stored. */
export interface StoredBundle {
  /** The service it was compiled for. */
  readonly serviceId: string;
  /** Its version, monotonic per service. */
  readonly version: number;
  /** Its entity tag, `"<version>"`, for a conditional read (`If-None-Match`). */
  readonly etag: string;
  /** The signed bundle, a JSON value. */
  readonly bundle: unknown;
  /** When it was stored, epoch milliseconds. */
  readonly updatedAt: number;
}

/** What {@link SecurityStoreDriver.putBundle} answers. */
export type PutBundleResult =
  | {
      /** Stored. */
      readonly ok: true;
      /** The change the write appended. */
      readonly seq: bigint;
    }
  | {
      /** Refused: the stored version is not the one named, or the new one is not higher. */
      readonly ok: false;
      /** The version stored now (`null`: none yet). */
      readonly version: number | null;
    };

/** What a {@link Change} names: a document's kind, `bundle` for a service's bundle, `audit` for an audit entry. */
export type ChangeKind = DocKind | "bundle" | "audit" | "ban";

/**
 * An audit entry to append (control-plane.md §6): the control plane
 * computes its hash over its predecessor's; the store keeps the chain
 * linear (`expectedPrevHash`) and the columns it filters on.
 */
export interface AuditInput {
  /** `SHA-256(prevHash || canonical JSON of entry)`, hex. */
  readonly hash: string;
  /** The hash of the entry before it (64 zeros for the first). */
  readonly prevHash: string;
  /** When, epoch milliseconds. */
  readonly at: number;
  /** Who: the operator's id, `break-glass`, or `system`. */
  readonly actor: string;
  /** What (`policy.publish`, `service.put`, `breakGlass.login`). */
  readonly action: string;
  /** The scope it acted on (`global`, `group:<id>`, `service:<id>`). */
  readonly scope: string;
  /** The entry, a JSON value: what the hash covers. */
  readonly entry: unknown;
}

/** An audit entry as stored. */
export interface AuditRecord extends AuditInput {
  /** Its number: 1 for the first, one more for each after, never reused. */
  readonly n: number;
}

/** The audit chain's head. */
export interface AuditHead {
  /** The last entry's number. */
  readonly n: number;
  /** The last entry's hash. */
  readonly hash: string;
}

/** What {@link SecurityStoreDriver.appendAuditAtHead} answers. */
export interface AuditAppended {
  /** The entry's number. */
  readonly n: number;
  /** The change the append wrote. */
  readonly seq: bigint;
  /** The entry as appended (what `make` answered). */
  readonly entry: AuditInput;
}

/** What {@link SecurityStoreDriver.appendAudit} answers. */
export type AppendAuditResult =
  | {
      /** Appended. */
      readonly ok: true;
      /** The entry's number. */
      readonly n: number;
      /** The change the append wrote. */
      readonly seq: bigint;
    }
  | {
      /** Refused: the head is not the one named. */
      readonly ok: false;
      /** The head as it is now (`null`: an empty chain). */
      readonly head: AuditHead | null;
    };

/** An audit list's query: a page by number, filtered. */
export interface AuditQuery {
  /** The most entries a page holds, 1 to {@link MAX_PAGE_LIMIT}. */
  readonly limit: number;
  /** The previous page's `next`, bound to the same filter and direction. */
  readonly cursor?: string;
  /** `asc` (oldest first, the default) or `desc`. */
  readonly direction?: "asc" | "desc";
  /** Only entries by this actor. */
  readonly actor?: string;
  /** Only entries of this action. */
  readonly action?: string;
  /** Only entries on this scope. */
  readonly scope?: string;
  /** Only entries on one of these scopes (a group and what is under it), 1 to {@link MAX_AUDIT_SCOPES}. */
  readonly scopes?: readonly string[];
  /** Only entries at or after this time, epoch milliseconds. */
  readonly since?: number;
  /** Only entries before this time. */
  readonly until?: number;
  /** Only entries numbered at least this. */
  readonly fromN?: number;
  /** Only entries numbered at most this. */
  readonly toN?: number;
}

/** What a ban refuses, as the control plane keeps it: the subject an EP's `ban()` takes. */
export interface StoredBanSubject {
  /** `ip` (an address), `cidr` (a range), `user` or `apiKey`. */
  readonly type: "ip" | "cidr" | "user" | "apiKey";
  /** The address or range, or a user's or an API key's HMAC under the fleet's secret (32 hex characters; never the id). */
  readonly value: string;
}

/** A ban to write (storage.md §3.1). */
export interface BanInputRecord {
  /** Where it applies: `global`, `group:<id>` or `service:<id>`. */
  readonly scope: string;
  /** What it refuses. */
  readonly subject: StoredBanSubject;
  /** `ban` refuses; `challenge` challenges. */
  readonly action: "ban" | "challenge";
  /** Why, for operators (1 to 500 characters); never sent to a client. */
  readonly reason: string;
  /** `manual` (an operator) or `auto` (a rule on an EP). */
  readonly source: "auto" | "manual";
  /** When it ends, epoch ms; `null` until lifted. */
  readonly expiresAt: number | null;
  /** Who wrote it (an operator id, or the reporting service). */
  readonly createdBy?: string;
  /** The rule that wrote an automatic ban. */
  readonly rule?: string;
  /** The problem code it answers with. */
  readonly code?: string;
  /** The service that reported an automatic ban. */
  readonly service?: string;
}

/** A stored ban. */
export interface BanRecord extends BanInputRecord {
  /** Its id: one per scope and subject ({@link banId}). */
  readonly id: string;
  /** When it (last) started, epoch ms. */
  readonly createdAt: number;
  /** When it was last written. */
  readonly updatedAt: number;
  /** How many times it was written, merges and restarts included. */
  readonly count: number;
  /** Its revision, one more per write or lift. */
  readonly revision: number;
  /** When it was lifted; `null` while not. */
  readonly liftedAt: number | null;
  /** Who lifted it. */
  readonly liftedBy?: string;
}

/** A ban list's query. */
export interface BanQuery {
  /** The most bans a page holds, 1 to {@link MAX_PAGE_LIMIT}. */
  readonly limit: number;
  /** The previous page's `next`, bound to the same filter and direction. */
  readonly cursor?: string;
  /** By id, `asc` (the default) or `desc`. */
  readonly direction?: "asc" | "desc";
  /** Only bans on one of these scopes, 1 to {@link MAX_AUDIT_SCOPES}. */
  readonly scopes?: readonly string[];
  /** `true`: only bans in force now (not lifted, not expired); `false`: only the others (history). */
  readonly active?: boolean;
}

/** A short-lived counter's value. */
export interface CounterValue {
  /** How many increments since it started. */
  readonly count: number;
  /** When it expires, epoch milliseconds. */
  readonly expiresAt: number;
}

/** The most scopes an audit query's `scopes` names. */
export const MAX_AUDIT_SCOPES = 5_000;

/** A signed checkpoint of the audit chain (control-plane.md §6.2). */
export interface AuditCheckpoint {
  /** The entry it covers: the chain up to and including it. */
  readonly n: number;
  /** That entry's hash. */
  readonly hash: string;
  /** When it was signed, epoch milliseconds. */
  readonly at: number;
  /** The audit key's id. */
  readonly keyId: string;
  /** The Ed25519 signature over `{ n, hash, at }`'s canonical JSON, base64. */
  readonly signature: string;
}

/** One entry of the change feed. */
export interface Change {
  /** Its sequence number: strictly increasing, never reused. */
  readonly seq: bigint;
  /** The kind of document changed, or `bundle` (its id is the service's, its revision the bundle's version). */
  readonly kind: ChangeKind;
  /** The document's id. */
  readonly id: string;
  /** The document's revision after the change (its last one, for a delete). */
  readonly revision: number;
  /** Whether the change deleted it. */
  readonly deleted: boolean;
}

/** A page request (storage.md §3.4). */
export interface ListQuery {
  /** The most items a page holds, 1 to {@link MAX_PAGE_LIMIT}. */
  readonly limit: number;
  /** Where the previous page stopped: its `next`. Bound to the walk (the kind, sort, direction and filter). */
  readonly cursor?: string;
  /** The order. Documents: `id` (default) or `updatedAt`; versions: by number, always. */
  readonly sort?: "id" | "updatedAt";
  /** `asc` (default) or `desc`. */
  readonly direction?: "asc" | "desc";
  /** Documents whose id starts with this, for {@link SecurityStoreDriver.list}. */
  readonly prefix?: string;
}

/** A page of a list. */
export interface Page<T> {
  /** The items, in order. */
  readonly items: readonly T[];
  /** The cursor of the next page; absent on the last. */
  readonly next?: string;
  /** An estimate of how many items the walk has, where one is cheap; never a count per page. */
  readonly totalEstimate?: number;
}

/** Where a stored body sits, for a {@link StoreCodec}: what its sealing binds it to. */
export interface StoreCodecContext {
  /** The table's role: a document's body, a policy version's policy, or a service's bundle. */
  readonly field: "doc" | "policy" | "bundle";
  /** The document's kind (`policy` for a version, `bundle` for a bundle). */
  readonly kind: ChangeKind;
  /** The document's id, the policy's id for a version, or the service's for a bundle. */
  readonly id: string;
  /** The version's id, for a version's policy. */
  readonly version?: string;
}

/**
 * How a durable store encodes every body it stores and decodes it on the
 * way out: the seam storage.md §8's field sealing plugs into
 * (`sealedFields` from `./sealing`), so a sealed body copied to another row
 * (another context) fails to open. Both are synchronous: `seal` answers a
 * JSON value, `open` throws for a body it cannot open. Default: stored as
 * given.
 */
export interface StoreCodec {
  /** Encodes a body for storage. */
  readonly seal: (body: unknown, context: StoreCodecContext) => unknown;
  /** Decodes a stored body. */
  readonly open: (stored: unknown, context: StoreCodecContext) => unknown;
}

/** The largest {@link ListQuery.limit}. */
export const MAX_PAGE_LIMIT = 1_000;

/** A tier of counters: a bucket's width (README §8.3). */
export type Tier = "minute" | "hour" | "day";

/** Each {@link Tier}'s bucket width, in milliseconds; buckets are aligned to the epoch (UTC). */
export const TIER_MS: Readonly<Record<Tier, number>> = Object.freeze({
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
});

/** What analytics retention deletes from (README §8.4): the events, each counter tier, and the ingested batch ids. */
export type RetainedTable = "events" | "minute" | "hour" | "day" | "batches";

/** The keys an event is filed under (README §8.1): the subjects a refusal counts against. */
export interface SecurityEventSubjects {
  /** The address key: an IPv4 address, or an IPv6 `/64`. */
  readonly ip?: string;
  /** The user id the app's `identify()` answered. */
  readonly user?: string;
  /** The API key's id (never the key). */
  readonly apiKey?: string;
  /** The attempted login identifier, as its HMAC. */
  readonly username?: string;
}

/**
 * One stored decision (README §8.1): what an enforcement point decided for
 * a request it sampled. The store indexes the named fields; `sample` is
 * opaque to it (the redacted request, the redaction module's to fill).
 */
export interface SecurityEvent {
  /** Its id: 1 to 64 characters, unique in the store (an enforcement point draws it at random). */
  readonly id: string;
  /** When the request was decided, epoch milliseconds. */
  readonly at: number;
  /** The service that decided it. */
  readonly service: string;
  /** The action taken (`block`, `challenge`, …; `log` for a dry-run-only hit, `allow` for a sampled allow). */
  readonly action: string;
  /** The rule that decided the action, when one did. */
  readonly rule?: string;
  /** Every rule hit, in the order the layers ran. */
  readonly rules?: readonly string[];
  /** Whether the deciding hit was in dry run (it would have been `action`). */
  readonly dryRun?: boolean;
  /** The route's key (its pattern, `POST /login`), when the route is known. */
  readonly route?: string;
  /** The subjects the request was counted against. */
  readonly subjects?: SecurityEventSubjects;
  /** The client's country, ISO 3166-1 alpha-2, when known. */
  readonly country?: string;
  /** The client's autonomous system number, when known. */
  readonly asn?: number;
  /** How long the decision took, milliseconds. */
  readonly latencyMs?: number;
  /**
   * On a sampled `allow`: the share of allows kept (the ring's
   * `sampleAllows`, `0.001` by default), stamped since PR-CP7 so a reader
   * knows what one stored allow stands for. Absent on every other action
   * (each is offered) and on allows stored before.
   */
  readonly sampleRate?: number;
  /** The status the request was answered with, when known. */
  readonly status?: number;
  /** The redacted request sample and anything else recorded: a JSON value the store keeps as given. */
  readonly sample?: unknown;
}

/** Which events {@link SecurityStoreDriver.listEvents} answers: every field given must match. */
export interface EventFilter {
  /** One event, by its id. */
  readonly id?: string;
  /** One service's. */
  readonly service?: string;
  /** Any of these services' (a group's scope), at most {@link MAX_FILTER_SERVICES}; `[]` matches none. */
  readonly services?: readonly string[];
  /** From this time, epoch milliseconds, inclusive. */
  readonly from?: number;
  /** Before this time, epoch milliseconds, exclusive. */
  readonly to?: number;
  /** One action's. */
  readonly action?: string;
  /** One deciding rule's. */
  readonly rule?: string;
  /** One route's. */
  readonly route?: string;
  /** One address key's. */
  readonly ip?: string;
  /** One user's. */
  readonly user?: string;
  /** One API key id's. */
  readonly apiKey?: string;
  /** One attempted login identifier's (its HMAC). */
  readonly username?: string;
  /** One country's. */
  readonly country?: string;
  /** One autonomous system's. */
  readonly asn?: number;
  /** Dry-run hits only (`true`), or enforced ones only (`false`). */
  readonly dryRun?: boolean;
}

/** A page of events: newest first by default, keyset by time and id. */
export interface EventListQuery extends EventFilter {
  /** The most items a page holds, 1 to {@link MAX_PAGE_LIMIT}. */
  readonly limit: number;
  /** Where the previous page stopped: its `next`, bound to the same filter and direction. */
  readonly cursor?: string;
  /** `desc` (default: the newest first) or `asc`. */
  readonly direction?: "asc" | "desc";
}

/**
 * One counter increment (README §8.1), added to the stored row of its
 * service, tier, bucket, metric and dimensions (an upsert that adds).
 */
export interface CounterRow {
  /** The service counted. */
  readonly service: string;
  /** The tier written: `minute` (default) for an enforcement point's minutes, `day` for exact daily counts. */
  readonly tier?: Tier;
  /** A time in the bucket, epoch milliseconds; aligned down to the tier's bucket. */
  readonly at: number;
  /** What is counted (`requests`, `rules`, `top.refused`): 1 to 100 of `a-z 0-9 . _ -`. */
  readonly metric: string;
  /** What it is counted by (`{ action: "block" }`): at most 8, names of `a-z A-Z 0-9 _`, values at most 200 characters. */
  readonly dims?: Readonly<Record<string, string>>;
  /** How much to add: a non-negative whole number. */
  readonly value: number;
}

/** A range of counters, for {@link SecurityStoreDriver.series} and {@link SecurityStoreDriver.topK}. */
export interface CounterQuery {
  /** One service's; every service's summed when absent. */
  readonly service?: string;
  /** These services' summed (a group's scope), at most {@link MAX_FILTER_SERVICES}; `[]` matches none. */
  readonly services?: readonly string[];
  /** The metric. */
  readonly metric: string;
  /** From this time, epoch milliseconds (aligned down to the tier's bucket). */
  readonly from: number;
  /** Before this time, epoch milliseconds, exclusive. */
  readonly to: number;
  /** The tier read. Default by the range: a minute up to 6 h, an hour up to 14 d, a day beyond (README §8.3). */
  readonly tier?: Tier;
  /** Only rows whose dimensions include these (a partial match). */
  readonly dims?: Readonly<Record<string, string>>;
}

/** {@link SecurityStoreDriver.series}' query: a counter range, one point per bucket and dimension set. */
export type SeriesQuery = CounterQuery;

/** One point of a series. */
export interface SeriesPoint {
  /** The bucket's start, epoch milliseconds. */
  readonly at: number;
  /** The row's dimensions. */
  readonly dims: Readonly<Record<string, string>>;
  /** The sum over the services read. */
  readonly value: number;
}

/** {@link SecurityStoreDriver.topK}'s query: a counter range summed per dimension set, the largest first. */
export interface TopKQuery extends CounterQuery {
  /** How many, 1 to {@link MAX_PAGE_LIMIT}. */
  readonly limit: number;
}

/** One row of a top-K. */
export interface TopKRow {
  /** The dimensions (`{ kind: "ip", subject: "203.0.113.7" }`). */
  readonly dims: Readonly<Record<string, string>>;
  /** Their sum over the range. */
  readonly value: number;
}

/** The most points {@link SecurityStoreDriver.series} answers; a wider query is refused (a `ConfigError`). */
export const MAX_SERIES_POINTS = 10_000;

/** The most services a `services` filter names. */
export const MAX_FILTER_SERVICES = 1_000;

/** The most events one {@link SecurityStoreDriver.appendEvents} takes. */
export const MAX_BATCH_EVENTS = 1_000;

/** The most counter rows one write takes. */
export const MAX_BATCH_COUNTERS = 20_000;

/**
 * A security store (storage.md §3.1). Every method rejects with the
 * backend's error when it is unreachable; a refused write is an answer
 * (`ok: false`), never a rejection.
 */
export interface SecurityStoreDriver {
  /** The driver's name, for messages: `memory`, `sqlite`, `policy-file`. */
  readonly name: string;
  /** What it can do. */
  readonly capabilities: SecurityStoreCapabilities;
  /** Opens it: connects, creates its schema. Idempotent; the other methods call it. */
  connect: () => Promise<void>;
  /** Closes it. Idempotent. */
  close: () => Promise<void>;
  /** Brings an existing schema in line with this version's (bun-sql's sync, CLAUDE.md "Schema sync"). */
  syncSchema?: (options?: SchemaSyncOptions) => Promise<SchemaChange[]>;

  /** One document, or `undefined`. */
  get: (kind: DocKind, id: string) => Promise<StoredDoc | undefined>;
  /** A page of one kind's documents. */
  list: (kind: DocKind, query: ListQuery) => Promise<Page<StoredDoc>>;
  /**
   * Writes a document only if its stored revision is `ifRevision` (`null`:
   * only if it does not exist). Never for kind `policy`, whose head moves
   * with {@link appendVersion} (a `ConfigError`).
   */
  put: (
    kind: DocKind,
    id: string,
    doc: unknown,
    ifRevision: number | null,
  ) => Promise<PutResult>;
  /** Deletes a document only if its stored revision is `ifRevision`; whether it did. */
  delete: (kind: DocKind, id: string, ifRevision: number) => Promise<boolean>;

  /**
   * Appends a version to a policy and moves its head to it, only if the
   * head is `expectedHead` (`null`: the policy has no version yet). A
   * version id the policy already has is refused like a moved head.
   */
  appendVersion: (
    policyId: string,
    version: PolicyVersionInput,
    expectedHead: string | null,
  ) => Promise<AppendResult>;
  /** One version of a policy, or `undefined`. */
  getVersion: (
    policyId: string,
    versionId: string,
  ) => Promise<PolicyVersionRecord | undefined>;
  /** A page of a policy's versions, by number (`desc` for the newest first). */
  listVersions: (
    policyId: string,
    query: ListQuery,
  ) => Promise<Page<PolicyVersionRecord>>;

  /**
   * Stores a service's signed bundle only if the stored version is
   * `expectedVersion` (`null`: none yet) and `bundle.version` is higher
   * (storage.md §3.1). It appends a `bundle` change.
   */
  putBundle: (
    serviceId: string,
    bundle: BundleInput,
    expectedVersion: number | null,
  ) => Promise<PutBundleResult>;
  /**
   * A service's bundle; `"not-modified"` when `ifNoneMatch` is its
   * entity tag; `undefined` when it has none.
   */
  getBundle: (
    serviceId: string,
    ifNoneMatch?: string,
  ) => Promise<StoredBundle | "not-modified" | undefined>;

  /**
   * Appends an audit entry only if the chain's head hash is
   * `expectedPrevHash` (`null`: the chain is empty) and the entry's
   * `prevHash` is it (storage.md §3.2): two writers never fork the chain.
   * It appends an `audit` change.
   */
  appendAudit: (
    entry: AuditInput,
    expectedPrevHash: string | null,
  ) => Promise<AppendAuditResult>;
  /**
   * Appends an audit entry on the chain's head, whatever it is now: the
   * head is read and the entry appended in one serialised transaction (the
   * store's write lock: Postgres's advisory lock, SQLite's `BEGIN
   * IMMEDIATE`), so the append never loses to another writer, in this
   * process or another. `make` is called once, with the head as read
   * there, and answers the entry, whose `prevHash` must be that head's hash
   * (64 zeros for an empty chain); it must not wait. Appends an `audit`
   * change. The control plane's audit log appends through it (#846).
   */
  appendAuditAtHead: (
    make: (head: AuditHead | null) => AuditInput,
  ) => Promise<AuditAppended>;
  /** The chain's head, or `null` when it has never had an entry. Kept after a purge. */
  getAuditHead: () => Promise<AuditHead | null>;
  /** A page of audit entries by number, filtered. */
  listAudit: (query: AuditQuery) => Promise<Page<AuditRecord>>;
  /** Stores a checkpoint; a second one for the same number is ignored. */
  appendCheckpoint: (checkpoint: AuditCheckpoint) => Promise<void>;
  /** A page of checkpoints by number. */
  listCheckpoints: (query: {
    /** The page size. */
    readonly limit: number;
    /** The previous page's `next`. */
    readonly cursor?: string;
    /** `asc` (default) or `desc`. */
    readonly direction?: "asc" | "desc";
  }) => Promise<Page<AuditCheckpoint>>;
  /**
   * Retention only (control-plane.md §6.2, never an API route): deletes up
   * to `limit` entries numbered below `beforeN`, oldest first; how many.
   */
  deleteAuditBefore: (beforeN: number, limit: number) => Promise<number>;

  /**
   * Adds one to the short-lived counter `key` and sets its expiry `ttlMs`
   * from now; an expired or absent one starts again at 1. Atomic across
   * every client of the store (control-plane state shared by instances:
   * the break-glass failures).
   */
  incrementCounter: (key: string, ttlMs: number) => Promise<CounterValue>;
  /** The counter `key`, or `undefined` when absent or expired. */
  getCounter: (key: string) => Promise<CounterValue | undefined>;
  /** Removes the counter `key` (a claim too); absent is fine. */
  resetCounter: (key: string) => Promise<void>;
  /**
   * Claims `key` for `ttlMs` when no live claim holds it: `true` for the
   * first caller, `false` for every other until it expires. Atomic across
   * every client (single-use codes).
   */
  claimKey: (key: string, ttlMs: number) => Promise<boolean>;

  /**
   * Writes a ban, merged with the record its scope and subject already have
   * (storage.md §3.1): an active one merges (a manual ban's description
   * replaces an automatic one's, `ban` beats `challenge`, the later expiry
   * wins and "until lifted" beats a date, the count grows); a lifted or
   * expired one starts again, its count kept. The stored record.
   */
  upsertBan: (ban: BanInputRecord) => Promise<BanRecord>;
  /** Lifts the ban `id` (its record is kept, as history); `false` when there is none or it is not active. */
  liftBan: (id: string, by: string, at: number) => Promise<boolean>;
  /** One ban by id, active or not. */
  getBan: (id: string) => Promise<BanRecord | undefined>;
  /** A page of bans by id, filtered by scope and by whether they are active now. */
  listBans: (query: BanQuery) => Promise<Page<BanRecord>>;

  /** The changes after `seq`, oldest first, at most `limit`, and the feed's head. */
  changesSince: (
    seq: bigint,
    limit: number,
  ) => Promise<{ readonly changes: readonly Change[]; readonly head: bigint }>;
  /**
   * Stores a batch of events, once: a `batchId` already stored answers
   * `{ duplicate: true }` and writes nothing, so a resent batch is never
   * counted twice. `counters`, when given, are added in the same
   * transaction (an enforcement point's batch carries both). An event id
   * already stored is skipped. Present when `capabilities.analytics`.
   */
  appendEvents?: (
    batchId: string,
    events: readonly SecurityEvent[],
    counters?: readonly CounterRow[],
  ) => Promise<{ readonly duplicate: boolean }>;
  /**
   * Adds counter rows (an upsert that adds, by service, tier, bucket,
   * metric and dimensions). A row for a bucket already rolled up is added
   * to the rolled-up tiers too, so a late batch is never lost from them.
   */
  addCounters?: (rows: readonly CounterRow[]) => Promise<void>;
  /** A page of events matching the filter, by time and id (newest first by default). */
  listEvents?: (query: EventListQuery) => Promise<Page<SecurityEvent>>;
  /** A metric's points over a range, one per bucket and dimension set, oldest first. */
  series?: (query: SeriesQuery) => Promise<readonly SeriesPoint[]>;
  /** A metric summed per dimension set over a range, the largest first. */
  topK?: (query: TopKQuery) => Promise<readonly TopKRow[]>;
  /**
   * Rolls `from` rows up into `to` buckets (`minute` to `hour`, `hour` to
   * `day`) for every `to` bucket that ends by `until`, each bucket once
   * (a watermark). Answers how many `to` rows it wrote.
   */
  rollup?: (from: Tier, to: Tier, until: number) => Promise<number>;
  /**
   * Deletes at most `limit` rows of `table` older than `before`; answers
   * how many. Never a counter row not yet rolled up into the next tier.
   */
  deleteBefore?: (
    table: RetainedTable,
    before: number,
    limit: number,
  ) => Promise<number>;

  /**
   * Calls `listener` with the feed's head after changes land, where the
   * driver can push (`capabilities.changeFeed: "push"`); `onGap` when it
   * may have missed some, which a follower answers with a full reconcile.
   * Answers the unsubscribe.
   */
  subscribe?: (
    listener: (head: bigint) => void,
    onGap: () => void,
  ) => () => void;
}
