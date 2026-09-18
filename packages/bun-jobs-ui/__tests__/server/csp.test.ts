/**
 * The shell's `connect-src`: `'self'` plus the explicit `ws(s)://` form of the
 * page's own origin (older WebKit does not let `'self'` match a socket), the
 * API's origin when it is elsewhere, and a dedicated socket port — never a
 * bare `ws:`/`wss:` that would allow a socket to any host.
 */
import type { JobsApi } from "@kingsleyweb/bun-jobs";
import { describe, expect, it } from "bun:test";
import { connectSources, cspHeader } from "../../lib/shell";
import { fixtureUi, parseCsp } from "./helpers";

/** The `connect-src` of the shell served for a request with this `Host`. */
async function connectSrcFor(
  ui: { router: { fetch: (input: Request) => Promise<Response> } },
  url: string,
  headers: Record<string, string> = {},
): Promise<string[] | undefined> {
  const response = await ui.router.fetch(new Request(url, { headers }));
  expect(response.status).toBe(200);
  return parseCsp(response.headers.get("content-security-policy")).get(
    "connect-src",
  );
}

/** A structural stand-in for a `JobsApi` with a socket. */
function apiWithSocket(port: number | undefined): JobsApi {
  return {
    basePath: "/jobs-api",
    routes: [],
    websocket: { path: "/jobs-api/ws", port },
  } as unknown as JobsApi;
}

describe("connect-src", () => {
  it("same origin: 'self' and the page's own ws: origin, no wildcard", async () => {
    const ui = fixtureUi();
    expect(
      await connectSrcFor(ui, "http://jobs.example:8080/", {
        host: "jobs.example:8080",
      }),
    ).toEqual(["'self'", "ws://jobs.example:8080"]);
    const api = fixtureUi({ api: apiWithSocket(undefined) });
    expect(
      await connectSrcFor(api, "http://127.0.0.1:3000/", {
        host: "127.0.0.1:3000",
      }),
    ).toEqual(["'self'", "ws://127.0.0.1:3000"]);
  });

  it("an https page gets wss:, from the URL or X-Forwarded-Proto", async () => {
    const ui = fixtureUi();
    expect(
      await connectSrcFor(ui, "https://jobs.example/", {
        host: "jobs.example",
      }),
    ).toEqual(["'self'", "wss://jobs.example"]);
    expect(
      await connectSrcFor(ui, "http://jobs.example/", {
        host: "jobs.example",
        "x-forwarded-proto": "https",
      }),
    ).toEqual(["'self'", "wss://jobs.example"]);
  });

  it("a cross-origin apiUrl adds its origin in http(s) and ws(s) form", async () => {
    const secure = fixtureUi({
      apiUrl: "https://api.example.com:8443/v1/jobs",
    });
    expect(
      await connectSrcFor(secure, "https://ui.example/", {
        host: "ui.example",
      }),
    ).toEqual([
      "'self'",
      "wss://ui.example",
      "https://api.example.com:8443",
      "wss://api.example.com:8443",
    ]);
    const plain = fixtureUi({ apiUrl: "http://api.example" });
    expect(
      await connectSrcFor(plain, "http://ui.example/", { host: "ui.example" }),
    ).toEqual([
      "'self'",
      "ws://ui.example",
      "http://api.example",
      "ws://api.example",
    ]);
  });

  it("a dedicated socket port adds that port on the page's hostname", async () => {
    const ui = fixtureUi({ api: apiWithSocket(4567) });
    expect(
      await connectSrcFor(ui, "http://jobs.example:8080/", {
        host: "jobs.example:8080",
      }),
    ).toEqual(["'self'", "ws://jobs.example:8080", "ws://jobs.example:4567"]);
    expect(
      await connectSrcFor(ui, "https://jobs.example/", {
        host: "jobs.example",
      }),
    ).toEqual(["'self'", "wss://jobs.example", "wss://jobs.example:4567"]);
  });

  it("a malformed Host cannot inject a directive: it is omitted", async () => {
    const ui = fixtureUi({ api: apiWithSocket(4567) });
    for (const host of [
      "evil.example; script-src *",
      "evil.example script-src",
      "evil.example,x",
      "evil.example:99999",
      "evil.example:",
      "a@b",
      "[::1]:80",
      "",
    ]) {
      const response = await ui.router.fetch(
        new Request("http://jobs.example/", { headers: { host } }),
      );
      const header = response.headers.get("content-security-policy")!;
      const csp = parseCsp(header);
      expect(csp.get("connect-src")).toEqual(["'self'"]);
      expect(csp.get("script-src")!.slice(0, 1)).toEqual(["'self'"]);
      expect(header.split(";")).toHaveLength(8);
      expect(header).not.toContain("evil");
    }
  });
});

describe("connectSources / cspHeader", () => {
  it("builds the sources from the page origin, the API and a port", () => {
    expect(connectSources({ host: "h.example", secure: false })).toEqual([
      "ws://h.example",
    ]);
    expect(
      connectSources({
        host: "h.example:81",
        secure: true,
        apiOrigin: "http://api.example:9000",
        websocketPort: 4000,
      }),
    ).toEqual([
      "wss://h.example:81",
      "wss://h.example:4000",
      "http://api.example:9000",
      "ws://api.example:9000",
    ]);
    expect(connectSources({ host: "bad host", secure: false })).toEqual([]);
  });

  it("cspHeader drops a source that is not a single token", () => {
    const csp = parseCsp(
      cspHeader({
        nonce: "n",
        connectSrc: ["https://ok.example", "x; script-src *", "a b", "c,d"],
      }),
    );
    expect(csp.get("connect-src")).toEqual(["'self'", "https://ok.example"]);
    expect(csp.get("script-src")).toEqual(["'self'", "'nonce-n'"]);
  });
});
