/**
 * The validation types (plan §5.4, §6.2, §16, PR-C4): `ValidationError` and
 * its issues, the configuration at each level, `SchemaSource`, and
 * `schemasFromZod` keyed by the route map. Each `@ts-expect-error` is a
 * negative control: it must error, and it must be there (an unused one
 * fails the check too).
 *
 * Checked by `bun run check`, not by `bun test`; nothing here runs.
 */
import type {
  ClientError,
  FailureMode,
  PartValidation,
  RouteSchemas,
  SchemaSource,
  ValidationConfig,
  ValidationErrorIssue,
} from "../lib/index";
import { z as mini } from "zod/mini";
import { z } from "zod";
import { createClient, ValidationError } from "../lib/index";
import { schemasFromZod } from "../lib/zod";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

interface Routes {
  "GET /users/:id": {
    params: { id: string };
    responses: { 200: { id: string }; 404: { code: string } };
  };
  "POST /users": {
    body: { name: string };
    responses: { 201: { id: string } };
  };
}

/* ValidationError. */

declare const error: ValidationError;
export type _Direction = Expect<
  Equal<typeof error.direction, "request" | "response">
>;
export type _Status = Expect<Equal<typeof error.status, number | undefined>>;
export type _Issues = Expect<
  Equal<typeof error.issues, readonly ValidationErrorIssue[]>
>;
export type _Target = Expect<
  Equal<
    ValidationErrorIssue["target"],
    "params" | "query" | "body" | "headers" | "response"
  >
>;
export type _Source = Expect<
  Equal<ValidationErrorIssue["source"], "builtin" | "custom">
>;
export type _Fields = Expect<
  Equal<
    Pick<ValidationErrorIssue, "message" | "path" | "key">,
    { message: string; path: string; key?: string }
  >
>;
export type _Key = Expect<Equal<typeof error.key, string | undefined>>;
const _base: ClientError = error;
void _base;
// @ts-expect-error -- read-only
error.direction = "request";
// @ts-expect-error -- not a direction
export const _wrongDirection: ValidationError["direction"] = "both";
// @ts-expect-error -- the issues are read-only
error.issues.push({ target: "body", message: "", path: "", source: "custom" });
// @ts-expect-error -- not a target
export const _wrongTarget: ValidationErrorIssue["target"] = "cookies";
export const made = new ValidationError("GET /x", "response", [], 500);

/* The configuration. */

export const _modes: FailureMode[] = [
  "throw",
  "warn",
  (e) => {
    const _e: ValidationError = e;
    void _e;
  },
];
// @ts-expect-error -- not a failure mode
export const _wrongMode: FailureMode = "drop";
export const _part: PartValidation[] = [
  true,
  false,
  { enabled: false },
  { custom: z.string(), replace: true },
  { custom: mini.string() },
];
// @ts-expect-error -- a custom schema is a Standard Schema
export const _notSchema: PartValidation = { custom: { parse: () => 1 } };
export const _config: ValidationConfig = {
  request: true,
  body: { custom: z.object({ name: z.string() }) },
  response: { 201: { custom: z.object({ id: z.string() }), replace: true } },
  onFailure: { request: "warn", response: (e) => void e.issues },
};
// @ts-expect-error -- `response` per status takes PartValidation entries
export const _wrongResponse: ValidationConfig = { response: { 200: "on" } };

createClient<Routes>({
  mode: "production",
  schemas: () => Promise.resolve({ schemas: {} }),
  validate: false,
  routes: {
    "GET /users/:id": { validate: { response: true } },
    "POST /users": { validate: false },
  },
});
createClient<Routes>({
  // @ts-expect-error -- not a mode
  mode: "staging",
});
void createClient<Routes>().get("/users/:id", {
  params: { id: "1" },
  validate: { params: { custom: z.object({ id: z.string() }) } },
});

/* SchemaSource and schemasFromZod. */

export const source: SchemaSource<Routes> = {
  schemas: {
    "GET /users/:id": {
      params: z.object({ id: z.string() }),
      responses: { 200: z.object({ id: z.string() }), 404: null },
    },
  },
};
export const _wrongKey: SchemaSource<Routes> = {
  schemas: {
    // @ts-expect-error -- not a route of the map
    "GET /nope": {},
  },
};
export const _route: RouteSchemas = { body: mini.string() };
// @ts-expect-error -- a response schema is a Standard Schema or null
export const _wrongRoute: RouteSchemas = { responses: { 200: "string" } };

export const generated = schemasFromZod<Routes>({
  "POST /users": {
    body: mini.looseObject({ name: mini.string() }),
    responses: { 201: z.object({ id: z.string() }) },
  },
});
export type _Generated = Expect<
  Equal<typeof generated, SchemaSource<Routes>["schemas"]>
>;
schemasFromZod<Routes>({
  // @ts-expect-error -- not a route of the map
  "DELETE /users": {},
});
schemasFromZod<Routes>({
  "POST /users": {
    // @ts-expect-error -- a zod schema, not any Standard Schema
    body: {
      "~standard": { version: 1, vendor: "x", validate: () => ({ value: 1 }) },
    },
  },
});
