/**
 * The adapter's side of routing parity with `@nestjs/platform-express`
 * (NestJS 12 parity plan, PR-5), unit by unit: `normalizePath` and the
 * middleware factory convert legacy paths with Nest's `LegacyRouteConverter`
 * and reject what Express rejects; the router is case-insensitive by
 * default; `getRequestHostname` is Express's `req.hostname`. The routing
 * differential (`routingCompat.nest.test.ts`) checks the same against a real
 * Express application.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import { RequestMethod } from "@nestjs/common";
import { LegacyRouteConverter } from "@nestjs/core/router/legacy-route-converter.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";

/** The converter's Nest logger (a private static), to watch its output. */
const converterLogger = (
  LegacyRouteConverter as unknown as {
    logger: {
      warn: (message: string) => void;
      error: (message: string) => void;
    };
  }
).logger;

/** A middleware that only calls `next()`. */
const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();

/** Silences and records the converter's warnings and errors. */
function watchConverter() {
  const warn = spyOn(converterLogger, "warn").mockImplementation(() => {});
  const error = spyOn(converterLogger, "error").mockImplementation(() => {});
  return { warn, error };
}

afterEach(() => {
  // Each test installs its own spies.
  (
    converterLogger.warn as unknown as { mockRestore?: () => void }
  ).mockRestore?.();
  (
    converterLogger.error as unknown as { mockRestore?: () => void }
  ).mockRestore?.();
});

describe("BunHttpAdapter.normalizePath", () => {
  it("returns a path-to-regexp 8 path unchanged, silently", () => {
    const adapter = new BunHttpAdapter();
    const { warn, error } = watchConverter();
    for (const path of ["/users/:id", "/files/*path", "/opt{/:x}", "/"]) {
      expect(adapter.normalizePath(path)).toBe(path);
    }
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("converts a legacy wildcard and warns, as Express's adapter does", () => {
    const adapter = new BunHttpAdapter();
    const { warn } = watchConverter();
    expect(adapter.normalizePath("/legacy/*")).toBe("/legacy/{*path}");
    expect(adapter.normalizePath("/old/(.*)")).toBe("/old/{*path}");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain(
      'Unsupported route path: "/legacy/*"',
    );
  });

  it("throws path-to-regexp's error for :x? and :x(\\d+), logging the converter's", () => {
    const adapter = new BunHttpAdapter();
    const { error } = watchConverter();
    expect(() => adapter.normalizePath("/optp/:x?")).toThrow(
      "Unexpected ? at index 8: /optp/:x?; visit https://git.new/pathToRegexpError for info",
    );
    expect(() => adapter.normalizePath("/num/:id(\\d+)")).toThrow(TypeError);
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0][0])).toContain(
      'Unsupported route path: "/optp/:x?"',
    );
  });
});

describe("BunHttpAdapter.createMiddlewareFactory", () => {
  it("converts `/*` to `/{*path}` without a warning (the all-wildcard)", async () => {
    const adapter = new BunHttpAdapter();
    const { warn } = watchConverter();
    const register = adapter.createMiddlewareFactory(RequestMethod.ALL);
    register("/*", passThrough);
    expect(warn).not.toHaveBeenCalled();
    const paths = adapter.instance
      .routes()
      .map((route) => route.group ?? route.path);
    expect(paths).toEqual(["/{*path}"]);
  });

  it("converts and warns for a legacy prefix wildcard", () => {
    const adapter = new BunHttpAdapter();
    const { warn } = watchConverter();
    const register = adapter.createMiddlewareFactory(RequestMethod.GET);
    register("/api/*", passThrough);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(adapter.instance.routes().map((route) => route.group)).toEqual([
      "/api/{*path}",
    ]);
  });

  it("strips the exact marker before converting", () => {
    const adapter = new BunHttpAdapter();
    watchConverter();
    const register = adapter.createMiddlewareFactory(RequestMethod.ALL);
    register("/api$", passThrough);
    expect(adapter.instance.routes().map((route) => route.path)).toEqual([
      "/api",
    ]);
  });

  it("rejects a path Express rejects, logging the converter's error", () => {
    const adapter = new BunHttpAdapter();
    const { error } = watchConverter();
    const register = adapter.createMiddlewareFactory(RequestMethod.ALL);
    expect(() => register("/a/:x?", passThrough)).toThrow(TypeError);
    expect(error).toHaveBeenCalledTimes(1);
    expect(adapter.instance.routes()).toHaveLength(0);
  });
});

describe("BunHttpAdapter: router case sensitivity", () => {
  it("matches case-insensitively by default, as Express does", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/Hello", (_req, res) => res.send("hi"));
    expect((await adapter.fetch("/hello")).status).toBe(200);
    expect((await adapter.fetch("/HELLO")).status).toBe(200);
  });

  it("matches exact case with router: { caseSensitive: true }", async () => {
    const adapter = new BunHttpAdapter(undefined, {
      router: { caseSensitive: true },
    });
    adapter.get("/Hello", (_req, res) => res.send("hi"));
    expect((await adapter.fetch("/Hello")).status).toBe(200);
    expect((await adapter.fetch("/hello")).status).toBe(404);
  });
});

describe("BunHttpAdapter.getRequestHostname", () => {
  /** The adapter's hostname for a request carrying `host` (or none). */
  async function hostnameFor(url: string, host?: string): Promise<string> {
    const adapter = new BunHttpAdapter();
    adapter.get("/h", (req, res) => {
      res.send(adapter.getRequestHostname(req as BunRequest));
    });
    const headers = host === undefined ? undefined : { host };
    return (await adapter.fetch(new Request(url, { headers }))).text();
  }

  it("keeps the Host header's case and strips its port", async () => {
    expect(await hostnameFor("http://x.test/h", "A.Example.com:8080")).toBe(
      "A.Example.com",
    );
  });

  it("keeps an IPv6 literal's brackets", async () => {
    expect(await hostnameFor("http://x.test/h", "[::1]:3000")).toBe("[::1]");
    expect(await hostnameFor("http://x.test/h", "[::1]")).toBe("[::1]");
  });

  it("ignores X-Forwarded-Host, as Express does without trust proxy", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get("/h", (req, res) => {
      res.send(adapter.getRequestHostname(req as BunRequest));
    });
    const response = await adapter.fetch(
      new Request("http://x.test/h", {
        headers: { host: "real.test", "x-forwarded-host": "proxy.test" },
      }),
    );
    expect(await response.text()).toBe("real.test");
  });

  it("falls back to the URL's host name without a Host header", async () => {
    expect(await hostnameFor("http://y.test:81/h")).toBe("y.test");
  });
});
