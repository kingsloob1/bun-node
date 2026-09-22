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
  /**
   * How many notifications the channel has received since it was registered.
   * Compared against a {@link Arrivals.mark} to tell whether one landed while
   * nobody was waiting.
   */
  epoch: number;
  /** The live registration, once it has been established. */
  subscription?: { unlisten: () => Promise<void> };
  /** Resolves when the registration is in place, so callers can await it. */
  ready: Promise<void>;
}

/**
 * What {@link Arrivals.take} found for a queue: a notification landed since the
 * mark (`"moved"`), none did (`"quiet"`), or there was no mark to judge by
 * (`"none"`) and the caller cannot rule one out.
 */
export type ArrivalMark = "moved" | "quiet" | "none";

/** Per-queue arrival notifications over Postgres `LISTEN`/`NOTIFY`. */
export class Arrivals {
  /** The connection registrations are made on. */
  readonly #sql: SQL;
  /** Channels this driver is listening on, by name. */
  readonly #channels = new Map<string, Channel>();
  /** Whether the engine can push at all. */
  readonly #enabled: boolean;
  /**
   * Each channel's epoch when a claim on its queue began, by channel name —
   * the earliest one not yet taken by a wait, so a claim that starts later
   * cannot hide a notification an earlier claimer has not seen.
   */
  readonly #marks = new Map<string, number>();

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
   * Records where `q`'s channel stands, as a claim on the queue begins.
   *
   * A notification is only delivered to someone already waiting, and a worker
   * starts waiting only after its claim came back empty — and after the
   * promotion and next-due reads that follow it. A job committed in between
   * announced itself to nobody, and only the wait's opening poll could still
   * find it. With the epoch recorded here, {@link take} can tell whether
   * anything landed since, and the wait then ends at once, without a
   * statement.
   *
   * The earliest untaken mark is kept: several workers on one driver share a
   * channel, and a later claim must not hide a notification an earlier one
   * missed. A channel not listening yet is started, and records nothing.
   */
  mark(q: QueueRef): void {
    if (!this.#enabled) {
      return;
    }

    const name = this.channel(q);
    const channel = this.#channels.get(name);

    if (!channel?.subscription) {
      if (!channel) {
        void this.#listen(name);
      }
      return;
    }

    if (!this.#marks.has(name)) {
      this.#marks.set(name, channel.epoch);
    }
  }

  /**
   * Forgets `q`'s mark, for a claim that took a job: that worker is not about
   * to wait. Another claimer that marked the same channel then finds no mark,
   * and polls as it would have without one.
   */
  unmark(q: QueueRef): void {
    this.#marks.delete(this.channel(q));
  }

  /**
   * Takes `q`'s mark, answering whether a notification landed since it was
   * made. The mark is gone afterwards: it describes one claim.
   */
  take(q: QueueRef): { state: ArrivalMark; since?: number } {
    const name = this.channel(q);
    const since = this.#marks.get(name);
    const channel = this.#channels.get(name);

    if (since === undefined || !channel?.subscription) {
      return { state: "none" };
    }

    this.#marks.delete(name);
    return channel.epoch === since
      ? { state: "quiet", since }
      : { state: "moved", since };
  }

  /**
   * Waits for an arrival on `q`, or resolves `false` when `timeoutMs` passes
   * first. Resolves `false` immediately when the engine cannot push.
   *
   * With `since` — an epoch from {@link take} — it resolves `true` at once if
   * the channel has moved past it by the time the waiter is in place, so a
   * notification landing while the registration was being awaited is not
   * lost either.
   */
  async wait(
    q: QueueRef,
    timeoutMs: number,
    signal?: AbortSignal,
    since?: number,
  ): Promise<boolean> {
    if (!this.#enabled || timeoutMs <= 0 || signal?.aborted) {
      return false;
    }

    const listening = await this.#listen(this.channel(q));

    if (!listening) {
      return false;
    }

    // Bound to a const the closures below can see: they are hoisted function
    // declarations, which lose the narrowing the check above established.
    const channel = listening;

    if (since !== undefined && channel.epoch !== since) {
      return true;
    }

    return await new Promise<boolean>((resolve) => {
      /**
       * The three ways this wait can end — a notification, the timeout, or an
       * abort — each of which has to undo the other two. Declared as functions
       * so they can refer to each other and to the timer below.
       */
      /** The timeout, declared ahead of the handlers that clear it. */
      let timer: ReturnType<typeof setTimeout> | undefined;

      function settle(arrived: boolean): void {
        clearTimeout(timer);
        channel.waiters.delete(notify);
        signal?.removeEventListener("abort", abort);
        resolve(arrived);
      }

      function notify(): void {
        settle(true);
      }

      function abort(): void {
        settle(false);
      }

      timer = setTimeout(settle, timeoutMs, false);
      timer.unref?.();

      channel.waiters.add(notify);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /** Drops every registration, for a driver that is closing. */
  async close(): Promise<void> {
    const channels = [...this.#channels.values()];
    this.#channels.clear();
    this.#marks.clear();

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

    const channel: Channel = {
      waiters: new Set(),
      epoch: 0,
      ready: Promise.resolve(),
    };

    channel.ready = (async () => {
      try {
        channel.subscription = await this.#sql.listen(name, () => {
          channel.epoch++;
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
