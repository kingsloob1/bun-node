/**
 * The "dropped by JSON Schema" warnings (typed-client plan §5.3, a PR-C4
 * follow-up): what a server's zod schemas hold that the OpenAPI document
 * cannot carry, found on the zod objects themselves and copied into the
 * generated file's header by `generate --module`.
 *
 * - each kind found where it is (a refinement, `z.date()`, `z.custom()`, a
 *   transform on the documented side), through every container zod has,
 *   in both flavours, recursion included;
 * - each node reported once (a component shared by two routes names the
 *   first route only);
 * - only a module source reports them: a file or URL document has no zod
 *   objects to read (the fixture app's two drops, against its document
 *   read from a file).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { BunRouter, listRoutes, validate } from "@kingsleyweb/bun-common";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { z as mini } from "zod/mini";
import { z } from "zod";
import { loadDocuments } from "../../lib/codegen/index";
import { routeDropWarnings, zodDrops } from "../../lib/codegen/zodDrops";

const FIXTURES = join(import.meta.dir, "fixtures");

/** A router's listed routes, through bun-common's own `listRoutes`. */
function listed(router: BunRouter): never {
  return listRoutes(router) as never;
}

describe("zodDrops", () => {
  it("finds a refinement, z.date(), z.custom() and a transform, with their paths", () => {
    const schema = z
      .object({
        name: z.string().refine((value) => value !== "x"),
        when: z.date(),
        blob: z.custom<string>(() => true),
        tags: z.array(z.string().superRefine(() => {})),
        meta: z.record(
          z.string(),
          z.number().check(() => {}),
        ),
        pair: z.tuple([z.string(), z.date()]),
        either: z.union([z.string(), z.date()]).optional(),
        plain: z.string().min(1).email(),
      })
      .refine(() => true);
    expect(zodDrops(schema, "input")).toEqual([
      { kind: "refinement", path: "" },
      { kind: "refinement", path: "name" },
      { kind: "date", path: "when" },
      { kind: "custom", path: "blob" },
      { kind: "refinement", path: "tags[]" },
      { kind: "refinement", path: "meta.*" },
      { kind: "date", path: "pair[1]" },
      { kind: "date", path: "either" },
    ]);
  });

  it("finds nothing in a schema JSON Schema carries (control for the above)", () => {
    expect(
      zodDrops(
        z.object({
          a: z.string().min(1).regex(/x/),
          b: z.array(z.int().max(3)).nullable(),
          c: z.enum(["x", "y"]).default("x"),
          d: z.iso.datetime(),
        }),
        "input",
      ),
    ).toEqual([]);
  });

  it("walks a pipe by the documented side: a transform's input documents, its output does not", () => {
    const transformed = z.object({
      at: z.string().transform((value) => new Date(value)),
    });
    expect(zodDrops(transformed, "input")).toEqual([]);
    expect(zodDrops(transformed, "output")).toEqual([
      { kind: "transform", path: "at" },
    ]);
    const preprocessed = z.preprocess((value) => value, z.string());
    expect(zodDrops(preprocessed, "input")).toEqual([
      { kind: "transform", path: "" },
    ]);
    expect(zodDrops(preprocessed, "output")).toEqual([]);
  });

  it("reads zod/mini's checks the same way", () => {
    expect(
      zodDrops(
        mini.object({
          a: mini.string().check(mini.refine(() => true)),
          b: mini.string().check(mini.minLength(1)),
        }),
        "input",
      ),
    ).toEqual([{ kind: "refinement", path: "a" }]);
  });

  it("follows recursion once, through z.lazy and a getter", () => {
    const Node: z.ZodType = z.lazy(() =>
      z.object({ when: z.date(), children: z.array(Node) }),
    );
    expect(zodDrops(Node, "input")).toEqual([{ kind: "date", path: "when" }]);
    const Category = z.object({
      name: z.string().refine(() => true),
      get children() {
        return z.array(Category);
      },
    });
    expect(zodDrops(Category, "input")).toEqual([
      { kind: "refinement", path: "name" },
    ]);
  });

  it("reports a node once across schemas sharing a `seen` set", () => {
    const When = z.date();
    const seen = new WeakSet<object>();
    expect(zodDrops(z.object({ a: When }), "input", seen)).toHaveLength(1);
    expect(zodDrops(z.object({ b: When }), "input", seen)).toEqual([]);
  });

  it("is not fooled by a schema that is not zod's", () => {
    const foreign = {
      "~standard": { version: 1, vendor: "valibot", validate: () => ({}) },
      _zod: { def: { type: "date" } },
    };
    expect(zodDrops(foreign, "input")).toEqual([]);
  });
});

describe("routeDropWarnings", () => {
  it("names each route part once per kind; a node shared by two routes, at the first only", async () => {
    const Stamp = z.object({ at: z.date() });
    const router = new BunRouter();
    router.post(
      "/a",
      validate(
        {
          body: z.object({ x: z.string() }).refine(() => true),
          query: z.object({ y: z.custom<string>(() => true) }),
        },
        { responses: { 200: Stamp } },
      ),
      (_req, res) => res.json({ at: new Date() }),
    );
    router.get("/b", validate({}, { responses: { 200: Stamp } }), (_req, res) =>
      res.json({ at: new Date() }),
    );
    const routes = listed(router);
    const documented = new Set(["POST /a", "GET /b"]);
    expect(routeDropWarnings(routes, documented)).toEqual([
      {
        at: "POST /a query",
        message: expect.stringMatching(
          /^at `y`: `z\.custom\(\)` has no JSON Schema/,
        ) as string,
      },
      {
        at: "POST /a body",
        message: expect.stringMatching(
          /^at the value itself: a refinement/,
        ) as string,
      },
      {
        at: "POST /a response 200",
        message: expect.stringMatching(
          /^at `at`: `z\.date\(\)` has no JSON Schema/,
        ) as string,
      },
    ]);
    // A route the document does not hold is skipped.
    expect(routeDropWarnings(routes, new Set(["GET /b"]))).toEqual([
      expect.objectContaining({ at: "GET /b response 200" }) as never,
    ]);
  });

  it('walks a response from its output under responseOutput: "parsed" (control: the default, its input)', async () => {
    const At = z.object({ at: z.string().transform((s) => s.length) });
    const router = new BunRouter();
    router.get("/c", validate({}, { responses: { 200: At } }), (_req, res) =>
      res.json({ at: "" }),
    );
    const routes = listed(router);
    expect(routeDropWarnings(routes, new Set(["GET /c"]))).toEqual([]);
    const parsed = (routes as { key: string }[]).map((route) => ({
      ...route,
      responseOutput: "parsed",
    }));
    expect(routeDropWarnings(parsed, new Set(["GET /c"]))).toEqual([
      expect.objectContaining({ at: "GET /c response 200" }) as never,
    ]);
  });
});

describe("only a module source reports them", () => {
  it("the fixture app as a module names its z.date() and its .refine(); its document as a file names neither", async () => {
    const fromModule = await loadDocuments({
      module: join(FIXTURES, "app.ts"),
    });
    const drops = fromModule.warnings.filter(
      (warning) =>
        warning.message.includes("has no JSON Schema") ||
        warning.message.includes("a refinement"),
    );
    expect(drops).toEqual([
      {
        at: "GET /api/users/:id response 200",
        message: expect.stringContaining("at `joined`: `z.date()`") as string,
      },
      {
        at: "POST /api/users body",
        message: expect.stringContaining(
          "at the value itself: a refinement",
        ) as string,
      },
    ]);

    // The same document, as a file: nothing says a refinement was there.
    const dir = await mkdtemp(join(tmpdir(), "bun-client-drops-"));
    const path = join(dir, "app.openapi.json");
    await writeFile(path, JSON.stringify(fromModule.openapi));
    try {
      const fromFile = await loadDocuments({ openapi: path });
      expect(fromFile.warnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a document with nothing dropped adds no warning (control)", async () => {
    const router = new BunRouter();
    router.get(
      "/d",
      validate({}, { responses: { 200: z.object({ a: z.string() }) } }),
      (_req, res) => res.json({ a: "" }),
    );
    expect(
      generateOpenApi(router, { title: "t", version: "1" }).warnings,
    ).toEqual([]);
    expect(routeDropWarnings(listed(router), new Set(["GET /d"]))).toEqual([]);
  });
});
