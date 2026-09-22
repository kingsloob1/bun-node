import type { JobsDriver, QueueRef } from "../drivers/index";
import type {
  WorkerConfigKey,
  WorkerConfigPatch,
  WorkerConfigValues,
  WorkerDesiredState,
  WorkerStopPersistence,
} from "../shared/workers";
import { ConfigError } from "../shared/errors";
import { fitName } from "../shared/fit";
import {
  isWorkerConfigKey,
  WORKER_CONFIG_BOUNDS,
  WORKER_CONFIG_KEYS,
  workerConfigIssue,
} from "../shared/workers";
import { DERIVED_NAME_LIMITS } from "./options";
import { RESERVED_STATE_PREFIX, setReservedState } from "./windows";

/**
 * Where a controller writes what it wants of a worker, and where the worker
 * reads it.
 *
 * Three families of queue-state entry, all under the prefix this package
 * reserves — so nothing a caller's `setQueueState` can name, and nothing the
 * window sweep can mistake for its own:
 *
 * - `__win:wcfg:<key>` — a **configuration override**, keyed by the worker's
 *   **stable** key, so it survives restarts and reaches every replica. Never
 *   swept: it is the operator's standing intent, and an orphan is listed so
 *   it can be removed deliberately.
 * - `__win:wctl:<id>` — a **lifecycle instruction** (pause, resume, stop,
 *   start), keyed by the worker's **incarnation**, so it can never outlive the
 *   process it was addressed to. Swept once its worker is gone.
 * - `__win:wstop:<key>` — a stop that was asked to outlive the process
 *   (`stopPersistence: "key"`). Written only for a worker whose record says
 *   it wants that, and read only by a worker configured for it.
 *
 * Every write is a compare-and-set read-modify-write with a short retry, like
 * `registerWorkerRecord`, so two controllers cannot lose each other's fields.
 * The entry's queue-state **version is its `seq`**: `setQueueState` already
 * guarantees that it is atomic and only ever rises. That is also why a reset
 * stores `{}` rather than deleting — a deleted entry starts again at version
 * 1, and a worker's `appliedSeq` would then look current when it is not.
 */

/** The prefix of every worker configuration override. */
export const WORKER_CONFIG_PREFIX = `${RESERVED_STATE_PREFIX}wcfg:`;

/** The prefix of every worker lifecycle instruction. */
export const WORKER_CONTROL_PREFIX = `${RESERVED_STATE_PREFIX}wctl:`;

/** The prefix of every stop recorded against a stable key. */
export const WORKER_STOP_PREFIX = `${RESERVED_STATE_PREFIX}wstop:`;

/**
 * The queue's control change counter: an entry whose queue-state **version**
 * rises on every configuration, lifecycle or stop write, so a process can
 * poll this one entry for all its workers on the queue and read their own
 * entries only when it moved (see {@link watchWorkerChanges}). Its value is
 * only the time of the last bump.
 */
export const WORKER_CHANGES_STATE = `${RESERVED_STATE_PREFIX}wchg`;

/** How many times a compare-and-set write is retried before it gives up. */
const CAS_ATTEMPTS = 5;

/**
 * How many control entries one sweep examines. Bounded like every other
 * maintenance pass, so a namespace with thousands of dead incarnations costs
 * a page per minute rather than one unbounded scan.
 */
export const WORKER_CONTROL_SWEEP_LIMIT = 100;

/**
 * How many report intervals a lifecycle instruction outlives its worker
 * before the sweep may remove it.
 *
 * Generous, because the cost of being early is real and the cost of being
 * late is a few bytes: a worker whose record lapsed because its process was
 * briefly paused, or whose clock is behind, must still find the instruction
 * waiting when it reports again.
 */
export const WORKER_CONTROL_GRACE_LIFETIMES = 10;

/**
 * A stored configuration override, as it is written.
 *
 * `v` is the shape's version, so a future field can be added without a reader
 * from this version mistaking what it finds.
 */
export interface WorkerConfigEntry {
  /** Entry version. */
  v: 1;
  /** The stable worker key it applies to, in full — the name may be fitted. */
  key: string;
  /** The settings it replaces. Empty after a reset. */
  values: WorkerConfigPatch;
  /** When it was last written, epoch ms. */
  at: number;
}

/** A stored lifecycle instruction, as it is written. */
export interface WorkerControlEntry {
  /** Entry version. */
  v: 1;
  /** The incarnation it is addressed to, in full. */
  id: string;
  /** That worker's stable key, for display and for the sweep. */
  key: string;
  /**
   * The addressee's `processStartedAt`. A worker applies an instruction only
   * when this is its own, so an instruction written to a worker with an
   * explicit (and therefore stable) id can never be applied by the process
   * that replaced it.
   */
  incarnation: number;
  /** What the worker should be. */
  state: WorkerDesiredState;
  /** When it was written, epoch ms. */
  at: number;
  /**
   * How long a `stop` should last, when the instruction asks for other than
   * the worker's own setting. Only honoured by a worker whose
   * `stopPersistenceOverridable` is on.
   */
  persist?: WorkerStopPersistence;
  /**
   * For a `stop`: how long to wait for the jobs still running, in
   * milliseconds. After it the worker abandons them — their signals are
   * aborted and their locks stop being renewed, so each lock lapses and
   * another worker recovers the job as stalled. Absent means wait
   * indefinitely, which is the default and the safe one: abandoning a job
   * that had already started is a second run of work, not a cancellation.
   *
   * At most {@link WORKER_STOP_TIMEOUT_MAX}. A stored value that is not a
   * whole number of milliseconds in `0 …` that is ignored on read, and the
   * stop still applies — without a timeout.
   */
  timeout?: number;
  /** Who asked, when a controller says. Never interpreted, only stored. */
  by?: string;
}

/** A stop recorded against a stable key, as it is written. */
export interface WorkerStopEntry {
  /** Entry version. */
  v: 1;
  /** The stable worker key it applies to, in full. */
  key: string;
  /** When it was written, epoch ms. */
  at: number;
  /** Who asked, when a controller says. */
  by?: string;
}

/** One stored entry with the version that is its `seq`. */
export interface VersionedEntry<TValue> {
  /** What is stored. */
  value: TValue;
  /** The queue-state version, which is the entry's `seq`. */
  seq: number;
  /**
   * Why part of what was stored was ignored, when part of it was.
   *
   * A field the reader cannot accept is dropped rather than making the whole
   * entry unreadable — an instruction must still be obeyed even if an
   * argument to it was nonsense — so the reason travels beside the value and
   * the worker records it in `control.lastError`.
   */
  issue?: string;
}

/**
 * The longest a stored `stop` may wait before abandoning the jobs still
 * running: an hour.
 *
 * A bound at all, because the value comes off shared storage and a mistyped
 * one would otherwise park a worker for days in `stopping` — visibly
 * draining, never drained. An hour is far longer than any job this package
 * expects to hold a lock for, and a caller who wants longer wants no timeout
 * at all, which is the default.
 */
export const WORKER_STOP_TIMEOUT_MAX = 3_600_000;

/**
 * Why a stored stop timeout cannot be used, or `null` when it can.
 *
 * Read the way every other stored field is: whatever a newer version, or a
 * person with a database client, put there has to be checked before it
 * reaches a running worker.
 */
export function workerStopTimeoutIssue(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return "a stop timeout must be a whole number of milliseconds";
  }

  if (value < 0 || value > WORKER_STOP_TIMEOUT_MAX) {
    return `a stop timeout must be between 0 and ${WORKER_STOP_TIMEOUT_MAX}ms`;
  }

  return null;
}

/** A configuration override as a reader sees it, live or orphaned. */
export interface WorkerConfigOverride {
  /** The queue it is stored on. */
  queue: string;
  /** The stable worker key it applies to. */
  key: string;
  /** The settings it replaces. */
  values: WorkerConfigPatch;
  /** Its version. */
  seq: number;
  /** When it was written, epoch ms. */
  updatedAt: number;
}

/**
 * Whether a driver can store worker control at all: it has queue state.
 * Listing is needed too, for the override listing and the sweep.
 */
export function supportsWorkerControl(driver: JobsDriver): boolean {
  return (
    typeof driver.getQueueState === "function" &&
    typeof driver.setQueueState === "function" &&
    typeof driver.listQueueState === "function"
  );
}

/**
 * The queue-state name of `key`'s configuration override, fitted like every
 * other name this package derives so a key of the longest legal length still
 * makes a storable name on MySQL and the file driver.
 *
 * The full key is kept *inside* the entry, so a fitted name never loses it.
 */
export function workerConfigName(key: string): string {
  return fitName(`${WORKER_CONFIG_PREFIX}${key}`, DERIVED_NAME_LIMITS);
}

/** The queue-state name of `id`'s lifecycle instruction. */
export function workerControlName(id: string): string {
  return fitName(`${WORKER_CONTROL_PREFIX}${id}`, DERIVED_NAME_LIMITS);
}

/** The queue-state name of `key`'s persistent stop. */
export function workerStopName(key: string): string {
  return fitName(`${WORKER_STOP_PREFIX}${key}`, DERIVED_NAME_LIMITS);
}

/**
 * The override stored for `key`, or `null`.
 *
 * A stored `values` is filtered to the settings this version knows and the
 * bounds it enforces, so an entry written by a newer version — or edited by
 * hand — cannot put an unknown key or an absurd number into a running worker.
 */
export async function readWorkerConfig(
  driver: JobsDriver,
  q: QueueRef,
  key: string,
): Promise<VersionedEntry<WorkerConfigEntry> | null> {
  const entry = await driver.getQueueState?.(q, workerConfigName(key));

  if (!entry) {
    return null;
  }

  const stored = entry.value as Partial<WorkerConfigEntry> | null;

  return {
    value: {
      v: 1,
      key: stored?.key ?? key,
      values: sanitizeConfigValues(stored?.values),
      at: typeof stored?.at === "number" ? stored.at : 0,
    },
    seq: entry.version,
  };
}

/**
 * Merges `patch` into `key`'s override and stores it, answering what is now
 * stored. A field set to `null` is removed, so the worker's own value applies
 * again.
 *
 * `expectedSeq` makes it a safe read-modify-write: the write is refused —
 * with `contended: true` and nothing changed — when the entry has moved on
 * since the caller read it. Without it, the last writer wins field by field,
 * which is what two operators editing different fields want.
 *
 * **Refuses rather than drops**, like `writeJobDefaults`: a key outside
 * `WORKER_CONFIG_KEYS`, or a value outside its `WORKER_CONFIG_BOUNDS` (or not
 * a whole number where one is required), throws a `ConfigError` naming the
 * key and the bound before anything is read or written. The management API
 * validates first and answers 400; this is the in-code guard. The one rule
 * spanning two fields (`heartbeatInterval` against the effective
 * `lockDuration`) depends on each worker's own code values, so it stays the
 * worker's to enforce when it applies the override.
 */
export async function writeWorkerConfig(
  driver: JobsDriver,
  q: QueueRef,
  key: string,
  patch: Readonly<Partial<Record<WorkerConfigKey, number | null>>>,
  options?: {
    /** Refuse unless the stored version is still this. */
    expectedSeq?: number;
    /** When set, every field is dropped first: a reset. */
    replace?: boolean;
    /** When the write happened; defaults to now. */
    now?: number;
  },
): Promise<{
  /** What is stored now. */ override: WorkerConfigOverride;
  /** Whether somebody else wrote first, so nothing changed. */
  contended: boolean;
}> {
  const changes: [WorkerConfigKey, number | null][] = [];

  for (const [field, value] of Object.entries(patch)) {
    if (!isWorkerConfigKey(field)) {
      throw new ConfigError(`"${field}" is not an editable worker setting`, {
        key: field,
        keys: WORKER_CONFIG_KEYS,
      });
    }

    if (value === undefined) {
      continue;
    }

    if (value !== null) {
      const issue = workerConfigIssue(field, value);

      if (issue !== null) {
        throw new ConfigError(issue, {
          key: field,
          value,
          bound: WORKER_CONFIG_BOUNDS[field],
        });
      }
    }

    changes.push([field, value]);
  }

  const name = workerConfigName(key);
  const now = options?.now ?? Date.now();

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const current = await readWorkerConfig(driver, q, key);

    if (
      options?.expectedSeq !== undefined &&
      options.expectedSeq !== (current?.seq ?? 0)
    ) {
      return {
        override: toOverride(q, key, current),
        contended: true,
      };
    }

    const values: WorkerConfigPatch = options?.replace
      ? {}
      : { ...current?.value.values };

    for (const [field, value] of changes) {
      if (value === null) {
        delete values[field];
      } else {
        values[field] = value;
      }
    }

    const entry: WorkerConfigEntry = { v: 1, key, values, at: now };
    const seq = await setReservedState(
      driver,
      q,
      name,
      entry,
      current?.seq ?? null,
    );

    if (seq !== null) {
      await bumpWorkerChanges(driver, q, now);
      return {
        override: { queue: q.queue, key, values, seq, updatedAt: now },
        contended: false,
      };
    }
  }

  // Five collisions in a row is contention, not a lost write: the caller is
  // told nothing changed rather than being given a value that was never
  // stored.
  return {
    override: toOverride(q, key, await readWorkerConfig(driver, q, key)),
    contended: true,
  };
}

/** Every override stored on a queue, in name order. */
export async function listWorkerConfigs(
  driver: JobsDriver,
  q: QueueRef,
): Promise<WorkerConfigOverride[]> {
  if (!supportsWorkerControl(driver)) {
    return [];
  }

  const overrides: WorkerConfigOverride[] = [];

  for (const name of await listNames(driver, q, WORKER_CONFIG_PREFIX)) {
    const entry = await driver.getQueueState!(q, name);
    const stored = entry?.value as Partial<WorkerConfigEntry> | null;

    if (!entry || !stored?.key) {
      continue;
    }

    overrides.push({
      queue: q.queue,
      key: stored.key,
      values: sanitizeConfigValues(stored.values),
      seq: entry.version,
      updatedAt: typeof stored.at === "number" ? stored.at : 0,
    });
  }

  return overrides;
}

/** The lifecycle instruction stored for `id`, or `null`. */
export async function readWorkerControl(
  driver: JobsDriver,
  q: QueueRef,
  id: string,
): Promise<VersionedEntry<WorkerControlEntry> | null> {
  const entry = await driver.getQueueState?.(q, workerControlName(id));
  const stored = entry?.value as Partial<WorkerControlEntry> | null;

  if (!entry || !stored || typeof stored.state !== "string") {
    return null;
  }

  // A timeout that cannot be used is dropped, not fatal: the stop it belongs
  // to still has to happen, and waiting indefinitely is the safe reading of
  // "no usable timeout".
  const issue =
    stored.timeout === undefined
      ? null
      : workerStopTimeoutIssue(stored.timeout);

  return {
    value: {
      v: 1,
      id: stored.id ?? id,
      key: stored.key ?? id,
      incarnation:
        typeof stored.incarnation === "number" ? stored.incarnation : 0,
      state: stored.state as WorkerDesiredState,
      at: typeof stored.at === "number" ? stored.at : 0,
      ...(stored.persist ? { persist: stored.persist } : {}),
      ...(stored.timeout !== undefined && issue === null
        ? { timeout: stored.timeout }
        : {}),
      ...(stored.by ? { by: stored.by } : {}),
    },
    seq: entry.version,
    ...(issue === null ? {} : { issue }),
  };
}

/**
 * Records what a worker should be, answering the version a worker will
 * report as `appliedSeq` once it has obeyed.
 *
 * Read-modify-write like the override, so two controllers racing produce one
 * winner and one `contended`, rather than a version that never existed.
 */
export async function writeWorkerControl(
  driver: JobsDriver,
  q: QueueRef,
  instruction: Omit<WorkerControlEntry, "v" | "at"> & {
    /** When it was written; defaults to now. */ at?: number;
  },
): Promise<{
  /** The stored instruction's version. */ seq: number;
  /** Whether somebody else wrote first, so nothing changed. */
  contended: boolean;
}> {
  const name = workerControlName(instruction.id);
  const entry: WorkerControlEntry = {
    v: 1,
    id: instruction.id,
    key: instruction.key,
    incarnation: instruction.incarnation,
    state: instruction.state,
    at: instruction.at ?? Date.now(),
    ...(instruction.persist ? { persist: instruction.persist } : {}),
    // Written as given, and checked by the worker that reads it. A caller's
    // own validation belongs at the edge that took the value; refusing it
    // here would leave the API unable to report *why* a stop it accepted did
    // not carry the timeout it was given.
    ...(instruction.timeout === undefined
      ? {}
      : { timeout: instruction.timeout }),
    ...(instruction.by ? { by: instruction.by } : {}),
  };

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const current = await driver.getQueueState?.(q, name);
    const seq = await setReservedState(
      driver,
      q,
      name,
      entry,
      current?.version ?? null,
    );

    if (seq !== null) {
      await bumpWorkerChanges(driver, q, entry.at);
      return { seq, contended: false };
    }
  }

  const current = await driver.getQueueState?.(q, name);
  return { seq: current?.version ?? 0, contended: true };
}

/**
 * Removes a lifecycle instruction, at the version it was read at, answering
 * whether it went.
 *
 * Conditional on the version so an instruction written between the read and
 * the delete survives: a worker clearing a stale entry must never swallow the
 * one a controller wrote a millisecond ago.
 */
export async function removeWorkerControl(
  driver: JobsDriver,
  q: QueueRef,
  id: string,
  seq: number,
): Promise<boolean> {
  return (
    (await setReservedState(driver, q, workerControlName(id), null, seq)) === 0
  );
}

/** Whether a stop is recorded against `key`, and when it was written. */
export async function readWorkerStop(
  driver: JobsDriver,
  q: QueueRef,
  key: string,
): Promise<VersionedEntry<WorkerStopEntry> | null> {
  const entry = await driver.getQueueState?.(q, workerStopName(key));
  const stored = entry?.value as Partial<WorkerStopEntry> | null;

  if (!entry || !stored) {
    return null;
  }

  return {
    value: {
      v: 1,
      key: stored.key ?? key,
      at: typeof stored.at === "number" ? stored.at : 0,
      ...(stored.by ? { by: stored.by } : {}),
    },
    seq: entry.version,
  };
}

/**
 * Records — or clears — a stop against a stable key, so every worker carrying
 * it comes up stopped until somebody starts it again.
 *
 * Unlike a lifecycle instruction this is not keyed by incarnation, which is
 * exactly the point: it is the one form of stop that is meant to outlive the
 * process.
 */
export async function writeWorkerStop(
  driver: JobsDriver,
  q: QueueRef,
  key: string,
  stopped: boolean,
  options?: {
    /** Who asked. */ by?: string;
    /** When; defaults to now. */ now?: number;
  },
): Promise<void> {
  const name = workerStopName(key);
  const value: WorkerStopEntry | null = stopped
    ? {
        v: 1,
        key,
        at: options?.now ?? Date.now(),
        ...(options?.by ? { by: options.by } : {}),
      }
    : null;

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const current = await driver.getQueueState?.(q, name);

    if (!stopped && !current) {
      return;
    }

    if (
      (await setReservedState(
        driver,
        q,
        name,
        value,
        current?.version ?? null,
      )) !== null
    ) {
      await bumpWorkerChanges(driver, q, options?.now ?? Date.now());
      return;
    }
  }
}

/** What one sweep removed, and where the next should resume. */
export interface WorkerControlSweep {
  /** How many instructions were removed. */
  removed: number;
  /** The last name examined, to pass back as `after`; `undefined` at the end. */
  next: string | undefined;
}

/**
 * Removes lifecycle instructions whose worker is gone.
 *
 * An instruction is keyed by incarnation, so every one of them becomes
 * garbage the moment its process ends — and nothing else would ever remove
 * it. Two conditions must both hold before one goes: no live worker has that
 * id, and it was written longer than `graceMs` ago. The second is what keeps
 * a race from eating a fresh instruction: a controller may well write to a
 * worker that has not reported yet.
 *
 * Bounded per call; a caller covering everything passes `next` back in until
 * it comes back `undefined`.
 */
export async function sweepWorkerControls(
  driver: JobsDriver,
  q: QueueRef,
  options: {
    /** The caller's clock. */
    now: number;
    /** The ids of every live worker on the queue. */
    liveIds: ReadonlySet<string>;
    /** How long an instruction is left alone after it was written. */
    graceMs: number;
    /** How many entries to examine. */
    limit?: number;
    /** Resume after this name. */
    after?: string;
  },
): Promise<WorkerControlSweep> {
  if (!supportsWorkerControl(driver)) {
    return { removed: 0, next: undefined };
  }

  const limit = options.limit ?? WORKER_CONTROL_SWEEP_LIMIT;
  const names = await driver.listQueueState!(q, {
    prefix: WORKER_CONTROL_PREFIX,
    limit,
    ...(options.after !== undefined ? { after: options.after } : {}),
  });

  let removed = 0;

  for (const name of names) {
    const entry = await driver.getQueueState!(q, name);
    const stored = entry?.value as Partial<WorkerControlEntry> | null;

    if (!entry || !stored?.id) {
      continue;
    }

    if (
      options.liveIds.has(stored.id) ||
      options.now - (stored.at ?? 0) <= options.graceMs
    ) {
      continue;
    }

    if ((await setReservedState(driver, q, name, null, entry.version)) === 0) {
      removed++;
    }
  }

  return { removed, next: names.length < limit ? undefined : names.at(-1) };
}

/** Every name under one of this module's prefixes, paged to the end. */
async function listNames(
  driver: JobsDriver,
  q: QueueRef,
  prefix: string,
): Promise<string[]> {
  const found: string[] = [];
  let after: string | undefined;

  for (;;) {
    const page = await driver.listQueueState!(q, {
      prefix,
      limit: 200,
      ...(after !== undefined ? { after } : {}),
    });

    found.push(...page);

    if (page.length < 200) {
      return found;
    }

    after = page.at(-1);
  }
}

/** A stored override, or the empty one a missing entry stands for. */
function toOverride(
  q: QueueRef,
  key: string,
  current: VersionedEntry<WorkerConfigEntry> | null,
): WorkerConfigOverride {
  return {
    queue: q.queue,
    key,
    values: current?.value.values ?? {},
    seq: current?.seq ?? 0,
    updatedAt: current?.value.at ?? 0,
  };
}

/**
 * The settings in a stored override that this version knows and accepts,
 * in {@link WORKER_CONFIG_KEYS} order.
 *
 * An entry is read off shared storage that a newer version, or a person with
 * a database client, may have written. Filtering here rather than at the
 * worker means every reader — the worker, the listing, a controller's
 * read-modify-write — sees the same thing.
 */
function sanitizeConfigValues(values: unknown): WorkerConfigPatch {
  if (typeof values !== "object" || values === null) {
    return {};
  }

  const source = values as Partial<Record<WorkerConfigKey, unknown>>;
  const clean: WorkerConfigPatch = {};

  for (const key of WORKER_CONFIG_KEYS) {
    const value = source[key];

    if (value !== undefined && workerConfigIssue(key, value) === null) {
      clean[key] = value as WorkerConfigValues[typeof key];
    }
  }

  return clean;
}

/**
 * Raises the queue's control change counter ({@link WORKER_CHANGES_STATE}),
 * after the entry it announces has been written — so a poller that sees the
 * new version and reads the entries finds the write.
 *
 * One compare-and-set attempt is enough: losing it means another writer
 * bumped after this one's entry landed, which announces it just as well.
 * Never throws — the write it follows has succeeded, and a missed bump only
 * costs latency: every worker still re-reads its entries at each heartbeat.
 */
export async function bumpWorkerChanges(
  driver: JobsDriver,
  q: QueueRef,
  now: number = Date.now(),
): Promise<void> {
  try {
    const current = await driver.getQueueState?.(q, WORKER_CHANGES_STATE);
    await setReservedState(
      driver,
      q,
      WORKER_CHANGES_STATE,
      { at: now },
      current?.version ?? null,
    );
  } catch {
    // See above: the heartbeat's re-read covers it.
  }
}

/** One worker following a queue's change counter. */
interface ChangeWatcher {
  /** How often it wants the counter read, ms. */
  interval: number;
  /** Called when the counter moved (and once on the poller's first read). */
  onChange: () => void;
}

/**
 * Reads one queue's change counter for every worker of this process that
 * follows it, and tells them all when it moves.
 *
 * Before it, each worker read its own two entries every interval, whether or
 * not anything had been written: two reads per worker every two seconds on
 * the backends that poll, forever, for instructions that arrive a few times a
 * day. Now a process reads one entry per queue per interval, and a worker
 * reads its own entries only when something was written to the queue.
 */
class ChangePoller {
  /** The workers following the counter. */
  readonly watchers = new Set<ChangeWatcher>();
  /** The version last read; `undefined` before the first read. */
  #version: number | undefined;
  /** The poll timer, while anyone watches. */
  #timer: ReturnType<typeof setInterval> | undefined;
  /** The interval the timer runs at. */
  #interval = 0;
  /** Whether a read is in flight, so a slow backend is not read twice at once. */
  #reading = false;

  constructor(
    /** The driver holding the counter. */
    readonly driver: JobsDriver,
    /** The queue. */
    readonly ref: QueueRef,
    /** Called once nobody watches, to drop this poller from the registry. */
    readonly onEmpty: () => void,
  ) {}

  /** Re-arms the timer at the smallest interval any watcher asks for. */
  rearm(): void {
    if (this.watchers.size === 0) {
      if (this.#timer) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
      this.onEmpty();
      return;
    }

    const interval = Math.min(
      ...[...this.watchers].map((watcher) => watcher.interval),
    );

    if (this.#timer && interval === this.#interval) {
      return;
    }

    if (this.#timer) {
      clearInterval(this.#timer);
    }

    this.#interval = interval;
    this.#timer = setInterval(() => {
      void this.#poll();
    }, interval);
    this.#timer.unref?.();
  }

  /** Reads the counter and tells every watcher when it moved. */
  async #poll(): Promise<void> {
    if (this.#reading) {
      return;
    }

    this.#reading = true;
    try {
      const entry = await this.driver.getQueueState!(
        this.ref,
        WORKER_CHANGES_STATE,
      );
      const version = entry?.version ?? 0;

      // The first read has nothing to compare with, and a write may have
      // landed between a worker's own first adoption and this read: every
      // watcher looks once rather than miss it.
      if (version !== this.#version) {
        this.#version = version;
        for (const watcher of [...this.watchers]) {
          watcher.onChange();
        }
      }
    } catch {
      // Tried again next interval; the heartbeat's re-read covers the gap.
    } finally {
      this.#reading = false;
    }
  }
}

/** The pollers of each driver, by queue. */
const changePollers = new WeakMap<JobsDriver, Map<string, ChangePoller>>();

/**
 * Follows a queue's control change counter: `onChange` is called within
 * about `interval` of any configuration, lifecycle or stop write to the
 * queue (and once after the first read). Every worker of the process on the
 * same driver and queue shares one read per interval — the smallest interval
 * any of them asks for. Answers the function that stops following.
 */
export function watchWorkerChanges(
  driver: JobsDriver,
  q: QueueRef,
  interval: number,
  onChange: () => void,
): () => void {
  let byQueue = changePollers.get(driver);

  if (!byQueue) {
    byQueue = new Map();
    changePollers.set(driver, byQueue);
  }

  const id = `${q.ns}\u0000${q.queue}`;
  let poller = byQueue.get(id);

  if (!poller) {
    const queues = byQueue;
    poller = new ChangePoller(driver, q, () => {
      if (queues.get(id) === poller) {
        queues.delete(id);
      }
    });
    byQueue.set(id, poller);
  }

  const watcher: ChangeWatcher = { interval, onChange };
  const owner = poller;
  owner.watchers.add(watcher);
  owner.rearm();

  return () => {
    if (owner.watchers.delete(watcher)) {
      owner.rearm();
    }
  };
}
