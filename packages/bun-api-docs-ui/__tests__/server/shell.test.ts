/**
 * The HTML shell: its markup, its headers, the CSP and nonce, and the
 * injected configuration — all through `router.fetch()`, no socket.
 */
import { describe, expect, it } from "bun:test";
import { DOCS_UI_CONFIG_ELEMENT_ID } from "../../lib/shared/config";
import { cspHeader, escapeHtml, jsonForScript } from "../../lib/shell";
import {
  cspNonce,
  fetchShell,
  fixtureDocsUi,
  parseCsp,
  parseShell,
} from "./helpers";

describe("the shell", () => {
  it("serves an HTML page with the security headers", async () => {
    const ui = fixtureDocsUi();
    const { response, html } = await fetchShell(ui.router, "/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(html).toContain("<title>API docs</title>");
    expect(html).toContain('<div id="root"></div>');
  });

  it("sends the exact CSP, with a nonce every nonce'd element carries", async () => {
    const ui = fixtureDocsUi();
    const { response, shell } = await fetchShell(ui.router, "/");
    const csp = response.headers.get("content-security-policy");
    const nonce = cspNonce(csp);

    expect(nonce).toBeString();
    expect(nonce!.length).toBeGreaterThanOrEqual(22);
    expect(csp).toBe(
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    expect(shell.configNonce).toBe(nonce!);
    expect(shell.script.nonce).toBe(nonce!);
    // Bun's split-chunk preloader reads it from here.
    expect(shell.metaNonce).toBe(nonce!);
  });

  it("a cross-origin document URL adds its origin to connect-src", async () => {
    const ui = fixtureDocsUi({
      document: "https://api.example.com:8443/v1/openapi.json",
    });
    const { response } = await fetchShell(ui.router, "/");
    expect(
      parseCsp(response.headers.get("content-security-policy")).get(
        "connect-src",
      ),
    ).toEqual(["'self'", "https://api.example.com:8443"]);
  });

  it("uses a fresh nonce for every request", async () => {
    const ui = fixtureDocsUi();
    const nonces = new Set<string | undefined>();
    for (let i = 0; i < 5; i++) {
      const response = await ui.router.fetch("/");
      nonces.add(cspNonce(response.headers.get("content-security-policy")));
      await response.text();
    }
    expect(nonces.size).toBe(5);
  });

  it("links the entry module and stylesheet with integrity, under assetsPath", async () => {
    const ui = fixtureDocsUi();
    const { shell } = await fetchShell(ui.router, "/");

    expect(shell.script.src).toMatch(/^\/docs\/assets\/entry-[\w-]+\.js$/);
    expect(shell.script.integrity).toMatch(/^sha384-[\w+/]+=*$/);
    expect(shell.styles).toHaveLength(1);
    expect(shell.styles[0].href).toMatch(/^\/docs\/assets\/entry-[\w-]+\.css$/);
    expect(shell.styles[0].integrity).toMatch(/^sha384-/);
  });

  it("injects the resolved configuration as parseable JSON", async () => {
    const ui = fixtureDocsUi({
      basePath: "/admin/api",
      title: "Shop API",
      theme: "dark",
    });
    const { shell } = await fetchShell(ui.router, "/");

    expect(shell.config).toEqual({
      version: 1,
      title: "Shop API",
      basePath: "/admin/api",
      assetsPath: "/admin/api/assets",
      documentUrl: "/api/openapi.json",
      csrfHeader: null,
      extensions: ["x-bun-common", "x-bun-jobs"],
      theme: "dark",
    });
    expect(shell.config).toEqual(ui.config);
  });

  it("escapes the title and the config for their contexts", async () => {
    const title = "</script><script>alert(1)</script> & \u2028\u2029 'q\"";
    const ui = fixtureDocsUi({ title });
    const { html, shell } = await fetchShell(ui.router, "/");

    // Exactly the two real scripts close: nothing in the title ends one early.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(shell.configText).not.toContain("<");
    expect(shell.configText).not.toContain(">");
    expect(shell.configText).not.toContain("\u2028");
    expect(shell.configText).not.toContain("\u2029");
    expect(shell.configText).toContain("\\u003c/script\\u003e");
    // It still round-trips exactly.
    expect(shell.config.title).toBe(title);

    expect(shell.title).toBe(
      "&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; \u2028\u2029 &#39;q&quot;",
    );
  });

  it("puts the config in the element the app reads", async () => {
    const ui = fixtureDocsUi();
    const { html } = await fetchShell(ui.router, "/");
    expect(html).toContain(
      `<script type="application/json" id="${DOCS_UI_CONFIG_ELEMENT_ID}" nonce=`,
    );
  });

  it("sets color-scheme from the theme", async () => {
    for (const [theme, scheme] of [
      ["system", "light dark"],
      ["light", "light"],
      ["dark", "dark"],
    ] as const) {
      const { html } = await fetchShell(fixtureDocsUi({ theme }).router, "/");
      expect(html).toContain(`<meta name="color-scheme" content="${scheme}">`);
    }
  });

  it("answers every client route under basePath with the shell (SPA fallback)", async () => {
    const ui = fixtureDocsUi();
    for (const path of [
      "/",
      "/http",
      "/http/listQueues",
      "/ws/channel-queue",
      "/a/b/c/d/e.html",
      "/assetsx",
    ]) {
      const response = await ui.router.fetch(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      parseShell(await response.text());
    }
  });

  it("answers HEAD with the headers and no body", async () => {
    const ui = fixtureDocsUi();
    const response = await ui.router.fetch("/http", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "'nonce-",
    );
    expect(await response.text()).toBe("");
  });

  it("does not claim other methods: they fall through (404 on a bare router)", async () => {
    const ui = fixtureDocsUi();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await ui.router.fetch("/", { method });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
  });
});

describe("shell helpers", () => {
  it("escapeHtml covers the five characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("jsonForScript is still JSON and round-trips", () => {
    const value = { a: "</script><!-- & \u2028\u2029 >" };
    const text = jsonForScript(value);
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(text)).toEqual(value);
  });

  it("cspHeader appends extra connect-src sources after 'self', no wildcard", () => {
    const csp = parseCsp(
      cspHeader({ nonce: "n", connectSrc: ["https://api.example"] }),
    );
    expect(csp.get("connect-src")).toEqual(["'self'", "https://api.example"]);
    expect(csp.get("script-src")).toEqual(["'self'", "'nonce-n'"]);
  });

  it("cspHeader drops a source that is not a single token", () => {
    const csp = parseCsp(
      cspHeader({
        nonce: "n",
        connectSrc: ["https://ok.example", "x; script-src *", "a b", "c,d"],
      }),
    );
    expect(csp.get("connect-src")).toEqual(["'self'", "https://ok.example"]);
  });
});
