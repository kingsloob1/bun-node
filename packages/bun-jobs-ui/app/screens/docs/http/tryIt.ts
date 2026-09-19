import type { HttpMethod, QueryScalar, QueryValue } from "../../../api/client";
import type { SchemaRoot } from "../schema/resolve";
import type { DocOperation, DocParameter } from "./model";
import {
  CSRF_HEADER_VALUE,
  segment,
  serializeQuery,
} from "../../../api/client";
import { JSON_METHODS, MUTATING_METHODS } from "../../../api/contract";
import { declaredTypes, deref, isSchemaObject } from "../schema/resolve";
import { schemaSkeleton } from "../schema/skeleton";

/**
 * The try-it panel's logic: which input each parameter gets, the request a
 * filled form makes, whether the panel may send it at all, and the curl and
 * fetch() snippets of that exact request. The request goes through the
 * app's own `ApiClient`, so the headers here restate its rules (for the
 * snippets) rather than decide them.
 */

/** Methods the app's client can send. */
const CLIENT_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** Action verbs whose try-it needs a typed confirmation: they delete or discard work. */
const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  "remove",
  "drain",
  "clean",
  "kill",
]);

/** The input a parameter is edited with. */
export type InputKind =
  | { kind: "text" }
  | { kind: "number"; integer: boolean; min?: number; max?: number }
  | { kind: "boolean" }
  | { kind: "enum"; options: string[] }
  | { kind: "list"; item: "text" | "integer" | "number" }
  | { kind: "enum-list"; options: string[] };

/** A form value: text for scalars and comma lists, the ticked options for an enum list. */
export type FieldValue = string | readonly string[];

/** What the form holds, keyed by {@link paramKey}. */
export type TryItValues = Readonly<Record<string, FieldValue>>;

/** A parameter's form key: `path:queue`, `query:state`. */
export function paramKey(parameter: Pick<DocParameter, "in" | "name">): string {
  return `${parameter.in}:${parameter.name}`;
}

/** The scalar item type of a schema (`$ref`s followed). */
function scalarType(schema: unknown, root: SchemaRoot): string | undefined {
  const node = deref(schema, root).schema;
  if (!isSchemaObject(node)) {
    return undefined;
  }
  return declaredTypes(node).find((type) => type !== "null");
}

/** The string values of an enum schema, when it is one. */
function enumOptions(schema: unknown, root: SchemaRoot): string[] | undefined {
  const node = deref(schema, root).schema;
  if (!isSchemaObject(node) || !Array.isArray(node.enum)) {
    return undefined;
  }
  return node.enum
    .filter((value) => value !== null)
    .map((value) => String(value));
}

/** How a parameter is edited, from its schema. */
export function inputKind(
  parameter: DocParameter,
  root: SchemaRoot,
): InputKind {
  const node = deref(parameter.schema, root).schema;
  const schema = isSchemaObject(node) ? node : {};
  const type = scalarType(schema, root);
  if (type === "array") {
    const options = enumOptions(schema.items, root);
    if (options) {
      return { kind: "enum-list", options };
    }
    const item = scalarType(schema.items, root);
    return {
      kind: "list",
      item: item === "integer" || item === "number" ? item : "text",
    };
  }
  const options = enumOptions(schema, root);
  if (options) {
    return { kind: "enum", options };
  }
  if (type === "boolean") {
    return { kind: "boolean" };
  }
  if (type === "integer" || type === "number") {
    return {
      kind: "number",
      integer: type === "integer",
      min: typeof schema.minimum === "number" ? schema.minimum : undefined,
      max: typeof schema.maximum === "number" ? schema.maximum : undefined,
    };
  }
  return { kind: "text" };
}

/** The parameters the form edits: path and query. Header parameters are the client's to send. */
export function formParameters(operation: DocOperation): DocParameter[] {
  return operation.parameters.filter(
    (parameter) => parameter.in === "path" || parameter.in === "query",
  );
}

/** The schema of the JSON body, when the operation takes one worth editing. */
export function bodySchema(operation: DocOperation): unknown {
  const json = operation.requestBody?.content.find(
    (media) => media.contentType === "application/json",
  );
  const schema = json?.schema;
  // The API's bodiless POSTs declare a body only to require the media type;
  // its schema is a bare description ("Ignored. Send no body, or `{}`.").
  if (
    !isSchemaObject(schema) ||
    Object.keys(schema).every(
      (key) => key === "description" || key.startsWith("x-"),
    )
  ) {
    return undefined;
  }
  return schema;
}

/** The editor's starting text: the body schema's required skeleton, or `""`. */
export function initialBodyText(
  operation: DocOperation,
  root: SchemaRoot,
): string {
  const schema = bodySchema(operation);
  return schema === undefined
    ? ""
    : JSON.stringify(schemaSkeleton(schema, root), null, 2);
}

/** A parameter's form value as the query takes it, or an error message. */
function coerce(
  parameter: DocParameter,
  kind: InputKind,
  value: FieldValue | undefined,
): { value: QueryValue } | { error: string } {
  if (kind.kind === "enum-list") {
    const picked = Array.isArray(value) ? value : [];
    return { value: picked.length > 0 ? [...picked] : undefined };
  }
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") {
    return parameter.required
      ? { error: `${parameter.name} is required` }
      : { value: undefined };
  }
  switch (kind.kind) {
    case "number": {
      const number = Number(raw);
      if (
        !Number.isFinite(number) ||
        (kind.integer && !Number.isInteger(number))
      ) {
        return {
          error: `${parameter.name} must be ${kind.integer ? "an integer" : "a number"}`,
        };
      }
      return { value: number };
    }
    case "boolean":
      return raw === "true" || raw === "false"
        ? { value: raw === "true" }
        : { error: `${parameter.name} must be true or false` };
    case "list": {
      const items = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const values: QueryScalar[] = [];
      for (const item of items) {
        if (kind.item === "text") {
          values.push(item);
          continue;
        }
        const number = Number(item);
        if (
          !Number.isFinite(number) ||
          (kind.item === "integer" && !Number.isInteger(number))
        ) {
          return {
            error: `${parameter.name}: "${item}" is not ${kind.item === "integer" ? "an integer" : "a number"}`,
          };
        }
        values.push(number);
      }
      return { value: values.length > 0 ? values : undefined };
    }
    default:
      return { value: raw };
  }
}

/** A request the panel sends, in the terms of `ApiClient.request`. */
export interface TryItRequest {
  /** The method. */
  method: HttpMethod;
  /** The path under the API base, path parameters percent-encoded. */
  path: string;
  /** The query; arrays go as repeated keys. */
  query: Record<string, QueryValue>;
  /** The JSON body, or `undefined` for none. */
  body: unknown;
}

/** The outcome of {@link buildRequest}. */
export type BuildResult =
  | { ok: true; request: TryItRequest }
  | { ok: false; errors: Record<string, string> };

/**
 * The request a filled form makes: path parameters substituted (each
 * percent-encoded as one segment, so `a/b` is `a%2Fb`), query values typed
 * from their schemas, and the body as parsed. `body` is the editor's parsed
 * value, `undefined` for an empty editor.
 */
export function buildRequest(
  operation: DocOperation,
  root: SchemaRoot,
  values: TryItValues,
  body: unknown,
): BuildResult {
  const errors: Record<string, string> = {};
  if (!CLIENT_METHODS.has(operation.method)) {
    return {
      ok: false,
      errors: { method: `${operation.method} cannot be sent from here` },
    };
  }
  let path = operation.path;
  const query: Record<string, QueryValue> = {};
  for (const parameter of formParameters(operation)) {
    const key = paramKey(parameter);
    const result = coerce(parameter, inputKind(parameter, root), values[key]);
    if ("error" in result) {
      errors[key] = result.error;
      continue;
    }
    if (parameter.in === "path") {
      path = path
        .split(`{${parameter.name}}`)
        .join(segment(String(result.value)));
    } else if (result.value !== undefined) {
      query[parameter.name] = result.value;
    }
  }
  if (
    body === undefined &&
    operation.requestBody?.required &&
    bodySchema(operation) !== undefined
  ) {
    errors.body = "A body is required";
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    request: { method: operation.method as HttpMethod, path, query, body },
  };
}

/**
 * The headers the app's client sends for a method — restated from
 * `createApiClient` for the snippets: `Accept` always, `Content-Type` on
 * POST/PUT/PATCH (body or not), and the CSRF header on every mutation when
 * the UI is configured with one.
 */
export function clientHeaders(
  method: HttpMethod,
  csrfHeader: string | null,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (JSON_METHODS.has(method)) {
    headers["Content-Type"] = "application/json";
  }
  if (csrfHeader && MUTATING_METHODS.has(method)) {
    headers[csrfHeader] = CSRF_HEADER_VALUE;
  }
  return headers;
}

/** Where the snippets point. */
export interface SnippetContext {
  /** The app's API base (`/jobs-api`, or an absolute URL). */
  apiBase: string;
  /** The page's origin, for an absolute curl URL. */
  origin: string;
  /** The UI's CSRF header, or `null`. */
  csrfHeader: string | null;
}

/** The URL the client requests: base + path + query. */
export function requestUrl(request: TryItRequest, apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}${request.path}${serializeQuery(request.query)}`;
}

/** Quotes a word for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A `curl` command sending exactly what the panel sends. */
export function curlSnippet(
  request: TryItRequest,
  context: SnippetContext,
): string {
  const relative = requestUrl(request, context.apiBase);
  const url = /^https?:\/\//.test(relative)
    ? relative
    : `${context.origin}${relative}`;
  const lines = [`curl -X ${request.method} ${shellQuote(url)}`];
  for (const [name, value] of Object.entries(
    clientHeaders(request.method, context.csrfHeader),
  )) {
    lines.push(`  -H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (request.body !== undefined) {
    lines.push(`  --data ${shellQuote(JSON.stringify(request.body))}`);
  }
  return [
    "# The browser also sends this site's cookies (credentials: same-origin).",
    "# If the API's authorize reads a session, add it: -b 'name=value'",
    lines.join(" \\\n"),
  ].join("\n");
}

/** A `fetch()` call sending exactly what the panel sends, from a page on this origin. */
export function fetchSnippet(
  request: TryItRequest,
  context: SnippetContext,
): string {
  const headers = clientHeaders(request.method, context.csrfHeader);
  const headerLines = Object.entries(headers)
    .map(
      ([name, value]) =>
        `    ${JSON.stringify(name)}: ${JSON.stringify(value)},`,
    )
    .join("\n");
  const lines = [
    `const response = await fetch(${JSON.stringify(requestUrl(request, context.apiBase))}, {`,
    `  method: ${JSON.stringify(request.method)},`,
    "  headers: {",
    headerLines,
    "  },",
    `  credentials: "same-origin",`,
  ];
  if (request.body !== undefined) {
    lines.push(
      `  body: JSON.stringify(${JSON.stringify(request.body, null, 2).replace(/\n/g, "\n  ")}),`,
    );
  }
  lines.push("});", "const data = await response.json();");
  return lines.join("\n");
}

/**
 * Whether sending an operation needs a TYPED confirmation: a DELETE, or an
 * action whose verb removes or discards work (`jobs.remove`, `queues.drain`,
 * `queues.clean`, `runners.kill`, `repeatables.remove`).
 */
export function isDestructive(operation: DocOperation): boolean {
  if (operation.method === "DELETE") {
    return true;
  }
  const verb = operation.action?.split(".").pop() ?? "";
  return DESTRUCTIVE_VERBS.has(verb);
}

/** Whether the panel may send, and why not. */
export type TryItGate = { enabled: true } | { enabled: false; reason: string };

/** What {@link tryItGate} decides from. */
export interface GateInputs {
  /** `meta.readOnly`. */
  readOnly: boolean;
  /** Whether the caller holds the operation's action (untargeted permissions). */
  permitted: boolean;
}

/**
 * The panel is off for a mutation on a read-only API, and for an action the
 * caller does not hold. Advisory, like every permission marker here:
 * `authorize` may decide per target, and the API's answer stays final.
 */
export function tryItGate(
  operation: DocOperation,
  inputs: GateInputs,
): TryItGate {
  if (!CLIENT_METHODS.has(operation.method)) {
    return {
      enabled: false,
      reason: `The app's client does not send ${operation.method}.`,
    };
  }
  if (operation.mutation && inputs.readOnly) {
    return {
      enabled: false,
      reason: "This API is read-only: it refuses every change.",
    };
  }
  if (operation.action !== undefined && !inputs.permitted) {
    return {
      enabled: false,
      reason: `You do not have the ${operation.action} permission.`,
    };
  }
  return { enabled: true };
}
