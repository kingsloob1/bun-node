import type {
  SummonCheckDto,
  SummonEventDto,
  SummonOutcomeKind,
  SummonReason,
  SummonSkipReason,
  SummonStatusDto,
} from "../../../api/types";
import type { BadgeTone } from "../../../components/Badge";
import { displayText, formatNumber, plural } from "../../../format";

/**
 * A queue's summoning in plain words: attempt outcomes, why a check ran, why
 * one did not summon, and why a controller is inert.
 *
 * Each table is an exhaustive record of the values the contract lists, so a
 * value added there is a compile error here until it is named; and each
 * lookup shows a value this build does not know as its raw string, since the
 * contract says a later server may add one.
 */

/** What an outcome means and how it is shown. */
interface OutcomeText {
  /** In plain words. */
  label: string;
  /** Its badge colour. */
  tone: BadgeTone;
  /** What it means, for a tooltip. */
  hint: string;
}

/** Each summon attempt outcome. */
const OUTCOMES: Readonly<Record<SummonOutcomeKind, OutcomeText>> = {
  started: {
    label: "Started",
    tone: "info",
    hint: "The summoner started compute. It counts as a worker on its way until one registers or the boot budget runs out.",
  },
  deduped: {
    label: "Deduplicated",
    tone: "neutral",
    hint: "The platform recognised a retried call and started nothing new.",
  },
  "already-running": {
    label: "Already running",
    tone: "neutral",
    hint: "The platform reported the compute already running.",
  },
  registered: {
    label: "Registered",
    tone: "success",
    hint: "A summoned worker registered: the attempt did its job.",
  },
  unavailable: {
    label: "Unavailable",
    tone: "warning",
    hint: "The platform had no capacity to start one.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    hint: "The summoner's call failed. Counts towards the backoff and the circuit.",
  },
  lost: {
    label: "Lost",
    tone: "danger",
    hint: "No worker registered within the boot budget. Counts towards the backoff and the circuit.",
  },
  "budget-exhausted": {
    label: "Budget exhausted",
    tone: "warning",
    hint: "The hourly or daily attempt budget is used up: nothing is summoned until it resets.",
  },
  released: {
    label: "Released",
    tone: "neutral",
    hint: "A scale-style summoner was set back to zero.",
  },
};

/** Why a check ran. */
const REASONS: Readonly<Record<SummonReason, string>> = {
  add: "a job was added",
  event: "another process's event",
  poll: "the periodic check",
  schedule: "a schedule",
  manual: "a manual summon",
  timer: "a delayed job coming due",
};

/** Why a check did not summon. */
const SKIPS: Readonly<Record<SummonSkipReason, string>> = {
  served: "enough workers are running or on their way",
  pending: "attempts already on their way cover the demand",
  cooldown: "the cooldown since the last attempt has not passed",
  backoff: "it is backing off after a failure",
  "circuit-open": "the circuit is open after repeated failures",
  budget: "the attempt budget is used up",
  contended: "another controller summoned at the same moment",
  closed: "the controller is closing",
  inert: "the controller is inert",
};

/** Why a controller is inert. */
const INERT: Readonly<
  Record<NonNullable<SummonStatusDto["inertReason"]>, string>
> = {
  "summoned-process":
    "The API's own process was summoned (or is a runner child), and the policy does not allow summoning from one, so this controller summons nothing.",
  "newer-marker":
    "A newer version of bun-jobs wrote this queue's summon state, so this controller leaves it alone and summons nothing.",
};

/** Each summoner style in plain words. */
const STYLES: Readonly<
  Record<
    NonNullable<SummonStatusDto["summoner"]>["capabilities"]["style"],
    string
  >
> = {
  launch: "Launch: starts new units",
  scale: "Scale: sets a count",
  wake: "Wake: starts one of a fixed pool",
};

/** Whether `key` is an own key of `table` (so `"toString"` is not). */
function known<K extends string>(
  table: Readonly<Record<K, unknown>>,
  key: unknown,
): key is K {
  return typeof key === "string" && Object.hasOwn(table, key);
}

/** An outcome in plain words, with its tone and meaning; a raw string for one this build does not know. */
export function summonOutcome(outcome: SummonOutcomeKind): OutcomeText {
  return known(OUTCOMES, outcome)
    ? OUTCOMES[outcome]
    : {
        label: displayText(outcome),
        tone: "neutral",
        hint: "An outcome this version of the UI does not know.",
      };
}

/** Why a check ran, in words; a raw string for a reason this build does not know. */
export function summonReason(reason: SummonReason): string {
  return known(REASONS, reason) ? REASONS[reason] : displayText(reason);
}

/** Why a check did not summon, in words; a raw string for one this build does not know. */
export function summonSkip(reason: SummonSkipReason): string {
  return known(SKIPS, reason) ? SKIPS[reason] : displayText(reason);
}

/** Why a controller is inert, in a sentence. */
export function summonInert(reason: SummonStatusDto["inertReason"]): string {
  if (reason === undefined) {
    return "This controller is inert: it summons nothing.";
  }
  return known(INERT, reason)
    ? INERT[reason]
    : `This controller is inert ("${displayText(reason)}"): it summons nothing.`;
}

/** A summoner style in words; a raw string for one this build does not know. */
export function summonStyle(
  style: NonNullable<SummonStatusDto["summoner"]>["capabilities"]["style"],
): string {
  return known(STYLES, style) ? STYLES[style] : displayText(style);
}

/** A `summon` event's payload in one line, e.g. "Started 1 worker (ecs), because a job was added". */
export function summonEventSummary(event: SummonEventDto): string {
  const outcome = summonOutcome(event.outcome).label;
  const workers =
    typeof event.count === "number" ? ` ${plural(event.count, "worker")}` : "";
  const kind = event.kind ? ` (${displayText(event.kind)})` : "";
  const reason =
    event.reason === undefined ? "" : `, because ${summonReason(event.reason)}`;
  const detail =
    event.detail === undefined ? "" : `: ${displayText(event.detail)}`;
  return `${outcome}${workers}${kind}${reason}${detail}`;
}

/** Whether a queue event's payload is a summon event's. */
export function isSummonEvent(payload: unknown): payload is SummonEventDto {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { outcome?: unknown }).outcome === "string" &&
    typeof (payload as { kind?: unknown }).kind === "string"
  );
}

/** What "summon now" did, for its toast. */
export function summonCheckSummary(result: SummonCheckDto): string {
  switch (result.action) {
    case "summoned": {
      const outcome =
        result.outcome === undefined
          ? "Summoned"
          : summonOutcome(result.outcome).label;
      return `${outcome}: attempt ${displayText(result.id ?? "")}`;
    }
    case "skipped":
      return `Nothing summoned: ${
        result.reason === undefined
          ? "a guard held it back"
          : summonSkip(result.reason)
      }`;
    case "released":
      return "Released: the summoner was set back to zero";
    case "none":
      return result.demand === undefined
        ? "Nothing to summon"
        : `Nothing to summon: demand is ${formatNumber(result.demand.demand)}`;
    default:
      return `Summon check: ${displayText(result.action)}`;
  }
}

/**
 * Whether "summon now" and reset are offered: the caller may (`queues.summon`,
 * not read-only) **and** the controller runs in the API's process. A status
 * read from another process's controller (`local: false`) is read-only, since
 * both actions need a controller here.
 */
export function summonActionsOffered(
  status: Pick<SummonStatusDto, "local">,
  canSummon: boolean,
): boolean {
  return canSummon && status.local;
}
