/**
 * The host-shell demo (`embed.ts`): its page under its own CSP, the menu
 * built from each UI's sections, and each UI's mount module and stylesheet
 * named with SRI and served by that UI's router. The browser's side is
 * bun-ui's `__tests__/kit/e2e/embed.e2e.test.ts`.
 */
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { docsUi } from "@kingsleyweb/bun-ui/docs";
import { jobsUi } from "@kingsleyweb/bun-ui/jobs";
import { securityUi } from "@kingsleyweb/bun-ui/security";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { EMBED_BASE, mountEmbedDemo } from "./embed";

let app: BunHttpAdapter;
let origin: string;

beforeAll(async () => {
  app = new BunHttpAdapter(0, { logger: noopLogger });
  const uis = {
    jobs: jobsUi({
      apiUrl: "/jobs-api",
      basePath: "/jobs",
      dev: true,
      logger: noopLogger,
    }),
    security: securityUi({
      apiUrl: "/security-api",
      basePath: "/security",
      dev: true,
      logger: noopLogger,
    }),
    docs: docsUi({
      document: () => ({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {},
      }),
      basePath: "/api-docs",
      dev: true,
      logger: noopLogger,
    }),
  };
  for (const ui of Object.values(uis)) app.use(ui.basePath, ui.router);
  mountEmbedDemo(app, uis);
  const server = await app.listen(0);
  origin = `http://127.0.0.1:${server.port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe("the host-shell demo", () => {
  it("serves its page under its own nonce CSP, its menu from the UIs' sections", async () => {
    const response = await fetch(`${origin}${EMBED_BASE}/jobs/queues`);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    const html = await response.text();
    expect(html).toContain(`<script type="module" nonce="${nonce}">`);
    for (const href of [
      `${EMBED_BASE}/jobs/queues`,
      `${EMBED_BASE}/security/bans`,
      `${EMBED_BASE}/docs/http`,
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("names each UI's mount module and stylesheet, with SRI, served by its router", async () => {
    const html = await (await fetch(`${origin}${EMBED_BASE}`)).text();
    for (const base of ["/jobs", "/security", "/api-docs"]) {
      const module = new RegExp(
        `<link rel="modulepreload" href="(${base}/assets/mount-[a-z0-9]+\\.js)" integrity="sha384-`,
      ).exec(html);
      expect(module).not.toBeNull();
      expect((await fetch(`${origin}${module![1]}`)).status).toBe(200);
      const css = new RegExp(
        `<link rel="stylesheet" href="(${base}/assets/mount-[a-f0-9]{12}\\.css)"`,
      ).exec(html);
      expect(css).not.toBeNull();
      expect((await fetch(`${origin}${css![1]}`)).status).toBe(200);
    }
  });
});
