/**
 * One-line summaries of the policy's keyed items, for the editor's tables.
 */
import type { JsonObject } from "./paths";

/** A value as written: a string or a number as it is, anything else as JSON. */
function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : JSON.stringify(value ?? "?");
}

/** A limit in a line: `100 per 1m by ip|route on POST /login`. */
export function limitSummary(item: JsonObject): string {
  const key = Array.isArray(item.key)
    ? item.key.join("|")
    : text(item.key ?? "ip");
  const routes = Array.isArray(item.routes)
    ? ` on ${item.routes.join(", ")}`
    : "";
  return `${text(item.limit)} per ${text(item.window)} by ${key}${routes}`;
}

/** A counted rule in a line: `3 × probe.hit in 1m → ban 1h`. */
export function countedSummary(item: JsonObject): string {
  const action = typeof item.action === "string" ? item.action : "ban";
  const duration =
    item.duration === null
      ? " until lifted"
      : item.duration === undefined
        ? ""
        : ` ${text(item.duration)}`;
  return `${text(item.threshold)} × ${text(item.event)} in ${text(item.window)} → ${action}${duration}`;
}
