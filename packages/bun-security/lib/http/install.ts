/**
 * `installSecurity`: the engine on a bun-common `BunHttpAdapter` (plan
 * §3.3), in three places:
 *
 * - **the early stage**, the adapter's before-read hook: layers L1 to L4
 *   and the limits that need neither the route nor the caller, before the
 *   body is read, so a refused request costs no parsing;
 * - **the route stage**, a middleware registered by the install: the
 *   matched route, its profile, the caller (`identify`), the limits keyed
 *   on them, the CSRF check;
 * - **the response stage**, the adapter's before-write hook: security
 *   headers and stack-trace scrubbing on every answer, refusals included
 *   (L13), and the outcome reported to the engine (L14).
 *
 * The install ends with a boot self-test: one marked request through the
 * adapter's socket-free `fetch()`, which must pass all three.
 */
import { randomUUID } from "node:crypto";
import type {
  BeforeWriteContext,
  BunHttpAdapter,
  BunRequest,
  Logger,
} from "@kingsleyweb/bun-common";
import {
  ConfigError,
  createLogger,
  getThrottleResults,
  resolveLogger,
} from "@kingsleyweb/bun-common";
import { refuses } from "../engine/actions";
import type { Decision } from "../engine/decision";
import { requestFacts } from "../engine/facts";
import type { RequestFacts } from "../engine/facts";
import { isThenable } from "../engine/maybe";
import type { Security } from "../engine/security";
import {
  answerChallenge,
  completeQuietly,
  isChallengeAnswer,
} from "../serve/challenge";
import { securityHeaders } from "./headers";
import type { SecurityHeadersOptions } from "./headers";
import {
  completeWhenSent,
  createRouteStage,
  ENGINE_FAILED,
  MAX_DELAY_MS,
  refusalFor,
} from "./middleware";
import type { SecurityMiddlewareOptions } from "./middleware";
import { stackScrubber } from "./scrub";
import type { ScrubMode } from "./scrub";
import { createState, stateOf } from "./state";
import type { SelfTestTrace } from "./state";

/** Options for {@link installSecurity}. */
export interface InstallSecurityOptions extends Omit<
  SecurityMiddlewareOptions,
  "router" | "trustProxy" | "clientIpHeader"
> {
  /**
   * The security headers (layers.md L13.1) on every answer: their options,
   * or `false` for none. Default on, with `securityHeaders()`'s defaults.
   */
  readonly headers?: SecurityHeadersOptions | false;
  /**
   * Replace a `5xx` answer that carries a stack trace with a bare
   * problem+json (layers.md L13.3): `"production"` while `NODE_ENV` is
   * `production`, `"always"`, or `false`. Default `"production"`.
   */
  readonly scrub?: ScrubMode | false;
  /**
   * Run the boot self-test (plan §3.3, D25) before resolving. Default
   * `true`. With it off the install resolves at once, untested.
   */
  readonly selfTest?: boolean;
  /**
   * Fail the self-test unless a bun-common throttle ran ahead of the route
   * stage (the adapter's `throttle` option): proof that the rate limits the
   * app relies on are in the pipeline. Default `false`: the self-test only
   * reports it.
   */
  readonly expectThrottle?: boolean;
}

/** What the boot self-test found. */
export interface SecuritySelfTest {
  /** Whether it ran. */
  readonly ran: boolean;
  /** Whether a bun-common throttle ran on the request ahead of the route stage. */
  readonly throttle: boolean;
}

/** What {@link installSecurity} resolves. */
export interface SecurityInstallation {
  /** What the boot self-test found. */
  readonly selfTest: SecuritySelfTest;
  /**
   * Takes the engine off the adapter: its hooks removed and its middleware
   * passing every request on (a middleware cannot be unregistered).
   */
  readonly remove: () => void;
}

/** The path of the self-test's request: answered by the route stage, never routed. */
export const SELF_TEST_PATH = "/__bun-security/self-test";

/** The header that marks the self-test's request, with a token of the install's own. */
const SELF_TEST_HEADER = "x-bun-security-self-test";

/** A documentation address (RFC 5737) as the self-test's peer, so a throttle has a key. */
const SELF_TEST_PEER = "192.0.2.1";

/** Whether `request` asks for a WebSocket upgrade. */
function isUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Installs the engine on a bun-common adapter (plan §3.3): the early stage
 * on its before-read hook, the route stage as a middleware registered now,
 * and the security headers, stack-trace scrubbing and outcome reporting on
 * its before-write hook; then the boot self-test. Install it before
 * registering routes and middleware: the route stage runs in registration
 * order, and only a throttle the adapter was constructed with runs ahead of
 * it. Rejects with bun-common's `ConfigError` when the self-test's request
 * did not pass all three stages.
 *
 * The client is resolved with the adapter's own `trustProxy` and
 * `clientIpHeader`, read per request; `identify` gets the `BunRequest`.
 *
 * @example
 * ```ts
 * const app = new BunHttpAdapter(0, { trustProxy: "loopback" });
 * await installSecurity(app, security);
 * app.post("/login", securityProfile("login"), login);
 * ```
 */
export async function installSecurity<
  customWebsocketDataType,
  routesType extends string,
>(
  app: BunHttpAdapter<customWebsocketDataType, routesType>,
  security: Security<BunRequest>,
  options: InstallSecurityOptions = {},
): Promise<SecurityInstallation> {
  // The hooks read only `requestIP` of the server, whatever its socket data.
  const adapter = app as unknown as BunHttpAdapter;
  const logger: Logger = resolveLogger(
    options.logger,
    createLogger({ name: "bun-security" }),
  );
  const token = randomUUID();
  let active = true;
  /** The self-test request's trace, once the early stage saw it. */
  let selfTestTrace: SelfTestTrace | undefined;

  /** The early stage's facts for `request`. */
  const factsOf = (
    request: Request,
    server: { requestIP: (request: Request) => { address: string } | null },
  ): RequestFacts => {
    const trustProxy = adapter.trustProxy;
    const clientIpHeader = adapter.clientIpHeader;
    return requestFacts(request, {
      peer: server.requestIP(request)?.address ?? "",
      ...(trustProxy === undefined ? {} : { trustProxy }),
      ...(clientIpHeader === undefined ? {} : { clientIpHeader }),
    });
  };

  /** Acts on the early stage's decision: an answer, a hold, or nothing (read on). */
  const act = (
    request: Request,
    facts: RequestFacts,
    decision: Decision,
  ): Response | undefined | Promise<Response | undefined> => {
    const flow = security.challenge;
    if (isChallengeAnswer(flow, decision, request)) {
      // Answered here, before the body is read: an admitted answer's slot
      // is given back once it is.
      const answered = answerChallenge(security, flow, request, facts, logger);
      return refuses(decision.action)
        ? answered
        : answered.then((response) => {
            completeQuietly(security, facts, decision, response.status, logger);
            return response;
          });
    }
    if (refuses(decision.action)) {
      return refusalFor(options, logger, decision, request, { flow, facts });
    }
    const state = createState(request, security);
    state.facts = facts;
    state.early = decision;
    if (decision.action === "delay" && (decision.delayMs ?? 0) > 0) {
      return Bun.sleep(Math.min(decision.delayMs ?? 0, MAX_DELAY_MS)).then(
        () => undefined,
      );
    }
    return undefined;
  };

  /** The engine failed in the early stage: read on unchecked, or refuse with `503`. */
  const failed = (
    request: Request,
    error: unknown,
  ): Response | undefined | Promise<Response> => {
    logger.error(
      "bun-security: the engine threw; the request was not checked",
      {
        error,
      },
    );
    return options.failClosedOnEngineError
      ? refusalFor(options, logger, ENGINE_FAILED, request)
      : undefined;
  };

  /** The self-test's request in the early stage: explained, never counted. */
  const selfTestEarly = (
    request: Request,
    facts: RequestFacts,
  ): Promise<undefined> | undefined => {
    const state = createState(request, security);
    const trace: SelfTestTrace = {
      early: true,
      route: false,
      write: false,
      throttle: false,
      error: undefined,
    };
    state.selfTest = trace;
    selfTestTrace = trace;
    try {
      const explained = security.explain(facts);
      if (isThenable(explained)) {
        return Promise.resolve(explained).then(
          () => undefined,
          (error: unknown) => {
            trace.error = error;
            return undefined;
          },
        );
      }
    } catch (error) {
      trace.error = error;
    }
    return undefined;
  };

  const removeRead = adapter.addBeforeReadHook((request, server) => {
    if (!active) return undefined;
    let facts: RequestFacts;
    let decided: Decision | Promise<Decision>;
    try {
      facts = factsOf(request, server);
      if (request.headers.get(SELF_TEST_HEADER) === token) {
        return selfTestEarly(request, facts);
      }
      // An upgrade's socket outlives any answer, so it takes no slot.
      decided = security.evaluate(facts, {
        track: !isUpgrade(request),
        stage: "early",
      });
    } catch (error) {
      return failed(request, error);
    }
    if (isThenable(decided)) {
      return Promise.resolve(decided).then(
        (decision) => act(request, facts, decision),
        (error: unknown) => failed(request, error),
      );
    }
    return act(request, facts, decided);
  });

  const routeStage = createRouteStage(security, {
    options,
    logger,
    router: () => adapter.instance,
    staged: true,
    active: () => active,
    selfTest: (state, req, res) => {
      const trace = state.selfTest;
      if (trace === undefined) return false;
      trace.route = true;
      trace.throttle = getThrottleResults(req) !== undefined;
      res.status(204).setHeader(SELF_TEST_HEADER, "ok");
      void res.end();
      return true;
    },
  });
  // On the router that routes the requests: the adapter, or the one
  // setInstance() gave it.
  adapter.instance.use(routeStage);

  const headers =
    options.headers === false
      ? undefined
      : securityHeaders(options.headers ?? {});
  const scrub =
    options.scrub === false
      ? undefined
      : stackScrubber(options.scrub ?? "production", logger);

  /** The response stage once scrubbing decided: headers, then the outcome. */
  const finish = (
    context: BeforeWriteContext,
    replacement: Response | undefined,
  ): Response | undefined => {
    const response = replacement ?? context.response;
    const seen: BeforeWriteContext =
      replacement === undefined ? context : { ...context, response };
    void headers?.(seen);
    const state = stateOf(context.request);
    if (
      state !== undefined &&
      !state.completed &&
      state.selfTest === undefined
    ) {
      completeWhenSent(state, context.res, response.status, logger);
    }
    return replacement;
  };

  const removeWrite = adapter.addBeforeWriteHook((context) => {
    if (!active) return undefined;
    const trace = stateOf(context.request)?.selfTest;
    if (trace !== undefined) trace.write = true;
    const replaced = scrub?.(context);
    return isThenable(replaced)
      ? Promise.resolve(replaced).then((value) => finish(context, value))
      : finish(context, replaced);
  });

  const remove = (): void => {
    active = false;
    removeRead();
    removeWrite();
  };

  if (options.selfTest === false) {
    return { selfTest: { ran: false, throttle: false }, remove };
  }
  const selfTest = await runSelfTest(
    adapter,
    token,
    options.expectThrottle === true,
    () => selfTestTrace,
    remove,
  );
  return { selfTest, remove };
}

/** Sends the self-test's request and checks what it went through. */
async function runSelfTest(
  adapter: BunHttpAdapter,
  token: string,
  expectThrottle: boolean,
  traceOf: () => SelfTestTrace | undefined,
  remove: () => void,
): Promise<SecuritySelfTest> {
  const response = await adapter.fetch(SELF_TEST_PATH, {
    headers: { [SELF_TEST_HEADER]: token },
    remoteAddress: SELF_TEST_PEER,
  });
  const trace = traceOf();
  const missing: string[] = [];
  if (trace?.early !== true)
    missing.push("the early stage (the before-read hook) did not see it");
  if (trace?.route !== true) {
    missing.push(
      "the route stage did not see it: a middleware or route registered before installSecurity() answered it; install it first",
    );
  }
  if (trace?.write !== true)
    missing.push(
      "the response stage (the before-write hook) did not see its answer",
    );
  if (response.headers.get(SELF_TEST_HEADER) !== "ok") {
    missing.push(
      `its answer was not the route stage's (status ${response.status})`,
    );
  }
  if (trace?.error !== undefined)
    missing.push("the engine threw while explaining it");
  if (expectThrottle && trace?.throttle !== true) {
    missing.push(
      "no bun-common throttle ran ahead of the route stage (expectThrottle)",
    );
  }
  if (missing.length > 0) {
    remove();
    throw new ConfigError(
      `installSecurity(): the boot self-test failed: ${missing.join("; ")}`,
      trace?.error === undefined ? undefined : { error: trace.error },
    );
  }
  return { ran: true, throttle: trace?.throttle === true };
}
