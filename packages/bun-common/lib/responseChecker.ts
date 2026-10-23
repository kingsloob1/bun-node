/**
 * A response checker for a `ResponseSchemas` declaration, driven **outside
 * the router** (plan `docs/plans/bun-validate/` §4.4, and V7b: Nest's
 * `@Validate` responses): the same engine as the commit gate in
 * `BunResponse` (V3a–V3c — statuses, headers, cookies, media types with
 * wildcards, `variants()` with `when`/discriminant/`refine` and the adjust,
 * `chunks()`/`sse()` streams, the value scrub), fed with a plain view of the
 * response instead of a `BunResponse`.
 *
 * ```ts
 * const checker = createResponseChecker(
 *   { 200: { content: { "application/json": User } }, 404: Problem },
 *   { mode: "error" },
 * );
 * const verdict = checker.check({
 *   req, status: 200, headers: res.getHeaders(),
 *   kind: "json", body: value,
 * });
 * // undefined: send it; ResponseValidationError: refuse; a stream check for
 * // chunks()/sse(); a replacement when a variant adjusted the response.
 * ```
 *
 * A checker is built once per declaration and reused across requests, as
 * `validate()`'s gate is (the declaration's schemas are compiled once).
 */
import type { BunRequest } from "./BunRequest";
import type {
  ResponseCommit,
  ResponseReplacement,
  ResponseStreamCheck,
} from "./BunResponse";
import type { IssueFormat } from "./contract/issues";
import type { Logger, LoggerLike } from "./logging";
import type {
  ResponseOutputMode,
  ResponseSchemas,
  ResponseValidationError,
  ResponseValidationMode,
} from "./responseValidation";
import { ResponseContractGate, toOutboundDef } from "./responseValidation";
import { noopLogger, resolveLogger } from "./logging";

/** The options of {@link createResponseChecker}. */
export interface ResponseCheckerOptions {
  /**
   * The policy: `"warn"` logs each mismatch once and passes the response,
   * `"error"` refuses a mismatch with a `ResponseValidationError` (and holds
   * the check while an async vendor settles), `"off"` checks nothing but
   * still applies a named variant's adjust. Default `"off"`, as
   * `responseValidation`'s.
   */
  mode?: ResponseValidationMode;
  /** Where a `"warn"` mismatch and a failed check are logged. `noopLogger` by default. */
  logger?: LoggerLike;
  /**
   * What a passing buffered JSON body is sent as (V13): `"parsed"` sends the
   * schema's output (unknown keys the vendor strips, defaults and
   * transforms applied — the check comes back as a replacement);
   * `"as-sent"` (the default) leaves it as given.
   */
  output?: ResponseOutputMode;
  /**
   * `"generic"` replaces every issue's message with `Invalid value` (plus
   * the vendor's issue code), instead of the default scrub, which withholds
   * only a message found to quote a received value. Default unset: the
   * scrub. Same name and meaning as on `validate()`.
   */
  messages?: IssueFormat["messages"];
  /**
   * Empties every issue's `path` (`""`), for schemas keyed by data the
   * client chose. Default `false`. Same name and meaning as on
   * `validate()`.
   */
  redactPaths?: IssueFormat["redactPaths"];
}

/** A response for {@link ResponseChecker.check}, with the request it answers. */
export interface ResponseCheckView {
  /**
   * The request the response answers. Its method, route and conditional
   * headers are read (a freshness 304 is exempt without being declared), and
   * it is handed to a variant's `when` and a `refine` as they expect.
   */
  readonly req: BunRequest;
  /** The final status. */
  readonly status: number;
  /** The final headers, as a native `Headers`; any `Set-Cookie`s are read from it. */
  readonly headers: Headers;
  /**
   * What produced the body: `"json"` (a value, checked as JSON),
   * `"text"`, `"bytes"`, `"blob"`, `"native"` (a passed-through body, read
   * only under a whole-body schema — `opaque()` declares it unread),
   * `"redirect"` (status and `location` checked, the generated body exempt),
   * `"status"` (a generated status body, exempt), `"stream"` (a hand-written
   * stream: never buffered — a whole-body schema is skipped with one
   * warning, as Q-H4 says; a `chunks()`/`sse()` declaration hands back the
   * per-chunk check), or `"empty"`.
   */
  readonly kind:
    | "json"
    | "text"
    | "bytes"
    | "blob"
    | "native"
    | "redirect"
    | "status"
    | "stream"
    | "empty";
  /**
   * The body: the value for `"json"`, the string for `"text"`, the bytes for
   * `"bytes"`, the `Blob` for `"blob"`, and the body's stream or bytes for
   * `"native"` (read only under a whole-body schema).
   */
  readonly body?: unknown;
  /**
   * The `Content-Type` in force; read from the headers when unset, and
   * `"application/json"` for a `"json"` body without one.
   */
  readonly contentType?: string;
  /** The variant named (`res.variant()`, or a `reply()`'s `variant`); `undefined` for none. */
  readonly variant?: string;
  /** Whether the handler set the status, so `.variant()` never fills it. Default `true`. */
  readonly statusSet?: boolean;
  /** Whether the body's `Content-Type` is only the implicit JSON one, which `.variant()` may replace. Default `kind === "json"`. */
  readonly typeImplicit?: boolean;
  /** An error handler's response: only reported, never refused (plan Q-H2). Default `false`. */
  readonly reportOnly?: boolean;
}

/** What {@link ResponseChecker.check} answers. */
export type ResponseCheckVerdict =
  | ResponseValidationError
  | ResponseStreamCheck
  | ResponseReplacement
  | undefined;

/**
 * A response checker for one declaration, reused across requests.
 *
 * The per-chunk check it hands back for a `chunks()`/`sse()` body is fed
 * each chunk as written (for SSE, each event serialised to the wire format);
 * an `Error` return cuts the stream off, already logged.
 */
export interface ResponseChecker {
  /**
   * Checks one response. Answers `undefined` to send it, a
   * `ResponseValidationError` to refuse it, the per-chunk check of a
   * `chunks()`/`sse()` stream to send it and check each chunk, an adjusted
   * response to send in its place (a named variant), or a Promise of one of
   * these to hold until it settles — only under `"error"` (and `"warn"` for
   * a named variant whose `when` answers a Promise).
   */
  check: (
    view: ResponseCheckView,
    /** Per call: parse nothing (a before-write hook can pass or refuse, never replace, so it checks as-sent). */
    options?: { output?: ResponseOutputMode },
  ) => ResponseCheckVerdict | Promise<ResponseCheckVerdict>;
}

/**
 * Builds a response checker for a `ResponseSchemas` declaration — the same
 * table `validate()`'s `responses` takes — for use outside the router (a
 * Nest interceptor, the before-write hook, any transport that can map its
 * response onto {@link ResponseCheckView}). A bad declaration throws a
 * `TypeError` here, at construction, as it does for `validate()`.
 *
 * @param responses The declaration.
 * @param options   The policy, the logger, and the issue wording.
 */
export function createResponseChecker(
  responses: ResponseSchemas,
  options?: ResponseCheckerOptions,
): ResponseChecker {
  const mode = options?.mode ?? "off";
  const logger: Logger = resolveLogger(options?.logger, noopLogger);
  const format: IssueFormat | undefined =
    options?.messages === undefined && options?.redactPaths === undefined
      ? undefined
      : {
          ...(options?.messages === undefined
            ? {}
            : { messages: options.messages }),
          ...(options?.redactPaths === undefined
            ? {}
            : { redactPaths: options.redactPaths }),
        };
  const build = (output: ResponseOutputMode): ResponseContractGate =>
    new ResponseContractGate(
      toOutboundDef(responses, "createResponseChecker()"),
      mode,
      () => logger,
      format,
      output,
    );
  /** The gate per output mode (the factory's, and an as-sent one on first override). */
  const gates = new Map<ResponseOutputMode, ResponseContractGate>();
  const gateFor = (output: ResponseOutputMode): ResponseContractGate => {
    let gate = gates.get(output);
    if (gate === undefined) {
      gate = build(output);
      gates.set(output, gate);
    }
    return gate;
  };
  return {
    check(
      view: ResponseCheckView,
      checkOptions?: { output?: ResponseOutputMode },
    ) {
      const contentType =
        view.contentType ??
        view.headers.get("content-type") ??
        (view.kind === "json" ? "application/json" : undefined);
      const response = new Response(
        view.kind === "native"
          ? ((view.body ?? null) as ConstructorParameters<typeof Response>[0])
          : null,
        { status: view.status, headers: view.headers },
      );
      const commit: ResponseCommit = {
        kind: view.kind,
        body: view.body,
        contentType,
        reportOnly: view.reportOnly ?? false,
        variant: view.variant,
        statusSet: view.statusSet ?? true,
        typeImplicit: view.typeImplicit ?? view.kind === "json",
      };
      return gateFor(
        checkOptions?.output ?? options?.output ?? "as-sent",
      ).commit({ req: view.req }, response, commit);
    },
  };
}
