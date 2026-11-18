/**
 * PR-U4's screens in Chrome, over the REAL app and a real
 * `createSecurityApi()`:
 *
 * - **The policy editor** reads the policy's JSON Schema from the API's
 *   OpenAPI document (its `SecurityPolicy` component) and a service's
 *   effective policy: a limit global locked shows "Locked by Global" with
 *   no override, and a generated form's field shows its origin.
 * - **Layout, measured**: at a desktop width (1440 px), no analytics
 *   panel's table runs past its panel. The
 * Top offenders panel is the case that broke: a long address, its score,
 * "Banned" and its links clipped the Ban column at the panel's edge
 * ("Banne"). A table either fits its panel or scrolls inside its own
 * region; it never spills over the panel's edge, where the card clips it.
 * Over the REAL app and a real `createSecurityApi()`, in headless Chrome
 * through `Bun.WebView`.
 *
 * Skips visibly when no Chrome is found (`BUN_CHROME_PATH` overrides the
 * search).
 */
import type { SecurityApi } from "@kingsleyweb/bun-security/control";
import { existsSync } from "node:fs";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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

/** The desktop width measured. */
const WIDTH = 1440;

/** The longest subject the panel shows: a full IPv6 address. */
const LONG_IP = "2001:db8:ffff:ffff:ffff:ffff:ffff:ff01";

/** One table's measurement. */
interface TableBox {
  /** The panel's test id. */
  panel: string;
  /** How far the table's scroll region runs past the panel's content box, px (0 when inside). */
  spill: number;
  /** Whether the region scrolls (its content is wider than it). */
  scrolls: boolean;
  /** The last header's text, as shown. */
  lastHeader: string;
  /** How far the last header runs past what the region shows, px, when the region does not scroll. */
  clipped: number;
}

/** Page-side: every analytics panel's table, measured. */
const MEASURE_TABLES = `(() => {
  const out = [];
  for (const panel of document.querySelectorAll('[data-testid^="panel-"]')) {
    const table = panel.querySelector("table");
    if (!table) continue;
    const region = table.closest(".table-wrap") ?? table;
    const box = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    const right = box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
    const r = region.getBoundingClientRect();
    const scrolls = region.scrollWidth > region.clientWidth + 1 && getComputedStyle(region).overflowX !== "visible";
    const headers = table.querySelectorAll("thead th");
    const last = headers[headers.length - 1];
    const lastBox = last ? last.getBoundingClientRect() : r;
    out.push({
      panel: panel.getAttribute("data-testid"),
      spill: Math.max(0, Math.round(r.right - right)),
      scrolls,
      lastHeader: last ? last.textContent : "",
      clipped: scrolls ? 0 : Math.max(0, Math.round(lastBox.right - Math.min(r.right, right))),
    });
  }
  return out;
})()`;

/** Page-side: resolves `true` once `selector` exists (with `text`, when given), `false` after `ms`. */
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
  `security UI layout in Chrome${chromePath === undefined ? " — SKIPPED: no Chrome found (set BUN_CHROME_PATH)" : ""}`,
  () => {
    let app: BunHttpAdapter;
    let api: SecurityApi;
    let origin: string;
    let view: Bun.WebView | undefined;
    let profile: ReturnType<typeof chromeProfile> | undefined;
    const pageConsole: string[] = [];

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
      api = await memorySecurityApi({ basePath: "/sec-api" });
      app = new BunHttpAdapter();
      app.use(api.basePath, api.router);
      const ui = createSecurityUi(
        {
          api,
          basePath: "/security",
          title: "Security layout",
          dev: true,
          logger: noopLogger,
        },
        { entry: DEFAULT_ENTRY },
      );
      app.use(ui.basePath, ui.router);
      const server = await app.listen(0);
      origin = `http://127.0.0.1:${server.port}`;
      const post = (path: string, body: unknown) =>
        fetch(`${origin}${api.basePath}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bun-security-csrf": "1",
          },
          body: JSON.stringify(body),
        });
      await post("/services", { id: "web", name: "Web" });
      // The widest Top offenders row: a full IPv6 address, refused,
      // scored and banned.
      const minute = Math.floor(Date.now() / 60_000) * 60_000;
      await api.plane.store.addCounters!([
        {
          service: "web",
          at: minute,
          metric: "requests",
          dims: { action: "block" },
          value: 1_234_567,
        },
        {
          service: "web",
          at: minute,
          metric: "top.refused",
          dims: { kind: "ip", subject: LONG_IP },
          value: 1_234_567,
        },
      ]);
      const banned = await post("/bans", {
        scope: "global",
        ip: LONG_IP,
        reason: "layout e2e",
        duration: "1h",
      });
      // A global policy with a locked limit and a trust-check threshold, published.
      await fetch(`${origin}${api.basePath}/policies/global/draft`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-bun-security-csrf": "1",
        },
        body: JSON.stringify({
          policy: {
            limits: [
              { id: "scanners", limit: 100, window: "1m", locked: true },
            ],
            trustCheck: { threshold: 0.7 },
          },
          revision: null,
        }),
      });
      const published = await post("/policies/global/publish", {
        expectedHead: null,
        confirm: "global",
      });
      if (published.status !== 200)
        throw new Error(
          `the publish was refused: ${published.status} ${await published.text()}`,
        );
      if (banned.status !== 201)
        throw new Error(
          `the ban was refused: ${banned.status} ${await banned.text()}`,
        );
      profile = chromeProfile("security-layout");
      view = new Bun.WebView({
        backend: {
          type: "chrome",
          url: false,
          path: chromePath,
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
      api?.live.close();
      await profile?.remove();
      await app?.close();
      api?.close();
    }, 30_000);

    it(`no analytics panel's table runs past its panel at ${WIDTH}px; Top offenders' Ban column shows whole`, async () => {
      await view!.navigate(`${origin}/security`);
      await waitFor('[data-testid="panel-offenders"] table', "Banned");
      const tables = await view!.evaluate<TableBox[]>(MEASURE_TABLES);
      const offenders = tables.find((t) => t.panel === "panel-offenders");
      expect(offenders).toBeDefined();
      // Every table stays inside its panel: it fits, or scrolls in its region.
      expect(tables.filter((t) => t.spill > 0 || t.clipped > 0)).toEqual([]);
      // Top offenders fits whole at a desktop width: its Ban column is not
      // hidden behind a scroll (overlay scrollbars hide that it scrolls).
      expect(offenders).toMatchObject({ scrolls: false, clipped: 0, spill: 0 });
    }, 60_000);

    it("the policy editor reads the real schema and a service's locks and origins", async () => {
      await view!.navigate(
        `${origin}/security/policies?scope=service:web&tab=limits`,
      );
      await waitFor('[data-testid="item-origin-scanners"]', "Locked by Global");
      expect(
        await view!.evaluate<boolean>(
          `document.querySelector('[data-testid="item-override-scanners"]') === null`,
        ),
      ).toBe(true);
      await view!.navigate(
        `${origin}/security/policies?scope=service:web&tab=identity`,
      );
      await waitFor(
        '[data-testid="origin-trustCheck.threshold"]',
        "Inherited from Global",
      );
      // The page never scrolls sideways at a desktop width.
      expect(
        await view!.evaluate<boolean>(
          "document.documentElement.scrollWidth <= window.innerWidth",
        ),
      ).toBe(true);
    }, 60_000);
  },
);
