/**
 * Every management route carries its full HTTP contract on its terminal layer
 * (plan `docs/plans/bun-validate/` §4.12 M5): `getContract(layer)` and
 * `describeContract` find its params, query and body, every response status
 * with its media types (alternate representations as string bodies, problems
 * as `application/problem+json`), all agreeing with the OpenAPI document.
 *
 * Checked over **every** route each configuration registers, not a sample,
 * with a negative control: a route whose contract is removed is reported.
 */
import type { AnyContract, ContractEntry } from "@kingsleyweb/bun-common";
import type { JobsApi, JobsApiConfig } from "../../lib/api/config";
import type { AnyRouteDef } from "../../lib/api/routes/define";
import type { Schema } from "../../lib/api/schema/builder";
import {
  BunRouter,
  CONTRACT,
  describeContract,
  getContract,
} from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { resolveConfig } from "../../lib/api/config";
import { JOBS_API_ACTIONS } from "../../lib/api/contract/constants";
import { buildJobsApi, builtInRoutes } from "../../lib/api/createJobsApi";
import { defineRoute, isRouteEnabled } from "../../lib/api/routes/define";
import { s } from "../../lib/api/schema/builder";
import { ProblemSchema } from "../../lib/api/schemas/common";
import { toOpenApiPath } from "../../lib/api/spec/openapi";
import { apiConfig, openContexts } from "./fixtures";

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

/** A route as `BunRouter.routes()` holds it: what this test reads of one. */
interface RouterRoute {
  /** The method, upper case; absent on middleware. */
  method?: string;
  /** The path as registered, relative to the router. */
  path?: string;
  /** The route's callbacks, in registration order. */
  callbacks?: readonly unknown[];
}

/** A JSON Schema node, loosely. */
type Json = Record<string, unknown>;

/** Whether a value is a JSON object node. */
function isNode(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON Schema with every `$ref` replaced by what it points at (looked up by
 * `lookup`), a cycle replaced by `{ $cycle: name }`, and `$schema` dropped,
 * so a document and the API's OpenAPI document compare by content whatever
 * their reference layout.
 */
function resolveRefs(
  node: unknown,
  lookup: (ref: string) => { name: string; node: unknown } | undefined,
  stack: readonly string[] = [],
): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => resolveRefs(child, lookup, stack));
  }
  if (!isNode(node)) {
    return node;
  }
  if (typeof node.$ref === "string") {
    const found = lookup(node.$ref);
    if (found === undefined) {
      return { $unresolved: node.$ref };
    }
    if (stack.includes(found.name)) {
      return { $cycle: found.name };
    }
    return resolveRefs(found.node, lookup, [...stack, found.name]);
  }
  const out: Json = {};
  for (const [key, child] of Object.entries(node)) {
    if (key === "$schema" || key === "$defs" || key === "definitions") {
      continue;
    }
    out[key] = resolveRefs(child, lookup, stack);
  }
  return out;
}

/**
 * A `~standard.jsonSchema` input document, resolved against its own `$defs`.
 * Its root is inlined where the OpenAPI document refers to it by name, so a
 * named root starts on the stack: a recursive one then unrolls exactly as
 * deep as the document's.
 */
function standardInput(schema: Schema<any, any>): unknown {
  const document = schema["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  });
  const defs = (document.$defs ?? {}) as Json;
  return resolveRefs(
    document,
    (ref) => {
      const name = ref.replace(/^#\/\$defs\//, "");
      return Object.hasOwn(defs, name) ? { name, node: defs[name] } : undefined;
    },
    schema.ref === undefined ? [] : [schema.ref],
  );
}

/** One OpenAPI schema object, resolved against the document's components. */
function openApiResolved(document: Json, schema: unknown): unknown {
  const components = ((document.components as Json | undefined)?.schemas ??
    {}) as Json;
  return resolveRefs(schema, (ref) => {
    const name = ref.replace(/^#\/components\/schemas\//, "");
    return Object.hasOwn(components, name)
      ? { name, node: components[name] }
      : undefined;
  });
}

/**
 * Whether two resolved JSON Schemas are equal, and neither holds a reference
 * that did not resolve (two equally broken documents must not pass).
 */
function sameSchema(a: unknown, b: unknown): boolean {
  const text = JSON.stringify([a, b]);
  return !text.includes('"$unresolved"') && Bun.deepEquals(a, b);
}

/** The encodings each inbound part travels with (bun-common's HTTP transport). */
const INBOUND_ENCODING: Readonly<Record<string, string>> = {
  params: "path-string",
  query: "querystring",
  body: "body",
};

/**
 * Everything wrong with the contracts the routes of `api` carry, one line per
 * finding (empty when every route is right): a route whose terminal layer
 * carries no contract, an inbound part or a response status, media type or
 * schema that differs from the route's definition or the OpenAPI document.
 */
function contractFailures(
  api: JobsApi,
  defs: readonly AnyRouteDef[],
): string[] {
  const failures: string[] = [];
  const byId = new Map(defs.map((def) => [def.operationId, def]));
  const routes = api.router.routes() as unknown as RouterRoute[];
  const document = api.openapi() as unknown as Json;
  const paths = document.paths as Record<string, Record<string, Json>>;

  for (const info of api.routes) {
    const def = byId.get(info.operationId)!;
    const where = `${info.method} ${def.path} (${info.operationId})`;
    const route = routes.find(
      (r) => r.method === info.method && r.path === def.path,
    );
    const terminal = route?.callbacks?.at(-1);
    const contract: AnyContract | undefined = getContract(terminal);
    if (contract === undefined) {
      failures.push(`${where}: its terminal layer carries no contract`);
      continue;
    }
    const described = describeContract(contract);
    if (described.transport !== "http") {
      failures.push(`${where}: transport ${described.transport}`);
    }
    const rows = described.entries;

    // Inbound: exactly the parts the route validates, each its own schema.
    const inbound = rows.filter((row) => row.side === "inbound");
    const wanted = (["params", "query", "body"] as const).filter(
      (part) => def[part] !== undefined,
    );
    if (
      JSON.stringify(inbound.map((row) => row.part)) !== JSON.stringify(wanted)
    ) {
      failures.push(
        `${where}: inbound parts ${inbound.map((row) => row.part).join(",")} ≠ ${wanted.join(",")}`,
      );
    }
    for (const row of inbound) {
      const part = row.part as "params" | "query" | "body";
      if (row.schema !== def[part]) {
        failures.push(`${where}: inbound ${part} is not the route's schema`);
      }
      if (row.encoding !== INBOUND_ENCODING[part]) {
        failures.push(`${where}: inbound ${part} encoding ${row.encoding}`);
      }
    }
    const operation = paths[toOpenApiPath(def.path).path]?.[
      def.method.toLowerCase()
    ] as Json | undefined;
    if (operation === undefined) {
      failures.push(`${where}: not in the OpenAPI document`);
      continue;
    }
    if (def.body) {
      const documented = (
        (operation.requestBody as Json).content as Record<string, Json>
      )["application/json"].schema;
      if (
        !sameSchema(
          standardInput(def.body),
          openApiResolved(document, documented),
        )
      ) {
        failures.push(`${where}: the body's JSON Schema ≠ the document's`);
      }
    }

    // Outbound: the document's statuses, each with its media types.
    const responses = operation.responses as Record<string, Json>;
    const statuses = Object.keys(responses)
      .filter((key) => key !== "default")
      .sort((a, b) => Number(a) - Number(b));
    const keys = described.sides.outbound?.keys ?? [];
    if (JSON.stringify(keys) !== JSON.stringify(statuses)) {
      failures.push(
        `${where}: statuses ${keys.join(",")} ≠ the document's ${statuses.join(",")}`,
      );
      continue;
    }
    for (const status of statuses) {
      const at = rows.filter(
        (row) => row.side === "outbound" && row.key === status,
      );
      const content = (responses[status].content ?? {}) as Record<string, Json>;
      const media = Object.keys(content).sort();
      if (media.length === 0) {
        // Declared without a body (`null`).
        if (
          at.length !== 1 ||
          at[0].schema !== null ||
          at[0].mediaType !== undefined
        ) {
          failures.push(`${where}: ${status} is not declared bodiless`);
        }
        continue;
      }
      const found = at.map((row) => row.mediaType ?? "").sort();
      if (JSON.stringify(found) !== JSON.stringify(media)) {
        failures.push(
          `${where}: ${status} media ${found.join(",")} ≠ ${media.join(",")}`,
        );
        continue;
      }
      for (const row of at) {
        failures.push(
          ...rowFailures(where, status, row, def, document, content),
        );
      }
    }
  }
  return failures;
}

/** What is wrong with one response row, against the route and the document. */
function rowFailures(
  where: string,
  status: string,
  row: ContractEntry,
  def: AnyRouteDef,
  document: Json,
  content: Record<string, Json>,
): string[] {
  const label = `${where}: ${status} ${row.mediaType}`;
  const schema = row.schema as Schema<any, any> | null;
  if (schema === null) {
    return [`${label}: no schema`];
  }
  if (row.part !== "body" || row.encoding !== "body") {
    return [`${label}: part ${row.part}, encoding ${row.encoding}`];
  }
  const out: string[] = [];
  if (row.mediaType === "application/json") {
    if (schema !== def.responses[Number(status)]) {
      out.push(`${label}: not the route's schema`);
    }
  } else if (row.mediaType === "application/problem+json") {
    if (schema !== ProblemSchema) {
      out.push(`${label}: not ProblemSchema`);
    }
  } else {
    // An alternate representation, written by the handler: a string body.
    const alternate = def.alternateContent?.[row.mediaType!];
    const input = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    if (alternate === undefined || input.type !== "string") {
      out.push(`${label}: not an alternate string body`);
    }
    return out;
  }
  if (
    !sameSchema(
      standardInput(schema),
      openApiResolved(document, content[row.mediaType].schema),
    )
  ) {
    out.push(`${label}: JSON Schema ≠ the document's`);
  }
  return out;
}

/** An API over every built-in route (and `extra`), and the definitions it was built from. */
function build(
  overrides: Partial<JobsApiConfig>,
  extra: readonly AnyRouteDef[] = [],
): {
  api: JobsApi;
  defs: AnyRouteDef[];
} {
  const resolved = resolveConfig(apiConfig(overrides));
  const defs = [...builtInRoutes(resolved), ...extra];
  return { api: buildJobsApi(resolved, defs), defs };
}

/** The configurations checked: each registers a different set of routes. */
const CONFIGS: Record<string, Partial<JobsApiConfig>> = {
  "every action, docs pages and the socket": {
    actions: [...JOBS_API_ACTIONS],
    docs: { ui: true },
  },
  "the default actions, CSRF off, no socket": {
    csrf: false,
    websocket: false,
  },
  "read-only": { actions: [...JOBS_API_ACTIONS], readOnly: true },
  "the runner half only": { actions: [...JOBS_API_ACTIONS], mode: "runner" },
};

describe("every route carries its HTTP contract on its terminal layer", () => {
  for (const [name, overrides] of Object.entries(CONFIGS)) {
    it(name, () => {
      const { api, defs } = build(overrides);
      const enabled = defs.filter((def) =>
        isRouteEnabled(def, resolveConfig(apiConfig(overrides))),
      );
      expect(api.routes.length).toBe(enabled.length);
      expect(api.routes.length).toBeGreaterThan(0);
      expect(contractFailures(api, defs)).toEqual([]);
    });
  }

  it("covers the whole API: every one of its routes in the widest configuration", () => {
    const { api } = build(CONFIGS["every action, docs pages and the socket"]);
    const routes = api.router.routes() as unknown as RouterRoute[];
    const carrying = routes.filter(
      (route) => getContract(route.callbacks?.at(-1)) !== undefined,
    );
    // One carrier per registered route, and nothing else carries one.
    expect(carrying).toHaveLength(api.routes.length);
    expect(api.routes.length).toBeGreaterThanOrEqual(84);
  });

  it("negative control: a route whose contract is removed is reported", () => {
    const { api, defs } = build(
      CONFIGS["every action, docs pages and the socket"],
    );
    const routes = api.router.routes() as unknown as RouterRoute[];
    const victim = routes.find(
      (route) => route.method === "GET" && route.path === "/queues/:queue/jobs",
    )!;
    const terminal = victim.callbacks!.at(-1) as object;
    expect(Reflect.deleteProperty(terminal, CONTRACT)).toBe(true);
    expect(contractFailures(api, defs)).toEqual([
      "GET /queues/:queue/jobs (listJobs): its terminal layer carries no contract",
    ]);
  });

  it("describes alternate representations as string bodies beside the JSON one", () => {
    const { api } = build(CONFIGS["every action, docs pages and the socket"]);
    const routes = api.router.routes() as unknown as RouterRoute[];
    const demand = routes.find(
      (route) => route.method === "GET" && route.path === "/demand",
    )!;
    const rows = describeContract(getContract(demand.callbacks!.at(-1))!)
      .entries.filter((row) => row.key === "200")
      .map((row) => ({
        mediaType: row.mediaType,
        vendor: row.vendor,
        kind: row.kind,
      }));
    expect(rows).toEqual([
      { mediaType: "application/json", vendor: "bun-jobs", kind: "value" },
      {
        mediaType: "text/plain; version=0.0.4",
        vendor: "bun-jobs",
        kind: "value",
      },
    ]);
  });

  it("installs no response gate whatever the host router sets", async () => {
    // Each route's validator carries its responses with its own `"off"`, so
    // a host's `responseValidation: "error"` checks nothing of the API's:
    // `validateResponses` (here off) is the API's only response check.
    const wrong = defineRoute({
      method: "GET",
      path: "/wrong-with-query",
      operationId: "getWrongWithQuery",
      action: "jobs.read",
      mode: "jobs",
      summary: "A validated route whose handler breaks its contract",
      tags: ["Jobs"],
      query: s.query(s.object({ x: s.optional(s.string()) })),
      responses: { 200: s.object({ ok: s.boolean() }) },
      handler: () => ({ body: { ok: "yes" } as unknown as { ok: boolean } }),
    });
    const { api } = build({ websocket: false }, [wrong]);
    const host = new BunRouter({ responseValidation: "error" });
    host.use(api.basePath, api.router);
    const response = await host.fetch("/admin/jobs/wrong-with-query?x=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: "yes" });
    expect((await host.fetch("/admin/jobs/meta")).status).toBe(200);
  });
});
