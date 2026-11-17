/**
 * What every security store driver checks and encodes the same way: kinds,
 * ids, page limits, JSON bodies, and the keyset cursors bound to their walk
 * (storage.md §3.4, over bun-sql's `encodePageCursor`/`decodePageCursor`).
 */
import type {
  AuditCheckpoint,
  AuditInput,
  AuditQuery,
  DocKind,
  ListQuery,
  PolicyVersionRecord,
  StoredDoc,
} from "./types";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  decodePageCursor,
  encodePageCursor,
} from "@kingsleyweb/bun-sql/cursor";
import { DOC_KINDS, MAX_AUDIT_SCOPES, MAX_PAGE_LIMIT } from "./types";

/** The longest id a document or version may have. */
export const MAX_ID_LENGTH = 200;

/** Throws a `ConfigError` unless `kind` is a {@link DocKind}. */
export function checkKind(kind: unknown): asserts kind is DocKind {
  if (!DOC_KINDS.includes(kind as DocKind)) {
    throw new ConfigError(
      `security store: "${String(kind)}" is not a document kind (${DOC_KINDS.join(", ")})`,
      { kind },
    );
  }
}

/** Throws a `ConfigError` unless `id` is a usable id: 1 to 200 characters. */
export function checkId(id: unknown, what = "an id"): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
    throw new ConfigError(
      `security store: ${what} must be a string of 1 to ${MAX_ID_LENGTH} characters`,
      { id },
    );
  }
}

/** Throws a `ConfigError` unless `revision` is a positive whole number (or `null` where allowed). */
export function checkRevision(
  revision: unknown,
  nullable: boolean,
): asserts revision is number | null {
  if (revision === null && nullable) return;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new ConfigError(
      `security store: a revision must be a positive whole number${nullable ? " or null" : ""}`,
      { revision },
    );
  }
}

/** The query, checked, with its defaults filled in. */
export interface ResolvedQuery {
  /** The page size. */
  readonly limit: number;
  /** The cursor, if any. */
  readonly cursor: string | undefined;
  /** The order. */
  readonly sort: "id" | "updatedAt";
  /** The direction. */
  readonly direction: "asc" | "desc";
  /** The id prefix ("" for none). */
  readonly prefix: string;
}

/** Checks a {@link ListQuery} and fills in its defaults. */
export function resolveQuery(query: ListQuery): ResolvedQuery {
  if (typeof query !== "object" || query === null) {
    throw new ConfigError("security store: a list query must be an object");
  }
  const { limit } = query;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ConfigError(
      `security store: a page's limit must be a whole number from 1 to ${MAX_PAGE_LIMIT}`,
      { limit },
    );
  }
  const sort = query.sort ?? "id";
  if (sort !== "id" && sort !== "updatedAt") {
    throw new ConfigError(
      `security store: a list sorts by "id" or "updatedAt", not "${String(sort)}"`,
      { sort },
    );
  }
  const direction = query.direction ?? "asc";
  if (direction !== "asc" && direction !== "desc") {
    throw new ConfigError(
      `security store: a direction is "asc" or "desc", not "${String(direction)}"`,
      { direction },
    );
  }
  const prefix = query.prefix ?? "";
  if (typeof prefix !== "string" || prefix.length > MAX_ID_LENGTH) {
    throw new ConfigError(
      "security store: a prefix must be a string of at most 200 characters",
      { prefix },
    );
  }
  return { limit, cursor: query.cursor, sort, direction, prefix };
}

/** A document list's cursor prefix (`sd1.`) and kind. */
const DOC_CURSOR = { prefix: "sd1.", kind: "docs" } as const;

/** A version list's cursor prefix (`sv1.`) and kind. */
const VERSION_CURSOR = { prefix: "sv1.", kind: "versions" } as const;

/** The walk a document list's cursor is bound to. */
function docWalk(kind: DocKind, query: ResolvedQuery): string[] {
  return [kind, query.sort, query.direction, query.prefix];
}

/** Where a document page stopped: its sort value and id. */
export interface DocPosition {
  /** The sort value: the id, or `updatedAt`. */
  readonly value: string | number;
  /** The id, which breaks ties. */
  readonly id: string;
}

/** The cursor after `last`, for a document list. */
export function docCursor(
  kind: DocKind,
  query: ResolvedQuery,
  last: StoredDoc,
): string {
  return encodePageCursor(
    DOC_CURSOR.prefix,
    DOC_CURSOR.kind,
    docWalk(kind, query),
    [query.sort === "id" ? last.id : last.updatedAt, last.id],
  );
}

/** The position a document list's cursor names, or a `ConfigError` (another walk, malformed). */
export function docPosition(
  kind: DocKind,
  query: ResolvedQuery,
): DocPosition | undefined {
  if (query.cursor === undefined) return undefined;
  const [value, id] = decodePageCursor(
    query.cursor,
    DOC_CURSOR.prefix,
    DOC_CURSOR.kind,
    docWalk(kind, query),
    [query.sort === "id" ? "string" : "number", "string"],
  );
  return { value: value!, id: id as string };
}

/** The cursor after `last`, for a version list. */
export function versionCursor(
  policyId: string,
  query: ResolvedQuery,
  last: PolicyVersionRecord,
): string {
  return encodePageCursor(
    VERSION_CURSOR.prefix,
    VERSION_CURSOR.kind,
    [policyId, query.direction],
    [last.number],
  );
}

/** The version number a version list's cursor names, or a `ConfigError`. */
export function versionPosition(
  policyId: string,
  query: ResolvedQuery,
): number | undefined {
  if (query.cursor === undefined) return undefined;
  const [number] = decodePageCursor(
    query.cursor,
    VERSION_CURSOR.prefix,
    VERSION_CURSOR.kind,
    [policyId, query.direction],
    ["number"],
  );
  return number as number;
}

/**
 * A body as every driver stores it: through JSON, so `undefined` members
 * vanish and a `Date` becomes its string on every backend alike. Throws a
 * `ConfigError` for a value JSON cannot hold (a `bigint`, a cycle, a
 * top-level `undefined`).
 */
export function jsonBody(value: unknown, what: string): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new ConfigError(`security store: ${what} is not JSON`, {
      cause: String(error),
    });
  }
  if (text === undefined) {
    throw new ConfigError(`security store: ${what} is not JSON`);
  }
  return JSON.parse(text) as unknown;
}

/** Refuses a write to a `policy` document, whose head moves only with `appendVersion`. */
export function refusePolicyWrite(kind: DocKind, what: string): void {
  if (kind === "policy") {
    throw new ConfigError(
      `security store: a policy's head moves only with appendVersion(), not ${what}`,
      { kind },
    );
  }
}

/** Throws a `ConfigError` for a store that has been closed. */
export function refuseClosed(name: string, closed: boolean): void {
  if (closed) {
    throw new ConfigError(`security store "${name}" is closed`);
  }
}

/** Throws a `ConfigError` for a write to a read-only store. */
export function refuseReadOnly(name: string, what: string): never {
  throw new ConfigError(
    `security store "${name}" is read-only: ${what} is refused (edit its source instead)`,
  );
}

/** Checks a version's input and fills in its clock. */
export function checkVersionInput(
  version: unknown,
  now: () => number,
): {
  id: string;
  policy: unknown;
  createdAt: number;
  createdBy: string | undefined;
  message: string | undefined;
} {
  if (typeof version !== "object" || version === null) {
    throw new ConfigError("security store: a version must be an object");
  }
  const input = version as Record<string, unknown>;
  checkId(input.id, "a version's id");
  for (const field of ["createdBy", "message"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      throw new ConfigError(
        `security store: a version's ${field} must be a string`,
        { [field]: input[field] },
      );
    }
  }
  const createdAt = input.createdAt ?? now();
  if (!Number.isSafeInteger(createdAt) || (createdAt as number) < 0) {
    throw new ConfigError(
      "security store: a version's createdAt must be epoch milliseconds",
      { createdAt },
    );
  }
  return {
    id: input.id as string,
    policy: jsonBody(input.policy, "a version's policy"),
    createdAt: createdAt as number,
    createdBy: input.createdBy as string | undefined,
    message: input.message as string | undefined,
  };
}

/** Throws a `ConfigError` unless `seq` and `limit` are a usable change-feed read. */
export function checkFeedRead(seq: unknown, limit: unknown): void {
  if (typeof seq !== "bigint" || seq < 0n) {
    throw new ConfigError(
      "security store: changesSince() takes a non-negative bigint sequence",
      { seq: String(seq) },
    );
  }
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_PAGE_LIMIT
  ) {
    throw new ConfigError(
      `security store: changesSince()'s limit must be a whole number from 1 to ${MAX_PAGE_LIMIT}`,
      { limit },
    );
  }
}

/** Throws a `ConfigError` unless `bundle` and `expectedVersion` are a usable {@link SecurityStoreDriver.putBundle}; the checked input. */
export function checkBundleInput(
  bundle: unknown,
  expectedVersion: unknown,
): { version: number; bundle: unknown } {
  if (typeof bundle !== "object" || bundle === null) {
    throw new ConfigError("security store: a bundle must be an object");
  }
  const input = bundle as Record<string, unknown>;
  if (!Number.isSafeInteger(input.version) || (input.version as number) < 1) {
    throw new ConfigError(
      "security store: a bundle's version must be a positive whole number",
      { version: input.version },
    );
  }
  if (
    expectedVersion !== null &&
    (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1)
  ) {
    throw new ConfigError(
      "security store: expectedVersion must be a positive whole number, or null for a service with no bundle yet",
      { expectedVersion },
    );
  }
  return {
    version: input.version as number,
    bundle: jsonBody(input.bundle, "a bundle"),
  };
}

/** A bundle's entity tag: its version, quoted, as an HTTP `ETag` is. */
export function bundleEtag(version: number): string {
  return `"${version}"`;
}

/** The predecessor of the first audit entry: 64 zeros. */
export const AUDIT_GENESIS_HASH = "0".repeat(64);

/** A SHA-256 hash in hex. */
const HASH = /^[\da-f]{64}$/;

/** Throws a `ConfigError` unless `input` is a usable audit entry for `expectedPrevHash`; the checked input. */
export function checkAuditInput(
  input: unknown,
  expectedPrevHash: unknown,
): AuditInput {
  if (typeof input !== "object" || input === null) {
    throw new ConfigError("security store: an audit entry must be an object");
  }
  const entry = input as Record<string, unknown>;
  if (
    expectedPrevHash !== null &&
    (typeof expectedPrevHash !== "string" || !HASH.test(expectedPrevHash))
  ) {
    throw new ConfigError(
      "security store: expectedPrevHash must be a SHA-256 hex hash, or null for an empty chain",
    );
  }
  for (const field of ["hash", "prevHash"] as const) {
    if (typeof entry[field] !== "string" || !HASH.test(entry[field])) {
      throw new ConfigError(
        `security store: an audit entry's ${field} must be a SHA-256 hex hash`,
      );
    }
  }
  if (entry.prevHash !== (expectedPrevHash ?? AUDIT_GENESIS_HASH)) {
    throw new ConfigError(
      "security store: an audit entry's prevHash must be the head it is appended on",
    );
  }
  for (const field of ["actor", "action", "scope"] as const) {
    if (
      typeof entry[field] !== "string" ||
      entry[field] === "" ||
      (entry[field] as string).length > 200
    ) {
      throw new ConfigError(
        `security store: an audit entry's ${field} must be a string of 1 to 200 characters`,
      );
    }
  }
  if (!Number.isSafeInteger(entry.at) || (entry.at as number) < 0) {
    throw new ConfigError(
      "security store: an audit entry's at must be epoch milliseconds",
    );
  }
  return {
    hash: entry.hash as string,
    prevHash: entry.prevHash as string,
    at: entry.at as number,
    actor: entry.actor as string,
    action: entry.action as string,
    scope: entry.scope as string,
    entry: jsonBody(entry.entry, "an audit entry"),
  };
}

/** Throws a `ConfigError` unless `checkpoint` is a usable checkpoint. */
export function checkCheckpoint(checkpoint: unknown): AuditCheckpoint {
  if (typeof checkpoint !== "object" || checkpoint === null) {
    throw new ConfigError("security store: a checkpoint must be an object");
  }
  const cp = checkpoint as Record<string, unknown>;
  if (
    !Number.isSafeInteger(cp.n) ||
    (cp.n as number) < 1 ||
    typeof cp.hash !== "string" ||
    !HASH.test(cp.hash)
  ) {
    throw new ConfigError(
      "security store: a checkpoint needs an entry number and its hash",
    );
  }
  if (
    !Number.isSafeInteger(cp.at) ||
    typeof cp.keyId !== "string" ||
    typeof cp.signature !== "string"
  ) {
    throw new ConfigError(
      "security store: a checkpoint needs at, keyId and signature",
    );
  }
  return {
    n: cp.n as number,
    hash: cp.hash,
    at: cp.at as number,
    keyId: cp.keyId,
    signature: cp.signature,
  };
}

/** An audit list's query, checked and defaulted. */
export interface ResolvedAuditQuery {
  /** The page size. */
  readonly limit: number;
  /** The cursor, if any. */
  readonly cursor: string | undefined;
  /** The direction. */
  readonly direction: "asc" | "desc";
  /** The filter, normalised (absent members `""` or `-1`), which a cursor is bound to. */
  readonly filter: {
    readonly actor: string;
    readonly action: string;
    readonly scope: string;
    /** The scopes, sorted and unique; `null` for any. */
    readonly scopes: readonly string[] | null;
    readonly since: number;
    readonly until: number;
    readonly fromN: number;
    readonly toN: number;
  };
}

/** Checks an audit query. */
export function resolveAuditQuery(query: AuditQuery): ResolvedAuditQuery {
  const base = resolveQuery({
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.direction === undefined ? {} : { direction: query.direction }),
  });
  for (const field of ["since", "until", "fromN", "toN"] as const) {
    if (
      query[field] !== undefined &&
      (!Number.isSafeInteger(query[field]) || (query[field] as number) < 0)
    ) {
      throw new ConfigError(
        `security store: an audit query's ${field} must be a whole number`,
      );
    }
  }
  let scopes: string[] | null = null;
  if (query.scopes !== undefined) {
    if (
      !Array.isArray(query.scopes) ||
      query.scopes.length === 0 ||
      query.scopes.length > MAX_AUDIT_SCOPES ||
      query.scopes.some((scope) => typeof scope !== "string" || scope === "")
    ) {
      throw new ConfigError(
        `security store: an audit query's scopes must be 1 to ${MAX_AUDIT_SCOPES} scope names`,
      );
    }
    scopes = [...new Set(query.scopes)].sort();
  }
  return {
    limit: base.limit,
    cursor: base.cursor,
    direction: base.direction,
    filter: {
      actor: query.actor ?? "",
      action: query.action ?? "",
      scope: query.scope ?? "",
      scopes,
      since: query.since ?? -1,
      until: query.until ?? -1,
      fromN: query.fromN ?? -1,
      toN: query.toN ?? -1,
    },
  };
}

/** The walk an audit cursor is bound to. */
function auditWalk(query: ResolvedAuditQuery): string[] {
  const f = query.filter;
  return [
    query.direction,
    f.actor,
    f.action,
    f.scope,
    f.scopes === null
      ? ""
      : new Bun.CryptoHasher("sha256")
          .update(f.scopes.join("\n"))
          .digest("hex"),
    String(f.since),
    String(f.until),
    String(f.fromN),
    String(f.toN),
  ];
}

/** The cursor after entry `n`. */
export function auditCursor(query: ResolvedAuditQuery, n: number): string {
  return encodePageCursor("sa1.", "audit", auditWalk(query), [n]);
}

/** The entry number an audit cursor names, or a `ConfigError` (another walk, malformed). */
export function auditPosition(query: ResolvedAuditQuery): number | undefined {
  if (query.cursor === undefined) return undefined;
  const [n] = decodePageCursor(
    query.cursor,
    "sa1.",
    "audit",
    auditWalk(query),
    ["number"],
  );
  return n as number;
}

/** Checks a counter's key and lifetime. */
export function checkCounter(key: string, ttlMs?: number): void {
  if (typeof key !== "string" || key.length === 0 || key.length > 200) {
    throw new ConfigError(
      "security store: a counter's key must be 1 to 200 characters",
    );
  }
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1)) {
    throw new ConfigError(
      "security store: a counter's ttlMs must be a positive whole number",
    );
  }
}

/** The cursor after checkpoint `n`. */
export function checkpointCursor(direction: string, n: number): string {
  return encodePageCursor("sc1.", "checkpoints", [direction], [n]);
}

/** The checkpoint number a cursor names. */
export function checkpointPosition(
  cursor: string | undefined,
  direction: string,
): number | undefined {
  if (cursor === undefined) return undefined;
  const [n] = decodePageCursor(
    cursor,
    "sc1.",
    "checkpoints",
    [direction],
    ["number"],
  );
  return n as number;
}
