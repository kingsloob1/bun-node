import type { JobsDriver } from "../drivers/index";
import type {
  ResolvedGroupCircuit,
  SummonGroupEntry,
  SummonGroupLimits,
} from "./group";
import type { SummonGroupStatus, SummonStatus } from "./types";
import {
  readGroupEntry,
  SUMMON_GROUP_PREFIX,
  summonGroupRef,
  summonGroupStateName,
} from "./group";
import {
  budgetResets,
  DAY_MS,
  HOUR_MS,
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
}

/**
 * A queue's summon status from its marker alone, with its group's when the
 * marker names one; `undefined` when the queue has no summon state (no
 * controller has ever written it). The budget's limits are the last claim's
 * (`off: true` for a budget that was off, none when no claim persisted them);
 * a marker a newer bun-jobs wrote answers `inert` with `newer-marker` and
 * nothing it cannot read.
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
      status: {
        queue,
        local: false,
        inert: newer !== undefined,
        ...(newer === undefined ? {} : { inertReason: "newer-marker" }),
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
            ? {}
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
  return groupStatus(name, entry, now, view);
}

/** Shapes a group's entry as a status, as {@link readStoredGroupStatus} describes. */
function groupStatus(
  name: string,
  entry: SummonGroupEntry,
  now: number,
  view: { local?: LocalGroupView; kind?: string },
): SummonGroupStatus {
  const limits: SummonGroupLimits | false =
    view.local === undefined ? (entry.limits ?? false) : view.local.budget;
  const kind = view.local?.kind ?? view.kind;
  const showCircuit =
    view.local === undefined
      ? kind !== undefined && entry.circuits?.[kind] !== undefined
      : view.local.circuit !== false;
  const circuits = entry.circuits ?? {};
  return {
    name,
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
}

/** A group's circuit for `kind`, as status shows it: an expired opening is left out. */
function circuitStatus(
  entry: SummonGroupEntry,
  kind: string,
  now: number,
): NonNullable<SummonGroupStatus["circuit"]> {
  const circuit = entry.circuits?.[kind];
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
