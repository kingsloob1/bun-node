/**
 * `jobsUi()` option validation and the configuration it resolves. Every
 * invalid option is a `ConfigError` at call time, never a surprise on the
 * first request.
 */
import type { JobsApi } from "@kingsleyweb/bun-jobs";
import type { JobsUiOptions } from "../../lib/types";
import { ConfigError } from "@kingsleyweb/bun-jobs";
import { describe, expect, it } from "bun:test";
import { jobsUi } from "../../lib/index";
import { normalizeBasePath } from "../../lib/jobsUi";
import { fixtureUi, parseCsp } from "./helpers";

/** A structural stand-in for a `JobsApi`, enough for option resolution. */
function fakeApi(
  overrides: Partial<Record<keyof JobsApi | "info", unknown>> = {},
): JobsApi {
  return {
    basePath: "/jobs-api",
    routes: [],
    websocket: undefined,
    ...overrides,
  } as unknown as JobsApi;
}

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
  it("defaults to /jobs and drops trailing slashes", () => {
    expect(fixtureUi().basePath).toBe("/jobs");
    expect(fixtureUi({ basePath: "/admin/ui//" }).basePath).toBe("/admin/ui");
    expect(fixtureUi({ basePath: "/a.b~c_d-e" }).basePath).toBe("/a.b~c_d-e");
  });

  it("must be absolute", () => {
    expectConfigError(() => fixtureUi({ basePath: "jobs" }), /absolute path/);
    expectConfigError(
      () => fixtureUi({ basePath: 42 as unknown as string }),
      /absolute path/,
    );
  });

  it("may not be /", () => {
    expectConfigError(() => fixtureUi({ basePath: "/" }), /may not be "\/"/);
    expectConfigError(() => fixtureUi({ basePath: "///" }), /may not be "\/"/);
  });

  it("allows only plain segments: no route syntax, no dot segments, no empties", () => {
    for (const bad of [
      "/jobs/:id",
      "/jobs/*",
      "/jobs/(x)",
      "/jobs/../x",
      "/jobs/.",
      "/a//b",
      "/jobs ui",
      "/jobs?x",
      "/jöbs",
    ]) {
      expectConfigError(() => fixtureUi({ basePath: bad }), /segments/);
    }
  });

  it("agrees with the API's rule on the same inputs", () => {
    expect(normalizeBasePath("/x/", "p")).toBe("/x");
    expect(() => normalizeBasePath("/x/:y", "p")).toThrow(ConfigError);
  });

  it("may not equal or sit under the API's basePath (api)", () => {
    const api = fakeApi({ basePath: "/admin/jobs" });
    expectConfigError(
      () => fixtureUi({ api, basePath: "/admin/jobs" }),
      /may not equal or sit under the API's basePath/,
    );
    expectConfigError(
      () => fixtureUi({ api, basePath: "/admin/jobs/ui" }),
      /may not equal or sit under/,
    );
    // Segment-wise, not a string prefix.
    expect(fixtureUi({ api, basePath: "/admin/jobs-ui" }).basePath).toBe(
      "/admin/jobs-ui",
    );
    // The API under the UI is allowed (see the api suite for why it works).
    expect(fixtureUi({ api, basePath: "/admin" }).basePath).toBe("/admin");
  });

  it("may not equal or sit under a same-origin apiUrl path", () => {
    expectConfigError(
      () => fixtureUi({ apiUrl: "/jobs", basePath: "/jobs" }),
      /may not equal or sit under/,
    );
    expectConfigError(
      () => fixtureUi({ apiUrl: "/jobs/", basePath: "/jobs/ui" }),
      /may not equal or sit under/,
    );
  });
});

describe("api / apiUrl", () => {
  it("needs exactly one of them", () => {
    expectConfigError(
      () => jobsUi({} as JobsUiOptions),
      /needs api .* or apiUrl/,
    );
    expectConfigError(
      () =>
        jobsUi({ api: fakeApi(), apiUrl: "/x" } as unknown as JobsUiOptions),
      /not both/,
    );
    expectConfigError(
      () => jobsUi(undefined as unknown as JobsUiOptions),
      /options object/,
    );
  });

  it("refuses something that is not a JobsApi", () => {
    expectConfigError(
      () => fixtureUi({ api: { basePath: "/x" } as unknown as JobsApi }),
      /createJobsApi/,
    );
  });

  it("takes a same-origin path: apiBase is the path, CSP adds only the page's socket origin", async () => {
    const ui = fixtureUi({ apiUrl: "/remote-api/" });
    expect(ui.config.apiBase).toBe("/remote-api");
    expect(ui.config.websocket).toBeNull();
    expect(ui.config.docs).toBeNull();
    const csp = parseCsp(
      (await ui.router.fetch("/")).headers.get("content-security-policy"),
    );
    expect(csp.get("connect-src")).toEqual(["'self'", "ws://localhost"]);
  });

  it("takes an http(s) URL: apiBase is the URL, CSP allows its origin", async () => {
    const ui = fixtureUi({ apiUrl: "https://api.example.com:8443/v1/jobs/" });
    expect(ui.config.apiBase).toBe("https://api.example.com:8443/v1/jobs");
    const csp = parseCsp(
      (await ui.router.fetch("/")).headers.get("content-security-policy"),
    );
    expect(csp.get("connect-src")).toEqual([
      "'self'",
      "ws://localhost",
      "https://api.example.com:8443",
      "wss://api.example.com:8443",
    ]);
    expect(fixtureUi({ apiUrl: "http://api.example" }).config.apiBase).toBe(
      "http://api.example",
    );
  });

  it("refuses a malformed apiUrl", () => {
    for (const [bad, pattern] of [
      ["", /absolute path or an http/],
      ["api.example", /absolute path or an http/],
      ["//api.example", /absolute path or an http/],
      ["ftp://api.example", /http: or https:/],
      ["https://api.example/x?y=1", /query/],
      ["https://api.example/x#y", /fragment/],
      ["https://u:p@api.example", /credentials/],
      ["/jobs/:x", /segments/],
    ] as const) {
      expectConfigError(() => fixtureUi({ apiUrl: bad }), pattern);
    }
  });
});

describe("apiUrl: the URL form follows the path form's rules", () => {
  it("refuses credentials of any kind, a password alone included", () => {
    for (const bad of [
      "https://:secret@api.example/x",
      "https://user@api.example/x",
      "https://user:pw@api.example",
      "https://@api.example/x",
    ]) {
      expectConfigError(() => fixtureUi({ apiUrl: bad }), /credentials/);
    }
  });

  it("refuses dot segments, spaces, encoded slashes and empty segments in the raw path", () => {
    for (const bad of [
      "http://api.example/a/../b",
      "http://api.example/a/./b",
      "http://api.example/..",
      "http://api.example/a b",
      "http://api.example/a%20b",
      "http://api.example/a%2Fb",
      "http://api.example/a//b",
      "http://api.example/a/:id",
      "http://api.example/a\\b",
      "http://api.example/a\tb",
    ]) {
      expectConfigError(() => fixtureUi({ apiUrl: bad }), /segments/);
    }
  });

  it("allows the origin root and trims a trailing slash", () => {
    for (const [good, base] of [
      ["http://api.example", "http://api.example"],
      ["http://api.example/", "http://api.example"],
      ["https://api.example/v1/jobs/", "https://api.example/v1/jobs"],
      ["https://api.example/v1/jobs//", "https://api.example/v1/jobs"],
      ["https://API.example:443/a.b~c_d-e", "https://api.example/a.b~c_d-e"],
    ] as const) {
      expect(fixtureUi({ apiUrl: good }).config.apiBase).toBe(base);
    }
  });

  it("refuses a query or fragment, even an empty one", () => {
    expectConfigError(
      () => fixtureUi({ apiUrl: "https://api.example/x?" }),
      /may not carry a query/,
    );
    expectConfigError(
      () => fixtureUi({ apiUrl: "https://api.example/x#" }),
      /may not carry a fragment/,
    );
  });
});

describe("apiUrl: the path form", () => {
  it("names a query or a fragment specifically", () => {
    for (const [bad, pattern] of [
      ["/jobs-api?x=1", /apiUrl may not carry a query/],
      ["/jobs-api?", /apiUrl may not carry a query/],
      ["/jobs-api#frag", /apiUrl may not carry a fragment/],
      ["/jobs-api/#", /apiUrl may not carry a fragment/],
    ] as const) {
      expectConfigError(() => fixtureUi({ apiUrl: bad }), pattern);
    }
  });
});

describe("csrfHeader", () => {
  it("defaults to null", () => {
    expect(fixtureUi().config.csrfHeader).toBeNull();
    expect(fixtureUi({ api: fakeApi() }).config.csrfHeader).toBeNull();
  });

  it("takes an explicit header, or false", () => {
    expect(fixtureUi({ csrfHeader: "X-Jobs-Csrf" }).config.csrfHeader).toBe(
      "X-Jobs-Csrf",
    );
    expect(
      fixtureUi({
        api: fakeApi({ info: { csrf: { header: "x-from-api" } } }),
        csrfHeader: false,
      }).config.csrfHeader,
    ).toBeNull();
  });

  it("reads api.info.csrf.header when the API exposes it", () => {
    expect(
      fixtureUi({ api: fakeApi({ info: { csrf: { header: "x-from-api" } } }) })
        .config.csrfHeader,
    ).toBe("x-from-api");
    // Anything else there is ignored, not trusted.
    expect(
      fixtureUi({ api: fakeApi({ info: { csrf: { header: 42 } } }) }).config
        .csrfHeader,
    ).toBeNull();
    expect(
      fixtureUi({ api: fakeApi({ info: { csrf: { header: false } } }) }).config
        .csrfHeader,
    ).toBeNull();
  });

  it("refuses something that is not a header name", () => {
    for (const bad of ["", "x y", "x:y", true]) {
      expectConfigError(
        () => fixtureUi({ csrfHeader: bad as string }),
        /csrfHeader/,
      );
    }
  });
});

describe("the rest", () => {
  it("sections default to both on; one may be off; both off is refused", () => {
    expect(fixtureUi().config.sections).toEqual({ manage: true, docs: true });
    expect(fixtureUi({ sections: { manage: false } }).config.sections).toEqual({
      manage: false,
      docs: true,
    });
    expect(fixtureUi({ sections: { docs: false } }).config.sections).toEqual({
      manage: true,
      docs: false,
    });
    expectConfigError(
      () => fixtureUi({ sections: { manage: false, docs: false } }),
      /at least one of manage and docs/,
    );
    expectConfigError(
      () => fixtureUi({ sections: { docs: "no" as unknown as boolean } }),
      /sections\.docs must be a boolean/,
    );
  });

  it("theme defaults to system and must be one of three", () => {
    expect(fixtureUi().config.theme).toBe("system");
    expectConfigError(
      () => fixtureUi({ theme: "blue" as "dark" }),
      /theme must be/,
    );
  });

  it("title defaults to Jobs and must be a non-empty string", () => {
    expect(fixtureUi().config.title).toBe("Jobs");
    expectConfigError(() => fixtureUi({ title: " " }), /title/);
  });

  it("refuses a non-function authorize, non-array middleware, non-boolean dev", () => {
    expectConfigError(
      () => fixtureUi({ authorize: true as unknown as () => boolean }),
      /authorize must be a function/,
    );
    expectConfigError(
      () => fixtureUi({ middleware: [42] as unknown as [] }),
      /middleware/,
    );
    expectConfigError(
      () => fixtureUi({ dev: "yes" as unknown as boolean }),
      /dev must be a boolean/,
    );
  });

  it("returns a frozen result and config", () => {
    const ui = fixtureUi();
    expect(Object.isFrozen(ui)).toBe(true);
    expect(Object.isFrozen(ui.config)).toBe(true);
    expect(Object.isFrozen(ui.config.sections)).toBe(true);
  });

  it("derives websocket and docs from the api", () => {
    const ui = fixtureUi({
      api: fakeApi({
        websocket: { path: "/jobs-api/ws", port: undefined },
        routes: [
          {
            method: "GET",
            path: "/jobs-api/openapi.json",
            operationId: "getOpenApiDocument",
          },
          {
            method: "GET",
            path: "/jobs-api/asyncapi.json",
            operationId: "getAsyncApiDocument",
          },
        ],
      }),
    });
    expect(ui.config.websocket).toEqual({ path: "/jobs-api/ws", port: null });
    expect(ui.config.docs).toEqual({
      openapi: "/jobs-api/openapi.json",
      asyncapi: "/jobs-api/asyncapi.json",
    });

    const dedicated = fixtureUi({
      api: fakeApi({
        websocket: { path: "/jobs-api/ws", port: 4567 },
        routes: [
          {
            method: "GET",
            path: "/jobs-api/openapi.json",
            operationId: "getOpenApiDocument",
          },
        ],
      }),
    });
    expect(dedicated.config.websocket).toEqual({
      path: "/jobs-api/ws",
      port: 4567,
    });
    expect(dedicated.config.docs).toEqual({
      openapi: "/jobs-api/openapi.json",
      asyncapi: null,
    });
  });
});
