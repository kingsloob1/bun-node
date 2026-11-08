import type { SummonGroupStatusDto } from "../../../api/types";

/**
 * A summon group in the shapes its views draw: the member queues' shares of
 * today's attempts, in order, and the shared circuit per provider kind. Pure,
 * so the Summon tab's group card and the Summoning screen's groups section
 * read a group the same way.
 *
 * A group arrives redacted to the member queues the caller may read, so
 * nothing here counts the members: a share list is what was charged today by
 * the queues shown, never the whole group. For a shared unit (`unit:
 * "shared"`) a share is the attempts that served the queue, each attempt
 * counted on every queue it served, so the shares do not add up to the
 * group budget's count.
 */

/** One member queue's share of the group's attempts today. */
export interface GroupShare {
  /** The queue. */
  queue: string;
  /**
   * Attempts it charged to the group this UTC day; for a shared unit, the
   * attempts that served it, each also counted on the unit's other queues.
   */
  day: number;
  /** When it last charged one (for a shared unit, when one last served it), epoch ms. */
  lastAt: number;
}

/** The group's shared circuit for one provider kind. */
export interface GroupCircuit {
  /** The provider kind, e.g. `"ecs"`; `undefined` when the summoner's kind is not known here. */
  kind: string | undefined;
  /** Consecutive failures counted across the group for this kind. */
  failures: number;
  /** When the open circuit closes, epoch ms; `undefined` while it is closed. */
  openUntil: number | undefined;
  /** The failure that last opened it, when the group's state names one the caller may read. */
  openedBy: NonNullable<SummonGroupStatusDto["circuit"]>["openedBy"];
}

/**
 * The member queues' shares of today's attempts, most attempts first, then
 * by queue name, so the order is stable between reads.
 */
export function groupShares(group: SummonGroupStatusDto): GroupShare[] {
  return Object.entries(group.queues)
    .map(([queue, share]) => ({ queue, day: share.day, lastAt: share.lastAt }))
    .sort(
      (a, b) =>
        b.day - a.day || (a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0),
    );
}

/**
 * The group's shared circuits, one per provider kind, in kind order: every
 * kind's from `circuits` when the answer has any, else the one `circuit`,
 * keyed by `kind` (the answering summoner's, `undefined` when not known
 * here). Empty when the group shares no circuit, or none has counted a
 * failure yet: there is then nothing to show.
 */
export function groupCircuits(
  group: SummonGroupStatusDto,
  kind: string | undefined,
): GroupCircuit[] {
  const every = Object.entries(group.circuits ?? {});
  if (every.length > 0) {
    return every
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, circuit]) => ({
        kind: name,
        failures: circuit.failures,
        openUntil: circuit.openUntil,
        openedBy: circuit.openedBy,
      }));
  }
  if (group.circuit === undefined) {
    return [];
  }
  return [
    {
      kind,
      failures: group.circuit.failures,
      openUntil: group.circuit.openUntil,
      openedBy: group.circuit.openedBy,
    },
  ];
}

/** A circuit's kind as a label: the kind, or "this summoner" when it is not known here. */
export function circuitKindLabel(kind: string | undefined): string {
  return kind === undefined || kind === "" ? "this summoner" : kind;
}

/**
 * Whether a group is one shared unit (`unit: "shared"`): one summoned
 * process serves every queue in it. Its shares then count each attempt on
 * every member queue it served, so they do not add up to the group budget's
 * count; a per-queue group's are each queue's own charges.
 */
export function groupIsShared(
  group: Pick<SummonGroupStatusDto, "unit">,
): boolean {
  return group.unit === "shared";
}

/** The tooltip of a shared unit's mark, on the group card and the groups list. */
export const SHARED_UNIT_TITLE =
  "One summoned process serves every queue of this group.";

/** The Summoning screen's groups list: what a group's Unit cell says. */
export function groupUnitLabel(
  group: Pick<SummonGroupStatusDto, "unit">,
): string {
  return groupIsShared(group) ? "Shared" : "Per queue";
}

/** How the group card words its shares of today's attempts. */
export interface GroupSharesText {
  /** The shares' subheading. */
  heading: string;
  /** A note under the subheading; `undefined` for a per-queue group, which needs none. */
  note: string | undefined;
  /** The line shown when no queue has a share today. */
  empty: string;
  /** The share table's accessible name. */
  tableLabel: string;
}

/**
 * The group card's words for its shares: a per-queue group's are the
 * attempts each queue charged to it; a shared unit's are the attempts that
 * served each queue, each attempt counted on every queue it served.
 */
export function groupSharesText(
  group: Pick<SummonGroupStatusDto, "name" | "unit">,
): GroupSharesText {
  return groupIsShared(group)
    ? {
        heading: "Attempts serving each queue today",
        note: "One attempt serves every queue of the unit, so each counts it: these do not add up to the group's budget.",
        empty: "No attempts served the unit's queues today.",
        tableLabel: `Attempts serving each queue of the group ${group.name} today`,
      }
    : {
        heading: "Charged today",
        note: undefined,
        empty: "No attempts charged to the group today.",
        tableLabel: `Attempts charged to the group ${group.name} today`,
      };
}

/** The Summoning screen's groups list: the header of each group's shares of today's attempts. */
export const GROUPS_TODAY_HEADER = "Today, per queue";

/** That header's tooltip: what a count means for each kind of group. */
export const GROUPS_TODAY_TITLE =
  "For a per-queue group, each count is the attempts that queue charged to the group today. For a shared unit, each attempt is counted on every queue it served, so the counts do not add up to the group's.";

/** The muted note in a shared unit's "Today, per queue" cell. */
export const SHARED_UNIT_ROW_NOTE = "each attempt serves every queue";
