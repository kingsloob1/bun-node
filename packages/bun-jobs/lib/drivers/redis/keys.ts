import type { QueueRef } from "../driver";

/**
 * How the Redis driver names things.
 *
 * Two rules shape every key. The namespace comes first, after a library-level
 * prefix, so one service's keys are a `SCAN` away and another's are never
 * touched. And in cluster mode a queue's keys carry a hash tag, because a Lua
 * script may only touch keys in one slot — without the tag, a script that
 * moves a job from the wait set to the active set would be rejected.
 */

/** Builds the keys for one namespace. */
export class RedisKeys {
  /** Library-level prefix, ahead of the namespace. */
  readonly prefix: string;
  /** Whether keys are grouped into one slot per queue. */
  readonly cluster: boolean;

  constructor(options: {
    /** Library-level prefix. Defaults to `bun-jobs`. */
    prefix?: string;
    /** Whether the server is a cluster. */
    cluster?: boolean;
  }) {
    this.prefix = options.prefix ?? "bun-jobs";
    this.cluster = options.cluster ?? false;
  }

  /** Everything under one namespace, for `purge`. */
  namespace(ns: string): string {
    return `${this.prefix}:${ns}`;
  }

  /** The set of runner ids known in a namespace. */
  runners(ns: string): string {
    return `${this.namespace(ns)}:runners`;
  }

  /** The set of queue names known in a namespace. */
  queues(ns: string): string {
    return `${this.namespace(ns)}:queues`;
  }

  /**
   * A runner's keys. Grouped by a hash tag in cluster mode for the same
   * reason a queue's are: its scripts touch several at once.
   */
  runner(
    ns: string,
    id: string,
  ): {
    lock: string;
    state: string;
    history: string;
    queued: string;
  } {
    const base = `${this.namespace(ns)}:r:${this.#tag(id)}`;

    return {
      lock: `${base}:lock`,
      state: `${base}:state`,
      history: `${base}:history`,
      queued: `${base}:queued`,
    };
  }

  /** A queue's keys, all in one slot. */
  queue(q: QueueRef): {
    wait: string;
    delayed: string;
    failed: string;
    active: string;
    completed: string;
    dead: string;
    meta: string;
    seq: string;
    wake: string;
    repeats: string;
    jobPrefix: string;
    logPrefix: string;
  } {
    const base = `${this.namespace(q.ns)}:q:${this.#tag(q.queue)}`;

    return {
      wait: `${base}:wait`,
      delayed: `${base}:delayed`,
      failed: `${base}:failed`,
      active: `${base}:active`,
      completed: `${base}:completed`,
      dead: `${base}:dead`,
      meta: `${base}:meta`,
      seq: `${base}:seq`,
      wake: `${base}:wake`,
      repeats: `${base}:repeat`,
      jobPrefix: `${base}:job:`,
      // A sibling of `job:`, not a suffix on the job's key: ids are arbitrary
      // strings, so `<job>:logs` would be the hash key of a job whose id ends
      // in `:logs`. The queue scripts derive this from `jobPrefix` — see
      // `logs(id)` in `scripts.ts` — so the two must keep this shape.
      logPrefix: `${base}:log:`,
    };
  }

  /** The channel events for one target are published on. */
  channel(ns: string, kind: "queue" | "runner", target: string): string {
    return `${this.namespace(ns)}:ev:${kind === "queue" ? "q" : "r"}:${target}`;
  }

  /**
   * The keys a queue script receives, in the order `scripts.ts` reads them.
   * The two have to agree, so they are written down in one place each.
   */
  queueScriptKeys(q: QueueRef): string[] {
    const keys = this.queue(q);

    return [
      keys.wait,
      keys.delayed,
      keys.failed,
      keys.active,
      keys.completed,
      keys.dead,
      keys.meta,
      keys.seq,
      keys.wake,
      this.queues(q.ns),
    ];
  }

  /** Wraps a name in a hash tag when the server is a cluster. */
  #tag(name: string): string {
    return this.cluster ? `{${name}}` : name;
  }
}
