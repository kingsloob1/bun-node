import type { DriverEvent, JobsDriver } from "./drivers/index";
import type { EventKind } from "./shared/events";
import { TypedEmitterBase } from "./shared/emitter";
import { assertNamespace, assertSegment } from "./shared/keys";

/**
 * One stream of every event in a namespace: each queue's and each runner's,
 * from whichever process published it.
 *
 * A driver's `subscribe` listens to one queue or one runner at a time, which
 * is what a `BunQueue` needs and nothing like what a dashboard needs. This
 * subscribes to all of them — or the ones named — and keeps looking, so a
 * queue first used after the notifier started is picked up within
 * `discoveryInterval`. Events arrive typed as the driver delivers them: a
 * `switch` on `event.kind`, then `event.type`, narrows the payload.
 *
 * It hears only what is published. Producers, workers and runners publish
 * when asked to (`publish: true`, or `publishEvents` on their `BunJobs`).
 *
 * **Discovery has a gap, by nature.** A queue another process starts using is
 * found on the next discovery pass, and anything it published before then is
 * not heard. To be sure of every event from the start, name the queues and
 * runners (`queues: ["mail"]`) or `follow()` them before they are used — a
 * subscription does not need the queue to exist yet. Queues, workers and
 * runners created by the same `BunJobs` as the notifier are followed the
 * moment they are created, so they have no gap.
 */

/** Which queues and runners to listen to, and how. */
export interface JobsNotifierOptions {
  /** `"all"` (the default) follows every queue in the namespace; a list, just those. */
  queues?: "all" | string[];
  /** `"all"` (the default) follows every runner in the namespace; a list, just those. */
  runners?: "all" | string[];
  /**
   * Which queues' **worker** events to follow — a worker pausing, stopping or
   * adopting a configuration override — by queue name, since that is the
   * channel workers of a queue share.
   *
   * Defaults to `[]`: none. Unlike queues and runners this is opt-in, because
   * it is a second subscription per queue, and on a driver that polls
   * (`capabilities.events === "poll"`) a second query every few dozen
   * milliseconds per queue — a cost nobody who is not watching workers should
   * pay. `"all"` follows every queue's, and `hold("worker", queue)` follows
   * one for as long as something is watching it.
   */
  workers?: "all" | string[];
  /**
   * How often to look for queues and runners that appeared since the last
   * look, in milliseconds. Defaults to `2000`. Only meaningful with `"all"`.
   */
  discoveryInterval?: number;
  /**
   * How many events an async iterator holds for a consumer that has fallen
   * behind before it drops the oldest. Defaults to `10000`; `dropped` counts
   * what was lost.
   */
  bufferSize?: number;
}

/**
 * How a target came to be followed for good: found by a discovery pass (or in
 * the configured lists it follows), or named to `follow()`.
 */
export type NotifierFollowSource = "discovery" | "follow";

/** What a {@link JobsNotifier} emits. */
// eslint-disable-next-line ts/consistent-type-definitions
export type JobsNotifierEvents = {
  /** An event, from any queue or runner being followed. */
  event: (event: DriverEvent) => void;
  /** A queue or runner started being followed. */
  subscribed: (kind: EventKind, target: string) => void;
  /**
   * A target became followed **for good** — by discovery, the configured
   * lists, a `BunJobs` creating it, or `follow()` — never by a `hold()`.
   * Emitted once per target, before its subscription is live. For a queue, a
   * `hold("worker", queue)` a listener starts here is live before the queue's
   * own follow resolves, which is how the management API's broad `workers`
   * channel picks up a new queue without missing its first worker event.
   *
   * `source` says how: `"discovery"` for a discovery pass (or the configured
   * lists it follows), `"follow"` for `follow()` — which is what a `BunJobs`
   * calls for a queue or runner it creates, before anything is published on
   * it. A discovered target may already have published events nobody heard.
   */
  followed: (
    kind: EventKind,
    target: string,
    source: NotifierFollowSource,
  ) => void;
  /** Something failed while subscribing or discovering. */
  error: (error: Error, context: string) => void;
};

/** A reply waiting for the next event. */
type Waiter = (result: IteratorResult<DriverEvent>) => void;

export class JobsNotifier
  extends TypedEmitterBase<JobsNotifierEvents>
  implements AsyncIterable<DriverEvent>
{
  /** The namespace being followed. */
  readonly namespace: string;
  /** How many buffered events were dropped because a consumer fell behind. */
  dropped = 0;

  /** The driver events come from. */
  readonly #driver: JobsDriver;
  /** Which queues to follow. */
  readonly #queues: "all" | string[];
  /** Which runners to follow. */
  readonly #runners: "all" | string[];
  /** Which queues' worker events to follow. */
  readonly #workers: "all" | string[];
  /** How often to discover new queues and runners. */
  readonly #discoveryInterval: number;
  /** The most events an iterator buffers. */
  readonly #bufferSize: number;
  /** Unsubscribe functions of live subscriptions, by `<kind>:<target>`. */
  readonly #subscriptions = new Map<string, () => Promise<void>>();
  /** Subscribes in flight, by key: a concurrent follower awaits the same one. */
  readonly #inflight = new Map<string, Promise<void>>();
  /** Keys followed for good: by discovery, the configured lists, or `follow()`. */
  readonly #permanent = new Set<string>();
  /** Keys followed only while held, with how many holders each has (`hold()`). */
  readonly #held = new Map<string, number>();
  /** Events waiting for an iterator to take them. */
  readonly #buffer: DriverEvent[] = [];
  /** Iterators waiting for an event. */
  readonly #waiters: Waiter[] = [];
  /** How many iterators are open; events are buffered only while one is. */
  #iterators = 0;
  /** The discovery timer. */
  #timer: ReturnType<typeof setInterval> | undefined;
  /** Whether `close()` has been called. */
  #closed = false;

  constructor(
    /** The driver to subscribe through. */
    driver: JobsDriver,
    /** The namespace to follow. */
    namespace: string,
    /** Which queues and runners, and how. */
    options: JobsNotifierOptions = {},
  ) {
    super();
    this.#driver = driver;
    this.namespace = assertNamespace(namespace);
    this.#queues = validateTargets(options.queues ?? "all", "queue name");
    this.#runners = validateTargets(options.runners ?? "all", "runner id");
    this.#workers = validateTargets(options.workers ?? [], "queue name");
    this.#discoveryInterval = Math.max(10, options.discoveryInterval ?? 2_000);
    this.#bufferSize = Math.max(1, options.bufferSize ?? 10_000);
  }

  /** The queues and runners currently followed, as `<kind>:<target>`. */
  get following(): string[] {
    return [...this.#subscriptions.keys()].sort();
  }

  /**
   * The targets of one kind followed for good — by discovery, the configured
   * lists, a `BunJobs` creating them, or `follow()` — whether or not their
   * subscription is live yet. A `hold()` alone does not count.
   */
  followedForGood(kind: EventKind): string[] {
    const prefix = `${kind}:`;
    return [...this.#permanent]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  }

  /**
   * Subscribes to everything that matches now, and starts looking for what
   * appears later. Resolves once the first round of subscriptions is in place.
   */
  async start(): Promise<void> {
    await this.#driver.connect();
    await this.#discover();

    if (
      !this.#closed &&
      !this.#timer &&
      (this.#queues === "all" ||
        this.#runners === "all" ||
        this.#workers === "all")
    ) {
      this.#timer = setInterval(() => {
        void this.#discover().catch((error: unknown) => {
          this.#emitError(error, "discover");
        });
      }, this.#discoveryInterval);
      this.#timer.unref?.();
    }
  }

  /** Stops listening, and ends any iterator waiting for an event. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    clearInterval(this.#timer);
    this.#timer = undefined;

    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }

    const unsubscribes = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    this.#held.clear();
    await Promise.allSettled(unsubscribes.map((unsubscribe) => unsubscribe()));
  }

  /**
   * Events as an async iterator, from the moment it is opened.
   *
   * A consumer slower than the events buffers up to `bufferSize` of them, then
   * loses the oldest; `dropped` says how many. Several iterators open at once
   * share one buffer, so each event reaches one of them — iterate once, and
   * fan out from there.
   */
  [Symbol.asyncIterator](): AsyncIterator<DriverEvent> {
    this.#iterators++;
    let finished = false;

    const finish = (): IteratorResult<DriverEvent> => {
      if (!finished) {
        finished = true;
        this.#iterators--;
      }
      return { value: undefined, done: true };
    };

    return {
      next: async () => {
        if (finished) {
          return { value: undefined, done: true };
        }

        const buffered = this.#buffer.shift();
        if (buffered) {
          return { value: buffered, done: false };
        }

        if (this.#closed) {
          return finish();
        }

        return await new Promise<IteratorResult<DriverEvent>>((resolve) => {
          this.#waiters.push((result) => {
            resolve(result.done ? finish() : result);
          });
        });
      },
      return: async () => finish(),
    };
  }

  /** Subscribes to every queue and runner that matches and is not yet followed. */
  async #discover(): Promise<void> {
    if (this.#closed) {
      return;
    }

    const needsQueueNames = this.#queues === "all" || this.#workers === "all";
    const [queueNames, runners] = await Promise.all([
      needsQueueNames ? this.#driver.listQueues(this.namespace) : [],
      this.#runners === "all"
        ? this.#driver.listRunners(this.namespace)
        : this.#runners,
    ]);
    const queues = this.#queues === "all" ? queueNames : this.#queues;
    const workers = this.#workers === "all" ? queueNames : this.#workers;

    await Promise.all([
      ...queues.map(
        async (queue) => await this.#follow("queue", queue, "discovery"),
      ),
      ...runners.map(
        async (runner) => await this.#follow("runner", runner, "discovery"),
      ),
      ...workers.map(
        async (queue) => await this.#follow("worker", queue, "discovery"),
      ),
    ]);
  }

  /**
   * Whether this notifier is meant to follow that target of that kind — a
   * queue's jobs, a runner's runs, or a queue's workers.
   */
  wants(kind: EventKind, target: string): boolean {
    const targets = this.#targetsOf(kind);
    return targets === "all" || targets.includes(target);
  }

  /** The configured target list for one kind. */
  #targetsOf(kind: EventKind): "all" | string[] {
    switch (kind) {
      case "queue":
        return this.#queues;
      case "worker":
        return this.#workers;
      default:
        return this.#runners;
    }
  }

  /**
   * Starts following one queue or runner now, whether or not it exists yet —
   * so nothing it publishes from its first use is missed — and for good.
   * Following something already followed does nothing; resolves once the
   * subscription is live, even when another follow started it.
   */
  async follow(kind: EventKind, target: string): Promise<void> {
    await this.#follow(
      kind,
      assertSegment(target, targetLabel(kind)),
      "follow",
    );
  }

  /**
   * Follows one queue or runner for as long as it is held: like
   * {@link JobsNotifier.follow}, but reference-counted, and dropped by the
   * last matching {@link JobsNotifier.unfollow} unless something follows it
   * for good (discovery, the configured lists, or `follow()`). For followers
   * whose names come from outside — a live-events subscription may name a
   * queue that does not exist yet, or never will.
   */
  async hold(kind: EventKind, target: string): Promise<void> {
    await this.#follow(kind, assertSegment(target, targetLabel(kind)), "hold");
  }

  /**
   * Releases one {@link JobsNotifier.hold}. When the last holder lets go and
   * nothing follows the target for good, its subscription is closed. Releasing
   * something not held does nothing.
   */
  async unfollow(kind: EventKind, target: string): Promise<void> {
    const key = `${kind}:${target}`;
    const holders = this.#held.get(key);
    if (holders === undefined) {
      return;
    }
    if (holders > 1) {
      this.#held.set(key, holders - 1);
      return;
    }
    this.#held.delete(key);
    // A subscribe in flight checks again once it lands, and drops itself.
    await this.#inflight.get(key);
    if (!this.#wanted(key)) {
      await this.#drop(key);
    }
  }

  /** Whether a key is still followed for good or held. */
  #wanted(key: string): boolean {
    return this.#permanent.has(key) || this.#held.has(key);
  }

  /** Closes one live subscription. */
  async #drop(key: string): Promise<void> {
    const unsubscribe = this.#subscriptions.get(key);
    if (!unsubscribe) {
      return;
    }
    this.#subscriptions.delete(key);
    try {
      await unsubscribe();
    } catch (error) {
      this.#emitError(error, `unsubscribe ${key}`);
    }
  }

  /**
   * Follows one queue or runner — for good (`how` is the source: discovery or
   * `follow()`) or as one more holder — and subscribes once.
   */
  async #follow(
    kind: EventKind,
    target: string,
    how: NotifierFollowSource | "hold",
  ): Promise<void> {
    const key = `${kind}:${target}`;

    if (this.#closed) {
      return;
    }
    const becamePermanent = how !== "hold" && !this.#permanent.has(key);
    if (how === "hold") {
      this.#held.set(key, (this.#held.get(key) ?? 0) + 1);
    } else {
      this.#permanent.add(key);
    }
    if (becamePermanent) {
      this.safeEmit("followed", kind, target, how);
    }

    if (!this.#subscriptions.has(key)) {
      // One subscribe per key, shared: two overlapping discovery passes cannot
      // both subscribe and deliver every event twice, and a follower joining
      // one in flight waits until it is live rather than resolving early.
      let inflight = this.#inflight.get(key);
      if (!inflight) {
        inflight = this.#subscribe(kind, target, key).finally(() => {
          this.#inflight.delete(key);
        });
        this.#inflight.set(key, inflight);
      }
      await inflight;
    }

    // A worker hold a `followed` listener started for this queue is live
    // before the queue's follow resolves: a `BunJobs` gates its first publish
    // on that follow, so the worker's first `state` event is heard.
    if (becamePermanent && kind === "queue") {
      await this.#inflight.get(`worker:${target}`);
    }
  }

  /** Subscribes to one queue or runner through the driver. Never rejects. */
  async #subscribe(
    kind: EventKind,
    target: string,
    key: string,
  ): Promise<void> {
    try {
      const unsubscribe = await this.#driver.subscribe(
        this.namespace,
        kind,
        target,
        (event) => this.#deliver(event),
      );

      if (this.#closed) {
        await unsubscribe();
        return;
      }

      this.#subscriptions.set(key, unsubscribe);
      // Its last holder let go while it was subscribing.
      if (!this.#wanted(key)) {
        await this.#drop(key);
        return;
      }
      this.safeEmit("subscribed", kind, target);
    } catch (error) {
      this.#emitError(error, `subscribe ${key}`);
    }
  }

  /** Hands an event to listeners, and to an iterator if one is open. */
  #deliver(event: DriverEvent): void {
    if (this.#closed) {
      return;
    }

    this.safeEmit("event", event);

    if (this.#iterators === 0) {
      return;
    }

    const waiter = this.#waiters.shift();

    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }

    this.#buffer.push(event);

    if (this.#buffer.length > this.#bufferSize) {
      this.#buffer.shift();
      this.dropped++;
    }
  }

  /** Reports a failure, which must not stop the stream. */
  #emitError(error: unknown, context: string): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.safeEmit("error", failure, context);
  }
}

/** A target list, validated, or `"all"`. */
function validateTargets(
  targets: "all" | string[],
  what: string,
): "all" | string[] {
  return targets === "all"
    ? "all"
    : targets.map((target) => assertSegment(target, what));
}

/** What a target of this kind is called, for a validation message. */
function targetLabel(kind: EventKind): string {
  return kind === "runner" ? "runner id" : "queue name";
}
