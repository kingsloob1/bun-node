/**
 * OpenAPI to runtime zod schemas (typed-client plan §5.2, PR-C4): the module
 * `bun-client generate --zod` writes beside the route map, which the client
 * loads lazily as its built-in schemas (`schemas: () => import(…)`).
 *
 * - **Flavours.** `zod/mini` by default (a third of classic's size, no
 *   `new Function`), classic `zod` on request. Both are written the same
 *   way, as function calls (`z.optional(x)`, `x.check(z.minLength(1))`),
 *   which both flavours have; only the import and the annotation differ.
 * - **Loose objects** (`z.looseObject`), requests included: a client
 *   checking a response must not reject a field a newer server added, and
 *   the server is the authority on unknown keys (§5.2).
 * - **Components** are exported constants, annotated with zod's base type
 *   so recursion needs no inference, each written after the components it
 *   refers to. A schema refers to itself through `z.lazy(() => Name)`; a
 *   cycle between components through a hoisted accessor
 *   (`z.lazy(lazyName)`, a function declaration after them), so nothing is
 *   used before it is defined (`no-use-before-define`).
 * - **What is checked**: types, `enum`/`const`, objects and their required
 *   keys, arrays and tuples, unions (`oneOf`/`anyOf`), `allOf`, `nullable`;
 *   string lengths and `pattern` (a regular-expression literal), the formats
 *   `email`, `uuid` (as zod's lenient `guid`), `date-time` (offsets
 *   allowed), `date` and `uri`; number ranges and `multipleOf`; array
 *   lengths. Other keywords are not checked (the check is looser, never
 *   stricter, than the document); keywords the types cannot express either
 *   (`not`, `if`, …) leave their schema `z.unknown()`, with a warning.
 * - **Per route**: `params`, `query` and `headers` from the documented
 *   parameters (loose objects of them), `body` from a JSON request body or
 *   a form's fields (multipart or urlencoded), `files` from a multipart
 *   body's files (`z.file()` with `z.maxSize` from `x-bun-max-bytes` and
 *   `z.mime` from the part's exact media types, a list `z.array` with its
 *   `maxItems`; a wildcard media type is not checked), and `responses` by
 *   numeric status: a JSON body's schema, an NDJSON stream's line schema,
 *   `z.string()` for a text one, `null` for none; and an event stream's
 *   `events` (`x-sse-events`): each event's data schema by name, `null` for
 *   one that carries none (`sse.md` §3.3), and under `x-sse-data: "text"`
 *   checked as text, as a header is (below). A part, or a status, with
 *   nothing to check (a raw body, an event stream's status, a binary
 *   download, a raw stream) is left out. `responseHeaders` by numeric
 *   status, from the headers each declares (`Content-Type` and
 *   `Set-Cookie` left out).
 * - **Headers** cross as strings, request and response alike: a header
 *   whose schema describes strings is checked by it, any other
 *   (`z.coerce.number()` documents `integer`) as `z.string()`.
 *
 * The module is laid out as Prettier lays it out (`./doc`), so `bun fmt`
 * leaves it unchanged (`__tests__/codegen/format.test.ts`).
 */
import type { Doc } from "./doc";
import type { FoundOperation } from "./openapi";
import type { SchemaContext } from "./schema";
import type { ParsedChannel } from "./asyncapi";
import type { FileField } from "./form";
import { pathParams } from "../path";
import {
  breakParent,
  conditionalGroup,
  fluid,
  group,
  hardline,
  hasHardline,
  ifBreak,
  indent,
  join,
  line,
  printDoc,
  softline,
} from "./doc";
import { framingOf, splitMultipart } from "./form";
import { declaredHeaders, isStringSchema } from "./headers";
import { componentIdentifiers, RESERVED } from "./openapi";
import { jsDoc, propertyKey, quote } from "./print";
import {
  componentOf,
  INEXPRESSIBLE,
  isRecord,
  mediaKind,
  resolvePointer,
} from "./schema";

/** Which zod the module imports: `"mini"` (`zod/mini`) or `"classic"` (`zod`). */
export type ZodFlavour = "mini" | "classic";

/** A JavaScript expression, as the emitter writes one. */
type Expr =
  | {
      /** An atom: an identifier, a literal, a regular expression, an arrow. */
      readonly kind: "atom";
      /** Its source text. */
      readonly text: string;
      /** Whether Prettier counts it a short call argument (`isShortCallArgument`). */
      readonly short: boolean;
      /** An arrow function (`() => Name`). Default: not. */
      readonly arrow?: boolean;
    }
  | {
      /** `callee(args)`, the callee a dotted name (`z.looseObject`). */
      readonly kind: "call";
      /** The dotted callee. */
      readonly callee: string;
      /** The arguments. */
      readonly args: readonly Expr[];
    }
  | {
      /** `base.check(checks)`: a member chain of two calls. */
      readonly kind: "check";
      /** The schema checked. */
      readonly base: Extract<Expr, { kind: "call" }>;
      /** The checks. */
      readonly checks: readonly Expr[];
    }
  | {
      /** An object literal: expanded (one property per line), or `inline` as a group. */
      readonly kind: "object";
      /** Its properties, in order. */
      readonly members: readonly (readonly [
        key: string | number,
        value: Expr,
      ])[];
      /** Written on one line, so Prettier keeps it there while it fits. Default: expanded. */
      readonly inline?: boolean;
    }
  | {
      /** An array literal. */
      readonly kind: "array";
      /** Its elements. */
      readonly elements: readonly Expr[];
    };

/** An atom. */
function atom(text: string, short: boolean): Expr {
  return { kind: "atom", text, short };
}

/** A call. */
function call(callee: string, ...args: readonly Expr[]): Expr {
  return { kind: "call", callee, args };
}

/** Prettier's `isShortCallArgument` threshold: a quarter of the line. */
const SHORT = 20;

/** A string literal. */
function str(value: string): Expr {
  const text = quote(value);
  return atom(text, text.length <= SHORT);
}

/** A number literal, as Prettier prints it (`1e21`, not `1e+21`). */
function num(value: number): Expr {
  return atom(String(value).replace("e+", "e"), true);
}

/** A JSON primitive as a literal. */
function literal(value: string | number | boolean | null): Expr {
  if (typeof value === "string") return str(value);
  if (typeof value === "number") return num(value);
  return atom(String(value), true);
}

/** `z.<name>()` with the given arguments. */
const z = (name: string, ...args: readonly Expr[]): Expr =>
  call(`z.${name}`, ...args);

/** `z.unknown()`. */
const UNKNOWN_SCHEMA = z("unknown");

/** Whether `expr` is `z.unknown()`. */
function isUnknown(expr: Expr): boolean {
  return expr.kind === "call" && expr.callee === "z.unknown";
}

/** `base.check(checks)`, or `base` when there are none. */
function checked(base: Expr, checks: readonly Expr[]): Expr {
  if (checks.length === 0 || base.kind !== "call") return base;
  return { kind: "check", base, checks };
}

/** `z.optional(x)`; `z.unknown()` already admits `undefined`. */
function optional(expr: Expr): Expr {
  return isUnknown(expr) ? expr : z("optional", expr);
}

/** `z.union([...])` of `members`, duplicates dropped; one member is itself; `z.unknown()` absorbs. */
function unionOf(members: readonly Expr[]): Expr {
  const out: Expr[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (isUnknown(member)) return UNKNOWN_SCHEMA;
    const key = JSON.stringify(member);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(member);
  }
  if (out.length === 0) return z("never");
  if (out.length === 1) return out[0];
  const others = out.filter(
    (member) => !(member.kind === "call" && member.callee === "z.null"),
  );
  if (out.length === 2 && others.length === 1) return z("nullable", others[0]);
  return z("union", { kind: "array", elements: out });
}

/** `z.intersection` of `members`, folded left; `z.unknown()` members dropped. */
function intersectionOf(members: readonly Expr[]): Expr {
  const out = members.filter((member) => !isUnknown(member));
  if (out.length === 0) return UNKNOWN_SCHEMA;
  return out.reduce((left, right) => z("intersection", left, right));
}

/** The escapes for the line terminators a regular-expression literal cannot hold. */
const LINE_TERMINATOR_ESCAPES: Readonly<Record<string, string>> = {
  "\n": "\\n",
  "\r": "\\r",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * A JSON Schema `pattern` as a regular-expression literal; `undefined` when
 * it does not compile.
 *
 * A `/` is escaped only outside a character class, where it would end the
 * literal: inside `[...]` it is literal text, and escaping it there trips
 * `no-useless-escape` in a project that lints its generated modules (#776).
 * A line terminator (`\n`, `\r`, U+2028, U+2029), escaped or not, is written
 * as its escape, since a literal cannot hold one. The pattern compiled
 * without flags above, so a class does not nest and its first unescaped `]`
 * closes it.
 */
function regexLiteral(pattern: string): Expr | undefined {
  try {
    void new RegExp(pattern);
  } catch {
    return undefined;
  }
  let body = "";
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      const next = pattern[index + 1] ?? "";
      body += LINE_TERMINATOR_ESCAPES[next] ?? char + next;
      index++;
    } else if (char === "[") {
      inClass = true;
      body += char;
    } else if (char === "]") {
      inClass = false;
      body += char;
    } else if (char === "/") body += inClass ? "/" : "\\/";
    else body += LINE_TERMINATOR_ESCAPES[char] ?? char;
  }
  if (body === "") body = "(?:)";
  return atom(`/${body}/`, body.length <= 5);
}

/** Whether a bound is worth checking: zod's own `z.int()` already holds the safe-integer range. */
function isBound(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) < Number.MAX_SAFE_INTEGER
  );
}

/** One conversion: the document, the warning sink, where references point, and the recursion guard. */
interface Walk {
  /** The document and the warning callback. */
  readonly context: SchemaContext;
  /**
   * How a reference to a component's constant is written: the constant
   * itself once defined, `z.lazy(() => Name)` for the component being
   * defined, or through its hoisted accessor when it comes later.
   */
  readonly reference: (id: string) => Expr;
  /** The non-component pointers being inlined, outermost first. */
  readonly inlining: readonly string[];
}

/** A JSON Schema as a zod expression. */
function convert(schema: unknown, walk: Walk, at: string): Expr {
  if (schema === true || schema === undefined) return UNKNOWN_SCHEMA;
  if (schema === false) return z("never");
  if (!isRecord(schema)) {
    walk.context.warn(at, "not a JSON Schema; not checked");
    return UNKNOWN_SCHEMA;
  }
  if (
    "not" in schema &&
    (schema.not === true ||
      (isRecord(schema.not) && Object.keys(schema.not).length === 0))
  )
    return z("never");
  const inexpressible = INEXPRESSIBLE.filter((name) => name in schema);
  if (inexpressible.length > 0) {
    walk.context.warn(
      at,
      `${inexpressible.map((name) => `\`${name}\``).join(", ")} cannot be checked; not checked`,
    );
    return UNKNOWN_SCHEMA;
  }

  const parts: Expr[] = [];
  if (typeof schema.$ref === "string") {
    parts.push(convertRef(schema.$ref, walk, at));
  } else if ("$ref" in schema) {
    walk.context.warn(at, "`$ref` is not a string; not checked");
    return UNKNOWN_SCHEMA;
  }
  const composed =
    typeof schema.$ref === "string" ||
    Array.isArray(schema.allOf) ||
    Array.isArray(schema.oneOf) ||
    Array.isArray(schema.anyOf);
  const base = convertBase(schema, walk, at);
  // A bare `type: "object"` beside a composition says only "an object".
  if (base !== undefined && !(composed && isAnyObject(base))) parts.push(base);
  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((member, index) => {
      parts.push(convert(member, walk, `${at} allOf[${index}]`));
    });
  }
  for (const name of ["oneOf", "anyOf"] as const) {
    const members = schema[name];
    if (Array.isArray(members))
      parts.push(
        unionOf(
          members.map((member, index) =>
            convert(member, walk, `${at} ${name}[${index}]`),
          ),
        ),
      );
  }
  let expr = intersectionOf(parts);
  if (schema.nullable === true && !isUnknown(expr)) expr = z("nullable", expr);
  return expr;
}

/** Whether `expr` is `z.looseObject({})`, what `{ type: "object" }` alone converts to. */
function isAnyObject(expr: Expr): boolean {
  return (
    expr.kind === "call" &&
    expr.callee === "z.looseObject" &&
    expr.args[0]?.kind === "object" &&
    expr.args[0].members.length === 0
  );
}

/** A `$ref`: a component's constant (lazily, inside a component), or the target inlined. */
function convertRef(ref: string, walk: Walk, at: string): Expr {
  const component = componentOf(ref);
  if (component !== undefined) {
    const name = walk.context.componentType(component);
    if (name === undefined) {
      walk.context.warn(
        at,
        `\`$ref\` "${ref}" names no component; not checked`,
      );
      return UNKNOWN_SCHEMA;
    }
    return walk.reference(name);
  }
  if (!ref.startsWith("#")) {
    walk.context.warn(
      at,
      `\`$ref\` "${ref}" points outside the document; not checked`,
    );
    return UNKNOWN_SCHEMA;
  }
  if (walk.inlining.includes(ref)) {
    walk.context.warn(
      at,
      `\`$ref\` "${ref}" is recursive and not a component; not checked`,
    );
    return UNKNOWN_SCHEMA;
  }
  const target = resolvePointer(walk.context.document, ref);
  if (target === undefined) {
    walk.context.warn(at, `\`$ref\` "${ref}" does not resolve; not checked`);
    return UNKNOWN_SCHEMA;
  }
  return convert(
    target,
    { ...walk, inlining: [...walk.inlining, ref] },
    `${at} → ${ref}`,
  );
}

/** What the schema's own keywords say; `undefined` when they say nothing. */
function convertBase(
  schema: Record<string, unknown>,
  walk: Walk,
  at: string,
): Expr | undefined {
  if ("const" in schema) return valueSchema(schema.const, walk, at);
  if (Array.isArray(schema.enum)) {
    const values = schema.enum;
    if (
      values.length > 0 &&
      values.every((value): value is string => typeof value === "string")
    )
      return z("enum", {
        kind: "array",
        elements: [...new Set(values)].map(str),
      });
    return unionOf(values.map((value) => valueSchema(value, walk, at)));
  }
  const declared = schema.type;
  const types: string[] =
    typeof declared === "string"
      ? [declared]
      : Array.isArray(declared)
        ? declared.filter((item): item is string => typeof item === "string")
        : [];
  if (types.length === 0) {
    if (
      "properties" in schema ||
      "additionalProperties" in schema ||
      "patternProperties" in schema ||
      "required" in schema
    )
      return convertObject(schema, walk, at);
    if ("items" in schema || "prefixItems" in schema)
      return convertArray(schema, walk, at);
    return undefined;
  }
  return unionOf(
    types.map((name): Expr => {
      switch (name) {
        case "string":
          return convertString(schema);
        case "number":
        case "integer":
          return convertNumber(schema, name);
        case "boolean":
          return z("boolean");
        case "null":
          return z("null");
        case "object":
          return convertObject(schema, walk, at);
        case "array":
          return convertArray(schema, walk, at);
        default:
          walk.context.warn(
            at,
            `unknown \`type\` "${name}"; that member not checked`,
          );
          return UNKNOWN_SCHEMA;
      }
    }),
  );
}

/** A `const` or `enum` member: a literal for a primitive; anything else is not checked. */
function valueSchema(value: unknown, walk: Walk, at: string): Expr {
  if (value === null) return z("null");
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return z("literal", literal(value));
  walk.context.warn(
    at,
    "a `const` or `enum` value that is an object or array is not checked",
  );
  return UNKNOWN_SCHEMA;
}

/** The string formats checked, and their zod schemas (lenient where JSON Schema is). */
const FORMATS: Readonly<Record<string, () => Expr>> = {
  email: () => z("email"),
  uuid: () => z("guid"),
  "date-time": () =>
    call("z.iso.datetime", {
      kind: "object",
      members: [["offset", atom("true", true)]],
      inline: true,
    }),
  date: () => call("z.iso.date"),
  uri: () => z("url"),
};

/** A string schema: its format, lengths and pattern. */
function convertString(schema: Record<string, unknown>): Expr {
  const format =
    typeof schema.format === "string" ? FORMATS[schema.format] : undefined;
  const checks: Expr[] = [];
  if (isBound(schema.minLength))
    checks.push(z("minLength", num(schema.minLength)));
  if (isBound(schema.maxLength))
    checks.push(z("maxLength", num(schema.maxLength)));
  // A format's own check stands for its pattern (zod writes both).
  if (format === undefined && typeof schema.pattern === "string") {
    const regex = regexLiteral(schema.pattern);
    if (regex !== undefined) checks.push(z("regex", regex));
  }
  return checked(format === undefined ? z("string") : format(), checks);
}

/** A number schema: integer or not, its range and `multipleOf`. */
function convertNumber(
  schema: Record<string, unknown>,
  type: "number" | "integer",
): Expr {
  const checks: Expr[] = [];
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema;
  // OpenAPI 3.0 writes an exclusive bound as a boolean beside the bound.
  if (isBound(minimum))
    checks.push(z(exclusiveMinimum === true ? "gt" : "gte", num(minimum)));
  if (isBound(exclusiveMinimum)) checks.push(z("gt", num(exclusiveMinimum)));
  if (isBound(maximum))
    checks.push(z(exclusiveMaximum === true ? "lt" : "lte", num(maximum)));
  if (isBound(exclusiveMaximum)) checks.push(z("lt", num(exclusiveMaximum)));
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0)
    checks.push(z("multipleOf", num(schema.multipleOf)));
  return checked(z(type === "integer" ? "int" : "number"), checks);
}

/** An object schema, loose: its properties (optional unless required), or a record of `additionalProperties`. */
function convertObject(
  schema: Record<string, unknown>,
  walk: Walk,
  at: string,
): Expr {
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const members = Object.entries(properties).map(
    ([name, child]): readonly [string, Expr] => {
      const expr = convert(child, walk, `${at}.${name}`);
      return [name, required.has(name) ? expr : optional(expr)];
    },
  );
  const additional = schema.additionalProperties;
  if (
    members.length === 0 &&
    additional !== undefined &&
    typeof additional !== "boolean"
  )
    return z(
      "record",
      z("string"),
      convert(additional, walk, `${at} additionalProperties`),
    );
  return z("looseObject", { kind: "object", members });
}

/** An array schema: `z.array`, or `z.tuple` from `prefixItems` (or 3.0's array-form `items`), with its lengths. */
function convertArray(
  schema: Record<string, unknown>,
  walk: Walk,
  at: string,
): Expr {
  const prefix = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : undefined;
  const items = Array.isArray(schema.items)
    ? schema.additionalItems
    : schema.items;
  const checks: Expr[] = [];
  if (isBound(schema.minItems))
    checks.push(z("minLength", num(schema.minItems)));
  if (isBound(schema.maxItems))
    checks.push(z("maxLength", num(schema.maxItems)));
  if (prefix !== undefined) {
    const elements: Expr = {
      kind: "array",
      elements: prefix.map((item, index) =>
        convert(item, walk, `${at}[${index}]`),
      ),
    };
    const tuple =
      items === false
        ? z("tuple", elements)
        : z("tuple", elements, convert(items, walk, `${at}[]`));
    return checked(tuple, checks);
  }
  return checked(z("array", convert(items, walk, `${at}[]`)), checks);
}

/* ------------------------------------------------------------------------ */
/* Printing, as Prettier prints the same source.                             */
/* ------------------------------------------------------------------------ */

/** Whether a call's last argument hugs its parentheses (Prettier's `couldExpandArg`). */
function huggable(expr: Expr | undefined): boolean {
  return (
    (expr?.kind === "object" && expr.members.length > 0) ||
    (expr?.kind === "array" && expr.elements.length > 0)
  );
}

/** A call's arguments, `(…)`, laid out as Prettier's `printCallArguments` does. */
function printArguments(args: readonly Expr[]): Doc {
  if (args.length === 0) return "()";
  const printed = args.map(printExpr);
  const last = args[args.length - 1];
  const penultimate = args.length > 1 ? args[args.length - 2] : undefined;
  const allBroken = group(
    ["(", indent([line, join([",", line], printed), ","]), line, ")"],
    true,
  );
  // Prettier's `isFunctionCompositionArgs`: several arguments, one of them a
  // call taking an arrow function (`z.lazy(() => Name)`), break them all.
  if (
    args.length > 1 &&
    args.some(
      (arg) =>
        arg.kind === "call" &&
        arg.args.some((inner) => inner.kind === "atom" && inner.arrow === true),
    )
  )
    return allBroken;
  if (huggable(last) && penultimate?.kind !== last.kind) {
    const nonLast = printed.slice(0, -1);
    if (nonLast.some(hasHardline)) return allBroken;
    const head: Doc[] = nonLast.flatMap((doc) => [doc, ", "]);
    return [
      printed.some(hasHardline) ? breakParent : "",
      conditionalGroup([
        ["(", join([",", line], printed), ")"],
        ["(", ...head, group(printed[printed.length - 1], true), ")"],
        allBroken,
      ]),
    ];
  }
  return group([
    "(",
    indent([softline, join([",", line], printed)]),
    ifBreak(","),
    softline,
    ")",
  ]);
}

/** `base.check(…)`, a member chain: on one line when it fits, else one call per line. */
function printCheck(expr: Extract<Expr, { kind: "check" }>): Doc {
  const dot = expr.base.callee.lastIndexOf(".");
  const head = expr.base.callee.slice(0, dot);
  const first: Doc = [
    expr.base.callee.slice(dot),
    printArguments(expr.base.args),
  ];
  const second: Doc = [".check", printArguments(expr.checks)];
  const expanded: Doc = [head, indent([hardline, first, hardline, second])];
  if (hasHardline(first)) return group(expanded);
  const oneLine: Doc = [head, first, second];
  return [
    hasHardline(oneLine) ? breakParent : "",
    conditionalGroup([oneLine, expanded]),
  ];
}

/** An expression. */
function printExpr(expr: Expr): Doc {
  switch (expr.kind) {
    case "atom":
      return expr.text;
    case "call":
      return [expr.callee, printArguments(expr.args)];
    case "check":
      return printCheck(expr);
    case "object":
      if (expr.members.length === 0) return "{}";
      if (expr.inline === true)
        return group([
          "{",
          indent([
            line,
            join(
              [",", line],
              expr.members.map(([key, value]) =>
                assignment(propertyKey(key), ":", value, true),
              ),
            ),
          ]),
          ifBreak(","),
          line,
          "}",
        ]);
      return group([
        "{",
        indent([
          hardline,
          join(
            [",", hardline],
            expr.members.map(([key, value]) =>
              assignment(propertyKey(key), ":", value, true),
            ),
          ),
          ",",
        ]),
        hardline,
        "}",
      ]);
    case "array":
      if (expr.elements.length === 0) return "[]";
      return group([
        "[",
        indent([softline, join([",", line], expr.elements.map(printExpr))]),
        ifBreak(","),
        softline,
        "]",
      ]);
  }
}

/**
 * Prettier's `isPoorlyBreakableMemberOrCallChain`: a call (or chain of
 * calls) whose every call has no argument or one short one.
 */
function poorlyBreakable(expr: Expr): boolean {
  if (expr.kind === "call")
    return (
      expr.args.length === 0 ||
      (expr.args.length === 1 &&
        expr.args[0].kind === "atom" &&
        expr.args[0].short)
    );
  if (expr.kind === "check")
    return (
      poorlyBreakable(expr.base) &&
      poorlyBreakable({ kind: "call", callee: "", args: expr.checks })
    );
  return false;
}

/**
 * `left<operator> right`, with Prettier's assignment layouts: a short
 * property key never breaks after the colon; a poorly breakable right side
 * moves to the next line whole when it does not fit ("break-after-operator");
 * anything else stays on the line while its first line fits ("fluid").
 */
function assignment(
  left: string,
  operator: string,
  right: Expr,
  property: boolean,
): Doc {
  const printed = printExpr(right);
  // Prettier's `isObjectPropertyWithShortKey`: shorter than a tab plus 3.
  if (property && left.length < 5) return [left, operator, " ", printed];
  if (poorlyBreakable(right))
    return group([left, operator, group(indent([line, printed]))]);
  return group([left, operator, fluid(printed)]);
}

/* ------------------------------------------------------------------------ */
/* The module.                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Names the zod module itself uses, which a component's constant must not
 * take: the types module's, and its own. A function, not a constant: this
 * module and `./openapi` import each other.
 */
function zodReserved(): ReadonlySet<string> {
  return new Set([
    ...RESERVED,
    "z",
    "schemas",
    "schemasFromZod",
    "channelSchemas",
  ]);
}

/** What {@link emitZodModule} needs of the document, already read by `generateRoutes`. */
export interface ZodModuleInput {
  /** The whole OpenAPI document. */
  readonly document: Record<string, unknown>;
  /** Its `components.schemas` names, sorted. */
  readonly componentNames: readonly string[];
  /** The route keys, in the map's order. */
  readonly keys: readonly string[];
  /** Each key's operations (two when an optional param documents as two paths). */
  readonly operations: ReadonlyMap<string, readonly FoundOperation[]>;
  /** The documents' hash, for the header. */
  readonly hash: string;
  /** Which zod to import. */
  readonly flavour: ZodFlavour;
  /** The import specifier of the route map module, for `Routes`. */
  readonly routesModule: string;
  /** The module `schemasFromZod` is imported from, with `/zod` appended. */
  readonly clientModule: string;
  /**
   * The AsyncAPI document's WebSocket channels (`./asyncapi`), written as
   * `channelSchemas`: each channel's message data schemas by side (`null`
   * for a message with no data), which `channel()` reads through the
   * client's `schemas` source. Their `$ref`s are inlined already. Default:
   * none (no `channelSchemas`).
   */
  readonly channels?: readonly ParsedChannel[];
}

/** A warning: where, and what. */
interface Warning {
  /** Where. */
  readonly at: string;
  /** What. */
  readonly message: string;
}

/** A request part's loose object of documented parameters; `undefined` when there are none. */
function parametersObject(
  parameters: readonly Record<string, unknown>[],
  location: "query" | "header",
  walk: Walk,
  key: string,
): Expr | undefined {
  const members: (readonly [string, Expr])[] = [];
  const seen = new Set<string>();
  for (const param of parameters) {
    if (param.in !== location) continue;
    const name =
      location === "header"
        ? String(param.name).toLowerCase()
        : String(param.name);
    if (seen.has(name)) continue;
    seen.add(name);
    const at = `${key} ${location === "header" ? "headers" : "query"}.${name}`;
    // A header is checked as sent, a string (`./headers`).
    const expr =
      location === "header"
        ? headerSchema(parameterSchemaOf(param), walk, at)
        : parameterSchema(param, walk, at);
    members.push([name, param.required === true ? expr : optional(expr)]);
  }
  return members.length === 0
    ? undefined
    : z("looseObject", { kind: "object", members });
}

/** A parameter's JSON Schema: its `schema`, or its first `content` entry's; `undefined` when neither is given. */
function parameterSchemaOf(param: Record<string, unknown>): unknown {
  if ("schema" in param) return param.schema;
  if (isRecord(param.content)) {
    const first = Object.values(param.content)[0];
    if (isRecord(first) && "schema" in first) return first.schema;
  }
  return undefined;
}

/**
 * A header value's schema: a header crosses as a string, so a schema that
 * describes strings is checked as it is, and any other (`integer`,
 * `boolean`, none) as `z.string()`: looser than the document, never
 * stricter (`./headers`). A text event's data (`x-sse-data: "text"`) is
 * checked the same way.
 */
function headerSchema(schema: unknown, walk: Walk, at: string): Expr {
  return isStringSchema(walk.context.document, schema)
    ? convert(schema, walk, at)
    : z("string");
}

/** A parameter's schema: its `schema`, or its `content`'s; a string when neither is given. */
function parameterSchema(
  param: Record<string, unknown>,
  walk: Walk,
  at: string,
): Expr {
  if ("schema" in param) return convert(param.schema, walk, at);
  if (isRecord(param.content)) {
    const first = Object.values(param.content)[0];
    if (isRecord(first) && "schema" in first)
      return convert(first.schema, walk, at);
  }
  return z("string");
}

/**
 * The components a schema refers to by `$ref`, at any depth, following
 * local pointers that are not components (as {@link convert} inlines them)
 * but not into the components themselves.
 */
function referencedComponents(schema: unknown, document: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string") {
      const component = componentOf(record.$ref);
      if (component !== undefined) {
        if (!found.includes(component)) found.push(component);
      } else walk(resolvePointer(document, record.$ref));
    }
    for (const [key, child] of Object.entries(record))
      if (key !== "$ref") walk(child);
  };
  walk(schema);
  return found;
}

/** One route's schemas: the object `schemasFromZod` takes for its key; `undefined` when nothing is checked. */
function routeSchemas(
  key: string,
  found: readonly FoundOperation[],
  walk: Walk,
): Expr | undefined {
  const { operation, parameters } = found[0];
  const members: (readonly [string, Expr])[] = [];

  /* params: the key's own, typed from the documented path parameters. */
  const documented = new Map<string, Record<string, unknown>>();
  for (const variant of found)
    for (const param of variant.parameters)
      if (param.in === "path" && !documented.has(String(param.name)))
        documented.set(String(param.name), param);
  const params: (readonly [string, Expr])[] = [];
  const named = new Set<string>();
  for (const info of pathParams(key.slice(key.indexOf(" ") + 1))) {
    if (named.has(info.name)) continue;
    named.add(info.name);
    const param = documented.get(info.name);
    const expr = info.wildcard
      ? z("array", z("string"))
      : param === undefined
        ? z("string")
        : parameterSchema(param, walk, `${key} params.${info.name}`);
    params.push([info.name, info.optional ? optional(expr) : expr]);
  }
  if (params.length > 0)
    members.push([
      "params",
      z("looseObject", { kind: "object", members: params }),
    ]);

  const query = parametersObject(parameters, "query", walk, key);
  if (query !== undefined) members.push(["query", query]);
  const headers = parametersObject(parameters, "header", walk, key);
  if (headers !== undefined) members.push(["headers", headers]);

  /* body: a JSON body or a form's fields; files: a multipart body's. */
  let body: unknown = operation.requestBody;
  if (isRecord(body) && typeof body.$ref === "string")
    body = resolvePointer(walk.context.document, body.$ref);
  if (isRecord(body) && isRecord(body.content)) {
    const media = Object.entries(body.content);
    const forms = new Set(["json", "multipart", "form"]);
    if (
      media.length > 0 &&
      media.every(([type]) => forms.has(mediaKind(type)))
    ) {
      const schemas: Expr[] = [];
      const files = new Map<string, Expr>();
      let fieldless = false;
      for (const [type, entry] of media) {
        const schema =
          isRecord(entry) && "schema" in entry ? entry.schema : undefined;
        if (mediaKind(type) !== "multipart") {
          schemas.push(
            schema === undefined
              ? UNKNOWN_SCHEMA
              : convert(schema, walk, `${key} body`),
          );
          continue;
        }
        if (schema === undefined) {
          schemas.push(UNKNOWN_SCHEMA);
          continue;
        }
        const split = splitMultipart(
          schema,
          isRecord(entry) ? entry.encoding : undefined,
          walk.context,
        );
        if (split.fields === undefined) fieldless = true;
        else schemas.push(convert(split.fields, walk, `${key} body`));
        for (const file of split.files)
          if (!files.has(file.name)) files.set(file.name, fileSchema(file));
      }
      if (schemas.length > 0) {
        const expr = unionOf(schemas);
        members.push([
          "body",
          body.required === true && !fieldless ? expr : optional(expr),
        ]);
      }
      if (files.size > 0)
        members.push([
          "files",
          z("looseObject", { kind: "object", members: [...files] }),
        ]);
    }
  }

  /* responses: by numeric status, JSON or text bodies, or none. */
  const raw = isRecord(operation.responses) ? operation.responses : {};
  const responses: (readonly [number, Expr])[] = [];
  let events: (readonly [string, Expr])[] | undefined;
  for (const status of Object.keys(raw)
    .filter((code) => /^[1-5]\d\d$/.test(code))
    .map(Number)
    .sort((a, b) => a - b)) {
    let response = raw[String(status)];
    if (isRecord(response) && typeof response.$ref === "string")
      response = resolvePointer(walk.context.document, response.$ref);
    if (!isRecord(response)) continue;
    const content = isRecord(response.content) ? response.content : {};
    const media = Object.entries(content);
    if (media.length === 0) {
      responses.push([status, atom("null", true)]);
      continue;
    }
    if (media.length === 1) {
      const [type, entry] = media[0];
      const schema = isRecord(entry) ? entry.schema : undefined;
      const framing = framingOf(type, schema);
      if (framing !== undefined) {
        // A streamed status: an NDJSON line's schema (the client checks
        // each line with it); a raw stream has nothing to check.
        if (framing === "ndjson" && schema !== undefined)
          responses.push([
            status,
            convert(schema, walk, `${key} response ${status}`),
          ]);
        continue;
      }
    }
    const kinds = new Set(media.map(([type]) => mediaKind(type)));
    const sse = media.some(
      ([, entry]) =>
        isRecord(entry) &&
        isRecord(entry.schema) &&
        "x-sse-events" in entry.schema,
    );
    if (sse) {
      // An event stream's events (`sse.md` §3.3): each event's data schema
      // by name, `null` for one that carries none; the first 2xx stream's.
      const declared = media
        .map(([, entry]) => (isRecord(entry) ? entry.schema : undefined))
        .find(
          (schema): schema is Record<string, unknown> =>
            isRecord(schema) && isRecord(schema["x-sse-events"]),
        )?.["x-sse-events"] as Record<string, unknown> | undefined;
      // Under `x-sse-data: "text"` an event's data arrives as text, so it
      // is checked as a header is: by a schema that describes strings, else
      // as `z.string()` (looser than the document, never stricter).
      const text = media.some(
        ([, entry]) =>
          isRecord(entry) &&
          isRecord(entry.schema) &&
          entry.schema["x-sse-data"] === "text",
      );
      if (events === undefined && declared !== undefined && status < 300)
        events = Object.keys(declared)
          .sort()
          .map((name) => {
            const at = `${key} response ${status} event "${name}"`;
            return [
              name,
              declared[name] === null
                ? atom("null", true)
                : text
                  ? headerSchema(declared[name], walk, at)
                  : convert(declared[name], walk, at),
            ];
          });
      continue;
    }
    if (kinds.size !== 1) continue;
    if (kinds.has("text")) responses.push([status, z("string")]);
    else if (kinds.has("json"))
      responses.push([
        status,
        unionOf(
          media.map(([, entry]) =>
            isRecord(entry) && "schema" in entry
              ? convert(entry.schema, walk, `${key} response ${status}`)
              : UNKNOWN_SCHEMA,
          ),
        ),
      ]);
  }
  if (responses.length > 0)
    members.push(["responses", { kind: "object", members: responses }]);
  if (events !== undefined && events.length > 0)
    members.push(["events", { kind: "object", members: events }]);

  /* responseHeaders: by numeric status, the headers it declares (§5.6). */
  const responseHeaders: (readonly [number, Expr])[] = [];
  for (const status of Object.keys(raw)
    .filter((code) => /^[1-5]\d\d$/.test(code))
    .map(Number)
    .sort((a, b) => a - b)) {
    const headers = declaredHeaders(walk.context.document, raw[String(status)]);
    if (headers.length === 0) continue;
    responseHeaders.push([
      status,
      z("looseObject", {
        kind: "object",
        members: headers.map((header) => {
          const expr = headerSchema(
            header.schema,
            walk,
            `${key} response ${status} headers.${header.name}`,
          );
          return [header.name, header.required ? expr : optional(expr)];
        }),
      }),
    ]);
  }
  if (responseHeaders.length > 0)
    members.push([
      "responseHeaders",
      { kind: "object", members: responseHeaders },
    ]);

  return members.length === 0 ? undefined : { kind: "object", members };
}

/**
 * One file field's schema: `z.file()` with its size and exact media types
 * (zod's `z.mime` takes no wildcard, so a list holding one is not checked:
 * looser, never stricter, than the document), a list of them as `z.array`
 * with its `maxItems`, optional unless required.
 */
function fileSchema(file: FileField): Expr {
  const checks: Expr[] = [];
  if (isBound(file.maxBytes)) checks.push(z("maxSize", num(file.maxBytes)));
  if (
    file.mediaTypes !== undefined &&
    file.mediaTypes.every((type) => !type.includes("*"))
  )
    checks.push(
      z("mime", { kind: "array", elements: file.mediaTypes.map(str) }),
    );
  const one = checked(z("file"), checks);
  const expr = file.multiple
    ? checked(
        z("array", one),
        isBound(file.maxItems) ? [z("maxLength", num(file.maxItems))] : [],
      )
    : one;
  return file.required ? expr : optional(expr);
}

/**
 * Writes the zod module for a document `generateRoutes` has read.
 *
 * @returns The module's source, formatted, ending in a newline, and what it
 *   could not check, in the order found.
 */
export function emitZodModule(input: ZodModuleInput): {
  code: string;
  warnings: Warning[];
} {
  const warnings: Warning[] = [];
  const identifiers = componentIdentifiers(input.componentNames, zodReserved());
  const context: SchemaContext = {
    document: input.document,
    componentType: (name) => identifiers.get(name),
    warn: (at, message) => warnings.push({ at, message }),
  };
  const components = isRecord(input.document.components)
    ? input.document.components
    : {};
  const componentSchemas = isRecord(components.schemas)
    ? components.schemas
    : {};
  const type = input.flavour === "mini" ? "z.ZodMiniType" : "z.ZodType";

  /* Components, each after those it refers to (a depth-first post-order). */
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): void => {
    if (state.has(name)) return;
    state.set(name, "visiting");
    for (const target of referencedComponents(
      componentSchemas[name],
      input.document,
    ))
      if (Object.hasOwn(componentSchemas, target)) visit(target);
    state.set(name, "done");
    order.push(name);
  };
  for (const name of input.componentNames) visit(name);

  const defined = new Set<string>();
  const taken = new Set([...identifiers.values(), ...zodReserved()]);
  /** The hoisted accessors of components referred to before they are defined, by identifier. */
  const accessors = new Map<string, string>();
  const directly = (id: string): Expr => atom(id, id.length <= SHORT);
  const declarations: Doc[] = order.map((name) => {
    const own = identifiers.get(name)!;
    const reference = (id: string): Expr => {
      if (id === own)
        return z("lazy", {
          kind: "atom",
          text: `() => ${id}`,
          short: false,
          arrow: true,
        });
      if (defined.has(id)) return directly(id);
      let accessor = accessors.get(id);
      if (accessor === undefined) {
        accessor = `lazy${id.charAt(0).toUpperCase()}${id.slice(1)}`;
        for (let n = 2; taken.has(accessor); n++)
          accessor = `lazy${id.charAt(0).toUpperCase()}${id.slice(1)}${n}`;
        taken.add(accessor);
        accessors.set(id, accessor);
      }
      return z("lazy", atom(accessor, accessor.length <= SHORT));
    };
    const expr = convert(
      componentSchemas[name],
      { context, reference, inlining: [] },
      `components.schemas.${name}`,
    );
    defined.add(own);
    return [assignment(`export const ${own}: ${type} =`, "", expr, false), ";"];
  });
  for (const [id, accessor] of accessors)
    declarations.push([
      jsDoc(`\`${id}\`, for the schemas before it that refer to it (a cycle).`),
      hardline,
      `function ${accessor}(): ${type} {`,
      indent([hardline, `return ${id};`]),
      hardline,
      "}",
    ]);

  const routes: (readonly [string, Expr])[] = [];
  for (const key of input.keys) {
    const expr = routeSchemas(key, input.operations.get(key)!, {
      context,
      reference: directly,
      inlining: [],
    });
    if (expr !== undefined) routes.push([key, expr]);
  }

  const channelMembers: (readonly [string, Expr])[] = [];
  for (const channel of input.channels ?? []) {
    const walk: Walk = { context, reference: directly, inlining: [] };
    const side = (list: ParsedChannel["sends"]): Expr => ({
      kind: "object",
      members: list.map(([type, data]) => [
        type,
        data === null
          ? atom("null", true)
          : convert(data, walk, `channel ${channel.key} message "${type}"`),
      ]),
    });
    const members: (readonly [string, Expr])[] = [];
    if (channel.receives.length > 0)
      members.push(["receives", side(channel.receives)]);
    if (channel.sends.length > 0) members.push(["sends", side(channel.sends)]);
    channelMembers.push([channel.key, { kind: "object", members }]);
  }

  const header = [
    "Generated by `bun-client generate --zod` (@kingsleyweb/bun-client) from an",
    "OpenAPI document: the runtime schemas the client validates with, loaded",
    `lazily: \`createClient<Routes>({ schemas: () => import("<this module>") })\`.`,
    "Do not edit; regenerate it, and run the same command with `--check` in CI.",
    "",
    `typesHash: ${input.hash}`,
    ...(warnings.length === 0
      ? []
      : [
          "",
          "Not checked:",
          ...warnings.map((warning) => `- ${warning.at}: ${warning.message}`),
        ]),
  ].join("\n");

  const schemasDoc: Doc = [
    "export const schemas = schemasFromZod<Routes>",
    printArguments([{ kind: "object", members: routes }]),
    ";",
  ];
  const module: Doc = join(
    [hardline, hardline],
    [
      [
        jsDoc(header),
        hardline,
        `import { schemasFromZod } from ${quote(`${input.clientModule}/zod`)};`,
        hardline,
        `import { z } from ${quote(input.flavour === "mini" ? "zod/mini" : "zod")};`,
        hardline,
        `import type { Routes } from ${quote(input.routesModule)};`,
      ],
      ...declarations,
      schemasDoc,
      ...(channelMembers.length === 0
        ? []
        : [
            [
              jsDoc(
                "The WebSocket channels' message schemas, by path and side, which\n`channel()` reads through the client's `schemas` source.",
              ),
              hardline,
              "export const channelSchemas = ",
              printExpr({ kind: "object", members: channelMembers }),
              ";",
            ],
          ]),
    ],
  );
  return { code: `${printDoc(module)}\n`, warnings };
}
