/**
 * End-to-end smoke: the REAL app (`app/main.tsx`, built in memory) served by
 * `jobsUi()` beside a real `createJobsApi` on a bun-common adapter bound to
 * port 0, loaded in headless Chrome through `Bun.WebView` (CDP, no new
 * dependencies).
 *
 * It asserts the app boots under the shell's CSP (it renders
 * `[data-testid="app-ready"]` once `/meta` has loaded) and that the browser
 * reported no CSP violation — including when the page opens the API's
 * socket, while a socket to any other host is refused as a `connect-src`
 * violation. Violations are collected with a buffered
 * `ReportingObserver`, which also returns reports raised before it was
 * created — the ones a listener added after load would miss. A negative
 * control injects an inline script to prove the collector sees violations.
 *
 * Skips visibly when no Chrome is found (`BUN_CHROME_PATH` overrides the
 * search) or `app/main.tsx` does not exist yet.
 */
import type { JobsApi } from "@kingsleyweb/bun-jobs";
import { existsSync } from "node:fs";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildAssets, DEFAULT_ENTRY } from "../../lib/assets";
import { createJobsUi } from "../../lib/jobsUi";
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

/** The first Chrome that exists, if any. */
const chromePath = CHROME_CANDIDATES.find((path) => existsSync(path));
const hasApp = existsSync(DEFAULT_ENTRY);
const skipReason =
  chromePath === undefined
    ? "no Chrome found (set BUN_CHROME_PATH)"
    : !hasApp
      ? `the app entry ${DEFAULT_ENTRY} does not exist yet`
      : undefined;

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
  const observer = new ReportingObserver((reports) => {
    for (const report of reports) {
      seen.push({
        directive: String(report.body.effectiveDirective ?? ""),
        blocked: String(report.body.blockedURL ?? ""),
      });
    }
  }, { types: ["csp-violation"], buffered: true });
  observer.observe();
  setTimeout(() => {
    for (const report of observer.takeRecords()) {
      seen.push({
        directive: String(report.body.effectiveDirective ?? ""),
        blocked: String(report.body.blockedURL ?? ""),
      });
    }
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
  `e2e smoke in Chrome${skipReason ? ` — SKIPPED: ${skipReason}` : ""}`,
  () => {
    let jobs: BunJobs;
    let api: JobsApi;
    let app: BunHttpAdapter;
    let origin: string;
    let view: Bun.WebView | undefined;
    /** The Chrome profile this suite owns, deleted with the view. */
    let profile: ReturnType<typeof chromeProfile> | undefined;
    const pageConsole: string[] = [];

    beforeAll(async () => {
      jobs = new BunJobs({
        namespace: `ui-e2e-${crypto.randomUUID().slice(0, 8)}`,
        driver: new MemoryDriver(),
        publishEvents: true,
        logger: noopLogger,
      });
      api = createJobsApi({
        jobs,
        basePath: "/jobs-api",
        mode: "jobs",
        authorize: () => true,
        logger: noopLogger,
      });
      // `dev: true`: the real app from source, whatever dist/ holds.
      const ui = createJobsUi(
        { api, title: "Jobs e2e", dev: true, logger: noopLogger },
        { entry: DEFAULT_ENTRY },
      );
      app = new BunHttpAdapter();
      app.use(api.basePath, api.router);
      app.use(ui.basePath, ui.router);
      api.websocket?.attach(app);
      const server = await app.listen(0);
      origin = `http://127.0.0.1:${server.port}`;
      // Build before the browser asks, so the page load is not the build. A
      // failed build is a 500 whose cause went to the (silent) logger, so
      // surface the bundler's own message instead.
      const warm = await fetch(`${origin}/jobs`);
      if (warm.status !== 200) {
        await buildAssets({ entry: DEFAULT_ENTRY });
        throw new Error(`the shell answered ${warm.status}`);
      }

      profile = chromeProfile("smoke");
      view = new Bun.WebView({
        backend: { type: "chrome", url: false, path: chromePath },
        // Chrome always writes a profile; owning the directory is what lets
        // this suite delete it (see `chromeProfile`).
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
      await api?.close();
      await jobs?.close();
    });

    it("boots the app under the CSP with no violations", async () => {
      await view!.navigate(`${origin}/jobs`);
      const ready = await view!.evaluate<boolean>(
        waitForSelector('[data-testid="app-ready"]', 15_000),
      );
      if (!ready) {
        throw new Error(
          `the app never rendered [data-testid="app-ready"]; page console:\n${pageConsole.join("\n")}`,
        );
      }
      expect(await view!.evaluate<string>("document.title")).toBe("Jobs e2e");

      const violations = await view!.evaluate<Violation[]>(COLLECT_VIOLATIONS);
      expect(violations).toEqual([]);
    }, 30_000);

    it("deep links boot the app too (SPA fallback)", async () => {
      await view!.navigate(`${origin}/jobs/queues`);
      expect(
        await view!.evaluate<boolean>(
          waitForSelector('[data-testid="app-ready"]', 15_000),
        ),
      ).toBe(true);
      expect(await view!.evaluate<Violation[]>(COLLECT_VIOLATIONS)).toEqual([]);
    }, 30_000);

    it("the page may open the API's socket: hello arrives, no CSP violation", async () => {
      // The socket is attached in beforeAll (`api.websocket?.attach(app)`).
      expect(api.websocket).toBeDefined();
      await view!.navigate(`${origin}/jobs`);
      const socketUrl = `${origin.replace(/^http/, "ws")}${api.websocket!.path}`;
      const outcome = await view!.evaluate<{
        first: string;
        violations: Violation[];
      }>(`(async () => {
        const first = await new Promise((resolve) => {
          const socket = new WebSocket(${JSON.stringify(socketUrl)}, "bun-jobs.v1");
          const timer = setTimeout(() => resolve("timeout"), 5000);
          socket.onmessage = (event) => {
            clearTimeout(timer);
            let type = "unparseable";
            try { type = JSON.parse(event.data).type; } catch {}
            socket.close();
            resolve(type);
          };
          socket.onerror = () => { clearTimeout(timer); resolve("error"); };
        });
        const violations = await ${COLLECT_VIOLATIONS};
        return { first, violations };
      })()`);
      expect(outcome.first).toBe("hello");
      expect(outcome.violations).toEqual([]);
    }, 30_000);

    it("negative control: a socket to another host is a connect-src violation", async () => {
      await view!.navigate(`${origin}/jobs`);
      const outcome = await view!.evaluate<{
        threw: boolean;
        violations: Violation[];
      }>(`(async () => {
        let threw = false;
        try {
          const socket = new WebSocket("ws://127.0.0.2:9/");
          socket.onerror = () => {};
        } catch {
          threw = true;
        }
        const violations = await ${COLLECT_VIOLATIONS};
        return { threw, violations };
      })()`);
      expect(
        outcome.violations.filter(
          (v) =>
            v.directive === "connect-src" &&
            v.blocked.startsWith("ws://127.0.0.2:9"),
        ),
      ).toHaveLength(1);
    }, 30_000);

    it("negative control: an inline script without the nonce is blocked and reported", async () => {
      await view!.navigate(`${origin}/jobs`);
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
