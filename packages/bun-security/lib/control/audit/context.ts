/**
 * The audit context of a request: who acts, from where, under which
 * permission and step-up. The route helper sets it around each handler
 * (an `AsyncLocalStorage`), so the control plane's logic records it
 * without taking a request; outside a request the actor is `system`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditActorDto } from "../contract/types";

/** What an audit entry records about the request behind it. */
export interface AuditRequestContext {
  /** Who. */
  readonly actor: AuditActorDto;
  /** The client address, as the admin listener resolved it. */
  readonly address: string | null;
  /** The host's session id for the operator, when `authenticate` gave one. */
  readonly sessionId: string | null;
  /** The request's id (`x-request-id`, or one made up). */
  readonly requestId: string;
  /** The permissions checked, in order. */
  readonly permissions: string[];
  /** Whether a step-up was proven on this request. */
  stepUp: boolean;
  /** Set when a change landed but its "done" entry could not be written. */
  incomplete: boolean;
}

/** Operators acting through a break-glass session: `owner` on `global`. */
export const breakGlassOperators = new WeakSet<object>();

/** The current request's audit context. */
export const auditContext = new AsyncLocalStorage<AuditRequestContext>();

/** The context of the current request, or a system one. */
export function currentAuditContext(): AuditRequestContext {
  return (
    auditContext.getStore() ?? {
      actor: { id: "system", kind: "system" },
      address: null,
      sessionId: null,
      requestId: "system",
      permissions: [],
      stepUp: false,
      incomplete: false,
    }
  );
}
