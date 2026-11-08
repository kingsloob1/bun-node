/**
 * Live invalidation across processes: a pluggable bus, so a `publishTags()`
 * (or a route's `cache.invalidates`, or a source's invalidation) in one
 * process reaches the live subscribers of every process on the bus.
 *
 * ```ts
 * import { redisBus } from "@kingsleyweb/bun-cache";
 * import { cacheLiveBus } from "@kingsleyweb/bun-cache/live";
 *
 * app.use(liveInvalidation(app, { authorize, bus: cacheLiveBus(redisBus(url)) }));
 * // or, in a process that only publishes (a worker), or to close it later:
 * const connection = connectLiveBus(cacheLiveBus(redisBus(url)));
 * ```
 *
 * {@link LiveBus} is structural, so bun-common depends on no bus: bun-cache's
 * `cacheLiveBus()` adapts any of its buses (Redis pub/sub, Postgres
 * `LISTEN`/`NOTIFY`), and anything with `publish` and `subscribe` will do.
 *
 * - **Local first.** A process delivers its own invalidations to its own
 *   subscribers at once, whatever the bus does; the bus carries them to the
 *   others. A message is never delivered twice: the publisher skips its own
 *   (by origin), and every receiver drops a number it has already taken.
 * - **Numbering stays per process.** A process numbers what the bus brings
 *   in its own epoch, like its own invalidations, so the wire protocol and
 *   resume are unchanged: a client resumes from the process it reconnects
 *   to, and one that lands on another process gets a `gap` (another epoch).
 * - **Ordering.** Each process numbers its messages `n = 1, 2, 3, …` and
 *   publishes one at a time, so a receiver takes one process's
 *   invalidations in the order they were published. Several
 *   `publishTags()` calls in one synchronous run, or made while a publish
 *   is in flight, go out as one message (up to 256 tags a message).
 * - **Gaps.** When invalidations may have been lost, the process sends every
 *   subscriber a `gap` (each invalidates everything) and answers older
 *   cursors with one: on every (re)subscription to the bus (nothing
 *   published before it reached this process), on the bus's own `onGap` (a
 *   reconnect), on a hole in another process's numbers (a message lost, or
 *   never sent because its bus was down), and on a message the bus could not
 *   carry whole (`truncated`).
 * - **When the bus is down**, local delivery goes on. A failed publish is
 *   logged (once per outage) and its number is spent, so the others see the
 *   hole at the next message that arrives and send their subscribers a
 *   `gap`; a failed subscription is retried (0.5 s, doubling to 30 s).
 * - **One bus per process**: the hub is the process's, so a second
 *   {@link connectLiveBus} with another bus throws a `ConfigError`; the same
 *   bus again shares the connection, which closes with its last holder.
 */
import type { Logger, LoggerLike } from "../logging";
import { ConfigError } from "../errors";
import { resolveLogger } from "../logging";
import { LIVE_MAX_TAGS } from "./contract";
import { deliverLocally, isTag, markGap } from "./hub";

/* ------------------------------------------------------------------ *
 * The interface
 * ------------------------------------------------------------------ */

/** One message on a {@link LiveBus}: an invalidation, from one process. */
export interface LiveBusMessage {
  /** The publishing process's id: random per process, so a process skips its own messages. */
  readonly origin: string;
  /**
   * The message's number among its origin's: `1, 2, 3, …`, consecutive, so a
   * receiver drops one it has taken (a duplicate) and sees a hole (a lost
   * message) as a gap.
   */
  readonly n: number;
  /** The invalidated tags (at most 256, each 1 to 512 characters). */
  readonly tags: readonly string[];
  /**
   * Set by a bus that could not carry the tags (a payload too large for
   * Postgres's `NOTIFY`, which bun-cache's bus turns into a `clear`): the
   * receiver treats the message as a gap. A publisher never sets it.
   */
  readonly truncated?: boolean;
}

/**
 * A bus between processes, as live invalidation uses it: anything with
 * `publish` and `subscribe`, at most once per message. bun-cache's
 * `cacheLiveBus(bus)` (`@kingsleyweb/bun-cache/live`) adapts its Redis and
 * Postgres buses.
 */
export interface LiveBus {
  /** The bus's name, for the logs (`"redis"`, `"postgres"`). Optional. */
  readonly name?: string;
  /** Publishes a message to every subscriber, this process's included (it skips its own). */
  publish: (message: LiveBusMessage) => Promise<void>;
  /**
   * Subscribes; answers the function that unsubscribes. `onGap` is called
   * whenever messages may have been lost (a reconnect).
   */
  subscribe: (
    onMessage: (message: LiveBusMessage) => void,
    onGap: () => void,
  ) => Promise<() => Promise<void>>;
}

/** {@link connectLiveBus}'s options. */
export interface ConnectLiveBusOptions {
  /**
   * Where publish and subscribe failures are logged (any `LoggerLike`).
   * Default: a console logger; `liveInvalidation()`'s `bus` passes the app's.
   * Only the first connection's logger is used.
   */
  readonly logger?: LoggerLike;
}

/** A process's connection to its live bus, from {@link connectLiveBus}. */
export interface LiveBusConnection {
  /**
   * Resolves once the subscription first holds (never rejects: a failing
   * subscription is retried until it holds or the connection closes, and
   * then resolves too).
   */
  readonly ready: Promise<void>;
  /**
   * Releases this holder; the last one unsubscribes and stops publishing
   * (after the publish in flight, waiting 2 s at most; what is still queued
   * is dropped). Never closes the bus itself: its owner does. Idempotent.
   */
  close: () => Promise<void>;
}

/* ------------------------------------------------------------------ *
 * The connection
 * ------------------------------------------------------------------ */

/** This process's id on the bus. */
const ORIGIN = crypto.randomUUID();

/** How many other processes' last numbers are kept (the oldest is forgotten first). */
const MAX_ORIGINS = 1024;

/** The most distinct tags waiting to be published; past it they are dropped, and their number spent, so receivers see a gap. */
const MAX_PENDING = 10_000;

/** The first resubscribe delay after a failure, in ms; doubled per failure up to {@link MAX_RETRY_MS}. */
const FIRST_RETRY_MS = 500;

/** The longest resubscribe delay, in ms. */
const MAX_RETRY_MS = 30_000;

/** The longest `close()` waits for the publish in flight, in ms. */
const CLOSE_WAIT_MS = 2_000;

/** The process's link to its bus. */
interface Link {
  /** The bus. */
  readonly bus: LiveBus;
  /** Where failures are logged. */
  readonly logger: Logger;
  /** How many open {@link LiveBusConnection}s hold it. */
  holders: number;
  /** Set once the last holder closed. */
  closed: boolean;
  /** The unsubscribe function, once subscribed. */
  unsubscribe: (() => Promise<void>) | undefined;
  /** The resubscribe timer, after a failure. */
  retry: ReturnType<typeof setTimeout> | undefined;
  /** {@link LiveBusConnection.ready}. */
  readonly ready: Promise<void>;
  /** Resolves {@link ready}. */
  readonly resolveReady: () => void;
  /** The last number published. */
  n: number;
  /** The tags waiting for the next publish, in order. */
  pending: Set<string>;
  /** Whether a flush is scheduled or running. */
  flushing: Promise<void> | undefined;
  /** Whether the last publish failed (so an outage is logged once). */
  failing: boolean;
  /** Each other process's last number taken, oldest first. */
  readonly origins: Map<string, number>;
}

/** The process's link, while one is connected. */
let link: Link | undefined;

/**
 * Connects this process's live invalidation to `bus`: every invalidation
 * published here is published on it, and every one another process
 * publishes on it is delivered here. See the module header.
 *
 * @param bus The bus: bun-cache's `cacheLiveBus(redisBus(url))`, or any
 *   {@link LiveBus}.
 * @param options {@link ConnectLiveBusOptions}.
 * @returns The connection: `ready`, and `close()` to release it.
 * @throws ConfigError when another bus is already connected.
 */
export function connectLiveBus(
  bus: LiveBus,
  options: ConnectLiveBusOptions = {},
): LiveBusConnection {
  if (
    typeof bus?.publish !== "function" ||
    typeof bus.subscribe !== "function"
  ) {
    throw new TypeError(
      "connectLiveBus(): expected a bus with publish() and subscribe()",
    );
  }
  if (link !== undefined && link.bus !== bus) {
    throw new ConfigError(
      "connectLiveBus(): another live bus is already connected in this process; close it first (one bus per process)",
    );
  }
  const current = link ?? open(bus, options);
  current.holders++;
  let released = false;
  return {
    ready: current.ready,
    close: async () => {
      if (released) return;
      released = true;
      if (--current.holders > 0) return;
      await shut(current);
    },
  };
}

/** Opens the process's link to `bus` and starts subscribing. */
function open(bus: LiveBus, options: ConnectLiveBusOptions): Link {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const created: Link = {
    bus,
    logger: resolveLogger(options.logger),
    holders: 0,
    closed: false,
    unsubscribe: undefined,
    retry: undefined,
    ready,
    resolveReady,
    n: 0,
    pending: new Set(),
    flushing: undefined,
    failing: false,
    origins: new Map(),
  };
  link = created;
  void subscribe(created, 0);
  return created;
}

/** Stops `current`: no more publishes or deliveries, and the subscription released. */
async function shut(current: Link): Promise<void> {
  current.closed = true;
  if (link === current) link = undefined;
  if (current.retry !== undefined) clearTimeout(current.retry);
  current.retry = undefined;
  current.pending.clear();
  current.resolveReady();
  // The publish in flight, but not one stuck on a bus that is down.
  if (current.flushing !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      current.flushing,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  const unsubscribe = current.unsubscribe;
  current.unsubscribe = undefined;
  await unsubscribe?.().catch((error: unknown) => {
    current.logger.warn("live bus: unsubscribing failed", {
      bus: current.bus.name,
      error,
    });
  });
}

/**
 * Closes any live bus connection, whoever holds it.
 *
 * @internal For tests.
 */
export async function resetLiveBus(): Promise<void> {
  if (link !== undefined) await shut(link);
}

/** Subscribes, retrying with backoff until it holds or the link closes. */
async function subscribe(current: Link, attempt: number): Promise<void> {
  current.retry = undefined;
  try {
    const unsubscribe = await current.bus.subscribe(
      (message) => receive(current, message),
      () => {
        if (!current.closed) markGap();
      },
    );
    if (current.closed) {
      await unsubscribe();
      return;
    }
    current.unsubscribe = unsubscribe;
    // Whatever another process published before now never reached us.
    markGap();
    if (attempt > 0)
      current.logger.info("live bus: subscribed again", {
        bus: current.bus.name,
      });
    current.resolveReady();
  } catch (error) {
    if (current.closed) return;
    if (attempt === 0)
      current.logger.warn(
        "live bus: subscribing failed; other processes' invalidations do not reach this one until it holds (retrying)",
        { bus: current.bus.name, error },
      );
    const delay = Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
    current.retry = setTimeout(() => {
      void subscribe(current, attempt + 1);
    }, delay);
    current.retry.unref?.();
  }
}

/** Whether `message` has the shape of a {@link LiveBusMessage}. */
function isMessage(message: unknown): message is LiveBusMessage {
  const m = message as Partial<LiveBusMessage> | null | undefined;
  return (
    typeof m?.origin === "string" &&
    m.origin.length > 0 &&
    typeof m.n === "number" &&
    Number.isSafeInteger(m.n) &&
    m.n > 0 &&
    Array.isArray(m.tags)
  );
}

/** Takes one message from the bus: dropped when it is ours or a duplicate; a hole or a truncated message is a gap. */
function receive(current: Link, message: LiveBusMessage): void {
  if (current.closed) return;
  if (!isMessage(message)) {
    current.logger.debug("live bus: ignored a message that is not one", {
      bus: current.bus.name,
    });
    return;
  }
  if (message.origin === ORIGIN) return;
  const { origins } = current;
  const last = origins.get(message.origin);
  if (last !== undefined && message.n <= last) return;
  origins.delete(message.origin);
  origins.set(message.origin, message.n);
  if (origins.size > MAX_ORIGINS) {
    const oldest = origins.keys().next().value;
    if (oldest !== undefined) origins.delete(oldest);
  }
  const lost = last !== undefined && message.n > last + 1;
  if (lost || message.truncated === true) markGap();
  if (message.truncated === true) return;
  const tags = [...new Set(message.tags.filter(isTag))];
  if (tags.length > 0) deliverLocally(tags);
}

/**
 * Queues `tags` (valid, de-duplicated) for the bus, when one is connected:
 * published in a microtask, with whatever else was published before it
 * runs, one message at a time.
 */
export function forwardToBus(tags: readonly string[]): void {
  const current = link;
  if (current === undefined || current.closed) return;
  for (const tag of tags) current.pending.add(tag);
  if (current.pending.size > MAX_PENDING) {
    // Spend a number for what is dropped: every receiver sees the hole.
    current.pending.clear();
    current.n++;
    current.logger.warn(
      "live bus: too many invalidations waiting for the bus; dropped (the other processes send their subscribers a gap)",
      { bus: current.bus.name, limit: MAX_PENDING },
    );
    return;
  }
  current.flushing ??= flush(current);
}

/** Publishes what is pending, a message of at most 256 tags at a time, until nothing is. */
async function flush(current: Link): Promise<void> {
  // In a microtask, so the publishes of one synchronous run go out together.
  await Promise.resolve();
  try {
    while (current.pending.size > 0 && !current.closed) {
      const tags = [...current.pending].slice(0, LIVE_MAX_TAGS);
      for (const tag of tags) current.pending.delete(tag);
      const n = ++current.n;
      try {
        await current.bus.publish({ origin: ORIGIN, n, tags });
        if (current.failing) {
          current.failing = false;
          current.logger.info("live bus: publishing again", {
            bus: current.bus.name,
          });
        }
      } catch (error) {
        // The number is spent: the receivers see the hole at the next one.
        if (!current.failing) {
          current.failing = true;
          current.logger.warn(
            "live bus: publishing failed; this process's invalidations reach its own subscribers only until it recovers",
            { bus: current.bus.name, error },
          );
        }
      }
    }
  } finally {
    current.flushing = undefined;
  }
}
