import type { SummonBudgetDto } from "../../../api/types";
import type { BudgetWindowView } from "./budgetText";
import { Badge } from "../../../components/Badge";
import { cx } from "../../../components/classNames";
import { RelativeTime } from "../../../components/RelativeTime";
import { useNow } from "../../../hooks/useNow";
// Not `./summonBudget`: Bun resolves an extensionless name differing from
// this file's only in case to this file itself (oven-sh/bun#44659).
import { summonBudgetView } from "./budgetText";

/** Props of {@link SummonBudget}. */
export interface SummonBudgetProps {
  /** The budget, as a summon status or `GET /summon` has it. */
  budget: SummonBudgetDto;
  /**
   * `data-testid` of the whole; each window's line gets it with `-hour` or
   * `-day` appended.
   */
  testId: string;
  /**
   * Whether the queue is in a summon group: a budget the policy turned off
   * then reads "Off: the group's budget applies", its counts in the tooltip.
   * Defaults to `false`.
   */
  group?: boolean;
}

/**
 * A summon budget: per UTC window, a meter of what is left, the attempts
 * left, and when the window resets — absolute in UTC, with the relative time
 * beside it. A window at its limit reads "Exhausted", in the warning tone. The
 * used counts are the tooltip. A budget the policy turned off shows its
 * counts and "no limit", with the reset times as the tooltip; one whose limits
 * were never stored (`limitsUnknown`) shows its counts and "limits unknown",
 * never "Off". In a summon group, an off budget says the group's applies.
 */
export function SummonBudget({
  budget,
  testId,
  group = false,
}: SummonBudgetProps) {
  const now = useNow();
  const view = summonBudgetView(budget, now, { group });
  if (view.state === "unknown") {
    return (
      <span
        className="summon-budget"
        data-testid={testId}
        data-limits-unknown="true"
        title={view.hint}
      >
        {view.text}
      </span>
    );
  }
  if (view.state === "off") {
    return (
      <span
        className="summon-budget"
        data-testid={testId}
        title={view.resets}
      >
        {view.text}
      </span>
    );
  }
  return (
    <span
      className="summon-budget"
      data-testid={testId}
      data-exhausted={view.exhausted}
      title={view.usedText}
    >
      <BudgetLine
        view={view.hour}
        testId={`${testId}-hour`}
      />
      {/* The lines are blocks on screen; read aloud or copied, they need a break. */}
      <span className="visually-hidden">; </span>
      <BudgetLine
        view={view.day}
        testId={`${testId}-day`}
      />
    </span>
  );
}

/** Props of {@link BudgetLine}. */
interface BudgetLineProps {
  /** The window. */
  view: BudgetWindowView;
  /** Its `data-testid`. */
  testId: string;
}

/** One window: its meter, what is left and when it resets. */
function BudgetLine({ view, testId }: BudgetLineProps) {
  // A meter needs max > min; a limit of 0 is a window always exhausted.
  const max = Math.max(view.limit, 1);
  return (
    <span
      className={cx("summon-budget-window", view.exhausted && "is-exhausted")}
      data-testid={testId}
      data-exhausted={view.exhausted}
      title={view.usedText}
    >
      <meter
        className="summon-budget-meter"
        min={0}
        max={max}
        low={max * 0.2}
        high={max * 0.5}
        optimum={max}
        value={Math.min(view.remaining, max)}
        aria-hidden="true"
      />
      <span>
        {view.exhausted && (
          <>
            <Badge
              tone="warning"
              title="Nothing is summoned until this window resets."
            >
              Exhausted
            </Badge>{" "}
          </>
        )}
        {view.left}, resets at {view.resetAt} (
        <RelativeTime value={view.resetsAt} />)
      </span>
    </span>
  );
}
