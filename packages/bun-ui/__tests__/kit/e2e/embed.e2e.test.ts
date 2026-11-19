/**
 * End-to-end, embedding (embedding.md §9.3): each UI mounted in a host
 * application's own page (`hostShell.ts`: its header, its side menu built
 * from the UIs' sections, an aggressive stylesheet, a strict CSP), in
 * headless Chrome (`Bun.WebView`), against real APIs.
 *
 * - **Navigation**: the host's menu moves the UI, with the page's history
 *   and with a host router owning it (`onNavigate`); back, forward and a
 *   reload land on the same screen; the UI's own links reach the host's
 *   router.
 * - **No leak in**: the UI's computed styles inside its root equal those on
 *   its own page, for the same screen, under the host's stylesheet.
 * - **No leak out**: the host's own elements compute the same with the UI
 *   mounted as without it.
 * - **The shells** `"none"`, `"tabs"` and `"full"`: each draws its frame,
 *   no page scrolls sideways at 375 and 1440 px, and U6's accessibility
 *   checks pass on the whole page with the UI in it.
 * - **The reader's text size**: a profile whose default font size is 24 px
 *   gives the root `--bun-ui-rem: 24px`, and the UI's text 1.5 times the
 *   size it has at 16 px.
 * - **Teardown**: `unmount()` leaves no root, closes the UI's sockets and
 *   live streams; a second mount works and tears down as cleanly.
 * - No CSP violation and no console error anywhere.
 *
 * Skips visibly without Chrome (`BUN_CHROME_PATH` overrides the search).
 */
import type { HostShell, HostUi } from "./hostShell";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chromeProfile } from "../../jobs/e2e/profile";
import {
  CHECK_CONTRAST,
  CHECK_STRUCTURE,
  CHECK_WIDTH,
} from "../../security/e2e/a11yChecks";
import { chromePath } from "../../security/e2e/harness";
import { HOST_SHELLS, HOST_UIS, startHostShell } from "./hostShell";

/** Each UI's first screen inside the mount, and a second one its menu reaches. */
const SCREENS: Record<
  HostUi,
  {
    first: string;
    second: { path: string; label: string; ready: string } | null;
  }
> = {
  jobs: {
    first: '[data-testid="overview"]',
    second: {
      path: "/queues",
      label: "Queues",
      ready: '[data-testid="queues-list"]',
    },
  },
  security: {
    first: '[data-testid="analytics"]',
    second: { path: "/bans", label: "Bans", ready: '[data-testid="bans"]' },
  },
  docs: { first: ".screen.http-docs", second: null },
};

/** Inside each UI's own page and inside its mount root, the elements compared. */
const PROBES = [
  "h1",
  "h2",
  "h3",
  ".card-title",
  "label",
  "select",
  "li",
  "dt",
  "dd",
  "strong",
  ".card",
  ".card-header",
  ".btn",
  ".badge",
  "table th",
  "table td",
  ".input",
  "p",
  "a",
  "code",
];

/** The host's own elements, compared with and without the UI mounted. */
const HOST_PROBES = [
  "body",
  ".host-header",
  ".host-brand",
  "#host-theme",
  ".host-menu",
  ".host-menu a",
  ".host-group",
  ".host-table",
  ".host-cell",
  ".host-footer",
];

/** The properties compared (no width or horizontal margin: the areas differ in size). */
const PROPERTIES = [
  "font-size",
  "font-family",
  "font-weight",
  "line-height",
  "letter-spacing",
  "color",
  "background-color",
  "padding-top",
  "padding-left",
  "border-top-width",
  "border-top-style",
  "border-top-color",
  "border-radius",
  "box-sizing",
  "outline-style",
  "text-decoration-line",
  "display",
];

/** Page-side: the first match of each selector inside `scope`, its computed properties. */
function readStyles(scope: string, selectors: readonly string[]): string {
  return `(() => {
    const root = document.querySelector(${JSON.stringify(scope)});
    const out = {};
    for (const selector of ${JSON.stringify(selectors)}) {
      const element = root && root.querySelector(selector);
      if (!element) continue;
      const style = getComputedStyle(element);
      out[selector] = Object.fromEntries(${JSON.stringify(PROPERTIES)}.map((name) => [name, style.getPropertyValue(name)]));
    }
    return JSON.stringify(out);
  })()`;
}

/** Page-side: resolves `true` once `selector` matches (and `ok()` holds), `false` after `ms`. */
function waitScript(selector: string, ms: number): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const check = () => {
      if (document.querySelector(${JSON.stringify(selector)}) && (!window.__host || window.__host.ready)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  })`;
}

describe.skipIf(chromePath === undefined)(
  `embedding in a host page, in Chrome${chromePath === undefined ? " — SKIPPED: no Chrome found (set BUN_CHROME_PATH)" : ""}`,
  () => {
    let host: HostShell;
    /** The views, by name, made on first use. */
    const views = new Map<string, Bun.WebView>();
    const profiles: ReturnType<typeof chromeProfile>[] = [];
    /** Console errors, by view. */
    const errors: string[] = [];

    beforeAll(async () => {
      host = await startHostShell();
      // Warm each UI's bundles before the browser asks.
      for (const ui of HOST_UIS) {
        expect((await fetch(`${host.origin}/ui/${ui}/mount.js`)).status).toBe(
          200,
        );
        expect((await fetch(`${host.origin}/ui/${ui}/`)).status).toBe(200);
      }
    }, 180_000);

    afterAll(async () => {
      for (const view of views.values()) view.close();
      for (const profile of profiles) await profile.remove();
      await host?.close();
    });

    /** A view of `width`: one tab per width, in the one Chrome Bun spawns. */
    function view(width: number): Bun.WebView {
      const key = String(width);
      let made = views.get(key);
      if (made === undefined) {
        const profile = chromeProfile(`embed-${key}`);
        profiles.push(profile);
        made = new Bun.WebView({
          backend: {
            type: "chrome",
            url: false,
            path: chromePath!,
            argv: ["--use-gl=disabled"],
          },
          dataStore: profile.dataStore,
          width,
          height: 900,
          console: (type, ...args) => {
            if (type === "error") {
              errors.push(`${key}: ${args.map(String).join(" ")}`);
            }
          },
        });
        views.set(key, made);
      }
      return made;
    }

    /** Opens `path` in `at` and waits for `ready`. */
    async function open(at: Bun.WebView, path: string, ready: string) {
      await at.navigate(`${host.origin}${path}`);
      await waitFor(at, ready, path);
    }

    /** Waits for `selector` in `at`, or fails naming `what` and the console. */
    async function waitFor(at: Bun.WebView, selector: string, what: string) {
      if (!(await at.evaluate<boolean>(waitScript(selector, 20_000)))) {
        throw new Error(
          `${what}: ${selector} never appeared; console:\n${errors.join("\n")}`,
        );
      }
    }

    /** The page's path, and the CSP violations the host saw. */
    async function state(at: Bun.WebView) {
      return JSON.parse(
        await at.evaluate<string>(
          `JSON.stringify({ path: location.pathname, violations: window.__host?.violations ?? [] })`,
        ),
      ) as { path: string; violations: string[] };
    }

    /** Clicks the host menu's link `label` of `ui`'s group. */
    async function clickMenu(at: Bun.WebView, ui: HostUi, label: string) {
      await at.evaluate(`(() => {
        const link = [...document.querySelectorAll('.host-menu a[href*="/${ui}"]')].find((a) => a.textContent === ${JSON.stringify(label)});
        if (!link) throw new Error("no menu link ${label}");
        link.click();
      })()`);
    }

    /** Page-side: whether `selector` is gone, after up to `ms`. */
    async function gone(at: Bun.WebView, selector: string, ms = 5_000) {
      return at.evaluate<boolean>(`new Promise((resolve) => {
        const deadline = Date.now() + ${ms};
        const check = () => {
          if (!document.querySelector(${JSON.stringify(selector)})) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(check, 50);
        };
        check();
      })`);
    }

    describe("navigation from the host's menu", () => {
      for (const mode of ["page", "router"] as const) {
        for (const ui of HOST_UIS) {
          const { first, second } = SCREENS[ui];
          if (second === null) continue;
          it(`${ui}, ${mode === "page" ? "the page's history" : "a host router (onNavigate)"}: menu, back, forward${mode === "page" ? ", reload" : ""}`, async () => {
            const at = view(1440);
            const base = `/${mode}-none/${ui}`;
            await open(at, `${base}/`, first);
            await clickMenu(at, ui, second.label);
            await waitFor(at, second.ready, "the menu");
            expect((await state(at)).path).toBe(`${base}${second.path}`);
            await at.evaluate("history.back()");
            await waitFor(at, first, "back");
            expect((await state(at)).path).toBe(`${base}/`);
            await at.evaluate("history.forward()");
            await waitFor(at, second.ready, "forward");
            expect((await state(at)).path).toBe(`${base}${second.path}`);
            if (mode === "page") {
              await open(at, `${base}${second.path}`, second.ready);
            }
            expect((await state(at)).violations).toEqual([]);
          });
        }
      }

      it("a host router receives the UI's own navigations, and moves from one UI to another", async () => {
        const at = view(1440);
        await open(at, "/router-tabs/jobs/", SCREENS.jobs.first);
        await at.evaluate(`(() => {
          const tab = [...document.querySelectorAll('[data-bun-ui="jobs"] [data-testid="section-tabs"] a')].find((a) => a.textContent === "Queues");
          tab.click();
        })()`);
        await waitFor(at, '[data-testid="queues-list"]', "the UI's tab");
        const navigations = JSON.parse(
          await at.evaluate<string>(
            "JSON.stringify(window.__host.navigations)",
          ),
        ) as [string, boolean][];
        expect(navigations).toContainEqual(["/router-tabs/jobs/queues", false]);
        expect((await state(at)).path).toBe("/router-tabs/jobs/queues");
        // To another UI: the host unmounts one and mounts the other.
        await clickMenu(at, "security", "Bans");
        await waitFor(
          at,
          '[data-bun-ui="security"] [data-testid="bans"]',
          "security",
        );
        expect(await gone(at, '[data-bun-ui="jobs"]')).toBe(true);
        await at.evaluate("history.back()");
        await waitFor(
          at,
          '[data-bun-ui="jobs"] [data-testid="queues-list"]',
          "back to jobs",
        );
      });
    });

    describe("styles", () => {
      for (const ui of HOST_UIS) {
        it(`${ui}: the same inside the mount, under the host's stylesheet, as on its own page`, async () => {
          const at = view(1440);
          const screen = SCREENS[ui].first;
          await open(at, `/ui/${ui}/`, screen);
          const own = JSON.parse(
            await at.evaluate<string>(readStyles(screen, PROBES)),
          ) as Record<string, unknown>;
          await open(
            at,
            `/page-none/${ui}/`,
            `[data-bun-ui="${ui}"] ${screen}`,
          );
          const mounted = JSON.parse(
            await at.evaluate<string>(
              readStyles(`[data-bun-ui="${ui}"] ${screen}`, PROBES),
            ),
          ) as Record<string, unknown>;
          const compared = Object.keys(own).filter((key) => key in mounted);
          expect(compared.length).toBeGreaterThanOrEqual(3);
          for (const key of compared) {
            expect({ [key]: mounted[key] }).toEqual({ [key]: own[key] });
          }
        });

        it(`${ui}: the host's own elements unchanged by the mount`, async () => {
          const at = view(1440);
          await open(at, `/page-none/${ui}/?nomount`, ".host-menu");
          const before = await at.evaluate<string>(
            readStyles("html", HOST_PROBES),
          );
          await open(
            at,
            `/page-none/${ui}/`,
            `[data-bun-ui="${ui}"] ${SCREENS[ui].first}`,
          );
          const after = await at.evaluate<string>(
            readStyles("html", HOST_PROBES),
          );
          expect(JSON.parse(after)).toEqual(JSON.parse(before));
          expect(Object.keys(JSON.parse(before) as object)).toHaveLength(
            HOST_PROBES.length,
          );
        });
      }
    });

    it("negative control: the UI's page stylesheet, unscoped, would restyle the host", async () => {
      const at = view(1440);
      await open(at, "/ui/jobs/", SCREENS.jobs.first);
      const href = await at.evaluate<string>(
        `document.querySelector('link[rel="stylesheet"]').href`,
      );
      await open(at, "/page-none/jobs/?nomount", ".host-menu");
      const before = await at.evaluate<string>(readStyles("html", HOST_PROBES));
      await at.evaluate(`new Promise((resolve) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = ${JSON.stringify(href)};
        link.onload = resolve;
        document.head.append(link);
      })`);
      const after = await at.evaluate<string>(readStyles("html", HOST_PROBES));
      expect(JSON.parse(after)).not.toEqual(JSON.parse(before));
    });

    describe("the shells", () => {
      for (const shell of HOST_SHELLS) {
        for (const ui of HOST_UIS) {
          it(`${ui}, shell "${shell}": its frame, no sideways scroll at 375 and 1440 px, U6's checks pass`, async () => {
            const ready = `[data-bun-ui="${ui}"] ${SCREENS[ui].first}`;
            for (const width of [1440, 375]) {
              const at = view(width);
              await open(at, `/page-${shell}/${ui}/`, ready);
              const frame = JSON.parse(
                await at.evaluate<string>(`JSON.stringify((() => {
                  const root = document.querySelector('[data-bun-ui="${ui}"]');
                  return {
                    shell: root.querySelector("[data-shell]")?.getAttribute("data-shell") ?? null,
                    bar: !!root.querySelector('[data-testid="app-bar"]'),
                    header: !!root.querySelector("header"),
                  };
                })())`),
              ) as { shell: string | null; bar: boolean; header: boolean };
              expect(frame.shell).toBe(shell);
              expect(frame.header).toBe(shell === "full" && ui !== "docs");
              const problems = [
                ...(await at.evaluate<string[]>(CHECK_WIDTH)),
                ...(width === 1440
                  ? [
                      ...(await at.evaluate<string[]>(CHECK_STRUCTURE)),
                      ...(await at.evaluate<string[]>(CHECK_CONTRAST)),
                    ]
                  : []),
              ];
              expect({ width, problems }).toEqual({ width, problems: [] });
              expect((await state(at)).violations).toEqual([]);
            }
          });
        }
      }
    });

    describe("the reader's text size", () => {
      it("a 24 px default gives --bun-ui-rem 24px and text 1.5 times its 16 px size", async () => {
        const ready = `[data-bun-ui="jobs"] ${SCREENS.jobs.first}`;
        const read = `JSON.stringify({
          rem: document.querySelector('[data-bun-ui="jobs"]').style.getPropertyValue("--bun-ui-rem"),
          h1: parseFloat(getComputedStyle(document.querySelector('[data-bun-ui="jobs"] h1')).fontSize),
          medium: (() => { const s = document.createElement("span"); s.style.fontSize = "medium"; document.body.append(s); const v = getComputedStyle(s).fontSize; s.remove(); return v; })(),
        })`;
        const at = view(1440);
        await open(at, "/page-none/jobs/", ready);
        const at16 = JSON.parse(await at.evaluate<string>(read)) as {
          rem: string;
          h1: number;
          medium: string;
        };
        // The reader's setting: Chrome's default font size, set as its
        // settings page sets it (a profile's preferences cannot be given
        // here: Bun spawns one Chrome per process, the first view's profile).
        await at.cdp("Page.setFontSizes", { fontSizes: { standard: 24 } });
        try {
          await open(at, "/page-none/jobs/", ready);
          const at24 = JSON.parse(
            await at.evaluate<string>(read),
          ) as typeof at16;
          expect(at16).toMatchObject({ rem: "16px", medium: "16px" });
          expect(at24).toMatchObject({ rem: "24px", medium: "24px" });
          expect(at24.h1 / at16.h1).toBeCloseTo(1.5, 2);
        } finally {
          await at.cdp("Page.setFontSizes", { fontSizes: { standard: 16 } });
        }
      });
    });

    describe("teardown", () => {
      for (const ui of HOST_UIS) {
        it(`${ui}: unmount leaves no root and closes its streams; a remount works and tears down as cleanly`, async () => {
          const at = view(1440);
          const ready = `[data-bun-ui="${ui}"] ${SCREENS[ui].first}`;
          await open(at, `/page-none/${ui}/`, ready);
          if (ui === "security") {
            // Control: mounted, its live stream is open.
            expect(
              await at.evaluate<number>(
                "window.__host.streams.filter((s) => s !== null && !s.aborted).length",
              ),
            ).toBeGreaterThan(0);
          }
          for (let round = 0; round < 2; round++) {
            await at.evaluate("window.__host.unmount()");
            expect(await gone(at, "[data-bun-ui]")).toBe(true);
            const left = JSON.parse(
              await at.evaluate<string>(`new Promise((resolve) => setTimeout(() => resolve(JSON.stringify({
                children: document.getElementById("content").children.length,
                sockets: window.__host.sockets.filter((s) => s.readyState < 2).length,
                streams: window.__host.streams.filter((s) => s !== null && !s.aborted).length,
                opened: window.__host.sockets.length + window.__host.streams.length,
              })), 300))`),
            ) as {
              children: number;
              sockets: number;
              streams: number;
              opened: number;
            };
            expect(left).toEqual({
              ...left,
              children: 0,
              sockets: 0,
              streams: 0,
            });
            // The security UI's live stream is always open; the jobs UI
            // opens its socket only when something publishes events, which
            // nothing does here (its socket's teardown is mountLeaks.test.tsx's).
            if (ui === "security") expect(left.opened).toBeGreaterThan(0);
            await at.evaluate("window.__host.mount()");
            await waitFor(at, ready, `remount ${round + 1}`);
          }
          expect((await state(at)).violations).toEqual([]);
        });
      }
    });

    it("logged no console error", () => {
      expect(errors).toEqual([]);
    });
  },
);
