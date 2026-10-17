import type {
  SummonBudgetDto,
  SummonListDto,
  SummonListItemDto,
} from "../../../app/api/types";
import type { MockReply } from "../mockFetch";

/** Fixtures of the Summoning screen (`GET /summon`), typed against the contract. */

/** How much of a summon budget is used and allowed. */
export interface SummonBudgetCounts {
  /** Summons this hour. */
  hour: number;
  /** Allowed per hour. */
  perHour: number;
  /** Summons today. */
  day: number;
  /** Allowed per day. */
  perDay: number;
}

/** Options of {@link summonListFixtures}. */
export interface SummonListFixtureOptions {
  /** The budget every controller carries. Defaults to 2 of 30 this hour, 10 of 300 today. */
  budget?: SummonBudgetCounts;
  /** Whether a controller carries a last attempt (started a minute before `now`). Defaults to `true`. */
  last?: boolean;
}

/**
 * The Summoning screen's fixtures, every time relative to one `now`: a test
 * file takes them once, when it loads (`const { NOW, controller, list } =
 * summonListFixtures()`), so its budgets, last attempts and expected labels
 * agree, however late in a run the file starts.
 */
export function summonListFixtures(
  options: SummonListFixtureOptions = {},
  now: number = Date.now(),
) {
  const counts = options.budget ?? {
    hour: 2,
    perHour: 30,
    day: 10,
    perDay: 300,
  };
  const withLast = options.last ?? true;
  /** A budget that is on, the hour window resetting in 23 minutes and the day in 9 hours. */
  const BUDGET: SummonBudgetDto = {
    ...counts,
    hourResetsAt: now + 23 * 60_000,
    dayResetsAt: now + 9 * 3_600_000,
  };
  /** The last attempt a controller reports: started a minute ago. */
  const last: Pick<SummonListItemDto, "last"> = {
    last: { id: "s-1", outcome: "started", at: now - 60_000 },
  };
  /** One controller as `GET /summon` lists it: ready, the budget on, and (by default) a last attempt started. */
  function controller(
    overrides: Partial<SummonListItemDto> = {},
  ): SummonListItemDto {
    return {
      namespace: "shop",
      queue: "emails",
      local: true,
      kind: "ecs",
      readiness: "ready",
      inert: false,
      ...(withLast ? last : {}),
      budget: BUDGET,
      ...overrides,
    };
  }
  /** `GET /summon` answering these controllers. */
  function list(controllers: SummonListItemDto[]): MockReply {
    const body: SummonListDto = { controllers };
    return { body };
  }
  return { NOW: now, BUDGET, controller, list };
}
