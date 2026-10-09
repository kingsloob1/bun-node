import type { JobsDriver, QueueRef, QueueStateEntry } from "../drivers/index";
import type { Logger } from "../shared/logger";
import type { SummonGroupOptions } from "./types";
import { RESERVED_STATE_PREFIX, setReservedState } from "../queue/windows";
import { ConfigError } from "../shared/errors";
import { assertSegment, RESERVED_QUEUE } from "../shared/keys";
import {
  DAY_MS,
  HOUR_MS,
  newEpoch,
  newerMarkerVersion,
  rollBudget,
} from "./marker";

/**
 * A summon group's shared state: one reserved queue-state entry per group,
 * `__win:summon-group:<name>`, under the package's pseudo-queue
 * (`{ ns, queue: "__bunjobs" }`), written only by compare-and-set.
 *
 * Keyed by the group's name alone, never by a member queue, so adding,
 * removing or reordering the group's queues — or a rolling deploy in which
 * old and new processes disagree on them — keeps one budget.
 *
 * What lives here is what the group shares: the budget's counts (with the
 * limits that last charged them, so a reader without a policy can show
 * them), and each queue's share of today's attempts. Everything else —
 * attempts in flight, backoff, cooldown, the circuit — stays on each queue's
 * own marker (`marker.ts`).
 *
 * **Every function here is a bounded loop of read, change, compare-and-set**,
 * re-reading on a lost write, so a group needs no lock and no multi-entry
 * transaction. The one ordering rule is the controller's: charge the group
 * **before** claiming the queue's marker, and refund it when that claim is
 * lost. A refund that never lands over-counts by one; it can never let the
 * group overspend.
 *
 * Internal: nothing here is exported from the package.
 */

/** The prefix of every group entry's queue-state name. Reserved, like the marker's. */
export const SUMMON_GROUP_PREFIX = `${RESERVED_STATE_PREFIX}summon-group:`;

/**
 * Rounds of compare-and-set a charge makes before giving up as contended.
 * Measured (plan §3.7): the losers of a 16-way race at one instant need up to
 * 15 rounds, so a few of them answer `contended` and run again a debounce
 * later — never a poll later.
 */
export const GROUP_CHARGE_ROUNDS = 8;

/** Rounds a refund or a reset makes: best effort, as a lost refund only over-counts. */
export const GROUP_WRITE_ROUNDS = 3;

/** The default limits of a group's budget, the same as a queue's own. */
const DEFAULT_GROUP_BUDGET = Object.freeze({ perHour: 30, perDay: 300 });

/** Where a group's entry lives: the namespace's pseudo-queue. */
export function summonGroupRef(
  /** The namespace the group's queues are in. */
  namespace: string,
): QueueRef {
  return { ns: namespace, queue: RESERVED_QUEUE };
}

/** A group's entry name: `__win:summon-group:<name>`. */
export function summonGroupStateName(
  /** The group's name, already a valid segment. */
  name: string,
): string {
  return `${SUMMON_GROUP_PREFIX}${name}`;
}

/** A budget's limits, both positive whole numbers. */
export interface SummonGroupLimits {
  /** Attempts per UTC hour. */
  perHour: number;
  /** Attempts per UTC day. */
  perDay: number;
}

/** `group.circuit` as given, checked: off, or the thresholds it sets (the rest are the policy's). */
export type ResolvedGroupCircuit =
  | false
  | {
      /** Failures that open it; `undefined` for the policy's. */
      failures?: number;
      /** How long it stays open, in ms; `undefined` for the policy's. */
      resetAfter?: number;
    };

/** `SummonPolicy.group`, checked, with its defaults. */
export interface ResolvedSummonGroup {
  /** The group's name, a valid segment. */
  name: string;
  /** The group's limits, or `false` for none (attempts are still counted). */
  budget: SummonGroupLimits | false;
  /** Whether the circuit is shared, and any thresholds of its own. */
  circuit: ResolvedGroupCircuit;
}

/** A group's circuit for one provider kind, in the entry. */
export interface SummonGroupCircuit {
  /** Consecutive failures counted across the group for this kind. */
  failures: number;
  /** While set and in the future, the circuit is open for this kind. */
  openUntil?: number;
  /** The failure that last opened it. */
  openedBy?: {
    /** The queue whose attempt failed. */
    queue: string;
    /** The attempt. */
    id: string;
    /** Its detail, when it had one. */
    detail?: string;
  };
}

/** One queue's share of the group's attempts, in the entry. */
export interface SummonGroupQueueShare {
  /** Attempts this queue charged to the group in the entry's day window. */
  day: number;
  /** When it last charged one, epoch ms. */
  lastAt: number;
}

/** What `__win:summon-group:<name>` holds. */
export interface SummonGroupEntry {
  /** Shape version. Always `1` here; a newer one is left alone. */
  v: 1;
  /**
   * Random at creation and never changed after, as the marker's: anything
   * derived from the entry's version (a shared unit's attempt ids) stays
   * unique after the entry is deleted or the namespace purged.
   */
  epoch: string;
  /** Attempts charged in the current hour and day, windowed as the marker's. */
  budget: {
    /** Start of the current hour window, epoch ms. */
    hourStart: number;
    /** Attempts charged in it. */
    hour: number;
    /** Start of the current day window, epoch ms. */
    dayStart: number;
    /** Attempts charged in it. */
    day: number;
    /**
     * How many times an operator's reset has cleared the counts, absent
     * before the first. A refund gives back only a charge made since the
     * last clear: one made before it was cleared with the counts, so giving
     * it back too would take an attempt counted after the reset out of the
     * group's budget.
     */
    clears?: number;
  };
  /**
   * The limits of the controller that last charged, so a reader with no
   * policy can show them. Absent while that controller's group budget was
   * `false`.
   */
  limits?: SummonGroupLimits;
  /**
   * Each queue's share of the day window's attempts, by queue name. Emptied
   * when the day window rolls, so a queue that left the group drops out.
   */
  queues?: Record<string, SummonGroupQueueShare>;
  /**
   * The shared circuit, by provider `kind`: written only by controllers whose
   * group shares its circuit. Absent until one counts a failure.
   */
  circuits?: Record<string, SummonGroupCircuit>;
}

/** Whether `value` is a positive whole number. */
function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A limit as given: a positive whole number, or a `ConfigError` naming it. */
function limit(name: string, value: unknown): number {
  if (!isPositiveInt(value)) {
    throw new ConfigError(`${name} must be a positive whole number`, {
      [name]: String(value),
    });
  }
  return value;
}

/**
 * `SummonPolicy.group`, checked, with its defaults; `undefined` when unset.
 *
 * @throws {ConfigError} for a `group` that is not an object, a `name` that is
 *   not a valid segment (or is missing), or a `budget` that is neither
 *   `false` nor `{ perHour?, perDay? }` of positive whole numbers.
 */
export function resolveSummonGroup(
  /** The option as given. */
  group: SummonGroupOptions | undefined,
): ResolvedSummonGroup | undefined {
  if (group === undefined) {
    return undefined;
  }
  if (typeof group !== "object" || group === null || Array.isArray(group)) {
    throw new ConfigError(
      "group must be { name, budget? }: the group's name and what it shares",
      { group: String(group) },
    );
  }
  const name = assertSegment(group.name, "group.name");
  const circuit = resolveCircuit(group.circuit);
  const budget = group.budget;
  if (budget === false) {
    return { name, budget: false, circuit };
  }
  if (
    budget !== undefined &&
    (typeof budget !== "object" || budget === null || Array.isArray(budget))
  ) {
    throw new ConfigError(
      "group.budget must be false (no group limit) or { perHour?, perDay? }",
      { budget: String(budget) },
    );
  }
  return {
    name,
    circuit,
    budget: {
      perHour: limit(
        "group.budget.perHour",
        budget?.perHour ?? DEFAULT_GROUP_BUDGET.perHour,
      ),
      perDay: limit(
        "group.budget.perDay",
        budget?.perDay ?? DEFAULT_GROUP_BUDGET.perDay,
      ),
    },
  };
}

/** `group.circuit`, checked: `false` (default), `true`, or `{ failures?, resetAfter? }`. */
function resolveCircuit(
  circuit: SummonGroupOptions["circuit"],
): ResolvedGroupCircuit {
  if (circuit === undefined || circuit === false) {
    return false;
  }
  if (circuit === true) {
    return {};
  }
  if (
    typeof circuit !== "object" ||
    circuit === null ||
    Array.isArray(circuit)
  ) {
    throw new ConfigError(
      "group.circuit must be a boolean or { failures?, resetAfter? }",
      { circuit: String(circuit) },
    );
  }
  return {
    ...(circuit.failures === undefined
      ? {}
      : { failures: limit("group.circuit.failures", circuit.failures) }),
    ...(circuit.resetAfter === undefined
      ? {}
      : { resetAfter: limit("group.circuit.resetAfter", circuit.resetAfter) }),
  };
}

/** A fresh entry for `now`, with a new epoch and nothing counted. */
export function freshGroupEntry(now: number): SummonGroupEntry {
  return {
    v: 1,
    epoch: newEpoch(),
    budget: {
      hourStart: Math.floor(now / HOUR_MS) * HOUR_MS,
      hour: 0,
      dayStart: Math.floor(now / DAY_MS) * DAY_MS,
      day: 0,
    },
  };
}

/** Whether `value` is a finite number. */
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Whether a stored value has the entry's required shape: `v`, `epoch` and
 * the budget's counts. The optional fields are checked by
 * {@link readGroupEntry}, which drops a malformed one rather than throw the
 * counts away.
 */
export function isSummonGroupEntry(value: unknown): value is SummonGroupEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  const budget = entry.budget as Record<string, unknown> | undefined;
  return (
    entry.v === 1 &&
    typeof entry.epoch === "string" &&
    entry.epoch.length > 0 &&
    typeof budget === "object" &&
    budget !== null &&
    isNumber(budget.hourStart) &&
    isNumber(budget.hour) &&
    isNumber(budget.dayStart) &&
    isNumber(budget.day)
  );
}

/** A group's entry as read, with the version to write it back at. */
export interface SummonGroupRead {
  /** The entry, a private copy with its windows rolled to `now`. */
  entry: SummonGroupEntry;
  /** The version it was read at, `null` when there is no entry yet. */
  version: number | null;
  /**
   * Whether an entry existed that is neither this shape nor a newer one:
   * garbage, which a fresh entry is written over.
   */
  unreadable: boolean;
  /**
   * The shape version of an entry a newer bun-jobs wrote, which this build
   * must not write over: set, and `entry` is a fresh one never to be
   * written. `undefined` otherwise.
   */
  newer?: number;
}

/**
 * The entry in a stored queue-state value, as a private copy with its
 * windows rolled to `now`. No entry gives a fresh one to create at `null`;
 * garbage gives a fresh one to write over it at its version; an entry a newer
 * bun-jobs wrote is reported as `newer` and must be left alone.
 */
export function readGroupEntry(
  /** What `getQueueState` answered. */
  stored: QueueStateEntry | null,
  /** The time to roll the windows to, epoch ms. */
  now: number,
): SummonGroupRead {
  if (stored === null) {
    return { entry: freshGroupEntry(now), version: null, unreadable: false };
  }
  const newer = newerMarkerVersion(stored.value);
  if (newer !== undefined) {
    return {
      entry: freshGroupEntry(now),
      version: stored.version,
      unreadable: false,
      newer,
    };
  }
  if (!isSummonGroupEntry(stored.value)) {
    return {
      entry: freshGroupEntry(now),
      version: stored.version,
      unreadable: true,
    };
  }
  const entry = structuredClone(stored.value);
  // Optional fields: one that is not the shape this build writes is dropped,
  // never a reason to start a fresh entry over the counts.
  const limits = entry.limits as unknown as Record<string, unknown> | undefined;
  if (
    limits !== undefined &&
    !(
      typeof limits === "object" &&
      limits !== null &&
      isPositiveInt(limits.perHour) &&
      isPositiveInt(limits.perDay)
    )
  ) {
    delete entry.limits;
  }
  entry.queues = queueShares(entry.queues);
  const clears: unknown = entry.budget.clears;
  if (
    clears !== undefined &&
    !(typeof clears === "number" && Number.isSafeInteger(clears) && clears > 0)
  ) {
    delete entry.budget.clears;
  }
  entry.circuits = circuitStates(entry.circuits);
  roll(entry, now);
  return { entry, version: stored.version, unreadable: false };
}

/** The well-formed shares of an entry's `queues`, dropping anything else. */
function queueShares(
  value: unknown,
): Record<string, SummonGroupQueueShare> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const shares: Record<string, SummonGroupQueueShare> = {};
  for (const [queue, share] of Object.entries(value)) {
    const fields = share as Record<string, unknown> | null;
    if (
      typeof fields === "object" &&
      fields !== null &&
      isNumber(fields.day) &&
      isNumber(fields.lastAt)
    ) {
      shares[queue] = { day: fields.day, lastAt: fields.lastAt };
    }
  }
  return Object.keys(shares).length === 0 ? undefined : shares;
}

/** The well-formed circuits of an entry's `circuits`, dropping anything else. */
function circuitStates(
  value: unknown,
): Record<string, SummonGroupCircuit> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const circuits: Record<string, SummonGroupCircuit> = {};
  for (const [kind, state] of Object.entries(value)) {
    const fields = state as Record<string, unknown> | null;
    if (
      typeof fields !== "object" ||
      fields === null ||
      !isNumber(fields.failures) ||
      !(fields.openUntil === undefined || isNumber(fields.openUntil))
    ) {
      continue;
    }
    const by = fields.openedBy as Record<string, unknown> | undefined;
    const openedBy =
      typeof by === "object" &&
      by !== null &&
      typeof by.queue === "string" &&
      typeof by.id === "string"
        ? {
            queue: by.queue,
            id: by.id,
            ...(typeof by.detail === "string" ? { detail: by.detail } : {}),
          }
        : undefined;
    circuits[kind] = {
      failures: fields.failures,
      ...(fields.openUntil === undefined
        ? {}
        : { openUntil: fields.openUntil as number }),
      ...(openedBy === undefined ? {} : { openedBy }),
    };
  }
  return Object.keys(circuits).length === 0 ? undefined : circuits;
}

/** Whether the entry's circuit for `kind` is open at `now`. */
export function groupCircuitOpen(
  entry: SummonGroupEntry,
  kind: string,
  now: number,
): boolean {
  const openUntil = entry.circuits?.[kind]?.openUntil;
  return openUntil !== undefined && openUntil > now;
}

/**
 * Moves the entry's windows on to `now`'s. A day window that rolls also
 * empties the per-queue shares, which count that window.
 */
function roll(entry: SummonGroupEntry, now: number): void {
  const dayStart = entry.budget.dayStart;
  rollBudget(entry, now);
  if (entry.budget.dayStart !== dayStart) {
    delete entry.queues;
  }
}

/** Whether the entry's counts have reached `limits`. */
export function groupBudgetSpent(
  entry: SummonGroupEntry,
  limits: SummonGroupLimits | false,
): boolean {
  return (
    limits !== false &&
    (entry.budget.hour >= limits.perHour || entry.budget.day >= limits.perDay)
  );
}

/** Reads a group's entry: one driver read, no write. */
export async function readGroup(
  driver: JobsDriver,
  /** The group's namespace. */
  namespace: string,
  /** The group's name. */
  name: string,
  /** The time to roll the windows to, epoch ms. */
  now: number,
): Promise<SummonGroupRead> {
  const stored = await driver.getQueueState!(
    summonGroupRef(namespace),
    summonGroupStateName(name),
  );
  return readGroupEntry(stored, now);
}

/** What {@link chargeGroup} did. */
export type SummonGroupCharge =
  | {
      /** One attempt was counted against the group. */
      outcome: "charged";
      /** The entry as written. */
      entry: SummonGroupEntry;
      /** The version it was written at. */
      version: number;
      /** When it was charged, epoch ms: what a refund gives back against. */
      at: number;
      /** The entry's `budget.clears` it was charged under (`0` before any). */
      clears: number;
    }
  | {
      /** The group's shared circuit is open for the summoner's kind: nothing was written. */
      outcome: "circuit-open";
      /** When it closes, epoch ms. */
      until: number;
    }
  | {
      /** The group's budget is spent: nothing was written. */
      outcome: "budget";
      /** The entry that refused it. */
      entry: SummonGroupEntry;
    }
  | {
      /** Every round lost its compare-and-set to another charge: nothing counted. */
      outcome: "contended";
    }
  | {
      /** The entry was written by a newer bun-jobs; left alone, nothing counted. */
      outcome: "newer";
      /** Its shape version. */
      version: number;
    };

/**
 * Counts one attempt for `queue` against the group: re-reads, refuses when
 * the budget is spent, else increments the hour, the day and the queue's
 * share and compare-and-sets, for at most {@link GROUP_CHARGE_ROUNDS} rounds.
 *
 * The budget is checked on the very read the write is conditional on, so of
 * any number of racing charges, in any number of processes, no more land
 * than the limit allows. The limits are written into the entry (or removed
 * with a group budget of `false`), so status can show them from the backend
 * alone.
 */
export async function chargeGroup(
  driver: JobsDriver,
  /** The group's namespace. */
  namespace: string,
  /** The group, resolved: its name and its limits. */
  group: ResolvedSummonGroup,
  options: {
    /** The queue the attempt is for: its share is counted too. */
    queue: string;
    /**
     * The summoner's kind, when the group shares its circuit: an open circuit
     * for it refuses the charge. Unset, the circuit is not read.
     */
    circuitKind?: string;
    /** Told once per call of an entry it replaced or left alone. */
    logger?: Logger;
  },
): Promise<SummonGroupCharge> {
  const ref = summonGroupRef(namespace);
  const name = summonGroupStateName(group.name);
  let warned = false;
  for (let round = 0; round < GROUP_CHARGE_ROUNDS; round++) {
    const now = Date.now();
    const read = readGroupEntry(await driver.getQueueState!(ref, name), now);
    if (read.newer !== undefined) {
      options.logger?.warn(
        "the summon group's entry was written by a newer bun-jobs; this controller leaves it alone and summons nothing for the group",
        { group: group.name, entryVersion: read.newer },
      );
      return { outcome: "newer", version: read.newer };
    }
    if (read.unreadable && !warned) {
      warned = true;
      options.logger?.warn(
        "the summon group's entry is unreadable; starting a fresh one over it",
        { group: group.name },
      );
    }
    const { entry, version } = read;
    if (
      options.circuitKind !== undefined &&
      groupCircuitOpen(entry, options.circuitKind, now)
    ) {
      return {
        outcome: "circuit-open",
        until: entry.circuits![options.circuitKind]!.openUntil!,
      };
    }
    if (groupBudgetSpent(entry, group.budget)) {
      return { outcome: "budget", entry };
    }
    entry.budget.hour++;
    entry.budget.day++;
    const share = entry.queues?.[options.queue];
    entry.queues = {
      ...entry.queues,
      [options.queue]: { day: (share?.day ?? 0) + 1, lastAt: now },
    };
    if (group.budget === false) {
      delete entry.limits;
    } else {
      entry.limits = {
        perHour: group.budget.perHour,
        perDay: group.budget.perDay,
      };
    }
    const written = await setReservedState(driver, ref, name, entry, version);
    if (written !== null) {
      return {
        outcome: "charged",
        entry,
        version: written,
        at: now,
        clears: entry.budget.clears ?? 0,
      };
    }
  }
  return { outcome: "contended" };
}

/**
 * Gives back the one attempt a charge at `chargedAt` counted for `queue`:
 * when its queue's claim was lost, or its provider was never called. Only in
 * windows that are still the charge's (a window that rolled on dropped the
 * count with it), only while no reset has cleared the counts since the
 * charge (the clear dropped it already), never below `0`, for at most
 * {@link GROUP_WRITE_ROUNDS} rounds. Best effort: answers whether it landed, and a refund that does not
 * only over-counts.
 */
export async function refundGroup(
  driver: JobsDriver,
  /** The group's namespace. */
  namespace: string,
  /** The group's name. */
  name: string,
  options: {
    /** The queue the charge was for. */
    queue: string;
    /** When the charge was made, epoch ms: {@link SummonGroupCharge}'s `at`. */
    chargedAt: number;
    /** The clears the charge was made under: {@link SummonGroupCharge}'s `clears`. */
    clears: number;
  },
): Promise<boolean> {
  const ref = summonGroupRef(namespace);
  const stateName = summonGroupStateName(name);
  const hourStart = Math.floor(options.chargedAt / HOUR_MS) * HOUR_MS;
  const dayStart = Math.floor(options.chargedAt / DAY_MS) * DAY_MS;
  for (let round = 0; round < GROUP_WRITE_ROUNDS; round++) {
    const read = readGroupEntry(
      await driver.getQueueState!(ref, stateName),
      Date.now(),
    );
    if (read.newer !== undefined || read.unreadable || read.version === null) {
      // Nothing of ours to give back to.
      return false;
    }
    const { entry, version } = read;
    if ((entry.budget.clears ?? 0) !== options.clears) {
      // Cleared since the charge, and the charge with it.
      return true;
    }
    let changed = false;
    if (entry.budget.hourStart === hourStart && entry.budget.hour > 0) {
      entry.budget.hour--;
      changed = true;
    }
    if (entry.budget.dayStart === dayStart && entry.budget.day > 0) {
      entry.budget.day--;
      changed = true;
      const share = entry.queues?.[options.queue];
      if (share !== undefined && share.day > 0) {
        share.day--;
      }
    }
    if (!changed) {
      return true;
    }
    if (
      (await setReservedState(driver, ref, stateName, entry, version)) !== null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Clears what an operator asks of a group's entry, for at most
 * {@link GROUP_WRITE_ROUNDS} × 2 rounds: with `budget`, the counts of the
 * current hour and day and every queue's share; with `circuit`, that provider
 * kind's shared circuit and its count. Answers whether it landed
 * (`true` when there was nothing to clear); `false` when every round lost
 * its write, or the entry is a newer bun-jobs'.
 */
export async function resetGroup(
  driver: JobsDriver,
  /** The group's namespace. */
  namespace: string,
  /** The group's name. */
  name: string,
  options: {
    /** Zero the budget's counts and the queues' shares. */
    budget?: boolean;
    /**
     * Close the shared circuit of this provider kind, and clear its count;
     * `true` for every kind's.
     */
    circuit?: string | true;
  },
): Promise<boolean> {
  if (options.budget !== true && options.circuit === undefined) {
    return true;
  }
  const ref = summonGroupRef(namespace);
  const stateName = summonGroupStateName(name);
  for (let round = 0; round < GROUP_WRITE_ROUNDS * 2; round++) {
    const read = readGroupEntry(
      await driver.getQueueState!(ref, stateName),
      Date.now(),
    );
    if (read.newer !== undefined) {
      return false;
    }
    if (read.version === null) {
      return true;
    }
    const { entry, version } = read;
    if (options.budget === true) {
      entry.budget.hour = 0;
      entry.budget.day = 0;
      entry.budget.clears = (entry.budget.clears ?? 0) + 1;
      delete entry.queues;
    }
    if (options.circuit === true) {
      delete entry.circuits;
    } else if (options.circuit !== undefined && entry.circuits !== undefined) {
      delete entry.circuits[options.circuit];
    }
    if (
      (await setReservedState(driver, ref, stateName, entry, version)) !== null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * One change a check made to its queue's circuit, replayed on the group's
 * shared circuit once the queue's write has landed.
 */
export type GroupCircuitNote =
  | {
      /** A counted failure: a failed call, a lost attempt, a late loss. */
      type: "failure";
      /** The attempt. */
      id: string;
      /** Its detail, when it had one. */
      detail?: string;
      /** An `auth` or `misconfigured` error: opens the circuit at once. */
      atOnce?: boolean;
    }
  | {
      /** A registration: the consecutive failures start again from `0`. */
      type: "success";
    };

/** What {@link noteGroupCircuit} did. */
export interface GroupCircuitNoted {
  /** Whether the write landed (or there was nothing to write). */
  landed: boolean;
  /**
   * The opening this write made — a circuit closed when it read, open after
   * — or `undefined`: the controller that made it tells `onSummonFailed`.
   */
  opened?: {
    /** When it closes, epoch ms. */
    until: number;
    /** The attempt whose failure opened it. */
    id: string;
    /** That failure's detail. */
    detail?: string;
  };
}

/**
 * Replays a check's circuit changes, in order, on the group's circuit for
 * `kind`: a failure counts one (an `atOnce` one raises the count to the
 * threshold), opening the circuit for `resetAfter` once the count reaches
 * `failures`; a success resets the count, leaving an open circuit to close
 * by time, as a queue's does. One compare-and-set, for at most
 * {@link GROUP_WRITE_ROUNDS} rounds. Best effort: a write that does not land
 * under-counts, and each queue's own circuit is still the backstop.
 */
export async function noteGroupCircuit(
  driver: JobsDriver,
  /** The group's namespace. */
  namespace: string,
  /** The group's name. */
  name: string,
  options: {
    /** The summoner's kind: whose circuit. */
    kind: string;
    /** The queue the changes were seen on. */
    queue: string;
    /** The changes, in the order the check made them. */
    notes: readonly GroupCircuitNote[];
    /** The thresholds: the group's own, else the policy's. */
    failures: number;
    /** How long an opening lasts, in ms. */
    resetAfter: number;
  },
): Promise<GroupCircuitNoted> {
  if (options.notes.length === 0) {
    return { landed: true };
  }
  const ref = summonGroupRef(namespace);
  const stateName = summonGroupStateName(name);
  for (let round = 0; round < GROUP_WRITE_ROUNDS; round++) {
    const now = Date.now();
    const read = readGroupEntry(
      await driver.getQueueState!(ref, stateName),
      now,
    );
    if (read.newer !== undefined) {
      return { landed: false };
    }
    const { entry, version } = read;
    const before = entry.circuits?.[options.kind];
    const wasOpen = groupCircuitOpen(entry, options.kind, now);
    const circuit: SummonGroupCircuit =
      before === undefined ? { failures: 0 } : { ...before };
    let opened: GroupCircuitNoted["opened"];
    for (const note of options.notes) {
      if (note.type === "success") {
        circuit.failures = 0;
        continue;
      }
      circuit.failures = note.atOnce
        ? Math.max(circuit.failures + 1, options.failures)
        : circuit.failures + 1;
      if (circuit.failures >= options.failures) {
        circuit.openUntil = now + options.resetAfter;
        circuit.openedBy = {
          queue: options.queue,
          id: note.id,
          ...(note.detail === undefined ? {} : { detail: note.detail }),
        };
        if (!wasOpen && opened === undefined) {
          opened = {
            until: circuit.openUntil,
            id: note.id,
            ...(note.detail === undefined ? {} : { detail: note.detail }),
          };
        }
      }
    }
    if (opened !== undefined) {
      opened.until = circuit.openUntil!;
    }
    // Nothing changed (a success with nothing counted, most often): no write.
    if (
      (before?.failures ?? 0) === circuit.failures &&
      before?.openUntil === circuit.openUntil
    ) {
      return { landed: true };
    }
    entry.circuits = { ...entry.circuits, [options.kind]: circuit };
    if (
      (await setReservedState(driver, ref, stateName, entry, version)) !== null
    ) {
      return { landed: true, ...(opened === undefined ? {} : { opened }) };
    }
  }
  return { landed: false };
}
