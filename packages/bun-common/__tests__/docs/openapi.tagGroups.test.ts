/**
 * `generateOpenApi({ tagGroups })`: sections of tags, emitted as the
 * top-level `x-tagGroups` extension (Redoc's and Scalar's shape), with the
 * rules {@link OpenApiOptions.tagGroups} states — the trailing `"Other"`
 * group, unused tags and repeats left out with a warning, a duplicate group
 * name a `ConfigError`, an untagged operation warned about.
 *
 * The meta-schema matrix (`openapi.meta.test.ts`) validates documents that
 * carry a group.
 */
import type { OpenApiOptions } from "../../lib/docs/index";
import { describe, expect, it } from "bun:test";
import { BunRouter } from "../../lib/BunRouter";
import { ConfigError } from "../../lib/errors";
import { generateOpenApi } from "../../lib/docs/index";

/** A router whose routes use the tags Users, Orders and Ops (in that first-use order). */
function shop(options: { untagged?: boolean } = {}): BunRouter {
  const router = new BunRouter();
  router
    .get("/users", (_req, res) => res.json([]))
    .describe({ tags: ["Users"], responses: { 200: null } });
  router
    .post("/users", (_req, res) => res.status(201).json({}))
    .describe({ tags: ["Users"], responses: { 201: null } });
  // An optional param: the route documents on two paths.
  router
    .get("/orders/:id?", (_req, res) => res.json([]))
    .describe({ tags: ["Orders"], responses: { 200: null } });
  router
    .get("/health", (_req, res) => res.json({}))
    .describe({ tags: ["Ops"], responses: { 200: null } });
  if (options.untagged === true) {
    // Untagged on two paths (an optional param): warned about once.
    router
      .get("/ping/:n?", (_req, res) => res.json({}))
      .describe({ responses: { 200: null } });
    router
      .get("/pong", (_req, res) => res.json({}))
      .describe({ tags: [], responses: { 200: null } });
  }
  return router;
}

/** The document and warnings for `shop()` with these groups. */
function generate(
  tagGroups: OpenApiOptions["tagGroups"],
  extra: Partial<OpenApiOptions> & { untagged?: boolean } = {},
) {
  const { untagged, ...options } = extra;
  return generateOpenApi(shop({ untagged }), {
    title: "Shop",
    version: "1",
    tags: {
      Users: { description: "People who buy" },
      Orders: { description: "What they bought" },
    },
    ...(tagGroups === undefined ? {} : { tagGroups }),
    ...options,
  });
}

/** The tag names of a document's `tags` list, in order. */
function tagNames(document: Record<string, unknown>): string[] {
  return ((document.tags ?? []) as { name: string }[]).map((tag) => tag.name);
}

describe("generateOpenApi tagGroups (x-tagGroups)", () => {
  it("emits the groups in the order given, and orders `tags` to match", () => {
    const { document, warnings } = generate([
      { name: "Operations", tags: ["Ops"] },
      { name: "Store", tags: ["Orders", "Users"] },
    ]);
    expect(document["x-tagGroups"]).toEqual([
      { name: "Operations", tags: ["Ops"] },
      { name: "Store", tags: ["Orders", "Users"] },
    ]);
    // First use is Users, Orders, Ops; the groups win.
    expect(tagNames(document)).toEqual(["Ops", "Orders", "Users"]);
    // Descriptions still come from options.tags.
    expect(document.tags).toContainEqual({
      name: "Orders",
      description: "What they bought",
    });
    expect(warnings).toEqual([]);
  });

  it("without tagGroups, or with an empty list, emits none and keeps first-use order", () => {
    for (const tagGroups of [undefined, []]) {
      const { document, warnings } = generate(tagGroups);
      expect(Object.hasOwn(document, "x-tagGroups")).toBe(false);
      expect(tagNames(document)).toEqual(["Users", "Orders", "Ops"]);
      expect(warnings).toEqual([]);
    }
  });

  it("puts the used tags no group names in a trailing Other group, in first-use order", () => {
    const { document, warnings } = generate([
      { name: "Operations", tags: ["Ops"] },
    ]);
    expect(document["x-tagGroups"]).toEqual([
      { name: "Operations", tags: ["Ops"] },
      { name: "Other", tags: ["Users", "Orders"] },
    ]);
    expect(tagNames(document)).toEqual(["Ops", "Users", "Orders"]);
    // Not a mistake: no warning.
    expect(warnings).toEqual([]);
  });

  it("appends them to a given Other group, wherever it stands", () => {
    const { document } = generate([
      { name: "Other", tags: ["Ops"] },
      { name: "Store", tags: ["Users"] },
    ]);
    expect(document["x-tagGroups"]).toEqual([
      { name: "Other", tags: ["Ops", "Orders"] },
      { name: "Store", tags: ["Users"] },
    ]);
  });

  it("leaves out a tag no operation uses, and a group left empty, with warnings", () => {
    const { document, warnings } = generate([
      { name: "Store", tags: ["Users", "Refunds", "Orders"] },
      { name: "Legacy", tags: ["Fax"] },
      { name: "Operations", tags: ["Ops"] },
    ]);
    expect(document["x-tagGroups"]).toEqual([
      { name: "Store", tags: ["Users", "Orders"] },
      { name: "Operations", tags: ["Ops"] },
    ]);
    // An unused tag never reaches `tags` either.
    expect(tagNames(document)).toEqual(["Users", "Orders", "Ops"]);
    expect(warnings).toEqual([
      {
        stage: "operation",
        message:
          'tag group "Store" names the tag "Refunds", which no documented operation uses; left out',
      },
      {
        stage: "operation",
        message:
          'tag group "Legacy" names the tag "Fax", which no documented operation uses; left out',
      },
      {
        stage: "operation",
        message:
          'tag group "Legacy" holds no tag a documented operation uses; left out',
      },
    ]);
  });

  it("keeps a tag named twice where it was first named, with a warning", () => {
    const { document, warnings } = generate([
      { name: "Store", tags: ["Users", "Orders", "Users"] },
      { name: "People", tags: ["Users", "Ops"] },
    ]);
    expect(document["x-tagGroups"]).toEqual([
      { name: "Store", tags: ["Users", "Orders"] },
      { name: "People", tags: ["Ops"] },
    ]);
    expect(warnings.map((warning) => warning.message)).toEqual([
      'tag group "Store" names the tag "Users" twice; listed once',
      'the tag "Users" is in tag group "Store" already; left out of "People"',
    ]);
  });

  it("refuses two groups with one name, and a malformed group, in lenient mode too", () => {
    expect(() =>
      generate([
        { name: "Store", tags: ["Users"] },
        { name: "Store", tags: ["Orders"] },
      ]),
    ).toThrow(ConfigError);
    expect(() =>
      generate([
        { name: "Store", tags: ["Users"] },
        { name: "Store", tags: ["Orders"] },
      ]),
    ).toThrow('two tag groups share the name "Store"');
    expect(() => generate([{ name: "", tags: ["Users"] }])).toThrow(
      /non-empty `name`/,
    );
    expect(() =>
      generate([{ name: "Store", tags: "Users" as unknown as string[] }]),
    ).toThrow(/needs `tags`/);
  });

  it("warns once per untagged route — an empty `tags` included — and still documents it", () => {
    const { document, warnings } = generate(
      [{ name: "Store", tags: ["Users", "Orders", "Ops"] }],
      { untagged: true },
    );
    expect(warnings.map((warning) => [warning.stage, warning.route])).toEqual([
      ["operation", "GET /ping/:n?"],
      ["operation", "GET /pong"],
    ]);
    expect(warnings[0].message).toContain("no tag");
    expect(warnings[0].message).toContain("x-tagGroups");
    const paths = document.paths as Record<string, unknown>;
    expect(Object.keys(paths)).toContain("/ping");
    expect(Object.keys(paths)).toContain("/ping/{n}");
    // Without groups an untagged route is no problem.
    expect(generate(undefined, { untagged: true }).warnings).toEqual([]);
  });

  it("escalates every tag-group warning under strict", () => {
    expect(() =>
      generate([{ name: "Store", tags: ["Users", "Refunds"] }], {
        strict: "strict",
      }),
    ).toThrow(/Refunds/);
    expect(() =>
      generate([{ name: "Store", tags: ["Users", "Orders", "Ops"] }], {
        strict: "strict",
        untagged: true,
      }),
    ).toThrow(/GET \/ping\/:n\?/);
    // A clean configuration passes strict.
    expect(() =>
      generate([{ name: "Store", tags: ["Users", "Orders", "Ops"] }], {
        strict: "strict",
      }),
    ).not.toThrow();
  });

  it("is deterministic, and hands back groups the caller may change", () => {
    const groups = [{ name: "Store", tags: ["Users"] }] as const;
    const first = generate(groups).document;
    const second = generate(groups).document;
    expect(first).toEqual(second);
    (first["x-tagGroups"] as { tags: string[] }[])[0].tags.push("Mutated");
    expect(generate(groups).document["x-tagGroups"]).toEqual(
      second["x-tagGroups"],
    );
    // The caller's option is untouched.
    expect(groups[0].tags).toEqual(["Users"]);
  });
});
