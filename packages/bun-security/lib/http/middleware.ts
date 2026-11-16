/**
 * The route stage (plan §3.3): a middleware registered ahead of the routes,
 * which finds the route the request will reach (bun-common's matched
 * layers, as its throttle finds a route's `skipThrottle()`), asks the app
 * who is calling (`identify`), and evaluates the limits and counted rules
 * keyed on the caller or the route, then the CSRF check. Under
 * `installSecurity` it is the second stage of a request the early hook
 * already decided; on its own it evaluates every stage at once.
 */
import type {
  BunRequest,
  BunResponse,
  BunRouter,
  Logger,
  LoggerLike,
  NextFunction,
  RouterMiddlewareHandler,
  TrustProxyOption,
} from "@kingsleyweb/bun-common";
import { createLogger, resolveLogger } from "@kingsleyweb/bun-common";
import { refuses } from "../engine/actions";
import type { Decision } from "../engine/decision";
import { requestFacts } from "../engine/facts";
import type { RequestFacts, SecurityIdentity } from "../engine/facts";
import { isThenable, then } from "../engine/maybe";
import type { Security } from "../engine/security";
import type { ChallengeFlow } from "../challenge/flow";
import {
  answerChallenge,
  challengeResponse,
  isChallengeAnswer,
} from "../serve/challenge";
import { dropResponse, refusalResponse } from "../serve/respond";
import { csrf, csrfDecision } from "./csrf";
import type { CsrfGuard, CsrfOptions } from "./csrf";
import { profileOf } from "./profile";
import { uniformOf } from "./uniform";
import type { UniformMark } from "./uniform";
import type { SecurityProfileMark } from "./profile";
import { createState, stateOf } from "./state";
import type { RequestState } from "./state";

/** The longest a `delay` decision holds a request, in milliseconds (layers.md §0.1's `maxDelayMs`). */
export const MAX_DELAY_MS = 2_000;

/** How a refusal is answered, shared by both stages. */
export interface RefusalOptions {
  /**
   * The answer to a refusal, in place of the default problem+json or HTML
   * page (plan §4.2). Not called for `drop`. If it throws, the default is
   * sent and the error logged.
   */
  readonly renderBlock?: (
    decision: Decision,
    request: Request,
  ) => Response | Promise<Response>;
  /**
   * When the engine itself throws (a bug), answer `503` instead of letting
   * the request through. Default `false`: a defence bug must not take the
   * site down (topologies.md §6.2).
   */
  readonly failClosedOnEngineError?: boolean;
  /** Where engine and hook errors are logged. Default: a console logger named `bun-security`. */
  readonly logger?: LoggerLike;
}

/** Options for {@link securityMiddleware}. */
export interface SecurityMiddlewareOptions extends RefusalOptions {
  /**
   * The router whose routes the request is matched against, to know its
   * route (`"GET /users/:id"`), its profile and whether any route matched:
   * the outermost one (the adapter), since a mounted router sees only its
   * own. Without it the route is unknown: rules on route patterns with
   * parameters and `route` keys do not apply, and no answer counts as
   * route-not-found.
   */
  readonly router?: BunRouter;
  /**
   * Which proxies in front of the listener to trust, with bun-common's
   * `trustProxy` values. Default: the router's `trustProxy`, else off.
   */
  readonly trustProxy?: TrustProxyOption;
  /** A client-address header set by the outermost trusted proxy. Default: the router's, else none. */
  readonly clientIpHeader?: string;
  /**
   * The CSRF check (layers.md L13.2), run once the request is admitted:
   * its options, a guard from `csrf()`, or `false` for none. Default on,
   * with `csrf()`'s defaults (Fetch Metadata and `Origin`, for requests
   * carrying cookies).
   */
  readonly csrf?: CsrfOptions | CsrfGuard | false;
}

/** The route a request will reach. */
interface FoundRoute {
  /** `"GET /users/:id"`: the route's method and full pattern. */
  readonly key: string;
  /** Its profile, if one of its callbacks is a `securityProfile()`. */
  readonly profile: SecurityProfileMark | undefined;
  /** Its uniform answers, if one of its callbacks is a `uniformAuthResponse()`. */
  readonly uniform: UniformMark | undefined;
}

/** The first route handler `router` will run for `req`, if any. */
export function routeOf(
  router: BunRouter,
  req: BunRequest,
): FoundRoute | undefined {
  const layers = router.getMatchedLayers({
    requestHost: req.host,
    requestMethod: req.method,
    requestUrl: req.originalUrl,
    requestPath: req.path,
  });
  for (const layer of layers) {
    if (!layer.isRouteHandler || layer.isErrorHandler) continue;
    const matched = layer.matched;
    const method =
      typeof matched.method === "string" && matched.method !== ""
        ? matched.method.toUpperCase()
        : req.method;
    const path = typeof matched.path === "string" ? matched.path : req.path;
    return {
      key: `${method} ${path}`,
      profile: profileOf(matched.callbacks as unknown[]),
      uniform: uniformOf(matched.callbacks as unknown[]),
    };
  }
  return undefined;
}

/** Logs and swallows an error of `complete()`. */
function reportCompleteError(logger: Logger, error: unknown): void {
  logger.error("bun-security: complete() failed", { error });
}

/**
 * Reports a request's outcome to the engine (layer L14), once: each stage's
 * decision with its facts, the status, and whether no route matched and the
 * answer is a `404` (route-not-found, never an app's own `404` for a
 * missing record, which a route handler answers).
 */
export function completeRequest(
  state: RequestState,
  status: number,
  logger: Logger,
): void {
  if (state.completed) return;
  state.completed = true;
  const outcome = {
    status,
    routeNotFound: state.routeMatched === false && status === 404,
  };
  const pairs: [RequestFacts | undefined, Decision | undefined][] = [
    [state.facts, state.early],
    [state.routeFacts, state.route],
  ];
  for (const [facts, decision] of pairs) {
    if (facts === undefined || decision === undefined) continue;
    try {
      const hits = state.security.complete(facts, decision, outcome);
      if (isThenable(hits)) {
        Promise.resolve(hits).catch((error: unknown) =>
          reportCompleteError(logger, error),
        );
      }
    } catch (error) {
      reportCompleteError(logger, error);
    }
  }
}

/** Completes `state` once `res`'s answer is final: now, or when its stream ends. */
export function completeWhenSent(
  state: RequestState,
  res: BunResponse | undefined,
  status: number,
  logger: Logger,
): void {
  if (res?.isStreamOpen === true) {
    res.onceStreamEnded(() => completeRequest(state, status, logger));
  } else {
    completeRequest(state, status, logger);
  }
}

/** The refusal `options` answer `decision` with, the default when `renderBlock` throws. */
export function refusalFor(
  options: RefusalOptions,
  logger: Logger,
  decision: Decision,
  request: Request,
  challenge?: {
    readonly flow: ChallengeFlow | undefined;
    readonly facts: RequestFacts | undefined;
  },
): Response | Promise<Response> {
  if (decision.action === "drop") return dropResponse();
  // A challenge, when the engine has a challenge flow (layers.md L10.2).
  const challenged =
    challenge?.facts === undefined
      ? undefined
      : challengeResponse(
          challenge.flow,
          decision,
          request,
          challenge.facts,
          logger,
        );
  if (challenged !== undefined) return challenged;
  const render = options.renderBlock;
  if (render === undefined) return refusalResponse(decision, request);
  const fallback = (error: unknown): Response => {
    logger.error("bun-security: renderBlock threw; sent the default refusal", {
      error,
    });
    return refusalResponse(decision, request);
  };
  try {
    const rendered = render(decision, request);
    return rendered instanceof Promise ? rendered.catch(fallback) : rendered;
  } catch (error) {
    return fallback(error);
  }
}

/** The decision a failed engine refuses with under `failClosedOnEngineError`. */
export const ENGINE_FAILED: Decision = Object.freeze({
  action: "block",
  status: 503,
  code: "unavailable",
  retryAfter: 1,
  hits: Object.freeze([]),
  tags: Object.freeze([]),
  risk: 0,
  subject: Object.freeze({}),
});

/** What the route stage needs beside the engine. */
export interface RouteStageSetup {
  /** The options. */
  readonly options: SecurityMiddlewareOptions;
  /** The logger. */
  readonly logger: Logger;
  /** The router to match against, read per request (an adapter's `instance` may change). */
  readonly router: () => BunRouter | undefined;
  /** Whether the early stage runs before this one (`installSecurity`). */
  readonly staged: boolean;
  /** Whether the middleware is still installed. */
  readonly active: () => boolean;
  /** Handles the boot self-test's own request; `true` when it did. */
  readonly selfTest?: (
    state: RequestState,
    req: BunRequest,
    res: BunResponse,
  ) => boolean;
}

/** The CSRF guard of `option`, or none. */
function guardOf(
  option: CsrfOptions | CsrfGuard | false | undefined,
): CsrfGuard | undefined {
  if (option === false) return undefined;
  if (typeof option === "function") return option;
  return csrf(option ?? {});
}

/** The route stage's middleware. */
export function createRouteStage(
  security: Security<BunRequest>,
  setup: RouteStageSetup,
): RouterMiddlewareHandler {
  const { options, logger } = setup;
  const guard = guardOf(options.csrf);

  /** Answers a refusal on `res` (a challenge with the facts the route stage decided from). */
  const refuse = (
    res: BunResponse,
    decision: Decision,
    request: Request,
    facts?: RequestFacts,
  ): unknown =>
    then(
      refusalFor(options, logger, decision, request, {
        flow: security.challenge,
        facts,
      }),
      (answer) => res.send(answer),
    );

  /** The admitted request's CSRF check, then the route. */
  const pass = (
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
    state: RequestState,
  ): unknown => {
    const refusal = guard?.check(req, state.profile?.crossSite === true);
    if (refusal !== undefined) {
      return refuse(res, csrfDecision(refusal), req.request);
    }
    return next();
  };

  /** Acts on the route stage's decision. */
  const act = (
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
    state: RequestState,
    decision: Decision,
  ): unknown => {
    const facts = state.routeFacts;
    // Without the early hook (securityMiddleware alone), the answer to a
    // challenge is taken here; under installSecurity the early hook took it.
    if (
      !setup.staged &&
      facts !== undefined &&
      isChallengeAnswer(security.challenge, decision, req.request)
    ) {
      // The router read the body already (its body parser): the answer is
      // given the bytes it kept.
      const request = req.request.bodyUsed
        ? new Request(req.request.url, {
            method: req.request.method,
            headers: req.request.headers,
            body: req.buffer ?? null,
          })
        : req.request;
      return answerChallenge(
        security,
        security.challenge,
        request,
        facts,
        logger,
      ).then((answer) => res.send(answer));
    }
    if (refuses(decision.action)) {
      return refuse(res, decision, req.request, facts);
    }
    if (decision.action === "delay" && (decision.delayMs ?? 0) > 0) {
      return Bun.sleep(Math.min(decision.delayMs ?? 0, MAX_DELAY_MS)).then(() =>
        pass(req, res, next, state),
      );
    }
    return pass(req, res, next, state);
  };

  /** The engine failed: let the request through, or refuse it with `503`. */
  const failed = (
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
    state: RequestState,
    error: unknown,
  ): unknown => {
    logger.error(
      "bun-security: the engine threw; the request was not checked",
      {
        error,
      },
    );
    return options.failClosedOnEngineError
      ? refuse(res, ENGINE_FAILED, req.request)
      : pass(req, res, next, state);
  };

  return (req, res, next) => {
    if (!setup.active()) return next();
    const request = req.request;
    let state = stateOf(request);
    if (state?.selfTest !== undefined && setup.selfTest?.(state, req, res)) {
      return undefined;
    }
    // Under installSecurity, a request the early stage did not admit never
    // gets here; one it could not check (the engine failed) has no state.
    const staged = setup.staged && state?.early !== undefined;
    state ??= createState(request, security);
    const router = setup.router();
    const found = router === undefined ? undefined : routeOf(router, req);
    if (router !== undefined) {
      state.routeMatched = found !== undefined;
      state.profile = found?.profile;
      state.uniform = found?.uniform;
    }
    if (!setup.staged) {
      // On its own, the answer is reported to complete() once it is final.
      const own = state;
      res.whenResponded((native) =>
        completeWhenSent(own, res, native.status, logger),
      );
    }
    const current = state;
    let decided: Decision | Promise<Decision>;
    try {
      const base =
        current.facts ??
        requestFacts(request, {
          peer: req.socketAddress?.address ?? "",
          ...(trustOf(options, router) === undefined
            ? {}
            : { trustProxy: trustOf(options, router) }),
          ...(clientIpHeaderOf(options, router) === undefined
            ? {}
            : { clientIpHeader: clientIpHeaderOf(options, router) }),
        });
      const identity = security.identify(req);
      const evaluate = (who: SecurityIdentity | undefined) => {
        const facts: RequestFacts = {
          ...base,
          ...(found === undefined ? {} : { routeKey: found.key }),
          ...(found?.profile === undefined
            ? {}
            : { profile: found.profile.name }),
          ...(who === undefined ? {} : { identity: who }),
        };
        current.routeFacts = facts;
        return security.evaluate(facts, staged ? { stage: "route" } : {});
      };
      decided = isThenable(identity)
        ? Promise.resolve(identity).then(evaluate)
        : evaluate(identity);
    } catch (error) {
      return failed(req, res, next, current, error);
    }
    if (isThenable(decided)) {
      return Promise.resolve(decided).then(
        (decision) => {
          current.route = decision;
          return act(req, res, next, current, decision);
        },
        (error: unknown) => failed(req, res, next, current, error),
      );
    }
    current.route = decided;
    return act(req, res, next, current, decided);
  };
}

/** The trust setting in force: the options', else the router's. */
function trustOf(
  options: SecurityMiddlewareOptions,
  router: BunRouter | undefined,
): TrustProxyOption | undefined {
  return options.trustProxy ?? router?.trustProxy;
}

/** The client-address header in force: the options', else the router's. */
function clientIpHeaderOf(
  options: SecurityMiddlewareOptions,
  router: BunRouter | undefined,
): string | undefined {
  return options.clientIpHeader ?? router?.clientIpHeader;
}

/**
 * The route stage as a middleware of its own, for a router `installSecurity`
 * does not cover: register it ahead of the routes it guards. It evaluates
 * every stage at once (the request was not seen earlier), runs the CSRF
 * check, and reports the outcome to the engine once the answer is final.
 * It takes no in-flight slot (layer L1 needs the early hook, which only
 * `installSecurity` installs), and it sees only answers sent on the
 * request's response, so a router's built-in `404` (no not-found handler)
 * is not counted as route-not-found; a not-found middleware's answer is.
 * Pass the outermost `router` so it knows the matched route.
 *
 * @example
 * ```ts
 * const app = new BunRouter();
 * app.use(securityMiddleware(security, { router: app }));
 * ```
 */
export function securityMiddleware(
  security: Security<BunRequest>,
  options: SecurityMiddlewareOptions = {},
): RouterMiddlewareHandler {
  const logger = resolveLogger(
    options.logger,
    createLogger({ name: "bun-security" }),
  );
  return createRouteStage(security, {
    options,
    logger,
    router: () => options.router,
    staged: false,
    active: () => true,
  });
}
