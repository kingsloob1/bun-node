/**
 * An event stream's checks (typed-client plan, `sse.md` §3.3, PR-S1): each
 * event by the server's rules (`bun-common/lib/responseValidation.ts`),
 * then a BYO schema on the whole event.
 *
 * **Loaded lazily**, by `./sse` alone, beside `./validation` (whose plan,
 * issue marking and runner it uses), so the core client's checks chunk
 * carries none of it (`__tests__/budget.test.ts`).
 */
import type { StandardOutcome } from "@kingsleyweb/bun-contract";
import type { ValidationErrorIssue } from "./errors";
import type { RouteSchemas } from "./types";
import type { Checked, PartPlan } from "./validation";
import { builtinIssues, customIssues, validateStandard } from "./validation";

/** One event of an event stream, as `sse()` delivers it (`sse.md` §3.1). */
export interface StreamEvent {
  /** The event's name. */
  readonly event: string;
  /** Its data, decoded. */
  readonly data: unknown;
  /** The last event ID as of it, when there is one. */
  readonly id?: string;
}

/** What `checkEvent` is told of the event's data besides the event. */
export interface EventData {
  /** The `data:` lines as they arrived; `undefined` with none. */
  readonly raw: string | undefined;
  /** `false` when the data was to be JSON and did not parse (it is delivered as the raw text). */
  readonly parsed: boolean;
}

/** An issue about an event's data, from the built-in rules. */
function eventIssue(name: string, message: string): ValidationErrorIssue {
  return { target: "data", key: name, message, path: "", source: "builtin" };
}

/**
 * A route's events for status `status` (`sse.md` §3.3): its `events`, else
 * a bun-common `sse({ … })` declaration as the status's response (a
 * server's own schema module may hold one).
 */
function eventsOf(route: RouteSchemas, status: number): RouteSchemas["events"] {
  if (route.events !== undefined) return route.events;
  const declared = route.responses?.[status] as {
    kind?: unknown;
    events?: unknown;
  } | null;
  return declared?.kind === "sse" &&
    typeof declared.events === "object" &&
    declared.events !== null
    ? (declared.events as RouteSchemas["events"])
    : undefined;
}

/**
 * Checks one event of an event stream (`sse.md` §3.3) by the server's rules
 * (`bun-common/lib/responseValidation.ts`): an undeclared name, data on an
 * event declared to carry none, data that is not JSON, then the event's
 * schema on its data; then the BYO schema, on the whole event (`{ event,
 * data, id }`, its data the built-in schema's output when that passed),
 * whose output, when it passes, is the event delivered.
 *
 * @param route  The route's built-in schemas; `undefined` when it has none.
 * @param status The stream's status.
 * @param plan   What runs for it.
 * @param event  The event, its data decoded.
 * @param data   The data as it arrived, and whether it decoded.
 */
export async function checkEvent(
  route: RouteSchemas | undefined,
  status: number,
  plan: PartPlan,
  event: StreamEvent,
  data: EventData,
): Promise<Checked<StreamEvent>> {
  const issues: ValidationErrorIssue[] = [];
  const name = event.event;
  let checked = event;
  const events =
    plan.builtin && route !== undefined ? eventsOf(route, status) : undefined;
  if (events !== undefined) {
    if (!Object.hasOwn(events, name)) {
      const names = Object.keys(events);
      const shown = names.slice(0, 10).join(", ");
      issues.push(
        eventIssue(
          name,
          `This event is not declared (${names.length > 10 ? `${shown}, …` : shown})`,
        ),
      );
    } else {
      const schema = events[name];
      if (schema === null) {
        if (data.raw !== undefined && data.raw !== "")
          issues.push(eventIssue(name, "No data is declared for this event"));
      } else if (!data.parsed) {
        issues.push(eventIssue(name, "The event's data is not valid JSON"));
      } else {
        const result: StandardOutcome<unknown> = await validateStandard(
          schema,
          event.data,
          "data",
          name,
          undefined,
          { stripProtoKeys: "nest" },
        );
        if (result.ok) checked = { ...event, data: result.value };
        else issues.push(...builtinIssues(result.issues, false));
      }
    }
  }
  let value = event;
  if (plan.custom !== undefined) {
    const result: StandardOutcome<unknown> = await validateStandard(
      plan.custom,
      checked,
      "data",
      name,
      undefined,
      { stripProtoKeys: "nest" },
    );
    if (result.ok) value = result.value as StreamEvent;
    else issues.push(...customIssues(result.issues));
  }
  return { value, issues };
}
