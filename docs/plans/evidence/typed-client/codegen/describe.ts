/**
 * The server-side half of the route model, as a spike OUTSIDE bun-common.
 *
 * `dv()` is `validate()` plus what api-docs-generation.md Decision 2 and 4
 * propose to add to bun-common itself: the schemas and the declared responses
 * attached to the returned middleware as non-enumerable properties, so a walk
 * over `router.routes()` can find them at runtime.
 */
import type { BunRouter } from "@kingsleyweb/bun-common";
import { validate } from "@kingsleyweb/bun-common";
import type { ValidatedShapeFor, ValidationSchemas, ValidatorMiddleware } from "@kingsleyweb/bun-common";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common/lib/types/standardSchema.ts";

/** Status → schema, or null for a status without a body. */
export type ResponseSchemas = Record<number, StandardSchemaV1 | null>;
type InputsOf<S> = { [K in keyof S]: S[K] extends StandardSchemaV1 ? StandardSchemaV1.InferInput<S[K]> : never };
type OutputsOf<R> = { [K in keyof R]: R[K] extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<R[K]> : null };

const SCHEMAS = "__schemas";
const RESPONSES = "__responses";

export function dv<const S extends ValidationSchemas, const R extends ResponseSchemas>(
  schemas: S,
  responses: R,
): ValidatorMiddleware<ValidatedShapeFor<S> & { input: InputsOf<S>; responses: OutputsOf<R> }> {
  const mw = validate(schemas);
  Object.defineProperty(mw, SCHEMAS, { value: schemas, enumerable: false });
  Object.defineProperty(mw, RESPONSES, { value: responses, enumerable: false });
  return mw as never;
}

/** JSON Schema, loosely. */
export type JsonSchema = Record<string, unknown>;

/** One route of the model: what docs, the client generator and the live sync all read. */
export interface ModelRoute {
  /** `"GET /users/:id"`: the key the client map uses. */
  key: string;
  method: string;
  /** Express syntax, mounts joined. */
  path: string;
  /** Path parameter names, in order. */
  params: string[];
  operationId: string;
  /** JSON Schemas: params, query (output: they cross as strings, coerced), body (input). */
  request: { params?: JsonSchema; query?: JsonSchema; body?: JsonSchema };
  /** status → JSON Schema of the OUTPUT, or null for no body. */
  responses: Record<string, JsonSchema | null>;
  /** Why something could not be described, if anything. */
  warnings: string[];
}
/** The whole model. */
export interface RouteModel {
  version: 1;
  /** sha-256 of the canonical JSON of `routes`: the change detector. */
  hash: string;
  routes: ModelRoute[];
}

export function toJson(schema: StandardSchemaV1, io: "input" | "output", warnings: string[], where: string): JsonSchema {
  const js = (schema["~standard"] as { jsonSchema?: Record<"input" | "output", (o: object) => JsonSchema> }).jsonSchema;
  if (!js) {
    warnings.push(`${where}: vendor ${schema["~standard"].vendor} has no ~standard.jsonSchema`);
    return {};
  }
  try {
    return js[io]({ target: "draft-2020-12" });
  } catch (error) {
    // zod: a z.date() is "unrepresentable". Fall back to `any` and say so.
    warnings.push(`${where}: ${(error as Error).message}; described as unknown`);
    return js[io]({ target: "draft-2020-12", libraryOptions: { unrepresentable: "any" } });
  }
}

/**
 * params and query cross as strings and are coerced, so a client sends the
 * OUTPUT's value types (z.coerce.number() has input `unknown`). But a key with
 * a default is required in the output and optional in the input: the client
 * may omit it. So: the input's `required`, the output's `properties`.
 */
export function keysInValuesOut(schema: StandardSchemaV1, warnings: string[], where: string): JsonSchema {
  const out = toJson(schema, "output", warnings, where);
  const input = toJson(schema, "input", [], where);
  return { ...out, required: input.required ?? [] };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function operationIdFor(method: string, path: string): string {
  const parts = path.split("/").filter(Boolean).map(p => p.startsWith(":") ? `By${p[1]!.toUpperCase()}${p.slice(2).replace(/\W/g, "")}` : p.replace(/\W+(.)/g, (_m, c: string) => c.toUpperCase()));
  return method.toLowerCase() + parts.map(p => p[0]!.toUpperCase() + p.slice(1)).join("");
}

/** Builds the model by walking the router's routes and their validators. */
export function buildModel(router: BunRouter): RouteModel {
  const routes: ModelRoute[] = [];
  for (const route of router.routes()) {
    if (!route.path) continue; // use() middleware layers carry no path; endpoints always do
    const method = route.method ? route.method.toUpperCase() : "ALL"; // all() carries no method
    const warnings: string[] = [];
    const request: ModelRoute["request"] = {};
    let responses: ModelRoute["responses"] = {};
    let described = false;
    for (const cb of route.callbacks as Record<string, unknown>[]) {
      const schemas = cb[SCHEMAS] as ValidationSchemas | undefined;
      if (!schemas) continue;
      described = true;
      const where = `${method} ${route.path}`;
      if (schemas.params) request.params = keysInValuesOut(schemas.params, warnings, `${where} params`);
      if (schemas.query) request.query = keysInValuesOut(schemas.query, warnings, `${where} query`);
      if (schemas.body) request.body = toJson(schemas.body, "input", warnings, `${where} body`);
      const rs = cb[RESPONSES] as ResponseSchemas | undefined;
      responses = {};
      for (const [status, s] of Object.entries(rs ?? {})) responses[status] = s ? toJson(s, "output", warnings, `${where} ${status}`) : null;
    }
    if (!described) warnings.push("no validator: request and response untyped");
    routes.push({ key: `${method} ${route.path}`, method, path: route.path, params: [...route.params], operationId: route.name || operationIdFor(method, route.path), request, responses, warnings });
  }
  routes.sort((a, b) => a.key.localeCompare(b.key));
  const hash = new Bun.CryptoHasher("sha256").update(canonical(routes)).digest("hex").slice(0, 16);
  return { version: 1, hash, routes };
}
