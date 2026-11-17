/**
 * `memoryStore()` (storage.md §5): the security store in one process's
 * memory, for tests, examples and a single process that needs no
 * persistence (topology (a)). Every write is a compare inside one
 * synchronous step, so it is atomic without a lock, and its change is
 * appended in the same step; subscribers are pushed the feed's head on the
 * next microtask. Bodies are stored through JSON, as a SQL driver stores
 * them, and every read answers a fresh copy.
 *
 * The change feed is kept whole for the store's life: a store for tests and
 * one process, not for a long-lived fleet.
 */
import type {
  CounterValue,
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
  StoredBundle,
  StoredDoc,
} from "./types";
import { ConfigError } from "@kingsleyweb/bun-common";
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

/** Options for {@link memoryStore}. */
export interface MemoryStoreOptions {
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** The driver's name in messages. Default `memory`. */
  readonly name?: string;
}

/** What the memory store can do. */
const CAPABILITIES: SecurityStoreCapabilities = Object.freeze({
  durable: false,
  multiProcess: false,
  multiHost: false,
  transactions: true,
  changeFeed: "push",
  analytics: false,
  cidrQuery: false,
  readOnly: false,
});

/** A fresh copy of a JSON value. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Compares two sort values, then ids, in `direction`. */
function compareDocs(
  a: { value: string | number; id: string },
  b: { value: string | number; id: string },
): number {
  if (a.value < b.value) return -1;
  if (a.value > b.value) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The security store in memory; see the module's description. */
export function memoryStore(
  options: MemoryStoreOptions = {},
): SecurityStoreDriver {
  /** Short-lived counters and claims, by key. */
  const counters = new Map<string, CounterValue>();
  const now = options.now ?? Date.now;
  const name = options.name ?? "memory";
  const docs = new Map<DocKind, Map<string, StoredDoc>>();
  const versions = new Map<string, PolicyVersionRecord[]>();
  const bundles = new Map<string, StoredBundle>();
  const audit: AuditRecord[] = [];
  const checkpoints = new Map<number, AuditCheckpoint>();
  let auditHead: AuditHead | null = null;
  const changes: Change[] = [];
  const listeners = new Set<(head: bigint) => void>();
  let seq = 0n;
  let closed = false;
  let notifying = false;

  /** One kind's map. */
  const of = (kind: DocKind): Map<string, StoredDoc> => {
    let map = docs.get(kind);
    if (map === undefined) {
      map = new Map();
      docs.set(kind, map);
    }
    return map;
  };

  /** Appends a change and schedules the subscribers. */
  const record = (
    kind: ChangeKind,
    id: string,
    revision: number,
    deleted: boolean,
  ): bigint => {
    seq += 1n;
    changes.push(Object.freeze({ seq, kind, id, revision, deleted }));
    if (!notifying && listeners.size > 0) {
      notifying = true;
      queueMicrotask(() => {
        notifying = false;
        for (const listener of [...listeners]) {
          try {
            listener(seq);
          } catch {
            // A listener's failure is its own; the others still hear.
          }
        }
      });
    }
    return seq;
  };

  /** A frozen copy of a stored document. */
  const out = (doc: StoredDoc): StoredDoc =>
    Object.freeze({ ...doc, doc: copy(doc.doc) });

  const store: SecurityStoreDriver = {
    name,
    capabilities: CAPABILITIES,
    connect: async () => {
      refuseClosed(name, closed);
    },
    close: async () => {
      closed = true;
      listeners.clear();
    },
    get: async (kind, id) => {
      refuseClosed(name, closed);
      checkKind(kind);
      checkId(id);
      const found = of(kind).get(id);
      return found === undefined ? undefined : out(found);
    },
    list: async (kind, query: ListQuery): Promise<Page<StoredDoc>> => {
      refuseClosed(name, closed);
      checkKind(kind);
      const resolved = resolveQuery(query);
      const after = docPosition(kind, resolved);
      const sign = resolved.direction === "asc" ? 1 : -1;
      const keyed = [...of(kind).values()]
        .filter((doc) => doc.id.startsWith(resolved.prefix))
        .map((doc) => ({
          doc,
          value: resolved.sort === "id" ? doc.id : doc.updatedAt,
          id: doc.id,
        }))
        .sort((a, b) => sign * compareDocs(a, b));
      const rest =
        after === undefined
          ? keyed
          : keyed.filter((item) => sign * compareDocs(item, after) > 0);
      const items = rest.slice(0, resolved.limit).map((item) => out(item.doc));
      const last = items.at(-1);
      return Object.freeze({
        items,
        ...(rest.length > resolved.limit && last !== undefined
          ? { next: docCursor(kind, resolved, last) }
          : {}),
        totalEstimate: keyed.length,
      });
    },
    put: async (kind, id, doc, ifRevision): Promise<PutResult> => {
      refuseClosed(name, closed);
      checkKind(kind);
      checkId(id);
      checkRevision(ifRevision, true);
      refusePolicyWrite(kind, "put()");
      const body = jsonBody(doc, "a document");
      const map = of(kind);
      const current = map.get(id);
      if ((current?.revision ?? null) !== ifRevision) {
        return Object.freeze({
          ok: false,
          conflict: current === undefined ? undefined : out(current),
        });
      }
      const revision = (current?.revision ?? 0) + 1;
      map.set(id, { kind, id, revision, doc: body, updatedAt: now() });
      return Object.freeze({
        ok: true,
        revision,
        seq: record(kind, id, revision, false),
      });
    },
    delete: async (kind, id, ifRevision) => {
      refuseClosed(name, closed);
      checkKind(kind);
      checkId(id);
      checkRevision(ifRevision, false);
      refusePolicyWrite(kind, "delete()");
      const map = of(kind);
      const current = map.get(id);
      if (current === undefined || current.revision !== ifRevision) {
        return false;
      }
      map.delete(id);
      record(kind, id, current.revision, true);
      return true;
    },
    appendVersion: async (
      policyId,
      version: PolicyVersionInput,
      expectedHead,
    ): Promise<AppendResult> => {
      refuseClosed(name, closed);
      checkId(policyId, "a policy id");
      if (expectedHead !== null) checkId(expectedHead, "a head");
      const input = checkVersionInput(version, now);
      const heads = of("policy");
      const current = heads.get(policyId);
      const head =
        current === undefined ? null : (current.doc as { head: string }).head;
      const list = versions.get(policyId) ?? [];
      if (head !== expectedHead || list.some((v) => v.id === input.id)) {
        return Object.freeze({ ok: false, head });
      }
      const number = list.length + 1;
      list.push(
        Object.freeze({
          policyId,
          id: input.id,
          number,
          policy: input.policy,
          createdAt: input.createdAt,
          createdBy: input.createdBy,
          message: input.message,
        }),
      );
      versions.set(policyId, list);
      const revision = (current?.revision ?? 0) + 1;
      heads.set(policyId, {
        kind: "policy",
        id: policyId,
        revision,
        doc: { head: input.id, number },
        updatedAt: now(),
      });
      return Object.freeze({
        ok: true,
        seq: record("policy", policyId, revision, false),
      });
    },
    getVersion: async (policyId, versionId) => {
      refuseClosed(name, closed);
      checkId(policyId, "a policy id");
      checkId(versionId, "a version id");
      const found = versions.get(policyId)?.find((v) => v.id === versionId);
      return found === undefined
        ? undefined
        : Object.freeze({ ...found, policy: copy(found.policy) });
    },
    listVersions: async (policyId, query) => {
      refuseClosed(name, closed);
      checkId(policyId, "a policy id");
      const resolved = resolveQuery(query);
      const after = versionPosition(policyId, resolved);
      const desc = resolved.direction === "desc";
      const all = [...(versions.get(policyId) ?? [])];
      if (desc) all.reverse();
      const rest =
        after === undefined
          ? all
          : all.filter((v) => (desc ? v.number < after : v.number > after));
      const items = rest
        .slice(0, resolved.limit)
        .map((v) => Object.freeze({ ...v, policy: copy(v.policy) }));
      const last = items.at(-1);
      return Object.freeze({
        items,
        ...(rest.length > resolved.limit && last !== undefined
          ? { next: versionCursor(policyId, resolved, last) }
          : {}),
        totalEstimate: all.length,
      });
    },
    putBundle: async (
      serviceId,
      bundle: BundleInput,
      expectedVersion,
    ): Promise<PutBundleResult> => {
      refuseClosed(name, closed);
      checkId(serviceId, "a service id");
      const input = checkBundleInput(bundle, expectedVersion);
      const current = bundles.get(serviceId);
      const stored = current?.version ?? null;
      if (stored !== expectedVersion || input.version <= (stored ?? 0)) {
        return Object.freeze({ ok: false, version: stored });
      }
      bundles.set(
        serviceId,
        Object.freeze({
          serviceId,
          version: input.version,
          etag: bundleEtag(input.version),
          bundle: input.bundle,
          updatedAt: now(),
        }),
      );
      return Object.freeze({
        ok: true,
        seq: record("bundle", serviceId, input.version, false),
      });
    },
    getBundle: async (serviceId, ifNoneMatch) => {
      refuseClosed(name, closed);
      checkId(serviceId, "a service id");
      const found = bundles.get(serviceId);
      if (found === undefined) return undefined;
      if (ifNoneMatch !== undefined && ifNoneMatch === found.etag) {
        return "not-modified";
      }
      return Object.freeze({ ...found, bundle: copy(found.bundle) });
    },
    appendAudit: async (
      input,
      expectedPrevHash,
    ): Promise<AppendAuditResult> => {
      refuseClosed(name, closed);
      const entry = checkAuditInput(input, expectedPrevHash);
      if ((auditHead?.hash ?? null) !== expectedPrevHash) {
        return Object.freeze({ ok: false, head: auditHead });
      }
      const n = (auditHead?.n ?? 0) + 1;
      audit.push(Object.freeze({ ...entry, n }));
      auditHead = Object.freeze({ n, hash: entry.hash });
      return Object.freeze({
        ok: true,
        n,
        seq: record("audit", String(n), n, false),
      });
    },
    getAuditHead: async () => {
      refuseClosed(name, closed);
      return auditHead;
    },
    listAudit: async (query) => {
      refuseClosed(name, closed);
      const resolved = resolveAuditQuery(query);
      const after = auditPosition(resolved);
      const f = resolved.filter;
      const desc = resolved.direction === "desc";
      const matching = audit.filter(
        (entry) =>
          (f.actor === "" || entry.actor === f.actor) &&
          (f.action === "" || entry.action === f.action) &&
          (f.scope === "" || entry.scope === f.scope) &&
          (f.scopes === null || f.scopes.includes(entry.scope)) &&
          (f.since < 0 || entry.at >= f.since) &&
          (f.until < 0 || entry.at < f.until) &&
          (f.fromN < 0 || entry.n >= f.fromN) &&
          (f.toN < 0 || entry.n <= f.toN),
      );
      if (desc) matching.reverse();
      const rest =
        after === undefined
          ? matching
          : matching.filter((entry) =>
              desc ? entry.n < after : entry.n > after,
            );
      const items = rest
        .slice(0, resolved.limit)
        .map((entry) => Object.freeze({ ...entry, entry: copy(entry.entry) }));
      const last = items.at(-1);
      return Object.freeze({
        items,
        ...(rest.length > resolved.limit && last !== undefined
          ? { next: auditCursor(resolved, last.n) }
          : {}),
      });
    },
    appendCheckpoint: async (checkpoint) => {
      refuseClosed(name, closed);
      const cp = checkCheckpoint(checkpoint);
      if (!checkpoints.has(cp.n)) checkpoints.set(cp.n, Object.freeze(cp));
    },
    listCheckpoints: async (query) => {
      refuseClosed(name, closed);
      const direction = query.direction ?? "asc";
      const resolved = resolveQuery({ limit: query.limit, direction });
      const after = checkpointPosition(query.cursor, direction);
      const all = [...checkpoints.values()].sort((a, b) =>
        direction === "asc" ? a.n - b.n : b.n - a.n,
      );
      const rest =
        after === undefined
          ? all
          : all.filter((cp) =>
              direction === "asc" ? cp.n > after : cp.n < after,
            );
      const items = rest.slice(0, resolved.limit);
      const last = items.at(-1);
      return Object.freeze({
        items,
        ...(rest.length > resolved.limit && last !== undefined
          ? { next: checkpointCursor(direction, last.n) }
          : {}),
      });
    },
    deleteAuditBefore: async (beforeN, limit) => {
      refuseClosed(name, closed);
      if (
        !Number.isSafeInteger(beforeN) ||
        !Number.isSafeInteger(limit) ||
        limit < 1
      ) {
        throw new ConfigError(
          "security store: deleteAuditBefore takes a number and a positive limit",
        );
      }
      let deleted = 0;
      while (deleted < limit && audit.length > 0 && audit[0]!.n < beforeN) {
        audit.shift();
        deleted++;
      }
      return deleted;
    },
    incrementCounter: async (key, ttlMs) => {
      refuseClosed(name, closed);
      checkCounter(key, ttlMs);
      const at = now();
      const current = counters.get(key);
      const count =
        current !== undefined && current.expiresAt > at ? current.count + 1 : 1;
      const value = Object.freeze({ count, expiresAt: at + ttlMs });
      counters.set(key, value);
      return value;
    },
    getCounter: async (key) => {
      refuseClosed(name, closed);
      checkCounter(key);
      const current = counters.get(key);
      return current !== undefined && current.expiresAt > now()
        ? current
        : undefined;
    },
    resetCounter: async (key) => {
      refuseClosed(name, closed);
      checkCounter(key);
      counters.delete(key);
    },
    claimKey: async (key, ttlMs) => {
      refuseClosed(name, closed);
      checkCounter(key, ttlMs);
      const at = now();
      const current = counters.get(key);
      if (current !== undefined && current.expiresAt > at) return false;
      counters.set(key, Object.freeze({ count: 1, expiresAt: at + ttlMs }));
      return true;
    },
    changesSince: async (since, limit) => {
      refuseClosed(name, closed);
      checkFeedRead(since, limit);
      // Changes are numbered from 1 with no holes, so the one after `since`
      // sits at index `since`.
      const start = Number(
        since < BigInt(changes.length) ? since : BigInt(changes.length),
      );
      return Object.freeze({
        changes: Object.freeze(changes.slice(start, start + limit)),
        head: seq,
      });
    },
    subscribe: (listener, _onGap) => {
      refuseClosed(name, closed);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return Object.freeze(store);
}
