/**
 * Reading contracts back (plan §4.1.5) and the §4.12 items V1 owns:
 * declared sides and keys (B1), row kinds (M4), wire encodings (m3), the
 * canonical row order (m1), `mergeContracts` (M3, Q-C11), `documented()`
 * (M6, Q-C12), and JSON Schema on `recordOf` and `toStandardSchema` (m10).
 */
import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import { z } from "zod";
import { toStandardSchema } from "../../lib/BunValidate";
import { describeContract, mergeContracts } from "../../lib/contract/describe";
import { createReceiver } from "../../lib/contract/guard";
import { validateStandard } from "../../lib/contract/issues";
import {
  documented,
  kindOf,
  markKind,
  recordOf,
} from "../../lib/contract/schemas";
import { createTestLogger } from "../../lib/logging";
import { broker, http, jobs, ws } from "./fixtures";

/** The rows without their schemas, for comparison. */
const rows = (c: Parameters<typeof describeContract>[0]) =>
  describeContract(c).entries.map(({ schema: _s, ...rest }) => rest);

describe("describeContract: declared sides and keys (B1)", () => {
  it("keeps a key with no parts, and tells a declared-empty side from an absent one", () => {
    const c = http.contract({
      outbound: { 202: {}, 200: { body: z.string() } },
    });
    const d = describeContract(c);
    expect(d.sides).toEqual({
      outbound: { declared: true, keys: ["200", "202"] },
    });
    expect(d.entries.map((e) => e.key)).toEqual(["200"]);

    expect(describeContract(http.contract({ outbound: {} })).sides).toEqual({
      outbound: { declared: true, keys: [] },
    });
    expect(describeContract(http.contract({})).sides).toEqual({});
    expect(describeContract(http.contract({ inbound: {} })).sides).toEqual({
      inbound: { declared: true },
    });
  });

  it("states the transport, its wire and the contract's meta", () => {
    const d = describeContract(
      jobs.contract({}, { name: "send-mail", description: "Sends one" }),
    );
    expect([d.transport, d.wire, d.meta]).toEqual([
      "jobs",
      "identity",
      { name: "send-mail", description: "Sends one" },
    ]);
    expect(describeContract(ws.contract({})).wire).toBe("json");
  });
});

describe("describeContract: rows (C20, M4, m3, m1)", () => {
  const User = z.object({ id: z.string() });
  const route = http.contract(
    {
      inbound: {
        body: User,
        query: z.object({ q: z.string() }),
        params: z.object({ id: z.string() }),
        headers: z.object({ "x-a": z.string() }),
      },
      outbound: {
        "201": {
          headers: z.object({ location: z.string() }),
          body: { "text/plain": z.string(), "application/json": User },
        },
        "404": {
          body: { "application/json": z.object({ title: z.string() }) },
        },
        "20": { body: null },
        "204": { body: null },
        default: {},
      },
    },
    { name: "createUser" },
  );

  it("emits one row per (side, key, part, media type) in canonical order, with encodings", () => {
    expect(rows(route)).toEqual([
      {
        side: "inbound",
        part: "headers",
        encoding: "header-string",
        kind: "value",
        vendor: "zod",
      },
      {
        side: "inbound",
        part: "params",
        encoding: "path-string",
        kind: "value",
        vendor: "zod",
      },
      {
        side: "inbound",
        part: "query",
        encoding: "querystring",
        kind: "value",
        vendor: "zod",
      },
      {
        side: "inbound",
        part: "body",
        encoding: "body",
        kind: "value",
        vendor: "zod",
      },
      {
        side: "outbound",
        keyName: "status",
        key: "20",
        part: "body",
        encoding: "body",
        kind: "value",
      },
      {
        side: "outbound",
        keyName: "status",
        key: "201",
        part: "headers",
        encoding: "header-string",
        kind: "value",
        vendor: "zod",
      },
      {
        side: "outbound",
        keyName: "status",
        key: "201",
        part: "body",
        mediaType: "application/json",
        encoding: "body",
        kind: "value",
        vendor: "zod",
      },
      {
        side: "outbound",
        keyName: "status",
        key: "201",
        part: "body",
        mediaType: "text/plain",
        encoding: "body",
        kind: "value",
        vendor: "zod",
      },
      {
        side: "outbound",
        keyName: "status",
        key: "204",
        part: "body",
        encoding: "body",
        kind: "value",
      },
      {
        side: "outbound",
        keyName: "status",
        key: "404",
        part: "body",
        mediaType: "application/json",
        encoding: "body",
        kind: "value",
        vendor: "zod",
      },
    ]);
    expect(describeContract(route).sides.outbound?.keys).toEqual([
      "20",
      "201",
      "204",
      "404",
      "default",
    ]);
    expect(
      describeContract(route).entries.find((e) => e.key === "204")!.schema,
    ).toBeNull();
  });

  it("hands over each schema and its JSON Schema, which the core never converts", () => {
    const entry = describeContract(route).entries.find(
      (e) => e.part === "params",
    )!;
    const json = (
      entry.schema!["~standard"] as unknown as {
        jsonSchema: {
          input: (o: { target: string }) => Record<string, unknown>;
        };
      }
    ).jsonSchema.input({ target: "draft-2020-12" });
    expect(json).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
    });
  });

  it("records a part's kind when a helper marked it, and value otherwise (M4)", () => {
    const stream = markKind(z.string(), "chunks");
    expect(kindOf(stream)).toBe("chunks");
    expect(kindOf(z.string())).toBe("value");
    const c = http.contract({
      outbound: { 200: { body: { "application/x-ndjson": stream } } },
    });
    expect(describeContract(c).entries.map((e) => e.kind)).toEqual(["chunks"]);
    expect(Object.keys(stream)).not.toContain("kind");
  });

  it("encodes outbound cookies as set-cookie and request cookies as cookie strings (m3)", () => {
    const c = http.contract({
      inbound: {
        cookies: z.object({ sid: z.string() }),
        signedCookies: z.object({ uid: z.string() }),
      },
      outbound: { 200: { cookies: z.object({ sid: z.string() }) } },
    });
    expect(
      describeContract(c).entries.map((e) => [e.side, e.part, e.encoding]),
    ).toEqual([
      ["inbound", "cookies", "cookie-string"],
      ["inbound", "signedCookies", "signed-cookie"],
      ["outbound", "cookies", "set-cookie"],
    ]);
  });
});

describe("mergeContracts (M3, Q-C11)", () => {
  const RawPage = z.object({ page: z.coerce.number() });
  const Refined = z.object({ page: z.number().max(10) });

  it("inbound: the outermost layer is the wire schema, and an inner one refining it warns", () => {
    const { logger, events } = createTestLogger();
    const router = http.contract({ inbound: { query: RawPage } });
    const route = http.contract({
      inbound: { query: Refined, body: z.string() },
    });
    const merged = mergeContracts(
      [
        { contract: router, origin: "router /posts" },
        { contract: route, origin: "GET /posts" },
      ],
      { logger },
    );
    const entries = describeContract(merged).entries;
    expect(entries.map((e) => [e.part, e.origin])).toEqual([
      ["query", "router /posts"],
      ["body", "GET /posts"],
    ]);
    expect(entries[0].schema).toBe(RawPage);
    expect(events.map((e) => [e.level, e.message, e.fields])).toEqual([
      [
        "warn",
        "contract part refined by an inner layer",
        {
          transport: "http",
          side: "inbound",
          part: "query",
          wire: "router /posts",
          refinedBy: ["GET /posts"],
        },
      ],
    ]);
  });

  it("outbound: the route beats the router beats the adapter, and every row records its origin", () => {
    const { logger, events } = createTestLogger();
    const adapter = http.contract({
      outbound: {
        500: { body: z.object({ error: z.string() }) },
        404: { body: z.string() },
      },
    });
    const router = http.contract({
      outbound: { 404: { body: z.object({ title: z.string() }) }, 401: {} },
    });
    const routeBody = z.object({ id: z.string() });
    const route = http.contract({
      outbound: { 200: { body: routeBody }, 404: { body: null } },
    });
    const merged = mergeContracts(
      [
        { contract: adapter, origin: "adapter" },
        { contract: router, origin: "router" },
        { contract: route, origin: "GET /users/:id" },
      ],
      { logger },
    );
    const d = describeContract(merged);
    expect(d.sides.outbound?.keys).toEqual(["200", "401", "404", "500"]);
    expect(
      d.entries.map((e) => [
        e.key,
        e.origin,
        e.schema === null ? "null" : e.vendor,
      ]),
    ).toEqual([
      ["200", "GET /users/:id", "zod"],
      ["404", "GET /users/:id", "null"],
      ["500", "adapter", "zod"],
    ]);
    expect(events).toEqual([]);
    // The merged contract guards like any other.
    const r = createReceiver(merged, "outbound")({ status: 404, body: "x" });
    expect((r as { issues: unknown }).issues).toEqual([
      {
        target: "body",
        path: "",
        key: "404",
        message: "No body is declared here",
      },
    ]);
  });

  it("refuses layers of different transports, and no layers", () => {
    expect(() =>
      mergeContracts([
        { contract: http.contract({}), origin: "a" },
        { contract: jobs.contract({}) as never, origin: "b" },
      ]),
    ).toThrow('every layer must be for one transport ("http", not "jobs")');
    expect(() => mergeContracts([])).toThrow(TypeError);
  });

  it("a merge without layers declaring a side leaves it undeclared", () => {
    const merged = mergeContracts([
      { contract: broker.contract({ inbound: { t: {} } }), origin: "x" },
    ]);
    expect(describeContract(merged).sides).toEqual({
      inbound: { declared: true, keys: ["t"] },
    });
  });
});

describe("documented() (M6, Q-C12)", () => {
  const json = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  };

  it("documents and never checks", async () => {
    const legacy = documented<{ id: string }>(json);
    const anything = { id: 42 };
    expect<unknown>(await validateStandard(legacy, anything, "body")).toEqual({
      ok: true,
      value: anything,
    });
    expect(
      legacy["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
    ).toEqual(json);
    expect(legacy["~standard"].vendor).toBe("bun-common/documented");
    const c = jobs.contract({ inbound: { data: legacy } });
    expect(createReceiver(c, "inbound").checks).toBe(false);
    expect(describeContract(c).entries.map((e) => [e.part, e.vendor])).toEqual([
      ["data", "bun-common/documented"],
    ]);
  });

  it("takes a converter too, and refuses anything but an object", () => {
    const d = documented({
      input: () => ({ type: "string" }),
      output: () => ({ type: "number" }),
    });
    expect(d["~standard"].jsonSchema.output({ target: "draft-07" })).toEqual({
      type: "number",
    });
    expect(() => documented("x" as never)).toThrow(TypeError);
  });

  it("loses to a validator wherever it sits, warning when they disagree", () => {
    const { logger, events } = createTestLogger();
    const validator = z.object({ id: z.string() });
    const agreeing = documented(
      validator["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
    );
    const disagreeing = documented({ type: "string" });
    const merged = mergeContracts(
      [
        {
          contract: http.contract({ outbound: { 200: { body: validator } } }),
          origin: "route-validator",
        },
        {
          contract: http.contract({ outbound: { 200: { body: disagreeing } } }),
          origin: "describe",
        },
      ],
      { logger },
    );
    expect(describeContract(merged).entries.map((e) => e.origin)).toEqual([
      "route-validator",
    ]);
    expect(events.map((e) => e.message)).toEqual([
      "documented schema disagrees with the validator, which wins",
    ]);

    events.length = 0;
    mergeContracts(
      [
        {
          contract: http.contract({ inbound: { body: agreeing } }),
          origin: "describe",
        },
        {
          contract: http.contract({ inbound: { body: validator } }),
          origin: "validator",
        },
      ],
      { logger },
    );
    expect(events).toEqual([]);

    // valibot has no JSON Schema of its own: the two cannot be compared.
    mergeContracts(
      [
        {
          contract: http.contract({ inbound: { body: v.string() } }),
          origin: "validator",
        },
        {
          contract: http.contract({ inbound: { body: agreeing } }),
          origin: "describe",
        },
      ],
      { logger },
    );
    expect(events.map((e) => e.message)).toEqual([
      "documented schema cannot be compared with the validator, which wins",
    ]);
  });
});

describe("JSON Schema on recordOf and toStandardSchema (m10)", () => {
  it("recordOf composes its members' JSON Schemas", () => {
    const record = recordOf({ a: z.string(), b: z.number() });
    const converter = (
      record["~standard"] as unknown as {
        jsonSchema: {
          input: (o: { target: string }) => Record<string, unknown>;
        };
      }
    ).jsonSchema;
    expect(converter.input({ target: "draft-2020-12" })).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b"],
    });
  });

  it("recordOf carries none when a member has none", () => {
    const record = recordOf({ a: z.string(), b: v.number() });
    expect("jsonSchema" in record["~standard"]).toBe(false);
  });

  it("recordOf checks each member and keeps only declared keys", async () => {
    const record = recordOf({ a: z.coerce.number() });
    expect(await record["~standard"].validate({ a: "1", b: 2 })).toEqual({
      value: { a: 1 },
    });
    expect(await record["~standard"].validate(null)).toEqual({
      issues: [{ message: "Expected an object", path: [] }],
    });
  });

  it("toStandardSchema takes an optional jsonSchema", () => {
    const Page = toStandardSchema<{ page: number }>(
      (input) => ({ value: input as { page: number } }),
      {
        jsonSchema: {
          type: "object",
          properties: { page: { type: "integer" } },
        },
      },
    );
    const converter = (
      Page["~standard"] as unknown as {
        jsonSchema: { input: (o: { target: string }) => unknown };
      }
    ).jsonSchema;
    expect(converter.input({ target: "draft-2020-12" })).toEqual({
      type: "object",
      properties: { page: { type: "integer" } },
    });
    expect(
      "jsonSchema" in toStandardSchema(() => ({ value: 1 }))["~standard"],
    ).toBe(false);
  });
});
