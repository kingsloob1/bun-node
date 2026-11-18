/**
 * How a management API route is declared and run: authentication, the
 * CSRF check on mutations, bun-common's `validate()` both ways (which is
 * also what the OpenAPI document reads), the permission check, the
 * step-up, then the handler.
 */
import type {
  BunRequest,
  BunResponse,
  BunRouter,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import { validate } from "@kingsleyweb/bun-common";
import type { CsrfGuard } from "../http/csrf";
import type { SecurityApiPermission } from "./contract/constants";
import type { PolicyScopeId } from "./contract/types";
import type { Operator, ResolvedSecurityApiOptions } from "./options";
import type { ControlPlane } from "./plane";
import type { Schema } from "./schema";
import { ApiProblem } from "./problems";
import { randomUUID } from "node:crypto";
import type { AuditRequestContext } from "./audit/context";
import { auditContext, breakGlassOperators } from "./audit/context";
import { BREAK_GLASS_STEP_UP_MS } from "./audit/breakglass";
import {
  AUDIT_INCOMPLETE_HEADER,
  BREAK_GLASS_HEADER,
} from "./contract/constants";
import { Problem } from "./schemas";

/** What a handler gets. */
export interface RouteContext<P, Q, B> {
  /** The request. */
  readonly req: BunRequest;
  /** The response, for a handler that writes it itself (`/live`). */
  readonly res: BunResponse;
  /** Path parameters, checked. */
  readonly params: P;
  /** The query, checked. */
  readonly query: Q;
  /** The body, checked. */
  readonly body: B;
  /** Who is calling. */
  readonly operator: Operator;
  /** The control plane. */
  readonly plane: ControlPlane;
  /** Checks a permission on a scope: a `403` when missing. */
  readonly require: (
    permission: SecurityApiPermission,
    scope: PolicyScopeId,
  ) => Promise<void>;
  /**
   * The step-up check for a guarded action: `true` when it may go ahead
   * now; `false` under `approvals` with no hook (the caller opens an
   * approval instead); a `401` with the step-up URL when the hook says no.
   */
  readonly stepUp: () => Promise<boolean>;
}

/** What a handler answers: a status and a JSON body, or nothing when it wrote the response. */
export type RouteAnswer =
  | {
      readonly status: number;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | undefined;

/** A route's declaration. */
export interface RouteSpec<P, Q, B> {
  /** The method. */
  readonly method: "get" | "post" | "put" | "delete";
  /** The path under the API's base. */
  readonly path: string;
  /** A one-line summary, for the document. */
  readonly summary: string;
  /** The document's tag. */
  readonly tag: string;
  /** Path parameters. */
  readonly params?: Schema<P>;
  /** The query. */
  readonly query?: Schema<Q>;
  /** The body. */
  readonly body?: Schema<B>;
  /** Every status it answers, with its body's schema (`null`: none). Problems are added. */
  readonly responses: Readonly<
    Record<number, Schema<unknown> | null | Readonly<Record<string, unknown>>>
  >;
  /** The problem statuses it may answer, besides 400, 401 and 500. */
  readonly problems?: readonly number[];
  /** Taken without an operator (the break-glass login); the CSRF check still applies. */
  readonly public?: boolean;
  /** Handles it. */
  readonly handle: (context: RouteContext<P, Q, B>) => Promise<RouteAnswer>;
}

/** The operator authenticated for a request. */
const OPERATORS = new WeakMap<Request, Operator>();

/** A break-glass session's login time, by its operator object, for step-up. */
const BREAK_GLASS_SESSIONS = new WeakMap<Operator, number>();

/** The methods that change something. */
const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Sends `problem`. */
export function sendProblem(res: BunResponse, problem: ApiProblem): void {
  for (const [name, value] of Object.entries(problem.headers))
    res.set(name, value);
  res
    .status(problem.status)
    .set("content-type", "application/problem+json")
    .send(JSON.stringify(problem.toBody()));
}

/** Registers `spec` on `router`. */
export function addRoute<P, Q, B>(
  router: BunRouter,
  spec: RouteSpec<P, Q, B>,
  options: ResolvedSecurityApiOptions,
  plane: ControlPlane,
  csrf: CsrfGuard | undefined,
): void {
  const authenticate: RouterHandler = async (req, res, next) => {
    let operator: Operator | null = null;
    const token = req.request.headers.get(BREAK_GLASS_HEADER);
    if (spec.public === true) {
      // No operator: only the CSRF check below.
    } else if (token !== null && options.breakGlass !== undefined) {
      // A break-glass session: the host's identity provider is not asked.
      const session = options.breakGlass.session(token);
      if (session !== undefined) {
        operator = { id: options.breakGlass.id, name: "break-glass" };
        breakGlassOperators.add(operator);
        BREAK_GLASS_SESSIONS.set(operator, session.iat);
      }
    } else {
      try {
        operator = await options.authenticate(req);
      } catch (error) {
        next(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    if (
      spec.public !== true &&
      (operator === null ||
        typeof operator?.id !== "string" ||
        operator.id === "")
    ) {
      // Never in the audit chain (anonymous traffic must not grow it): the log only.
      plane.logger.info(
        "bun-security api: refused an unauthenticated request",
        {
          method: req.method,
          path: req.path,
          address: req.ip ?? null,
        },
      );
      sendProblem(
        res,
        new ApiProblem(
          401,
          "unauthenticated",
          "sign in to use the security management API",
        ),
      );
      return;
    }
    if (operator !== null) OPERATORS.set(req.request, operator);
    if (MUTATIONS.has(req.method) && options.csrf !== false) {
      const refusal = csrf?.check(req);
      if (
        refusal !== undefined ||
        !req.request.headers.has(options.csrf.header)
      ) {
        // A forged request is not the operator's act: the log only, never the chain.
        plane.logger.info("bun-security api: refused a request as cross-site", {
          method: req.method,
          path: req.path,
          address: req.ip ?? null,
          reason: refusal ?? "no CSRF header",
        });
        sendProblem(
          res,
          new ApiProblem(
            403,
            "csrf",
            refusal === undefined
              ? `a change needs the ${options.csrf.header} header`
              : `refused as a cross-site request (${refusal})`,
          ),
        );
        return;
      }
    }
    next();
  };

  const statuses = [400, 401, 403, 500, ...(spec.problems ?? [])];
  const responses: Record<number, unknown> = { ...spec.responses };
  for (const status of statuses)
    responses[status] ??= { content: { "application/problem+json": Problem } };

  const handler: RouterHandler = async (req, res, next) => {
    const operator = OPERATORS.get(req.request) ?? { id: "anonymous" };
    const breakGlassAt = BREAK_GLASS_SESSIONS.get(operator);
    const audit: AuditRequestContext = {
      actor: {
        id: operator.id,
        kind:
          breakGlassAt !== undefined
            ? "break-glass"
            : spec.public === true
              ? "system"
              : "operator",
      },
      address: req.ip ?? null,
      sessionId: operator.sessionId ?? null,
      requestId: req.request.headers.get("x-request-id") ?? randomUUID(),
      permissions: [],
      stepUp: false,
      incomplete: false,
    };
    /** The permission and scope a `require` refused, for the refusal's entry. */
    let denied: { permission: string; scope: string } | undefined;
    const context: RouteContext<P, Q, B> = {
      req,
      res,
      params: req.params as P,
      query: req.query as Q,
      body: req.body as B,
      operator,
      plane,
      require: async (permission, scope) => {
        audit.permissions.push(`${permission} ${scope}`);
        if (!(await plane.can(operator, permission, scope))) {
          denied = { permission, scope };
          throw new ApiProblem(
            403,
            "forbidden",
            `this needs ${permission} on ${scope}`,
          );
        }
      },
      stepUp: async () => {
        // A break-glass login is a fresh second factor (TOTP) for 5 minutes.
        if (
          breakGlassAt !== undefined &&
          options.now() - breakGlassAt <= BREAK_GLASS_STEP_UP_MS
        ) {
          audit.stepUp = true;
          return true;
        }
        if (options.guard === "none") return true;
        if (options.guard === "approvals") return false;
        if (await options.stepUp!.verify(req, operator)) {
          audit.stepUp = true;
          return true;
        }
        throw new ApiProblem(
          401,
          "step_up_required",
          "this change needs a fresh second factor",
          {
            stepUpUrl: options.stepUp!.challenge(req),
          },
        );
      },
    };
    try {
      const answer = await auditContext.run(
        audit,
        async () => await spec.handle(context),
      );
      if (audit.incomplete) res.set(AUDIT_INCOMPLETE_HEADER, "incomplete");
      if (answer === undefined) return;
      for (const [name, value] of Object.entries(answer.headers ?? {}))
        res.set(name, value);
      if (answer.body === undefined) {
        res.status(answer.status).send("");
      } else {
        res.status(answer.status).json(answer.body as never);
      }
    } catch (error) {
      if (
        error instanceof ApiProblem &&
        (error.code === "forbidden" || error.code === "step_up_required") &&
        OPERATORS.has(req.request)
      ) {
        // A signed-in operator refused (a permission, a step-up): in the chain.
        await auditContext
          .run(
            audit,
            async () =>
              await plane.audit.event(
                "access.refused",
                denied?.scope ?? "global",
                {
                  outcome: "refused",
                  reason: error.code,
                  permission: denied?.permission ?? null,
                  route: `${req.method} ${spec.path}`,
                  target: { ...(req.params as Record<string, string>) },
                },
              ),
          )
          .catch((failure: unknown) =>
            plane.logger.error(
              "bun-security api: a refusal could not be audited",
              { error: failure },
            ),
          );
      }
      next(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const route = (
    router as unknown as Record<
      string,
      (
        path: string,
        ...handlers: RouterHandler[]
      ) => { describe?: (doc: unknown) => unknown }
    >
  )[spec.method].call(
    router,
    spec.path,
    authenticate,
    validate(
      {
        ...(spec.params === undefined ? {} : { params: spec.params }),
        ...(spec.query === undefined ? {} : { query: spec.query }),
        ...(spec.body === undefined ? {} : { body: spec.body }),
      },
      { responses: responses as never },
    ),
    handler,
  );
  route?.describe?.({ summary: spec.summary, tags: [spec.tag] });
}
