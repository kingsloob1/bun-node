/**
 * `app/unauthorized.ts` without a DOM: the redirect's decisions against a
 * fake location and fetch, and the cache watcher against a real QueryClient.
 */
import type { RedirectLocation } from "../../app/unauthorized";
import type { UiUnauthorized } from "../../lib/shared/unauthorized.ts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "bun:test";
import { DocsUiConfigError, parseDocsUiConfig } from "../../app/config";
import {
  createUnauthorizedRedirect,
  NO_UNAUTHORIZED_REDIRECT,
  statusOf,
  watchAuthFailures,
} from "../../app/unauthorized";
import { expectAbsent, expectUndefined } from "./assert";

/** `unauthorized: { redirectTo: "/login" }`, resolved. */
const TO_LOGIN: UiUnauthorized = {
  redirectTo: "/login",
  returnParam: "returnTo",
  statuses: [401],
};

/** A location at `href` recording every `assign`. */
function fakeLocation(href = "https://ops.example/jobs/queues?q=a#top") {
  const assigned: string[] = [];
  const location: RedirectLocation = {
    href,
    assign: (url) => {
      assigned.push(url);
    },
  };
  return { location, assigned };
}

/** A `fetch` answering `status`, recording what it was asked. */
function fakeFetch(status: number | "network") {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    asked.push({ url, init });
    if (status === "network") {
      throw new TypeError("Failed to fetch");
    }
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetcher, asked };
}

describe("statusOf", () => {
  it("reads a numeric status from any error-like value", () => {
    expect(statusOf({ status: 401 })).toBe(401);
    expect(statusOf(Object.assign(new Error("x"), { status: 403 }))).toBe(403);
    expectUndefined(statusOf({ status: "401" }));
    expectUndefined(statusOf(new Error("x")));
    expectUndefined(statusOf(null));
    expectUndefined(statusOf("401"));
  });
});

describe("createUnauthorizedRedirect", () => {
  it("is the no-op redirect when the option is off", async () => {
    const redirect = createUnauthorizedRedirect(null, "/jobs");
    expect(redirect).toBe(NO_UNAUTHORIZED_REDIRECT);
    expect(redirect.enabled).toBe(false);
    expect(redirect.report(401)).toBe(false);
    expect(await redirect.probe()).toBe(false);
  });

  it("navigates on a listed status, once, with the relative in-app location", () => {
    const { location, assigned } = fakeLocation();
    const redirect = createUnauthorizedRedirect(TO_LOGIN, "/jobs", {
      location: () => location,
    });
    expect(redirect.report(403)).toBe(false);
    expect(redirect.report(500)).toBe(false);
    expect(redirect.redirected).toBe(false);
    expect(redirect.report(401)).toBe(true);
    expect(redirect.report(401)).toBe(true);
    expect(redirect.reportError({ status: 401 })).toBe(true);
    expect(redirect.redirected).toBe(true);
    expect(assigned).toEqual([
      "/login?returnTo=%2Fjobs%2Fqueues%3Fq%3Da%23top",
    ]);
  });

  it("never follows a target that resolves into its own basePath on its own origin", () => {
    for (const to of [
      "https://ops.example/jobs/login",
      "https://ops.example/JOBS",
      "https://ops.example/%6Aobs/x",
    ]) {
      const { location, assigned } = fakeLocation();
      const redirect = createUnauthorizedRedirect(
        { ...TO_LOGIN, redirectTo: to },
        "/jobs",
        {
          location: () => location,
        },
      );
      expect(redirect.report(401)).toBe(false);
      expect(assigned).toEqual([]);
    }
    // The same path on another origin is somewhere else: followed.
    const { location, assigned } = fakeLocation();
    createUnauthorizedRedirect(
      { ...TO_LOGIN, redirectTo: "https://id.example/jobs/login" },
      "/jobs",
      { location: () => location },
    ).report(401);
    expect(assigned).toEqual([
      "https://id.example/jobs/login?returnTo=%2Fjobs%2Fqueues%3Fq%3Da%23top",
    ]);
  });

  it("does nothing without a location (no browser)", () => {
    const redirect = createUnauthorizedRedirect(TO_LOGIN, "/jobs", {
      location: () => undefined,
    });
    expect(redirect.report(401)).toBe(false);
    expect(redirect.redirected).toBe(false);
  });

  it("probe: a HEAD of the shell, whose status is reported", async () => {
    const { location, assigned } = fakeLocation();
    const { fetcher, asked } = fakeFetch(401);
    const redirect = createUnauthorizedRedirect(TO_LOGIN, "/jobs", {
      location: () => location,
      fetch: () => fetcher,
    });
    expect(await redirect.probe()).toBe(true);
    expect(asked).toEqual([
      {
        url: "/jobs",
        init: { method: "HEAD", credentials: "same-origin", cache: "no-store" },
      },
    ]);
    expect(assigned).toHaveLength(1);
    // Already sent away: no second probe.
    expect(await redirect.probe()).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("probe: a 200, an unlisted status or a failed probe navigate nowhere", async () => {
    for (const status of [200, 403, 500, "network"] as const) {
      const { location, assigned } = fakeLocation();
      const { fetcher } = fakeFetch(status);
      const redirect = createUnauthorizedRedirect(TO_LOGIN, "/jobs", {
        location: () => location,
        fetch: () => fetcher,
      });
      expect(await redirect.probe()).toBe(false);
      expect(assigned).toEqual([]);
    }
  });
});

describe("watchAuthFailures", () => {
  /** A rejection carrying `status`, as ApiError and bun-client's HttpError do. */
  const failing = (status: number) => () =>
    Promise.reject(Object.assign(new Error(`HTTP ${status}`), { status }));

  it("reports failed queries and mutations, and stops when unsubscribed", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const reported: unknown[] = [];
    const stop = watchAuthFailures(queryClient, {
      ...NO_UNAUTHORIZED_REDIRECT,
      enabled: true,
      reportError: (error) => {
        reported.push(statusOf(error));
        return false;
      },
    });
    await queryClient
      .fetchQuery({ queryKey: ["a"], queryFn: failing(401) })
      .catch(() => {});
    await queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: failing(403) })
      .execute(undefined)
      .catch(() => {});
    await queryClient
      .fetchQuery({ queryKey: ["b"], queryFn: async () => 1 })
      .catch(() => {});
    expect(reported).toEqual([401, 403]);

    stop();
    await queryClient
      .fetchQuery({ queryKey: ["c"], queryFn: failing(401) })
      .catch(() => {});
    expect(reported).toEqual([401, 403]);
  });

  it("subscribes to nothing when the redirect is off", () => {
    const queryClient = new QueryClient();
    const stop = watchAuthFailures(queryClient, NO_UNAUTHORIZED_REDIRECT);
    expect(queryClient.getQueryCache().hasListeners()).toBe(false);
    expect(queryClient.getMutationCache().hasListeners()).toBe(false);
    stop();
  });
});

describe("parseDocsUiConfig: unauthorized", () => {
  /** A valid config, as `docsUi()` injects it. */
  const base = {
    version: 1,
    title: "API docs",
    basePath: "/docs",
    assetsPath: "/docs/assets",
    documentUrl: "/docs/document.json",
    csrfHeader: null,
    extensions: ["x-bun-common"],
    theme: "system",
  };

  it("reads a missing field as off (an older shell, or bun-common's docsRouter, which mirrors the config)", () => {
    expectAbsent(parseDocsUiConfig(base).unauthorized);
    expectAbsent(
      parseDocsUiConfig({ ...base, unauthorized: null }).unauthorized,
    );
  });

  it("passes a resolved option through, and refuses a malformed one", () => {
    expect(
      parseDocsUiConfig({ ...base, unauthorized: TO_LOGIN }).unauthorized,
    ).toEqual(TO_LOGIN);
    for (const unauthorized of [
      "/login",
      { redirectTo: "/login" },
      { ...TO_LOGIN, statuses: [500] },
    ]) {
      expect(() => parseDocsUiConfig({ ...base, unauthorized })).toThrow(
        DocsUiConfigError,
      );
    }
  });
});
