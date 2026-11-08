import type { EventName, JobsApiMode } from "../../../api/types";
import {
  JOBS_API_ACTIONS,
  JOBS_API_WS_SUBPROTOCOL,
} from "@kingsleyweb/bun-jobs/api/contract";
import { parseChannel, typesFor } from "../../events/eventLog";

/**
 * The Events-console links of the WebSocket reference's try-it: the one
 * jobs-specific piece. The reading of the document and the address machinery
 * are the package's (`@kingsleyweb/bun-api-docs-ui/embed`); what a filled
 * channel LINKS to is the app's.
 */

/** Whether a string is one of the API's actions (so a have/lack marker can be shown). */
export function isKnownAction(
  action: string,
): action is (typeof JOBS_API_ACTIONS)[number] {
  return (JOBS_API_ACTIONS as readonly string[]).includes(action);
}

/** The subprotocol the client contract defaults to, for a document that states none. */
export const DEFAULT_SUBPROTOCOL: string = JOBS_API_WS_SUBPROTOCOL;

/**
 * The Events console link subscribing to `channel` filtered to `types`, or
 * `null` when the console could not open it in `mode`. The type filter is
 * left off when it would let every type the console offers for the channel
 * through anyway (a filter of everything is no filter).
 */
export function eventsLink(
  channel: string,
  types: readonly EventName[],
  mode: JobsApiMode,
): string | null {
  const choice = parseChannel(channel, mode);
  if (choice === null) {
    return null;
  }
  const allowed = typesFor(choice);
  const kept = allowed.filter((type) => types.includes(type));
  const params = new URLSearchParams({ channel });
  if (kept.length > 0 && kept.length < allowed.length) {
    params.set("types", kept.join(","));
  }
  return `/events?${params.toString()}`;
}
