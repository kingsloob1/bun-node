/**
 * `securityUi()` option validation and the configuration it resolves: every
 * unusable option is bun-common's `ConfigError` at call time.
 */
import { ConfigError } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { securityUi } from "../../../lib/security/index";
import {
  closeSecurityApis,
  fixtureSecurityUi,
  memorySecurityApi,
} from "./helpers";

afterAll(closeSecurityApis);

/** Expects `fn` to throw a `ConfigError` matching `pattern`. */
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

describe("api and apiUrl", () => {
  it("takes exactly one", async () => {
    const api = await memorySecurityApi();
    expectConfigError(() => securityUi({} as never), /needs api .* or apiUrl/);
    expectConfigError(
      () => securityUi({ api, apiUrl: "/x" } as never),
      /api or apiUrl, not both/,
    );
    expectConfigError(
      () => securityUi({ api: {} as never }),
      /result of createSecurityApi/,
    );
    expectConfigError(() => securityUi(null as never), /securityUi\(\)/);
  });

  it("with api, the API's base, docs and live come from it", async () => {
    const api = await memorySecurityApi();
    const ui = fixtureSecurityUi({ api });
    expect(ui.config.apiBase).toBe("/security/api");
    expect(ui.config.docs).toEqual({
      openapi: "/security/api/openapi.json",
      asyncapi: "/security/api/asyncapi.json",
    });
    expect(ui.config.live).toEqual({ path: "/security/api/live" });
  });

  it("with apiUrl, a path or an absolute URL", () => {
    expect(
      fixtureSecurityUi({ apiUrl: "/admin/sec-api/" }).config.apiBase,
    ).toBe("/admin/sec-api");
    expect(
      fixtureSecurityUi({ apiUrl: "https://sec.example.com/api" }).config
        .apiBase,
    ).toBe("https://sec.example.com/api");
    expectConfigError(
      () => fixtureSecurityUi({ apiUrl: "javascript:alert(1)" }),
      /apiUrl/,
    );
  });
});

describe("basePath", () => {
  it("defaults to /security and may not be or sit under the API's", async () => {
    const api = await memorySecurityApi({ basePath: "/admin/api" });
    expect(fixtureSecurityUi({ api }).basePath).toBe("/security");
    expectConfigError(
      () => fixtureSecurityUi({ api, basePath: "/admin/api" }),
      /may not equal or sit under/,
    );
    expectConfigError(
      () => fixtureSecurityUi({ api, basePath: "/admin/api/ui" }),
      /may not equal or sit under/,
    );
    expectConfigError(
      () => fixtureSecurityUi({ apiUrl: "/x", basePath: "/x/ui" }),
      /may not equal or sit under/,
    );
    // The API under the UI is allowed: the UI's router leaves its paths alone.
    expect(fixtureSecurityUi({ apiUrl: "/security/api" }).basePath).toBe(
      "/security",
    );
  });

  it("refuses odd paths", () => {
    expectConfigError(
      () => fixtureSecurityUi({ basePath: "security" }),
      /absolute path/,
    );
    expectConfigError(() => fixtureSecurityUi({ basePath: "/" }), /may not be/);
  });
});

describe("the config", () => {
  it("has the defaults", () => {
    const { config } = fixtureSecurityUi();
    expect(config).toEqual({
      version: 1,
      title: "Security",
      basePath: "/security",
      assetsPath: "/security/assets",
      apiBase: "/security/api",
      csrfHeader: "x-bun-security-csrf",
      breakGlass: false,
      docs: {
        openapi: "/security/api/openapi.json",
        asyncapi: "/security/api/asyncapi.json",
      },
      live: { path: "/security/api/live" },
      theme: "system",
      layout: { align: "center", scope: "content", maxWidth: 1400 },
      unauthorized: null,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("csrfHeader is a header name, lower-cased", () => {
    expect(
      fixtureSecurityUi({ csrfHeader: "X-My-Csrf" }).config.csrfHeader,
    ).toBe("x-my-csrf");
    expectConfigError(
      () => fixtureSecurityUi({ csrfHeader: "a b" }),
      /csrfHeader/,
    );
  });

  it("breakGlass follows the API's account, or the apiUrl option", async () => {
    expect(
      fixtureSecurityUi({ api: await memorySecurityApi() }).config.breakGlass,
    ).toBe(false);
    expect(
      fixtureSecurityUi({
        api: await memorySecurityApi({ withBreakGlass: true }),
      }).config.breakGlass,
    ).toBe(true);
    expect(
      fixtureSecurityUi({ apiUrl: "/a", breakGlass: true }).config.breakGlass,
    ).toBe(true);
    expect(fixtureSecurityUi({ apiUrl: "/a" }).config.breakGlass).toBe(false);
    expectConfigError(
      () => fixtureSecurityUi({ apiUrl: "/a", breakGlass: "yes" as never }),
      /breakGlass must be a boolean/,
    );
  });

  it("theme and layout are the kit's", () => {
    expect(fixtureSecurityUi({ theme: "dark" }).config.theme).toBe("dark");
    expect(
      fixtureSecurityUi({ layout: { align: "left", maxWidth: 1200 } }).config
        .layout,
    ).toEqual({
      align: "left",
      scope: "content",
      maxWidth: 1200,
    });
    expectConfigError(
      () => fixtureSecurityUi({ theme: "pink" as never }),
      /theme/,
    );
    expectConfigError(
      () => fixtureSecurityUi({ layout: { maxWidth: -1 } }),
      /maxWidth/,
    );
  });

  it("unauthorized is the kit's, and may not point inside the UI", () => {
    expect(
      fixtureSecurityUi({ unauthorized: { redirectTo: "/login" } }).config
        .unauthorized,
    ).toEqual({
      redirectTo: "/login",
      returnParam: "returnTo",
      statuses: [401],
    });
    expectConfigError(
      () =>
        fixtureSecurityUi({ unauthorized: { redirectTo: "/security/login" } }),
      /basePath/,
    );
  });
});
