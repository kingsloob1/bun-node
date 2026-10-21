/**
 * Guards: one compiled check per contract side, under one policy.
 *
 * A **receiver** parses, handing on each part's output; a **sender** checks
 * and hands back the very message it was given (plan §4.1.3). A guard
 * returns a {@link ContractError} rather than throwing, and is compiled once
 * with a plan per key, which keeps a side or key with no schema free: the
 * same message back, synchronously, with nothing allocated.
 */
import type { Logger } from "../logging";
import type { IssueFormat } from "./issues";
import type { MediaMatcher } from "./media";
import type {
  AnyContract,
  GuardOptions,
  IssueContext,
  MaybePromise,
  MediaMap,
  PartDecl,
  Policy,
  Received,
  Schema,
  Sent,
  Side,
  StandardOutcome,
  ValidationIssue,
} from "./model";
import { resolveLogger } from "../logging";
import { runSchema } from "./issues";
import { compileMediaMap } from "./media";
import { isDocumented } from "./schemas";
import { isSchema } from "./transport";

/** Raised (or returned by a guard) when a message fails its contract under `"error"`. */
export class ContractError extends Error {
  /** Every issue, value-free. */
  readonly issues: readonly ValidationIssue[];
  /** Where the issues were found. */
  readonly context: IssueContext;

  /**
   * @param issues  The issues found; their messages and paths go into the
   *   error's message, which therefore holds no received value either.
   * @param context Where they were found.
   */
  constructor(issues: readonly ValidationIssue[], context: IssueContext) {
    const where = `${context.transport} ${context.side}${context.key === undefined ? "" : ` ${context.key}`}`;
    const summary = issues
      .map((i) => `${i.target}${i.path ? `.${i.path}` : ""}: ${i.message}`)
      .join("; ");
    super(`${where} failed its contract: ${summary}`);
    this.name = "ContractError";
    this.issues = issues;
    this.context = context;
  }
}

/**
 * A compiled check of one side. A receiver's resolves to the parsed message
 * (each part's output); a sender's to the very message it was given, since
 * the sender's value is what goes on the wire. Either resolves to a
 * {@link ContractError} on a mismatch under `"error"`; it never throws one.
 */
export interface Guard<In, Out> {
  /** Checks `message`; synchronous when every schema it runs is. */
  (message: In): MaybePromise<Out | ContractError>;
  /**
   * `false` when the side has nothing to check (no schema, or `"off"`): the
   * guard is then the identity, and an adapter may skip the call.
   */
  readonly checks: boolean;
  /**
   * Whether a message with this key would be checked at all, so a router or
   * topic table can decide once per key, beside its handler, and skip the
   * guard where it is `false` (plan Q-C6). `true` for an undeclared key under
   * `undeclaredKey: "report"`; on an unkeyed side it is {@link checks}.
   */
  readonly checksKey: (key: string | number) => boolean;
}

/** The parts a message shape checks, in the order the contract declares them. */
type Plan = readonly (readonly [part: string, decl: PartDecl])[];

/** Whether a part declaration does nothing at runtime: `documented()`, or a media map of only those. */
function documentsOnly(decl: PartDecl): boolean {
  if (decl === null) return false;
  if (isSchema(decl)) return isDocumented(decl);
  const members = Object.values(decl);
  return members.length > 0 && members.every(isDocumented);
}

/** The parts of one message shape worth checking. */
function toPlan(parts: object): Plan {
  return Object.entries(parts).filter(
    ([, decl]) => decl !== undefined && !documentsOnly(decl as PartDecl),
  ) as [string, PartDecl][];
}

/** A key in canonical integer form (`"200"`), which a message may also give as a number. */
const INTEGER_KEY = /^(?:0|[1-9]\d*)$/;

/** The guard of a side with nothing to check: returns its argument, allocates nothing. */
const identity: Guard<unknown, unknown> = Object.assign(
  (message: unknown): unknown => message,
  { checks: false, checksKey: (_key: string | number): boolean => false },
);

/** Each media map's compiled matcher, built on its first message. */
const MATCHERS = new WeakMap<MediaMap, MediaMatcher<Schema | null>>();

/**
 * The declared entry a media type falls under (`lib/contract/media.ts`):
 * parameters stripped on both sides, case ignored, the most specific key
 * winning (exact, then `type/*`, then `*\/*`).
 */
function mediaEntry(
  map: MediaMap,
  mediaType: string,
): [declared: string, schema: Schema | null] | undefined {
  let matcher = MATCHERS.get(map);
  if (matcher === undefined) {
    matcher = compileMediaMap<Schema | null>(map, "contract media map");
    MATCHERS.set(map, matcher);
  }
  const found = matcher.match(mediaType);
  return found === undefined ? undefined : [found[0].declared, found[1]];
}

/** The declared keys, for an undeclared-key message: never the key received. */
function declaredList(keys: readonly string[]): string {
  const shown = keys.slice(0, 10).join(", ");
  return keys.length > 10 ? `${shown}, …` : shown;
}

/** Checks one part of a message. */
function checkPart(
  part: string,
  decl: PartDecl,
  value: unknown,
  key: string | number | undefined,
  format: IssueFormat,
): MaybePromise<StandardOutcome<unknown>> {
  if (decl === null) {
    if (value === undefined) return { ok: true, value };
    const issue: ValidationIssue = {
      target: part,
      message: `No ${part} is declared here`,
      path: "",
    };
    if (key !== undefined) issue.key = String(key);
    return { ok: false, issues: [issue] };
  }
  if (isSchema(decl)) {
    return runSchema(decl, value, part, key, undefined, format);
  }
  const media = value as { mediaType?: unknown; value?: unknown } | undefined;
  const found =
    typeof media?.mediaType === "string"
      ? mediaEntry(decl, media.mediaType)
      : undefined;
  if (found === undefined) {
    const issue: ValidationIssue = {
      target: part,
      message: `This media type is not declared (${Object.keys(decl).join(", ")})`,
      path: "",
    };
    if (key !== undefined) issue.key = String(key);
    return { ok: false, issues: [issue] };
  }
  const [declared, schema] = found;
  if (schema === null) {
    // This media type is declared with no body.
    if (media!.value === undefined) return { ok: true, value };
    const issue: ValidationIssue = {
      target: part,
      message: `No ${part} is declared for this media type`,
      path: "",
      mediaType: declared,
    };
    if (key !== undefined) issue.key = String(key);
    return { ok: false, issues: [issue] };
  }
  const outcome = runSchema(schema, media!.value, part, key, declared, format);
  const wrap = (o: StandardOutcome<unknown>): StandardOutcome<unknown> =>
    o.ok
      ? { ok: true, value: { mediaType: media!.mediaType, value: o.value } }
      : o;
  return outcome instanceof Promise ? outcome.then(wrap) : wrap(outcome);
}

/** Compiles one side of `contract` into a guard. */
function compile(
  contract: AnyContract,
  side: Side,
  options: GuardOptions,
  parse: boolean,
): Guard<unknown, unknown> {
  const policy: Policy = options.policy ?? "error";
  const undeclaredKey = options.undeclaredKey ?? "report";
  const { onIssues } = options;
  const format: IssueFormat = {
    ...(options.messages === undefined ? {} : { messages: options.messages }),
    ...(options.redactPaths === undefined
      ? {}
      : { redactPaths: options.redactPaths }),
  };
  const spec = contract.transport[side];
  const def = (contract.def as Partial<Record<Side, Record<string, object>>>)[
    side
  ];
  const keyName = spec?.key;
  const single: Plan =
    def === undefined || keyName !== undefined ? [] : toPlan(def);

  // "off", no side declared, or an unkeyed side without schemas: nothing to do per message.
  if (
    policy === "off" ||
    spec === undefined ||
    def === undefined ||
    (keyName === undefined && single.length === 0)
  ) {
    return identity;
  }

  const plans = new Map<string | number, Plan>();
  const declaredKeys: string[] = [];
  if (keyName !== undefined) {
    for (const [k, parts] of Object.entries(def)) {
      const plan = toPlan(parts);
      plans.set(k, plan);
      if (INTEGER_KEY.test(k)) plans.set(Number(k), plan);
      declaredKeys.push(k);
    }
    // A keyed side whose every key is schema-free and whose undeclared keys
    // pass: nothing to do per message either.
    if (
      undeclaredKey === "allow" &&
      [...plans.values()].every((p) => p.length === 0)
    ) {
      return identity;
    }
  }

  const transport = contract.transport.name;
  let logger: Logger | undefined;
  const log = (): Logger => (logger ??= resolveLogger(options.logger));

  const fail = (
    message: unknown,
    issues: ValidationIssue[],
    key: string | undefined,
  ): unknown => {
    const context: IssueContext =
      key === undefined
        ? { transport, side, policy }
        : { transport, side, key, policy };
    if (onIssues !== undefined) {
      try {
        onIssues(issues, context);
      } catch (error) {
        log().error("contract onIssues hook failed", {
          transport,
          side,
          error,
        });
      }
    }
    if (policy === "error") return new ContractError(issues, context);
    log().warn("contract mismatch", {
      transport,
      side,
      ...(key === undefined ? {} : { key }),
      issues: issues.map((i) => ({
        target: i.target,
        path: i.path,
        message: i.message,
        ...(i.key === undefined ? {} : { key: i.key }),
        ...(i.mediaType === undefined ? {} : { mediaType: i.mediaType }),
      })),
    });
    return message;
  };

  const finish = (
    message: unknown,
    plan: Plan,
    settled: readonly StandardOutcome<unknown>[],
    key: string | undefined,
  ): unknown => {
    let issues: ValidationIssue[] | undefined;
    for (const outcome of settled) {
      if (!outcome.ok) (issues ??= []).push(...outcome.issues);
    }
    if (issues !== undefined) return fail(message, issues, key);
    if (!parse) return message;
    const out: Record<string, unknown> =
      typeof message === "object" && message !== null
        ? { ...(message as Record<string, unknown>) }
        : {};
    for (let i = 0; i < plan.length; i++) {
      out[plan[i][0]] = (settled[i] as { value: unknown }).value;
    }
    return out;
  };

  const guard = (message: unknown): MaybePromise<unknown> => {
    const msg =
      typeof message === "object" && message !== null
        ? (message as Record<string, unknown>)
        : undefined;
    let plan = single;
    let rawKey: string | number | undefined;
    if (keyName !== undefined) {
      const given = msg?.[keyName];
      const found =
        typeof given === "string" || typeof given === "number"
          ? plans.get(given)
          : undefined;
      if (found === undefined) {
        if (undeclaredKey === "allow") return message;
        return fail(
          message,
          [
            {
              target: keyName,
              message: `This ${keyName} is not declared (${declaredList(declaredKeys)})`,
              path: "",
            },
          ],
          undefined,
        );
      }
      // A key with no schema: the same message back, nothing allocated.
      if (found.length === 0) return message;
      plan = found;
      rawKey = given as string | number;
    }
    const results: MaybePromise<StandardOutcome<unknown>>[] = Array.from({
      length: plan.length,
    });
    let pending = false;
    for (let i = 0; i < plan.length; i++) {
      const [part, decl] = plan[i];
      const result = checkPart(part, decl, msg?.[part], rawKey, format);
      results[i] = result;
      pending ||= result instanceof Promise;
    }
    const key = rawKey === undefined ? undefined : String(rawKey);
    return pending
      ? Promise.all(results).then((settled) =>
          finish(message, plan, settled, key),
        )
      : finish(message, plan, results as StandardOutcome<unknown>[], key);
  };

  const checksKey =
    keyName === undefined
      ? (_key: string | number): boolean => true
      : (key: string | number): boolean => {
          const plan = plans.get(key);
          return plan === undefined
            ? undeclaredKey === "report"
            : plan.length > 0;
        };
  return Object.assign(guard, { checks: true, checksKey });
}

/**
 * Compiles a receiver for one side of `contract`: it **parses**, so what it
 * hands on carries each part's output (a `z.coerce.date()` arrives as a
 * `Date`).
 *
 * Under `"error"` (the default) a mismatch is a {@link ContractError}. Under
 * `"warn"` it is logged and the raw message handed on, and under `"off"`
 * nothing is checked, so with either (or a policy only known to be a
 * {@link Policy}) the receiver is typed to hand on `unknown` (plan Q-C1).
 *
 * @param contract The contract.
 * @param side     The side its owner receives (`"inbound"` on a server).
 * @param options  Policy, logger, `onIssues`, undeclared keys, issue wording.
 */
export function createReceiver<C extends AnyContract, Sd extends Side>(
  contract: C,
  side: Sd,
  options?: GuardOptions & {
    /** `"error"`, or left out: the receiver's output is typed as parsed. */
    policy?: "error";
  },
): Guard<unknown, Received<C, Sd>>;
export function createReceiver<C extends AnyContract, Sd extends Side>(
  contract: C,
  side: Sd,
  options: GuardOptions,
): Guard<unknown, unknown>;
export function createReceiver(
  contract: AnyContract,
  side: Side,
  options?: GuardOptions,
): Guard<unknown, unknown> {
  return compile(contract, side, options ?? {}, true);
}

/**
 * Compiles a sender for one side of `contract`: it **checks**, and resolves
 * to the very message it was given, which is what goes on the wire. Its
 * input is typed by {@link Sent}: each field's input, or its output where
 * the input is `unknown`. Takes all three policies.
 *
 * @param contract The contract.
 * @param side     The side its owner sends (`"outbound"` on a server).
 * @param options  Policy, logger, `onIssues`, undeclared keys, issue wording.
 */
export function createSender<C extends AnyContract, Sd extends Side>(
  contract: C,
  side: Sd,
  options?: GuardOptions,
): Guard<Sent<C, Sd>, Sent<C, Sd>> {
  return compile(contract, side, options ?? {}, false) as Guard<
    Sent<C, Sd>,
    Sent<C, Sd>
  >;
}
