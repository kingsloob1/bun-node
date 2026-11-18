/**
 * End-to-end smoke for the security UI (PR-U1): the REAL app
 * (`app/security/main.tsx`, built in memory) served by `securityUi()` beside
 * a real `createSecurityApi()` on a bun-common adapter bound to port 0,
 * loaded in headless Chrome through `Bun.WebView`.
 *
 * - Signed in: the analytics page (PR-U2) renders its panels from the real
 *   reads, a chart's table opens, the live stream over CP5's `/live` goes
 *   live and a decision the hub streams appears in the activity feed, the
 *   nav opens the API reference, and the browser reports no CSP violation
 *   (with a negative control).
 * - Signed out, with the break-glass account: "Sign in required" offers the
 *   break-glass form; a real password and TOTP code sign in, the app loads
 *   as the break-glass account, and the session (token and expiry) is in
 *   `sessionStorage` and shown.
 *
 * Skips visibly when no Chrome is found (`BUN_CHROME_PATH` overrides the
 * search).
 */
import type { SecurityApi } from "@kingsleyweb/bun-security/control";
import { existsSync } from "node:fs";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { totpCode } from "@kingsleyweb/bun-security/control";
import { base32Decode } from "@kingsleyweb/bun-security/lib/control/audit/breakglass";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildAssets } from "../../../lib/kit/assets";
import { DEFAULT_ENTRY } from "../../../lib/security/assets";
import { createSecurityUi } from "../../../lib/security/securityUi";
import { chromeProfile } from "../../jobs/e2e/profile";
import { memorySecurityApi } from "../server/helpers";

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

/** The break-glass account's TOTP secret (`memorySecurityApi`'s). */
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

/** A CSP violation as the page reports it. */
interface Violation {
  /** The directive violated. */
  directive: string;
  /** What was blocked. */
  blocked: string;
}

/** Page-side: every CSP violation reported so far, buffered ones included. */
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

/** Page-side: resolves `true` once `selector` exists (and, given, its text includes `text`), `false` after `ms`. */
function waitForSelector(selector: string, ms: number, text?: string): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const check = () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element && (${JSON.stringify(text ?? "")} === "" || element.textContent.includes(${JSON.stringify(text ?? "")}))) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  })`;
}

describe.skipIf(chromePath === undefined)(
  `security UI e2e smoke in Chrome${chromePath === undefined ? " — SKIPPED: no Chrome found (set BUN_CHROME_PATH)" : ""}`,
  () => {
    let app: BunHttpAdapter;
    let signedIn: SecurityApi;
    let signedOut: SecurityApi;
    let origin: string;
    let view: Bun.WebView | undefined;
    /** The Chrome profile this suite owns, deleted with the view. */
    let profile: ReturnType<typeof chromeProfile> | undefined;
    const pageConsole: string[] = [];

    /** Opens `path` and waits for `selector`, or fails with the page's console. */
    async function open(
      path: string,
      selector: string,
      text?: string,
    ): Promise<void> {
      await view!.navigate(`${origin}${path}`);
      await waitFor(selector, text);
    }

    /** Waits for `selector`, or fails with the page's console. */
    async function waitFor(selector: string, text?: string): Promise<void> {
      if (
        !(await view!.evaluate<boolean>(
          waitForSelector(selector, 20_000, text),
        ))
      ) {
        throw new Error(
          `${selector} never appeared; page console:\n${pageConsole.join("\n")}`,
        );
      }
    }

    beforeAll(async () => {
      signedIn = await memorySecurityApi({ basePath: "/sec-api" });
      // No operator: every call is 401 unless it carries a break-glass session.
      signedOut = await memorySecurityApi({
        basePath: "/bg-api",
        withBreakGlass: true,
        authenticate: () => null,
      });
      app = new BunHttpAdapter();
      app.use(signedIn.basePath, signedIn.router);
      app.use(signedOut.basePath, signedOut.router);
      for (const [api, basePath] of [
        [signedIn, "/security"],
        [signedOut, "/break-glass"],
      ] as const) {
        const ui = createSecurityUi(
          {
            api,
            basePath,
            title: "Security e2e",
            dev: true,
            logger: noopLogger,
          },
          { entry: DEFAULT_ENTRY },
        );
        app.use(ui.basePath, ui.router);
      }
      const server = await app.listen(0);
      origin = `http://127.0.0.1:${server.port}`;
      // The analytics page's data (PR-U2): a service, and its counters now.
      await fetch(`${origin}${signedIn.basePath}/services`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bun-security-csrf": "1",
        },
        body: JSON.stringify({ id: "web", name: "Web" }),
      });
      const minute = Math.floor(Date.now() / 60_000) * 60_000;
      await signedIn.plane.store.addCounters!([
        {
          service: "web",
          at: minute,
          metric: "requests",
          dims: { action: "allow" },
          value: 40,
        },
        {
          service: "web",
          at: minute,
          metric: "requests",
          dims: { action: "block" },
          value: 3,
        },
      ]);
      const warm = await fetch(`${origin}/security`);
      if (warm.status !== 200) {
        await buildAssets({ entry: DEFAULT_ENTRY });
        throw new Error(`the shell answered ${warm.status}`);
      }
      profile = chromeProfile("security-smoke");
      view = new Bun.WebView({
        backend: {
          type: "chrome",
          url: false,
          path: chromePath,
          argv: ["--use-gl=disabled"],
        },
        dataStore: profile.dataStore,
        width: 1280,
        height: 800,
        console: (type, ...args) => {
          pageConsole.push(`${type}: ${args.map(String).join(" ")}`);
        },
      });
    }, 120_000);

    afterAll(async () => {
      view?.close();
      // The live streams end first, so the adapter's close has nothing open
      // to drain (the analytics page holds `/live` open, PR-U2).
      signedIn?.live.close();
      signedOut?.live.close();
      await profile?.remove();
      await app?.close();
      signedIn?.close();
      signedOut?.close();
    }, 30_000);

    it("loads the analytics page, goes live, shows a live event, opens the API reference, with no CSP violation", async () => {
      await open("/security", '[data-testid="headline-refused"]', "3");
      expect(await view!.evaluate<string>("document.title")).toBe(
        "Security e2e",
      );
      // The traffic chart is an SVG image with a summary; its table is one click away.
      // Each panel reads on its own: wait for this one, not the headline's.
      await waitFor('[data-testid="traffic-chart"] [role="img"] svg');
      await view!.evaluate<void>(
        `[...document.querySelectorAll('[data-testid="traffic-chart"] button')].find((b) => b.textContent === "Table").click()`,
      );
      await waitFor('[data-testid="traffic-chart"] table', "Blocked");
      // The real `/live` stream, through bun-client's `sse()`.
      await waitFor(".app-header-end", "Live");
      // A decision the hub streams appears in the activity feed.
      await waitFor('[data-testid="panel-feed"]');
      await new Promise((resolve) => setTimeout(resolve, 500));
      signedIn.live.publishBatch("web", {
        events: [
          {
            id: "e2e-live-1",
            at: Date.now(),
            service: "web",
            action: "block",
            rule: "rule:e2e",
            route: "GET /e2e",
            subjects: { ip: "203.0.113.50" },
          },
        ],
        counters: [],
      });
      await waitFor('[data-testid="feed-row"]', "203.0.113.50");
      const opened = await view!.evaluate<string | null>(`(async () => {
        const link = [...document.querySelectorAll('[data-testid="nav"] a')].find((a) => a.textContent === "API reference");
        if (!link) return null;
        link.click();
        const shown = await ${waitForSelector(".http-sidebar-list a", 15_000)};
        return shown ? location.pathname : null;
      })()`);
      if (opened === null)
        throw new Error(
          `the API reference never rendered; page console:\n${pageConsole.join("\n")}`,
        );
      expect(opened).toBe("/security/api");
      expect(await view!.evaluate<Violation[]>(COLLECT_VIOLATIONS)).toEqual([]);
    }, 60_000);

    it("negative control: an inline script without the nonce is blocked and reported", async () => {
      await view!.navigate(`${origin}/security`);
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

    it("signed out, signs in with break-glass and loads as that account", async () => {
      await open("/break-glass", '[data-testid="break-glass-link"]');
      const code = totpCode(
        base32Decode(TOTP_SECRET),
        Math.floor(Date.now() / 30_000),
      );
      const submitted = await view!.evaluate<boolean>(`(async () => {
        document.querySelector('[data-testid="break-glass-link"]').click();
        const shown = await ${waitForSelector('[data-testid="break-glass-form"]', 5_000)};
        if (!shown) return false;
        const set = (input, value) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set(document.querySelector('[data-testid="break-glass-form"] input[type="password"]'), "pw");
        set(document.querySelector('[data-testid="break-glass-form"] input[autocomplete="one-time-code"]'), ${JSON.stringify(code)});
        await new Promise((resolve) => setTimeout(resolve, 50));
        document.querySelector('[data-testid="break-glass-form"] button[type="submit"]').click();
        return true;
      })()`);
      expect(submitted).toBe(true);
      await waitFor(
        '[data-testid="break-glass-session"]',
        "Break-glass session until",
      );
      await waitFor('[data-testid="app-ready"]');
      const stored = await view!.evaluate<{
        token: string;
        expiresAt: number;
        header: string;
      } | null>(
        `JSON.parse(sessionStorage.getItem("bun-security-ui:break-glass") ?? "null")`,
      );
      expect(stored?.header).toBe("x-bun-security-break-glass");
      expect(typeof stored?.token).toBe("string");
      expect(stored!.expiresAt).toBeGreaterThan(Date.now());
      expect(await view!.evaluate<Violation[]>(COLLECT_VIOLATIONS)).toEqual([]);
    }, 60_000);
  },
);
