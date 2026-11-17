/**
 * Field sealing for the durable store (storage.md §8, PR-D3): a
 * {@link StoreCodec} that seals the named fields of each body with
 * bun-cache's envelope (`@kingsleyweb/bun-cache/encryption`), so a secret
 * the control plane keeps is ciphertext in the database file, its dumps and
 * its backups, while every other field, and so the store's indexes and
 * filters, stay as they were.
 *
 * Each sealed value is bound to where it sits: the table's role (`doc`,
 * `policy`, `bundle`), the document's kind and id, the version's id, and
 * the field's path with its concrete array indexes and keys. Copied to
 * another row, another field or another table, it does not open.
 *
 * At rest a sealed field is `{ "$sealed": "<base64url envelope>" }` in place
 * of its value. The ring's first key seals; every key opens what it sealed,
 * so a rotation puts the new key first, and {@link resealStore} rewrites the
 * documents still sealed under an older one.
 */
import type {
  CacheKeyRing,
  FieldKeyRing,
} from "@kingsleyweb/bun-cache/encryption";
import type {
  ChangeKind,
  DocKind,
  SecurityStoreDriver,
  StoreCodec,
  StoreCodecContext,
} from "../store/types";
import { Buffer } from "node:buffer";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  CacheDecryptError,
  fieldKeyId,
  fieldKeyRing,
  openField,
  sealField,
} from "@kingsleyweb/bun-cache/encryption";
import { DOC_KINDS } from "../store/types";

/** The purpose the store's fields are sealed under (bun-cache's `FieldContext.purpose`). */
export const SEALING_PURPOSE = "bun-security/store";

/** The key a sealed field's value sits under at rest. */
export const SEALED_MARKER = "$sealed";

/**
 * The fields to seal, by where they are stored: a path is the property
 * names from the body's top, joined with `.`; a `*` segment stands for
 * every element of an array or every property of an object. A path that
 * is absent from a body seals nothing.
 */
export interface SealedFieldPaths {
  /** Documents' fields, by kind. */
  readonly doc?: { readonly [K in DocKind]?: readonly string[] };
  /** Policy versions' policy fields. */
  readonly policy?: readonly string[];
  /** Bundles' fields. */
  readonly bundle?: readonly string[];
}

/**
 * The fields sealed by default: storage.md §8's secrets, on the records
 * that will hold them. No record holds one yet: agent keys (PR-CP4), alert
 * channels (PR-CP6) and break-glass (PR-CP4) are still to come, and today's
 * service identities hold only their tokens' SHA-256 (`verifier`), never a
 * token. Policies and bundles are not sealed: they hold no secret (the
 * policy format keeps hashes, the bundle signing key never reaches the
 * store), and the control plane diffs and reviews them.
 *
 * - `agentKey.secret`: an agent's HMAC secret, when it signs with one rather
 *   than a key pair (control-plane.md §7), and `agentKey.previous.secret`,
 *   the secret a rotation replaced while it is still accepted (PR-CP4);
 * - `serviceIdentity.secret`: a service identity's shared secret, should
 *   one ever be HMAC rather than a token's hash;
 * - `alertChannel.url` and `alertChannel.secret`: a webhook's URL (a
 *   Slack-compatible one carries its token in the path) and its signing
 *   secret;
 * - `operator.totpSeed`: the break-glass account's TOTP seed.
 */
export const DEFAULT_SEALED_FIELDS: SealedFieldPaths = {
  doc: {
    agentKey: ["secret", "previous.secret"],
    serviceIdentity: ["secret"],
    alertChannel: ["url", "secret"],
    operator: ["totpSeed"],
  },
};

/** Options of {@link sealedFields}. */
export interface SealedFieldsOptions {
  /**
   * The key ring: `[{ id, key }]`, each key 32 bytes (bytes, or hex, base64
   * or base64url text: `openssl rand -base64 32`). The first seals; every
   * key opens what it sealed. From the environment or a secret manager,
   * never from the store it protects.
   */
  readonly keys: CacheKeyRing;
  /** The fields to seal. Default {@link DEFAULT_SEALED_FIELDS}; `{}` seals nothing. */
  readonly fields?: SealedFieldPaths;
  /**
   * Whether a plain value at a sealed path is read as it is, for a store
   * that held its secrets before sealing was turned on; {@link resealStore}
   * then seals them. Default `false`: refused, so nobody with write access
   * to the database can put a value of their own in place of a sealed one.
   */
  readonly acceptUnsealed?: boolean;
}

/** {@link sealedFields}' codec: a {@link StoreCodec}, and what it knows of the bodies it opened. */
export interface SealedFieldsCodec extends StoreCodec {
  /** The ring's key ids; the first seals. */
  readonly keyIds: readonly string[];
  /** The fields it seals. */
  readonly fields: SealedFieldPaths;
  /**
   * Whether a body this codec opened had a field sealed under a key other
   * than the first, or a plain value at a sealed path: {@link resealStore}'s
   * test. `false` for anything it did not open.
   */
  readonly isStale: (body: unknown) => boolean;
}

/** Why a sealed field did not open. */
export type SealedFieldFailure =
  "auth" | "unknown-key" | "malformed" | "unsealed";

/**
 * A sealed field did not open: the store's read rejects with it. Its
 * message names the field's place, the reason and the key id, never a
 * value or key material.
 */
export class SealedFieldError extends Error {
  /**
   * Why: `"auth"`, a changed byte, a wrong key under a known id, or a value
   * sealed for another place; `"unknown-key"`, no ring key has its id;
   * `"malformed"`, not a sealed value; `"unsealed"`, a plain value at a
   * sealed path without `acceptUnsealed`.
   */
  readonly reason: SealedFieldFailure;
  /** The key id the value's envelope names, when it names one. */
  readonly keyId: string | undefined;
  /** The table's role. */
  readonly field: StoreCodecContext["field"];
  /** The document's kind. */
  readonly kind: ChangeKind;
  /** The document's id. */
  readonly id: string;
  /** The field's path, with its concrete indexes (`channels.0.secret`). */
  readonly path: string;

  constructor(init: {
    /** Why it did not open. */
    reason: SealedFieldFailure;
    /** The envelope's key id, when it has one. */
    keyId?: string;
    /** Where it sits. */
    context: StoreCodecContext;
    /** The field's concrete path. */
    path: string;
    /** What bun-cache threw, when it threw. */
    cause?: unknown;
  }) {
    const { context } = init;
    super(
      `sealed field "${init.path}" of ${context.kind} "${context.id}"${
        context.version === undefined ? "" : ` version "${context.version}"`
      } did not open (${init.reason}${
        init.keyId === undefined ? "" : `, key id "${init.keyId}"`
      })`,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = "SealedFieldError";
    this.reason = init.reason;
    this.keyId = init.keyId;
    this.field = context.field;
    this.kind = context.kind;
    this.id = context.id;
    this.path = init.path;
  }
}

/** One path, split. */
type Segments = readonly string[];

/** A path segment: a property name, or `*`. */
const SEGMENT = /^[^.]{1,200}$/;

/** Splits and checks one path; throws a `ConfigError`. */
function parsePath(path: unknown, where: string): Segments {
  if (typeof path !== "string" || path.length === 0) {
    throw new ConfigError(`${where} must be a non-empty path`);
  }
  const segments = path.split(".");
  if (!segments.every((segment) => SEGMENT.test(segment))) {
    throw new ConfigError(
      `${where} "${path}" must be property names joined with "." (a "*" for every element)`,
    );
  }
  if (segments.includes(SEALED_MARKER)) {
    throw new ConfigError(`${where} "${path}" cannot name "${SEALED_MARKER}"`);
  }
  return segments;
}

/** Whether two paths can reach the same value, or one a value inside the other's. */
function overlaps(a: Segments, b: Segments): boolean {
  const shorter = Math.min(a.length, b.length);
  for (let i = 0; i < shorter; i++) {
    if (a[i] !== b[i] && a[i] !== "*" && b[i] !== "*") return false;
  }
  return true;
}

/** Checks a list of paths: each well formed, none overlapping another. */
function parsePaths(paths: unknown, where: string): readonly Segments[] {
  if (!Array.isArray(paths)) {
    throw new ConfigError(`${where} must be a list of paths`);
  }
  const parsed = (paths as unknown[]).map((path, index) =>
    parsePath(path, `${where}[${index}]`),
  );
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      if (overlaps(parsed[i], parsed[j])) {
        throw new ConfigError(
          `${where}: "${parsed[i].join(".")}" and "${parsed[j].join(".")}" overlap; seal one of them`,
        );
      }
    }
  }
  return parsed;
}

/** The parsed field map: paths by table role and kind. */
interface ParsedFields {
  /** Documents' paths, by kind. */
  readonly doc: ReadonlyMap<DocKind, readonly Segments[]>;
  /** Policy versions' paths. */
  readonly policy: readonly Segments[];
  /** Bundles' paths. */
  readonly bundle: readonly Segments[];
}

/** Checks `fields`; throws a `ConfigError`. */
function parseFields(fields: unknown): ParsedFields {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new ConfigError(
      "sealedFields(): fields must be { doc?, policy?, bundle? }",
    );
  }
  const input = fields as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "doc" && key !== "policy" && key !== "bundle") {
      throw new ConfigError(
        `sealedFields(): fields.${key} is not a table; use doc, policy or bundle`,
      );
    }
  }
  const doc = new Map<DocKind, readonly Segments[]>();
  if (input.doc !== undefined) {
    if (typeof input.doc !== "object" || input.doc === null) {
      throw new ConfigError(
        "sealedFields(): fields.doc must map kinds to paths",
      );
    }
    for (const [kind, paths] of Object.entries(input.doc)) {
      if (!(DOC_KINDS as readonly string[]).includes(kind)) {
        throw new ConfigError(
          `sealedFields(): fields.doc.${kind} is not a document kind (${DOC_KINDS.join(", ")})`,
        );
      }
      const parsed = parsePaths(paths, `sealedFields(): fields.doc.${kind}`);
      if (parsed.length > 0) doc.set(kind as DocKind, parsed);
    }
  }
  return {
    doc,
    policy:
      input.policy === undefined
        ? []
        : parsePaths(input.policy, "sealedFields(): fields.policy"),
    bundle:
      input.bundle === undefined
        ? []
        : parsePaths(input.bundle, "sealedFields(): fields.bundle"),
  };
}

/** Whether `value` is a plain object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is a sealed field at rest: `{ $sealed: string }` and nothing else. */
function isSealed(value: unknown): value is { readonly $sealed: string } {
  return (
    isRecord(value) &&
    typeof value[SEALED_MARKER] === "string" &&
    Object.keys(value).length === 1
  );
}

/**
 * Rewrites the values `segments` reaches inside `value` with `at`, copying
 * only the containers on the way (the input is never changed); answers
 * `value` itself when nothing was reached.
 */
function rewrite(
  value: unknown,
  segments: Segments,
  index: number,
  trail: string[],
  at: (found: unknown, trail: readonly string[]) => unknown,
): unknown {
  if (index === segments.length) {
    return value === undefined ? value : at(value, trail);
  }
  const segment = segments[index];
  if (Array.isArray(value)) {
    const list: readonly unknown[] = value;
    let copy: unknown[] | undefined;
    const visit = (i: number): void => {
      trail.push(String(i));
      const next = rewrite(list[i], segments, index + 1, trail, at);
      trail.pop();
      if (next !== list[i]) {
        copy ??= [...list];
        copy[i] = next;
      }
    };
    if (segment === "*") {
      for (let i = 0; i < list.length; i++) visit(i);
    } else if (
      /^(?:0|[1-9]\d*)$/.test(segment) &&
      Number(segment) < list.length
    ) {
      visit(Number(segment));
    }
    return copy ?? value;
  }
  if (isRecord(value)) {
    let copy: Record<string, unknown> | undefined;
    const keys =
      segment === "*"
        ? Object.keys(value)
        : Object.hasOwn(value, segment)
          ? [segment]
          : [];
    for (const key of keys) {
      trail.push(key);
      const next = rewrite(value[key], segments, index + 1, trail, at);
      trail.pop();
      if (next !== value[key]) {
        copy ??= { ...value };
        copy[key] = next;
      }
    }
    return copy ?? value;
  }
  return value;
}

/** What a sealed value is bound to: the place, then the concrete path, part by part. */
function bindOf(
  context: StoreCodecContext,
  trail: readonly string[],
): string[] {
  return [
    context.field,
    context.kind,
    context.id,
    context.version === undefined ? "" : `@${context.version}`,
    ...trail,
  ];
}

/**
 * A {@link StoreCodec} sealing the named fields of every body, for
 * `sqliteStore({ codec })` and `postgresStore({ codec })` (storage.md §8).
 * Throws a `ConfigError` for a malformed ring or field map, naming what is
 * wrong and never a key.
 *
 * ```ts
 * const codec = sealedFields({
 *   keys: [
 *     { id: "2026-11", key: process.env.STORE_KEY_2026_11! }, // seals
 *     { id: "2026-10", key: process.env.STORE_KEY_2026_10! }, // still opens
 *   ],
 * });
 * const store = postgresStore({ url, codec });
 * ```
 */
export function sealedFields(options: SealedFieldsOptions): SealedFieldsCodec {
  if (typeof options !== "object" || options === null) {
    throw new ConfigError(
      "sealedFields(): options must be { keys, fields?, acceptUnsealed? }",
    );
  }
  let ring: FieldKeyRing;
  try {
    ring = fieldKeyRing(options.keys);
  } catch (error) {
    throw new ConfigError(
      `sealedFields(): keys: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    options.acceptUnsealed !== undefined &&
    typeof options.acceptUnsealed !== "boolean"
  ) {
    throw new ConfigError("sealedFields(): acceptUnsealed must be a boolean");
  }
  const acceptUnsealed = options.acceptUnsealed === true;
  const fields =
    options.fields === undefined ? DEFAULT_SEALED_FIELDS : options.fields;
  const parsed = parseFields(fields);
  const primary = ring.primaryKeyId;
  /** The bodies opened with a stale field, for {@link SealedFieldsCodec.isStale}. */
  const stale = new WeakSet<object>();

  const pathsOf = (context: StoreCodecContext): readonly Segments[] =>
    context.field === "doc"
      ? (parsed.doc.get(context.kind as DocKind) ?? [])
      : context.field === "policy"
        ? parsed.policy
        : parsed.bundle;

  const seal = (body: unknown, context: StoreCodecContext): unknown => {
    let out = body;
    for (const segments of pathsOf(context)) {
      out = rewrite(out, segments, 0, [], (value, trail) => {
        const text = JSON.stringify(value);
        if (text === undefined) return value;
        const sealed = sealField(text, ring, {
          purpose: SEALING_PURPOSE,
          bind: bindOf(context, trail),
        });
        return { [SEALED_MARKER]: Buffer.from(sealed).toString("base64url") };
      });
    }
    return out;
  };

  const open = (stored: unknown, context: StoreCodecContext): unknown => {
    let out = stored;
    let outdated = false;
    for (const segments of pathsOf(context)) {
      out = rewrite(out, segments, 0, [], (value, trail) => {
        const path = trail.join(".");
        if (!isSealed(value)) {
          if (acceptUnsealed) {
            outdated = true;
            return value;
          }
          throw new SealedFieldError({ reason: "unsealed", context, path });
        }
        const bytes = Buffer.from(value[SEALED_MARKER], "base64url");
        let plain: Uint8Array;
        try {
          plain = openField(bytes, ring, {
            purpose: SEALING_PURPOSE,
            bind: bindOf(context, trail),
          });
        } catch (error) {
          if (!(error instanceof CacheDecryptError)) throw error;
          throw new SealedFieldError({
            reason:
              error.reason === "auth" || error.reason === "unknown-key"
                ? error.reason
                : "malformed",
            keyId: error.keyId,
            context,
            path,
            cause: error,
          });
        }
        if (fieldKeyId(bytes) !== primary) outdated = true;
        try {
          return JSON.parse(new TextDecoder().decode(plain)) as unknown;
        } catch (error) {
          throw new SealedFieldError({
            reason: "malformed",
            context,
            path,
            cause: error,
          });
        }
      });
    }
    if (outdated && typeof out === "object" && out !== null) stale.add(out);
    return out;
  };

  return Object.freeze({
    seal,
    open,
    keyIds: ring.keyIds,
    fields,
    isStale: (body: unknown) =>
      typeof body === "object" && body !== null && stale.has(body),
  });
}

/** Options of {@link resealStore}. */
export interface ResealStoreOptions {
  /** The document kinds to walk. Default: every kind the codec seals a field of. */
  readonly kinds?: readonly DocKind[];
  /** Documents per page. Default `100`. */
  readonly pageSize?: number;
}

/** What {@link resealStore} did. */
export interface ResealResult {
  /** Documents read. */
  readonly scanned: number;
  /** Documents written back, sealed under the ring's first key. */
  readonly resealed: number;
  /** Documents changed by someone else between the read and the write: their writer sealed them afresh. */
  readonly conflicts: number;
}

/**
 * Rewrites every document the codec opened with a field sealed under an
 * older key, or a plain value at a sealed path (`acceptUnsealed`), so it is
 * sealed under the ring's first key (storage.md §8's `reseal` job). Each is
 * written back at the revision read: a revision is used per document
 * rewritten (and a change in the feed), and a document written in between
 * is a conflict, left as its writer sealed it. Policy versions and bundles
 * are never rewritten (they are append-only); the default seals none of
 * their fields. `store` must be built with `codec`.
 */
export async function resealStore(
  store: SecurityStoreDriver,
  codec: SealedFieldsCodec,
  options: ResealStoreOptions = {},
): Promise<ResealResult> {
  const kinds =
    options.kinds ??
    (Object.keys(codec.fields.doc ?? {}) as DocKind[]).filter(
      (kind) => (codec.fields.doc?.[kind]?.length ?? 0) > 0,
    );
  const limit = options.pageSize ?? 100;
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= 1000)) {
    throw new ConfigError(
      "resealStore(): pageSize must be an integer from 1 to 1000",
    );
  }
  let scanned = 0;
  let resealed = 0;
  let conflicts = 0;
  for (const kind of kinds) {
    let cursor: string | undefined;
    do {
      const page = await store.list(kind, { limit, cursor });
      for (const item of page.items) {
        scanned += 1;
        if (!codec.isStale(item.doc)) continue;
        const written = await store.put(kind, item.id, item.doc, item.revision);
        if (written.ok) resealed += 1;
        else conflicts += 1;
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }
  return Object.freeze({ scanned, resealed, conflicts });
}
