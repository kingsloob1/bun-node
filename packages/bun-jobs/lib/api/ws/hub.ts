import type { DriverEvent } from "../../drivers/index";
import type { JobsNotifierOptions } from "../../notifier";
import type { ResolvedJobsApiConfig } from "../config";
import { JobsNotifier } from "../../notifier";
import { channelKeysFor, jobIdsOf } from "./channels";

/**
 * The fan-out from one notifier to every session.
 *
 * - **One notifier per API**, opened on the first subscription and closed by
 *   `api.close()`. It is listened to with `on("event")`, never iterated: the
 *   notifier's iterators share one buffer, so each event would reach only one
 *   of them, and a full buffer drops the oldest.
 * - **Sequence numbers are the hub's own.** Driver events carry none, so each
 *   is stamped on receipt with a process-local monotonic `seq`, under a random
 *   `epoch` per API instance: a `seq` means something only within its epoch.
 * - **A ring buffer** keeps recent stamped events, so a client that reconnects
 *   to the same instance can resume without a gap.
 * - **Dispatch is indexed** by channel name, so an event costs what its
 *   matching sessions cost, and a session matching several channels receives
 *   the event once, listing every channel it matched.
 * - **`progress` is coalesced** per job to one per `coalesceProgressMs`,
 *   keeping the latest: progress is a level, not an edge, so the dropped
 *   values need no gap.
 */

/** The timers and clock the socket uses; replaceable in tests. */
export interface WsClock {
  /** The current time, epoch ms. */
  now: () => number;
  /** Schedules `callback` once, after `ms`. */
  setTimeout: (callback: () => void, ms: number) => unknown;
  /** Cancels a {@link WsClock.setTimeout}. */
  clearTimeout: (handle: unknown) => void;
  /** Schedules `callback` every `ms`. */
  setInterval: (callback: () => void, ms: number) => unknown;
  /** Cancels a {@link WsClock.setInterval}. */
  clearInterval: (handle: unknown) => void;
}

/** Unreferences a timer handle when it supports it, so an idle socket never holds the process open. */
function unref(handle: unknown): unknown {
  (handle as { unref?: () => void } | undefined)?.unref?.();
  return handle;
}

/** The real clock. */
export const SYSTEM_CLOCK: WsClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => unref(setTimeout(callback, ms)),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => unref(setInterval(callback, ms)),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

/** An event as the hub holds it. */
export interface StampedEvent {
  /** Its sequence number within the hub's epoch. */
  seq: number;
  /** When the hub received it, epoch ms (the replay age is measured from here). */
  receivedAt: number;
  /** The event. */
  event: DriverEvent;
  /** Every channel name it reaches. */
  keys: readonly string[];
}

/** Something the hub delivers to: a session. */
export interface HubSubscriber {
  /** Receives one event, with the subscriber's channels it matched. */
  deliver: (stamped: StampedEvent, keys: string[]) => void;
}

/** What resuming after a `seq` can do. */
export type ReplayResult =
  | {
      /** The retained events cover the request. */
      status: "ok";
      /** Every retained event after it, oldest first. */
      events: StampedEvent[];
    }
  | {
      /** The client's epoch is not this hub's, or the events are no longer retained. */
      status: "epoch-changed" | "resume-expired";
    };

/** Options for {@link EventHub}. */
export interface EventHubOptions {
  /** The clock. */
  clock: WsClock;
  /** Opens the notifier. Defaults to one built from the configuration. */
  openNotifier?: () => Promise<JobsNotifier>;
}

/** Per-job progress coalescing state. */
interface ProgressState {
  /** When a progress event for the job was last dispatched. */
  lastAt: number;
  /** The latest progress event held back, if any. */
  pending?: DriverEvent;
  /** The timer that dispatches {@link pending}. */
  timer?: unknown;
}

/** Above this many coalescing entries, idle ones are swept. */
const PROGRESS_SWEEP_AT = 10_000;

/** Queue events after which a job reports no more progress. */
const PROGRESS_TERMINAL = new Set([
  "completed",
  "failed",
  "dead",
  "removed",
  "retrying",
  "cleaned",
]);

export class EventHub {
  /** This hub's epoch: random, so a restarted or different instance never matches. */
  readonly epoch: string = crypto.randomUUID();

  /** The resolved configuration. */
  readonly #config: ResolvedJobsApiConfig;
  /** The clock. */
  readonly #clock: WsClock;
  /** Opens the notifier. */
  readonly #openNotifier: () => Promise<JobsNotifier>;
  /** Replay bounds, or `false`. */
  readonly #replay: { size: number; maxAgeMs: number } | false;
  /** Progress coalescing interval; `0` sends all. */
  readonly #coalesceMs: number;

  /** The last `seq` stamped. */
  #seq = 0;
  /** The replay ring: a circular array. */
  readonly #ring: (StampedEvent | undefined)[];
  /** Index of the oldest retained entry. */
  #start = 0;
  /** Entries retained. */
  #count = 0;
  /** Subscribers by channel name. */
  readonly #channels = new Map<string, Set<HubSubscriber>>();
  /** Progress coalescing state, by `queue\0jobId`. */
  readonly #progress = new Map<string, ProgressState>();
  /** The notifier, once open. */
  #notifier: JobsNotifier | undefined;
  /** The open in flight. */
  #opening: Promise<void> | undefined;
  /** Whether `close()` was called. */
  #closed = false;

  constructor(config: ResolvedJobsApiConfig, options: EventHubOptions) {
    this.#config = config;
    this.#clock = options.clock;
    this.#openNotifier =
      options.openNotifier ?? (() => this.#defaultNotifier());
    const websocket = config.websocket;
    this.#replay = websocket === false ? false : websocket.replay;
    this.#coalesceMs = websocket === false ? 0 : websocket.coalesceProgressMs;
    this.#ring = Array.from({ length: this.#replay ? this.#replay.size : 0 });
  }

  /** The last `seq` stamped; `0` before any event. */
  get seq(): number {
    return this.#seq;
  }

  /** The notifier, once opened (and until closed). */
  get notifier(): JobsNotifier | undefined {
    return this.#notifier;
  }

  /** Whether events are retained for resume at all. */
  get replayEnabled(): boolean {
    return this.#replay !== false;
  }

  /**
   * The oldest `seq` still retained for replay; `seq + 1` when none is. A
   * `seq` below it can never be replayed again.
   */
  get oldestRetainedSeq(): number {
    this.#expire();
    return this.#count > 0 ? this.#ring[this.#start]!.seq : this.#seq + 1;
  }

  /** How many channels have at least one subscriber. */
  get channelCount(): number {
    return this.#channels.size;
  }

  /**
   * Opens the notifier, once. Concurrent callers share the attempt; a failed
   * attempt is forgotten, so the next subscription tries again.
   */
  async open(): Promise<void> {
    if (this.#closed) {
      throw new Error("The event hub is closed");
    }
    if (this.#notifier) {
      return;
    }
    this.#opening ??= this.#openNotifier()
      .then(async (notifier) => {
        if (this.#closed) {
          await notifier.close();
          throw new Error("The event hub is closed");
        }
        notifier.on("event", (event) => this.ingest(event));
        notifier.on("error", (error, context) => {
          this.#config.logger.warn("jobs api event source failed", {
            error,
            context,
          });
        });
        this.#notifier = notifier;
      })
      .finally(() => {
        this.#opening = undefined;
      });
    await this.#opening;
  }

  /** Builds the notifier from the configuration: mode and lists narrow what it follows. */
  async #defaultNotifier(): Promise<JobsNotifier> {
    const config = this.#config;
    const options: JobsNotifierOptions = {};
    if (config.mode === "runner") {
      options.queues = [];
    } else if (config.queues !== "all") {
      options.queues = [...config.queues.keys()];
    }
    if (config.mode === "jobs") {
      options.runners = [];
    } else if (Array.isArray(config.runners)) {
      options.runners = config.runners.map((runner) => runner.id);
    }
    if (config.jobs) {
      return await config.jobs.notifier(options);
    }
    const notifier = new JobsNotifier(config.driver, config.namespace, options);
    await notifier.start();
    return notifier;
  }

  /** Adds a subscriber to a channel. */
  subscribe(subscriber: HubSubscriber, key: string): void {
    let set = this.#channels.get(key);
    if (!set) {
      set = new Set();
      this.#channels.set(key, set);
    }
    set.add(subscriber);
  }

  /** Removes a subscriber from a channel. */
  unsubscribe(subscriber: HubSubscriber, key: string): void {
    const set = this.#channels.get(key);
    if (set?.delete(subscriber) && set.size === 0) {
      this.#channels.delete(key);
    }
  }

  /**
   * Takes one event from the source: coalesces it if it is progress, and
   * otherwise stamps and dispatches it. Public so a test can feed the hub.
   */
  ingest(event: DriverEvent): void {
    if (this.#closed) {
      return;
    }
    if (event.kind === "queue" && this.#coalesceMs > 0) {
      if (event.type === "progress") {
        this.#coalesce(event);
        return;
      }
      for (const id of jobIdsOf(event)) {
        // Progress held back for this job goes first, so it never arrives
        // after the event that ended the job.
        const key = `${event.target} ${id}`;
        this.#flushProgress(key);
        if (PROGRESS_TERMINAL.has(event.type)) {
          this.#progress.delete(key);
        }
      }
    }
    this.#stamp(event);
  }

  /** Holds back or dispatches one progress event. */
  #coalesce(event: DriverEvent): void {
    const key = `${event.target} ${event.id ?? ""}`;
    const now = this.#clock.now();
    const state = this.#progress.get(key);
    if (!state || (!state.timer && now - state.lastAt >= this.#coalesceMs)) {
      if (!state && this.#progress.size >= PROGRESS_SWEEP_AT) {
        this.#sweepProgress(now);
      }
      this.#progress.set(key, { lastAt: now });
      this.#stamp(event);
      return;
    }
    state.pending = event;
    state.timer ??= this.#clock.setTimeout(
      () => {
        state.timer = undefined;
        // A timer callback has no caller to catch for it: a throw here would
        // be uncaught, and would end the process.
        try {
          this.#flushProgress(key);
        } catch (error) {
          this.#config.logger.error("jobs api progress flush failed", {
            error,
          });
        }
      },
      Math.max(0, state.lastAt + this.#coalesceMs - now),
    );
  }

  /** Dispatches a job's held-back progress now, if there is any. */
  #flushProgress(key: string): void {
    const state = this.#progress.get(key);
    if (!state?.pending) {
      return;
    }
    if (state.timer !== undefined) {
      this.#clock.clearTimeout(state.timer);
      state.timer = undefined;
    }
    const pending = state.pending;
    state.pending = undefined;
    state.lastAt = this.#clock.now();
    this.#stamp(pending);
  }

  /** Forgets coalescing entries with nothing pending and an elapsed interval. */
  #sweepProgress(now: number): void {
    for (const [key, state] of this.#progress) {
      if (!state.pending && now - state.lastAt >= this.#coalesceMs) {
        this.#progress.delete(key);
      }
    }
  }

  /**
   * Stamps an event, retains it, and hands it to every matching subscriber
   * once. The channel keys are computed before the `seq` is taken, so an event
   * that could not be routed would never burn a number every client then
   * waits for in vain.
   */
  #stamp(event: DriverEvent): void {
    const keys = channelKeysFor(event);
    const stamped: StampedEvent = {
      seq: ++this.#seq,
      receivedAt: this.#clock.now(),
      event,
      keys,
    };
    this.#retain(stamped);

    const matches = new Map<HubSubscriber, string[]>();
    for (const key of stamped.keys) {
      const set = this.#channels.get(key);
      if (!set) {
        continue;
      }
      for (const subscriber of set) {
        const keys = matches.get(subscriber);
        if (keys) {
          keys.push(key);
        } else {
          matches.set(subscriber, [key]);
        }
      }
    }
    for (const [subscriber, keys] of matches) {
      try {
        subscriber.deliver(stamped, keys);
      } catch (error) {
        this.#config.logger.error("jobs api event delivery failed", { error });
      }
    }
  }

  /** Adds an event to the ring, overwriting the oldest when full. */
  #retain(stamped: StampedEvent): void {
    if (!this.#replay) {
      return;
    }
    const size = this.#ring.length;
    if (this.#count < size) {
      this.#ring[(this.#start + this.#count) % size] = stamped;
      this.#count++;
    } else {
      this.#ring[this.#start] = stamped;
      this.#start = (this.#start + 1) % size;
    }
    this.#expire();
  }

  /** Drops entries older than `maxAgeMs`. */
  #expire(): void {
    if (!this.#replay) {
      return;
    }
    const oldestAllowed = this.#clock.now() - this.#replay.maxAgeMs;
    const size = this.#ring.length;
    while (this.#count > 0) {
      const oldest = this.#ring[this.#start]!;
      if (oldest.receivedAt >= oldestAllowed) {
        break;
      }
      this.#ring[this.#start] = undefined;
      this.#start = (this.#start + 1) % size;
      this.#count--;
    }
  }

  /**
   * The retained events after `afterSeq`, for a client that last saw
   * `afterSeq` under `epoch`:
   *
   * - `epoch-changed` when the epoch is not this hub's, and also when
   *   `afterSeq` is beyond anything this hub has stamped: such a position was
   *   never in this epoch's history, so — as for a foreign epoch — nothing
   *   about what the client holds is known, and a gap from `0` is the honest
   *   answer (a range from `afterSeq + 1` would be inverted);
   * - `resume-expired` when replay is off, or when events after `afterSeq`
   *   are no longer retained;
   * - otherwise `ok`, with every retained event whose `seq` is greater.
   */
  replay(epoch: string, afterSeq: number): ReplayResult {
    if (epoch !== this.epoch || afterSeq > this.#seq) {
      return { status: "epoch-changed" };
    }
    if (!this.#replay) {
      return { status: "resume-expired" };
    }
    this.#expire();
    const size = this.#ring.length;
    const oldestSeq =
      this.#count > 0 ? this.#ring[this.#start]!.seq : this.#seq + 1;
    if (afterSeq < oldestSeq - 1) {
      return { status: "resume-expired" };
    }
    const events: StampedEvent[] = [];
    for (let index = 0; index < this.#count; index++) {
      const stamped = this.#ring[(this.#start + index) % size]!;
      if (stamped.seq > afterSeq) {
        events.push(stamped);
      }
    }
    return { status: "ok", events };
  }

  /** Stops listening: closes the notifier the hub opened and cancels coalescing timers. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const state of this.#progress.values()) {
      if (state.timer !== undefined) {
        this.#clock.clearTimeout(state.timer);
      }
    }
    this.#progress.clear();
    this.#channels.clear();
    await this.#opening?.catch(() => undefined);
    const notifier = this.#notifier;
    this.#notifier = undefined;
    await notifier?.close();
  }
}
