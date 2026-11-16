/**
 * `SecurityService`: bun-security on bun-nest's adapter (plan §3.5), in the
 * same three stages as bun-common's `installSecurity` (plan §3.3):
 *
 * - **the early stage**, the adapter's before-read hook: layers L1 to L4,
 *   L6 and L8's honeypots, and the limits keyed on the address alone,
 *   before the body is read;
 * - **the route stage**, run by `SecurityGuard` (Nest's guards see the
 *   handler, so `@SecurityProfile()` and `@SkipSecurity()` work): the
 *   caller (`identify`), the limits keyed on it or the route, canaries, the
 *   CSRF check;
 * - **the response stage**: a head middleware, registered while Nest
 *   builds the module (before Nest's body parsers, middleware and routes),
 *   marks route-not-found and puts a response transform on each response
 *   for the security headers and stack-trace scrubbing; an observing
 *   before-write hook reports the outcome to `complete()`.
 *
 * bun-nest's before-write hooks may only refuse an answer, never change it,
 * so the headers and scrubbing ride on bun-common's response transforms,
 * which every answer Nest writes on the request's response passes through
 * (a route's, Nest's not-found and exception answers).
 */
import { randomUUID } from "node:crypto";
import type {
  BeforeWriteContext,
  BunRequest,
  BunResponse,
  BunResponseTransformBody,
  BunRouter,
  Logger,
} from "@kingsleyweb/bun-common";
import type {
  Decision,
  RequestFacts,
  Security,
  SecurityIdentity,
} from "@kingsleyweb/bun-security";
import type {
  CsrfGuard,
  CsrfOptions,
  RefusalOptions,
} from "@kingsleyweb/bun-security/http";
import type { SelfTestTrace } from "@kingsleyweb/bun-security/lib/http/state";
import type { BunHttpAdapter } from "../BunHttpAdapter";
import type {
  SecurityModuleSettings,
  SecurityProfileMetadata,
  SecuritySource,
} from "./security.interface";
import {
  ConfigError,
  createLogger,
  resolveLogger,
} from "@kingsleyweb/bun-common";
import { createSecurity, requestFacts } from "@kingsleyweb/bun-security";
import { csrf, securityHeaders } from "@kingsleyweb/bun-security/http";
import { csrfDecision } from "@kingsleyweb/bun-security/lib/http/csrf";
import {
  completeWhenSent,
  ENGINE_FAILED,
  MAX_DELAY_MS,
  refusalFor,
  routeOf,
} from "@kingsleyweb/bun-security/lib/http/middleware";
import { carriesStack } from "@kingsleyweb/bun-security/lib/http/scrub";
import { createState, stateOf } from "@kingsleyweb/bun-security/lib/http/state";
import { SecurityRefusalException } from "./security.exception";

/** The path of the self-test's request: answered by the head middleware, never routed. */
export const SECURITY_SELF_TEST_PATH = "/__bun-security/self-test";

/** The header that marks the self-test's request, with a token of the service's own. */
const SELF_TEST_HEADER = "x-bun-security-self-test";

/** A documentation address (RFC 5737) as the self-test's peer. */
const SELF_TEST_PEER = "192.0.2.1";

/** The actions that refuse a request. */
const REFUSING: ReadonlySet<string> = new Set([
  "challenge",
  "block",
  "ban",
  "drop",
]);

/** The settings' keys, which are not `createSecurity`'s. */
const SETTING_KEYS: ReadonlySet<string> = new Set([
  "headers",
  "csrf",
  "scrub",
  "selfTest",
  "renderBlock",
  "failClosedOnEngineError",
  "globalGuard",
  "isGlobal",
]);

/** The body types worth scanning for a stack trace: text, JSON, HTML, XML. */
const TEXTUAL =
  /^(?:text\/(?!event-stream)|application\/(?:[\w.+-]+\+)?(?:json|xml))/i;

/** Whether `request` asks for a WebSocket upgrade. */
function isUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** The text of a buffered body, when it is text or bytes. */
function bodyText(
  body: BunResponseTransformBody | undefined,
): string | undefined {
  if (typeof body === "string") return body;
  if (body === undefined || body instanceof Blob) return undefined;
  const bytes =
    body instanceof ArrayBuffer || body instanceof SharedArrayBuffer
      ? new Uint8Array(body)
      : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new TextDecoder().decode(bytes);
}

/** The bare problem+json a scrubbed answer becomes. */
function scrubbed(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/problem+json");
  headers.set("cache-control", "no-store");
  const status = response.status;
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: status === 503 ? "Service Unavailable" : "Internal Server Error",
      status,
      code: "internal_error",
    }),
    { status, headers },
  );
}

/** The engine of `source` and whether this service made it (and so closes it). */
function engineOf(source: SecuritySource & SecurityModuleSettings): {
  security: Security<BunRequest>;
  owned: boolean;
} {
  if (typeof source !== "object" || source === null) {
    throw new ConfigError(
      "SecurityModule: the options must be createSecurity's options or `{ security }`",
    );
  }
  if ("security" in source) {
    if ("policy" in source) {
      throw new ConfigError(
        "SecurityModule: pass either `security` (an engine made elsewhere) or createSecurity's options with a `policy`, not both",
      );
    }
    return { security: source.security, owned: false };
  }
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!SETTING_KEYS.has(key)) options[key] = value;
  }
  return {
    security: createSecurity(
      options as unknown as Parameters<typeof createSecurity<BunRequest>>[0],
    ),
    owned: true,
  };
}

/** The CSRF guard of `option`, or none. */
function guardOf(
  option: CsrfOptions | CsrfGuard | false | undefined,
): CsrfGuard | undefined {
  if (option === false) return undefined;
  if (typeof option === "function") return option;
  return csrf(option ?? {});
}

/**
 * The engine on the adapter: its hooks, the route stage `SecurityGuard`
 * runs, and the boot self-test. Built by `SecurityModule` while Nest builds
 * the application, so its head middleware runs ahead of everything Nest
 * registers later.
 */
export class SecurityService {
  /** The engine. */
  readonly security: Security<BunRequest>;
  /** Whether this service made the engine, and so closes it. */
  readonly #owned: boolean;
  /** The settings. */
  readonly #settings: SecurityModuleSettings & RefusalOptions;
  /** The adapter. */
  readonly #adapter: BunHttpAdapter;
  /** Where errors and refusals are logged. */
  readonly #logger: Logger;
  /** The CSRF guard, if on. */
  readonly #csrf: CsrfGuard | undefined;
  /** The security headers hook, if on. */
  readonly #headers: ReturnType<typeof securityHeaders> | undefined;
  /** Whether stack traces are scrubbed. */
  readonly #scrub: boolean;
  /** The self-test request's token. */
  readonly #token = randomUUID();
  /** The self-test request's trace, once the early stage saw it. */
  #selfTestTrace: SelfTestTrace | undefined;
  /** Whether the hooks are installed. */
  #active = true;
  /** Removes the adapter hooks. */
  readonly #removers: (() => void)[] = [];

  constructor(
    /** Where the engine comes from, and the settings. */
    source: SecuritySource & SecurityModuleSettings,
    /** The application's adapter: bun-nest's `BunHttpAdapter`. */
    adapter: unknown,
  ) {
    if (
      typeof adapter !== "object" ||
      adapter === null ||
      typeof (adapter as Partial<BunHttpAdapter>).addBeforeReadHook !==
        "function"
    ) {
      throw new ConfigError(
        "SecurityModule needs @kingsleyweb/bun-nest's BunHttpAdapter as the application's HTTP adapter",
      );
    }
    this.#adapter = adapter as BunHttpAdapter;
    const { security, owned } = engineOf(source);
    this.security = security;
    this.#owned = owned;
    this.#settings = source;
    this.#logger = resolveLogger(
      source.logger,
      createLogger({ name: "bun-security" }),
    );
    this.#csrf = guardOf(source.csrf);
    this.#headers =
      source.headers === false
        ? undefined
        : securityHeaders(source.headers ?? {});
    const scrub = source.scrub ?? "production";
    this.#scrub =
      scrub === "always" ||
      (scrub === "production" && Bun.env.NODE_ENV === "production");
    this.#install();
  }

  /** The router the adapter routes with. */
  get #router(): BunRouter {
    return this.#adapter.getInstance();
  }

  /** The early stage's facts for `request`. */
  #factsOf(request: Request, peer: string): RequestFacts {
    const router = this.#router;
    const trustProxy = router.trustProxy;
    const clientIpHeader = router.clientIpHeader;
    return requestFacts(request, {
      peer,
      ...(trustProxy === undefined ? {} : { trustProxy }),
      ...(clientIpHeader === undefined ? {} : { clientIpHeader }),
    });
  }

  /** A refusal answered in the early stage, with the security headers on it. */
  #earlyRefusal(
    request: Request,
    decision: Decision,
  ): Response | Promise<Response> {
    const withHeaders = (response: Response): Response => {
      void this.#headers?.({
        phase: "early",
        request,
        req: undefined,
        res: undefined,
        response,
      });
      return response;
    };
    const answer = refusalFor(this.#settings, this.#logger, decision, request);
    return answer instanceof Promise
      ? answer.then(withHeaders)
      : withHeaders(answer);
  }

  /** Installs the before-read hook, the head middleware and the before-write observer. */
  #install(): void {
    const adapter = this.#adapter;
    const security = this.security;

    this.#removers.push(
      adapter.addBeforeReadHook((request, server) => {
        if (!this.#active) return undefined;
        let facts: RequestFacts;
        let decided: Decision | Promise<Decision>;
        try {
          facts = this.#factsOf(
            request,
            server.requestIP(request)?.address ?? "",
          );
          if (request.headers.get(SELF_TEST_HEADER) === this.#token) {
            return this.#selfTestEarly(request, facts);
          }
          // An upgrade's socket outlives any answer, so it takes no slot.
          decided = security.evaluate(facts, {
            track: !isUpgrade(request),
            stage: "early",
          });
        } catch (error) {
          return this.#earlyFailed(request, error);
        }
        const act = (
          decision: Decision,
        ): Response | undefined | Promise<Response | undefined> => {
          if (REFUSING.has(decision.action)) {
            return this.#earlyRefusal(request, decision);
          }
          const state = createState(request, security);
          state.facts = facts;
          state.early = decision;
          if (decision.action === "delay" && (decision.delayMs ?? 0) > 0) {
            return Bun.sleep(
              Math.min(decision.delayMs ?? 0, MAX_DELAY_MS),
            ).then(() => undefined);
          }
          return undefined;
        };
        return decided instanceof Promise
          ? decided.then(act, (error: unknown) =>
              this.#earlyFailed(request, error),
            )
          : act(decided);
      }),
    );

    // The head middleware: registered now, while Nest builds the module, so
    // it runs ahead of Nest's body parsers, middleware and routes.
    adapter.use((req: BunRequest, res: BunResponse, next: () => void) => {
      if (!this.#active) return next();
      const state = stateOf(req.request);
      const trace = state?.selfTest;
      if (trace !== undefined) {
        trace.route = true;
        res.status(204).setHeader(SELF_TEST_HEADER, "ok");
        void res.end();
        return undefined;
      }
      if (state !== undefined) {
        state.routeMatched = routeOf(this.#router, req) !== undefined;
      }
      if (this.#headers !== undefined || this.#scrub) {
        res.addResponseTransform({
          transform: (native, { body }) =>
            this.#transform(req, res, native, body),
        });
      }
      return next();
    });

    this.#removers.push(
      adapter.addBeforeWriteHook((context) => {
        if (!this.#active) return;
        const state = stateOf(context.request.request);
        if (state === undefined) return;
        if (state.selfTest !== undefined) {
          state.selfTest.write = true;
          return;
        }
        if (!state.completed) {
          completeWhenSent(
            state,
            context.response,
            context.status,
            this.#logger,
          );
        }
      }),
    );
  }

  /** The response stage on one native response: scrubbing, then the headers. */
  #transform(
    req: BunRequest,
    res: BunResponse,
    native: Response,
    body: BunResponseTransformBody | undefined,
  ): Response {
    let response = native;
    if (
      this.#scrub &&
      native.status >= 500 &&
      TEXTUAL.test(native.headers.get("content-type") ?? "")
    ) {
      const text = bodyText(body);
      if (text !== undefined && carriesStack(text)) {
        this.#logger.warn(
          "bun-security: a 5xx answer carried a stack trace; scrubbed",
          { status: native.status, method: req.method, path: req.path },
        );
        response = scrubbed(native);
      }
    }
    if (this.#headers !== undefined) {
      const context: BeforeWriteContext = {
        phase: "response",
        request: req.request,
        req,
        res,
        response,
      };
      void this.#headers(context);
    }
    return response;
  }

  /** The engine failed in the early stage: read on unchecked, or refuse with `503`. */
  #earlyFailed(
    request: Request,
    error: unknown,
  ): Response | undefined | Promise<Response> {
    this.#logger.error(
      "bun-security: the engine threw; the request was not checked",
      { error },
    );
    return this.#settings.failClosedOnEngineError
      ? this.#earlyRefusal(request, ENGINE_FAILED)
      : undefined;
  }

  /** The self-test's request in the early stage: explained, never counted. */
  #selfTestEarly(
    request: Request,
    facts: RequestFacts,
  ): Promise<undefined> | undefined {
    const state = createState(request, this.security);
    const trace: SelfTestTrace = {
      early: true,
      route: false,
      write: false,
      throttle: false,
      error: undefined,
    };
    state.selfTest = trace;
    this.#selfTestTrace = trace;
    try {
      const explained = this.security.explain(facts);
      if (explained instanceof Promise) {
        return explained.then(
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
  }

  /**
   * The route stage, as `SecurityGuard` runs it for one request: `true`
   * to let it through, or a `SecurityRefusalException` thrown. `profile`
   * and `skip` are the route's `@SecurityProfile()` and `@SkipSecurity()`.
   */
  async routeStage(
    req: BunRequest,
    res: BunResponse,
    profile: SecurityProfileMetadata | undefined,
    skip: readonly string[] | undefined,
  ): Promise<boolean> {
    if (!this.#active) return true;
    const request = req.request;
    const state = stateOf(request) ?? createState(request, this.security);
    if (profile !== undefined) state.profile = profile;
    if (skip !== undefined && skip.length === 0) return true;
    // The early stage decided an admitted request; one it could not check
    // (the engine failed) is evaluated in full here.
    const staged = state.early !== undefined;
    let decision: Decision;
    try {
      const base =
        state.facts ?? this.#factsOf(request, req.socketAddress?.address ?? "");
      const route = req.route;
      const identity: SecurityIdentity | undefined =
        await this.security.identify(req);
      const facts: RequestFacts = {
        ...base,
        ...(route
          ? {
              routeKey: `${(route.method || req.method).toUpperCase()} ${route.path}`,
            }
          : {}),
        ...(identity === undefined ? {} : { identity }),
      };
      state.routeFacts = facts;
      decision = await this.security.evaluate(
        facts,
        staged ? { stage: "route" } : {},
      );
    } catch (error) {
      this.#logger.error(
        "bun-security: the engine threw; the request was not checked",
        { error },
      );
      if (this.#settings.failClosedOnEngineError) {
        this.#refuse(res, ENGINE_FAILED);
      }
      return true;
    }
    state.route = decision;
    if (REFUSING.has(decision.action) && !skipped(decision, skip)) {
      this.#refuse(res, decision);
    }
    if (decision.action === "delay" && (decision.delayMs ?? 0) > 0) {
      await Bun.sleep(Math.min(decision.delayMs ?? 0, MAX_DELAY_MS));
    }
    if (this.#csrf !== undefined && !(skip?.includes("csrf") ?? false)) {
      const refusal = this.#csrf.check(req, profile?.crossSite === true);
      if (refusal !== undefined) this.#refuse(res, csrfDecision(refusal));
    }
    return true;
  }

  /** Throws the refusal, its `Retry-After` and `no-store` set on the response Nest answers on. */
  #refuse(res: BunResponse, decision: Decision): never {
    res.setHeader("cache-control", "no-store");
    if (decision.retryAfter !== undefined) {
      res.setHeader(
        "retry-after",
        String(Math.max(0, Math.ceil(decision.retryAfter))),
      );
    }
    throw new SecurityRefusalException(decision);
  }

  /**
   * The boot self-test's request (plan §3.3, D25): one marked request
   * through the adapter's socket-free `fetch()`, which the early stage, the
   * head middleware and the before-write observer must all see. Throws a
   * `ConfigError` naming what missed it.
   */
  async selfTest(): Promise<void> {
    const response = await this.#adapter.fetch(SECURITY_SELF_TEST_PATH, {
      headers: { [SELF_TEST_HEADER]: this.#token },
      remoteAddress: SELF_TEST_PEER,
    });
    const trace = this.#selfTestTrace;
    const missing: string[] = [];
    if (trace?.early !== true) {
      missing.push(
        "the early stage (the adapter's before-read hook) did not see it",
      );
    }
    if (trace?.route !== true) {
      missing.push("the head middleware did not see it");
    }
    if (trace?.write !== true) {
      missing.push(
        "the outcome observer (the before-write hook) did not see its answer",
      );
    }
    if (response.headers.get(SELF_TEST_HEADER) !== "ok") {
      missing.push(
        `its answer was not the head middleware's (status ${response.status})`,
      );
    }
    if (trace?.error !== undefined) {
      missing.push("the engine threw while explaining it");
    }
    if (missing.length > 0) {
      throw new ConfigError(
        `SecurityModule: the boot self-test failed: ${missing.join("; ")}`,
        trace?.error === undefined ? undefined : { error: trace.error },
      );
    }
  }

  /** Takes the engine off the adapter, and closes it if this service made it. */
  close(): void {
    if (!this.#active) return;
    this.#active = false;
    for (const remove of this.#removers.splice(0)) remove();
    if (this.#owned) this.security.close();
  }
}

/** Whether every refusing hit of `decision` is one of the rules the route skips. */
function skipped(
  decision: Decision,
  skip: readonly string[] | undefined,
): boolean {
  if (skip === undefined || skip.length === 0) return false;
  const refusing = decision.hits.filter((hit) => REFUSING.has(hit.action));
  return (
    refusing.length > 0 && refusing.every((hit) => skip.includes(hit.rule))
  );
}
