/**
 * End-to-end smoke for the docs viewer: the REAL viewer (`app/docs/main.tsx`,
 * built in memory) served by `docsUi()` on a bun-common adapter bound to port
 * 0, loaded in headless Chrome through `Bun.WebView` (CDP, no new
 * dependencies). The viewer is served on public listeners by bun-common's
 * `docsRouter` (`"self-hosted"`), so its strict self-only CSP is what a
 * visitor's browser enforces; this proves the app boots and works under it.
 *
 * It loads the viewer, opens an operation from the sidebar, and asserts the
 * browser reported no CSP violation (a buffered `ReportingObserver`, which
 * also returns reports raised before it was created). A negative control
 * injects an inline script without the nonce to prove the collector sees a
 * violation. No domain package: the document is a small hand-written OpenAPI
 * 3.1 one, as a viewer of any API's document would get.
 *
 * Skips visibly when no Chrome is found (`BUN_CHROME_PATH` overrides the
 * search).
 */
import { existsSync } from "node:fs";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildAssets, DEFAULT_ENTRY } from "../../../lib/docs/assets";
import { createDocsUi } from "../../../lib/docs/docsUi";
import { chromeProfile } from "../../jobs/e2e/profile";

/** Where Chrome may be, in search order. */
const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => typeof path === "string" && path !== "");

/** The first Chrome that exists, if any. */
const chromePath = CHROME_CANDIDATES.find((path) => existsSync(path));
const skipReason =
  chromePath === undefined
    ? "no Chrome found (set BUN_CHROME_PATH)"
    : undefined;

/** The document the viewer shows: one tag, two operations. */
const DOCUMENT = {
  openapi: "3.1.0",
  info: { title: "Pets e2e", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        tags: ["Pets"],
        summary: "List the pets",
        responses: { "200": { description: "The pets" } },
      },
    },
    "/pets/{id}": {
      get: {
        operationId: "getPet",
        tags: ["Pets"],
        summary: "Read one pet",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "The pet",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

/** A CSP violation as the page reports it. */
interface Violation {
  /** The directive violated, e.g. `"script-src-elem"`. */
  directive: string;
  /** What was blocked: a URL, `"inline"` or `"eval"`. */
  blocked: string;
}

/**
 * Page-side: every CSP violation reported so far, buffered ones included.
 * Resolves after a tick so queued reports are delivered first.
 */
const COLLECT_VIOLATIONS = `new Promise((resolve) => {
  const seen = [];
  const read = (reports) => {
    for (const report of reports) {
      seen.push({
        directive: String(report.body.effectiveDirective ?? ""),
        blocked: String(report.body.blockedURL ?? ""),
      });
    }
  };
  const observer = new ReportingObserver(read, { types: ["csp-violation"], buffered: true });
  observer.observe();
  setTimeout(() => {
    read(observer.takeRecords());
    observer.disconnect();
    resolve(seen);
  }, 50);
})`;

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

describe.skipIf(skipReason !== undefined)(
  `docs viewer e2e smoke in Chrome${skipReason ? ` — SKIPPED: ${skipReason}` : ""}`,
  () => {
    let app: BunHttpAdapter;
    let origin: string;
    let view: Bun.WebView | undefined;
    /** The Chrome profile this suite owns, deleted with the view. */
    let profile: ReturnType<typeof chromeProfile> | undefined;
    const pageConsole: string[] = [];

    beforeAll(async () => {
      // `dev: true`: the real viewer from source, whatever dist/ holds.
      const ui = createDocsUi(
        {
          document: () => DOCUMENT,
          basePath: "/docs",
          title: "Docs e2e",
          dev: true,
          logger: noopLogger,
        },
        { entry: DEFAULT_ENTRY },
      );
      app = new BunHttpAdapter();
      app.use(ui.basePath, ui.router);
      const server = await app.listen(0);
      origin = `http://127.0.0.1:${server.port}`;
      // Build before the browser asks, so the page load is not the build. A
      // failed build is a 500 whose cause went to the (silent) logger, so
      // surface the bundler's own message instead.
      const warm = await fetch(`${origin}/docs`);
      if (warm.status !== 200) {
        await buildAssets({ entry: DEFAULT_ENTRY });
        throw new Error(`the shell answered ${warm.status}`);
      }

      profile = chromeProfile("docs-smoke");
      view = new Bun.WebView({
        backend: {
          type: "chrome",
          url: false,
          path: chromePath,
          // Keeps headless Chrome off the desktop's display, as the jobs
          // suites do (see `__tests__/jobs/e2e/smoke.e2e.test.ts`).
          argv: ["--use-gl=disabled"],
        },
        dataStore: profile.dataStore,
        width: 1280,
        height: 800,
        console: (type, ...args) => {
          pageConsole.push(`${type}: ${args.map(String).join(" ")}`);
        },
      });
    }, 60_000);

    afterAll(async () => {
      view?.close();
      await profile?.remove();
      await app?.close();
    });

    it("loads the viewer and opens an operation, with no CSP violation", async () => {
      await view!.navigate(`${origin}/docs`);
      const listed = await view!.evaluate<boolean>(
        waitForSelector(".http-sidebar-list a", 15_000),
      );
      if (!listed) {
        throw new Error(
          `the viewer never listed an operation; page console:\n${pageConsole.join("\n")}`,
        );
      }
      expect(await view!.evaluate<string>("document.title")).toBe("Docs e2e");

      const opened = await view!.evaluate<string | null>(`(async () => {
        const link = [...document.querySelectorAll(".http-sidebar-list a")]
          .find((a) => a.textContent.includes("/pets/{id}"));
        if (!link) return null;
        link.click();
        const shown = await ${waitForSelector('[data-testid="http-operation"]', 10_000)};
        if (!shown) return null;
        return document.querySelector('[data-testid="op-path"]')?.textContent ?? "";
      })()`);
      if (opened === null) {
        throw new Error(
          `the operation never opened; page console:\n${pageConsole.join("\n")}`,
        );
      }
      expect(opened).toContain("/pets/{id}");
      expect(await view!.evaluate<string>("location.pathname")).toStartWith(
        "/docs/http",
      );

      const violations = await view!.evaluate<Violation[]>(COLLECT_VIOLATIONS);
      expect(violations).toEqual([]);
    }, 30_000);

    it("negative control: an inline script without the nonce is blocked and reported", async () => {
      await view!.navigate(`${origin}/docs`);
      const outcome = await view!.evaluate<{
        ran: boolean;
        violations: Violation[];
      }>(`(async () => {
        const script = document.createElement("script");
        script.textContent = "window.__inlineRan = true";
        document.head.appendChild(script);
        const violations = await ${COLLECT_VIOLATIONS};
        return { ran: window.__inlineRan === true, violations };
      })()`);
      expect(outcome.ran).toBe(false);
      expect(outcome.violations.map((v) => v.directive)).toContain(
        "script-src-elem",
      );
    }, 30_000);
  },
);
