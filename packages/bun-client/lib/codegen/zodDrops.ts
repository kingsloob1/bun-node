/**
 * What a server's zod schemas hold that their JSON Schema cannot (typed-client
 * plan §5.3), for the warnings `bun-client generate --module` copies into the
 * generated file: a refinement (`.refine()`, `.superRefine()`, a `.check()`
 * function) is dropped from the document silently, and a `z.date()`, a
 * `z.custom()` or a transform on the documented side becomes `{}`. A client
 * typed or checked from the document (`--zod`) is then weaker than the
 * server, and nothing in the document says so; only the zod objects do.
 *
 * **Structural.** It reads zod 4's own description of a schema
 * (`schema._zod.def`: its `type`, its `checks`, its children) and imports
 * nothing of zod, so the codegen entry stays free of it.
 *
 * Only the document's side of a schema is walked: a `pipe` (what
 * `.transform()` and `z.preprocess()` build) by its input for a request or a
 * response documented from the input (bun-common's default), by its output
 * under `responseOutput: "parsed"`.
 */
import type { CodegenWarning } from "./openapi";
import { isRecord } from "./schema";

/** Which side of a schema the document describes. */
export type DocumentedSide = "input" | "output";

/** What JSON Schema cannot carry, by kind. */
export type ZodDrop = "refinement" | "date" | "custom" | "transform";

/** One drop: what, and where in the value (`""` for the value itself). */
export interface ZodDropAt {
  /** What is dropped. */
  readonly kind: ZodDrop;
  /** Where: dotted keys, `[]` for an array's items, `[n]` a tuple's, `*` a record's values. */
  readonly path: string;
}

/** A zod 4 schema's description, as far as the walk reads it. */
interface ZodDef {
  /** The schema's kind: `"object"`, `"pipe"`, `"date"`, … */
  readonly type?: unknown;
  /** Its checks; a refinement is one whose own `check` is `"custom"`. */
  readonly checks?: unknown;
  /** The rest: children by kind. */
  readonly [field: string]: unknown;
}

/** A zod 4 schema's `_zod.def`; `undefined` for anything else. */
function defOf(value: unknown): ZodDef | undefined {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  )
    return undefined;
  const props = (value as { "~standard"?: { vendor?: unknown } })["~standard"];
  const internals = (value as { _zod?: { def?: unknown } })._zod;
  if (props?.vendor !== "zod" || !isRecord(internals?.def)) return undefined;
  return internals.def;
}

/** A schema's checks that are refinements: their own `def.check` is `"custom"`. */
function refinements(def: ZodDef): number {
  if (!Array.isArray(def.checks)) return 0;
  return def.checks.filter(
    (check) =>
      (check as { _zod?: { def?: { check?: unknown } } } | null)?._zod?.def
        ?.check === "custom",
  ).length;
}

/** The kinds of schema JSON Schema has nothing for (zod's `unrepresentable`), as drops. */
const KINDS: Readonly<Record<string, ZodDrop>> = {
  date: "date",
  custom: "custom",
  transform: "transform",
};

/** Children reached through `innerType` (wrappers that do not move the path). */
const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch",
  "success",
  "promise",
]);

/**
 * The drops in one zod schema, each node once per call (`seen`, shared by a
 * caller that wants each node reported once across schemas).
 *
 * @param schema The schema; anything that is not a zod 4 schema has none.
 * @param side   The side the document describes.
 * @param seen   Nodes already walked; their drops are not reported again.
 */
export function zodDrops(
  schema: unknown,
  side: DocumentedSide,
  seen: WeakSet<object> = new WeakSet(),
): ZodDropAt[] {
  const found: ZodDropAt[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    const def = defOf(value);
    if (def === undefined || depth > 64 || seen.has(value as object)) return;
    seen.add(value as object);
    if (refinements(def) > 0) found.push({ kind: "refinement", path });
    const kind = typeof def.type === "string" ? def.type : "";
    if (Object.hasOwn(KINDS, kind)) {
      found.push({ kind: KINDS[kind], path });
      return;
    }
    const at = (segment: string): string =>
      path === "" ? segment.replace(/^\./, "") : `${path}${segment}`;
    const next = depth + 1;
    if (WRAPPERS.has(kind)) walk(def.innerType, path, next);
    else if (kind === "object" && isRecord(def.shape)) {
      for (const [name, child] of Object.entries(def.shape))
        walk(child, at(`.${name}`), next);
      walk(def.catchall, at(".*"), next);
    } else if (kind === "array" || kind === "set")
      walk(def.element ?? def.valueType, at("[]"), next);
    else if (kind === "record" || kind === "map")
      walk(def.valueType, at(".*"), next);
    else if (kind === "tuple") {
      if (Array.isArray(def.items))
        def.items.forEach((item, index) => walk(item, at(`[${index}]`), next));
      walk(def.rest, at("[]"), next);
    } else if (kind === "union" && Array.isArray(def.options)) {
      for (const option of def.options) walk(option, path, next);
    } else if (kind === "intersection") {
      walk(def.left, path, next);
      walk(def.right, path, next);
    } else if (kind === "pipe") {
      walk(side === "input" ? def.in : def.out, path, next);
    } else if (kind === "lazy" && typeof def.getter === "function") {
      walk((def.getter as () => unknown)(), path, next);
    }
  };
  walk(schema, "", 0);
  return found;
}

/** What each kind of drop is, and does to the generated file, for its warning. */
const CONSEQUENCE: Readonly<Record<ZodDrop, string>> = {
  refinement:
    "a refinement (`.refine()`, `.superRefine()`) is not in the document, so a schema generated from it (`--zod`) does not run it",
  date: "`z.date()` has no JSON Schema, so it is typed `unknown` and not checked (declare the wire type, `z.iso.datetime()`)",
  custom:
    "`z.custom()` has no JSON Schema, so it is typed `unknown` and not checked",
  transform:
    "a transform on the documented side has no JSON Schema, so it is typed `unknown` and not checked",
};

/**
 * One route part's drops as warnings, one per kind, naming every path (the
 * root as "the value itself").
 *
 * @param at    Where, as a generator warning names it (`"GET /users/:id body"`).
 * @param drops The part's drops.
 */
export function dropWarnings(
  at: string,
  drops: readonly ZodDropAt[],
): CodegenWarning[] {
  const byKind = new Map<ZodDrop, string[]>();
  for (const drop of drops) {
    const paths = byKind.get(drop.kind) ?? [];
    const path = drop.path === "" ? "the value itself" : `\`${drop.path}\``;
    if (!paths.includes(path)) paths.push(path);
    byKind.set(drop.kind, paths);
  }
  return [...byKind].map(([kind, paths]) => ({
    at,
    message: `at ${paths.join(", ")}: ${CONSEQUENCE[kind]}`,
  }));
}

/** One schema row of a route's described contract (bun-contract's `ContractEntry`), as read here. */
interface ContractRow {
  /** `"inbound"` (the request) or `"outbound"` (a response). */
  readonly side?: unknown;
  /** The part: `"body"`, `"query"`, `"headers"`, … */
  readonly part?: unknown;
  /** The status, on a response row. */
  readonly key?: unknown;
  /** The schema (a `chunks()` row's is the chunk schema's holder). */
  readonly schema?: unknown;
  /** An SSE body's event rows. */
  readonly nested?: unknown;
}

/** One route of bun-common's `listRoutes`, as read here. */
export interface ListedRouteLike {
  /** `"GET /users/:id"`. */
  readonly key: string;
  /** Its described contract. */
  readonly contract?: {
    /** The contract's transport: only `"http"` routes are documented. */
    readonly transport?: unknown;
    /** Its rows. */
    readonly entries?: unknown;
  };
  /** `"parsed"`: responses are documented from their output side. */
  readonly responseOutput?: unknown;
}

/** The request parts a client sends; cookies and the rest are not the client's. */
const CLIENT_PARTS = new Set(["params", "query", "headers", "body"]);

/**
 * The drops of every documented route, as warnings: each zod node reported
 * once, at the first route part (in `listRoutes`' order) it is met in.
 *
 * @param routes     bun-common's `listRoutes(router)`.
 * @param documented The route keys the document holds (its
 *   `x-bun-route-key`s); a route not among them is skipped.
 */
export function routeDropWarnings(
  routes: readonly ListedRouteLike[],
  documented: ReadonlySet<string>,
): CodegenWarning[] {
  const warnings: CodegenWarning[] = [];
  const seen = new WeakSet<object>();
  const visit = (at: string, schema: unknown, side: DocumentedSide): void => {
    // A `chunks()` declaration holds its line's schema.
    const target =
      defOf(schema) === undefined && isRecord(schema) ? schema.chunk : schema;
    warnings.push(...dropWarnings(at, zodDrops(target, side, seen)));
  };
  for (const route of routes) {
    if (!documented.has(route.key) || route.contract?.transport !== "http")
      continue;
    const rows = Array.isArray(route.contract.entries)
      ? (route.contract.entries as ContractRow[])
      : [];
    const output = route.responseOutput === "parsed" ? "output" : "input";
    for (const row of rows) {
      const part = typeof row.part === "string" ? row.part : "";
      if (row.side === "inbound") {
        if (CLIENT_PARTS.has(part))
          visit(`${route.key} ${part}`, row.schema, "input");
        continue;
      }
      if (row.side !== "outbound") continue;
      const at = `${route.key} response ${String(row.key)}${part === "body" ? "" : ` ${part}`}`;
      if (part === "body" || part === "headers") visit(at, row.schema, output);
      if (Array.isArray(row.nested))
        for (const event of row.nested as ContractRow[])
          visit(
            `${at} event "${String(event.key)}" ${String(event.part)}`,
            event.schema,
            output,
          );
    }
  }
  return warnings;
}
