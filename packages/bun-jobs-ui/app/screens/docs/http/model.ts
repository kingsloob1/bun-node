import type { SpecDocument } from "../../../api/docs";
import { deref, isSchemaObject, refOf, resolveRef } from "../schema/resolve";

/**
 * The parts of an OpenAPI 3.1 document the HTTP reference renders, read out
 * of the JSON into plain records. Everything is defensive: the document is
 * data from the API, and a field of the wrong shape is skipped rather than
 * trusted.
 */

/** Path item keys that are operations, in the order OpenAPI lists them. */
const OPERATION_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

/** Where a parameter goes. */
export type ParameterLocation = "path" | "query" | "header" | "cookie";

/** One parameter of an operation. */
export interface DocParameter {
  /** Its name. */
  name: string;
  /** Where it goes. */
  in: ParameterLocation;
  /** Whether it must be sent (path parameters always are). */
  required: boolean;
  /** What it means. */
  description?: string;
  /** Its schema (possibly a `$ref`). */
  schema: unknown;
  /** OpenAPI `style` (`form` for the API's array query parameters). */
  style?: string;
  /** OpenAPI `explode`: `true` sends an array as repeated keys. */
  explode?: boolean;
  /** Whether it is deprecated. */
  deprecated: boolean;
}

/** One media type of a body. */
export interface DocMediaType {
  /** E.g. `application/json`. */
  contentType: string;
  /** Its schema, when it declares one. */
  schema: unknown;
}

/** An operation's request body. */
export interface DocRequestBody {
  /** Whether a body must be sent. */
  required: boolean;
  /** A note, e.g. that `Content-Type: application/json` is required even when bodiless. */
  description?: string;
  /** The media types accepted. */
  content: DocMediaType[];
}

/** One documented response. */
export interface DocResponse {
  /** `"200"`, `"404"`, `"default"`, `"4XX"`. */
  status: string;
  /** What it means (for a problem: the titles of its codes). */
  description: string;
  /** Its bodies. */
  content: DocMediaType[];
  /** `x-bun-jobs-codes`: the problem codes answered with this status. */
  codes: string[];
  /** The `$ref` it came from (`#/components/responses/Problem`), if any. */
  ref?: string;
}

/** `x-bun-jobs-csrf`: what a mutation must carry. */
export interface DocCsrf {
  /** The header every mutation must carry (any non-empty value), or `null` when none is required. */
  header: string | null;
  /** Whether `Content-Type: application/json` is required, even without a body. */
  requireJson: boolean;
}

/** One operation, flattened. */
export interface DocOperation {
  /** `operationId` (or `METHOD path` when the document gives none). */
  id: string;
  /** Upper-case method. */
  method: string;
  /** The path template, relative to the server (`/queues/{queue}`). */
  path: string;
  /** One line. */
  summary?: string;
  /** More. */
  description?: string;
  /** Its tags. */
  tags: string[];
  /** Whether it is deprecated. */
  deprecated: boolean;
  /** Path-item and operation parameters, operation ones winning. */
  parameters: DocParameter[];
  /** The body it takes. */
  requestBody?: DocRequestBody;
  /** Its responses, in document order. */
  responses: DocResponse[];
  /** `x-bun-jobs-action`: the permission `authorize` is asked about. */
  action?: string;
  /** `x-bun-jobs-mutation`: whether it changes state (CSRF checks, refused when read-only). */
  mutation: boolean;
  /** `x-bun-jobs-requires`: the driver methods it needs. */
  requires: string[];
  /** `x-bun-jobs-csrf`, on mutations when CSRF checks are on. */
  csrf?: DocCsrf;
}

/** One tag, with the operations under it. */
export interface DocTagGroup {
  /** The tag's name. */
  name: string;
  /** What it covers. */
  description?: string;
  /** Its operations, in document order. */
  operations: DocOperation[];
}

/** One server entry. */
export interface DocServer {
  /** Its URL, often relative (`/jobs-api`). */
  url: string;
  /** A note. */
  description?: string;
}

/** The document's header. */
export interface DocInfo {
  /** `openapi`, e.g. `3.1.0`. */
  openapi: string;
  /** The API's title. */
  title: string;
  /** Its version. */
  version: string;
  /** What it is. */
  description?: string;
  /** Where it is served. */
  servers: DocServer[];
}

/** A string field, or `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A string array field, or `[]`. */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Follows a `$ref` to a component (a parameter, a response, a body), one level of indirection at a time. */
function component(
  doc: SpecDocument,
  value: unknown,
): { node: Record<string, unknown> | undefined; ref?: string } {
  const ref = refOf(value);
  if (ref === undefined) {
    return { node: isSchemaObject(value) ? value : undefined };
  }
  const target = deref(value, doc).schema;
  return { node: isSchemaObject(target) ? target : undefined, ref };
}

/** The media types of a `content` map. */
function mediaTypes(value: unknown): DocMediaType[] {
  if (!isSchemaObject(value)) {
    return [];
  }
  return Object.entries(value).map(([contentType, media]) => ({
    contentType,
    schema: isSchemaObject(media) ? media.schema : undefined,
  }));
}

/** Reads one parameter. */
function readParameter(
  doc: SpecDocument,
  raw: unknown,
): DocParameter | undefined {
  const { node } = component(doc, raw);
  const name = text(node?.name);
  const location = text(node?.in);
  if (
    !node ||
    name === undefined ||
    (location !== "path" &&
      location !== "query" &&
      location !== "header" &&
      location !== "cookie")
  ) {
    return undefined;
  }
  return {
    name,
    in: location,
    required: location === "path" || node.required === true,
    description: text(node.description),
    schema: node.schema,
    style: text(node.style),
    explode: typeof node.explode === "boolean" ? node.explode : undefined,
    deprecated: node.deprecated === true,
  };
}

/** Reads the `x-bun-jobs-csrf` extension. */
function readCsrf(value: unknown): DocCsrf | undefined {
  if (!isSchemaObject(value)) {
    return undefined;
  }
  return {
    header: text(value.header) ?? null,
    requireJson: value.requireJson === true,
  };
}

/** Reads one operation of a path item. */
function readOperation(
  doc: SpecDocument,
  path: string,
  method: string,
  raw: Record<string, unknown>,
  shared: unknown[],
): DocOperation {
  const parameters = new Map<string, DocParameter>();
  for (const item of [
    ...shared,
    ...(Array.isArray(raw.parameters) ? raw.parameters : []),
  ]) {
    const parameter = readParameter(doc, item);
    if (parameter) {
      parameters.set(`${parameter.in}:${parameter.name}`, parameter);
    }
  }
  const body = component(doc, raw.requestBody).node;
  const responses: DocResponse[] = [];
  if (isSchemaObject(raw.responses)) {
    for (const [status, value] of Object.entries(raw.responses)) {
      const { node, ref } = component(doc, value);
      responses.push({
        status,
        description: text(node?.description) ?? "",
        content: mediaTypes(node?.content),
        codes: strings(node?.["x-bun-jobs-codes"]),
        ...(ref ? { ref } : {}),
      });
    }
  }
  return {
    id: text(raw.operationId) ?? `${method.toUpperCase()} ${path}`,
    method: method.toUpperCase(),
    path,
    summary: text(raw.summary),
    description: text(raw.description),
    tags: strings(raw.tags),
    deprecated: raw.deprecated === true,
    parameters: [...parameters.values()],
    requestBody: body
      ? {
          required: body.required === true,
          description: text(body.description),
          content: mediaTypes(body.content),
        }
      : undefined,
    responses,
    action: text(raw["x-bun-jobs-action"]),
    mutation: raw["x-bun-jobs-mutation"] === true,
    requires: strings(raw["x-bun-jobs-requires"]),
    csrf: readCsrf(raw["x-bun-jobs-csrf"]),
  };
}

/** Every operation of the document, in path order and, within a path, method order. */
export function listOperations(doc: SpecDocument): DocOperation[] {
  const operations: DocOperation[] = [];
  if (!isSchemaObject(doc.paths)) {
    return operations;
  }
  for (const [path, item] of Object.entries(doc.paths)) {
    const pathItem = component(doc, item).node;
    if (!pathItem) {
      continue;
    }
    const shared = Array.isArray(pathItem.parameters)
      ? pathItem.parameters
      : [];
    for (const method of OPERATION_METHODS) {
      const raw = pathItem[method];
      if (isSchemaObject(raw)) {
        operations.push(readOperation(doc, path, method, raw, shared));
      }
    }
  }
  return operations;
}

/** The document's header: title, version, description, servers. */
export function readInfo(doc: SpecDocument): DocInfo {
  const info = isSchemaObject(doc.info) ? doc.info : {};
  const servers = Array.isArray(doc.servers)
    ? doc.servers.flatMap((server): DocServer[] => {
        const url = isSchemaObject(server) ? text(server.url) : undefined;
        return url === undefined
          ? []
          : [
              {
                url,
                description: text(
                  (server as Record<string, unknown>).description,
                ),
              },
            ];
      })
    : [];
  return {
    openapi: text(doc.openapi) ?? "",
    title: text(info.title) ?? "API",
    version: text(info.version) ?? "",
    description: text(info.description),
    servers: servers.length > 0 ? servers : [{ url: "/" }],
  };
}

/**
 * Operations by tag, in the document's `tags` order; tags an operation uses
 * but the list omits follow in first-use order, then `Other` for untagged
 * operations. An operation with two tags is listed under both.
 */
export function groupByTag(
  doc: SpecDocument,
  operations: readonly DocOperation[],
): DocTagGroup[] {
  const groups = new Map<string, DocTagGroup>();
  if (Array.isArray(doc.tags)) {
    for (const tag of doc.tags) {
      const name = isSchemaObject(tag) ? text(tag.name) : undefined;
      if (name !== undefined && !groups.has(name)) {
        groups.set(name, {
          name,
          description: text((tag as Record<string, unknown>).description),
          operations: [],
        });
      }
    }
  }
  const other: DocOperation[] = [];
  for (const operation of operations) {
    if (operation.tags.length === 0) {
      other.push(operation);
    }
    for (const tag of operation.tags) {
      let group = groups.get(tag);
      if (!group) {
        group = { name: tag, operations: [] };
        groups.set(tag, group);
      }
      group.operations.push(operation);
    }
  }
  const result = [...groups.values()].filter(
    (group) => group.operations.length > 0,
  );
  if (other.length > 0) {
    result.push({ name: "Other", operations: other });
  }
  return result;
}

/**
 * Whether an operation matches a search: every whitespace-separated term
 * must appear, ignoring case, in its path, id, summary, method or action.
 */
export function matchesSearch(operation: DocOperation, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const haystack = [
    operation.method,
    operation.path,
    operation.id,
    operation.summary ?? "",
    operation.action ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Groups filtered by a search; groups left empty are dropped. */
export function filterGroups(
  groups: readonly DocTagGroup[],
  query: string,
): DocTagGroup[] {
  return groups
    .map((group) => ({
      ...group,
      operations: group.operations.filter((operation) =>
        matchesSearch(operation, query),
      ),
    }))
    .filter((group) => group.operations.length > 0);
}

/**
 * A server URL as the reader can use it: a relative one (`/jobs-api`, the
 * API's default) is resolved against the origin the app talks to — the API
 * base's own origin when it is absolute, else the page's.
 */
export function resolveServerUrl(
  url: string,
  apiBase: string,
  pageOrigin: string,
): string {
  const origin = /^https?:\/\//.test(apiBase)
    ? new URL(apiBase).origin
    : pageOrigin;
  try {
    return new URL(url, `${origin}/`).href.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** The named component schemas, sorted as the document lists them. */
export function componentSchemaNames(doc: SpecDocument): string[] {
  const schemas = resolveRef(doc, "#/components/schemas");
  return isSchemaObject(schemas) ? Object.keys(schemas) : [];
}

/** The tone a method badge takes. */
export function methodTone(
  method: string,
): "info" | "success" | "warning" | "danger" | "neutral" {
  switch (method) {
    case "GET":
      return "info";
    case "POST":
      return "success";
    case "PUT":
    case "PATCH":
      return "warning";
    case "DELETE":
      return "danger";
    default:
      return "neutral";
  }
}

/** The success responses (2xx), for the status a successful try-it had. */
export function successStatuses(operation: DocOperation): string[] {
  return operation.responses
    .map((response) => response.status)
    .filter((status) => /^2\d\d$/.test(status));
}
