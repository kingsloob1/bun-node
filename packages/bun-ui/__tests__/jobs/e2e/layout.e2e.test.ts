/**
 * End-to-end, layout (#785): every UI of the package, the real app in
 * headless Chrome (`Bun.WebView`) on a 2560px-wide screen, measured. The
 * `layout` option is applied by the kit (`app/kit/layout.ts`) and drawn by its
 * base styles; happy-dom has no layout, so only a browser can show where the
 * content lands.
 *
 * Each UI is mounted once per layout under its own path on one adapter, and
 * each case asserts the screen's place against the area it sits in:
 *
 * - `content` scope: the side nav stays at the window's left edge, the screen
 *   sits left, centred or right in the main area, `maxWidth` wide.
 * - `page` scope: the nav and the screen are one block, placed left, centred
 *   or right in the window, and the header's brand lines up with it.
 * - a cap wider than the screen: the content fills its area whatever the
 *   alignment, as on a narrow screen.
 *
 * The UI list is the rule's check: a new UI is added here, and one that
 * sets its own width or place instead of the kit's fails it.
 *
 * Skips visibly without Chrome (`BUN_CHROME_PATH` overrides the search).
 */
import type { UiLayoutOptions } from "../../../lib/kit/browser/shared";
import { existsSync } from "node:fs";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DEFAULT_ENTRY as DOCS_ENTRY } from "../../../lib/docs/assets";
import { createDocsUi } from "../../../lib/docs/docsUi";
import { DEFAULT_ENTRY as JOBS_ENTRY } from "../../../lib/jobs/assets";
import { createJobsUi } from "../../../lib/jobs/jobsUi";
import { DEFAULT_ENTRY as SECURITY_ENTRY } from "../../../lib/security/assets";
import { createSecurityUi } from "../../../lib/security/securityUi";
import { memorySecurityApi } from "../../security/server/helpers";
import { chromeProfile } from "./profile";

/** Where Chrome may be, in search order. */
const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => typeof path === "string" && path !== "");

const chromePath = CHROME_CANDIDATES.find((path) => existsSync(path));

/** The viewport: an extra-large screen. */
const WIDTH = 2560;

/** The side nav's width (`--nav-width`) and the main area's padding (`--space-5`). */
const NAV = 200;
const PAD = 24;

/** A small OpenAPI document for the docs viewer. */
const DOCUMENT = {
  openapi: "3.1.0",
  info: { title: "Layout e2e", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        tags: ["Pets"],
        summary: "List the pets",
        responses: { "200": { description: "The pets" } },
      },
    },
  },
};

/** One measured layout: a mount path and the option it was given. */
interface Case {
  /** The mount path, unique per case. */
  path: string;
  /** The `layout` option; `undefined` is the default. */
  layout: UiLayoutOptions | undefined;
}

/** The jobs UI's cases. */
const JOBS_CASES = {
  contentLeft: { path: "/jobs-content-left", layout: { align: "left" } },
  contentDefault: { path: "/jobs-default", layout: undefined },
  contentRight: { path: "/jobs-content-right", layout: { align: "right" } },
  pageLeft: {
    path: "/jobs-page-left",
    layout: { align: "left", scope: "page" },
  },
  pageCenter: { path: "/jobs-page-center", layout: { scope: "page" } },
  pageRight: {
    path: "/jobs-page-right",
    layout: { align: "right", scope: "page" },
  },
  narrowCap: { path: "/jobs-cap-1000", layout: { maxWidth: 1000 } },
  wideCap: { path: "/jobs-cap-4000", layout: { maxWidth: 4000 } },
} satisfies Record<string, Case>;

/** The docs viewer's cases: no side nav, so "page" looks as "content" does. */
const DOCS_CASES = {
  left: { path: "/docs-left", layout: { align: "left" } },
  default: { path: "/docs-default", layout: undefined },
  right: { path: "/docs-right", layout: { align: "right" } },
  page: { path: "/docs-page", layout: { scope: "page" } },
} satisfies Record<string, Case>;

/** The security UI's cases: the kit's frame, as the jobs UI's. */
const SECURITY_CASES = {
  left: { path: "/sec-content-left", layout: { align: "left" } },
  default: { path: "/sec-default", layout: undefined },
  right: { path: "/sec-content-right", layout: { align: "right" } },
  pageCenter: { path: "/sec-page-center", layout: { scope: "page" } },
} satisfies Record<string, Case>;

/** A rectangle, rounded to whole pixels. */
interface Box {
  left: number;
  right: number;
  width: number;
}

/** What {@link MEASURE} returns. */
interface Measure {
  /** `innerWidth`. */
  viewport: number;
  /** The page's width beside a vertical scrollbar: what the layout divides. */
  page: number;
  /** The page's scroll width: never past the viewport. */
  scrollWidth: number;
  /** The first `.screen`. */
  screen: Box;
  /** The area the screen sits in: `.app-main` or `.docs-viewer`, its content box. */
  area: Box;
  /** The side nav, when the UI has one. */
  nav: Box | null;
  /** The header's brand link, when the UI has one. */
  brand: Box | null;
}

/** Page-side: the boxes {@link Measure} names. */
const MEASURE = `(() => {
  const box = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
  };
  const areaElement = document.querySelector(".app-main") ?? document.querySelector(".docs-viewer");
  const outer = box(areaElement);
  const style = getComputedStyle(areaElement);
  const padLeft = Math.round(parseFloat(style.paddingLeft));
  const padRight = Math.round(parseFloat(style.paddingRight));
  const area = { left: outer.left + padLeft, right: outer.right - padRight, width: outer.width - padLeft - padRight };
  return {
    viewport: window.innerWidth,
    page: document.documentElement.clientWidth,
    scrollWidth: document.scrollingElement.scrollWidth,
    screen: box(document.querySelector(".screen")),
    area,
    nav: box(document.querySelector(".app-nav")),
    brand: box(document.querySelector(".app-brand")),
  };
})()`;

/** Page-side: resolves `true` once `selector` exists, `false` after `ms`. */
function waitForSelector(selector: string, ms: number): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const check = () => {
      if (document.querySelector(${JSON.stringify(selector)})) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  })`;
}

describe.skipIf(chromePath === undefined)(
  `layout at ${WIDTH}px in Chrome${chromePath === undefined ? " — SKIPPED: no Chrome found (set BUN_CHROME_PATH)" : ""}`,
  () => {
    let jobs: BunJobs;
    let api: ReturnType<typeof createJobsApi>;
    let securityApi: Awaited<ReturnType<typeof memorySecurityApi>>;
    let app: BunHttpAdapter;
    let origin: string;
    let view: Bun.WebView | undefined;
    /** The Chrome profile this suite owns, deleted with the view. */
    let profile: ReturnType<typeof chromeProfile> | undefined;
    const pageConsole: string[] = [];

    beforeAll(async () => {
      jobs = new BunJobs({
        namespace: `ui-layout-e2e-${crypto.randomUUID().slice(0, 8)}`,
        driver: new MemoryDriver(),
        logger: noopLogger,
      });
      api = createJobsApi({
        jobs,
        basePath: "/jobs-api",
        mode: "jobs",
        authorize: () => true,
        logger: noopLogger,
      });
      app = new BunHttpAdapter();
      app.use(api.basePath, api.router);
      for (const { path, layout } of Object.values(JOBS_CASES) as Case[]) {
        const ui = createJobsUi(
          {
            api,
            basePath: path,
            dev: true,
            logger: noopLogger,
            ...(layout === undefined ? {} : { layout }),
          },
          { entry: JOBS_ENTRY },
        );
        app.use(ui.basePath, ui.router);
      }
      for (const { path, layout } of Object.values(DOCS_CASES) as Case[]) {
        const ui = createDocsUi(
          {
            document: () => DOCUMENT,
            basePath: path,
            dev: true,
            logger: noopLogger,
            ...(layout === undefined ? {} : { layout }),
          },
          { entry: DOCS_ENTRY },
        );
        app.use(ui.basePath, ui.router);
      }
      securityApi = await memorySecurityApi({ basePath: "/sec-api" });
      app.use(securityApi.basePath, securityApi.router);
      for (const { path, layout } of Object.values(SECURITY_CASES) as Case[]) {
        const ui = createSecurityUi(
          {
            api: securityApi,
            basePath: path,
            dev: true,
            logger: noopLogger,
            ...(layout === undefined ? {} : { layout }),
          },
          { entry: SECURITY_ENTRY },
        );
        app.use(ui.basePath, ui.router);
      }
      const server = await app.listen(0);
      origin = `http://127.0.0.1:${server.port}`;
      // Build each bundle before the browser asks.
      expect(
        (await fetch(`${origin}${JOBS_CASES.contentDefault.path}`)).status,
      ).toBe(200);
      expect((await fetch(`${origin}${DOCS_CASES.default.path}`)).status).toBe(
        200,
      );
      expect(
        (await fetch(`${origin}${SECURITY_CASES.default.path}`)).status,
      ).toBe(200);

      profile = chromeProfile("layout");
      view = new Bun.WebView({
        backend: {
          type: "chrome",
          url: false,
          path: chromePath,
          // Keeps headless Chrome off the desktop's display, as the other
          // suites do (see `responsive.e2e.test.ts`).
          argv: ["--use-gl=disabled"],
        },
        dataStore: profile.dataStore,
        width: WIDTH,
        height: 900,
        console: (type, ...args) => {
          pageConsole.push(`${type}: ${args.map(String).join(" ")}`);
        },
      });
    }, 120_000);

    afterAll(async () => {
      view?.close();
      await profile?.remove();
      await app?.close();
      await api?.close();
      await jobs?.close();
      securityApi?.live.close();
      securityApi?.close();
    });

    /** Opens a case's page, waits for `ready`, and measures it. */
    async function measure(path: string, ready: string): Promise<Measure> {
      await view!.navigate(`${origin}${path}`);
      const shown = await view!.evaluate<boolean>(
        waitForSelector(ready, 20_000),
      );
      if (!shown) {
        throw new Error(
          `${path}: ${ready} never appeared; page console:\n${pageConsole.join("\n")}`,
        );
      }
      const result = await view!.evaluate<Measure>(MEASURE);
      expect(result.viewport).toBe(WIDTH);
      expect(result.scrollWidth).toBeLessThanOrEqual(WIDTH);
      return result;
    }

    /** The gaps between the screen and its area's content box, left and right. */
    function gaps(result: Measure): { left: number; right: number } {
      return {
        left: result.screen.left - result.area.left,
        right: result.area.right - result.screen.right,
      };
    }

    /** The jobs app is ready once its Overview's screen renders. */
    const JOBS_READY = '[data-testid="app-ready"] .screen';
    /** The security app is ready once its Overview renders. */
    const SECURITY_READY =
      '[data-testid="app-ready"] .screen[data-testid="overview"]';
    /** The docs viewer is ready once the document's reference renders. */
    const DOCS_READY = ".screen.http-docs";

    describe("jobsUi(), content scope: the nav stays at the edge", () => {
      it("centres the screen by default, 1400px wide", async () => {
        const result = await measure(
          JOBS_CASES.contentDefault.path,
          JOBS_READY,
        );
        expect(result.nav!.left).toBe(0);
        expect(result.nav!.width).toBe(NAV);
        expect(result.screen.width).toBe(1400);
        const { left, right } = gaps(result);
        expect(left).toBeGreaterThan(400);
        expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      }, 30_000);

      it("puts it against the nav with align: left (the layout before 3.3.0)", async () => {
        const result = await measure(JOBS_CASES.contentLeft.path, JOBS_READY);
        expect(result.nav!.left).toBe(0);
        expect(result.screen.width).toBe(1400);
        expect(gaps(result).left).toBe(0);
        expect(result.screen.left).toBe(NAV + PAD);
      }, 30_000);

      it("puts it against the right edge with align: right", async () => {
        const result = await measure(JOBS_CASES.contentRight.path, JOBS_READY);
        expect(result.nav!.left).toBe(0);
        expect(result.screen.width).toBe(1400);
        expect(gaps(result).right).toBe(0);
        expect(result.screen.right).toBe(result.page - PAD);
      }, 30_000);

      it("caps the screen at maxWidth", async () => {
        const result = await measure(JOBS_CASES.narrowCap.path, JOBS_READY);
        expect(result.screen.width).toBe(1000);
        const { left, right } = gaps(result);
        expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      }, 30_000);

      it("fills the area when the cap is wider than it, as on a narrow screen", async () => {
        const result = await measure(JOBS_CASES.wideCap.path, JOBS_READY);
        expect(result.screen.width).toBe(result.area.width);
        expect(gaps(result)).toEqual({ left: 0, right: 0 });
      }, 30_000);
    });

    describe("jobsUi(), page scope: the nav and the screen move as one block", () => {
      /** The block: the nav, the cap and the main area's padding. */
      const BLOCK = NAV + 1400 + 2 * PAD;

      it("centres the block, the brand lined up with it", async () => {
        const result = await measure(JOBS_CASES.pageCenter.path, JOBS_READY);
        // Rounded: an odd page width leaves the block on a half pixel.
        const blockLeft = (result.page - BLOCK) / 2;
        const near = (actual: number, expected: number) =>
          expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
        near(result.nav!.left, blockLeft);
        near(result.screen.left, blockLeft + NAV + PAD);
        expect(result.screen.width).toBe(1400);
        near(result.brand!.left, blockLeft + 16);
      }, 30_000);

      it("puts the block at the left edge with align: left", async () => {
        const result = await measure(JOBS_CASES.pageLeft.path, JOBS_READY);
        expect(result.nav!.left).toBe(0);
        expect(result.screen.left).toBe(NAV + PAD);
        expect(result.brand!.left).toBe(16);
      }, 30_000);

      it("puts the block at the right edge with align: right", async () => {
        const result = await measure(JOBS_CASES.pageRight.path, JOBS_READY);
        const blockLeft = result.page - BLOCK;
        expect(result.nav!.left).toBe(blockLeft);
        expect(result.screen.right).toBe(result.page - PAD);
        expect(result.brand!.left).toBe(blockLeft + 16);
      }, 30_000);
    });

    describe("securityUi(): the kit's frame", () => {
      it("centres the screen by default, 1400px wide, the nav at the edge", async () => {
        const result = await measure(
          SECURITY_CASES.default.path,
          SECURITY_READY,
        );
        expect(result.nav!.left).toBe(0);
        expect(result.nav!.width).toBe(NAV);
        expect(result.screen.width).toBe(1400);
        const { left, right } = gaps(result);
        expect(left).toBeGreaterThan(400);
        expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      }, 30_000);

      it("puts it against the nav with align: left", async () => {
        const result = await measure(SECURITY_CASES.left.path, SECURITY_READY);
        expect(gaps(result).left).toBe(0);
        expect(result.screen.left).toBe(NAV + PAD);
      }, 30_000);

      it("puts it against the right edge with align: right", async () => {
        const result = await measure(SECURITY_CASES.right.path, SECURITY_READY);
        expect(gaps(result).right).toBe(0);
        expect(result.screen.right).toBe(result.page - PAD);
      }, 30_000);

      it("moves the nav and the screen as one block in page scope", async () => {
        const result = await measure(
          SECURITY_CASES.pageCenter.path,
          SECURITY_READY,
        );
        const blockLeft = (result.page - (NAV + 1400 + 2 * PAD)) / 2;
        expect(Math.abs(result.nav!.left - blockLeft)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(result.screen.left - (blockLeft + NAV + PAD)),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(result.brand!.left - (blockLeft + 16)),
        ).toBeLessThanOrEqual(1);
      }, 30_000);
    });

    describe("docsUi(): the viewer's screen", () => {
      it("centres the screen by default, 1400px wide", async () => {
        const result = await measure(DOCS_CASES.default.path, DOCS_READY);
        expect(result.nav).toBeNull();
        expect(result.screen.width).toBe(1400);
        const { left, right } = gaps(result);
        expect(left).toBeGreaterThan(400);
        expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      }, 30_000);

      it("puts it at the left with align: left", async () => {
        const result = await measure(DOCS_CASES.left.path, DOCS_READY);
        expect(result.screen.left).toBe(PAD);
      }, 30_000);

      it("puts it at the right with align: right", async () => {
        const result = await measure(DOCS_CASES.right.path, DOCS_READY);
        expect(result.screen.right).toBe(result.page - PAD);
      }, 30_000);

      it("looks the same in page scope, having no side nav", async () => {
        const content = await measure(DOCS_CASES.default.path, DOCS_READY);
        const page = await measure(DOCS_CASES.page.path, DOCS_READY);
        expect(page.screen).toEqual(content.screen);
      }, 30_000);
    });
  },
);
