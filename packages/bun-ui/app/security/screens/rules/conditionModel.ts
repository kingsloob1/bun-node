/**
 * A request rule's condition as the matcher builder edits it (layers.md
 * L7): a tree of `all`, `any` and `not` over tests, each test one target
 * and one comparison, and back to the policy's JSON. A condition the
 * builder cannot show (a shape it does not know) is kept as JSON, edited
 * as text, and written back as it is. A `regex` is checked as it is typed
 * with the control plane's own check (`regexRefusal`, from the contract).
 */
import { regexRefusal } from "@kingsleyweb/bun-security/control/contract";

/** A target and what kind of comparison it takes. */
export interface TargetSpec {
  /** Its name in the policy. */
  readonly id: string;
  /** How it is labelled. */
  readonly label: string;
  /**
   * `string` (the string comparisons), `named` (a string comparison of a
   * named header or query parameter), `cookie` (whether a named cookie is
   * sent), `number`, `cidr` (the client address in ranges), `asn`.
   */
  readonly kind: "string" | "named" | "cookie" | "number" | "cidr" | "asn";
  /** Read only once the route and the caller are known. */
  readonly routeStage?: boolean;
}

/** The targets (layers.md L7), early stage first. */
export const TARGETS: readonly TargetSpec[] = [
  { id: "method", label: "Method", kind: "string" },
  { id: "path", label: "Path", kind: "string" },
  { id: "rawPath", label: "Raw path", kind: "string" },
  { id: "query", label: "Query string", kind: "string" },
  { id: "queryParam", label: "Query parameter", kind: "named" },
  { id: "header", label: "Header", kind: "named" },
  { id: "anyHeader", label: "Any header's value", kind: "string" },
  { id: "cookie", label: "Cookie sent", kind: "cookie" },
  { id: "client", label: "Client address", kind: "cidr" },
  { id: "contentLength", label: "Content length", kind: "number" },
  { id: "headerCount", label: "Header count", kind: "number" },
  { id: "country", label: "Country", kind: "string" },
  { id: "asn", label: "ASN", kind: "asn" },
  { id: "class", label: "Address class", kind: "string" },
  { id: "routeKey", label: "Route", kind: "string", routeStage: true },
  { id: "user", label: "User", kind: "string", routeStage: true },
  { id: "session", label: "Session", kind: "string", routeStage: true },
  { id: "tenant", label: "Tenant", kind: "string", routeStage: true },
  { id: "apiKey", label: "API key", kind: "string", routeStage: true },
  { id: "userHash", label: "User key", kind: "string", routeStage: true },
  {
    id: "apiKeyHash",
    label: "API key's key",
    kind: "string",
    routeStage: true,
  },
];

/** The string comparisons. */
export const STRING_OPS = [
  "equals",
  "in",
  "prefix",
  "suffix",
  "contains",
  "glob",
  "regex",
  "exists",
  "length",
] as const;

/** The number comparisons. */
export const NUMBER_OPS = ["equals", "gt", "gte", "lt", "lte"] as const;

/** The ASN comparisons. */
export const ASN_OPS = ["equals", "in", "exists"] as const;

/** A comparison's name. */
export type MatchOp =
  (typeof STRING_OPS)[number] | (typeof NUMBER_OPS)[number] | "cidr";

/** One test, as the builder holds it. */
export interface MatchNode {
  /** Discriminator. */
  readonly kind: "match";
  /** The target's id. */
  readonly target: string;
  /** The header's, query parameter's or cookie's name. */
  readonly name: string;
  /** The comparison. */
  readonly op: MatchOp;
  /** The comparison under `length` (a number comparison). */
  readonly lengthOp: (typeof NUMBER_OPS)[number];
  /** The value, as typed (a list: one per line; `exists`: `true` or `false`). */
  readonly value: string;
  /** Fold case. `undefined`: the target's default. */
  readonly ignoreCase: boolean | undefined;
}

/** A condition, as the builder holds it. */
export type ConditionNode =
  | MatchNode
  | {
      readonly kind: "all" | "any";
      readonly children: readonly ConditionNode[];
    }
  | { readonly kind: "not"; readonly child: ConditionNode }
  /** A shape the builder does not know, kept as written. */
  | { readonly kind: "raw"; readonly json: string };

/** A target's spec. */
export function targetOf(id: string): TargetSpec {
  return TARGETS.find((target) => target.id === id) ?? TARGETS[1]!;
}

/** A new test: the path, by glob. */
export function newMatch(): MatchNode {
  return {
    kind: "match",
    target: "path",
    name: "",
    op: "glob",
    lengthOp: "gt",
    value: "",
    ignoreCase: undefined,
  };
}

/** Whether `value` is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Kept as written. */
function raw(value: unknown): ConditionNode {
  return { kind: "raw", json: JSON.stringify(value, null, 2) };
}

/** A list value as the builder types it: one per line. */
function lines(list: unknown): string | undefined {
  return Array.isArray(list) &&
    list.every((item) => typeof item === "string" || typeof item === "number")
    ? list.join("\n")
    : undefined;
}

/** Reads one comparison object (`{ glob: "…" }`, `{ length: { gt: 4 } }`). */
function comparison(
  kind: TargetSpec["kind"],
  matcher: Record<string, unknown>,
): Pick<MatchNode, "op" | "lengthOp" | "value" | "ignoreCase"> | undefined {
  const { ignoreCase, ...rest } = matcher;
  if (ignoreCase !== undefined && typeof ignoreCase !== "boolean")
    return undefined;
  const keys = Object.keys(rest);
  if (keys.length !== 1) return undefined;
  const op = keys[0]!;
  const value = rest[op];
  const base = { lengthOp: "gt" as const, ignoreCase };
  if (kind === "number") {
    return (NUMBER_OPS as readonly string[]).includes(op) &&
      typeof value === "number"
      ? { ...base, op: op as MatchOp, value: String(value) }
      : undefined;
  }
  if (kind === "asn") {
    if (op === "equals" && typeof value === "number")
      return { ...base, op, value: String(value) };
    if (op === "in" && lines(value) !== undefined)
      return { ...base, op, value: lines(value)! };
    if (op === "exists" && typeof value === "boolean")
      return { ...base, op, value: String(value) };
    return undefined;
  }
  if (op === "in") {
    const list = lines(value);
    return list === undefined ? undefined : { ...base, op, value: list };
  }
  if (op === "exists")
    return typeof value === "boolean"
      ? { ...base, op, value: String(value) }
      : undefined;
  if (op === "length") {
    if (!isObject(value)) return undefined;
    const inner = Object.entries(value);
    if (inner.length !== 1) return undefined;
    const [lengthOp, n] = inner[0]!;
    return (NUMBER_OPS as readonly string[]).includes(lengthOp) &&
      typeof n === "number"
      ? {
          ...base,
          op,
          lengthOp: lengthOp as MatchNode["lengthOp"],
          value: String(n),
        }
      : undefined;
  }
  return (STRING_OPS as readonly string[]).includes(op) &&
    typeof value === "string"
    ? { ...base, op: op as MatchOp, value }
    : undefined;
}

/** A condition from the policy's JSON; what it does not know is kept raw. */
export function parseCondition(value: unknown): ConditionNode {
  if (!isObject(value)) return raw(value);
  const keys = Object.keys(value);
  if (keys.length === 1 && (keys[0] === "all" || keys[0] === "any")) {
    const list = value[keys[0]];
    return Array.isArray(list)
      ? { kind: keys[0], children: list.map(parseCondition) }
      : raw(value);
  }
  if (keys.length === 1 && keys[0] === "not")
    return { kind: "not", child: parseCondition(value.not) };
  // A named target carries its name beside the comparison.
  for (const named of ["header", "queryParam"] as const) {
    if (typeof value[named] === "string") {
      const { [named]: name, ...matcher } = value;
      const parsed = comparison("string", matcher);
      return parsed === undefined
        ? raw(value)
        : { kind: "match", target: named, name: name as string, ...parsed };
    }
  }
  if (typeof value.cookie === "string") {
    return keys.length === 2 && typeof value.exists === "boolean"
      ? {
          kind: "match",
          target: "cookie",
          name: value.cookie,
          op: "exists",
          lengthOp: "gt",
          value: String(value.exists),
          ignoreCase: undefined,
        }
      : raw(value);
  }
  if (keys.length !== 1) return raw(value);
  const target = TARGETS.find((item) => item.id === keys[0]);
  const matcher = value[keys[0]!];
  if (target === undefined || !isObject(matcher)) return raw(value);
  if (target.kind === "cidr") {
    const cidr = matcher.cidr;
    const list =
      typeof cidr === "string"
        ? cidr
        : Array.isArray(cidr)
          ? lines(cidr)
          : undefined;
    return Object.keys(matcher).length === 1 && list !== undefined
      ? {
          kind: "match",
          target: target.id,
          name: "",
          op: "cidr",
          lengthOp: "gt",
          value: list,
          ignoreCase: undefined,
        }
      : raw(value);
  }
  const parsed = comparison(target.kind, matcher);
  return parsed === undefined
    ? raw(value)
    : { kind: "match", target: target.id, name: "", ...parsed };
}

/** A number typed, or a reason. */
function numberOf(text: string, what: string): number | string {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(n)
    ? n
    : `${what} must be a number`;
}

/** Every line typed, trimmed, empties dropped. */
function listOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Why a test's `regex` is refused, or `undefined` (also for a test that is not a regex). */
export function regexVerdict(node: MatchNode): string | undefined {
  if (node.op !== "regex") return undefined;
  if (node.value === "") return "Type a pattern";
  return regexRefusal(node.value, node.ignoreCase === true);
}

/** One test as JSON, or the reason it cannot be. */
function matchJson(node: MatchNode): Record<string, unknown> | string {
  const target = targetOf(node.target);
  const label = target.label;
  if (
    (target.kind === "named" || target.kind === "cookie") &&
    node.name.trim() === ""
  )
    return `${label}: name it`;
  if (target.kind === "cookie") {
    return node.value === "true" || node.value === "false"
      ? { cookie: node.name.trim(), exists: node.value === "true" }
      : `${label}: say whether it is sent`;
  }
  if (target.kind === "cidr") {
    const ranges = listOf(node.value);
    if (ranges.length === 0) return `${label}: give a range`;
    return { client: { cidr: ranges.length === 1 ? ranges[0] : ranges } };
  }
  let matcher: Record<string, unknown>;
  if (target.kind === "number") {
    const n = numberOf(node.value, label);
    if (typeof n === "string") return n;
    matcher = { [node.op]: n };
  } else if (target.kind === "asn") {
    if (node.op === "exists") matcher = { exists: node.value === "true" };
    else if (node.op === "in") {
      const list = listOf(node.value).map(Number);
      if (list.length === 0 || list.some((n) => !Number.isInteger(n)))
        return `${label}: one whole number per line`;
      matcher = { in: list };
    } else {
      const n = numberOf(node.value, label);
      if (typeof n === "string") return n;
      matcher = { equals: n };
    }
  } else {
    switch (node.op) {
      case "in": {
        const list = listOf(node.value);
        if (list.length === 0) return `${label}: one value per line`;
        matcher = { in: list };
        break;
      }
      case "exists":
        matcher = { exists: node.value !== "false" };
        break;
      case "length": {
        const n = numberOf(node.value, `${label}'s length`);
        if (typeof n === "string") return n;
        matcher = { length: { [node.lengthOp]: n } };
        break;
      }
      case "regex": {
        const refused = regexVerdict(node);
        if (refused !== undefined) return `${label}: ${refused}`;
        matcher = { regex: node.value };
        break;
      }
      default:
        if (node.value === "") return `${label}: type a value`;
        matcher = { [node.op]: node.value };
    }
    if (node.ignoreCase !== undefined) matcher.ignoreCase = node.ignoreCase;
  }
  return target.kind === "named"
    ? { [target.id]: node.name.trim(), ...matcher }
    : { [target.id]: matcher };
}

/** The condition as the policy's JSON, or the first reason it cannot be. */
export function conditionJson(
  node: ConditionNode,
): { json: unknown } | { error: string } {
  switch (node.kind) {
    case "match": {
      const json = matchJson(node);
      return typeof json === "string" ? { error: json } : { json };
    }
    case "not": {
      const child = conditionJson(node.child);
      return "error" in child ? child : { json: { not: child.json } };
    }
    case "all":
    case "any": {
      if (node.children.length === 0)
        return { error: `An “${node.kind}” group needs a test` };
      const out: unknown[] = [];
      for (const child of node.children) {
        const json = conditionJson(child);
        if ("error" in json) return json;
        out.push(json.json);
      }
      return { json: { [node.kind]: out } };
    }
    case "raw":
      try {
        return { json: JSON.parse(node.json) as unknown };
      } catch {
        return { error: "A condition written as JSON does not parse" };
      }
  }
}
