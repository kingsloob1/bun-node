/**
 * The one runner (`validateStandard`) and the one issue shape.
 *
 * Every issue the core produces keeps the rule of plan §4.1.6: it never
 * carries the received value. Vendors quote it in their messages (valibot
 * always, arktype, yup, zod for an unknown key), so a message found to quote
 * a received value is replaced by a generic one; only the path's keys are
 * copied, never a segment's value. The scrub runs only on failure.
 *
 * A message is compared with what its issue is about: the value at the
 * issue's path (its leaves, and its keys when it is an object), the keys of
 * the object holding it, and the path's own keys. Not the rest of the value,
 * so a schema's own words (`Expected one of "waiting", "active"`) survive
 * another field holding `"waiting"`. A root issue, or a path the value does
 * not lead along, is compared with the whole value; so is every issue under
 * the `"whole"` {@link ScrubScope}. That fallback also compares the value's
 * keys of three or more characters unquoted, as whole words (yup's
 * `unspecified keys: …`).
 */
import type { StandardSchemaV1 } from "../types/standardSchema";
import type {
  GuardOptions,
  MaybePromise,
  Schema,
  StandardOutcome,
  ValidationIssue,
} from "./model";

/** The issue-wording options a runner honours. */
export type IssueFormat = Pick<GuardOptions, "messages" | "redactPaths">;

/**
 * What of the received value an issue's message is compared with.
 * `"path"` (a schema's issues): the value at the issue's path, the keys of
 * the object holding it and the path's keys; the whole value for a root
 * issue, its keys of three or more characters unquoted too. `"whole"` (a
 * response `refine`'s, which sees every part): the whole received value,
 * wherever the issue points.
 */
export type ScrubScope = "path" | "whole";

/** At most this many received leaves are compared with a message. */
const MAX_LEAVES = 256;
/** And none deeper than this. */
const MAX_DEPTH = 8;
/** A vendor code safe to quote: a short identifier, never data. */
const SAFE_CODE = /^[\w.:-]{1,64}$/;

/**
 * Applies `f` to a value or a promise of one, staying synchronous when the
 * input is. Not named `then`: a module exporting `then` is a thenable, and
 * `await import()` of it would call that function.
 */
export function andThen<A, B>(
  value: MaybePromise<A>,
  f: (resolved: A) => MaybePromise<B>,
): MaybePromise<B> {
  return value instanceof Promise ? value.then(f) : f(value);
}

/** The vendor's issue code (zod, arktype) or type (valibot), when it is a safe identifier. */
function issueCode(issue: StandardSchemaV1.Issue): string | undefined {
  const { code, type } = issue as { code?: unknown; type?: unknown };
  const found = typeof code === "string" ? code : type;
  return typeof found === "string" && SAFE_CODE.test(found) ? found : undefined;
}

/** The generic message that replaces a vendor's. */
function genericMessage(issue: StandardSchemaV1.Issue): string {
  const code = issueCode(issue);
  return code === undefined ? "Invalid value" : `Invalid value (${code})`;
}

/** Escapes `text` for use inside a regular expression. */
const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a short token (a one- or two-character string or number, a
 * boolean) is quoted as a received value: after a word vendors use for it (`received 7`,
 * `(was true)`, `` value was: `7` ``), or in quotes.
 */
function quotesShort(message: string, token: string): boolean {
  const t = escape(token);
  return new RegExp(
    `(?:received|was|value|got|given)[^A-Za-z0-9]{0,4}${t}(?![\\w.])|["'\`]${t}["'\`]`,
    "i",
  ).test(message);
}

/** Records the tokens of one leaf that a message must not contain. */
interface Forbidden {
  /** Substrings that must not appear (long strings and numbers, quoted forms). */
  plain: string[];
  /** Short tokens matched only in a quoting context ({@link quotesShort}). */
  short: string[];
  /**
   * Keys of three or more characters, matched unquoted as whole words
   * ({@link namesKey}); filled only when the whole value is compared.
   * Capped at `MAX_LEAVES` on their own, so they never crowd out a leaf.
   */
  keys: string[];
}

/**
 * Whether `message` names `key` as a whole word: not inside a longer word,
 * so `state` is not found in `statement`.
 */
function namesKey(message: string, key: string): boolean {
  return new RegExp(`(?<!\\w)${escape(key)}(?!\\w)`).test(message);
}

/**
 * Adds `value`'s leaves (and quoted keys) to `out`, and with `bareKeys` its
 * keys of three or more characters unquoted; bounded, run only on failure.
 */
function collect(
  value: unknown,
  out: Forbidden,
  depth: number,
  bareKeys = false,
): void {
  if (out.plain.length + out.short.length >= MAX_LEAVES) return;
  switch (typeof value) {
    case "string":
      if (value.length >= 3) out.plain.push(value);
      else if (value.length > 0) {
        out.plain.push(JSON.stringify(value));
        out.short.push(value);
      }
      return;
    case "number":
    case "bigint": {
      const text = String(value);
      if (text.length >= 3) out.plain.push(text);
      else out.short.push(text);
      return;
    }
    case "boolean":
      out.short.push(String(value));
      return;
    case "object": {
      if (value === null || depth >= MAX_DEPTH) return;
      if (value instanceof Date) {
        if (!Number.isNaN(value.getTime())) out.plain.push(value.toISOString());
        return;
      }
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
      const isArray = Array.isArray(value);
      for (const k of Object.keys(value)) {
        if (!isArray) {
          out.plain.push(JSON.stringify(k));
          if (bareKeys && k.length >= 3 && out.keys.length < MAX_LEAVES) {
            out.keys.push(k);
          }
        }
        collect(
          (value as Record<string, unknown>)[k],
          out,
          depth + 1,
          bareKeys,
        );
        if (out.plain.length + out.short.length >= MAX_LEAVES) return;
      }
    }
  }
}

/** The segment's key, whether the vendor gives a bare key or a `{ key }` object. */
function segmentKey(
  segment: PropertyKey | StandardSchemaV1.PathSegment,
): PropertyKey {
  return typeof segment === "object" && segment !== null && "key" in segment
    ? segment.key
    : segment;
}

/** Where an issue's path leads in the received value. */
interface AtPath {
  /** The value at the path; `undefined` when its last key is absent. */
  value: unknown;
  /** The object or array holding {@link AtPath.value}; `undefined` for the root. */
  holder: object | undefined;
}

/**
 * Walks `path` through `received`, or `undefined` when the path does not
 * lead along it (a segment past a value that is not an object).
 */
function atPath(
  received: unknown,
  path: StandardSchemaV1.Issue["path"],
): AtPath | undefined {
  let value = received;
  let holder: object | undefined;
  for (const segment of path ?? []) {
    if (typeof value !== "object" || value === null) return undefined;
    holder = value;
    value = (value as Record<PropertyKey, unknown>)[segmentKey(segment)];
  }
  return { value, holder };
}

/** Adds an object's own keys, quoted, to `out` (an array's indices are not); bounded. */
function collectKeys(holder: object, out: Forbidden): void {
  if (Array.isArray(holder)) return;
  for (const k of Object.keys(holder)) {
    if (out.plain.length + out.short.length >= MAX_LEAVES) return;
    out.plain.push(JSON.stringify(k));
  }
}

/**
 * Whether `issue`'s message quotes anything received, each bounded. Under
 * `"path"`: the value at the issue's path (its leaves, and its keys when it
 * is an object), the keys of the object holding it, and the path's own keys
 * (quoted); the whole value for a root issue or a path that does not lead
 * along it, with its keys of three or more characters also unquoted
 * ({@link namesKey}). Under `"whole"`: the value at the path first, so it is
 * inside the bound, then the whole value.
 */
function quotesReceived(
  issue: StandardSchemaV1.Issue,
  received: unknown,
  scope: ScrubScope,
): boolean {
  const message = issue.message;
  const tokens: Forbidden = { plain: [], short: [], keys: [] };
  const at = atPath(received, issue.path);
  if (at === undefined || at.holder === undefined) {
    // The whole value: a root issue, or a path that does not lead along it.
    collect(received, tokens, 0, true);
  } else {
    collect(at.value, tokens, 0);
    collectKeys(at.holder, tokens);
    if (scope === "whole") collect(received, tokens, 0);
  }
  for (const segment of issue.path ?? []) {
    const key = segmentKey(segment);
    if (typeof key === "string") tokens.plain.push(JSON.stringify(key));
  }
  for (const token of tokens.plain) {
    if (message.includes(token)) return true;
  }
  for (const token of tokens.short) {
    if (quotesShort(message, token)) return true;
  }
  for (const key of tokens.keys) {
    if (namesKey(message, key)) return true;
  }
  return false;
}

/** The issue's message with any received value withheld, per `format`. */
function scrubbedMessage(
  issue: StandardSchemaV1.Issue,
  received: unknown,
  format: IssueFormat | undefined,
  scope: ScrubScope,
): string {
  if (format?.messages === "generic") return genericMessage(issue);
  const message = typeof issue.message === "string" ? issue.message : "";
  if (message.length === 0) return genericMessage(issue);
  return quotesReceived(issue, received, scope)
    ? genericMessage(issue)
    : message;
}

/** Renders a Standard Schema issue path as a dotted string of its keys. */
export function formatPath(issue: StandardSchemaV1.Issue): string {
  if (!issue.path || issue.path.length === 0) return "";
  return issue.path.map((segment) => String(segmentKey(segment))).join(".");
}

/**
 * Flattens a vendor's issues into {@link ValidationIssue}s for one part.
 * Run only on failure.
 *
 * @param issues    The vendor's issues.
 * @param received  The value they are about, which their messages must not quote.
 * @param target    The part's name, reported on every issue.
 * @param key       The declared key, reported on every issue.
 * @param mediaType The declared media type, reported on every issue.
 * @param format    How issues are worded: `messages: "generic"` and `redactPaths`.
 * @param scope     What of `received` a message is compared with (a {@link ScrubScope}).
 *   Default `"path"`; a response `refine` passes `"whole"`.
 */
export function toIssues<TTarget extends string>(
  issues: readonly StandardSchemaV1.Issue[],
  received: unknown,
  target: TTarget,
  key: string | undefined,
  mediaType: string | undefined,
  format: IssueFormat | undefined,
  scope: ScrubScope = "path",
): ValidationIssue<TTarget>[] {
  return issues.map((issue) => {
    const out: ValidationIssue<TTarget> = {
      target,
      message: scrubbedMessage(issue, received, format, scope),
      path: format?.redactPaths === true ? "" : formatPath(issue),
    };
    if (key !== undefined) out.key = key;
    if (mediaType !== undefined) out.mediaType = mediaType;
    return out;
  });
}

/**
 * Runs `schema` on `value`, with the key given raw (a status may be the
 * number `200`), converting it to a string only if there are issues. The
 * guards' entry point; {@link validateStandard} is the public one.
 */
export function runSchema<T, TTarget extends string>(
  schema: Schema,
  value: unknown,
  target: TTarget,
  key: string | number | undefined,
  mediaType: string | undefined,
  format: IssueFormat | undefined,
): MaybePromise<StandardOutcome<T, TTarget>> {
  const settle = (
    result: StandardSchemaV1.Result<unknown>,
  ): StandardOutcome<T, TTarget> =>
    result.issues
      ? {
          ok: false,
          issues: toIssues(
            result.issues,
            value,
            target,
            key === undefined ? undefined : String(key),
            mediaType,
            format,
          ),
        }
      : { ok: true, value: result.value as T };
  const result = schema["~standard"].validate(value);
  return result instanceof Promise ? result.then(settle) : settle(result);
}

/**
 * The one runner (plan V-D2): validates `value` with `schema` and flattens
 * any issues under `target`, with no received value in them.
 *
 * Synchronous when the vendor is (zod, valibot, arktype, a hand-rolled sync
 * schema); a Promise only when the vendor returns one (yup, an async schema).
 *
 * @param schema    Any Standard Schema.
 * @param value     What arrived.
 * @param target    The part's name, reported on every issue (`"body"`, `"payload"`).
 * @param key       The declared key, reported on every issue (a status, a message type).
 * @param mediaType The declared media type, reported on every issue.
 * @param options   How issues are worded: `messages: "generic"` and `redactPaths`.
 */
export function validateStandard<S extends Schema, TTarget extends string>(
  schema: S,
  value: unknown,
  target: TTarget,
  key?: string,
  mediaType?: string,
  options?: IssueFormat,
): MaybePromise<StandardOutcome<StandardSchemaV1.InferOutput<S>, TTarget>> {
  return runSchema(schema, value, target, key, mediaType, options);
}
