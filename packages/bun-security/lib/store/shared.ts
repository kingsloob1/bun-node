/**
 * What every security store driver checks and encodes the same way: kinds,
 * ids, page limits, JSON bodies, and the keyset cursors bound to their walk
 * (storage.md §3.4, over bun-sql's `encodePageCursor`/`decodePageCursor`).
 */
import type {
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
import { DOC_KINDS, MAX_PAGE_LIMIT } from "./types";

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
