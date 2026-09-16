import type { JsonSchema } from "../../lib/api/schema/validate";
import type { BunJobs } from "../../lib/index";
import { afterAll, describe, expect, it } from "bun:test";
import { resolveConfig } from "../../lib/api/config";
import { createJobsApi } from "../../lib/api/createJobsApi";
import { defineRoute } from "../../lib/api/routes/define";
import { s, toJsonSchema } from "../../lib/api/schema/builder";
import { isDateTime, validateJson } from "../../lib/api/schema/validate";
import { QueueSource, RunnerSource } from "../../lib/api/sources";
import { generateOpenApi } from "../../lib/api/spec/openapi";
import { danglingRefs } from "../../lib/api/spec/refs";
import { ConfigError } from "../../lib/index";
import {
  apiConfig,
  ECHO_HANDLER,
  jobsContext,
  openContexts,
  registerRunnerElsewhere,
} from "./fixtures";

/**
 * The edges the review found: what the validator must refuse, what the
 * generator must refuse to name twice, what a cache must not forget, and what
 * the document must say — none of which a happy-path test reaches.
 */

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

describe("component names", () => {
  /** A route answering with `schema`. */
  const route = (id: string, schema: ReturnType<typeof s.object>) =>
    defineRoute({
      method: "GET",
      path: `/${id}`,
      operationId: id,
      action: "jobs.read",
      mode: "jobs",
      summary: id,
      tags: ["Jobs"],
      responses: { 200: schema },
      handler: () => ({ body: {} }) as never,
    });

  it("refuses two different schemas under one component name", () => {
    const config = resolveConfig(apiConfig());
    const one = s.named("Thing", s.object({ a: s.string() }));
    const other = s.named("Thing", s.object({ b: s.integer() }));
    expect(() =>
      generateOpenApi([route("one", one), route("two", other)], config),
    ).toThrow(ConfigError);
    expect(() =>
      generateOpenApi([route("one", one), route("two", other)], config),
    ).toThrow(/both named "Thing"/);

    // Including a name the API's own components use.
    const impostor = s.named("Problem", s.object({ mine: s.boolean() }));
    expect(() => generateOpenApi([route("p", impostor)], config)).toThrow(
      /both named "Problem"/,
    );
  });

  it("keeps one schema used twice as a single component", () => {
    const config = resolveConfig(apiConfig());
    const shared = s.named("Shared", s.object({ a: s.string() }));
    const document = generateOpenApi(
      [route("one", shared), route("two", shared)],
      config,
    );
    const schemas = (
      document.components as { schemas: Record<string, unknown> }
    ).schemas;
    expect(schemas.Shared).toBeDefined();
    expect(danglingRefs(document)).toEqual([]);
  });
});

describe("the validator's edges", () => {
  it("refuses integers a number cannot hold exactly", () => {
    const integer = { type: "integer" } as const;
    expect(validateJson(integer, 2 ** 53 - 1)).toEqual({ value: 2 ** 53 - 1 });
    expect(validateJson(integer, 2 ** 53)).toHaveProperty("issues");
    expect(validateJson(integer, 2 ** 53 + 2)).toHaveProperty("issues");
    expect(validateJson({ type: "integer", minimum: 0 }, 1e300)).toHaveProperty(
      "issues",
    );
    // The message names what it got, not "integer" twice over.
    const result = validateJson(integer, 2 ** 53 + 2) as {
      issues: { message: string }[];
    };
    expect(result.issues[0]!.message).toBe("Expected integer, received number");

    // A coerced query value is held to the same rule.
    const query = s.query(s.object({ n: s.integer() }));
    expect(
      query["~standard"].validate({ n: "9007199254740993" }),
    ).toHaveProperty("issues");
  });

  it("refuses a date-time no clock can hold", () => {
    expect(isDateTime("2020-06-30T23:59:59Z")).toBe(true);
    expect(isDateTime("2020-06-30T12:00:60Z")).toBe(false);
    expect(Number.isNaN(Date.parse("2020-06-30T12:00:60Z"))).toBe(true);
    expect(
      validateJson(
        { type: "string", format: "date-time" },
        "2020-06-30T12:00:60Z",
      ),
    ).toHaveProperty("issues");
  });

  it("drops unknown query keys but refuses unknown body fields", () => {
    const query = s.query(s.object({ limit: s.optional(s.integer()) }));
    expect(
      query["~standard"].validate({ limit: "5", _: "123", utm_source: "x" }),
    ).toEqual({ value: { limit: 5 } });

    const body = s.object({ limit: s.optional(s.integer()) });
    expect(body["~standard"].validate({ limit: 5, extra: 1 })).toHaveProperty(
      "issues",
    );
  });

  it("does not require a property that has a default", () => {
    const schema = s.object({
      limit: s.integer({ default: 20 }),
      name: s.string(),
    });
    expect(schema.json.required).toEqual(["name"]);
    expect(schema["~standard"].validate({ name: "x" })).toEqual({
      value: { name: "x", limit: 20 },
    });
  });
});

describe("the generated document", () => {
  it("documents 413 wherever a body is read, body schema or not", () => {
    const document = createJobsApi(apiConfig()).openapi();
    const paths = document.paths as Record<
      string,
      Record<
        string,
        { responses: Record<string, { "x-bun-jobs-codes"?: string[] }> }
      >
    >;
    // A mutation with no body schema still reads (and caps) a body.
    const pause = paths["/queues/{queue}/pause"]!.post!.responses;
    expect(pause["413"]!["x-bun-jobs-codes"]).toEqual(["PAYLOAD_TOO_LARGE"]);
    expect(pause["400"]!["x-bun-jobs-codes"]).toContain("INVALID_JSON");
    // A read with no body documents neither.
    const meta = paths["/meta"]!.get!.responses;
    expect(meta["413"]).toBeUndefined();
  });

  /** Every keyword the WU1 validator interprets, plus the ones documents carry. */
  const KEYWORDS = new Set([
    "$ref",
    "additionalProperties",
    "anyOf",
    "const",
    "default",
    "description",
    "enum",
    "format",
    "items",
    "maxItems",
    "maxLength",
    "maximum",
    "minItems",
    "minLength",
    "minimum",
    "pattern",
    "properties",
    "required",
    "type",
  ]);

  it("emits only schema keywords the validator interprets", () => {
    // A CI-safe structural check: it holds whether or not ajv is installed,
    // and catches a generator that starts emitting something the runtime
    // validator would ignore.
    const document = createJobsApi(apiConfig()).openapi();
    const problems: string[] = [];

    const visit = (node: unknown, where: string) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return;
      }
      const schema = node as JsonSchema & Record<string, unknown>;
      for (const key of Object.keys(schema)) {
        if (!KEYWORDS.has(key)) {
          problems.push(`${where}: ${key}`);
        }
      }
      if (typeof schema.pattern === "string") {
        try {
          void new RegExp(schema.pattern, "u");
        } catch {
          problems.push(`${where}: pattern does not compile`);
        }
      }
      if (schema.format !== undefined && schema.format !== "date-time") {
        problems.push(`${where}: format ${String(schema.format)}`);
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        visit(child, `${where}/properties/${key}`);
      }
      if (typeof schema.additionalProperties === "object") {
        visit(schema.additionalProperties, `${where}/additionalProperties`);
      }
      visit(schema.items, `${where}/items`);
      (schema.anyOf ?? []).forEach((member, index) =>
        visit(member, `${where}/anyOf/${index}`),
      );
    };

    const components = (
      document.components as { schemas: Record<string, JsonSchema> }
    ).schemas;
    for (const [name, schema] of Object.entries(components)) {
      visit(schema, `#/components/schemas/${name}`);
    }
    expect(problems).toEqual([]);
  });

  it("emits a named schema through toJsonSchema as a reference, once", () => {
    const named = s.named("Once", s.object({ a: s.string() }));
    const components = new Map<string, JsonSchema>();
    const names = new Map<string, JsonSchema>();
    expect(toJsonSchema(named, { components, names })).toEqual({
      $ref: "#/components/schemas/Once",
    });
    expect([...components.keys()]).toEqual(["Once"]);
    // A different schema under that name, in the same document, is refused.
    const clash = s.named("Once", s.object({ b: s.string() }));
    expect(() => toJsonSchema(clash, { components, names })).toThrow(
      ConfigError,
    );
  });
});

describe("membership caches", () => {
  it("does not lose an invalidation that arrives mid-read", async () => {
    let names = ["a"];
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const jobs = {
      listQueues: async () => {
        loads++;
        const snapshot = [...names];
        await gate;
        return snapshot;
      },
    } as unknown as BunJobs;
    const source = new QueueSource({
      jobs,
      queues: "all",
      limits: { queueCacheMs: 60_000 } as never,
    });

    const first = source.has("b");
    names = ["a", "b"];
    source.invalidate();
    release();
    expect(await first).toBe(false);
    // The read that started before the invalidation must not have been cached.
    expect(await source.has("b")).toBe(true);
    expect(loads).toBe(2);
  });

  it("shares one cached discovery between listing and resolving a runner", async () => {
    const jobs = jobsContext("api-hardening");
    jobs.runner({
      id: "local",
      file: ECHO_HANDLER,
      executionMode: "in-process",
    });
    await registerRunnerElsewhere(jobs, "remote");
    let discoveries = 0;
    const discover = jobs.runners.discover.bind(jobs.runners);
    jobs.runners.discover = async () => {
      discoveries++;
      return await discover();
    };

    const config = resolveConfig(
      apiConfig({ jobs, limits: { queueCacheMs: 60_000 } }),
    );
    const source = new RunnerSource(config);
    await source.list();
    await source.resolve("remote");
    await source.resolve("remote");
    // A local runner needs no discovery at all.
    await source.resolve("local");
    expect(discoveries).toBe(1);

    source.invalidate();
    await source.resolve("remote");
    expect(discoveries).toBe(2);
  });
});
