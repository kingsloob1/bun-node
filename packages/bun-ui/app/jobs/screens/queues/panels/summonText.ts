import type {
  PendingSummonDto,
  SummonCheckDto,
  SummonEventDto,
  SummonLastOutcomeDto,
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
    hint: "The platform could not start one now: no capacity, a throttled call or a spent quota. It counts towards the backoff and the circuit, except a throttle, which only waits the platform's retry time.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    hint: "The summoner's call failed. Counts towards the backoff and the circuit, and an auth or misconfiguration error opens the circuit at once. A call that timed out stays on its way, and counts only if no worker registers in time.",
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
    "A newer version of bun-jobs wrote this queue's summon state: this version leaves it alone, summons nothing for it and cannot read its budget.",
  "unreadable-marker":
    "This queue's summon state cannot be read: it is not in a shape any version of bun-jobs writes, so its attempts, failures and budget are unknown here.",
};

/** A summoner's style, from its capabilities (known once the summoner is ready). */
type SummonStyle = NonNullable<
  NonNullable<SummonStatusDto["summoner"]>["capabilities"]
>["style"];

/** Each summoner style in plain words. */
const STYLES: Readonly<Record<SummonStyle, string>> = {
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

/**
 * Whether a status's summon state was read, so its attempts on their way,
 * consecutive failures, backoff, circuit and budget are facts worth showing.
 *
 * Not for `inertReason: "unreadable-marker"`: the server could not read the
 * queue's summon state at all, and answers `pending: []` and `failures: 0`
 * as placeholders, not as counts. Shown, they would read as "nothing on its
 * way, no failures", which nobody knows. Every other status, inert or not,
 * carries what was read.
 */
export function summonStateKnown(
  status: Pick<SummonStatusDto, "inertReason">,
): boolean {
  return status.inertReason !== "unreadable-marker";
}

/** A summoner style in words; a raw string for one this build does not know. */
export function summonStyle(style: SummonStyle): string {
  return known(STYLES, style) ? STYLES[style] : displayText(style);
}

/**
 * A list of names from an event payload, which arrives unchecked: each made
 * safe as text, `[]` for anything but an array.
 */
function nameList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((name) => displayText(name)) : [];
}

/**
 * A `summon` event's payload in one line, e.g. "Started 1 worker (ecs),
 * because a job was added". A shared unit's event names the queues it
 * serves (`queues`, as many as the connection may see) and the ones its
 * attempt registered no worker on (`missing`): "Registered 1 worker (ecs),
 * for renders, thumbs; missing previews". The `partial:<queues>` detail
 * such an event carries says what `missing` says, so it is left out then.
 */
export function summonEventSummary(event: SummonEventDto): string {
  const outcome = summonOutcome(event.outcome).label;
  const workers =
    typeof event.count === "number" ? ` ${plural(event.count, "worker")}` : "";
  const kind = event.kind ? ` (${displayText(event.kind)})` : "";
  const reason =
    event.reason === undefined ? "" : `, because ${summonReason(event.reason)}`;
  const queues = nameList(event.queues);
  const missing = nameList(event.missing);
  const unit = queues.length > 0 ? `, for ${queues.join(", ")}` : "";
  const absent = missing.length > 0 ? `; missing ${missing.join(", ")}` : "";
  const detail = shownDetail(event.detail, missing);
  return `${outcome}${workers}${kind}${reason}${unit}${absent}${
    detail === undefined ? "" : `: ${detail}`
  }`;
}

/** Whether a detail is a shared unit's `partial:<queues>` (or bare `partial`). */
function isPartialDetail(detail: unknown): boolean {
  return (
    typeof detail === "string" &&
    (detail === "partial" || detail.startsWith("partial:"))
  );
}

/**
 * The detail worth printing beside an outcome, made safe as text: none for a
 * `partial:<queues>` detail when `missing` names those queues already (it is
 * kept on the wire for readers that parse it), and none without a detail.
 */
function shownDetail(
  detail: unknown,
  missing: readonly string[],
): string | undefined {
  if (detail === undefined || (missing.length > 0 && isPartialDetail(detail))) {
    return undefined;
  }
  return displayText(detail);
}

/**
 * The queues a summon status's last outcome registered no worker on: a
 * shared unit's partial attempt (`last.missing`), each made safe as text.
 * Empty for any other outcome, and for one an older bun-jobs wrote, whose
 * `partial:<queues>` detail is then shown as it is.
 */
export function summonLastMissing(
  last: Pick<SummonLastOutcomeDto, "missing">,
): string[] {
  return nameList(last.missing);
}

/**
 * The detail the "Last outcome" row prints after the outcome: the same rule
 * as {@link summonEventSummary}, so a partial attempt's `partial:<queues>` is
 * left out where `missing` says it in words. `undefined` when there is none
 * to print.
 */
export function summonLastDetail(
  last: Pick<SummonLastOutcomeDto, "detail" | "missing">,
): string | undefined {
  return shownDetail(last.detail, summonLastMissing(last));
}

/** A partial attempt in words: "Partial: no worker registered on previews, thumbs". */
export function summonPartialText(missing: readonly string[]): string {
  return `Partial: no worker registered on ${missing.join(", ")}`;
}

/** What a partial attempt means for the controller, under the "Last outcome" row. */
export const SUMMON_PARTIAL_HINT =
  "A shared unit that registers on only some of its queues counts as a failed attempt, so the controller backs off rather than summoning again and again.";

/** A shared unit's progress on one of its queues (`PendingSummonDto.coverage`). */
type CoverageState = NonNullable<PendingSummonDto["coverage"]>[string];

/** One queue of an attempt's coverage, as the "On their way" table's badge shows it. */
export interface CoverageBadge {
  /** The queue. */
  queue: string;
  /** The badge's text: "✓ renders", "renders pending" or "✗ renders missing". */
  label: string;
  /** Its colour: success, neutral or danger. */
  tone: BadgeTone;
  /** Its tooltip: why a missing queue is missing; `undefined` otherwise. */
  title: string | undefined;
  /** Whether it is the queue whose Summon tab this is, marked "(this queue)". */
  current: boolean;
}

/** The tooltip of a queue an attempt's unit registered no worker on in time. */
export const COVERAGE_MISSING_HINT =
  "No worker registered on this queue before the attempt's boot budget ran out.";

/** The "On their way" table's Coverage header. */
export const COVERAGE_HEADER = "Coverage";

/** What a Coverage cell shows for an attempt with no coverage: one queue's, or a failed read. */
export const COVERAGE_NONE = "—";

/** Each coverage state's badge, by state, for a queue `queue`. */
const COVERAGE: Readonly<
  Record<
    CoverageState,
    (queue: string) => Pick<CoverageBadge, "label" | "tone" | "title">
  >
> = {
  registered: (queue) => ({
    label: `✓ ${queue}`,
    tone: "success",
    title: undefined,
  }),
  pending: (queue) => ({
    label: `${queue} pending`,
    tone: "neutral",
    title: undefined,
  }),
  missing: (queue) => ({
    label: `✗ ${queue} missing`,
    tone: "danger",
    title: COVERAGE_MISSING_HINT,
  }),
};

/**
 * An attempt's coverage as the "On their way" table's badges: its queues in
 * the order the status lists the unit's (`status.queues`), then any others
 * by name, the queue whose tab this is marked. A state this build does not
 * know reads "<queue> <state>" in the neutral tone, as the contract asks.
 *
 * `undefined` where the attempt has no coverage: one queue's controller, or
 * a status whose reads of it failed. The cell then shows
 * {@link COVERAGE_NONE}; so does an empty one.
 */
export function attemptCoverage(
  coverage: PendingSummonDto["coverage"],
  order: readonly string[] | undefined,
  queue: string,
): CoverageBadge[] | undefined {
  if (
    typeof coverage !== "object" ||
    coverage === null ||
    Array.isArray(coverage)
  ) {
    return undefined;
  }
  const listed = order ?? [];
  const rank = (name: string) => {
    const index = listed.indexOf(name);
    return index === -1 ? listed.length : index;
  };
  return Object.keys(coverage)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => {
      // A key is always a string; its state arrives unchecked.
      const state: unknown = coverage[name];
      const badge = known(COVERAGE, state)
        ? COVERAGE[state](name)
        : {
            label: `${name} ${displayText(state)}`,
            tone: "neutral" as const,
            title: undefined,
          };
      return { queue: name, ...badge, current: name === queue };
    });
}

/**
 * Whether the "On their way" table has a Coverage column: where at least one
 * attempt carries coverage, which only a shared unit's do.
 */
export function showCoverage(
  pending: readonly Pick<PendingSummonDto, "coverage">[],
): boolean {
  return pending.some((attempt) => attempt.coverage !== undefined);
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
      // The reading names its queue: for a shared unit, its most-starved
      // queue's, which may not be the queue the check was asked about.
      return result.demand === undefined
        ? "Nothing to summon"
        : `Nothing to summon: demand on ${displayText(result.demand.queue)} is ${formatNumber(result.demand.demand)}`;
    default:
      return `Summon check: ${displayText(result.action)}`;
  }
}

/**
 * The error toast of a 403 on "summon now" or reset of a shared unit: both
 * need `queues.summon` on every queue the unit serves, and the server's
 * refusal names none, since some may be hidden from the caller.
 */
export const SHARED_UNIT_FORBIDDEN =
  "This needs queues.summon on every queue of the shared unit, including any you cannot see.";

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
