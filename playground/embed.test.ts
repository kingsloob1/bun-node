/**
 * The host-shell demo (`embed.ts`): its page under its own CSP, the menu
 * built from each UI's sections, and each UI's mount module and stylesheet
 * named with SRI and served by that UI's router; the jobs group lists what
 * the jobs API serves (#881). The browser's side is
 * bun-ui's `__tests__/kit/e2e/embed.e2e.test.ts`.
 */
import type { JobsSectionsMeta } from "@kingsleyweb/bun-ui/jobs/browser";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { docsUi } from "@kingsleyweb/bun-ui/docs";
import { jobsUi } from "@kingsleyweb/bun-ui/jobs";
import {
  JOBS_SECTIONS,
  jobsSectionsFor,
  sectionsFor,
} from "@kingsleyweb/bun-ui/jobs/browser";
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

describe("the demo's jobs menu (#881)", () => {
  /** The demo beside a real jobs API in `mode`; the menu's jobs links, and what the API serves. */
  async function jobsLinks(mode: "jobs" | "runner"): Promise<{
    links: string[];
    served: string[];
    permissionOnly: string[];
  }> {
    const jobs = new BunJobs({
      namespace: `embed-${crypto.randomUUID().slice(0, 8)}`,
      driver: new MemoryDriver(),
      logger: noopLogger,
    });
    const api = createJobsApi({
      jobs,
      basePath: "/jobs-api",
      mode,
      authorize: () => true,
      logger: noopLogger,
    });
    const demo = new BunHttpAdapter(0, { logger: noopLogger });
    const ui = jobsUi({
      api,
      basePath: "/jobs",
      dev: true,
      logger: noopLogger,
    });
    demo.use(api.basePath, api.router);
    demo.use(ui.basePath, ui.router);
    const others = {
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
    for (const other of Object.values(others)) {
      demo.use(other.basePath, other.router);
    }
    mountEmbedDemo(demo, { jobs: ui, ...others });
    try {
      const html = await (await demo.fetch(`${EMBED_BASE}/jobs`)).text();
      const links = [
        ...html.matchAll(new RegExp(`href="${EMBED_BASE}/jobs([^"]*)"`, "g")),
      ].map((match) => match[1] || "/");
      // What the mounted UI's nav shows: the API's meta and permissions.
      const meta = (await (
        await demo.fetch("/jobs-api/meta")
      ).json()) as JobsSectionsMeta;
      const granted = (
        (await (await demo.fetch("/jobs-api/meta/permissions")).json()) as {
          actions: Record<string, boolean>;
        }
      ).actions;
      const can = (action: string) => granted[action] === true;
      return {
        links,
        served: jobsSectionsFor(meta, can).map((section) => section.path),
        // As the demo built it before: every section, permission alone.
        permissionOnly: sectionsFor(JOBS_SECTIONS, () => true).map(
          (section) => section.path,
        ),
      };
    } finally {
      await api.close();
      await jobs.close();
      await demo.close();
    }
  }

  it("lists what the demo's API serves, as the mounted UI's nav does", async () => {
    for (const mode of ["jobs", "runner"] as const) {
      const { links, served } = await jobsLinks(mode);
      expect([mode, links]).toEqual([mode, served]);
    }
  });

  it("negative control: the permission-only list links pages a runner-only API does not serve", async () => {
    const { links, permissionOnly } = await jobsLinks("runner");
    expect(links).toContain("/runners");
    expect(links).not.toContain("/queues");
    // sectionsFor alone, as the demo built it before, would link /queues.
    expect(permissionOnly).toContain("/queues");
  });
});
