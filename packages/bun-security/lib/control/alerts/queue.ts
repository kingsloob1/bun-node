/**
 * Delivery queues for alert messages (README §9.3, PR-CP6). Each delivery
 * is tried up to 6 times, waiting between tries from 30 s doubling to an
 * hour, with jitter; one that runs out of tries becomes a dead letter,
 * kept and listed until replayed.
 *
 * - {@link memoryDeliveryQueue}: in process, bounded (past `maxPending` a
 *   new delivery is dropped and counted, never silently); dead letters
 *   kept, the oldest dropped past `maxDeadLetters` (counted).
 * - {@link jobsDeliveryQueue}: on a bun-jobs queue (an optional peer: the
 *   caller passes its `BunQueue`), so retries survive a restart; a worker
 *   runs {@link AlertDeliveryQueue.deliver} for each job, and bun-jobs'
 *   dead-letter queue holds what died.
 */
import type { AlertDeadLetter, AlertDelivery, AlertMessage } from "./types";

/** The retry policy (the coordinator's defaults of 2026-11-17). */
export const ALERT_RETRY = Object.freeze({
  /** Tries per delivery. */
  attempts: 6,
  /** The first wait, ms. */
  firstDelayMs: 30_000,
  /** The longest wait, ms. */
  maxDelayMs: 3_600_000,
});

/** The wait before try `attempt + 1` after `attempt` failed tries: doubling, capped, with jitter in its upper half. */
export function retryDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const plain = Math.min(
    ALERT_RETRY.maxDelayMs,
    ALERT_RETRY.firstDelayMs * 2 ** (attempt - 1),
  );
  return Math.round(plain / 2 + (random() * plain) / 2);
}

/** Sends one delivery; throws when it did not go. */
export type DeliverFn = (delivery: AlertDelivery) => Promise<void>;

/** What a queue reports. */
export interface DeliveryQueueStats {
  /** Deliveries waiting (to be tried, or tried again). */
  readonly pending: number;
  /** Deliveries sent. */
  readonly sent: number;
  /** Tries that failed. */
  readonly failures: number;
  /** Deliveries that ran out of tries. */
  readonly dead: number;
  /** Deliveries dropped by the bound (`maxPending`, `maxDeadLetters`). */
  readonly dropped: number;
}

/** A queue of deliveries. */
export interface AlertDeliveryQueue {
  /** Queues a message for a channel. */
  readonly enqueue: (channelId: string, message: AlertMessage) => Promise<void>;
  /** The dead letters, newest first (empty for a queue whose dead letters live elsewhere). */
  readonly deadLetters: () => readonly AlertDeadLetter[];
  /** Queues a dead letter again with fresh tries; whether it was there. */
  readonly replay: (id: string) => Promise<boolean>;
  /** Its figures. */
  readonly stats: () => DeliveryQueueStats;
  /** Stops it (pending deliveries are kept no further). */
  readonly close: () => void;
}

/** Options of {@link memoryDeliveryQueue}. */
export interface MemoryDeliveryQueueOptions {
  /** Sends a delivery. */
  readonly deliver: DeliverFn;
  /** The most deliveries waiting; past it a new one is dropped and counted. Default 10,000. */
  readonly maxPending?: number;
  /** The most dead letters kept per channel; past it the channel's oldest go (counted). Default 10,000. */
  readonly maxDeadLetters?: number;
  /** How long a dead letter is kept, ms. Default 30 days. */
  readonly retainMs?: number;
  /** Deliveries tried at once. Default 4. */
  readonly concurrency?: number;
  /** The clock, epoch ms. */
  readonly now: () => number;
  /** A number in [0, 1), for the jitter. */
  readonly random?: () => number;
  /** Start the timer that works the queue (default `true`; tests call `work()`). */
  readonly timers?: boolean;
}

/** An in-process queue; see the module's description. */
export interface MemoryDeliveryQueue extends AlertDeliveryQueue {
  /** Tries every delivery due now; resolves when they are done. */
  readonly work: () => Promise<void>;
}

/** A delivery's id. */
function deliveryId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** An in-process queue; see the module's description. */
export function memoryDeliveryQueue(
  options: MemoryDeliveryQueueOptions,
): MemoryDeliveryQueue {
  const maxPending = options.maxPending ?? 10_000;
  const maxDead = options.maxDeadLetters ?? 10_000;
  const retainMs = options.retainMs ?? 30 * 86_400_000;
  const concurrency = options.concurrency ?? 4;
  const random = options.random ?? Math.random;
  const pending: { delivery: AlertDelivery; dueAt: number }[] = [];
  const dead: AlertDeadLetter[] = [];
  /** Drops dead letters older than `retainMs` (newest first, so from the end). */
  const expire = () => {
    const cutoff = options.now() - retainMs;
    while (dead.length > 0 && dead.at(-1)!.diedAt < cutoff) dead.pop();
  };
  let sent = 0;
  let failures = 0;
  let died = 0;
  let dropped = 0;
  let working: Promise<void> | undefined;
  let closed = false;

  const work = async (): Promise<void> => {
    if (working !== undefined) return await working;
    working = (async () => {
      const now = options.now();
      const due = pending.filter((entry) => entry.dueAt <= now);
      for (const entry of due) pending.splice(pending.indexOf(entry), 1);
      for (let at = 0; at < due.length; at += concurrency) {
        await Promise.all(
          due.slice(at, at + concurrency).map(async ({ delivery }) => {
            const attempts = delivery.attempts + 1;
            try {
              await options.deliver({ ...delivery, attempts });
              sent += 1;
            } catch (error) {
              failures += 1;
              const reason =
                error instanceof Error ? error.message : String(error);
              if (attempts >= ALERT_RETRY.attempts) {
                died += 1;
                dead.unshift({
                  ...delivery,
                  attempts,
                  reason: reason.slice(0, 500),
                  diedAt: options.now(),
                });
                expire();
                let count = 0;
                for (let i = 0; i < dead.length; i++) {
                  if (dead[i]!.channelId !== delivery.channelId) continue;
                  count += 1;
                  if (count > maxDead) {
                    dead.splice(i, 1);
                    dropped += 1;
                    break;
                  }
                }
              } else if (!closed) {
                pending.push({
                  delivery: { ...delivery, attempts },
                  dueAt: options.now() + retryDelay(attempts, random),
                });
              }
            }
          }),
        );
      }
    })().finally(() => {
      working = undefined;
    });
    return await working;
  };

  const timer =
    options.timers === false
      ? undefined
      : setInterval(() => {
          void work();
        }, 1_000);
  timer?.unref?.();

  const queue: MemoryDeliveryQueue = {
    enqueue: (channelId, message) => {
      if (closed) return Promise.resolve();
      if (pending.length >= maxPending) {
        dropped += 1;
        return Promise.resolve();
      }
      const now = options.now();
      pending.push({
        delivery: {
          id: deliveryId(),
          channelId,
          message,
          attempts: 0,
          queuedAt: now,
        },
        dueAt: now,
      });
      return Promise.resolve();
    },
    deadLetters: () => {
      expire();
      return [...dead];
    },
    replay: async (id) => {
      const at = dead.findIndex((letter) => letter.id === id);
      if (at < 0) return false;
      const [letter] = dead.splice(at, 1);
      pending.push({
        delivery: {
          id: letter!.id,
          channelId: letter!.channelId,
          message: letter!.message,
          attempts: 0,
          queuedAt: letter!.queuedAt,
        },
        dueAt: options.now(),
      });
      return true;
    },
    stats: () => ({
      pending: pending.length,
      sent,
      failures,
      dead: died,
      dropped,
    }),
    close: () => {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      pending.length = 0;
    },
    work,
  };
  return Object.freeze(queue);
}

/** The part of a bun-jobs `BunQueue` the adapter uses (bun-jobs is an optional peer). */
export interface JobsQueueLike {
  /** Adds a job. */
  readonly add: (
    name: string,
    data: AlertDelivery,
    options: {
      /** Tries. */
      readonly attempts: number;
      /** The waits between them. */
      readonly backoff: {
        /** `exponential`. */
        readonly type: "exponential";
        /** The first wait, ms. */
        readonly delay: number;
        /** The longest, ms. */
        readonly max: number;
        /** Jitter, 0 to 1. */
        readonly jitter: number;
      };
      /** The dead-letter queue's name. */
      readonly deadLetter?: string;
    },
  ) => Promise<unknown>;
}

/** The job name deliveries are added under. */
export const ALERT_DELIVERY_JOB = "bun-security.alert";

/**
 * Deliveries on a bun-jobs queue: each is a job (`bun-security.alert`) with
 * the retry policy as its attempts and backoff, dead letters on
 * `deadLetter`. Run a `BunQueueWorker` on the queue with
 * `(job) => alerts.deliver(job.data)` as its processor.
 */
export function jobsDeliveryQueue(options: {
  /** The bun-jobs queue. */
  readonly queue: JobsQueueLike;
  /** The dead-letter queue's name. Default none (bun-jobs keeps dead jobs by its `removeOnFail`). */
  readonly deadLetter?: string;
  /** The clock, epoch ms. */
  readonly now: () => number;
}): AlertDeliveryQueue {
  let sent = 0;
  const queue: AlertDeliveryQueue = {
    enqueue: async (channelId, message) => {
      await options.queue.add(
        ALERT_DELIVERY_JOB,
        {
          id: deliveryId(),
          channelId,
          message,
          attempts: 0,
          queuedAt: options.now(),
        },
        {
          attempts: ALERT_RETRY.attempts,
          backoff: {
            type: "exponential",
            delay: ALERT_RETRY.firstDelayMs,
            max: ALERT_RETRY.maxDelayMs,
            jitter: 0.5,
          },
          ...(options.deadLetter === undefined
            ? {}
            : { deadLetter: options.deadLetter }),
        },
      );
      sent += 1;
    },
    // bun-jobs keeps them: its dead-letter queue, or its dead jobs.
    deadLetters: () => [],
    replay: async () => false,
    stats: () => ({ pending: 0, sent, failures: 0, dead: 0, dropped: 0 }),
    close: () => {},
  };
  return Object.freeze(queue);
}
