/**
 * `docsUi()` option validation and the configuration it resolves. Every
 * invalid option is a `ConfigError` at call time, never a surprise on the
 * first request.
 */
import { ConfigError } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { normalizeBasePath } from "../../lib/docsUi";
import { docsUi } from "../../lib/index";
import { fixtureDocsUi } from "./helpers";

/** Expects `fn` to throw a `ConfigError` whose message matches `pattern`. */
function expectConfigError(fn: () => unknown, pattern: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  expect((caught as Error).message).toMatch(pattern);
}

describe("basePath", () => {
  it("defaults to /docs and drops trailing slashes", () => {
    expect(fixtureDocsUi().basePath).toBe("/docs");
    expect(fixtureDocsUi({ basePath: "/admin/docs//" }).basePath).toBe(
      "/admin/docs",
    );
    expect(fixtureDocsUi({ basePath: "/a.b~c_d-e" }).basePath).toBe(
      "/a.b~c_d-e",
    );
  });

  it("must be absolute", () => {
    expectConfigError(
      () => fixtureDocsUi({ basePath: "docs" }),
      /absolute path/,
    );
    expectConfigError(
      () => fixtureDocsUi({ basePath: 42 as unknown as string }),
      /absolute path/,
    );
  });

  it("may not be /", () => {
    expectConfigError(
      () => fixtureDocsUi({ basePath: "/" }),
      /may not be "\/"/,
    );
    expectConfigError(() => fixtureDocsUi({ basePath: "///" }), /may not be/);
  });

  it("refuses odd segments", () => {
    for (const basePath of ["/a b", "/a//b", "/a/./b", "/a/../b", "/a%2Fb"]) {
      expectConfigError(() => fixtureDocsUi({ basePath }), /segments/);
    }
  });
});

describe("document", () => {
  it("is required, as a path, an http(s) URL or a thunk", () => {
    expectConfigError(
      () => fixtureDocsUi({ document: undefined as unknown as string }),
      /document must be/,
    );
    expectConfigError(
      () => fixtureDocsUi({ document: "" }),
      /document must be/,
    );
    expectConfigError(
      () => fixtureDocsUi({ document: 42 as unknown as string }),
      /document must be/,
    );
  });

  it("a same-origin path is served as given", () => {
    expect(
      fixtureDocsUi({ document: "/api/openapi.json" }).config.documentUrl,
    ).toBe("/api/openapi.json");
    expect(
      fixtureDocsUi({ document: "/api/openapi.json?full=1" }).config
        .documentUrl,
    ).toBe("/api/openapi.json?full=1");
  });

  it("an http(s) URL is kept whole", () => {
    const url = "https://api.example.com:8443/v1/asyncapi.json";
    expect(fixtureDocsUi({ document: url }).config.documentUrl).toBe(url);
  });

  it("refuses a URL with credentials, a non-http(s) scheme, or a rewritten path", () => {
    expectConfigError(
      () => fixtureDocsUi({ document: "https://u:p@api.example/x.json" }),
      /credentials/,
    );
    expectConfigError(
      () => fixtureDocsUi({ document: "ftp://api.example/x.json" }),
      /http: or https:/,
    );
    expectConfigError(
      () => fixtureDocsUi({ document: "https://api.example/a/../b.json" }),
      /segments/,
    );
    expectConfigError(
      () => fixtureDocsUi({ document: "docs/openapi.json" }),
      /document must be/,
    );
    expectConfigError(
      () => fixtureDocsUi({ document: "//cdn.example/x.json" }),
      /document must be/,
    );
  });

  it("a thunk is served by the router at <basePath>/document.json", () => {
    const ui = fixtureDocsUi({
      basePath: "/reference",
      document: () => ({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {},
      }),
    });
    expect(ui.config.documentUrl).toBe("/reference/document.json");
  });
});

describe("title", () => {
  it('defaults to "API docs" and must be a non-empty string', () => {
    expect(fixtureDocsUi().config.title).toBe("API docs");
    expectConfigError(() => fixtureDocsUi({ title: "" }), /title/);
    expectConfigError(() => fixtureDocsUi({ title: "  " }), /title/);
    expectConfigError(
      () => fixtureDocsUi({ title: 3 as unknown as string }),
      /title/,
    );
  });
});

describe("theme", () => {
  it('defaults to "system"', () => {
    expect(fixtureDocsUi().config.theme).toBe("system");
    expect(fixtureDocsUi({ theme: "dark" }).config.theme).toBe("dark");
  });

  it("must be a theme", () => {
    expectConfigError(
      () => fixtureDocsUi({ theme: "blue" as never }),
      /"system", "light" or "dark"/,
    );
  });
});

describe("extensions", () => {
  it("defaults to the bun-common and bun-jobs vocabularies", () => {
    expect(fixtureDocsUi().config.extensions).toEqual([
      "x-bun-common",
      "x-bun-jobs",
    ]);
  });

  it("must be a non-empty array of x- prefixes", () => {
    expectConfigError(() => fixtureDocsUi({ extensions: [] }), /non-empty/);
    expectConfigError(
      () => fixtureDocsUi({ extensions: "x-acme" as never }),
      /non-empty array/,
    );
    expectConfigError(() => fixtureDocsUi({ extensions: ["acme"] }), /"x-"/);
    expectConfigError(() => fixtureDocsUi({ extensions: ["X-Acme"] }), /"x-"/);
    expect(fixtureDocsUi({ extensions: ["x-acme"] }).config.extensions).toEqual(
      ["x-acme"],
    );
  });
});

describe("csrfHeader", () => {
  it("defaults to none", () => {
    expect(fixtureDocsUi().config.csrfHeader).toBeNull();
    expect(fixtureDocsUi({ csrfHeader: false }).config.csrfHeader).toBeNull();
    expect(fixtureDocsUi({ csrfHeader: "x-csrf" }).config.csrfHeader).toBe(
      "x-csrf",
    );
  });

  it("must be a header name or false", () => {
    expectConfigError(
      () => fixtureDocsUi({ csrfHeader: "not a header" }),
      /header name/,
    );
    expectConfigError(
      () => fixtureDocsUi({ csrfHeader: 3 as unknown as string }),
      /header name/,
    );
  });
});

describe("the rest", () => {
  it("middleware must be functions, authorize a function, dev a boolean", () => {
    expectConfigError(
      () => fixtureDocsUi({ middleware: "x" as never }),
      /middleware/,
    );
    expectConfigError(
      () => fixtureDocsUi({ authorize: "x" as never }),
      /authorize/,
    );
    expectConfigError(() => fixtureDocsUi({ dev: "yes" as never }), /dev/);
  });

  it("the options object itself is required", () => {
    expectConfigError(() => docsUi(null as never), /needs an options object/);
  });

  it("the config is frozen, deeply", () => {
    const ui = fixtureDocsUi();
    expect(Object.isFrozen(ui.config)).toBe(true);
  });
});

describe("normalizeBasePath", () => {
  it("validates as the router's option does", () => {
    expect(normalizeBasePath("/docs/", "basePath")).toBe("/docs");
    expect(() => normalizeBasePath("", "basePath")).toThrow(ConfigError);
  });
});
