/**
 * The checks (typed-client plan §5, PR-C4): the built-in schemas run through
 * bun-contract's guards, the very ones the server runs (D20, Q18), and BYO
 * schemas through its one runner, `validateStandard`. So a check on the
 * client and on the server agree on issue paths, value-free messages and
 * prototype-key stripping, by construction.
 *
 * **Loaded lazily.** `client.ts` imports this module with `import()` only
 * when a call has something to check, so a client with validation off (a
 * production default) never loads it, nor bun-contract, and a bundler that
 * splits puts both in their own chunk (`__tests__/budget.test.ts` measures
 * the two apart; `__tests__/bundleSafety.test.ts` proves the entry chunk
 * holds none of it).
 *
 * A request is the HTTP transport's inbound side, checked with a **sender**
 * (it hands back the message it was given, never touching it); a response is
 * the outbound side keyed by status, checked with a **receiver** (it strips
 * prototype-pollution keys from what arrived, as the server does from a
 * request). A built-in schema checks and changes nothing; a BYO schema's
 * output is what is sent or delivered (§5.4).
 */
import type {
  AnyContract,
  StandardOutcome,
  StandardSchemaV1,
  ValidationIssue,
} from "@kingsleyweb/bun-contract";
import type {
  ClientError,
  ValidationError,
  ValidationErrorIssue,
} from "./errors";
import type {
  FailureMode,
  PartValidation,
  RouteSchemas,
  SchemaSource,
  ValidationConfig,
} from "./types";
import {
  ContractError,
  createReceiver,
  createSender,
  validateStandard,
} from "@kingsleyweb/bun-contract";
import { httpTransport } from "@kingsleyweb/bun-contract/lib/http";

/** A request part the client checks. */
export type RequestPart = "params" | "query" | "body" | "headers";

/** What runs for one part (or one response status), as the configuration resolved it. */
export interface PartPlan {
  /** Run the route's built-in schema for the part, when it has one. */
  readonly builtin: boolean;
  /** A BYO schema run after it. */
  readonly custom?: StandardSchemaV1;
}

/** A check's outcome: the values to send or deliver, and every issue found. */
export interface Checked<T> {
  /** The values: as given, except where a BYO schema passed (its output). */
  readonly value: T;
  /** Every issue, the built-in ones first; empty when everything passed. */
  readonly issues: readonly ValidationErrorIssue[];
}

/**
 * A compiled guard as this module calls it: a message in, the message (a
 * receiver's parsed) or a `ContractError` out, maybe asynchronously.
 */
type Check = (message: Record<string, unknown>) => unknown;

/** The guards compiled for one route's schemas, by the parts or status they check. */
const GUARDS = new WeakMap<RouteSchemas, Map<string, Check>>();

/** The guard for `id` of `route`, compiled once by `build`. */
function cached(route: RouteSchemas, id: string, build: () => Check): Check {
  let byId = GUARDS.get(route);
  if (byId === undefined) {
    byId = new Map();
    GUARDS.set(route, byId);
  }
  let guard = byId.get(id);
  if (guard === undefined) {
    guard = build();
    byId.set(id, guard);
  }
  return guard;
}

/** The HTTP contract of `def`, built through the server's own transport. */
function contractOf(def: object): AnyContract {
  return httpTransport.contract(def as never);
}

/** A guard's issues, marked as the built-in schema's, with a response's `body` target named `response`. */
function builtinIssues(
  issues: readonly ValidationIssue[],
  response: boolean,
): ValidationErrorIssue[] {
  return issues.map((issue) => ({
    ...issue,
    target: (response
      ? "response"
      : issue.target) as ValidationErrorIssue["target"],
    source: "builtin",
  }));
}

/** A BYO schema's issues, marked as such. */
function customIssues(
  issues: readonly ValidationIssue[],
): ValidationErrorIssue[] {
  return issues.map((issue) => ({
    ...issue,
    target: issue.target as ValidationErrorIssue["target"],
    source: "custom",
  }));
}

/**
 * Checks request parts (§5.4): the built-in schemas of the parts whose plan
 * asks for them, all at once through one sender, then each part's BYO
 * schema, on the value as given (a sender's output is its input). A BYO
 * schema that passes replaces its part's value with its output.
 *
 * @param route  The route's built-in schemas; `undefined` when it has none.
 * @param plans  What runs, per part; a part not listed is not checked.
 * @param values The parts' values, as the call gives them.
 */
export async function checkRequest(
  route: RouteSchemas | undefined,
  plans: Partial<Record<RequestPart, PartPlan>>,
  values: Partial<Record<RequestPart, unknown>>,
): Promise<Checked<Partial<Record<RequestPart, unknown>>>> {
  const parts = Object.keys(plans) as RequestPart[];
  const issues: ValidationErrorIssue[] = [];
  const builtin = parts.filter(
    (part) => plans[part]!.builtin && route?.[part] !== undefined,
  );
  if (route !== undefined && builtin.length > 0) {
    const guard = cached(
      route,
      `request:${builtin.join(",")}`,
      () =>
        createSender(
          contractOf({
            inbound: Object.fromEntries(
              builtin.map((part) => [part, route[part]]),
            ),
          }),
          "inbound",
        ) as unknown as Check,
    );
    const message = Object.fromEntries(
      builtin.map((part) => [part, values[part]]),
    );
    const outcome = await guard(message);
    if (outcome instanceof ContractError)
      issues.push(...builtinIssues(outcome.issues, false));
  }
  const out = { ...values };
  for (const part of parts) {
    const custom = plans[part]!.custom;
    if (custom === undefined) continue;
    const result: StandardOutcome<unknown> = await validateStandard(
      custom,
      values[part],
      part,
    );
    if (result.ok) out[part] = result.value;
    else issues.push(...customIssues(result.issues));
  }
  return { value: out, issues };
}

/**
 * Checks a response body (§5.4, §5.5): the status's built-in schema through
 * a receiver (which strips prototype-pollution keys from the body in place),
 * then the BYO schema, on the built-in schema's output when it passed and on
 * the body when it failed. A BYO schema that passes makes its output the
 * value delivered; otherwise the body is delivered as it arrived.
 *
 * @param route  The route's built-in schemas; `undefined` when it has none.
 * @param status The response's status.
 * @param plan   What runs for this status.
 * @param body   The body as the client read it (JSON parsed, text, …).
 */
export async function checkResponse(
  route: RouteSchemas | undefined,
  status: number,
  plan: PartPlan,
  body: unknown,
): Promise<Checked<unknown>> {
  const issues: ValidationErrorIssue[] = [];
  let parsed: { ok: true; value: unknown } | undefined;
  const schema = route?.responses?.[status];
  if (plan.builtin && route !== undefined && schema !== undefined) {
    const guard = cached(route, "response", () =>
      createReceiver(
        contractOf({
          outbound: Object.fromEntries(
            Object.entries(route.responses ?? {}).map(([code, body]) => [
              code,
              { body },
            ]),
          ),
        }),
        "outbound",
        { undeclaredKey: "allow" },
      ),
    );
    const outcome = await guard({ status, body });
    if (outcome instanceof ContractError)
      issues.push(...builtinIssues(outcome.issues, true));
    else parsed = { ok: true, value: (outcome as { body: unknown }).body };
  }
  let value = body;
  if (plan.custom !== undefined) {
    const result: StandardOutcome<unknown> = await validateStandard(
      plan.custom,
      parsed === undefined ? body : parsed.value,
      "response",
      String(status),
      undefined,
      { stripProtoKeys: "nest" },
    );
    if (result.ok) value = result.value;
    else issues.push(...customIssues(result.issues));
  }
  return { value, issues };
}

/* ------------------------------------------------------------------------ */
/* The configuration (§6.2), resolved per call.                              */
/* ------------------------------------------------------------------------ */

/** The request parts, in the order they are checked and reported. */
const REQUEST_PARTS: readonly RequestPart[] = [
  "params",
  "query",
  "body",
  "headers",
];

/** One part's (or one status's) validation, as the levels resolved it. */
interface PartState {
  /** Run the built-in schema. */
  enabled: boolean;
  /** The BYO schema, run after it. */
  custom: StandardSchemaV1 | undefined;
  /** Run only the BYO schema. */
  replace: boolean;
}

/** One call's validation, every level merged. */
interface ResolvedValidation {
  /** Each request part's. */
  parts: Record<RequestPart, PartState>;
  /** Every response status's, unless {@link statuses} has its own. */
  response: PartState;
  /** Per-status settings. */
  statuses: Map<number, PartState>;
  /** What a request failure does. */
  onRequest: FailureMode;
  /** What a response failure does. */
  onResponse: FailureMode;
}

/** A part turned off: nothing runs, BYO included. */
const offState = (): PartState => ({
  enabled: false,
  custom: undefined,
  replace: false,
});

/** Applies one level's entry for a part (§6.2): `true` on, `false` off, an object per key. */
function applyPart(state: PartState, entry: PartValidation | undefined): void {
  if (entry === undefined) return;
  if (entry === false) {
    Object.assign(state, offState());
    return;
  }
  if (entry === true) {
    state.enabled = true;
    return;
  }
  if (entry.enabled !== undefined) state.enabled = entry.enabled;
  if (entry.custom !== undefined) state.custom = entry.custom;
  if (entry.replace !== undefined) state.replace = entry.replace;
}

/**
 * Merges the validation levels (client, route, call) over the mode's
 * defaults: per key, later winning; a `false` turns everything under it
 * off until a later level turns it back on.
 */
function resolveValidation(
  development: boolean,
  levels: readonly (ValidationConfig | false | undefined)[],
): ResolvedValidation {
  const fresh = (): PartState => ({
    enabled: development,
    custom: undefined,
    replace: false,
  });
  const out: ResolvedValidation = {
    parts: {
      params: fresh(),
      query: fresh(),
      body: fresh(),
      headers: fresh(),
    },
    response: fresh(),
    statuses: new Map(),
    onRequest: "throw",
    onResponse: "warn",
  };
  for (const level of levels) {
    if (level === undefined) continue;
    if (level === false) {
      for (const part of REQUEST_PARTS) out.parts[part] = offState();
      out.response = offState();
      out.statuses.clear();
      continue;
    }
    if (level.request !== undefined)
      for (const part of REQUEST_PARTS)
        applyPart(out.parts[part], level.request);
    for (const part of REQUEST_PARTS) applyPart(out.parts[part], level[part]);
    const response = level.response;
    if (typeof response === "boolean") {
      applyPart(out.response, response);
      for (const state of out.statuses.values()) applyPart(state, response);
    } else if (response !== undefined) {
      for (const [code, entry] of Object.entries(response)) {
        const status = Number(code);
        const state = out.statuses.get(status) ?? { ...out.response };
        applyPart(state, entry);
        out.statuses.set(status, state);
      }
    }
    const failure = level.onFailure;
    if (typeof failure === "string" || typeof failure === "function") {
      out.onRequest = failure;
      out.onResponse = failure;
    } else if (failure !== undefined) {
      if (failure.request !== undefined) out.onRequest = failure.request;
      if (failure.response !== undefined) out.onResponse = failure.response;
    }
  }
  return out;
}

/** What runs for a part, when anything does: the built-in schema (if there is a source) and the BYO one. */
function planOf(state: PartState, schemas: boolean): PartPlan | undefined {
  const builtin = schemas && state.enabled && !state.replace;
  if (!builtin && state.custom === undefined) return undefined;
  return state.custom === undefined
    ? { builtin }
    : { builtin, custom: state.custom };
}

/* ------------------------------------------------------------------------ */
/* The checks a client runs.                                                 */
/* ------------------------------------------------------------------------ */

/** What `createClient` hands the checks when it first loads them. */
export interface ChecksContext {
  /** The client's mode is development (its defaults turn checks on). */
  readonly development: boolean;
  /** The built-in schemas' source, as configured. */
  readonly source:
    | SchemaSource<Record<string, unknown>>
    | (() => Promise<SchemaSource<Record<string, unknown>>>)
    | undefined;
  /** Where `"warn"` writes. */
  readonly logger: Pick<Console, "warn">;
  /**
   * The error classes, handed over rather than imported, so a bundler that
   * splits keeps `./errors` in the entry chunk alone instead of moving it to
   * a chunk both load.
   */
  readonly errors: {
    /** {@link ClientError}. */
    readonly ClientError: typeof ClientError;
    /** {@link ValidationError}. */
    readonly ValidationError: typeof ValidationError;
  };
}

/** One call's checks: the request parts, the headers as sent, and the response. */
export interface CallChecks {
  /**
   * Checks the params, query and body before anything is built (§5.4):
   * resolves to the options to send (a passing BYO schema's output in its
   * part's place), or rejects under `"throw"`.
   */
  readonly request: <
    O extends { params?: unknown; query?: unknown; body?: unknown },
  >(
    options: O,
  ) => Promise<O>;
  /** Checks the headers as sent, on the first attempt; `undefined` when nothing checks them. */
  readonly headers: ((request: Request) => Promise<void>) | undefined;
  /** Checks a declared status's body (§5.5): resolves to what to deliver, or rejects under `"throw"`. */
  readonly response: (status: number, body: unknown) => Promise<unknown>;
}

/** The checks of one client: each call's, from its route key and its validation levels. */
export type Checks = (
  key: string,
  levels: readonly (ValidationConfig | false | undefined)[],
) => CallChecks;

/**
 * Builds a client's checks: the schema source, loaded on first use (a
 * failed load is retried by the next call), and the failure modes.
 */
export function createChecks(context: ChecksContext): Checks {
  const { source, logger } = context;
  const { ClientError, ValidationError } = context.errors;
  const hasSource = source !== undefined;
  let loaded:
    Promise<Readonly<Record<string, RouteSchemas | undefined>>> | undefined;
  const loadSchemas = (
    key: string,
  ): Promise<Readonly<Record<string, RouteSchemas | undefined>>> => {
    loaded ??= (async () => {
      let module: SchemaSource<Record<string, unknown>> | undefined;
      try {
        module = typeof source === "function" ? await source() : source;
      } catch (error) {
        loaded = undefined;
        throw new ClientError(`${key}: the built-in schemas failed to load`, {
          key,
          cause: error,
        });
      }
      const schemas = (module as { schemas?: unknown } | undefined)?.schemas;
      if (typeof schemas !== "object" || schemas === null) {
        loaded = undefined;
        throw new ClientError(
          `${key}: the schema source has no \`schemas\` object (a module generated by \`bun-client generate --zod\` exports one)`,
          { key },
        );
      }
      return schemas as Readonly<Record<string, RouteSchemas | undefined>>;
    })();
    return loaded;
  };

  /** The route's built-in schemas, when a plan runs one. */
  const routeOf = async (
    key: string,
    plans: readonly PartPlan[],
  ): Promise<RouteSchemas | undefined> =>
    plans.some((plan) => plan.builtin)
      ? (await loadSchemas(key))[key]
      : undefined;

  /** Applies a failure mode: throws, warns, or calls the hook. */
  const failed = (mode: FailureMode, error: ValidationError): void => {
    if (mode === "throw") throw error;
    if (mode === "warn") logger.warn(error.message);
    else mode(error);
  };

  return (key, levels) => {
    const validation = resolveValidation(context.development, levels);
    const headersPlan = planOf(validation.parts.headers, hasSource);
    return {
      request: async (options) => {
        const plans: Partial<Record<RequestPart, PartPlan>> = {};
        for (const part of ["params", "query", "body"] as const) {
          const plan = planOf(validation.parts[part], hasSource);
          if (plan !== undefined) plans[part] = plan;
        }
        const list = Object.values(plans);
        if (list.length === 0) return options;
        // The server sees an absent params or query as an empty object.
        const { value, issues } = await checkRequest(
          await routeOf(key, list),
          plans,
          {
            params: options.params ?? {},
            query: options.query ?? {},
            body: options.body,
          },
        );
        if (issues.length > 0)
          failed(
            validation.onRequest,
            new ValidationError(key, "request", issues),
          );
        const out: Record<string, unknown> = { ...options };
        for (const part of Object.keys(plans))
          out[part] = value[part as RequestPart];
        return out as typeof options;
      },
      headers:
        headersPlan === undefined
          ? undefined
          : async (request) => {
              const headers: Record<string, string> = {};
              request.headers.forEach((value, name) => {
                headers[name] = value;
              });
              const { issues } = await checkRequest(
                await routeOf(key, [headersPlan]),
                { headers: headersPlan },
                { headers },
              );
              if (issues.length > 0)
                failed(
                  validation.onRequest,
                  new ValidationError(key, "request", issues),
                );
            },
      response: async (status, body) => {
        const plan = planOf(
          validation.statuses.get(status) ?? validation.response,
          hasSource,
        );
        if (plan === undefined) return body;
        const { value, issues } = await checkResponse(
          await routeOf(key, [plan]),
          status,
          plan,
          body,
        );
        if (issues.length > 0) {
          failed(
            validation.onResponse,
            new ValidationError(key, "response", issues, status),
          );
          return body;
        }
        return value;
      },
    };
  };
}
