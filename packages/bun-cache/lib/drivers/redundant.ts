/**
 * `redundant()` (plan §5): a driver combinator that keeps one cache tier
 * alive when a backend is lost. It is a `CacheDriver` made of other drivers
 * (its **members**), so it goes wherever a driver goes — alone, or as the L2
 * under an L1 — and its members can differ in type (a file driver plus S3,
 * two Postgres servers, Redis plus Postgres).
 *
 * ```ts
 * const driver = redundant([postgresDriver({ url: A }), postgresDriver({ url: B })], {
 *   write: "all",      // or "primary": write one, replicate the rest through a queue
 *   read: "failover",  // or "race"
 *   timeout: 250,      // per member, per operation
 *   circuit: { failures: 5, cooldown: 30_000 },
 * });
 * ```
 *
 * - **Writes** (`write: "all"`, the default) go to every healthy member at
 *   once and resolve on the acknowledgement of the member a read would ask
 *   first (`ack: "one"`: the first healthy one in order under `failover`, so
 *   a process reads its own writes; the first to answer under `race`), or of
 *   all of them (`ack: "all"`). A slower member's write carries on in the
 *   background, up to its `timeout`. Writes that carry a tag fence, and tag
 *   invalidations, always wait for every member: their answers must agree.
 *   `write: "primary"` writes the first healthy member and copies to the rest
 *   in the background through a bounded queue per member, in order.
 * - **Reads** (`read: "failover"`, the default) ask the first healthy member;
 *   on an error, a timeout, or a miss from a secondary, the next. A miss from
 *   a healthy primary is final. `read: "race"` asks every healthy member and
 *   takes the first hit. Tag stamps are read from every healthy member, the
 *   newest per tag winning: an invalidation recorded anywhere counts.
 * - **Health**: one circuit per member, per process. `circuit.failures`
 *   consecutive failures or timeouts open it (`member-down`) for
 *   `circuit.cooldown`; then one `ping()` probe closes it (`member-up`) or
 *   re-opens it.
 * - **Rejoin empty** (§5.3): a member that misses a write or delete — down,
 *   failed, timed out, or dropped from a full replication queue — is marked
 *   **dirty** (`member-dirty`) in this process, and nothing else is kept.
 *   Reads skip it until it has been emptied: once every operation it was sent
 *   has settled, every namespace this combinator wrote to is `clear()`ed on
 *   it, and then it serves again. A repair log replayed after an outage could
 *   not be trusted; an empty cache can always be rebuilt.
 * - **The gap** (§5.3): another process that still sees the member up does
 *   not know it missed anything, and may fail over to it and serve a deleted
 *   value for up to that entry's TTL. `secondaryTtl` caps the TTL written to
 *   every member but the first, which bounds that window.
 * - **Counters and locks** live on the primary (the first member) only
 *   (`counters: "primary"`, the default): they cannot be atomic across
 *   independent backends. While the primary is down or being emptied,
 *   `increment`, `acquireLock` and `releaseLock` throw
 *   `UnsupportedOperationError` and never fail over (a counter restarted from
 *   a secondary's old value is worse than an error), and the capabilities
 *   report `atomicIncrement: false` and `lock: false`, so a cache's
 *   `getOrSet` falls back to its in-process single-flight. `counters:
 *   "refuse"` removes them.
 * - **Capabilities** are the intersection of the members' (§5.1), except
 *   counters and locks. **Tags**: `"index"` when every member indexes them
 *   (deleted on every member, the fence checked on every member: a write any
 *   member fences is fenced, and deleted where it was stored), otherwise
 *   `"stamps"` — invalidation writes stamps on every member and the core's
 *   read check hides what they invalidate, which is correct on an index
 *   member too (it stores and reads stamps like any driver), at the cost of
 *   the space being reclaimed at expiry rather than at once.
 * - **The bus** is the first member's (§5.3), unless the cache names one.
 *
 * Read repair and quorum reads (§5.2) are not offered: repair can copy a
 * value deleted elsewhere while a member was down, and quorum needs three or
 * more members for store-of-record semantics a cache does not need.
 */
import { UnsupportedOperationError } from "../core/errors";
import type {
  BusMessage,
  CacheDriver,
  CacheDriverCapabilities,
  CacheEventMap,
  CacheMemberEvent,
  SchemaChange,
  SchemaSyncOptions,
  StoredEntry,
  TagFence,
} from "../core/types";

/** `redundant()`'s options (plan §5.6). */
export interface RedundantOptions {
  /**
   * How writes and deletes reach the members. `"all"` (the default): every
   * healthy member, in parallel, acknowledged as `ack` says. `"primary"`: the
   * first healthy member, then the rest in the background through a bounded
   * queue per member (`maxQueue`), in order. Only that first member is
   * current; the others lag by their queue, and a crash loses the queue.
   */
  write?: "all" | "primary";
  /**
   * For `write: "all"`: `"one"` (the default) resolves once the member a read
   * would ask first has acknowledged — the first healthy one in order under
   * `read: "failover"` (so a process reads its own writes), the first to
   * answer under `read: "race"` — while the rest finish in the background;
   * `"all"` waits for every healthy member, so a write that resolved is on
   * each of them or has marked it dirty. A fenced write and a tag
   * invalidation always wait for all. A `TypeError` beside `write: "primary"`.
   */
  ack?: "one" | "all";
  /**
   * How reads pick a member. `"failover"` (the default): the first healthy
   * member in order; on an error, a timeout, or a miss from a secondary, the
   * next. A miss from a healthy primary is final. `"race"`: every healthy
   * member at once, the first hit wins — the lowest latency, twice the read
   * load, and it may return an older copy while a newer one exists.
   */
  read?: "failover" | "race";
  /**
   * The per-member bound on every operation, in ms; `0` for none. Defaults
   * to 250. A member that does not answer in time counts a failure toward its
   * circuit, and a write it missed marks it dirty, but its call is not
   * cancelled: the backend may still apply it. Keep the cache's own
   * `timeout`, if any, above this one. `connect()` is not bounded by it.
   */
  timeout?: number;
  /**
   * Each member's circuit: `failures` consecutive failures or timeouts
   * (default 5) open it for `cooldown` ms (default 30,000), and then one
   * `ping()` probe (a read, for a member without `ping`) closes it or opens it
   * again. An open member gets no reads or writes; each write it misses
   * leaves it dirty.
   */
  circuit?: {
    /** Consecutive failures or timeouts that open a member's circuit. Defaults to 5. */
    failures?: number;
    /** How long it stays open before the probe, in ms. Defaults to 30,000. */
    cooldown?: number;
  };
  /**
   * Where counters and locks live (§5.3). `"primary"` (the default): on the
   * first member only — while it is down or being emptied they throw
   * `UnsupportedOperationError`, and never fail over. `"refuse"`: nowhere;
   * the combinator advertises neither.
   */
  counters?: "primary" | "refuse";
  /**
   * Caps the hard expiry written to every member but the first, in ms from
   * the write: an entry there lives at most this long. It bounds the window
   * in which a process that did not see a member go down can fail over to it
   * and serve a value deleted meanwhile (§5.3, "the gap"). Optional: by
   * default each entry keeps its own TTL everywhere.
   */
  secondaryTtl?: number;
  /**
   * For `write: "primary"`: at most this many operations queued per member
   * for replication. Defaults to 10,000. A write that would pass it is
   * dropped for that member, which is marked dirty (`member-dirty` with
   * `reason: "overflow"`) and emptied, rather than left lagging with holes.
   * A `TypeError` beside `write: "all"`.
   */
  maxQueue?: number;
}

/** The defaults (§5.4, §5.6). */
const DEFAULTS = {
  /** `timeout`, ms. */
  timeout: 250,
  /** `circuit.failures`. */
  failures: 5,
  /** `circuit.cooldown`, ms. */
  cooldown: 30_000,
  /** `maxQueue`. */
  maxQueue: 10_000,
};

/** Where a member without `ping()` is probed: a read of a key nobody writes. */
const PROBE_NAMESPACE = "bun-cache-redundant-probe";

/** At most this many replicated operations go to a member in one batch. */
const BATCH_LIMIT = 500;

/** One replicated operation, queued for a member under `write: "primary"`. */
type Replication =
  | {
      /** A write. */ kind: "set";
      /** Its namespace. */ ns: string;
      /** The entry, as the first member stored it. */ entry: StoredEntry;
    }
  | {
      /** A delete of one key. */ kind: "delete";
      /** Its namespace. */ ns: string;
      /** The key. */ key: string;
    }
  | {
      /** A new hard expiry. */ kind: "touch";
      /** Its namespace. */ ns: string;
      /** The key. */ key: string;
      /** The expiry, epoch ms, or `null`. */ expiresAt: number | null;
    }
  | {
      /** A namespace emptied. */ kind: "clear";
      /** The namespace. */ ns: string;
    }
  | {
      /** Tags invalidated through the index. */ kind: "deleteByTags";
      /** Their namespace. */ ns: string;
      /** The tags. */ tags: readonly string[];
      /** When their stamps lapse, epoch ms. */ until: number;
    }
  | {
      /** Stamps written. */ kind: "setStamps";
      /** Their namespace. */ ns: string;
      /** The tags. */ tags: readonly string[];
      /** When they were invalidated, epoch ms. */ at: number;
      /** When the stamps lapse, epoch ms. */ until: number;
    };

/** One member and its health, in this process. */
interface Member {
  /** Its position; 0 is the primary. */
  index: number;
  /** The member driver. */
  driver: CacheDriver;
  /** Consecutive failures or timeouts. */
  failures: number;
  /** While its circuit is open: when the probe may run, epoch ms. `0`: closed. */
  openUntil: number;
  /** Whether a probe is running. */
  probing: boolean;
  /** Whether it missed a write or delete and must be emptied before it serves reads. */
  dirty: boolean;
  /** The emptying of a dirty member whose circuit is closed, while it runs. */
  cleaning: Promise<void> | undefined;
  /** The member's calls still running, settled or not by their timeout. */
  inflight: Set<Promise<void>>;
  /** `write: "primary"`: what is still to be replicated to it, in order. */
  queue: Replication[];
  /** The running drain of {@link queue}, if any. */
  draining: Promise<void> | undefined;
  /** Its writes still running, per namespace, for {@link RedundantDriver}'s ordering of one member's writes. */
  writes: Map<string, WriteSlot>;
}

/** One namespace's writes still running on one member. */
interface WriteSlot {
  /** The latest write per key. */
  keys: Map<string, Promise<void>>;
  /** The latest namespace-wide write (`clear`, a tag invalidation), while it runs. */
  barrier: Promise<void> | undefined;
  /** Every write still running. */
  all: Set<Promise<void>>;
}

/** One member's answer to a fanned-out write. */
interface Acknowledged<T> {
  /** The member that answered. */
  member: Member;
  /** Its answer. */
  value: T;
}

/** A listener {@link RedundantDriver.onMemberEvent} keeps. */
type MemberListener = <E extends CacheMemberEvent>(
  event: E,
  payload: CacheEventMap[E],
) => void;

/** Whether an entry is still live: an expired one is a miss to the combinator, so a read moves on. */
function live(entry: StoredEntry): boolean {
  return entry.expiresAt === null || entry.expiresAt > Date.now();
}

/** A replicated operation that orders everything around it: it runs alone. */
function isBarrier(op: Replication): boolean {
  return (
    op.kind === "clear" || op.kind === "deleteByTags" || op.kind === "setStamps"
  );
}

/** The key a key-scoped replicated operation is about. */
function keyOf(op: Replication): string {
  return op.kind === "set"
    ? `${op.ns}\n${op.entry.key}`
    : op.kind === "delete" || op.kind === "touch"
      ? `${op.ns}\n${op.key}`
      : "";
}

/**
 * Takes the next batch off a replication queue: a barrier alone, or a run of
 * key-scoped operations on distinct keys (so they can go in parallel and
 * still land in order), at most {@link BATCH_LIMIT}.
 */
function takeBatch(queue: Replication[]): Replication[] {
  if (isBarrier(queue[0]!)) {
    return queue.splice(0, 1);
  }
  const seen = new Set<string>();
  let count = 0;
  while (count < queue.length && count < BATCH_LIMIT) {
    const op = queue[count]!;
    const key = keyOf(op);
    if (isBarrier(op) || seen.has(key)) {
      break;
    }
    seen.add(key);
    count++;
  }
  return queue.splice(0, count);
}

/** Checks one option against its allowed values. */
function oneOf<T extends string>(
  name: string,
  value: T | undefined,
  allowed: readonly T[],
): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new TypeError(
      `redundant(): ${name} must be ${allowed.map((each) => `"${each}"`).join(" or ")}, not ${JSON.stringify(value)}`,
    );
  }
}

/** Checks a numeric option: finite, at least `min`, an integer when asked. */
function checkNumber(
  name: string,
  value: number | undefined,
  min: number,
  integer = false,
): void {
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      (integer && !Number.isInteger(value)))
  ) {
    throw new TypeError(
      `redundant(): ${name} must be ${integer ? "an integer" : "a finite number"} of at least ${min}, not ${String(value)}`,
    );
  }
}

/** The combinator. See the module header. */
export class RedundantDriver implements CacheDriver {
  readonly name: string;

  /** Deletes a namespace's tagged entries through every member's index, waiting for each (`tags: "index"` only). */
  readonly deleteByTags?: (
    ns: string,
    tags: readonly string[],
    stampUntil: number,
  ) => Promise<number>;

  /** Updates a hard expiry on every member (only when every member has `touch`). */
  readonly touch?: (
    ns: string,
    key: string,
    expiresAt: number | null,
  ) => Promise<boolean>;

  /** Adds to a counter on the primary only (`counters: "primary"`, a primary with counters). */
  readonly increment?: (
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ) => Promise<number>;

  /** Reads a counter from the primary only; `undefined` while it is down. */
  readonly getCounter?: (
    ns: string,
    key: string,
  ) => Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  >;

  /** Takes a lock on the primary only (`counters: "primary"`, a primary with locks). */
  readonly acquireLock?: (
    ns: string,
    key: string,
    owner: string,
    ttlMs: number,
  ) => Promise<boolean>;

  /** Releases a lock on the primary only. */
  readonly releaseLock?: (
    ns: string,
    key: string,
    owner: string,
  ) => Promise<boolean>;

  /** Sweeps every healthy member that sweeps (only when one does). */
  readonly sweep?: (now: number, limit: number) => Promise<number>;

  /** The first member's bus publish, when it has a bus. */
  readonly publish?: (message: BusMessage) => Promise<void>;

  /** The first member's bus subscribe, when it has a bus. */
  readonly subscribe?: (
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ) => Promise<() => Promise<void>>;

  /** The members, in order. */
  readonly #members: Member[];
  /** `write`. */
  readonly #write: "all" | "primary";
  /** `ack`. */
  readonly #ack: "one" | "all";
  /** `read`. */
  readonly #read: "failover" | "race";
  /** `timeout`, ms; `0` for none. */
  readonly #timeout: number;
  /** `circuit.failures`. */
  readonly #failureLimit: number;
  /** `circuit.cooldown`, ms. */
  readonly #cooldown: number;
  /** `secondaryTtl`, ms, if set. */
  readonly #secondaryTtl: number | undefined;
  /** `maxQueue`. */
  readonly #maxQueue: number;
  /** Whether counters and locks live on the primary (`counters: "primary"`). */
  readonly #countersOnPrimary: boolean;
  /** The capabilities that do not change with the members' health. */
  readonly #fixed: Omit<CacheDriverCapabilities, "atomicIncrement" | "lock">;
  /** Every namespace this combinator wrote to, deleted from or cleared: what a dirty member is emptied of. */
  readonly #namespaces = new Set<string>();
  /** The `onMemberEvent` listeners. */
  readonly #listeners: MemberListener[] = [];
  /** Set by `close()`: no more probes or emptying. */
  #closed = false;

  constructor(
    /** The member drivers, the primary first; at least two, each once. */
    drivers: readonly CacheDriver[],
    /** See {@link RedundantOptions}. */
    options: RedundantOptions = {},
  ) {
    // Checked as plain data: `Array.isArray` narrows a readonly array to `any[]`.
    const given: unknown = drivers;
    if (!Array.isArray(given) || given.length < 2) {
      throw new TypeError(
        "redundant(): give at least two member drivers, the primary first",
      );
    }
    if (new Set(drivers).size !== drivers.length) {
      throw new TypeError(
        "redundant(): each member driver may appear once (the same instance twice would take every write twice)",
      );
    }
    oneOf("write", options.write, ["all", "primary"]);
    oneOf("ack", options.ack, ["one", "all"]);
    oneOf("read", options.read, ["failover", "race"]);
    oneOf("counters", options.counters, ["primary", "refuse"]);
    checkNumber("timeout", options.timeout, 0);
    checkNumber("circuit.failures", options.circuit?.failures, 1, true);
    checkNumber("circuit.cooldown", options.circuit?.cooldown, 0);
    checkNumber("secondaryTtl", options.secondaryTtl, 1);
    checkNumber("maxQueue", options.maxQueue, 1, true);
    if (options.write === "primary" && options.ack !== undefined) {
      throw new TypeError(
        'redundant(): ack applies to write: "all"; write: "primary" acknowledges on the first healthy member',
      );
    }
    if (options.write !== "primary" && options.maxQueue !== undefined) {
      throw new TypeError(
        'redundant(): maxQueue applies to write: "primary", the only mode with a replication queue',
      );
    }

    this.#members = drivers.map((driver, index) => ({
      index,
      driver,
      failures: 0,
      openUntil: 0,
      probing: false,
      dirty: false,
      cleaning: undefined,
      inflight: new Set(),
      queue: [],
      draining: undefined,
      writes: new Map(),
    }));
    this.name = `redundant(${drivers.map((driver) => driver.name).join(", ")})`;
    this.#write = options.write ?? "all";
    this.#ack = options.ack ?? "one";
    this.#read = options.read ?? "failover";
    this.#timeout = options.timeout ?? DEFAULTS.timeout;
    this.#failureLimit = options.circuit?.failures ?? DEFAULTS.failures;
    this.#cooldown = options.circuit?.cooldown ?? DEFAULTS.cooldown;
    this.#secondaryTtl = options.secondaryTtl;
    this.#maxQueue = options.maxQueue ?? DEFAULTS.maxQueue;

    const caps = drivers.map((driver) => driver.capabilities);
    // A member that says "index" but has no `deleteByTags` is one the core
    // treats as stamps-mode too (it checks both), so the combinator does.
    const indexed = drivers.every(
      (driver) =>
        driver.capabilities.tags === "index" &&
        driver.deleteByTags !== undefined,
    );
    const limits = caps
      .map((each) => each.maxEntryBytes)
      .filter((each): each is number => each !== undefined);
    const primary = drivers[0]!;
    const bus =
      primary.capabilities.bus !== "none" &&
      primary.publish !== undefined &&
      primary.subscribe !== undefined
        ? primary.capabilities.bus
        : "none";
    this.#fixed = {
      multiProcess: caps.every((each) => each.multiProcess),
      ttl: caps.every((each) => each.ttl === "native") ? "native" : "sweep",
      tags: indexed ? "index" : "stamps",
      fence: caps.every((each) => each.fence === "atomic")
        ? "atomic"
        : "check-then-write",
      bus,
      ...(limits.length > 0 ? { maxEntryBytes: Math.min(...limits) } : {}),
    };

    if (indexed) {
      this.deleteByTags = async (ns, tags, stampUntil) =>
        await this.#deleteByTags(ns, tags, stampUntil);
    }
    if (drivers.every((driver) => driver.touch !== undefined)) {
      this.touch = async (ns, key, expiresAt) =>
        await this.#touch(ns, key, expiresAt);
    }
    this.#countersOnPrimary = (options.counters ?? "primary") === "primary";
    if (this.#countersOnPrimary) {
      if (
        primary.capabilities.atomicIncrement &&
        primary.increment !== undefined
      ) {
        this.increment = async (ns, key, by, expiresAt) =>
          await this.#onPrimary(
            "increment",
            async (driver) => await driver.increment!(ns, key, by, expiresAt),
          );
      }
      if (primary.getCounter !== undefined) {
        this.getCounter = async (ns, key) => await this.#getCounter(ns, key);
      }
      if (
        primary.capabilities.lock &&
        primary.acquireLock !== undefined &&
        primary.releaseLock !== undefined
      ) {
        this.acquireLock = async (ns, key, owner, ttlMs) =>
          await this.#onPrimary(
            "acquireLock",
            async (driver) => await driver.acquireLock!(ns, key, owner, ttlMs),
          );
        this.releaseLock = async (ns, key, owner) =>
          await this.#onPrimary(
            "releaseLock",
            async (driver) => await driver.releaseLock!(ns, key, owner),
          );
      }
    }
    if (drivers.some((driver) => driver.sweep !== undefined)) {
      this.sweep = async (now, limit) => await this.#sweep(now, limit);
    }
    if (bus !== "none") {
      this.publish = async (message) => await primary.publish!(message);
      this.subscribe = async (onMessage, onGap) =>
        await primary.subscribe!(onMessage, onGap);
    }
  }

  /**
   * The members' intersection (§5.1), except counters and locks, which
   * follow the primary (§5.3): `atomicIncrement` and `lock` read `false`
   * while it is down or being emptied, so a cache's `increment` refuses and
   * its `getOrSet` lock falls back to the in-process single-flight.
   */
  get capabilities(): CacheDriverCapabilities {
    const primary = this.#members[0]!;
    const onPrimary = this.#countersOnPrimary && this.#readable(primary);
    return {
      ...this.#fixed,
      atomicIncrement: onPrimary && this.increment !== undefined,
      lock: onPrimary && this.acquireLock !== undefined,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Health                                                           */
  /* ---------------------------------------------------------------- */

  /** Whether a member serves reads: its circuit closed, and not dirty. */
  #readable(member: Member): boolean {
    return (
      member.openUntil === 0 && !member.dirty && member.cleaning === undefined
    );
  }

  /** Whether a member takes writes: its circuit closed, and not being emptied. */
  #writable(member: Member): boolean {
    return member.openUntil === 0 && member.cleaning === undefined;
  }

  /** Delivers a member event to every listener, each isolated from the others' throws. */
  #emit<E extends CacheMemberEvent>(event: E, payload: CacheEventMap[E]): void {
    for (const listener of this.#listeners) {
      try {
        listener(event, payload);
      } catch {
        // A listener's throw never breaks the operation (§3.12).
      }
    }
  }

  /** Starts what is due: the probe of an open member past its cooldown, the emptying of a dirty one whose circuit is closed. */
  #maintain(): void {
    if (this.#closed) {
      return;
    }
    const now = Date.now();
    for (const member of this.#members) {
      if (member.openUntil > 0) {
        if (member.openUntil <= now && !member.probing) {
          void this.#probe(member);
        }
      } else if (member.dirty && member.cleaning === undefined) {
        this.#startCleaning(member);
      }
    }
  }

  /**
   * Runs one call on a member under its `timeout`, tracking the call itself
   * (not the timeout) in `inflight`, so a member is emptied only once every
   * operation it was sent has settled.
   */
  async #timed<T>(
    member: Member,
    op: string,
    run: () => Promise<T>,
  ): Promise<T> {
    let call: Promise<T>;
    try {
      call = run();
    } catch (error) {
      call = Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    const tracked: Promise<void> = call.then(
      () => {
        member.inflight.delete(tracked);
      },
      () => {
        member.inflight.delete(tracked);
      },
    );
    member.inflight.add(tracked);
    const timeout = this.#timeout;
    if (!(timeout > 0)) {
      return await call;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `redundant member ${member.index} ("${member.driver.name}") timed out on ${op} after ${timeout} ms`,
          ),
        );
      }, timeout);
      timer.unref?.();
    });
    try {
      return await Promise.race([call, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** {@link #timed}, counting the outcome toward the member's circuit. */
  async #call<T>(
    member: Member,
    op: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      const value = await this.#timed(member, op, run);
      if (member.openUntil === 0) {
        member.failures = 0;
      }
      return value;
    } catch (error) {
      member.failures++;
      if (member.openUntil === 0 && member.failures >= this.#failureLimit) {
        this.#open(member, member.failures);
      }
      throw error;
    }
  }

  /** Opens a member's circuit: no reads or writes until a probe after the cooldown. Its replication queue is lost, which leaves it dirty. */
  #open(member: Member, failures: number): void {
    member.openUntil = Date.now() + this.#cooldown;
    this.#emit("member-down", {
      driver: this.name,
      index: member.index,
      member: member.driver.name,
      failures,
    });
    if (member.queue.length > 0) {
      const op = member.queue[0]!.kind;
      member.queue.length = 0;
      this.#miss(member, op, "down");
    }
  }

  /** Records that a member missed a write or delete: it is dirty, and is emptied as soon as its circuit is closed. */
  #miss(
    member: Member,
    op: string,
    reason: CacheEventMap["member-dirty"]["reason"],
  ): void {
    if (member.dirty) {
      return;
    }
    member.dirty = true;
    this.#emit("member-dirty", {
      driver: this.name,
      index: member.index,
      member: member.driver.name,
      op,
      reason,
    });
    if (member.openUntil === 0 && member.cleaning === undefined) {
      this.#startCleaning(member);
    }
  }

  /** Waits until every call a member was sent has settled. */
  async #settled(member: Member): Promise<void> {
    while (member.inflight.size > 0 || member.draining !== undefined) {
      await Promise.all([...member.inflight, member.draining]);
    }
  }

  /** Clears every namespace this combinator wrote to on one member. */
  async #empty(
    member: Member,
    call: (op: string, run: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    await Promise.all(
      [...this.#namespaces].map(
        async (ns) =>
          await call("clear", async () => await member.driver.clear(ns)),
      ),
    );
  }

  /** Empties a dirty member whose circuit is closed (§5.3): reads skip it meanwhile, and writes do not reach it. */
  #startCleaning(member: Member): void {
    if (this.#closed) {
      return;
    }
    member.queue.length = 0;
    member.cleaning = (async () => {
      try {
        await this.#settled(member);
        await this.#empty(
          member,
          async (op, run) => await this.#call(member, op, run),
        );
        member.dirty = false;
        if (member.openUntil === 0) {
          this.#emit("member-up", {
            driver: this.name,
            index: member.index,
            member: member.driver.name,
            cleared: true,
          });
        }
      } catch {
        // Still dirty: the failure counted toward its circuit, and the next
        // operation, or the probe once it is open, tries again.
      } finally {
        member.cleaning = undefined;
      }
    })();
  }

  /**
   * The half-open probe of a member past its cooldown: `ping()` (or a read),
   * then, if it missed anything while down, the emptying — both before it is
   * let back in. Either failing opens the circuit for another cooldown.
   */
  async #probe(member: Member): Promise<void> {
    member.probing = true;
    try {
      await this.#timed(member, "ping", async () => {
        if (member.driver.ping === undefined) {
          await member.driver.get(PROBE_NAMESPACE, "ping");
        } else {
          await member.driver.ping();
        }
      });
      const cleared = member.dirty;
      if (cleared) {
        await this.#settled(member);
        await this.#empty(
          member,
          async (op, run) => await this.#timed(member, op, run),
        );
      }
      if (this.#closed) {
        return;
      }
      member.openUntil = 0;
      member.failures = 0;
      member.dirty = false;
      this.#emit("member-up", {
        driver: this.name,
        index: member.index,
        member: member.driver.name,
        cleared,
      });
    } catch {
      member.openUntil = Date.now() + this.#cooldown;
    } finally {
      member.probing = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Writes                                                           */
  /* ---------------------------------------------------------------- */

  /** An entry as one member stores it: capped at `secondaryTtl` on every member but the first. */
  #entryFor(member: Member, entry: StoredEntry): StoredEntry {
    const expiresAt = this.#expiryFor(member, entry.expiresAt);
    return expiresAt === entry.expiresAt ? entry : { ...entry, expiresAt };
  }

  /** A hard expiry as one member stores it (see {@link #entryFor}). */
  #expiryFor(member: Member, expiresAt: number | null): number | null {
    if (member.index === 0 || this.#secondaryTtl === undefined) {
      return expiresAt;
    }
    const cap = Date.now() + this.#secondaryTtl;
    return expiresAt === null ? cap : Math.min(expiresAt, cap);
  }

  /** The members a write goes to; the open ones missed it. A member being emptied is skipped: it is about to hold nothing anyway. */
  #targets(op: string): Member[] {
    const targets: Member[] = [];
    for (const member of this.#members) {
      if (this.#writable(member)) {
        targets.push(member);
      } else if (member.openUntil > 0) {
        this.#miss(member, op, "down");
      }
    }
    return targets;
  }

  /**
   * `write: "all"`: runs a write on every healthy member at once. Resolves
   * with the answers so far once `mode` is met — `"one"`: the member a read
   * asks first (the first not failed, in order, under `failover`; the first
   * to answer under `race`); `"all"`: every member settled. A member that
   * fails is marked dirty. Rejects only when no member acknowledged.
   */
  async #fanOut<T>(
    op: string,
    run: (member: Member) => Promise<T>,
    mode: "one" | "all",
  ): Promise<Acknowledged<T>[]> {
    const targets = this.#targets(op);
    if (targets.length === 0) {
      throw new Error(`${this.name}: no member is up for ${op}`);
    }
    const inOrder = this.#read === "failover";
    return await new Promise<Acknowledged<T>[]>((resolve, reject) => {
      const answers: Acknowledged<T>[] = [];
      const errors: unknown[] = [];
      /** Per target: undefined while pending, then whether it acknowledged. */
      const outcome: (boolean | undefined)[] = targets.map(() => undefined);
      let pending = targets.length;
      let done = false;
      /** Resolves once `mode` is met; rejects once nobody can meet it. */
      const settle = (): void => {
        if (done) {
          return;
        }
        if (mode === "one") {
          const first = inOrder
            ? outcome.find((each) => each !== false)
            : outcome.includes(true)
              ? true
              : undefined;
          if (first === true) {
            done = true;
            resolve([...answers]);
            return;
          }
        }
        if (pending === 0) {
          done = true;
          if (answers.length > 0) {
            resolve(answers);
          } else {
            reject(
              new AggregateError(
                errors,
                `${this.name}: no member acknowledged ${op}`,
              ),
            );
          }
        }
      };
      targets.forEach((member, position) => {
        this.#call(member, op, async () => await run(member)).then(
          (value) => {
            answers.push({ member, value });
            outcome[position] = true;
            pending--;
            settle();
          },
          (error: unknown) => {
            errors.push(error);
            outcome[position] = false;
            pending--;
            this.#miss(member, op, "failed");
            settle();
          },
        );
      });
    });
  }

  /**
   * `write: "primary"`: runs a write on the first healthy member (the next,
   * if it fails), then queues `replicate(answer)` for every other healthy
   * member. Members that are down missed it.
   */
  async #primaryWrite<T>(
    op: string,
    run: (member: Member) => Promise<T>,
    replicate: (value: T) => Replication[],
  ): Promise<T> {
    const members = this.#members;
    const errors: unknown[] = [];
    let position = 0;
    let chosen: { value: T } | undefined;
    for (; position < members.length; position++) {
      const member = members[position]!;
      if (!this.#writable(member)) {
        if (member.openUntil > 0) {
          this.#miss(member, op, "down");
        }
        continue;
      }
      try {
        chosen = {
          value: await this.#call(member, op, async () => await run(member)),
        };
        break;
      } catch (error) {
        errors.push(error);
        this.#miss(member, op, "failed");
      }
    }
    if (chosen === undefined) {
      throw new AggregateError(
        errors,
        errors.length === 0
          ? `${this.name}: no member is up for ${op}`
          : `${this.name}: no member acknowledged ${op}`,
      );
    }
    const ops = replicate(chosen.value);
    if (ops.length > 0) {
      for (const member of members.slice(position + 1)) {
        if (this.#writable(member)) {
          this.#enqueue(member, op, ops);
        } else if (member.openUntil > 0) {
          this.#miss(member, op, "down");
        }
      }
    }
    return chosen.value;
  }

  /** Queues replicated operations for a member, or drops them past `maxQueue` (the member is then dirty). */
  #enqueue(member: Member, op: string, ops: Replication[]): void {
    if (member.dirty) {
      return;
    }
    if (member.queue.length + ops.length > this.#maxQueue) {
      this.#miss(member, op, "overflow");
      return;
    }
    member.queue.push(...ops);
    member.draining ??= this.#drain(member);
  }

  /** Replicates a member's queue, batch by batch, until it is empty, the member goes down, or it is being emptied. */
  async #drain(member: Member): Promise<void> {
    try {
      // One turn first, so writes made in the same tick share a batch.
      await Promise.resolve();
      while (
        member.queue.length > 0 &&
        this.#writable(member) &&
        !member.dirty
      ) {
        await this.#replicate(member, takeBatch(member.queue));
      }
    } finally {
      member.draining = undefined;
    }
  }

  /** Runs one batch of replicated operations on a member: the writes of a namespace as one `setMany`, its deletes as one `delete`. */
  async #replicate(member: Member, batch: Replication[]): Promise<void> {
    const sets = new Map<string, StoredEntry[]>();
    const deletes = new Map<string, string[]>();
    const calls: [string, () => Promise<unknown>][] = [];
    const driver = member.driver;
    for (const op of batch) {
      switch (op.kind) {
        case "set": {
          const list = sets.get(op.ns) ?? [];
          list.push(this.#entryFor(member, op.entry));
          sets.set(op.ns, list);
          break;
        }
        case "delete": {
          const list = deletes.get(op.ns) ?? [];
          list.push(op.key);
          deletes.set(op.ns, list);
          break;
        }
        case "touch": {
          const expiresAt = this.#expiryFor(member, op.expiresAt);
          calls.push([
            "touch",
            async () => await driver.touch?.(op.ns, op.key, expiresAt),
          ]);
          break;
        }
        case "clear": {
          calls.push(["clear", async () => await driver.clear(op.ns)]);
          break;
        }
        case "deleteByTags": {
          calls.push([
            "deleteByTags",
            async () => await driver.deleteByTags?.(op.ns, op.tags, op.until),
          ]);
          break;
        }
        case "setStamps": {
          calls.push([
            "setStamps",
            async () => await driver.setStamps(op.ns, op.tags, op.at, op.until),
          ]);
          break;
        }
      }
    }
    for (const [ns, entries] of sets) {
      calls.push(["setMany", async () => await driver.setMany(ns, entries)]);
    }
    for (const [ns, keys] of deletes) {
      calls.push(["delete", async () => await driver.delete(ns, keys)]);
    }
    await Promise.all(
      calls.map(async ([op, run]) => {
        try {
          await this.#call(member, op, run);
        } catch {
          this.#miss(member, op, "failed");
        }
      }),
    );
  }

  /** A write in `write` mode: fanned out (with `mode`), or written to the first member and replicated. */
  async #mutate<T>(
    op: string,
    ns: string,
    keys: readonly string[] | undefined,
    run: (member: Member) => Promise<T>,
    replicate: (value: T) => Replication[],
    mode: "one" | "all" = this.#ack,
  ): Promise<Acknowledged<T>[]> {
    this.#maintain();
    this.#namespaces.add(ns);
    const ordered = async (member: Member): Promise<T> =>
      await this.#sequenced(member, ns, keys, async () => await run(member));
    if (this.#write === "primary") {
      const member = { current: this.#members[0]! };
      const value = await this.#primaryWrite(
        op,
        async (each) => {
          member.current = each;
          return await ordered(each);
        },
        replicate,
      );
      return [{ member: member.current, value }];
    }
    return await this.#fanOut(op, ordered, mode);
  }

  /**
   * Runs a write on a member after the member's earlier writes it must
   * follow: those on the same keys, and any namespace-wide one (`clear`, a
   * tag invalidation); a namespace-wide write (`keys` undefined) follows
   * every earlier write in its namespace. Under `ack: "one"` a member's write
   * may still be running when the next one starts, and a member with a
   * connection pool would otherwise apply them out of order (measured: a
   * `clear` and the `deleteByTags` after it, on Postgres behind Redis).
   */
  async #sequenced<T>(
    member: Member,
    ns: string,
    keys: readonly string[] | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    let slot = member.writes.get(ns);
    if (slot === undefined) {
      slot = { keys: new Map(), barrier: undefined, all: new Set() };
      member.writes.set(ns, slot);
    }
    const after: Promise<void>[] = [];
    if (keys === undefined) {
      after.push(...slot.all);
    } else {
      if (slot.barrier !== undefined) {
        after.push(slot.barrier);
      }
      for (const key of keys) {
        const earlier = slot.keys.get(key);
        if (earlier !== undefined) {
          after.push(earlier);
        }
      }
    }
    const call =
      after.length === 0
        ? run()
        : Promise.all(after).then(async () => await run());
    const owner = slot;
    const settled: Promise<void> = call.then(
      () => release(),
      () => release(),
    );
    /** Forgets this write once it settled, and the namespace's slot once empty. */
    function release(): void {
      owner.all.delete(settled);
      if (owner.barrier === settled) {
        owner.barrier = undefined;
      }
      for (const key of keys ?? []) {
        if (owner.keys.get(key) === settled) {
          owner.keys.delete(key);
        }
      }
      if (owner.all.size === 0 && member.writes.get(ns) === owner) {
        member.writes.delete(ns);
      }
    }
    owner.all.add(settled);
    if (keys === undefined) {
      owner.barrier = settled;
    } else {
      for (const key of keys) {
        owner.keys.set(key, settled);
      }
    }
    return await call;
  }

  async set(
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ): Promise<"stored" | "fenced"> {
    const answers = await this.#mutate(
      "set",
      ns,
      [entry.key],
      async (member) =>
        await member.driver.set(ns, this.#entryFor(member, entry), fence),
      (result) => (result === "stored" ? [{ kind: "set", ns, entry }] : []),
      // A fenced write waits for every member: their answers must agree.
      fence === undefined ? this.#ack : "all",
    );
    if (answers.some((answer) => answer.value === "fenced")) {
      // Fenced anywhere is fenced everywhere: delete what was stored.
      await Promise.all(
        answers
          .filter((answer) => answer.value === "stored")
          .map(async ({ member }) => {
            try {
              await this.#call(
                member,
                "delete",
                async () =>
                  await this.#sequenced(
                    member,
                    ns,
                    [entry.key],
                    async () => await member.driver.delete(ns, [entry.key]),
                  ),
              );
            } catch {
              this.#miss(member, "delete", "failed");
            }
          }),
      );
      return "fenced";
    }
    return "stored";
  }

  async setMany(ns: string, entries: readonly StoredEntry[]): Promise<void> {
    await this.#mutate(
      "setMany",
      ns,
      entries.map((each) => each.key),
      async (member) =>
        await member.driver.setMany(
          ns,
          entries.map((entry) => this.#entryFor(member, entry)),
        ),
      () => entries.map((entry) => ({ kind: "set", ns, entry })),
    );
  }

  async delete(ns: string, keys: readonly string[]): Promise<number> {
    const answers = await this.#mutate(
      "delete",
      ns,
      keys,
      async (member) => await member.driver.delete(ns, keys),
      () => keys.map((key) => ({ kind: "delete", ns, key })),
    );
    return Math.max(...answers.map((answer) => answer.value));
  }

  async clear(ns: string): Promise<void> {
    await this.#mutate(
      "clear",
      ns,
      undefined,
      async (member) => await member.driver.clear(ns),
      () => [{ kind: "clear", ns }],
    );
  }

  /** {@link touch}'s body. */
  async #touch(
    ns: string,
    key: string,
    expiresAt: number | null,
  ): Promise<boolean> {
    const answers = await this.#mutate(
      "touch",
      ns,
      [key],
      async (member) =>
        await member.driver.touch!(ns, key, this.#expiryFor(member, expiresAt)),
      () => [{ kind: "touch", ns, key, expiresAt }],
    );
    return answers.some((answer) => answer.value);
  }

  /** {@link deleteByTags}'s body: every member, waited for. */
  async #deleteByTags(
    ns: string,
    tags: readonly string[],
    stampUntil: number,
  ): Promise<number> {
    const answers = await this.#mutate(
      "deleteByTags",
      ns,
      undefined,
      async (member) => await member.driver.deleteByTags!(ns, tags, stampUntil),
      () => [{ kind: "deleteByTags", ns, tags, until: stampUntil }],
      "all",
    );
    return Math.max(...answers.map((answer) => answer.value));
  }

  async setStamps(
    ns: string,
    tags: readonly string[],
    at: number,
    until: number,
  ): Promise<void> {
    await this.#mutate(
      "setStamps",
      ns,
      undefined,
      async (member) => await member.driver.setStamps(ns, tags, at, until),
      () => [{ kind: "setStamps", ns, tags, at, until }],
      "all",
    );
  }

  /* ---------------------------------------------------------------- */
  /* Reads                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Reads `keys` by the `read` strategy. Failover: member by member, in
   * order, each asked for the keys still missing; a healthy primary's misses
   * are final. Race: every healthy member at once, each key taking the first
   * hit. Rejects only when no member answered.
   */
  async #readKeys(
    op: string,
    keys: readonly string[],
    run: (
      member: Member,
      keys: readonly string[],
    ) => Promise<(StoredEntry | undefined)[]>,
  ): Promise<(StoredEntry | undefined)[]> {
    this.#maintain();
    const out: (StoredEntry | undefined)[] = keys.map(() => undefined);
    const readable = this.#members.filter((member) => this.#readable(member));
    if (readable.length === 0) {
      throw new Error(`${this.name}: no member is up for ${op}`);
    }
    const errors: unknown[] = [];
    if (this.#read === "failover") {
      let holes = keys.map((_, position) => position);
      let answered = false;
      for (const member of readable) {
        if (holes.length === 0) {
          break;
        }
        const asked = holes.map((position) => keys[position]!);
        try {
          const got = await this.#call(
            member,
            op,
            async () => await run(member, asked),
          );
          answered = true;
          const next: number[] = [];
          holes.forEach((position, slot) => {
            const entry = got[slot];
            if (entry !== undefined && live(entry)) {
              out[position] = entry;
            } else {
              next.push(position);
            }
          });
          holes = next;
          if (member.index === 0) {
            break; // a healthy primary's miss is final
          }
        } catch (error) {
          errors.push(error);
        }
      }
      if (!answered) {
        throw new AggregateError(
          errors,
          `${this.name}: no member answered ${op}`,
        );
      }
      return out;
    }
    return await new Promise((resolve, reject) => {
      let holes = keys.length;
      let pending = readable.length;
      let answered = false;
      let done = false;
      for (const member of readable) {
        this.#call(member, op, async () => await run(member, keys))
          .then(
            (got) => {
              answered = true;
              if (done) {
                return;
              }
              got.forEach((entry, position) => {
                if (
                  out[position] === undefined &&
                  entry !== undefined &&
                  live(entry)
                ) {
                  out[position] = entry;
                  holes--;
                }
              });
              if (holes === 0) {
                done = true;
                resolve(out);
              }
            },
            (error: unknown) => {
              errors.push(error);
            },
          )
          .finally(() => {
            pending--;
            if (pending === 0 && !done) {
              done = true;
              if (answered) {
                resolve(out);
              } else {
                reject(
                  new AggregateError(
                    errors,
                    `${this.name}: no member answered ${op}`,
                  ),
                );
              }
            }
          });
      }
    });
  }

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    const [entry] = await this.#readKeys("get", [key], async (member) => [
      await member.driver.get(ns, key),
    ]);
    return entry;
  }

  async getMany(
    ns: string,
    keys: readonly string[],
  ): Promise<(StoredEntry | undefined)[]> {
    if (keys.length === 0) {
      return [];
    }
    return await this.#readKeys(
      "getMany",
      keys,
      async (member, asked) => await member.driver.getMany(ns, asked),
    );
  }

  /**
   * Reads stamps from every healthy member, whatever `read` says, and
   * answers the newest per tag: an invalidation recorded on any member
   * counts, and agrees with the fence, which any member may apply.
   */
  async getStamps(
    ns: string,
    tags: readonly string[],
  ): Promise<Map<string, number>> {
    this.#maintain();
    const readable = this.#members.filter((member) => this.#readable(member));
    if (readable.length === 0) {
      throw new Error(`${this.name}: no member is up for getStamps`);
    }
    const results = await Promise.allSettled(
      readable.map(
        async (member) =>
          await this.#call(
            member,
            "getStamps",
            async () => await member.driver.getStamps(ns, tags),
          ),
      ),
    );
    const out = new Map<string, number>();
    const errors: unknown[] = [];
    let answered = false;
    for (const result of results) {
      if (result.status === "rejected") {
        errors.push(result.reason);
        continue;
      }
      answered = true;
      for (const [tag, at] of result.value) {
        if (at > (out.get(tag) ?? Number.NEGATIVE_INFINITY)) {
          out.set(tag, at);
        }
      }
    }
    if (!answered) {
      throw new AggregateError(
        errors,
        `${this.name}: no member answered getStamps`,
      );
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Counters and locks: the primary only (§5.3)                      */
  /* ---------------------------------------------------------------- */

  /** Runs a counter or lock operation on the primary, or refuses while it is down or being emptied. Never fails over. */
  async #onPrimary<T>(
    op: string,
    run: (driver: CacheDriver) => Promise<T>,
  ): Promise<T> {
    this.#maintain();
    const primary = this.#members[0]!;
    if (!this.#readable(primary)) {
      throw new UnsupportedOperationError(
        this.name,
        op,
        `its primary member ("${primary.driver.name}") is down or being emptied, and counters and locks never fail over (plan §5.3)`,
      );
    }
    return await this.#call(primary, op, async () => await run(primary.driver));
  }

  /** `getCounter` on the primary; `undefined` while it is down: a counter lives nowhere else. */
  async #getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  > {
    this.#maintain();
    const primary = this.#members[0]!;
    if (!this.#readable(primary)) {
      return undefined;
    }
    return await this.#call(
      primary,
      "getCounter",
      async () => await primary.driver.getCounter!(ns, key),
    );
  }

  /* ---------------------------------------------------------------- */
  /* The rest of the contract                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Connects every member at once (not bounded by `timeout`: each driver's
   * own connection timeout applies). A member that fails is down from the
   * start (`member-down`); only every member failing rejects.
   */
  async connect(): Promise<void> {
    const results = await Promise.allSettled(
      this.#members.map(async (member) => await member.driver.connect?.()),
    );
    const errors: unknown[] = [];
    results.forEach((result, position) => {
      if (result.status === "rejected") {
        errors.push(result.reason);
        const member = this.#members[position]!;
        if (member.openUntil === 0) {
          member.failures = Math.max(member.failures, 1);
          this.#open(member, 1);
        }
      }
    });
    if (errors.length === this.#members.length) {
      throw new AggregateError(errors, `${this.name}: no member connected`);
    }
  }

  /** Answers when one healthy member answers its probe; rejects when none does. */
  async ping(): Promise<void> {
    this.#maintain();
    const errors: unknown[] = [];
    for (const member of this.#members) {
      if (!this.#readable(member)) {
        continue;
      }
      try {
        await this.#call(member, "ping", async () => {
          if (member.driver.ping === undefined) {
            await member.driver.get(PROBE_NAMESPACE, "ping");
          } else {
            await member.driver.ping();
          }
        });
        return;
      } catch (error) {
        errors.push(error);
      }
    }
    throw new AggregateError(errors, `${this.name}: no member answered ping`);
  }

  /** {@link sweep}'s body: every healthy member that sweeps, their counts added. */
  async #sweep(now: number, limit: number): Promise<number> {
    this.#maintain();
    const sweepers = this.#members.filter(
      (member) => member.driver.sweep !== undefined && member.openUntil === 0,
    );
    const results = await Promise.allSettled(
      sweepers.map(
        async (member) =>
          await this.#call(member, "sweep", async () => {
            // After the writes already sent to it, as a member's other
            // operations are: under `ack: "one"` an expired entry's write
            // may still be running there (measured: Postgres behind Redis
            // swept nothing, its write not yet applied).
            await Promise.all(
              [...member.writes.values()].flatMap((slot) => [...slot.all]),
            );
            return await member.driver.sweep!(now, limit);
          }),
      ),
    );
    let swept = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        swept += result.value;
      }
    }
    if (sweepers.length > 0 && results.every((r) => r.status === "rejected")) {
      throw new AggregateError(
        results.map((result) =>
          result.status === "rejected" ? (result.reason as unknown) : undefined,
        ),
        `${this.name}: no member swept`,
      );
    }
    return swept;
  }

  /** Registers an eviction listener on every member that reports evictions: an entry evicted from two members is two reports. */
  onEviction(
    listener: (ns: string, key: string, reason: string) => void,
  ): void {
    for (const member of this.#members) {
      member.driver.onEviction?.(listener);
    }
  }

  /** Registers a listener for `member-down`, `member-up` and `member-dirty` (§5.4). */
  onMemberEvent(listener: MemberListener): void {
    this.#listeners.push(listener);
  }

  /** Runs every member's `syncSchema`, in order; each change's description names its member. Every member runs even when one fails. */
  async syncSchema(options?: SchemaSyncOptions): Promise<SchemaChange[]> {
    const changes: SchemaChange[] = [];
    const errors: unknown[] = [];
    for (const member of this.#members) {
      try {
        for (const change of (await member.driver.syncSchema?.(options)) ??
          []) {
          changes.push({
            ...change,
            description: `member ${member.index} (${member.driver.name}): ${change.description}`,
          });
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${this.name}: syncSchema failed`);
    }
    return changes;
  }

  /**
   * Closes every member, after their replication queues have drained and
   * their calls in flight have settled (each bounded by `timeout`). Closes
   * every member even when one fails, then rejects with what failed.
   */
  async close(): Promise<void> {
    await Promise.all(
      this.#members.map(async (member) => {
        await member.cleaning;
        await this.#settled(member);
      }),
    );
    this.#closed = true;
    const results = await Promise.allSettled(
      this.#members.map(async (member) => await member.driver.close()),
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${this.name}: a member failed to close`,
      );
    }
  }

  /** A test hook: each member's health. See {@link redundantDriverState}. */
  static state(driver: RedundantDriver): RedundantMemberState[] {
    return driver.#members.map((member) => ({
      index: member.index,
      member: member.driver.name,
      up: member.openUntil === 0,
      dirty: member.dirty,
      cleaning: member.cleaning !== undefined,
      failures: member.failures,
      queued: member.queue.length,
    }));
  }
}

/** One member's health, as {@link redundantDriverState} reports it. */
export interface RedundantMemberState {
  /** Its position; 0 is the primary. */
  index: number;
  /** Its driver's `name`. */
  member: string;
  /** Whether its circuit is closed. */
  up: boolean;
  /** Whether it missed a write or delete and is still to be emptied. */
  dirty: boolean;
  /** Whether its emptying is running. */
  cleaning: boolean;
  /** Its consecutive failures. */
  failures: number;
  /** `write: "primary"`: operations queued for it. */
  queued: number;
}

/**
 * Each member's health in this process — circuit, dirty, queue. A test
 * hook: not exported from the package root. Throws for a driver
 * `redundant()` did not make.
 */
export function redundantDriverState(
  driver: CacheDriver,
): RedundantMemberState[] {
  if (!(driver instanceof RedundantDriver)) {
    throw new TypeError("redundantDriverState takes a redundant() driver");
  }
  return RedundantDriver.state(driver);
}

/** A redundant driver (§5): see {@link RedundantDriver} and {@link RedundantOptions}. */
export function redundant(
  /** The member drivers, the primary first; at least two. */
  drivers: readonly CacheDriver[],
  /** See {@link RedundantOptions}. */
  options: RedundantOptions = {},
): CacheDriver {
  return new RedundantDriver(drivers, options);
}
