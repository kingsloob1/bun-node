/**
 * `unauthorized` on the server: what `docsUi()` accepts and refuses, what it
 * puts in the page's config, and the shell's `303` for a denied navigation.
 * The validation and the redirect are `lib/unauthorized.ts`, which
 * the jobs UI's `jobsUi()` shares; its own tests check the same rules through
 * `jobsUi()`.
 */
import type { DocsUiUnauthorizedOptions } from "../../../lib/docs/types";
import { BunRouter, ConfigError } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  isUiUnauthorized,
  relativeReturnPath,
  unauthorizedRedirectUrl,
} from "../../../lib/kit/browser/unauthorized";
import { resolveUnauthorized } from "../../../lib/kit/unauthorized";
import { fetchShell, fixtureDocsUi } from "./helpers";

/** A browser's page navigation. */
const NAVIGATE = {
  "sec-fetch-mode": "navigate",
  accept: "text/html,application/xhtml+xml,*/*;q=0.8",
};

/** The viewer denying everyone with `status`, redirecting per `unauthorized` (`null`: the option left out). */
function denying(
  status: 401 | 403,
  unauthorized: DocsUiUnauthorizedOptions | null = { redirectTo: "/login" },
  extra: Parameters<typeof fixtureDocsUi>[0] = {},
) {
  return fixtureDocsUi({
    basePath: "/docs",
    authorize: () => ({ allow: false, status }),
    ...(unauthorized === null ? {} : { unauthorized }),
    ...extra,
  });
}

/** `ui` mounted at its basePath on a host router, as an app mounts it. */
function mounted(ui: ReturnType<typeof fixtureDocsUi>): BunRouter {
  const host = new BunRouter();
  host.use(ui.basePath, ui.router);
  return host;
}

/** Asserts `docsUi()` refuses `unauthorized` with bun-common's ConfigError matching `message`. */
function refuses(unauthorized: unknown, message: RegExp): void {
  let thrown: unknown;
  try {
    fixtureDocsUi({
      basePath: "/docs",
      unauthorized: unauthorized as DocsUiUnauthorizedOptions,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toMatch(message);
}

describe("unauthorized: options", () => {
  it("is off by default", () => {
    expect(fixtureDocsUi().config.unauthorized).toBeNull();
  });

  it("defaults returnParam to returnTo and statuses to [401], frozen, and travels in the page's config", async () => {
    const ui = fixtureDocsUi({ unauthorized: { redirectTo: "/login" } });
    expect(ui.config.unauthorized).toEqual({
      redirectTo: "/login",
      returnParam: "returnTo",
      statuses: [401],
    });
    expect(Object.isFrozen(ui.config.unauthorized)).toBe(true);
    expect(Object.isFrozen(ui.config.unauthorized!.statuses)).toBe(true);
    const { shell } = await fetchShell(ui.router, "/");
    expect(shell.config.unauthorized).toEqual(ui.config.unauthorized);
  });

  it("takes returnParam false or a name, and statuses sorted without repeats", () => {
    expect(
      fixtureDocsUi({
        unauthorized: {
          redirectTo: "https://id.example/sign-in",
          returnParam: false,
          statuses: [403, 401, 403],
        },
      }).config.unauthorized,
    ).toEqual({
      redirectTo: "https://id.example/sign-in",
      returnParam: null,
      statuses: [401, 403],
    });
    expect(
      fixtureDocsUi({
        unauthorized: { redirectTo: "/login", returnParam: "next" },
      }).config.unauthorized?.returnParam,
    ).toBe("next");
  });

  it("refuses a target inside its own basePath (a redirect loop), with bun-common's ConfigError", () => {
    for (const redirectTo of [
      "/docs",
      "/docs/",
      "/docs/login",
      "/DOCS/http",
      "/x/../docs/login",
    ]) {
      refuses(
        { redirectTo },
        /inside the UI's basePath \/docs: .*redirect loop/,
      );
    }
  });

  it("refuses every other kind of target, and a malformed option", () => {
    for (const [redirectTo, message] of [
      [undefined, /must be a path starting with "\/" or an absolute http/],
      ["login", /must be a path/],
      ["javascript:alert(1)", /must be a path/],
      ["data:text/html,<p>x</p>", /must be a path/],
      ["//id.example/login", /may not start with "\/\/"/],
      ["/\\id.example", /whitespace, control characters or "\\"/],
      ["/log in", /whitespace/],
      ["https://user:pass@id.example/", /credentials/],
    ] as const) {
      refuses({ redirectTo }, message);
    }
    refuses("/login", /unauthorized must be an object/);
    // A misspelt key (`to` for `redirectTo`) is refused, not ignored.
    refuses({ to: "/login" }, /unauthorized.redirectTo must be a path/);
    refuses(
      { redirectTo: "/login", returnParam: "a b" },
      /returnParam must be false or/,
    );
    refuses(
      { redirectTo: "/login", statuses: [] },
      /statuses must be a non-empty array/,
    );
    refuses(
      { redirectTo: "/login", statuses: [500] },
      /statuses must be a non-empty array/,
    );
  });

  it("throws the caller's own error class (jobsUi() passes bun-jobs')", () => {
    class OtherError extends Error {}
    expect(() =>
      resolveUnauthorized(
        { redirectTo: "login" },
        "/x",
        (message) => new OtherError(message),
      ),
    ).toThrow(OtherError);
  });
});

describe("unauthorized: the shell", () => {
  it("answers a denied navigation with 303 to the target, carrying the full path and query", async () => {
    const response = await mounted(denying(401)).fetch(
      "/docs/http/listQueues?q=mail",
      { headers: NAVIGATE },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/login?returnTo=%2Fdocs%2Fhttp%2FlistQueues%3Fq%3Dmail",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("treats an Accept naming text/html as a navigation without Sec-Fetch-Mode, and HEAD like GET", async () => {
    const accept = await mounted(denying(401)).fetch("/docs", {
      headers: { accept: "text/html" },
    });
    expect(accept.status).toBe(303);
    const head = await mounted(denying(401)).fetch("/docs/x", {
      method: "HEAD",
      headers: NAVIGATE,
    });
    expect(head.status).toBe(303);
    expect(head.headers.get("location")).toBe("/login?returnTo=%2Fdocs%2Fx");
  });

  it("keeps the problem for a request that is not a navigation", async () => {
    const notNavigations: Record<string, string>[] = [
      { "sec-fetch-mode": "cors", accept: "text/html" },
      { accept: "*/*" },
      {},
    ];
    for (const headers of notNavigations) {
      const response = await mounted(denying(401)).fetch("/docs", {
        headers,
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
      await response.text();
    }
  });

  it("keeps the problem for a bundle file and for the document, even on a navigation", async () => {
    const thunk = () => ({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
    });
    for (const path of ["/docs/assets/main.js", "/docs/document.json"]) {
      const response = await mounted(
        denying(401, { redirectTo: "/login" }, { document: thunk }),
      ).fetch(path, { headers: NAVIGATE });
      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
      await response.text();
    }
  });

  it("leaves a 403 alone by default, and redirects it when statuses lists it", async () => {
    const plain = await mounted(denying(403)).fetch("/docs", {
      headers: NAVIGATE,
    });
    expect(plain.status).toBe(403);
    await plain.text();
    const both = await mounted(
      denying(403, { redirectTo: "/login", statuses: [401, 403] }),
    ).fetch("/docs", { headers: NAVIGATE });
    expect(both.status).toBe(303);
  });

  it("follows returnParam: off, or renamed on an absolute target", async () => {
    const off = await mounted(
      denying(401, { redirectTo: "/login", returnParam: false }),
    ).fetch("/docs/http", { headers: NAVIGATE });
    expect(off.headers.get("location")).toBe("/login");
    const absolute = await mounted(
      denying(401, {
        redirectTo: "https://id.example/sign-in?app=docs#form",
        returnParam: "next",
      }),
    ).fetch("/docs/http", { headers: NAVIGATE });
    expect(absolute.headers.get("location")).toBe(
      "https://id.example/sign-in?app=docs&next=%2Fdocs%2Fhttp#form",
    );
  });

  it("is off without the option: a denied navigation is the problem, as before", async () => {
    const response = await mounted(denying(401, null)).fetch("/docs", {
      headers: NAVIGATE,
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    await response.text();
  });
});

describe("the shared helpers", () => {
  it("relativeReturnPath never hands back a path a browser would read as another host", () => {
    expect(relativeReturnPath("//evil.example/x")).toBe("/evil.example/x");
    expect(relativeReturnPath("/\\evil.example")).toBe("/evil.example");
    expect(relativeReturnPath("https://evil.example/")).toBe("/");
    expect(relativeReturnPath("/docs/q?a=1#h")).toBe("/docs/q?a=1#h");
  });

  it("unauthorizedRedirectUrl adds nothing without a returnParam or a return path", () => {
    expect(
      unauthorizedRedirectUrl(
        { redirectTo: "/login?x=1", returnParam: null },
        "/docs",
      ),
    ).toBe("/login?x=1");
    expect(
      unauthorizedRedirectUrl(
        { redirectTo: "/login", returnParam: "returnTo" },
        undefined,
      ),
    ).toBe("/login");
  });

  it("isUiUnauthorized accepts the resolved shape and nothing else", () => {
    expect(
      isUiUnauthorized({
        redirectTo: "/login",
        returnParam: null,
        statuses: [401],
      }),
    ).toBe(true);
    for (const value of [
      null,
      [],
      "x",
      { redirectTo: 1, returnParam: null, statuses: [401] },
      { redirectTo: "/l", returnParam: 1, statuses: [401] },
      { redirectTo: "/l", returnParam: null, statuses: "401" },
      { redirectTo: "/l", returnParam: null, statuses: [500] },
    ]) {
      expect(isUiUnauthorized(value)).toBe(false);
    }
  });
});
