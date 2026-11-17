/**
 * The shell `securityUi()` serves: headers, the nonce CSP, SRI on every
 * asset, the injected config, client routes, and the API's paths left to
 * the API's router — through `router.fetch()`, no socket.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import {
  closeSecurityApis,
  cspNonce,
  fetchSecurityShell,
  fixtureSecurityUi,
  memorySecurityApi,
  parseCsp,
} from "./helpers";

afterAll(closeSecurityApis);

describe("the shell", () => {
  it("is an HTML page with the security headers and the config", async () => {
    const ui = fixtureSecurityUi({ title: "Guard <&>" });
    const { response, shell, html } = await fetchSecurityShell(ui.router, "/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html).toContain('<div id="root"></div>');
    expect(shell.title).toBe("Guard &lt;&amp;&gt;");
    expect(shell.config).toEqual(JSON.parse(JSON.stringify(ui.config)));
  });

  it("sends a nonce CSP, carried by every nonce'd element, with SRI on the assets", async () => {
    const { response, shell } = await fetchSecurityShell(
      fixtureSecurityUi().router,
      "/",
    );
    const csp = response.headers.get("content-security-policy");
    const nonce = cspNonce(csp);
    expect(nonce).toBeString();
    const directives = parseCsp(csp);
    expect(directives.get("script-src")).toEqual([
      "'self'",
      `'nonce-${nonce}'`,
    ]);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(shell.configNonce).toBe(nonce!);
    expect(shell.script.nonce).toBe(nonce!);
    expect(shell.script.src.startsWith("/security/assets/")).toBe(true);
    expect(shell.script.integrity).toMatch(/^sha384-/);
    expect(shell.styles.length).toBeGreaterThan(0);
    for (const style of shell.styles)
      expect(style.integrity).toMatch(/^sha384-/);
  });

  it("a cross-origin apiUrl adds its origin to connect-src, and nothing else", async () => {
    const ui = fixtureSecurityUi({
      apiUrl: "https://sec.example.com:8443/api",
    });
    const { response } = await fetchSecurityShell(ui.router, "/");
    expect(
      parseCsp(response.headers.get("content-security-policy")).get(
        "connect-src",
      ),
    ).toEqual(["'self'", "https://sec.example.com:8443"]);
  });

  it("serves the shell for every client route, and its assets with the hash", async () => {
    const ui = fixtureSecurityUi();
    for (const path of [
      "/",
      "/api",
      "/api/operations/getMeta",
      "/bans?scope=global",
    ]) {
      const { response } = await fetchSecurityShell(ui.router, path);
      expect(response.status).toBe(200);
    }
    const { shell } = await fetchSecurityShell(ui.router, "/");
    const asset = await ui.router.fetch(
      shell.script.src.slice("/security".length),
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  it("mounted beside the API (even under the UI's path), the API's routes still answer", async () => {
    const api = await memorySecurityApi({ basePath: "/security/api" });
    const ui = fixtureSecurityUi({ api });
    const app = new BunRouter();
    app.use(ui.basePath, ui.router);
    app.use(api.basePath, api.router);
    const meta = await app.fetch("/security/api/meta");
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { breakGlass: boolean }).breakGlass).toBe(
      false,
    );
    const shell = await app.fetch("/security/");
    expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("authorize guards the shell and the assets; a refusal is a problem under the API's URN", async () => {
    const ui = fixtureSecurityUi({ authorize: () => false });
    const response = await ui.router.fetch("/");
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(((await response.json()) as { type: string }).type).toMatch(
      /^urn:bun-security:problem:/,
    );
  });
});
