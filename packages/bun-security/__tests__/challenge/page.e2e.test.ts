/**
 * The challenge page end to end (layers.md L10.2): a real `Bun.serve`
 * behind `withSecurity`, an address on a `challenge` list entry, and
 * headless Chrome through `Bun.WebView` (CDP, no new dependency). The page
 * solves the proof of work with its own nonce'd script, posts the answer,
 * is sent back with the clearance cookie, and lands on the app's page.
 *
 * CSP violations are collected by the harness, not the product: it adds
 * `report-uri /csp-report` to the page's policy and records what Chrome
 * posts. A page that submits at once may navigate away before a report is
 * sent, so the "no violation" check is made on a copy of the page whose
 * submit is removed (`/clean`): it solves, stays, and reports nothing. The
 * negative control (`/tainted`) plants an inline script without the nonce
 * in the same held page and sees it blocked, unrun, and reported, while the
 * nonce'd solver runs.
 *
 * Skips visibly when no Chrome is found (`BUN_CHROME_PATH` overrides the
 * search).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { challenges } from "../../lib/challenge/flow";
import { powChallenge } from "../../lib/challenge/pow";
import { createSecurity } from "../../lib/engine/security";
import { withSecurity } from "../../lib/serve/index";

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

/** A CSP violation report Chrome posted (`report-uri`), as received. */
interface Report {
  /** The path of the page that raised it. */
  page: string;
  /** The directive violated, e.g. `script-src-elem`. */
  directive: string;
}

/** Page-side: resolves the page's text once `predicate` holds, or `null` after `ms`. */
function waitFor(predicate: string, ms: number): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const check = () => {
      try {
        if (${predicate}) return resolve(document.body ? document.body.innerText : "");
      } catch {}
      if (Date.now() > deadline) return resolve(null);
      setTimeout(check, 50);
    };
    check();
  })`;
}

describe.skipIf(skipReason !== undefined)(
  `challenge page e2e in Chrome${skipReason ? ` — SKIPPED: ${skipReason}` : ""}`,
  () => {
    let server: ReturnType<typeof Bun.serve>;
    let port: number;
    let view: Bun.WebView | undefined;
    let profile: string | undefined;
    const pageConsole: string[] = [];
    const reports: Report[] = [];
    const answers: string[] = [];

    beforeAll(() => {
      const security = createSecurity({
        // Every loopback client is challenged (the browser is one).
        policy: {
          // Loopback is internal (never refused) by default: not here.
          internal: false,
          lists: [{ ip: "127.0.0.0/8", action: "challenge" }],
        },
        logger: () => {},
        challenge: challenges({
          provider: powChallenge({
            secret: "e2e-pow-secret-0123456789-0123456789",
            maxNumber: 5000,
          }),
          secret: "e2e-clearance-secret-0123456789-012345",
        }),
      });
      const handler = withSecurity(
        security,
        (request) =>
          new Response(
            `<!doctype html><title>App</title><p id="app">Welcome to ${new URL(request.url).pathname}</p>`,
            {
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          ),
        { logger: () => {} },
      );
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (request, srv) => {
          const url = new URL(request.url);
          // The test's CSP report sink: Chrome posts each violation here.
          if (url.pathname === "/csp-report") {
            const body = (await request.json()) as {
              "csp-report"?: Record<string, string>;
            };
            const report = body["csp-report"] ?? {};
            reports.push({
              page: new URL(report["document-uri"] ?? "http://x/").pathname,
              directive:
                report["effective-directive"] ??
                report["violated-directive"] ??
                "",
            });
            return new Response(null, { status: 204 });
          }
          if (url.pathname === "/__bun-security/challenge")
            answers.push(url.host);
          const response = await handler(request, srv);
          const csp = response.headers.get("content-security-policy");
          if (csp === null) return response;
          // The harness, not the product: report violations to the sink, and
          // for /tainted plant an inline script without the nonce and keep
          // the page from submitting, so it stays to be read.
          const headers = new Headers(response.headers);
          headers.set(
            "content-security-policy",
            `${csp}; report-uri /csp-report`,
          );
          let html = await response.text();
          if (url.pathname === "/clean") {
            html = html.replace("form.submit();", "");
          }
          if (url.pathname === "/tainted") {
            html = html
              .replace(
                "</body>",
                "<script>window.__planted = true</script></body>",
              )
              .replace("form.submit();", "");
          }
          return new Response(html, { status: response.status, headers });
        },
      });
      port = server.port ?? 0;
      profile = mkdtempSync(join(tmpdir(), "bun-security-e2e-"));
      view = new Bun.WebView({
        backend: {
          type: "chrome",
          url: false,
          path: chromePath,
          argv: ["--use-gl=disabled"],
        },
        dataStore: { directory: profile },
        width: 1024,
        height: 768,
        console: (type, ...args) => {
          pageConsole.push(`${type}: ${args.map(String).join(" ")}`);
        },
      });
    }, 60_000);

    afterAll(async () => {
      view?.close();
      await server?.stop(true);
      if (profile !== undefined)
        rmSync(profile, { recursive: true, force: true });
    });

    /** Navigates to `url`, waits for the app's page, and returns its text. */
    async function landOn(url: string): Promise<string> {
      await view!.navigate(url);
      const landed = await view!.evaluate<string | null>(
        waitFor(`document.getElementById("app") !== null`, 30_000),
      );
      if (landed === null) {
        throw new Error(
          `the page never reached the app; page console:\n${pageConsole.join("\n")}`,
        );
      }
      return landed;
    }

    /** Waits up to `ms` for a report from `page`; the reports from it. */
    async function reportsFrom(page: string, ms: number): Promise<Report[]> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !reports.some((r) => r.page === page)) {
        await Bun.sleep(50);
      }
      return reports.filter((r) => r.page === page);
    }

    it("solves the proof of work in the page, is cleared, and lands on the app, with no CSP violation", async () => {
      // 127.0.0.1: its own cookie jar, apart from the control's `localhost`.
      const landed = await landOn(`http://127.0.0.1:${port}/account?tab=2`);
      expect(landed).toContain("Welcome to /account");
      expect(
        await view!.evaluate<string>("location.pathname + location.search"),
      ).toBe("/account?tab=2");
      expect(
        answers.filter((host) => host.startsWith("127.0.0.1")),
      ).toHaveLength(1);
      // Cleared: the next page is the app's at once, with no second answer.
      expect(await landOn(`http://127.0.0.1:${port}/other`)).toContain(
        "Welcome to /other",
      );
      expect(
        answers.filter((host) => host.startsWith("127.0.0.1")),
      ).toHaveLength(1);
      // Reports are posted asynchronously: give one from the challenge page a second to arrive.
      expect(await reportsFrom("/account", 1_000)).toEqual([]);
    }, 60_000);

    it("raises no CSP violation on the challenge page while it solves (the page held, so a report would arrive)", async () => {
      await view!.navigate(`http://localhost:${port}/clean`);
      const solved = await view!.evaluate<string | null>(
        waitFor(
          `document.getElementById("bun-security-status")?.textContent === "Done."`,
          30_000,
        ),
      );
      expect(solved).not.toBeNull();
      expect(await reportsFrom("/clean", 1_000)).toEqual([]);
    }, 60_000);

    it("negative control: a planted inline script without the nonce is blocked and reported, while the nonce'd solver runs", async () => {
      // localhost: a cookie jar of its own, so it is challenged whatever ran first.
      await view!.navigate(`http://localhost:${port}/tainted`);
      const solved = await view!.evaluate<string | null>(
        waitFor(
          `document.getElementById("bun-security-status")?.textContent === "Done."`,
          30_000,
        ),
      );
      if (solved === null) {
        throw new Error(
          `the solver never finished; page console:\n${pageConsole.join("\n")}`,
        );
      }
      // The nonce'd solver ran and filled the answer; the planted script did not run.
      expect(await view!.evaluate<boolean>(`window.__planted === true`)).toBe(
        false,
      );
      expect(
        await view!.evaluate<number>(
          `document.querySelector('input[name="altcha"]').value.length`,
        ),
      ).toBeGreaterThan(0);
      const tainted = await reportsFrom("/tainted", 5_000);
      expect(tainted.map((r) => r.directive)).toContain("script-src-elem");
    }, 60_000);
  },
);
