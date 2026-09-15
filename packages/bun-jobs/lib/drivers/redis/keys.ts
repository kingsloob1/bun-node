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
    children: string;
    meta: string;
    excludeCursors: string;
    seq: string;
    wake: string;
    repeats: string;
    jobPrefix: string;
    logPrefix: string;
    statePrefix: string;
    stateNames: string;
    workers: string;
    workersExpiry: string;
    throughputPrefix: string;
  } {
    const base = `${this.namespace(q.ns)}:q:${this.#tag(q.queue)}`;

    return {
      wait: `${base}:wait`,
      delayed: `${base}:delayed`,
      failed: `${base}:failed`,
      active: `${base}:active`,
      completed: `${base}:completed`,
      dead: `${base}:dead`,
      // Parents in a flow still waiting on children, scored by `createdAt`.
      // A set of its own rather than a flag on the wait set, so no claim, and
      // no promotion sweep, can ever reach one.
      children: `${base}:children`,
      meta: `${base}:meta`,
      // Where a claim that excludes names resumes its scan, one hash field per
      // exclusion set. A sibling of `meta`, not passed to scripts as a key:
      // the claim scripts derive it from `meta` — see `excludeCursors()` in
      // `scripts.ts` — so the two must keep this shape.
      excludeCursors: `${base}:exclude`,
      seq: `${base}:seq`,
      wake: `${base}:wake`,
      repeats: `${base}:repeat`,
      jobPrefix: `${base}:job:`,
      // A sibling of `job:`, not a suffix on the job's key: ids are arbitrary
      // strings, so `<job>:logs` would be the hash key of a job whose id ends
      // in `:logs`. The queue scripts derive this from `jobPrefix` — see
      // `logs(id)` in `scripts.ts` — so the two must keep this shape.
      logPrefix: `${base}:log:`,
      // One hash per named value, `version` and `value`, for `setQueueState`.
      // Under the queue's base, so it shares the queue's slot and a purge of
      // the namespace sweeps it with everything else.
      statePrefix: `${base}:state:`,
      // Every state entry's name, in a sorted set at score 0 so members order
      // by their bytes and `listQueueState` is a `ZRANGE BYLEX` rather than a
      // keyspace `SCAN`. `state-names`, not `state:names`: under `statePrefix`
      // it would be the hash of an entry called `names`. Kept in step by
      // `SET_QUEUE_STATE`, in the same script as the write. Entries written
      // before this key existed are not in it; queue state has not shipped in
      // a release, so there is nothing to migrate.
      stateNames: `${base}:state-names`,
      // Worker heartbeat records: field = worker id, value = the record as
      // JSON. Kept in step with `workersExpiry` by the worker scripts, and both
      // expire at the latest record's `expiresAt`, so an abandoned queue's
      // registry disappears on its own.
      workers: `${base}:workers`,
      // Each worker's `expiresAt`, member = worker id, so lapsed records are a
      // `ZRANGEBYSCORE` away rather than a decode of every record.
      workersExpiry: `${base}:workers-exp`,
      // One hash per minute, `<prefix><minute start>`, fields `completed` and
      // `failed`. A sibling of `job:`, not passed to scripts as a key: COMPLETE
      // and FAIL derive it from `jobPrefix` — see `THROUGHPUT_COUNT` in
      // `scripts.ts` — so the two must keep this shape. Each minute expires
      // `THROUGHPUT_RETENTION_MS` after it ends.
      throughputPrefix: `${base}:tp:`,
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
      // Appended rather than placed beside `dead`, so every index the
      // scripts already read stays where it was.
      keys.children,
    ];
  }

  /** Wraps a name in a hash tag when the server is a cluster. */
  #tag(name: string): string {
    return this.cluster ? `{${name}}` : name;
  }
}
