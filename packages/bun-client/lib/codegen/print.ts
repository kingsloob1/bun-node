/**
 * The generator's TypeScript: a small type model ({@link TsType}) and its
 * printing as Prettier prints the same source (`./doc`), so a generated file
 * is formatted as it is written.
 *
 * Every object type prints expanded, one member per line, which Prettier
 * keeps (it never collapses an object written over several lines). The
 * layouts of unions, intersections, arrays, tuples and type arguments follow
 * Prettier's TypeScript printer; `__tests__/codegen/format.test.ts` runs
 * `bun fmt --check` over every golden file to hold them to it.
 */
import type { Doc } from "./doc";
import {
  align,
  group,
  hardline,
  hasHardline,
  ifBreak,
  indent,
  join,
  line,
  PRINT_WIDTH,
  softline,
} from "./doc";

/** One member of an object type. */
export interface TsMember {
  /** The property name (a status is a number). */
  readonly name: string | number;
  /** `true` for `name?:`. */
  readonly optional: boolean;
  /** The property's type. */
  readonly type: TsType;
  /** A JSDoc comment printed above the member. Default: none. */
  readonly doc?: string;
}

/** A TypeScript type, as the generator emits one. */
export type TsType =
  | {
      /** A keyword type. */
      readonly kind: "keyword";
      /** The keyword. */
      readonly name:
        | "string"
        | "number"
        | "boolean"
        | "null"
        | "undefined"
        | "unknown"
        | "never";
    }
  | {
      /** A literal type. */
      readonly kind: "literal";
      /** The literal's value. */
      readonly value: string | number | boolean;
    }
  | {
      /** A named type, with type arguments or none. */
      readonly kind: "ref";
      /** The name. */
      readonly name: string;
      /** Type arguments. Default: none. */
      readonly args?: readonly TsType[];
    }
  | {
      /** An object type. */
      readonly kind: "object";
      /** Its named members, in order. */
      readonly members: readonly TsMember[];
      /** An index signature's value type (`[key: string]: T`). Default: none. */
      readonly index?: TsType;
    }
  | {
      /** `T[]`. */
      readonly kind: "array";
      /** The element type. */
      readonly element: TsType;
    }
  | {
      /** A tuple, `[A, B, ...C[]]`. */
      readonly kind: "tuple";
      /** The fixed elements. */
      readonly elements: readonly TsType[];
      /** The rest element's item type. Default: none (a closed tuple). */
      readonly rest?: TsType;
    }
  | {
      /** `A | B`. */
      readonly kind: "union";
      /** The members, flattened (never a union). */
      readonly members: readonly TsType[];
    }
  | {
      /** `A & B`. */
      readonly kind: "intersection";
      /** The members, flattened (never an intersection). */
      readonly members: readonly TsType[];
    };

/** A keyword type. */
export function keyword(
  name: Extract<TsType, { kind: "keyword" }>["name"],
): TsType {
  return { kind: "keyword", name };
}

/** `unknown`. */
export const UNKNOWN: TsType = keyword("unknown");

/** `Record<never, never>`: the route map's "no keys" (plan §3.0). */
export const NO_KEYS: TsType = {
  kind: "ref",
  name: "Record",
  args: [keyword("never"), keyword("never")],
};

/** A stable identity for a type, to drop duplicate union members. */
function typeKey(type: TsType): string {
  return JSON.stringify(type);
}

/**
 * A union of `members`: nested unions flattened, `never` dropped, duplicates
 * dropped, `unknown` absorbing the rest; one member is itself.
 */
export function union(members: readonly TsType[]): TsType {
  const out: TsType[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const flat = member.kind === "union" ? member.members : [member];
    for (const item of flat) {
      if (item.kind === "keyword" && item.name === "unknown") return UNKNOWN;
      if (item.kind === "keyword" && item.name === "never") continue;
      const key = typeKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  if (out.length === 0) return keyword("never");
  if (out.length === 1) return out[0];
  return { kind: "union", members: out };
}

/** An intersection of `members`, flattened; `unknown` members dropped; one member is itself. */
export function intersection(members: readonly TsType[]): TsType {
  const out: TsType[] = [];
  for (const member of members) {
    for (const item of member.kind === "intersection"
      ? member.members
      : [member]) {
      if (item.kind === "keyword" && item.name === "unknown") continue;
      out.push(item);
    }
  }
  if (out.length === 0) return UNKNOWN;
  if (out.length === 1) return out[0];
  return { kind: "intersection", members: out };
}

/**
 * A string literal as Prettier writes it: double quotes, unless the text
 * holds more double quotes than single ones.
 */
export function quote(text: string): string {
  const doubles = (text.match(/"/g) ?? []).length;
  const singles = (text.match(/'/g) ?? []).length;
  const json = JSON.stringify(text);
  if (doubles <= singles) return json;
  // JSON.stringify escaped every `"`; in single quotes they need none, and
  // a `'` needs one.
  return `'${json.slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")}'`;
}

/** A property name as written: bare when it is a plain identifier or a number, else quoted. */
export function propertyKey(name: string | number): string {
  if (typeof name === "number") return String(name);
  return /^[A-Z_$][\w$]*$/i.test(name) ? name : quote(name);
}

/** A JSDoc comment for `text`, one line when it is one, as lines otherwise. */
export function jsDoc(text: string): Doc {
  const lines = text
    .replaceAll("*/", "*\\/")
    .split(/\r\n|\r|\n/)
    .map((part) => part.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  while (lines.length > 0 && lines[0] === "") lines.shift();
  if (lines.length === 0) return [];
  if (lines.length === 1) return `/** ${lines[0]} */`;
  return join(hardline, [
    "/**",
    ...lines.map((part) => (part === "" ? " *" : ` * ${part}`)),
    " */",
  ]);
}

/** Where a type is printed: what Prettier's layout decisions read off the parent. */
type Position =
  "plain" | "array" | "typeArgument" | "tuple" | "intersection" | "union";

/** `true` for an object type (Prettier's `isObjectType`). */
function isObject(type: TsType): boolean {
  return type.kind === "object";
}

/**
 * Prettier's `shouldHugType`: an object type, or a union of exactly one
 * object type and `null`s, prints hugging its parent's brackets.
 */
function shouldHug(type: TsType): boolean {
  if (isObject(type)) return true;
  if (type.kind !== "union") return false;
  const nulls = type.members.filter(
    (member) => member.kind === "keyword" && member.name === "null",
  ).length;
  return type.members.length - 1 === nulls && type.members.some(isObject);
}

/** An object type's members, one per line. */
function printObject(type: Extract<TsType, { kind: "object" }>): Doc {
  const members: Doc[] = type.members.map((member) => [
    member.doc === undefined ? [] : [jsDoc(member.doc), hardline],
    propertyKey(member.name),
    member.optional ? "?" : "",
    ": ",
    printType(member.type),
    ";",
  ]);
  if (type.index !== undefined)
    members.push(["[key: string]: ", printType(type.index), ";"]);
  if (members.length === 0) return "{}";
  return group([
    "{",
    indent([hardline, join(hardline, members)]),
    hardline,
    "}",
  ]);
}

/**
 * A union, laid out as Prettier lays one out: on the line when it fits;
 * else, where it can move (a property's value, a type alias, an array's
 * parentheses), flat on the next line when it fits there; else one member
 * per line, each led by `| `. An intersection member is parenthesized.
 */
function printUnion(
  type: Extract<TsType, { kind: "union" }>,
  position: Position,
): Doc {
  const parenthesized = position === "array" || position === "intersection";
  if (shouldHug(type)) {
    const hugged = join(
      " | ",
      type.members.map((member) => printType(member, "union")),
    );
    return parenthesized ? ["(", hugged, ")"] : hugged;
  }
  const inner = group([
    ifBreak("| "),
    join(
      [line, "| "],
      type.members.map((member) => align(2, printType(member, "union"))),
    ),
  ]);
  if (parenthesized)
    return group(["(", indent([softline, inner]), softline, ")"]);
  if (position === "tuple")
    return group([
      indent([ifBreak(["(", softline]), inner]),
      softline,
      ifBreak(")"),
    ]);
  if (position === "typeArgument") return inner;
  return group(indent([softline, inner]));
}

/** An intersection, laid out as Prettier's `printIntersectionType` does. */
function printIntersection(
  type: Extract<TsType, { kind: "intersection" }>,
): Doc {
  const parts: Doc[] = [];
  let wasIndented = false;
  type.members.forEach((member, index) => {
    const printed = printType(member, "intersection");
    if (index === 0) {
      parts.push(printed);
      return;
    }
    const previous = type.members[index - 1];
    if (!isObject(previous) && !isObject(member)) {
      parts.push(indent([" &", line, printed]));
    } else if (isObject(previous) && isObject(member)) {
      parts.push([" & ", wasIndented ? indent(printed) : printed]);
    } else {
      if (index > 1) wasIndented = true;
      parts.push(" & ", index > 1 ? indent(printed) : printed);
    }
  });
  return group(parts);
}

/** Type arguments, `<A, B>`; one hugging argument stays on the line. */
function printArguments(args: readonly TsType[]): Doc {
  if (args.length === 1 && shouldHug(args[0]))
    return ["<", printType(args[0], "typeArgument"), ">"];
  return group([
    "<",
    indent([
      softline,
      join(
        [",", line],
        args.map((arg) => printType(arg, "typeArgument")),
      ),
    ]),
    softline,
    ">",
  ]);
}

/** A type as Prettier prints it in `position`. */
export function printType(type: TsType, position: Position = "plain"): Doc {
  switch (type.kind) {
    case "keyword":
      return type.name;
    case "literal":
      return typeof type.value === "string"
        ? quote(type.value)
        : String(type.value);
    case "ref":
      return type.args === undefined || type.args.length === 0
        ? type.name
        : [type.name, printArguments(type.args)];
    case "object":
      return printObject(type);
    case "array": {
      return [printType(type.element, "array"), "[]"];
    }
    case "tuple": {
      const count = type.elements.length + (type.rest === undefined ? 0 : 1);
      const elements: Doc[] = type.elements.map((element) =>
        printType(element, count > 1 ? "tuple" : "typeArgument"),
      );
      if (type.rest !== undefined)
        elements.push([
          "...",
          printType({ kind: "array", element: type.rest }),
        ]);
      if (elements.length === 0) return "[]";
      return group([
        "[",
        indent([softline, join([",", line], elements)]),
        ifBreak(","),
        softline,
        "]",
      ]);
    }
    case "union":
      return printUnion(type, position);
    case "intersection": {
      const printed = printIntersection(type);
      return position === "array" || position === "union"
        ? ["(", printed, ")"]
        : printed;
    }
  }
}

/** `doc` printed flat: every group flat, every line a space or nothing. */
function printFlat(doc: Doc): string {
  if (typeof doc === "string") return doc;
  if (Array.isArray(doc))
    return (doc as readonly Doc[]).map(printFlat).join("");
  const command = doc as Exclude<Doc, string | readonly Doc[]>;
  switch (command.kind) {
    case "group":
    case "indent":
      return printFlat(command.contents);
    case "ifBreak":
      return printFlat(command.flat);
    case "line":
      return command.soft ? "" : " ";
  }
}

/** The width of `doc` printed flat, or `undefined` when it cannot print flat. */
function flatWidth(doc: Doc): number | undefined {
  if (hasHardline(doc)) return undefined;
  return printFlat(doc).length;
}

/**
 * `export type Name = <type>;`, with Prettier's assignment layouts: on the
 * line when it fits; flat on the next line when that fits; else the type's
 * own broken layout (a union then starts its own line).
 */
export function printTypeAlias(name: string, type: TsType): Doc {
  const head = `export type ${name} =`;
  const rhs = printType(type);
  const width = type.kind === "union" ? undefined : flatWidth(rhs);
  if (width !== undefined && head.length + 1 + width + 1 > PRINT_WIDTH) {
    if (2 + width + 1 <= PRINT_WIDTH)
      return [head, indent([hardline, rhs]), ";"];
  }
  return [head, " ", rhs, ";"];
}
