/**
 * The query serialiser against bun-common's real parser (plan §6.1, risk R7):
 * every shape goes through `createClient` → a real `BunRouter.fetch()`, and
 * the route answers with `req.query` as the server parsed it. What arrives
 * is the value with every leaf as a string (the wire carries strings; the
 * server's schema coerces them).
 *
 * The negative controls write the same values the naive ways (a lone repeated
 * key, unencoded keys and values) and show the parser reads them differently,
 * so each rule in `lib/querystring.ts` is load-bearing.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { createClient } from "../lib/index";
import { serializeQuery } from "../lib/querystring";

interface Routes {
  "GET /echo": {
    query: Record<string, unknown>;
    responses: { 200: { query: unknown } };
  };
}

const router = new BunRouter();
router.get("/echo", (req, res) => res.json({ query: req.query }));

const api = createClient<Routes>({ fetch: (request) => router.fetch(request) });

/** `req.query` as the server parsed `query`, sent through the client. */
async function roundTrip(query: Record<string, unknown>): Promise<unknown> {
  const result = await api.get("/echo", { query });
  if (!result.ok) throw new Error(`status ${result.status}`);
  return result.data.query;
}

/** `req.query` for a query string written by hand. */
async function parsed(search: string): Promise<unknown> {
  const response = await router.fetch(`/echo?${search}`);
  return ((await response.json()) as { query: unknown }).query;
}

/** Each shape: what is sent, and what the server must receive. */
const SHAPES: [
  name: string,
  sent: Record<string, unknown>,
  received: unknown,
][] = [
  ["a string", { q: "hello" }, { q: "hello" }],
  ["an empty string", { q: "" }, { q: "" }],
  [
    "a number, a boolean, a bigint",
    { n: 42, f: -1.5, b: false, big: 10n },
    { n: "42", f: "-1.5", b: "false", big: "10" },
  ],
  [
    "a Date, as JSON writes it",
    { at: new Date(Date.UTC(2026, 10, 2)) },
    { at: "2026-11-02T00:00:00.000Z" },
  ],
  [
    "reserved characters in a value",
    { s: "a&b=c+d %25 #?/é" },
    { s: "a&b=c+d %25 #?/é" },
  ],
  ["an array of scalars", { tag: ["x", "y", "z"] }, { tag: ["x", "y", "z"] }],
  ["an array of one", { tag: ["only"] }, { tag: ["only"] }],
  ["an array of numbers", { ids: [1, 2] }, { ids: ["1", "2"] }],
  [
    "a nested object",
    { filter: { status: "open", owner: { id: "7" } } },
    { filter: { status: "open", owner: { id: "7" } } },
  ],
  [
    "an array in an object",
    { filter: { tags: ["a", "b"] } },
    { filter: { tags: ["a", "b"] } },
  ],
  [
    "one-element array in an object",
    { filter: { tags: ["a"] } },
    { filter: { tags: ["a"] } },
  ],
  [
    "an array of objects",
    {
      sort: [
        { by: "name", dir: "asc" },
        { by: "id", dir: "desc" },
      ],
    },
    {
      sort: [
        { by: "name", dir: "asc" },
        { by: "id", dir: "desc" },
      ],
    },
  ],
  [
    "an array of arrays",
    { grid: [["a", "b"], ["c"]] },
    { grid: [["a", "b"], ["c"]] },
  ],
  [
    "mixed scalars and objects in an array",
    { mix: ["a", { b: "c" }] },
    { mix: ["a", { b: "c" }] },
  ],
  ["a numeric object key", { byId: { 7: "x" } }, { byId: { 7: "x" } }],
  ["a key with a dot", { "a.b": "dot" }, { "a.b": "dot" }],
  ["reserved characters in a key", { "k&=+ %é": "v" }, { "k&=+ %é": "v" }],
  [
    "null and undefined, skipped",
    { a: null, b: undefined, c: "kept", list: ["x", null, "y"] },
    { c: "kept", list: ["x", "y"] },
  ],
  [
    "an empty array and object, skipped",
    { e: [], o: {}, kept: "1" },
    { kept: "1" },
  ],
  [
    "prototype keys, skipped",
    JSON.parse('{"__proto__":{"polluted":"1"},"ok":"1"}') as Record<
      string,
      unknown
    >,
    { ok: "1" },
  ],
];

describe("the query serialiser round-trips through bun-common's parser", () => {
  for (const [name, sent, received] of SHAPES) {
    it(name, async () => {
      expect(await roundTrip(sent)).toEqual(received);
    });
  }

  it("writes nothing for no query, an empty one, or a non-object", async () => {
    expect(serializeQuery(undefined)).toBe("");
    expect(serializeQuery({})).toBe("");
    expect(serializeQuery("a=1")).toBe("");
    expect(await roundTrip({})).toEqual({});
  });

  it("documents the one shape that cannot travel: a key holding [ or ] arrives nested", async () => {
    // bun-common decodes %5B/%5D before picoquery reads the string
    // (`decodeNestingBrackets`, BunRequest.ts), so no encoding keeps them
    // literal. Pinned so a parser change that lifts it is noticed.
    expect(await roundTrip({ "x[y]": "v" })).toEqual({ x: { y: "v" } });
  });
});

describe("negative controls: the naive encodings arrive wrong", () => {
  it("a one-element array written as a repeated key arrives as a scalar", async () => {
    expect(await parsed("tag=only")).toEqual({ tag: "only" });
    expect(serializeQuery({ tag: ["only"] })).toBe("tag[0]=only");
  });

  it("an object in an array written by repetition loses its shape", async () => {
    expect(await parsed("sort.by=name&sort.by=id")).toEqual({
      sort: { by: ["name", "id"] },
    });
  });

  it("a dotted key written unencoded arrives nested", async () => {
    expect(await parsed("a.b=dot")).toEqual({ a: { b: "dot" } });
    expect(serializeQuery({ "a.b": "dot" })).toBe("a%2Eb=dot");
  });

  it("a value written unencoded is cut at & and its + becomes a space", async () => {
    expect(await parsed("s=a&b=c+d")).toEqual({ s: "a", b: "c d" });
  });
});
