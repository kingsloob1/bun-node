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
  | "operator"
  | "roleBinding"
  | "alertChannel"
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
  "operator",
  "roleBinding",
  "alertChannel",
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
  /** Events, counters, rollups and range queries (the analytics operations, which arrive with the CP). */
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
      /** The change the write appended. */
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

/** What a {@link Change} names: a document's kind, or `bundle` for a service's bundle. */
export type ChangeKind = DocKind | "bundle";

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
 * way out: the seam storage.md §8's field sealing (PR-D3) plugs into, so a
 * sealed body copied to another row (another context) fails to open.
 * `seal` answers a JSON value (a sealed field is its base64 text);
 * `open` throws for a body it cannot open. Default: stored as given.
 */
export interface StoreCodec {
  /** Encodes a body for storage. */
  readonly seal: (body: unknown, context: StoreCodecContext) => unknown;
  /** Decodes a stored body. */
  readonly open: (stored: unknown, context: StoreCodecContext) => unknown;
}

/** The largest {@link ListQuery.limit}. */
export const MAX_PAGE_LIMIT = 1_000;

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

  /** The changes after `seq`, oldest first, at most `limit`, and the feed's head. */
  changesSince: (
    seq: bigint,
    limit: number,
  ) => Promise<{ readonly changes: readonly Change[]; readonly head: bigint }>;
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
