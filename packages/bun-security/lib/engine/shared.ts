/**
 * The shared store (topologies.md §3): where state shared between
 * enforcement points lives — shared and hybrid limits, counted-rule
 * counters, the active bans and their log, offence scores and the ladder's
 * ban history, distinct counts. `cacheStore(cache)` from
 * `@kingsleyweb/bun-security/stores` implements it over a bun-cache `Cache`;
 * the engine needs nothing else of bun-cache, so the root entry imports
 * none of it.
 *
 * Every method that touches the store throws (or rejects) when the store
 * fails, a miss being `undefined`, never a failure: the ban log treats a
 * failed read as "not known", so a sick store can never empty the bans.
 * {@link StoreGuard} gives an implementation the per-call timeout and the
 * circuit breaker the engine relies on to never wait on a sick store
 * (topologies.md §6.1).
 */
import type { ThrottleStore } from "@kingsleyweb/bun-common";

/** Whether the shared store is answering (for `status()` and the `store.unavailable` warning). */
export interface StoreHealth {
  /** Whether the last call succeeded and the circuit is closed. */
  readonly healthy: boolean;
  /** When the current run of failures began, epoch ms; `undefined` while healthy. */
  readonly failingSince: number | undefined;
  /** Consecutive failures. */
  readonly failures: number;
}

/** How often the engine works the shared store in the background, in milliseconds. */
export interface SharedStateIntervals {
  /** Hybrid limits and offence scores sync this often. */
  readonly sync: number;
  /** The ban log is read this often, besides the bus's nudges. */
  readonly poll: number;
  /** The whole active ban set is reloaded this often. */
  readonly reconcile: number;
}

/**
 * Hot state shared between processes (topologies.md §3.1), as the engine
 * uses it: `createSecurity({ store })`. Values are plain JSON data; keys are
 * the engine's, under the store's own namespace. Each method throws or
 * rejects when the store fails; a miss is `undefined`.
 */
export interface SharedStateStore {
  /** A short name for logs and status (`"bun-cache:redis"`). */
  readonly name: string;
  /** Where `shared` limits and counted rules count: a throttle store every process shares. */
  readonly throttle: ThrottleStore;
  /** Where `hybrid` limits count: a store in front of {@link throttle} that syncs in batches. Absent: `hybrid` limits are refused. */
  readonly hybrid?: ThrottleStore;
  /** The background intervals. */
  readonly intervals: SharedStateIntervals;
  /** Reads one value; `undefined` when there is none. */
  get: (key: string) => Promise<unknown>;
  /** Reads several values, in order, `undefined` per miss. */
  getMany: (keys: readonly string[]) => Promise<unknown[]>;
  /** Writes a value for `ttl` milliseconds (`null`: until deleted). */
  set: (key: string, value: unknown, ttl: number | null) => Promise<void>;
  /** Adds `by` to the counter at `key`, atomically; creates it with `ttl` (`null`: none); answers the new value. `by` `0` reads it. */
  increment: (key: string, by: number, ttl: number | null) => Promise<number>;
  /** Moves `key`'s expiry to `ttl` milliseconds from now; nothing when it is gone. */
  touch: (key: string, ttl: number) => Promise<void>;
  /** Adds elements to the distinct-count sketch at `key` (created with `ttl`). */
  pfAdd: (
    key: string,
    elements: readonly string[],
    ttl: number | null,
  ) => Promise<boolean>;
  /** The distinct elements added at `key`, estimated. */
  pfCount: (key: string) => Promise<number>;
  /** Tells every listener that the bans changed. Optional: without it, the ban log is polled. */
  notify?: () => Promise<void>;
  /** Listens for {@link notify}; `onGap` when messages may have been lost. Answers how to stop. */
  listen?: (
    onNotify: () => void,
    onGap: () => void,
  ) => Promise<() => Promise<void>>;
  /** Writes what the store holds back (its hybrid counts) now. Optional. */
  flush?: () => Promise<void>;
  /** Whether the store is answering. */
  health: () => StoreHealth;
  /** Stops what the store started (its hybrid sync); never closes the cache it was given. */
  close: () => Promise<void>;
}

/** A shared store's failure: what it threw, or that it timed out, or that its circuit is open. */
export class SharedStoreError extends Error {
  constructor(
    /** What went wrong. */
    message: string,
    /** What the store threw, if anything. */
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "SharedStoreError";
  }
}

/** What {@link StoreGuard} takes. */
export interface StoreGuardOptions {
  /** A call slower than this many milliseconds fails. */
  readonly timeout: number;
  /** This many failures in a row open the circuit. */
  readonly failures: number;
  /** How long the circuit stays open, in milliseconds; then one call probes. */
  readonly cooldown: number;
  /** The clock. */
  readonly now: () => number;
}

/**
 * A per-call timeout and a circuit breaker around a store's calls
 * (topologies.md §6.1): a call slower than `timeout` fails (it is not
 * cancelled; its answer is ignored); `failures` failures in a row open the
 * circuit, and calls then fail at once until `cooldown` has passed, when one
 * call probes and its success closes the circuit. So a dead store costs a
 * request nothing but the fallback.
 */
export class StoreGuard {
  /** Consecutive failures. */
  #failures = 0;
  /** When the current run of failures began. */
  #failingSince: number | undefined;
  /** The circuit is open until then (0: closed). */
  #openUntil = 0;
  /** Whether a probe is running. */
  #probing = false;

  constructor(
    /** The settings. */
    private readonly options: StoreGuardOptions,
  ) {}

  /** The store's health as the guard has seen it. */
  health(): StoreHealth {
    const now = this.options.now();
    return {
      healthy: this.#failures === 0 && this.#openUntil <= now,
      failingSince: this.#failingSince,
      failures: this.#failures,
    };
  }

  /** Runs `call` under the timeout (`timeout` ms when given) and the circuit. */
  async run<T>(
    what: string,
    call: () => Promise<T>,
    timeout: number = this.options.timeout,
  ): Promise<T> {
    const now = this.options.now();
    let probe = false;
    if (this.#openUntil > 0) {
      if (this.#openUntil > now || this.#probing) {
        throw new SharedStoreError(
          `the shared store's circuit is open (${what} not tried)`,
        );
      }
      probe = true;
      this.#probing = true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new SharedStoreError(
              `the shared store's ${what} timed out after ${timeout} ms`,
            ),
          );
        }, timeout);
        timer.unref?.();
        call().then(resolve, reject);
      });
      this.#failures = 0;
      this.#failingSince = undefined;
      this.#openUntil = 0;
      return result;
    } catch (error) {
      this.#failures++;
      this.#failingSince ??= now;
      if (probe || this.#failures >= this.options.failures) {
        this.#openUntil = now + this.options.cooldown;
      }
      throw error instanceof SharedStoreError
        ? error
        : new SharedStoreError(`the shared store's ${what} failed`, error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (probe) this.#probing = false;
    }
  }
}
