import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import type { JsonSchema } from "../../lib/api/schema/validate";
import { BunRouter, validate, ValidationError } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { s, toJsonSchema } from "../../lib/api/schema/builder";
import {
  coerceArray,
  coerceBoolean,
  coerceNumber,
} from "../../lib/api/schema/coerce";
import { isDateTime, validateJson } from "../../lib/api/schema/validate";
import {
  JOB_STATES,
  JobStateSchema,
  ProblemSchema,
} from "../../lib/api/schemas/common";

/** Runs a schema and returns its Standard Schema result, synchronously. */
function run(
  schema: { "~standard": { validate: (value: unknown) => unknown } },
  value: unknown,
) {
  return schema["~standard"].validate(value) as
    | { value: unknown; issues?: undefined }
    | { issues: { message: string; path?: PropertyKey[] }[] };
}

/** The issues of a failing result, as `path: message` strings. */
function issuesOf(result: ReturnType<typeof run>): string[] {
  if (!result.issues) {
    throw new Error(
      `expected issues, got value ${JSON.stringify(result.value)}`,
    );
  }
  return result.issues.map(
    (issue) => `${(issue.path ?? []).join(".")}: ${issue.message}`,
  );
}

/** The value of a passing result. */
function valueOf(result: ReturnType<typeof run>): unknown {
  if (result.issues) {
    throw new Error(`expected a value, got ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

describe("schema builder", () => {
  it("emits plain JSON Schema, deep-frozen", () => {
    const schema = s.object({
      name: s.string({ minLength: 1 }),
      tags: s.optional(s.array(s.string(), { maxItems: 3 })),
    });
    expect(schema.json).toEqual({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        tags: { type: "array", items: { type: "string" }, maxItems: 3 },
      },
      required: ["name"],
      additionalProperties: false,
    });
    expect(Object.isFrozen(schema.json)).toBe(true);
    expect(Object.isFrozen(schema.json.properties!.tags!.items)).toBe(true);
  });

  it("implements Standard Schema V1", () => {
    const schema = s.string();
    expect(schema["~standard"].version).toBe(1);
    expect(schema["~standard"].vendor).toBe("bun-jobs");
    expect(valueOf(run(schema, "x"))).toBe("x");
  });

  it("emits named components as $ref, once, and refuses two schemas under one name", () => {
    const Item = s.named("Item", s.object({ id: s.string() }));
    const List = s.object({
      first: Item,
      rest: s.array(Item),
      maybe: s.nullable(Item),
    });
    const components = new Map<string, JsonSchema>();
    const emitted = toJsonSchema(List, { components });

    expect(emitted.properties!.first).toEqual({
      $ref: "#/components/schemas/Item",
    });
    expect(emitted.properties!.rest!.items).toEqual({
      $ref: "#/components/schemas/Item",
    });
    expect(emitted.properties!.maybe!.anyOf![0]).toEqual({
      $ref: "#/components/schemas/Item",
    });
    expect([...components.keys()]).toEqual(["Item"]);
    expect(components.get("Item")).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
    // The root itself is a reference unless asked to be inlined.
    expect(toJsonSchema(Item)).toEqual({ $ref: "#/components/schemas/Item" });
    expect(toJsonSchema(Item, { inlineRoot: true }).type).toBe("object");
    // Emitted objects are fresh, not the frozen originals.
    expect(Object.isFrozen(emitted)).toBe(false);

    const Other = s.named("Item", s.object({ other: s.string() }));
    expect(() => toJsonSchema(s.object({ a: Item, b: Other }))).toThrow(
      /both named "Item"/,
    );
    expect(() => s.named("bad name", s.string())).toThrow(/may only contain/);
  });

  it("refuses patterns it cannot express, and unusable bounds", () => {
    expect(() => s.string({ pattern: /abc/i })).toThrow(/no flags/);
    expect(() => s.string({ pattern: "(" })).toThrow();
    expect(() => s.integer({ minimum: Number.NaN })).toThrow(/finite/);
    expect(() => s.array(s.string(), { maxItems: -1 })).toThrow(/non-negative/);
    expect(() => s.enum(["a", "a"])).toThrow(/repeat/);
  });

  it("lists every job state, as the named JobState component", () => {
    expect(JobStateSchema.ref).toBe("JobState");
    expect(JobStateSchema.json.enum).toEqual([...JOB_STATES]);
    expect(issuesOf(run(JobStateSchema, "sleeping"))).toEqual([
      `: Expected one of ${JOB_STATES.map((state) => JSON.stringify(state)).join(", ")}`,
    ]);
  });
});

describe("validation", () => {
  it("checks types, telling integer from number", () => {
    expect(valueOf(run(s.integer(), 3))).toBe(3);
    expect(issuesOf(run(s.integer(), 3.5))).toEqual([
      ": Expected integer, received number",
    ]);
    expect(issuesOf(run(s.number(), Number.POSITIVE_INFINITY))).toEqual([
      ": Expected number, received Infinity",
    ]);
    expect(issuesOf(run(s.string(), 1))).toEqual([
      ": Expected string, received integer",
    ]);
    expect(issuesOf(run(s.boolean(), "true"))).toEqual([
      ": Expected boolean, received string",
    ]);
    expect(issuesOf(run(s.object({}), []))).toEqual([
      ": Expected object, received array",
    ]);
    expect(issuesOf(run(s.string(), undefined))).toEqual([": Required"]);
  });

  it("checks bounds and lengths, counting code points", () => {
    const Priority = s.integer({ minimum: 0, maximum: 10 });
    expect(issuesOf(run(Priority, -1))).toEqual([
      ": Expected a value of at least 0",
    ]);
    expect(issuesOf(run(Priority, 11))).toEqual([
      ": Expected a value of at most 10",
    ]);
    expect(valueOf(run(Priority, 10))).toBe(10);

    const One = s.string({ minLength: 1, maxLength: 1 });
    // One code point, two UTF-16 units: JSON Schema counts it as one.
    expect(valueOf(run(One, "😀"))).toBe("😀");
    expect(issuesOf(run(One, ""))).toEqual([
      ": Expected at least 1 characters",
    ]);
    expect(issuesOf(run(One, "ab"))).toEqual([
      ": Expected at most 1 characters",
    ]);
  });

  it("checks patterns and RFC 3339 date-times", () => {
    const Name = s.string({ pattern: "^[a-z]+$" });
    expect(valueOf(run(Name, "abc"))).toBe("abc");
    expect(issuesOf(run(Name, "ABC"))).toEqual([
      ": Expected a value matching ^[a-z]+$",
    ]);

    const At = s.string({ format: "date-time" });
    expect(valueOf(run(At, "2026-09-15T10:00:00Z"))).toBe(
      "2026-09-15T10:00:00Z",
    );
    expect(valueOf(run(At, "2026-09-15T10:00:00.123+01:00"))).toBe(
      "2026-09-15T10:00:00.123+01:00",
    );
    expect(isDateTime("2024-02-29T00:00:00Z")).toBe(true);
    expect(isDateTime("2026-02-29T00:00:00Z")).toBe(false);
    expect(isDateTime("2026-13-01T00:00:00Z")).toBe(false);
    expect(isDateTime("2026-09-15T24:00:00Z")).toBe(false);
    expect(isDateTime("2026-09-15")).toBe(false);
    expect(issuesOf(run(At, "tomorrow"))).toEqual([
      ": Expected an RFC 3339 date-time",
    ]);
  });

  it("checks literals, enums and arrays", () => {
    expect(issuesOf(run(s.literal("started"), "queued"))).toEqual([
      ': Expected "started"',
    ]);
    expect(s.literal(3).json).toEqual({ type: "integer", const: 3 });

    const Ids = s.array(s.string({ minLength: 1 }), {
      minItems: 1,
      maxItems: 2,
    });
    expect(issuesOf(run(Ids, []))).toEqual([": Expected at least 1 items"]);
    expect(issuesOf(run(Ids, ["a", "b", "c"]))).toEqual([
      ": Expected at most 2 items",
    ]);
    expect(issuesOf(run(Ids, ["a", ""]))).toEqual([
      "1: Expected at least 1 characters",
    ]);
  });

  it("reports every object issue with its path, and refuses unknown properties", () => {
    const Body = s.object({
      name: s.string(),
      opts: s.object({ priority: s.integer({ minimum: 0 }) }),
    });
    expect(
      issuesOf(run(Body, { opts: { priority: -1 }, extra: true })),
    ).toEqual([
      "name: Required",
      "opts.priority: Expected a value of at least 0",
      "extra: Unknown property",
    ]);

    const Open = s.object({ a: s.string() }, { additionalProperties: true });
    expect(valueOf(run(Open, { a: "x", b: 1 }))).toEqual({ a: "x", b: 1 });

    const Counts = s.record(s.integer());
    expect(valueOf(run(Counts, { waiting: 1 }))).toEqual({ waiting: 1 });
    expect(issuesOf(run(Counts, { waiting: "1" }))).toEqual([
      "waiting: Expected integer, received string",
    ]);
  });

  it("applies defaults, as copies, without touching the input", () => {
    const Options = s.object({
      limit: s.optional(s.integer({ default: 20 })),
      filter: s.optional(
        s.object({ tags: s.array(s.string()) }, { additionalProperties: true }),
      ),
    });
    const withDefault = s.object({ nested: s.optional(s.unknown()) });
    const input = {};
    expect(valueOf(run(Options, input))).toEqual({ limit: 20 });
    expect(input).toEqual({});
    expect(valueOf(run(withDefault, {}))).toEqual({});

    // An object default is cloned per validation, so one caller's mutation
    // cannot leak into the next request.
    const Frozen = s.object({
      page: s.optional(
        s.object({ size: s.integer() }, { additionalProperties: true }),
      ),
    });
    const fromJson = {
      ...Frozen.json,
      properties: {
        page: { ...Frozen.json.properties!.page!, default: { size: 5 } },
      },
    };
    const first = valueOf(validateJson(fromJson, {} as unknown) as never) as {
      page: { size: number };
    };
    first.page.size = 99;
    expect(valueOf(validateJson(fromJson, {}) as never)).toEqual({
      page: { size: 5 },
    });
  });

  it("never lets a __proto__ key replace the output's prototype", () => {
    const Open = s.object({}, { additionalProperties: true });
    const input = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    const output = valueOf(run(Open, input)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect((output as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.hasOwn(output, "__proto__")).toBe(true);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("accepts null through nullable and reports the member that was meant", () => {
    const MaybeName = s.nullable(s.object({ name: s.string() }));
    expect(valueOf(run(MaybeName, null))).toBeNull();
    expect(issuesOf(run(MaybeName, { name: 1 }))).toEqual([
      "name: Expected string, received integer",
    ]);
    expect(issuesOf(run(MaybeName, "x"))).toEqual([
      ": Expected object or null, received string",
    ]);
  });

  it("picks the discriminated union member a value aimed at", () => {
    const Outcome = s.union(
      s.object({ outcome: s.literal("started"), runId: s.string() }),
      s.object({ outcome: s.literal("queued"), position: s.integer() }),
    );
    expect(valueOf(run(Outcome, { outcome: "queued", position: 2 }))).toEqual({
      outcome: "queued",
      position: 2,
    });
    // Aimed at "queued": only its issue is reported, not "started"'s.
    expect(issuesOf(run(Outcome, { outcome: "queued" }))).toEqual([
      "position: Required",
    ]);
    expect(issuesOf(run(Outcome, { outcome: "skipped" }))).toEqual([
      ": Expected object or object, received object",
    ]);

    const RunAt = s.union(
      s.integer({ minimum: 0 }),
      s.string({ format: "date-time" }),
    );
    expect(valueOf(run(RunAt, 5))).toBe(5);
    expect(valueOf(run(RunAt, "2026-09-15T00:00:00Z"))).toBe(
      "2026-09-15T00:00:00Z",
    );
    expect(issuesOf(run(RunAt, "soon"))).toEqual([
      ": Expected an RFC 3339 date-time",
    ]);
  });

  it("validates the Problem schema against a real problem body", () => {
    expect(
      valueOf(
        run(ProblemSchema, {
          type: "urn:bun-jobs:error:JOB_NOT_FOUND",
          title: "Job not found",
          status: 404,
          code: "JOB_NOT_FOUND",
          issues: [{ target: "query", path: "limit", message: "Required" }],
        }),
      ),
    ).toBeDefined();
    expect(
      issuesOf(
        run(ProblemSchema, { type: "x", title: "y", status: 99, code: "z" }),
      ),
    ).toEqual(["status: Expected a value of at least 100"]);
  });
});

describe("coercion", () => {
  it("turns decimal strings into numbers and nothing else", () => {
    expect(coerceNumber("42")).toBe(42);
    expect(coerceNumber(" -1.5 ")).toBe(-1.5);
    expect(coerceNumber("1e3")).toBe(1000);
    expect(coerceNumber("0x10")).toBeUndefined();
    expect(coerceNumber("")).toBeUndefined();
    expect(coerceNumber("Infinity")).toBeUndefined();
    expect(coerceBoolean("TRUE")).toBe(true);
    expect(coerceBoolean("0")).toBe(false);
    expect(coerceBoolean("yes")).toBeUndefined();
    expect(coerceArray("a,b")).toEqual(["a", "b"]);
    expect(coerceArray("")).toEqual([]);
    expect(coerceArray(["a,b"])).toEqual(["a,b"]);
  });

  it("coerces only under s.query", () => {
    const Page = s.object({ limit: s.integer(), total: s.boolean() });
    // The control: without `s.query`, a string is a string.
    expect(issuesOf(run(Page, { limit: "5", total: "true" }))).toEqual([
      "limit: Expected integer, received string",
      "total: Expected boolean, received string",
    ]);
    expect(valueOf(run(s.query(Page), { limit: "5", total: "true" }))).toEqual({
      limit: 5,
      total: true,
    });
    expect(s.query(Page).coerce).toBe(true);
    expect(Page.coerce).toBe(false);
    expect(s.query(Page).json).toBe(Page.json);
  });

  it("builds arrays from repeated keys and comma lists, and refuses several values for a scalar", () => {
    const Query = s.query(
      s.object({
        state: s.optional(s.array(s.enum(["waiting", "failed"]))),
        limit: s.optional(s.integer({ default: 20 })),
      }),
    );
    expect(valueOf(run(Query, { state: "waiting,failed" }))).toEqual({
      state: ["waiting", "failed"],
      limit: 20,
    });
    expect(valueOf(run(Query, { state: ["waiting", "failed"] }))).toEqual({
      state: ["waiting", "failed"],
      limit: 20,
    });
    expect(valueOf(run(Query, { state: "waiting" }))).toEqual({
      state: ["waiting"],
      limit: 20,
    });
    expect(issuesOf(run(Query, { state: "waiting,nope" }))).toEqual([
      'state.1: Expected one of "waiting", "failed"',
    ]);
    expect(issuesOf(run(Query, { limit: ["1", "2"] }))).toEqual([
      "limit: Expected a single value, received several",
    ]);
    expect(issuesOf(run(Query, { limit: "ten" }))).toEqual([
      "limit: Expected integer, received string",
    ]);
  });
});

describe("through bun-common's validate() and router.fetch()", () => {
  /** A router rendering validation failures as `{ issues }`, the way the API's error handler reads them. */
  function router() {
    const r = new BunRouter();
    const Query = s.query(
      s.object({
        state: s.optional(s.array(s.enum(JOB_STATES))),
        limit: s.optional(s.integer({ minimum: 1, maximum: 100, default: 20 })),
        order: s.optional(s.enum(["asc", "desc"], { default: "asc" })),
      }),
    );
    const Params = s.query(s.object({ id: s.integer({ minimum: 1 }) }));
    const Body = s.object({
      ids: s.array(s.string({ minLength: 1 }), { maxItems: 3 }),
      opts: s.optional(
        s.object({
          priority: s.optional(s.integer({ minimum: 0 })),
          runAt: s.optional(
            s.union(
              s.integer({ minimum: 0 }),
              s.string({ format: "date-time" }),
            ),
          ),
        }),
      ),
    });

    r.get("/jobs", validate({ query: Query }), (req, res) => {
      return res.json({ query: req.query });
    });
    r.get("/jobs/:id", validate({ params: Params }), (req, res) => {
      return res.json({ params: req.params });
    });
    r.post("/jobs", validate({ body: Body }), (req, res) => {
      return res.json({ body: req.body });
    });
    r.use(((error, _req, res, _next) => {
      if (error instanceof ValidationError) {
        return res.status(400).json({ issues: error.issues });
      }
      return res.status(500).json({ error: String(error) });
    }) satisfies RouterErrorMiddlewareHandler);
    return r;
  }

  it("hands the handler coerced, defaulted query values", async () => {
    const response = await router().fetch(
      "/jobs?state=waiting&state=failed&limit=5",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      query: { state: ["waiting", "failed"], limit: 5, order: "asc" },
    });

    const csv = await router().fetch("/jobs?state=waiting,dead");
    expect(await csv.json()).toEqual({
      query: { state: ["waiting", "dead"], limit: 20, order: "asc" },
    });
  });

  it("reports query issues with target and dotted path, ignoring unknown keys", async () => {
    const response = await router().fetch(
      "/jobs?state=waiting,nope&limit=500&extra=1",
    );
    expect(response.status).toBe(400);
    // `extra` is not an issue: a query schema drops what it does not declare,
    // so a cache-buster or a `utm_*` tag cannot fail a request.
    expect(await response.json()).toEqual({
      issues: [
        {
          target: "query",
          path: "state.1",
          message: `Expected one of ${JOB_STATES.map((state) => JSON.stringify(state)).join(", ")}`,
        },
        {
          target: "query",
          path: "limit",
          message: "Expected a value of at most 100",
        },
      ],
    });

    const ignored = await router().fetch("/jobs?limit=5&_=1736&utm_source=x");
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({
      query: { limit: 5, order: "asc" },
    });
  });

  it("coerces path params", async () => {
    expect(await (await router().fetch("/jobs/42")).json()).toEqual({
      params: { id: 42 },
    });
    expect(await (await router().fetch("/jobs/zero")).json()).toEqual({
      issues: [
        {
          target: "params",
          path: "id",
          message: "Expected integer, received string",
        },
      ],
    });
  });

  it("reports body issues at nested paths and array indexes, and does not coerce bodies", async () => {
    const post = (body: unknown) =>
      router().fetch("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const ok = await post({
      ids: ["a"],
      opts: { runAt: "2026-09-15T00:00:00Z" },
    });
    expect(await ok.json()).toEqual({
      body: { ids: ["a"], opts: { runAt: "2026-09-15T00:00:00Z" } },
    });

    const bad = await post({
      ids: ["a", ""],
      opts: { priority: "1", runAt: "later" },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      issues: [
        {
          target: "body",
          path: "ids.1",
          message: "Expected at least 1 characters",
        },
        {
          target: "body",
          path: "opts.priority",
          message: "Expected integer, received string",
        },
        {
          target: "body",
          path: "opts.runAt",
          message: "Expected an RFC 3339 date-time",
        },
      ],
    });

    const tooMany = await post({ ids: ["a", "b", "c", "d"] });
    expect(await tooMany.json()).toEqual({
      issues: [
        { target: "body", path: "ids", message: "Expected at most 3 items" },
      ],
    });
  });
});
