/**
 * `typesHash` (typed-client plan §3.0, §8.2 item 2, PR-M1): SHA-256 over the
 * canonical JSON of `{ asyncapi, openapi }`, 16 hex characters. Stable across
 * calls and processes, blind to key order, changed by any change to the
 * documents — a schema, a route, an error code, and (per the plan's
 * definition, which hashes the documents whole) prose.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import process from "node:process";
import { typesHash } from "../../lib/docs/index";
import { fixtureDocuments } from "./fixtures/typesHash.fixture";

const FIXTURE = new URL("./fixtures/typesHash.fixture.ts", import.meta.url)
  .pathname;

describe("typesHash: the definition", () => {
  it("is the first 16 hex characters of SHA-256 over the canonical JSON of { asyncapi, openapi }", () => {
    // Computed independently: keys sorted at every depth, arrays in order.
    const openapi = { paths: { "/b": {}, "/a": { get: {} } }, info: { z: 1 } };
    const asyncapi = { channels: { c: { address: "/c" } } };
    const canonical =
      '{"asyncapi":{"channels":{"c":{"address":"/c"}}},"openapi":{"info":{"z":1},"paths":{"/a":{"get":{}},"/b":{}}}}';
    const expected = createHash("sha256")
      .update(canonical)
      .digest("hex")
      .slice(0, 16);
    expect(typesHash({ openapi, asyncapi })).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{16}$/);
  });

  it("leaves an absent document out, so one document hashes alone", () => {
    const openapi = { openapi: "3.1.2", paths: {} };
    const alone = createHash("sha256")
      .update('{"openapi":{"openapi":"3.1.2","paths":{}}}')
      .digest("hex")
      .slice(0, 16);
    expect(typesHash({ openapi })).toBe(alone);
    expect(typesHash({ openapi, asyncapi: undefined })).toBe(alone);
    expect(typesHash({ openapi, asyncapi: {} })).not.toBe(alone);
  });

  it("is blind to key order at every depth, and not to array order", () => {
    const a = { x: { b: 1, a: [1, 2] }, y: 2 };
    const b = { y: 2, x: { a: [1, 2], b: 1 } };
    expect(typesHash({ openapi: a })).toBe(typesHash({ openapi: b }));
    const reordered = { y: 2, x: { a: [2, 1], b: 1 } };
    expect(typesHash({ openapi: reordered })).not.toBe(
      typesHash({ openapi: a }),
    );
  });

  it("refuses what is not a document", () => {
    expect(() => typesHash(null as never)).toThrow(TypeError);
    expect(() => typesHash({ openapi: [] as never })).toThrow(TypeError);
    expect(() => typesHash({ asyncapi: "x" as never })).toThrow(
      /asyncapi must be a document object/,
    );
  });
});

describe("typesHash over a real app's documents", () => {
  it("is the same for two builds of one app, in this process", () => {
    const first = typesHash(fixtureDocuments());
    const second = typesHash(fixtureDocuments());
    expect(second).toBe(first);
  });

  it("is the same in a fresh process", () => {
    const child = Bun.spawnSync([process.execPath, FIXTURE], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe(typesHash(fixtureDocuments()));
  });

  it("covers the AsyncAPI document too", () => {
    const { openapi, asyncapi } = fixtureDocuments();
    expect(Object.keys(asyncapi.channels as object)).not.toHaveLength(0);
    expect(typesHash({ openapi, asyncapi })).not.toBe(typesHash({ openapi }));
  });

  it("changes when a schema changes", () => {
    expect(typesHash(fixtureDocuments({ nameType: "number" }))).not.toBe(
      typesHash(fixtureDocuments()),
    );
  });

  it("changes when a route is added", () => {
    expect(typesHash(fixtureDocuments({ extraRoute: true }))).not.toBe(
      typesHash(fixtureDocuments()),
    );
  });

  it("changes when an error code changes", () => {
    expect(
      typesHash(fixtureDocuments({ errors: ["NOT_FOUND", "GONE"] })),
    ).not.toBe(typesHash(fixtureDocuments()));
  });

  it("changes on a prose-only change: the documents are hashed whole (plan §3.0)", () => {
    expect(typesHash(fixtureDocuments({ summary: "Fetch a user" }))).not.toBe(
      typesHash(fixtureDocuments()),
    );
  });
});
