import type { JobsDriver } from "../drivers/index";
import type {
  ResolvedGroupCircuit,
  SharedSummonMarker,
  SummonGroupEntry,
  SummonGroupLimits,
} from "./group";
import type { SummonGroupStatus, SummonStatus } from "./types";
import { withCoverage } from "./coverage";
import {
  ownValue,
  readGroupEntry,
  readSharedMarker,
  SUMMON_GROUP_PREFIX,
  summonGroupRef,
  summonGroupStateName,
} from "./group";
import {
  budgetResets,
  DAY_MS,
  HOUR_MS,
  isSummonMarker,
  newerMarkerVersion,
  readMarker,
  rollBudget,
  SUMMON_MARKER,
} from "./marker";

/**
 * Summon status read from storage alone (plan summon-multi-queue §5.1): what
 * a process with no controller for a queue — the management API, most often
 * — can show of the queue's marker and of a summon group's entry. Every
 * claim persists its controller's `kind`, budget `limits` and `group` on the
 * marker, and every group charge its limits on the entry, so nothing here
 * needs a policy.
 *
 * Reads only. Internal: nothing here is exported from the package.
 */

/** A queue's summon status read from storage, and the summoner kind it names. */
export interface StoredSummonStatus {
  /** The status, `local: false`. */
  status: SummonStatus;
  /** The `kind` the last claim persisted, when one did. */
  kind?: string;
  /**
   * `true` when the marker is neither this build's shape nor a newer one's:
   * `status` then holds nothing read from it (no budget, no failures, inert
   * with `unreadable-marker`), so a list leaves the queue out rather than
   * show zeros.
   */
  unreadable?: true;
  /**
   * When the state's last attempt was claimed, epoch ms, by the claiming
   * controller's clock: what decides between a queue's own marker and a
   * shared unit's entry naming the queue ({@link sharedUnitAnswers}).
   * Absent when no attempt was ever claimed, or the state could not be read.
   */
  lastAttemptAt?: number;
}

/**
 * A queue's summon status from its marker alone, with its group's when the
 * marker names one; `undefined` when the queue has no summon state (no
 * controller has ever written it). The budget's limits are the last claim's
 * (`off: true` for a budget that was off, `limitsUnknown: true` when no claim
 * persisted them); a marker a newer bun-jobs wrote answers `inert` with
 * `newer-marker` and no budget, and an unreadable one `unreadable: true`,
 * `inert` with `unreadable-marker` and nothing read from it — never what
 * would read as a healthy, idle queue. The group, when there is one, is
 * unfiltered: a caller serving it redacts what its reader may not see.
 */
export async function readStoredSummonStatus(
  driver: JobsDriver,
  /** The queue's namespace. */
  namespace: string,
  /** The queue. */
  queue: string,
  /** The time to read windows and expiries at, epoch ms. */
  now: number,
): Promise<StoredSummonStatus | undefined> {
  const stored = await driver.getQueueState!(
    { ns: namespace, queue },
    SUMMON_MARKER,
  );
  if (stored === null) {
    return undefined;
  }
  const { marker, newer, unreadable } = readMarker(stored, now);
  if (newer !== undefined || unreadable) {
    return {
      ...(unreadable ? { unreadable: true as const } : {}),
      status: {
        queue,
        local: false,
        inert: true,
        inertReason: newer === undefined ? "unreadable-marker" : "newer-marker",
        pending: [],
        failures: 0,
      },
    };
  }
  rollBudget(marker, now);
  const limits = marker.limits;
  const group =
    marker.group === undefined
      ? undefined
      : await readStoredGroupStatus(driver, namespace, marker.group, now, {
          kind: marker.kind,
        });
  return {
    ...(marker.kind === undefined ? {} : { kind: marker.kind }),
    ...(marker.lastAttemptAt === undefined
      ? {}
      : { lastAttemptAt: marker.lastAttemptAt }),
    status: {
      queue,
      local: false,
      inert: false,
      pending: marker.pending,
      failures: marker.failures,
      ...(marker.backoffUntil !== undefined && marker.backoffUntil > now
        ? { backoffUntil: marker.backoffUntil }
        : {}),
      ...(marker.circuitOpenUntil !== undefined && marker.circuitOpenUntil > now
        ? { circuitOpenUntil: marker.circuitOpenUntil }
        : {}),
      budget: {
        hour: marker.budget.hour,
        ...(limits === undefined || limits === false
          ? {}
          : { perHour: limits.perHour }),
        day: marker.budget.day,
        ...(limits === false
          ? { off: true as const }
          : limits === undefined
            ? // Written before claims persisted limits: the counts are
              // real, the limits unknown — never shown as "off".
              { limitsUnknown: true as const }
            : { perDay: limits.perDay }),
        ...budgetResets(marker),
      },
      ...(marker.last === undefined ? {} : { last: marker.last }),
      ...(group === undefined ? {} : { group }),
    },
  };
}

/** What a reader that has a policy for the group knows: a local controller's. */
export interface LocalGroupView {
  /** Its group's limits. */
  budget: SummonGroupLimits | false;
  /** Whether its group shares the circuit. */
  circuit: ResolvedGroupCircuit;
  /** Its summoner's kind. */
  kind: string;
  /** `"shared"` when the controller is the group's shared unit; absent for a per-queue one. */
  unit?: "shared";
}

/**
 * The queues a shared unit's entry persisted (`members`), by the group
 * status read from it: what the management API asks `authorize` about
 * besides the shares, which empty at UTC midnight. Weak, so it goes with the
 * status. Internal: read through {@link storedGroupMembersOf}.
 */
const GROUP_MEMBERS = new WeakMap<SummonGroupStatus, readonly string[]>();

/**
 * The queues a shared unit's last claim persisted on the group's entry
 * behind `group` (a status {@link readStoredGroupStatus} answered), in its
 * policy's order; empty for any other group, and for an entry no claim of
 * this version has written.
 */
export function storedGroupMembersOf(
  group: SummonGroupStatus,
): readonly string[] {
  return GROUP_MEMBERS.get(group) ?? [];
}

/**
 * A summon group's status from its entry. With `local` (a controller's own
 * view) the limits and the circuit of its kind are its policy's, and the
 * status is answered even before the entry exists; without, the limits are
 * the ones the last charge persisted (`off: true` when that charge's group
 * budget was off), `circuit` is the circuit of `kind` when one was given and
 * the entry holds it, and `undefined` answers a group with no entry. Every
 * kind's circuit the entry holds is in `circuits` either way.
 */
export async function readStoredGroupStatus(
  driver: JobsDriver,
  /** The group's namespace. */
  namespace: string,
  /** The group's name. */
  name: string,
  /** The time to read windows and expiries at, epoch ms. */
  now: number,
  view: {
    /** A local controller's view of the group, if there is one. */
    local?: LocalGroupView;
    /** For a reader without one: the kind whose circuit `circuit` shows. */
    kind?: string;
  } = {},
): Promise<SummonGroupStatus | undefined> {
  const stored = await driver.getQueueState!(
    summonGroupRef(namespace),
    summonGroupStateName(name),
  );
  if (stored === null && view.local === undefined) {
    return undefined;
  }
  const { entry, newer } = readGroupEntry(stored, now);
  if (newer !== undefined && view.local === undefined) {
    return undefined;
  }
  // Only a shared unit writes marker fields into the group's entry, and
  // per-queue charges keep them as they find them: a current unit is told
  // by its claims, not by those fields alone (`currentUnitMembers`).
  const members =
    newer === undefined && stored !== null && isSummonMarker(stored.value)
      ? currentUnitMembers(readSharedMarker(stored, now).marker)
      : undefined;
  return groupStatus(name, entry, now, {
    ...view,
    shared: members !== undefined,
    ...(members === undefined ? {} : { members }),
  });
}

/**
 * The queues of the shared unit a group's entry holds, when the entry shows
 * one is current; `undefined` when it does not. Per-queue controllers keep a
 * unit's marker fields as they find them, so the fields alone would call a
 * group a unit for good after it switched back. The evidence is the unit's
 * last claim (`lastAttemptAt`), which stamps every member's share with its
 * own time:
 *
 * - **With persisted `members`**: those, less each one a per-queue
 *   controller has charged since that claim (its share's `lastAt` after it):
 *   that queue has a controller of its own again, whose own marker answers
 *   for it. The unit stays current while any member is left, so one replica
 *   charging during a rolling deploy hides only its own queue, and a group
 *   switched back entirely ends with none.
 * - **Without** (an entry an earlier build's unit wrote): the queues whose
 *   share carries exactly that claim's time, in code-point order — a
 *   per-queue member of a mixed group, charged at another time, is not one.
 *
 * Shares empty at UTC midnight, so until a per-queue controller charges
 * again that day, a group switched back still carries the `unit` label (its
 * members' own newer markers still answer for them, by
 * {@link sharedUnitAnswers}); a unit whose `members` predate this build is
 * not read at all once its shares have gone, until its next claim.
 */
export function currentUnitMembers(
  /** The entry as a shared marker, read and rolled. */
  marker: SharedSummonMarker,
): string[] | undefined {
  const claimedAt = marker.lastAttemptAt;
  if (claimedAt === undefined) {
    return undefined;
  }
  const shares = marker.queues ?? {};
  if (marker.members !== undefined) {
    const current = marker.members.filter(
      (queue) => (ownValue(shares, queue)?.lastAt ?? claimedAt) <= claimedAt,
    );
    return current.length === 0 ? undefined : current;
  }
  const stamped = Object.keys(shares)
    .filter((queue) => ownValue(shares, queue)!.lastAt === claimedAt)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return stamped.length === 0 ? undefined : stamped;
}

/**
 * Shapes a group's entry as a status, as {@link readStoredGroupStatus}
 * describes. `unit: "shared"` from a local controller's view when there is
 * one (its policy says), else when the entry is a shared unit's (`shared`).
 */
function groupStatus(
  name: string,
  entry: SummonGroupEntry,
  now: number,
  view: {
    local?: LocalGroupView;
    kind?: string;
    shared?: boolean;
    members?: readonly string[] | undefined;
  },
): SummonGroupStatus {
  const limits: SummonGroupLimits | false =
    view.local === undefined ? (entry.limits ?? false) : view.local.budget;
  const kind = view.local?.kind ?? view.kind;
  const showCircuit =
    view.local === undefined
      ? kind !== undefined && ownValue(entry.circuits, kind) !== undefined
      : view.local.circuit !== false;
  const circuits = entry.circuits ?? {};
  const unit =
    view.local === undefined
      ? view.shared === true
      : view.local.unit === "shared";
  const status: SummonGroupStatus = {
    name,
    ...(unit ? { unit: "shared" as const } : {}),
    budget: {
      hour: entry.budget.hour,
      ...(limits === false ? {} : { perHour: limits.perHour }),
      day: entry.budget.day,
      ...(limits === false
        ? { off: true as const }
        : { perDay: limits.perDay }),
      hourResetsAt: entry.budget.hourStart + HOUR_MS,
      dayResetsAt: entry.budget.dayStart + DAY_MS,
    },
    queues: Object.fromEntries(
      Object.entries(entry.queues ?? {}).map(([queue, share]) => [
        queue,
        { day: share.day, lastAt: share.lastAt },
      ]),
    ),
    ...(showCircuit && kind !== undefined
      ? { circuit: circuitStatus(entry, kind, now) }
      : {}),
    ...(Object.keys(circuits).length === 0
      ? {}
      : {
          circuits: Object.fromEntries(
            Object.keys(circuits).map((one) => [
              one,
              circuitStatus(entry, one, now),
            ]),
          ),
        }),
  };
  if (view.members !== undefined && view.members.length > 0) {
    GROUP_MEMBERS.set(status, view.members);
  }
  return status;
}

/** A group's circuit for `kind`, as status shows it: an expired opening is left out. */
function circuitStatus(
  entry: SummonGroupEntry,
  kind: string,
  now: number,
): NonNullable<SummonGroupStatus["circuit"]> {
  const circuit = ownValue(entry.circuits, kind);
  return {
    failures: circuit?.failures ?? 0,
    ...(circuit?.openUntil !== undefined && circuit.openUntil > now
      ? { openUntil: circuit.openUntil }
      : {}),
    ...(circuit?.openedBy === undefined
      ? {}
      : { openedBy: { ...circuit.openedBy } }),
  };
}

/**
 * The names of every summon group with an entry in the namespace, in
 * code-point order: `listQueueState` on the pseudo-queue, a page at a time.
 * Groups are few (one per budget), so every one is listed.
 */
export async function listSummonGroupNames(
  driver: JobsDriver,
  /** The namespace. */
  namespace: string,
): Promise<string[]> {
  const names: string[] = [];
  let after: string | undefined;
  const page = 500;
  for (;;) {
    const listed = await driver.listQueueState!(summonGroupRef(namespace), {
      prefix: SUMMON_GROUP_PREFIX,
      limit: page,
      ...(after === undefined ? {} : { after }),
    });
    names.push(
      ...listed.map((stateName) => stateName.slice(SUMMON_GROUP_PREFIX.length)),
    );
    if (listed.length < page) {
      return names;
    }
    after = listed.at(-1);
  }
}

/** A shared unit read from its group's entry alone: what a process with no controller for it can show. */
export interface StoredSharedUnit {
  /** The group's name: the unit's (`group.name`). */
  group: string;
  /**
   * The queues it serves, in its policy's order, as its last claim
   * persisted them; for an entry written before claims persisted them, the
   * queues with a share today, in code-point order.
   */
  members: readonly string[];
  /** Its status, `local: false`, with no `coverage` on its attempts. */
  status: SummonStatus;
  /** The `kind` its last claim persisted, when one did. */
  kind?: string;
  /** When its last attempt was claimed, epoch ms, by its controller's clock. */
  lastAttemptAt?: number;
}

/**
 * Every shared unit with state in the namespace, read from storage alone
 * (plan summon-multi-queue B4, C3): the namespace's group entries listed,
 * then each read once, and those a shared unit wrote (`isSummonMarker`: only
 * a shared controller writes marker fields into a group's entry) shaped as
 * its status. Left out: an entry a newer bun-jobs wrote, one of a group of
 * per-queue controllers, and a unit that names no queue (no claim has
 * persisted its queues, and no queue has a share today). No claim or record
 * is read: {@link withCoverage} adds a unit's coverage when it is wanted.
 *
 * The budget's limits are the group's own, which every claim persists
 * (`off` when absent): a stricter `budget` in the unit's policy is known only
 * to its controller (Q6). The circuit is the later of the unit's own and the
 * group's circuit for its kind, as `controller.status()` has it.
 */
export async function readStoredSharedUnits(
  driver: JobsDriver,
  /** The namespace. */
  namespace: string,
  /** The time to read windows and expiries at, epoch ms. */
  now: number,
): Promise<StoredSharedUnit[]> {
  if (typeof driver.listQueueState !== "function") {
    return [];
  }
  const names = await listSummonGroupNames(driver, namespace);
  const entries = await Promise.all(
    names.map(
      async (name) =>
        await driver.getQueueState!(
          summonGroupRef(namespace),
          summonGroupStateName(name),
        ),
    ),
  );
  const units: StoredSharedUnit[] = [];
  for (const [index, stored] of entries.entries()) {
    if (
      stored === null ||
      newerMarkerVersion(stored.value) !== undefined ||
      !isSummonMarker(stored.value)
    ) {
      continue;
    }
    const unit = sharedUnitOf(
      names[index]!,
      readSharedMarker(stored, now).marker,
      now,
    );
    if (unit !== undefined) {
      units.push(unit);
    }
  }
  return units;
}

/** One shared unit's entry, read and rolled, as {@link readStoredSharedUnits} shapes it. */
function sharedUnitOf(
  name: string,
  marker: SharedSummonMarker,
  now: number,
): StoredSharedUnit | undefined {
  const members = currentUnitMembers(marker);
  if (members === undefined) {
    return undefined;
  }
  const kind = marker.kind;
  const circuitOpenUntil = Math.max(
    marker.circuitOpenUntil ?? 0,
    kind === undefined ? 0 : (ownValue(marker.circuits, kind)?.openUntil ?? 0),
  );
  const limits = marker.limits;
  const group = groupStatus(name, marker as unknown as SummonGroupEntry, now, {
    ...(kind === undefined ? {} : { kind }),
    shared: true,
    members,
  });
  return {
    group: name,
    members,
    ...(kind === undefined ? {} : { kind }),
    ...(marker.lastAttemptAt === undefined
      ? {}
      : { lastAttemptAt: marker.lastAttemptAt }),
    status: {
      queue: members[0]!,
      queues: [...members],
      local: false,
      inert: false,
      pending: marker.pending,
      failures: marker.failures,
      ...(marker.backoffUntil !== undefined && marker.backoffUntil > now
        ? { backoffUntil: marker.backoffUntil }
        : {}),
      ...(circuitOpenUntil > now ? { circuitOpenUntil } : {}),
      budget: {
        hour: marker.budget.hour,
        ...(limits === undefined || limits === false
          ? {}
          : { perHour: limits.perHour }),
        day: marker.budget.day,
        ...(limits === undefined || limits === false
          ? { off: true as const }
          : { perDay: limits.perDay }),
        ...budgetResets(marker),
      },
      ...(marker.last === undefined ? {} : { last: marker.last }),
      group,
    },
  };
}

/**
 * Whether a shared unit naming a queue answers for it rather than the
 * queue's own marker: when the queue has no readable marker of its own, or
 * the unit's last claim is at or after the marker's. A queue switched from a
 * shared unit back to a controller of its own is then answered by its own
 * marker once that claims, and the other way round. Both times come from
 * controllers' clocks, and a stale entry is minutes to hours older, so a
 * skew between them does not matter here.
 */
export function sharedUnitAnswers(
  /** The unit. */
  unit: Pick<StoredSharedUnit, "lastAttemptAt">,
  /** The queue's own stored status, if it has one. */
  own:
    | Pick<StoredSummonStatus, "lastAttemptAt" | "unreadable" | "status">
    | undefined,
): boolean {
  // Garbage holds no claim: the unit answers.
  if (own === undefined || own.unreadable === true) {
    return true;
  }
  if (own.lastAttemptAt === undefined) {
    // A newer bun-jobs' marker this build cannot date: its writer is alive
    // and newer than this reader, so it answers (`inert`, `newer-marker`)
    // rather than a unit that may be stale. A marker of this build with no
    // claim yet loses to any unit that has claimed.
    return own.status.inertReason !== "newer-marker";
  }
  return (unit.lastAttemptAt ?? Number.NEGATIVE_INFINITY) >= own.lastAttemptAt;
}

/**
 * The shared unit of `units` that names `queue` and claimed last, if any:
 * one queue in two units (an overlap) is answered by the more recent, and
 * of two that claimed at the same time, by the group first in code-point
 * order.
 */
export function sharedUnitFor(
  units: readonly StoredSharedUnit[],
  /** The queue. */
  queue: string,
): StoredSharedUnit | undefined {
  let found: StoredSharedUnit | undefined;
  for (const unit of units) {
    if (!unit.members.includes(queue)) {
      continue;
    }
    const at = unit.lastAttemptAt ?? Number.NEGATIVE_INFINITY;
    const best = found?.lastAttemptAt ?? Number.NEGATIVE_INFINITY;
    if (
      found === undefined ||
      at > best ||
      (at === best && unit.group < found.group)
    ) {
      found = unit;
    }
  }
  return found;
}

/**
 * The members `unit` answers for, in its order: each one whose own marker
 * does not answer for itself ({@link sharedUnitAnswers}) and that no other
 * unit of `units` answers for ({@link sharedUnitFor}). What `GET /summon`
 * lists a remote unit with, and what `GET /queues/<member>/summon` names as
 * its `queues`, so the two agree.
 */
export function answeredMembers(
  unit: StoredSharedUnit,
  /** Every unit read with it. */
  units: readonly StoredSharedUnit[],
  /** Each member's own stored status, by queue (absent: none). */
  own: ReadonlyMap<string, StoredSummonStatus | undefined>,
): string[] {
  return unit.members.filter(
    (queue) =>
      sharedUnitFor(units, queue) === unit &&
      sharedUnitAnswers(unit, own.get(queue)),
  );
}

/**
 * A queue's summon status from storage alone, a shared unit's included: the
 * queue's own marker ({@link readStoredSummonStatus}), unless a shared unit
 * naming the queue answers for it ({@link sharedUnitAnswers}) — then the
 * unit's status, its `queues` the members it answers for
 * ({@link answeredMembers}, as `GET /summon` lists them) and its attempts
 * with their `coverage` on those. `undefined` when neither has state.
 * Coverage is best effort: `onCoverageError` hears a failed read, and the
 * status is answered without it.
 */
export async function readStoredQueueSummon(
  driver: JobsDriver,
  /** The queue's namespace. */
  namespace: string,
  /** The queue. */
  queue: string,
  /** The time to read windows and expiries at, epoch ms. */
  now: number,
  /** Told of a failed coverage read. */
  onCoverageError?: (error: unknown) => void,
): Promise<StoredSummonStatus | undefined> {
  const [own, units] = await Promise.all([
    readStoredSummonStatus(driver, namespace, queue, now),
    readStoredSharedUnits(driver, namespace, now),
  ]);
  const unit = sharedUnitFor(units, queue);
  if (unit === undefined || !sharedUnitAnswers(unit, own)) {
    return own;
  }
  // The other members' own markers, so `queues` leaves out a member that
  // answers for itself, as the list does.
  const others = unit.members.filter((member) => member !== queue);
  const stored = await Promise.all(
    others.map(
      async (member) =>
        await readStoredSummonStatus(driver, namespace, member, now),
    ),
  );
  const members = answeredMembers(
    unit,
    units,
    new Map<string, StoredSummonStatus | undefined>([
      [queue, own],
      ...others.map((member, index) => [member, stored[index]] as const),
    ]),
  );
  return {
    ...(unit.kind === undefined ? {} : { kind: unit.kind }),
    ...(unit.lastAttemptAt === undefined
      ? {}
      : { lastAttemptAt: unit.lastAttemptAt }),
    status: {
      ...unit.status,
      queue: members[0]!,
      queues: members,
      pending: await withCoverage(
        driver,
        namespace,
        members,
        unit.status.pending,
        now,
        onCoverageError,
      ),
    },
  };
}
