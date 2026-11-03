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
    "params" | "query" | "body" | "headers" | "files" | "response"
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

/* A BYO response schema's output types `data` (§5.4, at the call level). */

/** A BYO schema that parses the wire's string into a `Date`. */
const WithDate = z.object({
  id: z.string(),
  at: z.string().transform((value) => new Date(value)),
});
interface Timed {
  "GET /events/:id": {
    params: { id: string };
    responses: {
      200: { id: string; at: string };
      404: { code: string };
    };
  };
  "GET /export": {
    responses: { 200: AsyncIterable<{ id: string; at: string }> };
  };
  "GET /file": { responses: { 200: Blob } };
}
const timed = createClient<Timed>();
/** A result's success body. */
type DataOf<R> = R extends { ok: true; data: infer D } ? D : never;
/** A result's error body at status `S`. */
type ErrorOf<R, S> = R extends { ok: false; status: S; error: infer B }
  ? B
  : never;

const byo = await timed.get("/events/:id", {
  params: { id: "1" },
  validate: { response: { 200: { custom: WithDate } } },
});
export type _ByoData = Expect<
  Equal<DataOf<typeof byo>, { id: string; at: Date }>
>;
// The other statuses keep their wire bodies.
export type _ByoError = Expect<
  Equal<ErrorOf<typeof byo, 404>, { code: string }>
>;
if (byo.ok) {
  // @ts-expect-error -- negative control: no longer the wire's string
  byo.data.at.toUpperCase();
}

// Control: without the BYO schema, `data` is the wire body.
export const plain = await timed.get("/events/:id", { params: { id: "1" } });
export type _PlainData = Expect<
  Equal<DataOf<typeof plain>, { id: string; at: string }>
>;

// A status key written as a string, on an error status, through `request`.
export const byError = await timed.request("GET /events/:id", {
  params: { id: "1" },
  validate: {
    response: { "404": { custom: z.object({ code: z.literal("NOT_FOUND") }) } },
  },
});
export type _ByError = Expect<
  Equal<ErrorOf<typeof byError, 404>, { code: "NOT_FOUND" }>
>;

// throwOnError: the success data is the output.
export const thrown = await timed.get("/events/:id", {
  params: { id: "1" },
  throwOnError: true,
  validate: { response: { 200: { custom: WithDate, replace: true } } },
});
export type _Thrown = Expect<Equal<typeof thrown, { id: string; at: Date }>>;

// Turned off: `false` for the status, the whole response, or the whole call.
export const offStatus = await timed.get("/events/:id", {
  params: { id: "1" },
  throwOnError: true,
  validate: { response: { 200: false } },
});
export type _OffStatus = Expect<
  Equal<typeof offStatus, { id: string; at: string }>
>;
export const offResponse = await timed.get("/events/:id", {
  params: { id: "1" },
  throwOnError: true,
  validate: { response: false },
});
export type _OffResponse = Expect<
  Equal<typeof offResponse, { id: string; at: string }>
>;
export const offAll = await timed.get("/events/:id", {
  params: { id: "1" },
  throwOnError: true,
  validate: false,
});
export type _OffAll = Expect<Equal<typeof offAll, { id: string; at: string }>>;
// A widened configuration says nothing about a status: the wire body.
declare const someConfig: ValidationConfig;
export const widened = await timed.get("/events/:id", {
  params: { id: "1" },
  throwOnError: true,
  validate: someConfig,
});
export type _Widened = Expect<
  Equal<typeof widened, { id: string; at: string }>
>;

// A streamed status yields the outputs; a download read as a stream is unread.
export const streamed = await timed.get("/export", {
  throwOnError: true,
  validate: { response: { 200: { custom: WithDate } } },
});
export type _Streamed = Expect<
  Equal<typeof streamed, AsyncIterable<{ id: string; at: Date }>>
>;
export const unread = await timed.get("/file", {
  throwOnError: true,
  as: "stream",
  validate: { response: { 200: { custom: z.instanceof(Blob) } } },
});
export type _Unread = Expect<Equal<typeof unread, ReadableStream<Uint8Array>>>;

// A hook keeps its contextual type beside the captured response schemas.
export const hooked = await timed.get("/events/:id", {
  params: { id: "1" },
  throwOnError: true,
  validate: {
    response: { 200: { custom: WithDate } },
    onFailure: (e) => {
      const _e: ValidationError = e;
      void _e;
    },
  },
});
export type _Hooked = Expect<Equal<typeof hooked, { id: string; at: Date }>>;
