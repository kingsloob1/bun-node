/**
 * What the integration knows of each request, between its stages: the
 * facts, the decisions, the route's profile, and whether it has been
 * reported to `complete()`. Keyed by the `Request` as `Bun.serve` handed it
 * over, which bun-common's route stage finds at `req.request`.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { Decision } from "../engine/decision";
import type { RequestFacts } from "../engine/facts";
import type { Security } from "../engine/security";
import type { SecurityProfileMark } from "./profile";
import type { UniformMark } from "./uniform";

/** What the boot self-test's request went through. */
export interface SelfTestTrace {
  /** The early stage saw it. */
  early: boolean;
  /** The route stage saw it. */
  route: boolean;
  /** The before-write hook saw its answer. */
  write: boolean;
  /** A throttle of bun-common's ran on it ahead of the route stage. */
  throttle: boolean;
  /** An error the engine threw while explaining it. */
  error: unknown;
}

/** One request's state. */
export interface RequestState {
  /** The engine that decided it. */
  readonly security: Security<BunRequest>;
  /** The early stage's facts (no route, no caller). */
  facts: RequestFacts | undefined;
  /** The early stage's decision; tracked, so it holds the in-flight slot. */
  early: Decision | undefined;
  /** The route stage's facts (the matched route and the caller). */
  routeFacts: RequestFacts | undefined;
  /** The route stage's decision. */
  route: Decision | undefined;
  /** Whether routing found a route handler; `undefined` before the route stage ran. */
  routeMatched: boolean | undefined;
  /** The matched route's profile, if it has one. */
  profile: SecurityProfileMark | undefined;
  /** The matched route's uniform answers, if it has them. */
  uniform: UniformMark | undefined;
  /** When the request arrived, `performance.now()`. */
  readonly startedAt: number;
  /** Whether `complete()` has been called for it. */
  completed: boolean;
  /** Set for the boot self-test's own request. */
  selfTest: SelfTestTrace | undefined;
}

/** Every request's state, by its native `Request`. */
const STATES = new WeakMap<Request, RequestState>();

/** The state of `request`, created when `security` is given and none exists. */
export function stateOf(request: Request): RequestState | undefined {
  return STATES.get(request);
}

/** A fresh state for `request`. */
export function createState(
  request: Request,
  security: Security<BunRequest>,
): RequestState {
  const state: RequestState = {
    security,
    facts: undefined,
    early: undefined,
    routeFacts: undefined,
    route: undefined,
    routeMatched: undefined,
    profile: undefined,
    uniform: undefined,
    startedAt: performance.now(),
    completed: false,
    selfTest: undefined,
  };
  STATES.set(request, state);
  return state;
}

/** What {@link requestSecurity} tells the app about a request. */
export interface RequestSecurity {
  /** The latest decision: the route stage's once it ran, else the early stage's. */
  readonly decision: Decision | undefined;
  /** The facts that decision was made from. */
  readonly facts: RequestFacts | undefined;
  /** The matched route's profile name, if it has one. */
  readonly profile: string | undefined;
  /** Whether routing found a route handler; `undefined` before the route stage ran. */
  readonly routeMatched: boolean | undefined;
}

/**
 * What bun-security decided about a request, for the app's handlers: the
 * decision (its `tags`, `risk`, `hits`), the facts, the route's profile.
 * `undefined` for a request it has not seen.
 *
 * @example
 * ```ts
 * app.get("/x", (req, res) => {
 *   const tags = requestSecurity(req)?.decision?.tags ?? [];
 * });
 * ```
 */
export function requestSecurity(
  req: BunRequest | Request,
): RequestSecurity | undefined {
  const state = STATES.get(req instanceof Request ? req : req.request);
  if (state === undefined) return undefined;
  return Object.freeze({
    decision: state.route ?? state.early,
    facts: state.route === undefined ? state.facts : state.routeFacts,
    profile: state.profile?.name,
    routeMatched: state.routeMatched,
  });
}
