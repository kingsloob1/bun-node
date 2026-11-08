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
  channelContract,
  ContractError,
  createReceiver,
  createSender,
  validateStandard,
} from "@kingsleyweb/bun-contract";
import { httpTransport } from "@kingsleyweb/bun-contract/lib/http";
import { droppedKeys } from "@kingsleyweb/bun-contract/lib/unknownKeys";

// The runner, for `./sseChecks` (loaded with this module, by `./sse`), and
// the guards and `channelContract` for `./channelChecks` (loaded the same
// way, by `./channel`), so bun-contract's values are imported here alone.
export {
  channelContract,
  ContractError,
  createReceiver,
  createSender,
  validateStandard,
};

/** A request part the client checks. */
export type RequestPart = "params" | "query" | "body" | "headers" | "files";

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

/**
 * A guard's issues, marked as the built-in schema's, with a response's
 * `body` target named `response` (its `headers` keep theirs).
 */
export function builtinIssues(
  issues: readonly ValidationIssue[],
  response: boolean,
): ValidationErrorIssue[] {
  return issues.map((issue) => ({
    ...issue,
    target: (response && issue.target === "body"
      ? "response"
      : issue.target) as ValidationErrorIssue["target"],
    source: "builtin",
  }));
}

/**
 * A route's schema for a body, as a guard checks it: a bun-common `chunks()`
 * declaration (a server's own module may hold one) is its chunk schema, so
 * a streamed NDJSON status is checked line by line against it.
 */
function bodySchema(schema: StandardSchemaV1 | null): StandardSchemaV1 | null {
  const declared = schema as { kind?: unknown; chunk?: unknown } | null;
  return declared !== null &&
    declared.kind === "chunks" &&
    typeof declared.chunk === "object" &&
    declared.chunk !== null &&
    "~standard" in declared.chunk
    ? (declared.chunk as StandardSchemaV1)
    : schema;
}

/** A BYO schema's issues, marked as such. */
export function customIssues(
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
 * asks for them, all at once through one sender (the files, which the HTTP
 * transport has no part for, through the same runner on their own), then
 * each part's BYO schema, on the value as given (a sender's output is its
 * input). A BYO schema that passes replaces its part's value with its
 * output.
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
    (part) =>
      part !== "files" && plans[part]!.builtin && route?.[part] !== undefined,
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
  if (plans.files?.builtin === true && route?.files !== undefined) {
    const result: StandardOutcome<unknown> = await validateStandard(
      route.files,
      values.files,
      "files",
    );
    if (!result.ok) issues.push(...builtinIssues(result.issues, false));
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

/** What a response check runs (§5.4–§5.6): the body's plan, and whether the built-in headers schema runs. */
export interface ResponsePlan extends PartPlan {
  /** Run the status's built-in headers schema, when it has one. */
  readonly headers: boolean;
}

/** What a response check is given: the body, the headers, or both. */
export interface ResponseInput {
  /** Check the body (`false` for one left unread, or the headers alone). */
  readonly checkBody: boolean;
  /** The body as the client read it (JSON parsed, text, …). */
  readonly body?: unknown;
  /** The headers as they arrived, by lower-case name; `undefined` leaves them unchecked (an NDJSON line). */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Checks a response (§5.4–§5.6): the status's built-in schemas, its
 * declared headers and its body, through one receiver (which strips
 * prototype-pollution keys from the body in place), then the BYO schema,
 * on the body, on the built-in schema's output when that passed and on the
 * body when it failed. A BYO schema that passes makes its output the value
 * delivered; otherwise the body is delivered as it arrived. Headers are
 * checked, never changed.
 *
 * @param route  The route's built-in schemas; `undefined` when it has none.
 * @param status The response's status.
 * @param plan   What runs for this status.
 * @param input  The body and the headers, and which of them to check.
 */
export async function checkResponse(
  route: RouteSchemas | undefined,
  status: number,
  plan: ResponsePlan,
  input: ResponseInput,
): Promise<Checked<unknown>> {
  const issues: ValidationErrorIssue[] = [];
  let parsed: { ok: true; value: unknown } | undefined;
  const body =
    input.checkBody && plan.builtin && route?.responses?.[status] !== undefined;
  const headers =
    input.headers !== undefined &&
    plan.headers &&
    route?.responseHeaders?.[status] !== undefined;
  if (route !== undefined && (body || headers)) {
    const guard = cached(
      route,
      `response:${body ? "body" : ""}:${headers ? "headers" : ""}`,
      () => {
        const statuses = new Set([
          ...(body ? Object.keys(route.responses ?? {}) : []),
          ...(headers ? Object.keys(route.responseHeaders ?? {}) : []),
        ]);
        return createReceiver(
          contractOf({
            outbound: Object.fromEntries(
              [...statuses].map((code) => {
                const parts: Record<string, unknown> = {};
                const declared = route.responseHeaders?.[Number(code)];
                if (headers && declared !== undefined) parts.headers = declared;
                const schema = route.responses?.[Number(code)];
                if (body && schema !== undefined)
                  parts.body = bodySchema(schema);
                return [code, parts];
              }),
            ),
          }),
          "outbound",
          { undeclaredKey: "allow" },
        );
      },
    );
    const message: Record<string, unknown> = { status };
    if (headers) message.headers = { ...input.headers };
    if (body) message.body = input.body;
    const outcome = await guard(message);
    if (outcome instanceof ContractError)
      issues.push(...builtinIssues(outcome.issues, true));
    else if (body)
      parsed = { ok: true, value: (outcome as { body: unknown }).body };
  }
  let value = input.body;
  if (input.checkBody && plan.custom !== undefined) {
    const result: StandardOutcome<unknown> = await validateStandard(
      plan.custom,
      parsed === undefined ? input.body : parsed.value,
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

/**
 * One part a BYO schema checked: its name (`"query"`, `"body"`,
 * `"response"`), what the schema was given, and its output (falsy when no
 * BYO schema ran: nothing to review).
 */
type Reviewed = readonly [
  target: ValidationErrorIssue["target"],
  input: unknown,
  output: unknown,
];

/**
 * `validate.unknownKeys` (`ValidationConfig.unknownKeys`): reviews BYO
 * schemas' outputs against what they were given (bun-contract's
 * `droppedKeys`): under `"warn"` logs the keys each dropped
 * (`<call>: the custom <target> schema dropped keys: a, b.c`); under
 * `"reject"` adds an `Unrecognized key` issue per key to `issues`.
 *
 * @param mode   `"warn"` or `"reject"`.
 * @param call   The route key, for the warning.
 * @param status The response's status, as the issues' `key`; `undefined` for a request part.
 * @param issues The call's issues so far, returned as they are when nothing is added.
 * @param logger Where `"warn"` writes.
 * @param parts  The parts to review.
 */
function reviewDropped(
  mode: "warn" | "reject",
  call: string,
  status: number | undefined,
  issues: readonly ValidationErrorIssue[],
  logger: Pick<Console, "warn">,
  ...parts: Reviewed[]
): readonly ValidationErrorIssue[] {
  const found: ValidationErrorIssue[] = [];
  for (const [target, input, output] of parts) {
    // A schema that failed hands back its input: nothing was dropped.
    const paths = output ? droppedKeys(input, output) : [];
    if (paths.length === 0) continue;
    if (mode === "warn") {
      logger.warn(
        `${call}: the custom ${target} schema dropped keys: ${paths.join(", ")}`,
      );
      continue;
    }
    for (const path of paths)
      found.push({
        target,
        message: "Unrecognized key",
        path,
        source: "custom",
        ...(status === undefined ? {} : { key: String(status) }),
      });
  }
  return found.length === 0 ? issues : [...issues, ...found];
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
  "files",
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
  /** The keys a BYO schema dropped: looked for unless `"strip"`. */
  unknownKeys: "strip" | "warn" | "reject";
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
      files: fresh(),
    },
    response: fresh(),
    statuses: new Map(),
    onRequest: "throw",
    onResponse: "warn",
    unknownKeys: "strip",
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
    if (level.unknownKeys !== undefined) out.unknownKeys = level.unknownKeys;
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

/**
 * What runs for a response status, when anything does: the body's plan, and
 * the built-in headers schema, which `replace` leaves on (it replaces the
 * body's built-in schema, the one a BYO schema stands in for).
 */
function responsePlanOf(
  state: PartState,
  schemas: boolean,
): ResponsePlan | undefined {
  const body = planOf(state, schemas);
  const headers = schemas && state.enabled;
  if (body === undefined && !headers) return undefined;
  return body === undefined
    ? { builtin: false, headers }
    : { ...body, headers };
}

/** A `Headers`' entries as an object, by lower-case name. */
function headersObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

/* ------------------------------------------------------------------------ */
/* The checks a client runs.                                                 */
/* ------------------------------------------------------------------------ */

/** What checks an event stream's events (`CallChecks.events`). */
export interface EventsPlan {
  /** What runs for the stream's status. */
  readonly plan: PartPlan;
  /** The route's built-in schemas; `undefined` when the plan runs none. */
  readonly route: RouteSchemas | undefined;
  /** What a failure does, as the levels resolved it (`sse()` adds `"drop"`). */
  readonly mode: FailureMode | "drop";
}

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
   * Checks the params, query, body and files before anything is built (§5.4):
   * resolves to the options to send (a passing BYO schema's output in its
   * part's place), or rejects under `"throw"`. A `raw` body (a `FormData`,
   * `URLSearchParams`, `Blob`, buffer or stream, which passes through as it
   * is) is not checked, nor are the files (a `FormData` carries its own).
   */
  readonly request: <
    O extends {
      params?: unknown;
      query?: unknown;
      body?: unknown;
      files?: unknown;
    },
  >(
    options: O,
    raw: boolean,
  ) => Promise<O>;
  /** Checks the headers as sent, on the first attempt; `undefined` when nothing checks them. */
  readonly headers: ((request: Request) => Promise<void>) | undefined;
  /**
   * Checks a declared status's body (§5.5), and its headers (§5.6) when
   * they are given: resolves to what to deliver, or rejects under
   * `"throw"`. An NDJSON line is checked without them.
   */
  readonly response: (
    status: number,
    body: unknown,
    headers?: Headers,
  ) => Promise<unknown>;
  /**
   * Checks a declared status's headers alone (§5.6), for a body left unread
   * (a stream, or a download as `"stream"`): resolves, or rejects under
   * `"throw"`.
   */
  readonly responseHeaders: (status: number, headers: Headers) => Promise<void>;
  /**
   * What checks an event stream's events (`sse.md` §3.3), as the stream's
   * status says: the plan, the route's built-in schemas (loaded when the
   * plan runs them) and the failure mode; `undefined` when nothing checks
   * them. `./sseChecks` runs the checks, so an HTTP-only client's checks
   * carry none of that code.
   */
  readonly events: (status: number) => Promise<EventsPlan | undefined>;
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

  /** The route's built-in schemas, when a response plan runs one (its headers' only when they are given). */
  const responseRouteOf = async (
    key: string,
    plan: ResponsePlan,
    headers: boolean,
  ): Promise<RouteSchemas | undefined> =>
    plan.builtin || (headers && plan.headers)
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
      request: async (options, raw) => {
        const plans: Partial<Record<RequestPart, PartPlan>> = {};
        for (const part of ["params", "query", "body", "files"] as const) {
          // A pre-built body carries its own fields and files.
          if (raw && (part === "body" || part === "files")) continue;
          const plan = planOf(validation.parts[part], hasSource);
          if (plan !== undefined) plans[part] = plan;
        }
        const list = Object.values(plans);
        if (list.length === 0) return options;
        // The server sees an absent params or query as an empty object.
        const checked = await checkRequest(await routeOf(key, list), plans, {
          params: options.params ?? {},
          query: options.query ?? {},
          body: options.body,
          files: options.files ?? {},
        });
        const value = checked.value;
        let issues = checked.issues;
        if (validation.unknownKeys !== "strip")
          issues = reviewDropped(
            validation.unknownKeys,
            key,
            undefined,
            issues,
            logger,
            ["query", options.query, plans.query?.custom && value.query],
            ["body", options.body, plans.body?.custom && value.body],
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
              const { issues } = await checkRequest(
                await routeOf(key, [headersPlan]),
                { headers: headersPlan },
                { headers: headersObject(request.headers) },
              );
              if (issues.length > 0)
                failed(
                  validation.onRequest,
                  new ValidationError(key, "request", issues),
                );
            },
      response: async (status, body, headers) => {
        const plan = responsePlanOf(
          validation.statuses.get(status) ?? validation.response,
          hasSource,
        );
        if (plan === undefined) return body;
        const checked = await checkResponse(
          await responseRouteOf(key, plan, headers !== undefined),
          status,
          plan,
          {
            checkBody: true,
            body,
            ...(headers === undefined
              ? {}
              : { headers: headersObject(headers) }),
          },
        );
        const value = checked.value;
        let issues = checked.issues;
        if (validation.unknownKeys !== "strip")
          issues = reviewDropped(
            validation.unknownKeys,
            key,
            status,
            issues,
            logger,
            ["response", body, plan.custom && value],
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
      responseHeaders: async (status, headers) => {
        const plan = responsePlanOf(
          validation.statuses.get(status) ?? validation.response,
          hasSource,
        );
        if (plan === undefined || !plan.headers) return;
        const { issues } = await checkResponse(
          await responseRouteOf(key, plan, true),
          status,
          plan,
          { checkBody: false, headers: headersObject(headers) },
        );
        if (issues.length > 0)
          failed(
            validation.onResponse,
            new ValidationError(key, "response", issues, status),
          );
      },
      events: async (status) => {
        const plan = planOf(
          validation.statuses.get(status) ?? validation.response,
          hasSource,
        );
        return plan === undefined
          ? undefined
          : {
              plan,
              route: await routeOf(key, [plan]),
              mode: validation.onResponse as FailureMode | "drop",
            };
      },
    };
  };
}
