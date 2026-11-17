/**
 * Where the live hub (PR-CP5) is told of what the control plane stored:
 * an agent's event batch once stored, and every ban written or lifted.
 * Internal, never exported from `./control`: a no-op until CP5 sets it on
 * the plane (`setLiveHooks`), so whichever of CP4 and CP5 lands second
 * wires them. A hook that throws is logged, never fails the request.
 */
import type { AgentEventBatch } from "../analytics/batch";
import type { BanRecord } from "../store/types";

/** What the live hub is told. */
export interface LiveHooks {
  /** An agent's batch was stored for `service` (not a resend). */
  readonly publishBatch: (service: string, batch: AgentEventBatch) => void;
  /** A ban was written or lifted: the stored record. */
  readonly publishBan: (ban: BanRecord) => void;
}

/** The hooks that do nothing. */
const NONE: LiveHooks = Object.freeze({
  publishBatch: () => {},
  publishBan: () => {},
});

/** The hooks set on each control plane. */
const HOOKS = new WeakMap<object, LiveHooks>();

/** Sets the live hub's hooks on `plane` (CP5). */
export function setLiveHooks(plane: object, hooks: LiveHooks): void {
  HOOKS.set(plane, hooks);
}

/** The live hub's hooks on `plane`, or ones that do nothing. */
export function liveHooksOf(plane: object): LiveHooks {
  return HOOKS.get(plane) ?? NONE;
}
