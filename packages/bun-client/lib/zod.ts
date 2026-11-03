/**
 * `@kingsleyweb/bun-client/zod` (typed-client plan §5.2, §10.1): the glue
 * between zod schemas and the client's built-in validation. The module
 * `bun-client generate --zod` writes calls {@link schemasFromZod}; so may a
 * hand-written module of the server's own zod schemas.
 *
 * zod is an **optional peer** (`^4`): this entry imports only its types, and
 * nothing in the `.` entry imports this one. An app reaches zod through the
 * schema module it loads lazily (`schemas: () => import("./api.zod.gen")`),
 * so a bundle with validation off carries neither.
 *
 * Both flavours work, `zod/mini` (the generator's default) and classic
 * `zod`: every zod 4 schema is a Standard Schema, which is all the client
 * runs. `zod/mini` reports `Invalid input` for every issue until a locale is
 * loaded (`z.config(z.locales.en())`); the paths are there either way.
 */
import type { $ZodType } from "zod/v4/core";
import type { SchemaSource } from "./types";

/** The request parts a route's schemas may name. */
const PARTS = ["params", "query", "headers", "body", "files"] as const;

/** Whether `value` is a zod 4 schema: a Standard Schema whose vendor is zod. */
function isZodSchema(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const props = (value as { "~standard"?: { vendor?: unknown } })["~standard"];
  return (
    typeof props === "object" &&
    props !== null &&
    props.vendor === "zod" &&
    typeof (props as { validate?: unknown }).validate === "function"
  );
}

/**
 * Types and checks a route-keyed map of zod schemas as the client's built-in
 * schemas: export its result as `schemas` from a module, and give the client
 * that module (`schemas: () => import("./api.zod.gen")`).
 *
 * ```ts
 * export const schemas = schemasFromZod<Routes>({
 *   "GET /users/:id": {
 *     params: z.looseObject({ id: z.string() }),
 *     responses: { 200: User, 404: Problem },
 *   },
 * });
 * ```
 *
 * @typeParam R The route map: a key it does not have is a compile error.
 * @param schemas Per route key, each request part's schema and the response
 *   bodies' by status (`null`: no body).
 * @returns The same object, typed for `SchemaSource<R>`'s `schemas`.
 * @throws TypeError when a key is not a route key (`"VERB /path"`) or a
 *   value is not a zod 4 schema, naming where.
 */
export function schemasFromZod<R>(schemas: {
  readonly [K in keyof R]?: {
    /** The path parameters, as a call gives them. */
    readonly params?: $ZodType;
    /** The query object, before it is serialised. */
    readonly query?: $ZodType;
    /** The request headers, by lower-case name. */
    readonly headers?: $ZodType;
    /** The request body (JSON, or a form's fields), before it is serialised. */
    readonly body?: $ZodType;
    /** A multipart body's files, by field (each a `File`, or a list of them). */
    readonly files?: $ZodType;
    /** Response bodies by status (an NDJSON stream's: one line); `null`: no body. */
    readonly responses?: { readonly [status: number]: $ZodType | null };
  };
}): SchemaSource<R>["schemas"] {
  for (const [key, route] of Object.entries(
    schemas as Readonly<Record<string, Record<string, unknown> | undefined>>,
  )) {
    if (!/^[A-Z]+ \//.test(key))
      throw new TypeError(
        `schemasFromZod(): "${key}" is not a route key ("VERB /path")`,
      );
    if (route === undefined) continue;
    for (const part of PARTS) {
      if (route[part] !== undefined && !isZodSchema(route[part]))
        throw new TypeError(
          `schemasFromZod(): ${key} ${part} is not a zod 4 schema`,
        );
    }
    const responses = (route.responses ?? {}) as Record<string, unknown>;
    for (const [status, schema] of Object.entries(responses)) {
      if (schema !== null && !isZodSchema(schema))
        throw new TypeError(
          `schemasFromZod(): ${key} response ${status} is not a zod 4 schema (or null)`,
        );
    }
  }
  return schemas;
}
