/**
 * Request rules compiled (layers.md L7): each rule's condition turned into
 * one test over a request's facts, built once per policy (no closure per
 * request), and the stage each rule runs in: the early stage (before the
 * request is read) for every target the request line and headers give, the
 * route stage for the matched route and the caller (`identify`).
 *
 * The compiled rules are kept beside the compiled policy (a `WeakMap`), so
 * `compilePolicy` needs no change: the policy is validated first
 * (`validateRequestRules`), so compiling cannot fail.
 */
import { toDurationMs } from "@kingsleyweb/bun-common";
import type { Duration } from "@kingsleyweb/bun-common";
import type { RequestFacts } from "../engine/facts";
import type { IntelLookup, IntelRecord } from "../intel/types";
import type { EvaluationStage } from "../engine/stages";
import { cidrContains, parseAddress, parseCidr } from "../ip/address";
import type { ParsedAddress, ParsedCidr } from "../ip/address";
import type { CompiledPolicy } from "../policy/compile";
import { compileGlob } from "./glob";
import { MANAGED_RULES } from "./managed";
import { compileSafeRegex } from "./regex";
import type {
  AsnMatcher,
  ManagedRulesPolicy,
  NumberMatcher,
  RequestRule,
  RequestRulesPolicy,
  RuleCondition,
  StringMatcher,
} from "./types";

/** The default `maxRegexInput`. */
export const DEFAULT_MAX_REGEX_INPUT = 1024;

/** The most of a query string parsed for `queryParam` tests. */
const MAX_QUERY_PARSE = 8192;

/** Targets that need the route stage. */
const ROUTE_TARGETS = new Set([
  "routeKey",
  "user",
  "session",
  "tenant",
  "apiKey",
  "userHash",
  "apiKeyHash",
]);

/** Nothing known of an address. */
const NO_INTEL: IntelRecord = Object.freeze({ classes: Object.freeze([]) });

/** A request as the rules read it: its facts, and what is parsed from them on first need. */
export class RuleInput {
  /** The query, parsed on first need. */
  #query: URLSearchParams | undefined;
  /** The client's address, parsed on first need (`null`: none). */
  #client: ParsedAddress | null | undefined;
  /** What IP intelligence knows of the client, looked up on first need. */
  #intel: IntelRecord | undefined;

  constructor(
    /** The request's facts. */
    readonly facts: RequestFacts,
    /** IP intelligence for the `country`, `asn` and `class` targets; none: they never match. */
    readonly lookup?: IntelLookup,
    /** The request's account subjects as keys (the engine's keyed `user` and `apiKey`), for `userHash` and `apiKeyHash`; none: they never match. */
    readonly keys?: { readonly user?: string; readonly apiKey?: string },
  ) {}

  /** What IP intelligence knows of the client (an empty record without one). */
  get intel(): IntelRecord {
    if (this.#intel === undefined) {
      const client = this.client;
      this.#intel =
        client === null || this.lookup === undefined
          ? NO_INTEL
          : this.lookup.lookup(client);
    }
    return this.#intel;
  }

  /** The query's parameters. */
  get query(): URLSearchParams {
    if (this.#query === undefined) {
      const text = this.facts.query ?? "";
      this.#query = new URLSearchParams(
        text.length > MAX_QUERY_PARSE ? text.slice(0, MAX_QUERY_PARSE) : text,
      );
    }
    return this.#query;
  }

  /** The client's address, parsed. */
  get client(): ParsedAddress | null {
    if (this.#client === undefined)
      this.#client = parseAddress(this.facts.client);
    return this.#client;
  }
}

/** A compiled test. */
type Test = (input: RuleInput) => boolean;

/** A rule as the engine runs it. */
export interface CompiledRequestRule {
  /** Its id. */
  readonly id: string;
  /** The hit's rule id: `rule:<id>`, or `probe:<id>` for the managed set. */
  readonly hitRule: string;
  /** Whether it is the managed probe set's. */
  readonly managed: boolean;
  /**
   * The event a hit counts: `rule.hit`, or `probe.hit` for the managed set.
   * Never `pattern.hit`, which is the identifier checks' (L11.7), so a
   * counted rule on it (ConcaveHR's `disposable_signup`) is not tripped by
   * a request rule (plan §17.19).
   */
  readonly event: "rule.hit" | "probe.hit";
  /** What a hit does. */
  readonly action: "log" | "block" | "challenge" | "ban" | "drop";
  /** The offence weight a hit adds to the address's score. */
  readonly weight: number;
  /** `enforce` or `dryRun` (`off` rules are not compiled). */
  readonly mode: "enforce" | "dryRun";
  /** The refusal's status. */
  readonly status: number;
  /** The refusal's problem code. */
  readonly code: string;
  /** A ban's length in ms; `null` until lifted; `undefined` for the ladder's escalating length. */
  readonly duration: number | null | undefined;
  /** Whether a verified crawler is held to it. */
  readonly crawlers: "apply" | "skip";
  /** The stage it runs in. */
  readonly stage: EvaluationStage;
  /** Its condition. */
  readonly test: Test;
}

/** A policy's request rules, compiled. */
export interface CompiledRequestRules {
  /** Every rule, in order: the policy's own, then the managed set's. */
  readonly rules: readonly CompiledRequestRule[];
  /** The most characters a regex reads. */
  readonly maxRegexInput: number;
}

/** No rules. */
const NONE: CompiledRequestRules = Object.freeze({
  rules: Object.freeze([]),
  maxRegexInput: DEFAULT_MAX_REGEX_INPUT,
});

/** A number comparison. */
function numberTest(matcher: NumberMatcher): (value: number) => boolean {
  if (matcher.equals !== undefined) {
    const n = matcher.equals;
    return (value) => value === n;
  }
  if (matcher.gt !== undefined) {
    const n = matcher.gt;
    return (value) => value > n;
  }
  if (matcher.gte !== undefined) {
    const n = matcher.gte;
    return (value) => value >= n;
  }
  if (matcher.lt !== undefined) {
    const n = matcher.lt;
    return (value) => value < n;
  }
  const n = matcher.lte ?? 0;
  return (value) => value <= n;
}

/** A test on one string value (present). */
function valueTest(
  matcher: StringMatcher,
  ignoreCase: boolean,
  maxRegexInput: number,
): (value: string) => boolean {
  const fold = (text: string) => (ignoreCase ? text.toLowerCase() : text);
  if (matcher.equals !== undefined) {
    const expected = fold(matcher.equals);
    return (value) => fold(value) === expected;
  }
  if (matcher.in !== undefined) {
    const set = new Set(matcher.in.map(fold));
    return (value) => set.has(fold(value));
  }
  if (matcher.prefix !== undefined) {
    const prefix = fold(matcher.prefix);
    return (value) => fold(value).startsWith(prefix);
  }
  if (matcher.suffix !== undefined) {
    const suffix = fold(matcher.suffix);
    return (value) => fold(value).endsWith(suffix);
  }
  if (matcher.contains !== undefined) {
    const part = fold(matcher.contains);
    return (value) => fold(value).includes(part);
  }
  if (matcher.glob !== undefined) {
    const glob = compileGlob(matcher.glob, ignoreCase);
    return (value) => glob(value);
  }
  if (matcher.regex !== undefined) {
    const regex = compileSafeRegex(matcher.regex, ignoreCase);
    return (value) =>
      regex.test(
        value.length > maxRegexInput ? value.slice(0, maxRegexInput) : value,
      );
  }
  if (matcher.length !== undefined) {
    const compare = numberTest(matcher.length);
    return (value) => compare(value.length);
  }
  return () => false;
}

/**
 * A test on a target with zero or more values: `exists` asks whether there
 * is one, `length` reads `lengthOf` when given (a header's length before the
 * facts cut it), any other matcher holds when one value matches.
 */
function stringTest(
  matcher: StringMatcher,
  values: (input: RuleInput) => readonly string[],
  defaultIgnoreCase: boolean,
  maxRegexInput: number,
  lengthOf?: (input: RuleInput) => number | undefined,
): Test {
  if (matcher.exists !== undefined) {
    const exists = matcher.exists;
    return (input) => values(input).length > 0 === exists;
  }
  if (matcher.length !== undefined && lengthOf !== undefined) {
    const compare = numberTest(matcher.length);
    return (input) => {
      const length = lengthOf(input);
      return length !== undefined && compare(length);
    };
  }
  const test = valueTest(
    matcher,
    matcher.ignoreCase ?? defaultIgnoreCase,
    maxRegexInput,
  );
  return (input) => values(input).some(test);
}

/** One value, or none. */
function one(value: string | undefined): readonly string[] {
  return value === undefined || value === "" ? [] : [value];
}

/** Compiles one test (a `RuleMatch`). */
function matchTest(
  match: Record<string, unknown>,
  maxRegexInput: number,
): Test {
  if ("header" in match) {
    const name = (match.header as string).toLowerCase();
    return stringTest(
      match as StringMatcher,
      (input) => one(input.facts.headers[name]),
      false,
      maxRegexInput,
      (input) =>
        input.facts.headerLengths?.[name] ?? input.facts.headers[name]?.length,
    );
  }
  if ("queryParam" in match) {
    const name = match.queryParam as string;
    return stringTest(
      match as StringMatcher,
      (input) => input.query.getAll(name),
      false,
      maxRegexInput,
    );
  }
  if ("cookie" in match) {
    const name = match.cookie as string;
    const exists = match.exists === true;
    return (input) => input.facts.cookieNames.includes(name) === exists;
  }
  if ("client" in match) {
    const spec = (match.client as { cidr: string | readonly string[] }).cidr;
    const ranges = (Array.isArray(spec) ? spec : [spec])
      .map((range: string) => parseCidr(range))
      .filter((range): range is ParsedCidr => range !== null);
    return (input) => {
      const address = input.client;
      return (
        address !== null && ranges.some((range) => cidrContains(range, address))
      );
    };
  }
  if ("asn" in match) {
    const spec = match.asn as AsnMatcher;
    if (spec.exists !== undefined) {
      const exists = spec.exists;
      return (input) => (input.intel.asn !== undefined) === exists;
    }
    const set = new Set(
      spec.in ?? (spec.equals === undefined ? [] : [spec.equals]),
    );
    return (input) => {
      const asn = input.intel.asn;
      return asn !== undefined && set.has(asn);
    };
  }
  if ("contentLength" in match) {
    const compare = numberTest(match.contentLength as NumberMatcher);
    return (input) =>
      input.facts.contentLength !== undefined &&
      compare(input.facts.contentLength);
  }
  if ("headerCount" in match) {
    const compare = numberTest(match.headerCount as NumberMatcher);
    return (input) =>
      compare(
        input.facts.headerCount ?? Object.keys(input.facts.headers).length,
      );
  }
  const [target, matcher] = Object.entries(match).find(
    ([key]) => !key.startsWith("$"),
  ) ?? ["", {}];
  const string = matcher as StringMatcher;
  switch (target) {
    case "method":
      return stringTest(
        string,
        (input) => one(input.facts.method),
        false,
        maxRegexInput,
      );
    case "path":
      return stringTest(
        string,
        (input) => one(input.facts.path),
        true,
        maxRegexInput,
      );
    case "rawPath":
      return stringTest(
        string,
        (input) => one(input.facts.rawPath),
        true,
        maxRegexInput,
      );
    case "query":
      return stringTest(
        string,
        (input) => one(input.facts.query),
        false,
        maxRegexInput,
      );
    case "anyHeader":
      return stringTest(
        string,
        (input) => Object.values(input.facts.headers),
        false,
        maxRegexInput,
      );
    case "country":
      return stringTest(
        string,
        (input) => one(input.intel.country),
        true,
        maxRegexInput,
      );
    case "class":
      return stringTest(
        string,
        (input) => input.intel.classes,
        true,
        maxRegexInput,
      );
    case "routeKey":
      return stringTest(
        string,
        (input) => one(input.facts.routeKey),
        true,
        maxRegexInput,
      );
    case "userHash":
    case "apiKeyHash": {
      const kind = target === "userHash" ? "user" : "apiKey";
      return stringTest(
        string,
        (input) => one(input.keys?.[kind]),
        false,
        maxRegexInput,
      );
    }
    case "user":
    case "session":
    case "tenant":
    case "apiKey": {
      const key = target;
      return stringTest(
        string,
        (input) => one(input.facts.identity?.[key]),
        false,
        maxRegexInput,
      );
    }
    default:
      return () => false;
  }
}

/** Compiles a condition. */
function conditionTest(condition: RuleCondition, maxRegexInput: number): Test {
  const record = condition as Record<string, unknown>;
  if ("all" in record) {
    const tests = (record.all as RuleCondition[]).map((c) =>
      conditionTest(c, maxRegexInput),
    );
    return (input) => tests.every((test) => test(input));
  }
  if ("any" in record) {
    const tests = (record.any as RuleCondition[]).map((c) =>
      conditionTest(c, maxRegexInput),
    );
    return (input) => tests.some((test) => test(input));
  }
  if ("not" in record) {
    const test = conditionTest(record.not as RuleCondition, maxRegexInput);
    return (input) => !test(input);
  }
  return matchTest(record, maxRegexInput);
}

/** Whether a condition reads a route-stage target anywhere. */
function needsRoute(condition: RuleCondition): boolean {
  const record = condition as Record<string, unknown>;
  if ("all" in record) return (record.all as RuleCondition[]).some(needsRoute);
  if ("any" in record) return (record.any as RuleCondition[]).some(needsRoute);
  if ("not" in record) return needsRoute(record.not as RuleCondition);
  return Object.keys(record).some((key) => ROUTE_TARGETS.has(key));
}

/** Compiles one rule; `undefined` when it is `off`. */
function compileRule(
  rule: RequestRule,
  managed: boolean,
  maxRegexInput: number,
  overrides: { mode?: "enforce" | "dryRun"; weight?: number } = {},
): CompiledRequestRule | undefined {
  const mode = overrides.mode ?? rule.mode ?? "enforce";
  if (mode === "off") return undefined;
  const action = rule.action ?? "block";
  return Object.freeze({
    id: rule.id,
    hitRule: managed ? `probe:${rule.id}` : `rule:${rule.id}`,
    managed,
    event: managed ? "probe.hit" : "rule.hit",
    action,
    weight: overrides.weight ?? rule.weight ?? (action === "log" ? 0 : 1),
    mode,
    status: rule.status ?? 403,
    code: rule.code ?? (action === "ban" ? "banned" : "blocked"),
    duration:
      rule.duration === null
        ? null
        : rule.duration === undefined
          ? undefined
          : toDurationMs(
              rule.duration as Duration,
              `requestRules ${rule.id}.duration`,
            ),
    crawlers: managed ? "skip" : (rule.crawlers ?? "apply"),
    stage: needsRoute(rule.when) ? "route" : "early",
    test: conditionTest(rule.when, maxRegexInput),
  });
}

/** Compiles a validated `requestRules` section. */
export function compileRequestRules(
  source: RequestRulesPolicy | undefined,
): CompiledRequestRules {
  // The managed probe set is on, in dry run, unless the policy says
  // otherwise (`managed: false`, or a mode): the user's decision with PR-S12.
  source ??= {};
  const maxRegexInput = source.maxRegexInput ?? DEFAULT_MAX_REGEX_INPUT;
  const rules: CompiledRequestRule[] = [];
  for (const rule of source.rules ?? []) {
    const compiled = compileRule(rule, false, maxRegexInput);
    if (compiled !== undefined) rules.push(compiled);
  }
  const managed = source.managed ?? true;
  if (managed !== false) {
    const settings: ManagedRulesPolicy = managed === true ? {} : managed;
    const exclude = new Set(settings.exclude ?? []);
    for (const [id, rule] of MANAGED_RULES) {
      if (exclude.has(id)) continue;
      const compiled = compileRule(rule, true, maxRegexInput, {
        mode: settings.mode ?? "dryRun",
        weight: settings.weight ?? 1,
      });
      if (compiled !== undefined) rules.push(compiled);
    }
  }
  if (rules.length === 0) return NONE;
  return Object.freeze({ rules: Object.freeze(rules), maxRegexInput });
}

/** Each compiled policy's rules. */
const COMPILED = new WeakMap<CompiledPolicy, CompiledRequestRules>();

/** The request rules of a compiled policy, compiled once. */
export function requestRulesOf(policy: CompiledPolicy): CompiledRequestRules {
  let rules = COMPILED.get(policy);
  if (rules === undefined) {
    rules = compileRequestRules(
      (policy.source as { requestRules?: RequestRulesPolicy }).requestRules,
    );
    COMPILED.set(policy, rules);
  }
  return rules;
}

/**
 * The rules that hold for a request in `stage` (every stage when
 * undefined), in order.
 */
export function matchRequestRules(
  compiled: CompiledRequestRules,
  facts: RequestFacts,
  stage: EvaluationStage | undefined,
  intel?: IntelLookup,
  keys?: { readonly user?: string; readonly apiKey?: string },
): CompiledRequestRule[] {
  const matched: CompiledRequestRule[] = [];
  let input: RuleInput | undefined;
  for (const rule of compiled.rules) {
    if (stage !== undefined && rule.stage !== stage) continue;
    input ??= new RuleInput(facts, intel, keys);
    if (rule.test(input)) matched.push(rule);
  }
  return matched;
}
