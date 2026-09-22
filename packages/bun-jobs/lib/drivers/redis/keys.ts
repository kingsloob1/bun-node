import type { EventKind } from "../../shared/events";
import type { QueueRef } from "../driver";
import { MINUTE_BUCKET_MS } from "../../api/contract/constants";

/** The letter each event kind's channel is named with. */
const CHANNEL_KINDS: Readonly<Record<EventKind, string>> = Object.freeze({
  queue: "q",
  runner: "r",
  worker: "w",
});

/**
 * The analytics series a metrics hash may hold, as the letter pair its keys
 * carry. One code per series, never derived from a runtime string, so a key
 * cannot be built for a series nothing reads.
 */
export type MetricsSeries =
  /** A queue's, or the namespace's, completed/failed counts. */
  | "jobs"
  /** One worker's, or the namespace's, completed/failed counts. */
  | "wjobs"
  /** One worker's busyness samples. */
  | "wbusy"
  /** One runner's runs by outcome, or the namespace's. */
  | "runs"
  /** One runner's run durations and their histogram. */
  | "rdur";

/**
 * How many buckets one metrics hash holds.
 *
 * **The load-bearing number of this layout.** A key per second would be ~19,500
 * keys in a mid-sized namespace and a 60-`HMGET` walk to read a minute; sixty
 * second-fields in one hash per minute is ~305 keys and two `HGETALL`s. The
 * same grouping applies one width up: sixty minute-fields in one hash per hour,
 * so a day of minutes is 24 keys rather than 1,440.
 */
export const METRICS_GROUP_SIZE = 60;

/**
 * How long one metrics hash covers, for a bucket width in ms.
 *
 * A width this does not name has no layout, and every caller must have
 * resolved to one the driver reported in its `MetricsSupport` first.
 */
export function metricsGroupSpan(interval: number): number {
  return interval * METRICS_GROUP_SIZE;
}

/** The start of the hash `at` falls in, for buckets `interval` wide. */
export function metricsGroupStart(at: number, interval: number): number {
  const span = metricsGroupSpan(interval);
  return Math.floor(at / span) * span;
}

/** Which of the sixty buckets in its hash `at` is, for buckets `interval` wide. */
export function metricsGroupOffset(at: number, interval: number): number {
  return Math.floor((at - metricsGroupStart(at, interval)) / interval);
}

/**
 * The field one bucket's counter or statistic is stored in: the bucket's
 * offset in its hash, then the name.
 *
 * Offset first so every field of one bucket sorts together and a field name
 * containing a `:` — which a statistic's never does, but a future one might —
 * cannot be read as another offset.
 */
export function metricsField(offset: number, name: string): string {
  return `${offset}:${name}`;
}

/**
 * Splits a field back into its bucket offset and name, or `null` when it is
 * not one of ours — a hash is read with `HGETALL`, so anything else in it is
 * skipped rather than guessed at.
 */
export function parseMetricsField(
  field: string,
): { offset: number; name: string } | null {
  const cut = field.indexOf(":");

  if (cut <= 0) {
    return null;
  }

  const offset = Number(field.slice(0, cut));

  if (!Number.isInteger(offset) || offset < 0 || offset >= METRICS_GROUP_SIZE) {
    return null;
  }

  return { offset, name: field.slice(cut + 1) };
}

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

  /**
   * Where the namespace's own roll-up buckets live.
   *
   * **Deliberately outside every queue's and runner's hash tag**, and the one
   * fact that shapes how the roll-up is written. A namespace key and a queue
   * key are in different slots in Cluster, so no script may touch both — which
   * is why the queue counts its own inside `COMPLETE`/`FAIL` while the
   * namespace's copy is a buffered write from the driver, up to a second
   * behind. It carries no tag of its own either: every read and write of one is
   * a single-key operation, so there is nothing for a tag to group.
   */
  namespaceMetrics(ns: string): string {
    return `${this.namespace(ns)}:mx:`;
  }

  /**
   * Which entities of one kind have recorded analytics in a namespace: a
   * sorted set, member = the entity, score = the latest instant it may have
   * recorded anything at.
   *
   * **What lets a grouped read find every runner or worker without being told
   * their names.** Redis cannot list keys cheaply — `KEYS` blocks the server
   * and a keyspace `SCAN` per request is the very cost the grouped read exists
   * to remove — so the writes that create an entity's hashes name it here as
   * well, and the read starts from `ZRANGE … BYSCORE <from> +inf`.
   *
   * Outside every hash tag, like the roll-up beside it and for the same
   * reason: it spans every queue and runner of the namespace, so no one tag
   * could hold it. Every operation on it is a single-key one, so it needs none
   * of its own. `ix:` cannot collide with a series hash under the same prefix:
   * a series is a fixed code (`MetricsSeries`), and none of them is `ix`.
   */
  metricsIndex(
    ns: string,
    /** Which entities: runners, or worker keys. */
    kind: "runners" | "workers",
  ): string {
    return `${this.namespaceMetrics(ns)}ix:${kind}`;
  }

  /**
   * One metrics hash: sixty buckets of one series, under the prefix of
   * whatever owns them.
   *
   * `<prefix>mx:<series>:<s|m>:<group start>[:<entity>]` — the width's letter
   * is there because a second's hash and a minute's hash of the same series
   * would otherwise share a name whenever an hour starts on a minute, and the
   * entity is **last** because a worker key is not a validated key segment and
   * may hold anything, including a `:`. Everything before it is fixed-shape, so
   * the key is unambiguous however the key is spelled.
   */
  metricsKey(
    /** The owner's metrics prefix: a queue's, a runner's, or the namespace's. */
    prefix: string,
    /** Which series. */
    series: MetricsSeries,
    /** The bucket width, ms. */
    interval: number,
    /** Any instant inside the hash; floored to the hash's start. */
    at: number,
    /** The worker key, for the two per-worker series. Omitted otherwise. */
    entity?: string,
  ): string {
    const width = interval === MINUTE_BUCKET_MS ? "m" : "s";
    const group = metricsGroupStart(at, interval);
    const base = `${prefix}${series}:${width}:${group}`;

    return entity === undefined ? base : `${base}:${entity}`;
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
    runLogs: string;
    runLogPrefix: string;
    runLinePrefix: string;
    metricsPrefix: string;
  } {
    const base = `${this.namespace(ns)}:r:${this.#tag(id)}`;

    return {
      lock: `${base}:lock`,
      state: `${base}:state`,
      history: `${base}:history`,
      queued: `${base}:queued`,
      // Which runs have a log, in the order they first wrote one, so
      // `keepRuns` knows which is oldest without reading every log.
      runLogs: `${base}:runlogs`,
      // One hash per run, holding what the lines cannot say for themselves:
      // how many were dropped, and how many bytes are left. Deliberately not
      // fields on `state` — they would show up in `getState()`, and a captured
      // line must not write the runner's state document at all.
      runLogPrefix: `${base}:runlog:`,
      // A sibling of `runlog:`, not a suffix on it: run ids are arbitrary
      // strings, so `<run>:lines` would be the meta key of a run whose id ends
      // in `:lines`. `APPEND_RUN_LOG` derives both prefixes to evict an
      // expired run, so the two must keep this shape.
      runLinePrefix: `${base}:runline:`,
      // Where this runner's analytics hashes sit — see `metricsKey`. Under the
      // runner's tag, so one script may write several of them at once.
      metricsPrefix: `${base}:mx:`,
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
    pruneCursors: string;
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
    metricsPrefix: string;
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
      // Where the expiry sweep's walk of each finished set resumes, one hash
      // field per set. Derived from `meta` in `PRUNE_EXPIRED` exactly as
      // `exclude` is, so the two must keep this shape.
      pruneCursors: `${base}:prune`,
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
      // Where this queue's analytics hashes sit — see `metricsKey`. Another
      // sibling of `job:`, derived from the prefix in Lua exactly as `tp:` is,
      // so the per-second counts ride `COMPLETE` and `FAIL` without taking a
      // KEYS entry and without leaving the queue's hash tag. The queue's
      // **minute** jobs counts are not here: they stay in the `tp:` hashes
      // above, so `getQueueMetrics` at a minute and `getThroughput` can never
      // disagree about the same events.
      metricsPrefix: `${base}:mx:`,
    };
  }

  /**
   * The channel events for one target are published on.
   *
   * One letter per kind, and a kind added later must pick a new one: a
   * `worker` event sharing the queue's channel would reach every `BunQueue`
   * subscriber, which asked for jobs.
   */
  channel(ns: string, kind: EventKind, target: string): string {
    return `${this.namespace(ns)}:ev:${CHANNEL_KINDS[kind]}:${target}`;
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
      // Appended rather than placed beside `dead`, so every index the
      // scripts already read stays where it was.
      //
      // The namespace's `queues` set is deliberately **not** here, though
      // the add scripts once wrote it: it carries no hash tag, so in Cluster
      // it sits in another slot and every queue script declaring it was
      // rejected with `CROSSSLOT`. The driver adds to it beside the script,
      // as the runner methods add to `runners`.
      keys.children,
    ];
  }

  /**
   * The private list a driver's blocking pop also names, so a push to it
   * ends the pop early and it can be re-issued over a different set of wake
   * keys — see `waitForJob` in the driver.
   *
   * One per driver instance (`owner`), and per queue name in Cluster
   * (`queue`), because a multi-key `BLPOP` must name keys of one slot: the
   * queue's tag goes on the end so the list shares its slot. Outside every
   * namespace, since a pop spans them all, and never written without an
   * expiry, so a process that dies leaves nothing behind for long.
   */
  wakeControl(owner: string, queue?: string): string {
    const base = `${this.prefix}:wake-ctl:${owner}`;
    return queue === undefined || !this.cluster
      ? base
      : `${base}:${this.#tag(queue)}`;
  }

  /** Wraps a name in a hash tag when the server is a cluster. */
  #tag(name: string): string {
    return this.cluster ? `{${name}}` : name;
  }
}
