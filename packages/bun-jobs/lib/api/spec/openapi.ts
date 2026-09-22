import type { OpenApiDocument, ResolvedJobsApiConfig } from "../config";
import type { AnyRouteDef, RouteResponses } from "../routes/define";
import type { JsonSchema } from "../schema/validate";
import { ConfigError } from "../../shared/errors";
import { isMutation } from "../config";
import { API_ERROR_STATUS, problemTitle } from "../errors";
import { toJsonSchema } from "../schema/builder";
import {
  ErrorDtoSchema,
  JobRefSchema,
  JobStateSchema,
  PageInfoSchema,
  ProblemSchema,
} from "../schemas/common";
import { pruneSchemaComponents } from "./refs";
import { openApiSecurity } from "./security";

/**
 * The OpenAPI 3.1 generator. It describes exactly the routes it is given —
 * the pruned list the router registered — so a route absent from the router
 * is absent from the document, and so is every schema only it used.
 */

/** Descriptions for the tags routes use. */
const TAG_DESCRIPTIONS: Record<string, string> = {
  Meta: "What the API exposes, and what the caller may do.",
  Docs: "Machine-readable descriptions of this API.",
  Queues: "Queues: counts, pausing, draining, cleaning and limits.",
  Jobs: "Jobs: listing, reading, retrying, removing and promoting.",
  Runners: "Runners: status, history, triggering and scheduling.",
  Workers:
    "Workers: which processes are consuming each queue, pausing, resuming, stopping and starting them, and the configuration overrides they adopt.",
  Analytics:
    "Analytics: jobs, runner and worker series over a time range. Every range read shares one rule — the request's `to` is exclusive, while a response's `range.to` is the start of the last bucket and `range.end` the exclusive end.",
};

/** Reason phrases for success statuses. */
const SUCCESS_DESCRIPTIONS: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
};

/** The bun-jobs package version, the default `info.version`. */
function packageVersion(): string {
  return (import.meta.require("../../../package.json") as { version: string })
    .version;
}

/** Converts an Express path to an OpenAPI template, returning the parameter names. */
export function toOpenApiPath(path: string): { path: string; names: string[] } {
  if (/[*()]/.test(path)) {
    throw new ConfigError(
      `Route path "${path}" uses syntax the OpenAPI generator cannot describe`,
      { path },
    );
  }
  const names: string[] = [];
  const converted = path.replace(
    /:(\w+)(\?)?/g,
    (_match, name: string, optional?: string) => {
      if (optional) {
        throw new ConfigError(
          `Route path "${path}" has an optional parameter, which OpenAPI cannot describe`,
          { path },
        );
      }
      names.push(name);
      return `{${name}}`;
    },
  );
  return { path: converted, names };
}

/** The problem codes a route can answer with: its own plus the ones every route of its kind gets. */
export function routeErrorCodes(
  def: AnyRouteDef,
  config: Pick<ResolvedJobsApiConfig, "csrf">,
): string[] {
  const codes = new Set<string>(["UNAUTHORIZED", "FORBIDDEN"]);
  const mutation = isMutation(def.action);
  if (def.params || def.query || def.body) {
    codes.add("VALIDATION");
  }
  if (def.body || mutation) {
    // Every route that reads a body checks its size and its JSON, whether or
    // not it declares a body schema.
    codes.add("INVALID_JSON");
    codes.add("PAYLOAD_TOO_LARGE");
  }
  if (mutation && config.csrf !== false) {
    codes.add("CSRF_REJECTED");
    if (config.csrf.requireJson) {
      codes.add("UNSUPPORTED_MEDIA_TYPE");
    }
  }
  for (const code of def.errors ?? []) {
    codes.add(code);
  }
  return [...codes].sort();
}

/** The status a documented code is answered with. */
function statusOf(code: string, operationId: string): number {
  const status = (API_ERROR_STATUS as Record<string, number>)[code];
  if (status === undefined) {
    throw new ConfigError(
      `Route "${operationId}" documents "${code}", which has no known status`,
      { operationId, code },
    );
  }
  return status;
}

/** Builds one operation. */
function operation(
  def: AnyRouteDef,
  config: ResolvedJobsApiConfig,
  pathNames: readonly string[],
  emit: (schema: JsonSchema) => JsonSchema,
): Record<string, unknown> {
  const parameters: Record<string, unknown>[] = [];

  const params = def.params?.json.properties ?? {};
  for (const name of Object.keys(params)) {
    if (!pathNames.includes(name)) {
      throw new ConfigError(
        `Route "${def.operationId}" validates param "${name}", which its path does not have`,
        { operationId: def.operationId, name },
      );
    }
  }
  for (const name of pathNames) {
    const node = params[name];
    parameters.push({
      name,
      in: "path",
      required: true,
      ...(node?.description ? { description: node.description } : {}),
      schema: node ? emit(node) : { type: "string" },
    });
  }

  const query = def.query?.json;
  const required = new Set(query?.required ?? []);
  for (const [name, node] of Object.entries(query?.properties ?? {})) {
    const isArray =
      node.type === "array" ||
      (Array.isArray(node.type) && node.type.includes("array"));
    parameters.push({
      name,
      in: "query",
      required: required.has(name) && node.default === undefined,
      ...(node.description ? { description: node.description } : {}),
      schema: emit(node),
      // Repeated keys (`state=a&state=b`); a comma list is accepted as well.
      ...(isArray ? { style: "form", explode: true } : {}),
    });
  }

  const mutation = isMutation(def.action);
  const csrf = mutation && config.csrf !== false ? config.csrf : undefined;
  if (csrf && csrf.header !== false) {
    parameters.push({
      name: csrf.header,
      in: "header",
      required: true,
      description:
        "CSRF defence: every mutation must carry this header with a non-empty value. Its presence forces a CORS preflight, which a cross-site form cannot pass.",
      schema: { type: "string", minLength: 1 },
    });
  }
  // `checkCsrf` refuses a POST that is not `application/json` — body or no
  // body — and any other mutation that sends a body. A route with a body
  // schema already declares only `application/json`; a bodiless POST has to
  // say so, or a generated client sends it with no `Content-Type` and gets 415.
  const jsonRequired =
    csrf !== undefined &&
    csrf.requireJson &&
    (def.method === "POST" || def.body !== undefined);
  const JSON_REQUIRED_NOTE =
    "Send `Content-Type: application/json` even with no body (an empty body, or `{}`): this API refuses a state-changing POST of any other media type with 415 UNSUPPORTED_MEDIA_TYPE.";

  const responses: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(def.responses as RouteResponses)) {
    const status = Number(key);
    responses[key] = {
      description: SUCCESS_DESCRIPTIONS[status] ?? "Success",
      ...(schema === null
        ? {}
        : { content: { "application/json": { schema: emit(schema.json) } } }),
    };
  }

  const byStatus = new Map<number, string[]>();
  for (const code of routeErrorCodes(def, config)) {
    const status = statusOf(code, def.operationId);
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  for (const [status, codes] of [...byStatus].sort(([a], [b]) => a - b)) {
    if (Object.hasOwn(responses, String(status))) {
      throw new ConfigError(
        `Route "${def.operationId}" declares ${status} both as a response and as a problem`,
        { operationId: def.operationId, status },
      );
    }
    responses[String(status)] = {
      description: codes.map((code) => problemTitle(code, status)).join("; "),
      content: {
        "application/problem+json": {
          schema: { $ref: "#/components/schemas/Problem" },
        },
      },
      "x-bun-jobs-codes": codes,
    };
  }
  responses.default = { $ref: "#/components/responses/Problem" };

  return {
    operationId: def.operationId,
    summary: def.summary,
    ...(def.description ? { description: def.description } : {}),
    tags: [...def.tags],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(def.body
      ? {
          requestBody: {
            required: !def.bodyOptional,
            ...(jsonRequired && def.bodyOptional
              ? { description: JSON_REQUIRED_NOTE }
              : {}),
            content: { "application/json": { schema: emit(def.body.json) } },
          },
        }
      : jsonRequired
        ? {
            // No body schema: whatever is sent is ignored, but the media type
            // is still checked.
            requestBody: {
              required: false,
              description: JSON_REQUIRED_NOTE,
              content: {
                "application/json": {
                  schema: {
                    description: "Ignored. Send no body, or `{}`.",
                  },
                },
              },
            },
          }
        : {}),
    responses,
    "x-bun-jobs-action": def.action,
    "x-bun-jobs-mutation": mutation,
    "x-bun-jobs-requires": [...(def.requires ?? [])],
    ...(csrf
      ? {
          "x-bun-jobs-csrf": {
            header: csrf.header === false ? null : csrf.header,
            requireJson: jsonRequired,
          },
        }
      : {}),
  };
}

/**
 * Generates the OpenAPI 3.1 document for `defs` (already pruned).
 *
 * - `servers` default to `[{ url: basePath }]`, so paths are relative to the mount;
 * - named schemas become `components.schemas`, referenced by `$ref`, and only
 *   the reachable ones are kept;
 * - every error status references the `Problem` schema and lists its codes
 *   in `x-bun-jobs-codes`;
 * - operation ids must be unique, or `ConfigError` is thrown.
 */
export function generateOpenApi(
  defs: readonly AnyRouteDef[],
  config: ResolvedJobsApiConfig,
): OpenApiDocument {
  const docs = config.docs === false ? undefined : config.docs;
  const components = new Map<string, JsonSchema>();
  // One name → schema map for the whole document: two different schemas
  // under one component name, in any two routes or a route and the core
  // schemas, throw instead of one silently replacing the other.
  const names = new Map<string, JsonSchema>();
  const emit = (schema: JsonSchema) =>
    toJsonSchema(schema, { components, names });

  const paths: Record<string, Record<string, unknown>> = {};
  const operationIds = new Set<string>();
  const tags: string[] = [];

  for (const def of defs) {
    if (operationIds.has(def.operationId)) {
      throw new ConfigError(
        `Two routes share the operation id "${def.operationId}"`,
        { operationId: def.operationId },
      );
    }
    operationIds.add(def.operationId);

    const { path, names } = toOpenApiPath(def.path);
    const item = (paths[path] ??= {});
    const method = def.method.toLowerCase();
    if (Object.hasOwn(item, method)) {
      throw new ConfigError(
        `Two routes are registered for ${def.method} ${def.path}`,
      );
    }
    item[method] = operation(def, config, names, emit);

    for (const tag of def.tags) {
      if (!tags.includes(tag)) {
        tags.push(tag);
      }
    }
  }

  // The API-wide schemas are registered whatever was routed, so every
  // document names them the same way; pruning below then drops the ones no
  // remaining operation reaches. Problem always survives: every error
  // response references it.
  for (const schema of [
    ProblemSchema,
    ErrorDtoSchema,
    JobRefSchema,
    PageInfoSchema,
    JobStateSchema,
  ]) {
    components.set(
      schema.ref!,
      toJsonSchema(schema, { components, names, inlineRoot: true }),
    );
  }

  const security = openApiSecurity(config.docs);
  const hasSecurity = security.securitySchemes !== undefined;

  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: docs?.title ?? `bun-jobs management API (${config.namespace})`,
      version: docs?.version ?? packageVersion(),
      description:
        docs?.description ??
        (hasSecurity
          ? "Management API for bun-jobs queues and runners."
          : "Management API for bun-jobs queues and runners. Authorization is enforced by the host application's `authorize` hook; this document declares no security schemes."),
    },
    servers: structuredClone(docs?.servers ?? [{ url: config.basePath }]),
    tags: tags.map((name) => ({
      name,
      ...(TAG_DESCRIPTIONS[name]
        ? { description: TAG_DESCRIPTIONS[name] }
        : {}),
    })),
    paths,
    components: {
      schemas: Object.fromEntries(
        [...components].sort(([a], [b]) => a.localeCompare(b)),
      ),
      responses: {
        Problem: {
          description: "A problem, as RFC 9457 describes it.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/Problem" },
            },
          },
        },
      },
      ...(hasSecurity ? { securitySchemes: security.securitySchemes } : {}),
    },
    ...(security.security ? { security: security.security } : {}),
  };

  pruneSchemaComponents(
    document as unknown as Parameters<typeof pruneSchemaComponents>[0],
  );
  return document;
}
