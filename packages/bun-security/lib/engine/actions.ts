/**
 * The actions' order (layers.md §0.1): when several rules hit, the engine
 * applies the most severe and records every hit.
 */
import type { SecurityAction } from "../policy/types";

/**
 * Each action's severity, least severe first: `allow` < `log` < `tag` <
 * `delay` < `challenge` < `block` < `ban` < `drop`.
 */
export const ACTION_SEVERITY: Readonly<Record<SecurityAction, number>> =
  Object.freeze({
    allow: 0,
    log: 1,
    tag: 2,
    delay: 3,
    challenge: 4,
    block: 5,
    ban: 6,
    drop: 7,
  });

/** Whether an action refuses the request: `challenge`, `block`, `ban` or `drop`. */
export function refuses(action: SecurityAction): boolean {
  return ACTION_SEVERITY[action] >= ACTION_SEVERITY.challenge;
}
