/**
 * `unauthorized` on the server: what `jobsUi()` accepts and refuses, what it
 * puts in the page's config, and the shell's `303` for a denied navigation.
 */
import type { JobsUiUnauthorizedOptions } from "../../lib/types";
import { BunRouter } from "@kingsleyweb/bun-common";
import { ConfigError } from "@kingsleyweb/bun-jobs";
import { describe, expect, it } from "bun:test";
import {
  unauthorizedRedirectUrl,
  relativeReturnPath,
} from "../../lib/shared/unauthorized";
import { fetchShell, fixtureUi } from "./helpers";

/** A browser's page navigation. */
const NAVIGATE = {
  "sec-fetch-mode": "navigate",
  accept: "text/html,application/xhtml+xml,*/*;q=0.8",
};

/** The UI denying everyone with `status`, redirecting per `unauthorized`. */
function denying(
  status: 401 | 403,
  unauthorized: JobsUiUnauthorizedOptions | null = { redirectTo: "/login" },
  basePath = "/jobs",
) {
  return fixtureUi({
    basePath,
    authorize: () => ({ allow: false, status }),
    ...(unauthorized === null ? {} : { unauthorized }),
  });
}

/** `ui` mounted at its basePath on a host router, as an app mounts it. */
function mounted(ui: ReturnType<typeof fixtureUi>): BunRouter {
  const host = new BunRouter();
  host.use(ui.basePath, ui.router);
  return host;
}

/** Asserts `jobsUi()` refuses `unauthorized` with a ConfigError matching `message`. */
function refuses(
  unauthorized: unknown,
  message: RegExp,
  basePath = "/jobs",
): void {
  let thrown: unknown;
  try {
    fixtureUi({
      basePath,
      unauthorized: unauthorized as JobsUiUnauthorizedOptions,
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toMatch(message);
}

describe("unauthorized: options", () => {
  it("is off by default", () => {
    expect(fixtureUi().config.unauthorized).toBeNull();
  });

  it("defaults returnParam to returnTo and statuses to [401], frozen", () => {
    const { config } = fixtureUi({ unauthorized: { redirectTo: "/login" } });
    expect(config.unauthorized).toEqual({
      redirectTo: "/login",
      returnParam: "returnTo",
      statuses: [401],
    });
    expect(Object.isFrozen(config.unauthorized)).toBe(true);
    expect(Object.isFrozen(config.unauthorized!.statuses)).toBe(true);
  });

  it("takes returnParam false, a custom name, and statuses sorted without repeats", () => {
    const { config } = fixtureUi({
      unauthorized: {
        redirectTo: "https://id.example/sign-in?app=jobs",
        returnParam: false,
        statuses: [403, 401, 403],
      },
    });
    expect(config.unauthorized).toEqual({
      redirectTo: "https://id.example/sign-in?app=jobs",
      returnParam: null,
      statuses: [401, 403],
    });
    expect(
      fixtureUi({ unauthorized: { redirectTo: "/login", returnParam: "next" } })
        .config.unauthorized?.returnParam,
    ).toBe("next");
  });

  it("travels to the browser in the page's config", async () => {
    const ui = fixtureUi({ unauthorized: { redirectTo: "/login" } });
    const { shell } = await fetchShell(ui.router, "/");
    expect(shell.config.unauthorized).toEqual({
      redirectTo: "/login",
      returnParam: "returnTo",
      statuses: [401],
    });
  });

  it("accepts paths and http(s) URLs outside the UI", () => {
    for (const to of [
      "/login",
      "/auth/sign-in?app=jobs#form",
      "/jobsx/login",
      "/job",
      "/",
      "/jobs-login",
      "/x/../login",
      "http://id.example",
      "HTTPS://id.example/sign-in",
      "https://id.example:8443/jobs/login",
    ]) {
      expect(
        fixtureUi({ unauthorized: { redirectTo: to } }).config.unauthorized
          ?.redirectTo,
      ).toBe(to);
    }
  });

  it("refuses a target inside its own basePath: a redirect loop", () => {
    for (const to of [
      "/jobs",
      "/jobs/",
      "/jobs/login",
      "/jobs?x=1",
      "/jobs#x",
      "/JOBS/login",
      "/x/../jobs/login",
      "/%6Aobs/login",
      "/jobs/assets/x.js",
    ]) {
      refuses(
        { redirectTo: to },
        /inside the UI's basePath \/jobs: .*redirect loop/,
      );
    }
    refuses({ redirectTo: "/admin/ui/sign-in" }, /redirect loop/, "/admin/ui");
  });

  it("refuses every other kind of target", () => {
    for (const [to, message] of [
      [undefined, /must be a path starting with "\/" or an absolute http/],
      ["", /must be a path/],
      [42, /must be a path/],
      ["login", /must be a path/],
      ["./login", /must be a path/],
      ["javascript:alert(1)", /must be a path/],
      ["JavaScript:alert(1)", /must be a path/],
      ["data:text/html,<p>x</p>", /must be a path/],
      ["ftp://id.example/", /must be a path/],
      ["https:id.example", /must be a path/],
      ["mailto:a@b.example", /must be a path/],
      ["//id.example/login", /may not start with "\/\/"/],
      ["/\\id.example/login", /whitespace, control characters or "\\"/],
      [" /login", /whitespace/],
      ["/log in", /whitespace/],
      ["/login\n", /whitespace/],
      ["/login\u0000", /control characters/],
      ["https://user:pass@id.example/", /credentials/],
      ["https://user@id.example/", /credentials/],
      ["https://", /must be a path/],
    ] as const) {
      refuses({ redirectTo: to }, message);
    }
  });

  it("refuses a malformed option, returnParam or statuses", () => {
    refuses("/login", /unauthorized must be an object/);
    refuses(null, /unauthorized must be an object/);
    refuses(["/login"], /unauthorized must be an object/);
    // A misspelt key (`to` for `redirectTo`) is refused, not ignored.
    refuses({ to: "/login" }, /unauthorized.redirectTo must be a path/);
    for (const returnParam of ["", "return to", "a&b", "a=b", 1, true]) {
      refuses(
        { redirectTo: "/login", returnParam },
        /returnParam must be false or/,
      );
    }
    for (const statuses of [[], [500], [401, 500], ["401"], 401, "401", {}]) {
      refuses(
        { redirectTo: "/login", statuses },
        /statuses must be a non-empty array/,
      );
    }
  });
});

describe("unauthorized: the shell", () => {
  it("answers a denied navigation with 303 to the target, carrying the full path and query", async () => {
    const response = await mounted(denying(401)).fetch(
      "/jobs/queues/mail?state=failed",
      { headers: NAVIGATE },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/login?returnTo=%2Fjobs%2Fqueues%2Fmail%3Fstate%3Dfailed",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("treats an Accept naming text/html as a navigation when Sec-Fetch-Mode is absent", async () => {
    const response = await mounted(denying(401)).fetch("/jobs", {
      headers: { accept: "text/html" },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?returnTo=%2Fjobs");
  });

  it("answers HEAD the same way", async () => {
    const response = await mounted(denying(401)).fetch("/jobs/x", {
      method: "HEAD",
      headers: NAVIGATE,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/login?returnTo=%2Fjobs%2Fx",
    );
  });

  it("keeps the problem for a request that is not a navigation", async () => {
    const notNavigations: Record<string, string>[] = [
      { "sec-fetch-mode": "cors", accept: "text/html" },
      { "sec-fetch-mode": "no-cors" },
      { accept: "*/*" },
      { accept: "application/json" },
      {},
    ];
    for (const headers of notNavigations) {
      const response = await mounted(denying(401)).fetch("/jobs/queues", {
        headers,
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(response.headers.get("location")).toBeNull();
      await response.text();
    }
  });

  it("keeps the problem for a bundle file, even on a navigation", async () => {
    for (const path of [
      "/jobs/assets/main.js",
      "/jobs/assets",
      "/jobs/assets/a/b",
    ]) {
      const response = await mounted(denying(401)).fetch(path, {
        headers: NAVIGATE,
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
      await response.text();
    }
  });

  it("leaves a 403 alone by default, and redirects it when statuses lists it", async () => {
    const plain = await mounted(denying(403)).fetch("/jobs", {
      headers: NAVIGATE,
    });
    expect(plain.status).toBe(403);
    expect(plain.headers.get("location")).toBeNull();
    await plain.text();

    const both = await mounted(
      denying(403, { redirectTo: "/login", statuses: [401, 403] }),
    ).fetch("/jobs", { headers: NAVIGATE });
    expect(both.status).toBe(303);
    expect(both.headers.get("location")).toBe("/login?returnTo=%2Fjobs");

    const only403 = await mounted(
      denying(401, { redirectTo: "/login", statuses: [403] }),
    ).fetch("/jobs", { headers: NAVIGATE });
    expect(only403.status).toBe(401);
    await only403.text();
  });

  it("follows returnParam: off, renamed, replacing one already in the target, keeping its fragment", async () => {
    const off = await mounted(
      denying(401, { redirectTo: "/login", returnParam: false }),
    ).fetch("/jobs/queues", { headers: NAVIGATE });
    expect(off.headers.get("location")).toBe("/login");

    const absolute = await mounted(
      denying(401, {
        redirectTo: "https://id.example/sign-in?app=jobs&next=stale#form",
        returnParam: "next",
      }),
    ).fetch("/jobs/queues", { headers: NAVIGATE });
    expect(absolute.headers.get("location")).toBe(
      "https://id.example/sign-in?app=jobs&next=%2Fjobs%2Fqueues#form",
    );
  });

  it("is off without the option: a denied navigation is the problem, as before", async () => {
    const response = await mounted(denying(401, null)).fetch("/jobs", {
      headers: NAVIGATE,
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    await response.text();
  });

  it("serves the page as usual when authorize allows it", async () => {
    const ui = fixtureUi({
      authorize: () => true,
      unauthorized: { redirectTo: "/login" },
    });
    const response = await mounted(ui).fetch("/jobs", { headers: NAVIGATE });
    expect(response.status).toBe(200);
    await response.text();
  });
});

describe("unauthorizedRedirectUrl / relativeReturnPath", () => {
  it("never hands back a path a browser would read as another host", () => {
    expect(relativeReturnPath("//evil.example/x")).toBe("/evil.example/x");
    expect(relativeReturnPath("/\\evil.example")).toBe("/evil.example");
    expect(relativeReturnPath("https://evil.example/")).toBe("/");
    expect(relativeReturnPath("/jobs/q?a=1#h")).toBe("/jobs/q?a=1#h");
  });

  it("adds nothing without a returnParam or a return path", () => {
    expect(
      unauthorizedRedirectUrl(
        { redirectTo: "/login?x=1", returnParam: null },
        "/jobs",
      ),
    ).toBe("/login?x=1");
    expect(
      unauthorizedRedirectUrl(
        { redirectTo: "/login", returnParam: "returnTo" },
        undefined,
      ),
    ).toBe("/login");
  });
});
