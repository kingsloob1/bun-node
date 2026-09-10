import type { SQL } from "bun";
import type { QueueRef } from "../driver";

/**
 * Being told a job arrived, instead of asking.
 *
 * Without a push channel a worker only notices new work by polling, so the poll
 * interval sets the tail of its round-trip latency: a job landing just after a
 * check waits out the whole interval. Backing the interval off narrows that,
 * but it cannot remove it — measured on Postgres, p99 stayed at 4ms against a
 * 2.9ms median, and pg-boss and graphile-worker are both faster on that column
 * precisely because they use `LISTEN`/`NOTIFY`.
 *
 * Postgres can do the same, so it does. One `LISTEN` per queue is shared by
 * everyone waiting on it, and the `NOTIFY` rides inside the insert rather than
 * following it, so a producer pays nothing for a consumer that may not exist.
 *
 * Polling stays underneath as the correctness floor. A notification is an
 * optimisation, never the only path: it can be missed while a listener is
 * reconnecting, and a job promoted by another process's maintenance sweep is
 * not announced at all.
 */

/** Everyone waiting on one channel, and the registration behind them. */
interface Channel {
  /** Called once each when the channel fires. */
  readonly waiters: Set<() => void>;
  /** The live registration, once it has been established. */
  subscription?: { unlisten: () => Promise<void> };
  /** Resolves when the registration is in place, so callers can await it. */
  ready: Promise<void>;
}

/** Per-queue arrival notifications over Postgres `LISTEN`/`NOTIFY`. */
export class Arrivals {
  /** The connection registrations are made on. */
  readonly #sql: SQL;
  /** Channels this driver is listening on, by name. */
  readonly #channels = new Map<string, Channel>();
  /** Whether the engine can push at all. */
  readonly #enabled: boolean;

  constructor(
    /** The driver's connection. */
    sql: SQL,
    /** Whether the dialect supports `LISTEN`; everything is inert when false. */
    enabled: boolean,
  ) {
    this.#sql = sql;
    this.#enabled = enabled;
  }

  /**
   * The channel a queue's arrivals are announced on.
   *
   * Hashed rather than concatenated: a channel name is an identifier, capped at
   * 63 bytes, and a namespace and queue name together can exceed that. The
   * hash is of both, so two queues cannot share a channel.
   */
  channel(q: QueueRef): string {
    return `bunjobs_${Bun.hash(`${q.ns}:${q.queue}`).toString(36)}`;
  }

  /**
   * Waits for an arrival on `q`, or resolves `false` when `timeoutMs` passes
   * first. Resolves `false` immediately when the engine cannot push.
   */
  async wait(
    q: QueueRef,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.#enabled || timeoutMs <= 0 || signal?.aborted) {
      return false;
    }

    const channel = await this.#listen(this.channel(q));

    if (!channel) {
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      /** Runs once, whichever of the three outcomes happens first. */
      const settle = (arrived: boolean) => {
        clearTimeout(timer);
        channel.waiters.delete(notify);
        signal?.removeEventListener("abort", abort);
        resolve(arrived);
      };

      const notify = () => settle(true);
      const abort = () => settle(false);
      const timer = setTimeout(settle, timeoutMs, false);
      timer.unref?.();

      channel.waiters.add(notify);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** Drops every registration, for a driver that is closing. */
  async close(): Promise<void> {
    const channels = [...this.#channels.values()];
    this.#channels.clear();

    for (const channel of channels) {
      for (const waiter of channel.waiters) waiter();
      channel.waiters.clear();
      await channel.subscription?.unlisten().catch(() => undefined);
    }
  }

  /**
   * The registration for one channel, made once and shared.
   *
   * A failure here is not fatal: the caller falls back to polling, which is
   * what every other engine does all the time.
   */
  async #listen(name: string): Promise<Channel | null> {
    const existing = this.#channels.get(name);

    if (existing) {
      await existing.ready;
      return existing.subscription ? existing : null;
    }

    const channel: Channel = { waiters: new Set(), ready: Promise.resolve() };

    channel.ready = (async () => {
      try {
        channel.subscription = await this.#sql.listen(name, () => {
          // Copied first: a waiter removes itself as it runs.
          for (const waiter of [...channel.waiters]) waiter();
        });
      } catch {
        this.#channels.delete(name);
      }
    })();

    this.#channels.set(name, channel);
    await channel.ready;

    return channel.subscription ? channel : null;
  }
}
