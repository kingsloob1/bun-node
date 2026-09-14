import type { JobsDriver, QueueRef } from "../drivers/index";
import { ConfigError } from "../shared/errors";
import { parseDuration } from "../shared/humanTime";

/**
 * Cluster-wide limits on a queue: how fast it may start jobs, how many may run
 * at once, and the same per job name.
 *
 * **Stored on the queue**, not passed to each worker, so every process reads
 * the same numbers and they can be changed while everything runs. Two
 * deployments configured differently in code would otherwise enforce two
 * different limits and each believe it was right.
 *
 * **Built on a compare-and-set** (`getQueueState` / `setQueueState`), which is
 * the one thing each driver has to make atomic. Everything else — windows,
 * leases, which names are full — is here, written once.
 *
 * **Approximate by design.** Concurrency is held as *leases*: each worker
 * records how many jobs it is running, renewed while it runs them and expiring
 * `lockDuration` after it stops renewing. A worker that crashes holding leases
 * keeps that capacity until they expire, and the moment between a claim and
 * recording which names it took can let a name briefly exceed its cap. In
 * exchange no claim waits on a global lock, and a queue with no limits pays
 * one cached read a second.
 */

/** A rate: at most `max` jobs started per `duration`. */
export interface RateLimit {
  /** How many jobs may start in one window. */
  max: number;
  /** The window: milliseconds, or a duration such as `"1 minute"`. */
  duration: number | string;
}

/** Limits on one job name. */
export interface NameLimits {
  /** How fast jobs of this name may start. */
  rate?: RateLimit;
  /** How many jobs of this name may run at once, across every worker. */
  concurrency?: number;
}

/** Limits on a queue. Anything left out is unlimited. */
export interface QueueLimits {
  /** How fast the queue as a whole may start jobs. */
  rate?: RateLimit;
  /** How many of its jobs may run at once, across every worker. */
  concurrency?: number;
  /**
   * Limits on particular job names, on top of the queue's own. A name at its
   * limit is skipped rather than waited behind: other names keep running.
   */
  names?: Record<string, NameLimits>;
}

/** A rate as stored: the window always in milliseconds. */
interface StoredRate {
  /** How many jobs may start in one window. */
  max: number;
  /** The window, in milliseconds. */
  duration: number;
}

/** Limits on one name, as stored. */
interface StoredNameLimits {
  /** How fast jobs of this name may start. */
  rate?: StoredRate;
  /** How many may run at once. */
  concurrency?: number;
}

/** Limits as stored, and as every worker reads them. */
export interface StoredLimits {
  /** The queue's rate. */
  rate?: StoredRate;
  /** The queue's concurrency. */
  concurrency?: number;
  /** Per-name limits. */
  names?: Record<string, StoredNameLimits>;
}

/** The queue-state name the limits are stored under. */
export const LIMITS_STATE = "limits";

/** The queue-state name the shared counters are stored under. */
export const LIMITER_STATE = "limiter";

/** Checks limits and converts durations, so what is stored needs no reading. */
export function normalizeLimits(limits: QueueLimits): StoredLimits {
  const stored: StoredLimits = {};

  if (limits.rate !== undefined) {
    stored.rate = normalizeRate(limits.rate, "rate");
  }

  if (limits.concurrency !== undefined) {
    stored.concurrency = positiveInteger(limits.concurrency, "concurrency");
  }

  for (const [name, nameLimits] of Object.entries(limits.names ?? {})) {
    const entry: StoredNameLimits = {};

    if (nameLimits.rate !== undefined) {
      entry.rate = normalizeRate(nameLimits.rate, `names.${name}.rate`);
    }

    if (nameLimits.concurrency !== undefined) {
      entry.concurrency = positiveInteger(
        nameLimits.concurrency,
        `names.${name}.concurrency`,
      );
    }

    if (entry.rate || entry.concurrency !== undefined) {
      stored.names ??= {};
      stored.names[name] = entry;
    }
  }

  return stored;
}

/** A rate with its window read. */
function normalizeRate(rate: RateLimit, what: string): StoredRate {
  const duration =
    typeof rate.duration === "string"
      ? parseDuration(rate.duration)
      : rate.duration;

  if (duration === null || !Number.isFinite(duration) || duration <= 0) {
    throw new ConfigError(
      `limits.${what}.duration must be a positive number of milliseconds or a duration such as "1 minute"`,
      { duration: rate.duration },
    );
  }

  return { max: positiveInteger(rate.max, `${what}.max`), duration };
}

/** A whole number of at least one. */
function positiveInteger(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(
      `limits.${what} must be a whole number of at least 1`,
      {
        value,
      },
    );
  }

  return value;
}

/** One worker's leases. */
interface Holder {
  /** When these leases lapse unless renewed. */
  expiresAt: number;
  /** How many jobs it holds capacity for, in total. */
  total: number;
  /** How many of those are of each name. */
  names: Record<string, number>;
}

/** One rate window's count. */
interface RateWindow {
  /** When the window began. */
  start: number;
  /** How many jobs started in it. */
  count: number;
}

/** The counters every worker shares. */
interface LimiterState {
  /** Leases, by worker. */
  holders: Record<string, Holder>;
  /** Rate windows: `""` for the queue, the name for a name's own rate. */
  windows: Record<string, RateWindow>;
}

/** What a worker may claim this pass. */
export interface Reservation {
  /** How many jobs it may claim. */
  grant: number;
  /** Names it must skip, because they are at a limit. */
  excludeNames: string[];
  /**
   * When claiming nothing, how long until it is worth asking again — the end
   * of the rate window that stopped it. `undefined` when no window did.
   */
  retryAfter: number | undefined;
  /** The queue window the grant was counted in, to take back what went unused. */
  windowStart: number | undefined;
  /** Limited names counted as if the whole grant were theirs, until `commit`. */
  tentative: TentativeNames;
}

/** Per-name counts a reservation took on account. */
interface TentativeNames {
  /** The limited names that had room, each charged the whole grant. */
  names: string[];
  /** The rate window each was charged in, by name. */
  windows: Record<string, number>;
}

/** A reservation that grants nothing. */
function emptyReservation(): Reservation {
  return {
    grant: 0,
    excludeNames: [],
    retryAfter: undefined,
    windowStart: undefined,
    tentative: { names: [], windows: {} },
  };
}

/** How many times one update retries a compare-and-set it lost. */
const UPDATE_ATTEMPTS = 12;

/** Default for how long stored limits are trusted before they are read again. */
export const DEFAULT_LIMITS_REFRESH_MS = 1_000;

/**
 * One worker's side of the shared limits.
 *
 * `reserve` before a claim, `commit` after it with the names it took,
 * `release` as each job ends. Releases are not written one by one: they ride
 * along with the next `reserve`, or the renewal timer, whichever comes first.
 */
export class QueueLimiter {
  /** The driver holding the state. */
  readonly #driver: JobsDriver;
  /** The queue. */
  readonly #ref: QueueRef;
  /** This worker's id, which names its leases. */
  readonly #holder: string;
  /** How long a lease lives unless renewed. */
  readonly #leaseMs: number;
  /** How long stored limits are trusted. */
  readonly #refreshMs: number;
  /** The limits, and when they were read. */
  #limits: { value: StoredLimits | null; readAt: number } | undefined;
  /** Jobs that ended and have not been written back yet. */
  #pending: { total: number; names: Record<string, number> } = {
    total: 0,
    names: {},
  };

  /** Renews this worker's leases while it holds any. */
  #renewal: ReturnType<typeof setInterval> | undefined;

  constructor(
    /** The driver holding the state; must implement queue state. */
    driver: JobsDriver,
    /** The queue. */
    ref: QueueRef,
    /** This worker's id. */
    holder: string,
    /** How long a lease lives unless renewed: the worker's lock duration. */
    leaseMs: number,
    /** How long stored limits are trusted before they are read again. */
    refreshMs: number = DEFAULT_LIMITS_REFRESH_MS,
  ) {
    this.#driver = driver;
    this.#ref = ref;
    this.#holder = holder;
    this.#leaseMs = leaseMs;
    this.#refreshMs = refreshMs;
  }

  /** Whether a driver can hold shared limits at all. */
  static supports(driver: JobsDriver): boolean {
    return (
      typeof driver.getQueueState === "function" &&
      typeof driver.setQueueState === "function"
    );
  }

  /**
   * How many of `slots` this worker may claim, and which names to skip — or
   * `null` when the queue has no limits, so the caller claims as it always has.
   *
   * A name with a limit and room left is the subtle case. The claim cannot be
   * told "at most two of these", and a batch could otherwise take the whole
   * head of the queue in one go, all of one capped name. So the batch shrinks
   * to the smallest room any such name has, and that room is counted as taken
   * now*, inside this compare-and-set — a worker reserving a moment later
   * sees the name full rather than claiming alongside. `commit` gives back
   * whatever the claim did not actually use.
   */
  async reserve(slots: number, now: number): Promise<Reservation | null> {
    const limits = await this.#readLimits(now);

    if (!limits) {
      return null;
    }

    let reservation: Reservation = emptyReservation();

    const written = await this.#update(now, (state) => {
      const holder = this.#ownHolder(state, now);
      let grant = slots;
      let retryAfter: number | undefined;
      let windowStart: number | undefined;

      if (limits.concurrency !== undefined) {
        grant = Math.min(grant, limits.concurrency - activeTotal(state));
      }

      if (limits.rate) {
        const window = windowFor(state, "", limits.rate, now);
        const left = limits.rate.max - window.count;
        windowStart = window.start;

        if (left <= 0) {
          retryAfter = window.start + limits.rate.duration - now;
        }

        grant = Math.min(grant, left);
      }

      const excludeNames: string[] = [];
      const open: [string, StoredNameLimits][] = [];

      for (const [name, nameLimits] of Object.entries(limits.names ?? {})) {
        let room = Number.POSITIVE_INFINITY;

        if (nameLimits.concurrency !== undefined) {
          room = Math.min(
            room,
            nameLimits.concurrency - activeByName(state, name),
          );
        }

        if (nameLimits.rate) {
          const window = windowFor(state, name, nameLimits.rate, now);
          room = Math.min(room, nameLimits.rate.max - window.count);
        }

        if (room <= 0) {
          excludeNames.push(name);
        } else {
          open.push([name, nameLimits]);
          grant = Math.min(grant, room);
        }
      }

      grant = Math.max(0, grant);

      holder.total += grant;

      if (limits.rate && windowStart !== undefined) {
        state.windows[""]!.count += grant;
      }

      // Every open limited name is counted as if the whole grant were its.
      const tentative: TentativeNames = { names: [], windows: {} };

      if (grant > 0) {
        for (const [name, nameLimits] of open) {
          tentative.names.push(name);

          if (nameLimits.concurrency !== undefined) {
            holder.names[name] = (holder.names[name] ?? 0) + grant;
          }

          if (nameLimits.rate) {
            const window = windowFor(state, name, nameLimits.rate, now);
            window.count += grant;
            tentative.windows[name] = window.start;
          }
        }
      }

      reservation = { grant, excludeNames, retryAfter, windowStart, tentative };
    });

    if (!written) {
      // Lost every race for the counters. Claiming nothing is safe; the loop
      // asks again in a moment.
      return emptyReservation();
    }

    if (reservation.grant > 0) {
      this.#startRenewal();
    }

    return reservation;
  }

  /**
   * Records what a reservation actually claimed: gives back the unused part of
   * the grant and the tentative per-name counts, and counts each limited name
   * that was actually claimed.
   */
  async commit(
    reservation: Reservation,
    names: string[],
    now: number,
  ): Promise<void> {
    if (reservation.grant === 0) {
      return;
    }

    const limits = this.#limits?.value ?? null;
    const unused = reservation.grant - names.length;

    await this.#update(now, (state) => {
      const holder = this.#ownHolder(state, now);
      holder.total = Math.max(0, holder.total - unused);

      const queueWindow = state.windows[""];
      if (
        unused > 0 &&
        queueWindow &&
        queueWindow.start === reservation.windowStart
      ) {
        queueWindow.count = Math.max(0, queueWindow.count - unused);
      }

      const claimed = new Map<string, number>();
      for (const name of names) {
        claimed.set(name, (claimed.get(name) ?? 0) + 1);
      }

      for (const name of reservation.tentative.names) {
        const actual = claimed.get(name) ?? 0;
        const giveBack = reservation.grant - actual;
        const nameLimits = limits?.names?.[name];

        if (nameLimits?.concurrency !== undefined || !nameLimits) {
          const left = (holder.names[name] ?? 0) - giveBack;
          if (left > 0) {
            holder.names[name] = left;
          } else {
            delete holder.names[name];
          }
        }

        const window = state.windows[name];
        if (
          window &&
          reservation.tentative.windows[name] !== undefined &&
          window.start === reservation.tentative.windows[name]
        ) {
          window.count = Math.max(0, window.count - giveBack);
        }
      }
    });
  }

  /** Notes that a job of this name has stopped running here. */
  release(name: string): void {
    this.#pending.total += 1;
    this.#pending.names[name] = (this.#pending.names[name] ?? 0) + 1;
  }

  /** Writes pending releases and renews this worker's leases now. */
  async renew(now: number): Promise<void> {
    await this.#update(now, (state) => {
      this.#ownHolder(state, now);
    });
  }

  /** Gives back everything this worker holds, and stops renewing. */
  async close(): Promise<void> {
    if (this.#renewal) {
      clearInterval(this.#renewal);
      this.#renewal = undefined;
    }

    if (!this.#limits?.value) {
      return;
    }

    await this.#update(Date.now(), (state) => {
      delete state.holders[this.#holder];
    });
  }

  /**
   * Whether the queue is known, right now, to have no limits: the stored limits
   * were read within the refresh interval and there were none.
   *
   * Synchronous on purpose. A worker asks before every claim, and most queues
   * have no limits; answering through `reserve()` cost three awaits between a
   * job arriving and being claimed, on the path round-trip latency is measured
   * along.
   */
  knownUnlimited(now: number): boolean {
    return (
      this.#limits !== undefined &&
      this.#limits.value === null &&
      now - this.#limits.readAt < this.#refreshMs
    );
  }

  /** The stored limits, read at most once per refresh interval. */
  async #readLimits(now: number): Promise<StoredLimits | null> {
    if (this.#limits && now - this.#limits.readAt < this.#refreshMs) {
      return this.#limits.value;
    }

    const entry = await this.#driver.getQueueState!(this.#ref, LIMITS_STATE);
    const value = (entry?.value as StoredLimits | undefined) ?? null;
    this.#limits = { value, readAt: now };
    return value;
  }

  /**
   * Reads the counters, applies `mutate` along with pending releases and lease
   * pruning, and writes them back — retrying from a fresh read when another
   * worker wrote first. Answers whether it wrote.
   */
  async #update(
    now: number,
    mutate: (state: LimiterState) => void,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
      const entry = await this.#driver.getQueueState!(this.#ref, LIMITER_STATE);
      const state: LimiterState = entry
        ? structuredClone(entry.value as LimiterState)
        : { holders: {}, windows: {} };

      // A copy, not the object. `release()` adds to `#pending` in place, so
      // holding the live object let a release noted while this write was in
      // flight ride along unwritten — and the subtraction below, seeing the
      // very object it was given, then forgot it as written. Each lost release
      // left a job counted as running for good, until a limited name read as
      // full with nothing running.
      const pending = {
        total: this.#pending.total,
        names: { ...this.#pending.names },
      };
      pruneHolders(state, now, this.#holder);
      applyReleases(state, this.#holder, pending);
      mutate(state);

      const version = await this.#driver.setQueueState!(
        this.#ref,
        LIMITER_STATE,
        state,
        entry?.version ?? null,
      );

      if (version !== null) {
        // Only what was written is forgotten: releases noted during the write
        // stay pending for the next one.
        this.#pending = subtractReleases(this.#pending, pending);
        return true;
      }

      // Somebody else wrote first. A short random pause keeps a crowd of
      // workers from retrying in lockstep.
      await Bun.sleep(1 + Math.floor(Math.random() * 4 * (attempt + 1)));
    }

    return false;
  }

  /** This worker's holder entry, created if absent, with its lease renewed. */
  #ownHolder(state: LimiterState, now: number): Holder {
    const holder = (state.holders[this.#holder] ??= {
      expiresAt: 0,
      total: 0,
      names: {},
    });
    holder.expiresAt = now + this.#leaseMs;
    return holder;
  }

  /** Keeps this worker's leases alive while it may be holding some. */
  #startRenewal(): void {
    if (this.#renewal) {
      return;
    }

    this.#renewal = setInterval(
      () => {
        void this.renew(Date.now()).catch(() => undefined);
      },
      Math.max(50, Math.floor(this.#leaseMs / 3)),
    );
    this.#renewal.unref?.();
  }
}

/** How many jobs every live holder is running, together. */
function activeTotal(state: LimiterState): number {
  return Object.values(state.holders).reduce(
    (sum, holder) => sum + holder.total,
    0,
  );
}

/** How many jobs of one name every live holder is running, together. */
function activeByName(state: LimiterState, name: string): number {
  return Object.values(state.holders).reduce(
    (sum, holder) => sum + (holder.names[name] ?? 0),
    0,
  );
}

/** The current window for a scope, starting a new one when the last has ended. */
function windowFor(
  state: LimiterState,
  scope: string,
  rate: StoredRate,
  now: number,
): RateWindow {
  const start = Math.floor(now / rate.duration) * rate.duration;
  const existing = state.windows[scope];

  if (existing && existing.start === start) {
    return existing;
  }

  const fresh = { start, count: 0 };
  state.windows[scope] = fresh;
  return fresh;
}

/** Drops leases that lapsed: their worker stopped renewing, most likely dead. */
function pruneHolders(state: LimiterState, now: number, self: string): void {
  for (const [id, holder] of Object.entries(state.holders)) {
    if (id !== self && holder.expiresAt <= now) {
      delete state.holders[id];
    }
  }
}

/** Takes finished jobs off this worker's leases. */
function applyReleases(
  state: LimiterState,
  self: string,
  pending: { total: number; names: Record<string, number> },
): void {
  const holder = state.holders[self];

  if (!holder || pending.total === 0) {
    return;
  }

  holder.total = Math.max(0, holder.total - pending.total);

  for (const [name, count] of Object.entries(pending.names)) {
    const left = (holder.names[name] ?? 0) - count;

    if (left > 0) {
      holder.names[name] = left;
    } else {
      delete holder.names[name];
    }
  }
}

/** What is still pending after `written` has been written. */
function subtractReleases(
  current: { total: number; names: Record<string, number> },
  written: { total: number; names: Record<string, number> },
): { total: number; names: Record<string, number> } {
  if (current === written) {
    return { total: 0, names: {} };
  }

  const names: Record<string, number> = {};

  for (const [name, count] of Object.entries(current.names)) {
    const left = count - (written.names[name] ?? 0);
    if (left > 0) {
      names[name] = left;
    }
  }

  return { total: Math.max(0, current.total - written.total), names };
}
