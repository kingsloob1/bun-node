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
  StoredDoc,
} from "./types";
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
  const now = options.now ?? Date.now;
  const name = options.name ?? "memory";
  const docs = new Map<DocKind, Map<string, StoredDoc>>();
  const versions = new Map<string, PolicyVersionRecord[]>();
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
    kind: DocKind,
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
