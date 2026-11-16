/**
 * The ban stream over a shared store (topologies.md §3.3, layers.md L4): how
 * a ban written by one process reaches every other, over a store that can
 * count and get but cannot list (a bun-cache cache).
 *
 * - **The log.** Each ban and lift is a record at `bans:log:<n>`, `n` from
 *   an atomic counter (`bans:seq`), kept {@link LOG_TTL}. A process reads the
 *   records past its cursor, in order, when the store's bus says the bans
 *   changed and every `poll` interval besides. A record not there yet (its
 *   writer took the number and has not written it) holds the cursor back
 *   for {@link HOLE_GRACE} at most, then is skipped, so a writer that died
 *   between the two cannot stall anyone.
 * - **The snapshot.** The active set as of a log number, written in parts
 *   of {@link SNAPSHOT_PART} bans (`bans:snap:<gen>:<i>`), then its head
 *   (`bans:snap`), then a generation counter (`bans:snapgen`), so a reader
 *   that sees the counter finds the head and the head's parts. One process
 *   per {@link COMPACT_EVERY} writes it, elected by an atomic increment of
 *   `bans:compact:<period>`.
 * - **The reconcile.** Every `reconcile` interval each process reads the
 *   snapshot and the log after it, and makes its table that set: a lost bus
 *   message, an expiry or a lift is corrected within the interval whatever
 *   the bus did (ConcaveHR's minute republish). A read that is not whole (a
 *   failed read, a hole) adds what it found and removes nothing, so a sick
 *   store can never empty the bans.
 * - **Writes** go to the table at once and to the store behind it, from a
 *   bounded queue that a failing store leaves to the next poll; past the
 *   bound the oldest are dropped and counted. A store found emptied (its
 *   counter behind this process's cursor: a flush, a new server) is
 *   refilled from this process's table.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import { mergeBans } from "./bans";
import type { Ban } from "./bans";
import type { SharedStateStore } from "./shared";

/** How long a log record is kept: a snapshot is written well within it. */
export const LOG_TTL = 24 * 60 * 60_000;

/** How long a snapshot's parts are kept: rewritten at every snapshot. */
export const SNAPSHOT_TTL = 30 * 24 * 60 * 60_000;

/** At most one snapshot is written per this many milliseconds, fleet-wide. */
export const COMPACT_EVERY = 5 * 60_000;

/** A snapshot is written when this many records have been logged since the last one, or {@link COMPACT_EVERY} has passed. */
export const COMPACT_RECORDS = 1_000;

/** Bans per snapshot part. */
export const SNAPSHOT_PART = 500;

/** How long a missing record holds the cursor back. */
export const HOLE_GRACE = 5_000;

/** Records read per `getMany`. */
const READ_BATCH = 500;

/** Past this many records behind, a process reloads instead of reading the log. */
const MAX_DELTA = 20_000;

/** A record of the log. */
export type BanLogRecord =
  | {
      /** A ban written (or merged): the record as its writer holds it. */
      readonly op: "ban";
      /** The ban. */
      readonly ban: Ban;
    }
  | {
      /** A ban lifted. */
      readonly op: "lift";
      /** Its id. */
      readonly id: string;
      /** When, epoch ms. */
      readonly at: number;
      /** The scope it was lifted in ({@link scopeKey}); absent: shared. */
      readonly scope?: string;
    };

/**
 * The scope a ban is enforced in: `"shared"` (every `shared` service on the
 * namespace) or `"service:<id>"` (that service alone, `state.scope:
 * "service"`). Two services' bans of one subject are two records unless
 * both are shared.
 */
export function scopeKey(ban: Pick<Ban, "scope" | "service">): string {
  return ban.scope === "service" ? `service:${ban.service ?? ""}` : "shared";
}

/** A record's key in the store's whole set: its scope and its id. */
function viewKey(ban: Ban): string {
  return `${scopeKey(ban)}|${ban.id}`;
}

/** The most bans the whole set is kept for (a snapshot's source). */
const MAX_VIEW = 2_000_000;

/** The snapshot's head. */
interface SnapshotHead {
  /** The last log number it includes. */
  readonly seq: number;
  /** Its parts' generation. */
  readonly gen: string;
  /** How many parts. */
  readonly parts: number;
  /** When it was written, epoch ms. */
  readonly at: number;
}

/** What the ban log feeds: the engine's table. */
export interface BanSink {
  /** Takes another process's record. */
  merge: (ban: Ban) => void;
  /** Takes another process's lift. */
  remove: (id: string) => void;
  /** Makes the table the store's set; see `BanTable.reconcile`. */
  reconcile: (set: ReadonlyMap<string, Ban>, complete: boolean) => void;
  /** Whether a record from the store may apply here: its scope is this process's, and a removed counted rule's bans do not. */
  keep: (ban: Ban) => boolean;
  /** This process's scope ({@link scopeKey}), for lifts. */
  scope: () => string;
  /** The bans in force here, for a snapshot or a refill. */
  list: () => readonly Ban[];
}

/** Key of the log counter. */
const SEQ = "bans:seq";
/** Key of the snapshot's head. */
const SNAP = "bans:snap";
/** Key of the snapshot generation counter. */
const SNAPGEN = "bans:snapgen";

/** A log record's key. */
function logKey(n: number): string {
  return `bans:log:${n}`;
}

/** A snapshot part's key. */
function partKey(gen: string, i: number): string {
  return `bans:snap:${gen}:${i}`;
}

/** Whether `value` is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An optional short string. */
function optionalText(value: unknown, max = 1024): boolean {
  return (
    value === undefined || (typeof value === "string" && value.length <= max)
  );
}

/**
 * `value` as a ban, or `undefined` when it is not one: the store is shared,
 * so what comes out of it is checked before it can refuse anyone.
 */
export function readBan(value: unknown): Ban | undefined {
  if (!isObject(value)) return undefined;
  const subject = value.subject;
  if (!isObject(subject)) return undefined;
  const { type, value: subjectValue } = subject;
  if (
    typeof type !== "string" ||
    type.length === 0 ||
    type.length > 256 ||
    typeof subjectValue !== "string" ||
    subjectValue.length === 0 ||
    subjectValue.length > 2048 ||
    value.id !== `${type}:${subjectValue}` ||
    (value.action !== "ban" && value.action !== "challenge") ||
    typeof value.reason !== "string" ||
    value.reason.length > 1024 ||
    (value.source !== "auto" && value.source !== "manual") ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !(
      value.expiresAt === null ||
      (typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt))
    ) ||
    typeof value.count !== "number" ||
    !Number.isSafeInteger(value.count) ||
    value.count < 1 ||
    !optionalText(value.rule) ||
    !optionalText(value.createdBy) ||
    !optionalText(value.code, 64) ||
    !optionalText(value.service, 256) ||
    (value.scope !== undefined && value.scope !== "service")
  ) {
    return undefined;
  }
  return Object.freeze({
    id: value.id,
    subject: Object.freeze({ type, value: subjectValue }),
    action: value.action,
    reason: value.reason,
    ...(value.rule === undefined ? {} : { rule: value.rule as string }),
    source: value.source,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ...(value.createdBy === undefined
      ? {}
      : { createdBy: value.createdBy as string }),
    count: value.count,
    ...(value.code === undefined ? {} : { code: value.code as string }),
    ...(value.service === undefined
      ? {}
      : { service: value.service as string }),
    ...(value.scope === "service" ? { scope: "service" as const } : {}),
  });
}

/** `value` as a log record, or `undefined`. */
function readRecord(value: unknown): BanLogRecord | undefined {
  if (!isObject(value)) return undefined;
  if (value.op === "ban") {
    const ban = readBan(value.ban);
    return ban === undefined ? undefined : { op: "ban", ban };
  }
  if (
    value.op === "lift" &&
    typeof value.id === "string" &&
    value.id.length <= 2304 &&
    typeof value.at === "number" &&
    optionalText(value.scope, 300)
  ) {
    return {
      op: "lift",
      id: value.id,
      at: value.at,
      ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
    };
  }
  return undefined;
}

/** `value` as a snapshot head, or `undefined`. */
function readHead(value: unknown): SnapshotHead | undefined {
  if (
    !isObject(value) ||
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0 ||
    typeof value.gen !== "string" ||
    !/^[\w-]{1,64}$/.test(value.gen) ||
    typeof value.parts !== "number" ||
    !Number.isSafeInteger(value.parts) ||
    value.parts < 0 ||
    value.parts > 10_000 ||
    typeof value.at !== "number"
  ) {
    return undefined;
  }
  return {
    seq: value.seq,
    gen: value.gen,
    parts: value.parts,
    at: value.at,
  };
}

/** What the log has read and written, for `status()`. */
export interface BanSyncStatus {
  /** Records waiting to be written to the store. */
  readonly pending: number;
  /** Records dropped from a full queue. */
  readonly dropped: number;
  /** The last log number read. */
  readonly cursor: number;
  /** When the active set was last reloaded whole, epoch ms. */
  readonly reconciledAt: number | undefined;
}

/** The ban log of one engine. */
export class BanSync {
  /** The last log number taken. */
  #cursor = 0;
  /** When the record after the cursor was first found missing. */
  #holeSince: number | undefined;
  /** Records to write. */
  #pending: BanLogRecord[] = [];
  /** Records dropped from a full queue. */
  #dropped = 0;
  /** The write in progress. */
  #writing: Promise<void> | undefined;
  /** The read in progress, and whether another was asked for meanwhile. */
  #reading: Promise<void> | undefined;
  /** Another read was asked for while one ran. */
  #again = false;
  /** The latest snapshot head seen. */
  #snapshot: SnapshotHead | undefined;
  /** The snapshot generation counter last seen. */
  #snapgen = 0;
  /** When the set was last reloaded whole. */
  #reconciledAt: number | undefined;
  /** When a store failure was last logged. */
  #lastWarn = Number.NEGATIVE_INFINITY;
  /**
   * The store's whole set, every scope, by {@link viewKey}: what a snapshot
   * is written from (this process's table holds its own scope only).
   * `undefined` until a whole reload, or past {@link MAX_VIEW}.
   */
  #view: Map<string, Ban> | undefined;

  constructor(
    /** The shared store. */
    private readonly store: SharedStateStore,
    /** The engine's table. */
    private readonly sink: BanSink,
    /** The clock. */
    private readonly now: () => number,
    /** Where failures are logged. */
    private readonly logger: Logger,
    /** The most records queued. */
    private readonly maxPending: number,
  ) {}

  /** The log's counters. */
  status(): BanSyncStatus {
    return {
      pending: this.#pending.length,
      dropped: this.#dropped,
      cursor: this.#cursor,
      reconciledAt: this.#reconciledAt,
    };
  }

  /** Whether a ban of `id` is queued, not yet in the store (a reload keeps it). */
  pending(id: string): boolean {
    for (const record of this.#pending) {
      if ((record.op === "ban" ? record.ban.id : record.id) === id) return true;
    }
    return false;
  }

  /** Logs a store failure, at most once every 10 s. */
  #failed(what: string, error: unknown): void {
    const now = this.now();
    if (now - this.#lastWarn < 10_000) return;
    this.#lastWarn = now;
    this.logger.warn(
      `bun-security: the shared store "${this.store.name}" failed ${what}; bans keep applying from memory`,
      { error },
    );
  }

  /** Queues a record for the store and starts writing it. */
  record(record: BanLogRecord): void {
    this.#pending.push(record);
    if (this.#pending.length > this.maxPending) {
      this.#pending.shift();
      this.#dropped++;
    }
    void this.write();
  }

  /** Writes the queue to the store; a failure leaves the rest for the next call. */
  write(): Promise<void> {
    this.#writing ??= this.#write().finally(() => {
      this.#writing = undefined;
    });
    return this.#writing;
  }

  /** {@link write}, unguarded. */
  async #write(): Promise<void> {
    let wrote = false;
    try {
      while (this.#pending.length > 0) {
        const record = this.#pending[0];
        if (record === undefined) break;
        const n = await this.store.increment(SEQ, 1, null);
        await this.store.set(logKey(n), record, LOG_TTL);
        // Dropped meanwhile (a full queue) or not, it is written now.
        if (this.#pending[0] === record) this.#pending.shift();
        wrote = true;
      }
    } catch (error) {
      this.#failed("writing a ban", error);
    }
    if (wrote) {
      try {
        await this.store.notify?.();
      } catch (error) {
        this.#failed("announcing a ban", error);
      }
    }
  }

  /** Reads the log past the cursor (coalesced: one read at a time, one more if asked meanwhile). */
  read(): Promise<void> {
    if (this.#reading !== undefined) {
      this.#again = true;
      return this.#reading;
    }
    this.#reading = (async () => {
      do {
        this.#again = false;
        try {
          await this.#delta();
        } catch (error) {
          this.#failed("reading the ban log", error);
        }
      } while (this.#again);
    })().finally(() => {
      this.#reading = undefined;
    });
    return this.#reading;
  }

  /** One read of the log past the cursor. */
  async #delta(): Promise<void> {
    const head = await this.store.increment(SEQ, 0, null);
    if (head < this.#cursor) {
      await this.#refill();
      return;
    }
    if (head - this.#cursor > MAX_DELTA) {
      await this.reload();
      return;
    }
    await this.#apply(head, (record) => {
      this.#see(record);
      if (record.op === "ban") {
        if (this.sink.keep(record.ban)) this.sink.merge(record.ban);
      } else if ((record.scope ?? "shared") === this.sink.scope()) {
        this.sink.remove(record.id);
      }
    });
  }

  /** Applies `record` to the whole set. */
  #see(record: BanLogRecord): void {
    const view = this.#view;
    if (view === undefined) return;
    if (record.op === "lift") {
      view.delete(`${record.scope ?? "shared"}|${record.id}`);
      return;
    }
    const key = viewKey(record.ban);
    const held = view.get(key);
    view.set(
      key,
      held === undefined ? record.ban : mergeBans(held, record.ban),
    );
    if (view.size > MAX_VIEW) {
      this.#view = undefined;
      this.logger.warn(
        `bun-security: the shared store "${this.store.name}" holds more than ${MAX_VIEW} bans; this process writes no snapshot`,
      );
    }
  }

  /**
   * Gives the table the bans of the whole set it now keeps (after a new
   * policy changed its scope), adding only.
   */
  reapply(): void {
    const view = this.#view;
    if (view === undefined) return;
    const set = new Map<string, Ban>();
    for (const ban of view.values()) {
      if (!this.sink.keep(ban)) continue;
      const held = set.get(ban.id);
      set.set(ban.id, held === undefined ? ban : mergeBans(held, ban));
    }
    this.sink.reconcile(set, false);
  }

  /**
   * Reads records `cursor + 1 .. head` in order, giving each to `take`;
   * stops at a missing one within its grace. Answers whether it read to the
   * head with nothing skipped.
   */
  async #apply(
    head: number,
    take: (record: BanLogRecord) => void,
  ): Promise<boolean> {
    let whole = true;
    while (this.#cursor < head) {
      const from = this.#cursor + 1;
      const to = Math.min(head, this.#cursor + READ_BATCH);
      const keys: string[] = [];
      for (let n = from; n <= to; n++) keys.push(logKey(n));
      const values = await this.store.getMany(keys);
      for (let i = 0; i < values.length; i++) {
        const record = readRecord(values[i]);
        if (record === undefined) {
          const now = this.now();
          if (values[i] === undefined) {
            this.#holeSince ??= now;
            if (now - this.#holeSince < HOLE_GRACE) return false;
          }
          // Skipped: missing past its grace, or not a record.
          whole = false;
        } else {
          take(record);
        }
        this.#holeSince = undefined;
        this.#cursor = from + i;
      }
    }
    return whole;
  }

  /**
   * Reloads the active set whole: the snapshot and the log after it. A read
   * that is not whole merges what it found and removes nothing.
   */
  async reload(): Promise<void> {
    const snapgen = await this.store.increment(SNAPGEN, 0, null);
    const head = await this.store.increment(SEQ, 0, null);
    if (head < this.#cursor || snapgen < this.#snapgen) {
      await this.#refill();
      return;
    }
    const set = new Map<string, Ban>();
    const now = this.now();
    let whole = true;
    let snapshot: SnapshotHead | undefined;
    if (snapgen > 0) {
      snapshot = readHead(await this.store.get(SNAP));
      if (snapshot === undefined) {
        // Counted but not read: a failed read, or the head expired.
        whole = false;
      } else {
        const keys: string[] = [];
        for (let i = 0; i < snapshot.parts; i++) {
          keys.push(partKey(snapshot.gen, i));
        }
        for (let i = 0; i < keys.length; i += READ_BATCH) {
          const parts = await this.store.getMany(keys.slice(i, i + READ_BATCH));
          for (const part of parts) {
            if (!Array.isArray(part)) {
              whole = false;
              continue;
            }
            for (const item of part as unknown[]) {
              const ban = readBan(item);
              if (ban === undefined) continue;
              if (ban.expiresAt !== null && ban.expiresAt <= now) continue;
              set.set(viewKey(ban), ban);
            }
          }
        }
      }
    }
    const saved = this.#cursor;
    this.#cursor = whole ? (snapshot?.seq ?? 0) : saved;
    if (!whole) {
      // Without the snapshot, only what was read can be added.
      for (const ban of set.values()) {
        this.#see({ op: "ban", ban });
        if (this.sink.keep(ban)) this.sink.merge(ban);
      }
      this.#cursor = saved;
      await this.#delta();
      return;
    }
    const logWhole = await this.#apply(head, (record) => {
      if (record.op === "ban") {
        const key = viewKey(record.ban);
        const held = set.get(key);
        set.set(
          key,
          held === undefined ? record.ban : mergeBans(held, record.ban),
        );
      } else {
        set.delete(`${record.scope ?? "shared"}|${record.id}`);
      }
    });
    const kept = new Map<string, Ban>();
    for (const [key, ban] of set) {
      if (ban.expiresAt !== null && ban.expiresAt <= now) {
        set.delete(key);
        continue;
      }
      if (!this.sink.keep(ban)) continue;
      const held = kept.get(ban.id);
      kept.set(ban.id, held === undefined ? ban : mergeBans(held, ban));
    }
    this.#view = set.size > MAX_VIEW ? undefined : set;
    this.sink.reconcile(kept, logWhole && this.#cursor === head);
    if (snapshot !== undefined) this.#snapshot = snapshot;
    this.#snapgen = snapgen;
    this.#reconciledAt = now;
  }

  /**
   * The store was emptied (its counter is behind this process's cursor): the
   * cursor starts again and this process's bans are logged again, so the
   * fleet's memory refills the store.
   */
  async #refill(): Promise<void> {
    this.logger.warn(
      `bun-security: the shared store "${this.store.name}" lost its ban log (flushed or replaced); logging this process's bans again`,
    );
    this.#cursor = 0;
    this.#snapgen = 0;
    this.#snapshot = undefined;
    this.#holeSince = undefined;
    // Every scope this process knows of, not only its own.
    const known =
      this.#view === undefined ? this.sink.list() : [...this.#view.values()];
    this.#view = undefined;
    for (const ban of known) this.record({ op: "ban", ban });
    await this.write();
  }

  /**
   * Writes a snapshot when one is due (see the module's description) and
   * this process wins the period's election. Answers whether it wrote one.
   */
  async compact(): Promise<boolean> {
    const now = this.now();
    const last = this.#snapshot;
    const due =
      last === undefined
        ? this.#cursor > 0
        : this.#cursor - last.seq >= COMPACT_RECORDS ||
          (now - last.at >= COMPACT_EVERY && this.#cursor > last.seq);
    // Written from the whole set, every scope: never from this process's table.
    if (!due || this.#pending.length > 0 || this.#view === undefined) {
      return false;
    }
    const period = Math.floor(now / COMPACT_EVERY);
    const won = await this.store.increment(
      `bans:compact:${period}`,
      1,
      2 * COMPACT_EVERY,
    );
    if (won !== 1) return false;
    const seq = this.#cursor;
    const bans = [...this.#view.values()].filter(
      (ban) => ban.expiresAt === null || ban.expiresAt > now,
    );
    const gen = `${seq}-${Math.random().toString(36).slice(2, 10)}`;
    const parts = Math.ceil(bans.length / SNAPSHOT_PART);
    for (let i = 0; i < parts; i++) {
      await this.store.set(
        partKey(gen, i),
        bans.slice(i * SNAPSHOT_PART, (i + 1) * SNAPSHOT_PART),
        SNAPSHOT_TTL,
      );
    }
    const head: SnapshotHead = { seq, gen, parts, at: now };
    await this.store.set(SNAP, head, null);
    this.#snapgen = await this.store.increment(SNAPGEN, 1, null);
    this.#snapshot = head;
    if (last !== undefined) {
      // Readers that took the old head have a while to finish with it.
      for (let i = 0; i < last.parts; i++) {
        await this.store.touch(partKey(last.gen, i), 10 * 60_000);
      }
    }
    return true;
  }
}
