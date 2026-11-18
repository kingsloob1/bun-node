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
import type { ResolvedCounter } from "./analytics";
import type {
  BanRecord,
  CounterValue,
  AppendAuditResult,
  AuditAppended,
  AppendResult,
  AuditCheckpoint,
  AuditHead,
  AuditRecord,
  BundleInput,
  Change,
  ChangeKind,
  CounterRow,
  DocKind,
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
  bucketOf,
  carryUp,
  checkDeleteBefore,
  checkRollup,
  checkTopKLimit,
  counterKey,
  dimsMatch,
  dimsOf,
  eventCursor,
  eventMatches,
  eventPosition,
  resolveCounterQuery,
  resolveCounters,
  resolveEventQuery,
  resolveEvents,
  retentionFloor,
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
  banAfter,
  banCursor,
  banId,
  banMatches,
  banPosition,
  checkBanInput,
  compareBans,
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
import { MAX_SERIES_POINTS } from "./types";

/** Options for {@link memoryStore}. */
export interface MemoryStoreOptions {
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** The driver's name in messages. Default `memory`. */
  readonly name?: string;
  /** The most events it keeps; past it, the oldest stored go first. Default 100,000. */
  readonly maxEvents?: number;
}

/** What the memory store can do. */
const CAPABILITIES: SecurityStoreCapabilities = Object.freeze({
  durable: false,
  multiProcess: false,
  multiHost: false,
  transactions: true,
  changeFeed: "push",
  analytics: true,
  cidrQuery: false,
  readOnly: false,
});

/** {@link MemoryStoreOptions.maxEvents}' default. */
const DEFAULT_MAX_EVENTS = 100_000;

/** Compares two events by time, then id. */
function compareEvents(
  a: { at: number; id: string },
  b: { at: number; id: string },
): number {
  if (a.at !== b.at) return a.at - b.at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

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
  /** Bans, by id. */
  const bans = new Map<string, BanRecord>();
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
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new ConfigError(
      "memoryStore(): maxEvents must be a positive whole number",
    );
  }
  /** The events, by id, in the order they were stored. */
  const events = new Map<string, SecurityEvent>();
  /** Each stored batch id, and when it was stored. */
  const batches = new Map<string, number>();
  /** The counter rows, by identity. */
  const analyticsRows = new Map<string, ResolvedCounter>();
  /** Each rollup's watermark. */
  const watermarks = new Map<string, number>();
  const watermark = (from: Tier, to: Tier): number =>
    watermarks.get(watermarkName(from, to)) ?? 0;

  /** Adds checked rows, carried up past the watermarks. */
  const addRows = (rows: readonly ResolvedCounter[]): void => {
    for (const row of carryUp(rows, watermark)) {
      const key = counterKey(row);
      const before = analyticsRows.get(key);
      analyticsRows.set(
        key,
        before === undefined
          ? row
          : { ...row, value: before.value + row.value },
      );
    }
  };

  /** The rows a counter query reads. */
  const rowsFor = (query: SeriesQuery): ResolvedCounter[] => {
    const resolved = resolveCounterQuery(query);
    return [...analyticsRows.values()].filter(
      (row) =>
        row.tier === resolved.tier &&
        row.metric === resolved.metric &&
        (resolved.service === undefined || row.service === resolved.service) &&
        (resolved.services === undefined ||
          resolved.services.includes(row.service)) &&
        row.bucket >= resolved.from &&
        row.bucket < resolved.to &&
        dimsMatch(row.dims, resolved.needles),
    );
  };
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
        seq: UNFED_KINDS.has(kind) ? 0n : record(kind, id, revision, false),
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
      if (!UNFED_KINDS.has(kind)) record(kind, id, current.revision, true);
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
    appendAuditAtHead: async (make): Promise<AuditAppended> => {
      refuseClosed(name, closed);
      // One synchronous step: nothing else runs between the read and the write.
      const head = auditHead;
      const entry = checkAuditInput(make(head), head?.hash ?? null);
      const n = (head?.n ?? 0) + 1;
      audit.push(Object.freeze({ ...entry, n }));
      auditHead = Object.freeze({ n, hash: entry.hash });
      return Object.freeze({
        n,
        seq: record("audit", String(n), n, false),
        entry,
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
          (f.toN < 0 || entry.n <= f.toN) &&
          (f.target === "" || auditTargetOf(entry.entry) === f.target),
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
    upsertBan: async (input) => {
      refuseClosed(name, closed);
      const ban = checkBanInput(input);
      const merged = mergeStoredBan(
        bans.get(banId(ban.scope, ban.subject)),
        ban,
        now(),
      );
      bans.set(merged.id, merged);
      record("ban", merged.id, merged.revision, false);
      return copy(merged);
    },
    liftBan: async (id, by, at) => {
      refuseClosed(name, closed);
      checkId(id, "a ban id");
      checkLift(by, at);
      const current = bans.get(id);
      if (current === undefined || !banActive(current, now())) return false;
      const lifted: BanRecord = Object.freeze({
        ...current,
        liftedAt: at,
        liftedBy: by,
        updatedAt: now(),
        revision: current.revision + 1,
      });
      bans.set(id, lifted);
      record("ban", id, lifted.revision, false);
      return true;
    },
    getBan: async (id) => {
      refuseClosed(name, closed);
      checkId(id, "a ban id");
      const found = bans.get(id);
      return found === undefined ? undefined : copy(found);
    },
    listBans: async (query) => {
      refuseClosed(name, closed);
      const resolved = resolveBanQuery(query);
      const after = banPosition(resolved);
      const at = now();
      const matching = [...bans.values()]
        .filter(
          (ban) =>
            banMatches(ban, resolved, at) &&
            (after === undefined || banAfter(ban, resolved, after)),
        )
        .sort(compareBans(resolved));
      const items = matching.slice(0, resolved.limit).map((ban) => copy(ban));
      const last = items.at(-1);
      return Object.freeze({
        items,
        ...(matching.length > resolved.limit && last !== undefined
          ? { next: banCursor(resolved, last) }
          : {}),
      });
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
    appendEvents: async (
      batchId,
      batch: readonly SecurityEvent[],
      rows?: readonly CounterRow[],
    ) => {
      refuseClosed(name, closed);
      const checked = resolveEvents(batchId, batch);
      const resolvedRows = rows === undefined ? [] : resolveCounters(rows);
      if (batches.has(batchId)) return Object.freeze({ duplicate: true });
      batches.set(batchId, now());
      for (const event of checked) {
        if (events.has(event.id)) continue;
        events.set(event.id, event);
        if (events.size > maxEvents) {
          events.delete(events.keys().next().value!);
        }
      }
      addRows(resolvedRows);
      return Object.freeze({ duplicate: false });
    },
    addCounters: async (rows: readonly CounterRow[]) => {
      refuseClosed(name, closed);
      addRows(resolveCounters(rows));
    },
    listEvents: async (query: EventListQuery): Promise<Page<SecurityEvent>> => {
      refuseClosed(name, closed);
      const resolved = resolveEventQuery(query);
      const after = eventPosition(resolved);
      const sign = resolved.direction === "asc" ? 1 : -1;
      const matching = [...events.values()]
        .filter((event) => eventMatches(event, resolved.filter))
        .sort((a, b) => sign * compareEvents(a, b));
      const rest =
        after === undefined
          ? matching
          : matching.filter((event) => sign * compareEvents(event, after) > 0);
      const items = rest
        .slice(0, resolved.limit)
        .map((event) => Object.freeze(copy(event)));
      const last = items.at(-1);
      return Object.freeze({
        items: Object.freeze(items),
        ...(rest.length > resolved.limit && last !== undefined
          ? { next: eventCursor(resolved, last) }
          : {}),
        totalEstimate: matching.length,
      });
    },
    series: async (query: SeriesQuery): Promise<readonly SeriesPoint[]> => {
      refuseClosed(name, closed);
      const byService = checkGroupBy(query.groupBy) === "service";
      const sums = new Map<
        string,
        { at: number; dims: string; service?: string; value: number }
      >();
      for (const row of rowsFor(query)) {
        const key = `${row.bucket}|${row.dims}${byService ? `|${row.service}` : ""}`;
        const before = sums.get(key);
        sums.set(key, {
          at: row.bucket,
          dims: row.dims,
          ...(byService ? { service: row.service } : {}),
          value: (before?.value ?? 0) + row.value,
        });
      }
      if (sums.size > MAX_SERIES_POINTS) {
        throw new ConfigError(
          `security store: the series has more than ${MAX_SERIES_POINTS} points; narrow the range or the dims`,
        );
      }
      return Object.freeze(
        [...sums.values()]
          .sort(
            (a, b) =>
              a.at - b.at ||
              (a.dims < b.dims ? -1 : a.dims > b.dims ? 1 : 0) ||
              (a.service ?? "").localeCompare(b.service ?? ""),
          )
          .map((point) =>
            Object.freeze({
              at: point.at,
              ...(point.service === undefined
                ? {}
                : { service: point.service }),
              dims: dimsOf(point.dims),
              value: point.value,
            }),
          ),
      );
    },
    distinct: async (query: CounterQuery): Promise<DistinctCount> => {
      refuseClosed(name, closed);
      const seen = new Set<string>();
      let other = false;
      for (const row of rowsFor(query)) {
        if (row.dims.includes(OTHER_DIM)) other = true;
        else seen.add(row.dims);
      }
      return Object.freeze({ count: seen.size, other });
    },
    topK: async (query: TopKQuery): Promise<readonly TopKRow[]> => {
      refuseClosed(name, closed);
      const limit = checkTopKLimit(query);
      const sums = new Map<string, number>();
      for (const row of rowsFor(query)) {
        sums.set(row.dims, (sums.get(row.dims) ?? 0) + row.value);
      }
      return Object.freeze(
        [...sums.entries()]
          .sort(
            (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
          )
          .slice(0, limit)
          .map(([dims, value]) => Object.freeze({ dims: dimsOf(dims), value })),
      );
    },
    rollup: async (from: Tier, to: Tier, until: number) => {
      refuseClosed(name, closed);
      const end = checkRollup(from, to, until);
      const start = watermark(from, to);
      if (end <= start) return 0;
      const sums = new Map<string, ResolvedCounter>();
      for (const row of analyticsRows.values()) {
        if (row.tier !== from || row.bucket < start || row.bucket >= end)
          continue;
        const up = { ...row, tier: to, bucket: bucketOf(row.bucket, to) };
        const key = counterKey(up);
        const before = sums.get(key);
        sums.set(
          key,
          before === undefined ? up : { ...up, value: before.value + up.value },
        );
      }
      for (const [key, row] of sums) {
        const before = analyticsRows.get(key);
        analyticsRows.set(
          key,
          before === undefined
            ? row
            : { ...row, value: before.value + row.value },
        );
      }
      watermarks.set(watermarkName(from, to), end);
      return sums.size;
    },
    deleteBefore: async (
      table: RetainedTable,
      before: number,
      limit: number,
    ) => {
      refuseClosed(name, closed);
      checkDeleteBefore(table, before, limit);
      let deleted = 0;
      if (table === "events") {
        for (const [id, event] of events) {
          if (deleted >= limit) break;
          if (event.at < before) {
            events.delete(id);
            deleted += 1;
          }
        }
        return deleted;
      }
      if (table === "batches") {
        for (const [id, at] of batches) {
          if (deleted >= limit) break;
          if (at < before) {
            batches.delete(id);
            deleted += 1;
          }
        }
        return deleted;
      }
      const floor = retentionFloor(table);
      const bound =
        floor === undefined
          ? before
          : Math.min(before, watermark(floor[0], floor[1]));
      for (const [key, row] of analyticsRows) {
        if (deleted >= limit) break;
        if (row.tier === table && row.bucket < bound) {
          analyticsRows.delete(key);
          deleted += 1;
        }
      }
      return deleted;
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
