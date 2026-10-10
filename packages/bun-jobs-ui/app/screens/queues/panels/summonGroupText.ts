import type { SummonGroupStatusDto } from "../../../api/types";

/**
 * A summon group in the shapes its views draw: the member queues' shares of
 * today's attempts, in order, and the shared circuit per provider kind. Pure,
 * so the Summon tab's group card and the Summoning screen's groups section
 * read a group the same way.
 *
 * A group arrives redacted to the member queues the caller may read, so
 * nothing here counts the members: a share list is what was charged today by
 * the queues shown, never the whole group.
 */

/** One member queue's share of the group's attempts today. */
export interface GroupShare {
  /** The queue. */
  queue: string;
  /** Attempts it charged to the group this UTC day. */
  day: number;
  /** When it last charged one, epoch ms. */
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
