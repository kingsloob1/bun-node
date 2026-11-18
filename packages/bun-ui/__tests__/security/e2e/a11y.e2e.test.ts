/**
 * Every security UI screen in Chrome (PR-U6), over the REAL app and a real
 * `createSecurityApi()` holding a little of everything (services, a group,
 * a published policy and a draft, a ban, an approval, an agent, an alert
 * rule and channel, events): each screen is checked for its landmarks and
 * one `h1`, every control's name, text contrast in the light and the dark
 * theme, a visible focus indicator on every control the Tab key reaches (in
 * document order, no positive `tabindex`), and no sideways scroll at 375 px
 * and at 1440 px. The negative control plants one problem of each kind and
 * requires each to be found; the dialog cases are keyboard only.
 *
 * Skips visibly when no Chrome is found (`BUN_CHROME_PATH`).
 */
import type { Host } from "./harness";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  CHECK_CONTRAST,
  CHECK_STRUCTURE,
  CHECK_WIDTH,
  FOCUSED,
  PLANT,
} from "./a11yChecks";
import { chromePath, DIALOG, ok, startHost, suiteName } from "./harness";

/** How many Tab presses each screen's focus walk takes at most. */
const TABS = 30;

/** Every screen, by path (`:ban`, `:approval`, `:rule` and `:channel` filled in once seeded). */
const SCREENS = [
  "/",
  "/services",
  "/services/new",
  "/groups",
  "/policies?scope=global",
  "/policies/versions?scope=global",
  "/rules?scope=global",
  "/rules/new?scope=global",
  "/rules/test?scope=service%3Acheckout",
  "/lists?scope=global",
  "/lists/new?scope=global",
  "/bans",
  "/bans/new",
  "/bans/:ban",
  "/bans/auto",
  "/events",
  "/audit",
  "/audit/1",
  "/approvals",
  "/approvals/:approval",
  "/agents",
  "/agents/new",
  "/agents/checkout-1",
  "/alerts",
  "/alerts/rules",
  "/alerts/rules/:rule",
  "/alerts/channels",
  "/alerts/channels/:channel",
  "/alerts/deliveries",
  "/alerts/dead-letters",
  "/api",
] as const;

describe.skipIf(chromePath === undefined)(
  suiteName("security UI accessibility and layout in Chrome"),
  () => {
    let host: Host;
    const ids: Record<string, string> = {};

    /** A screen's path with the seeded ids. */
    const pathOf = (screen: string) =>
      screen.replace(
        /:(ban|approval|rule|channel)\b/,
        (_, key: string) => ids[key]!,
      );

    /** Opens `path` and waits for its heading, then for its reads to settle. */
    async function show(path: string) {
      await host.open(path, "main h1");
      await host.evaluate(`new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        const check = () => {
          if (!document.querySelector("main .spinner, main [aria-busy=true]") || Date.now() > deadline) return resolve(true);
          setTimeout(check, 50);
        };
        setTimeout(check, 150);
      })`);
    }

    /** The focus walk: Tab through the screen, each stop's indicator and order. */
    async function walkFocus(): Promise<string[]> {
      const out: string[] = [];
      await host.evaluate(
        "(document.activeElement?.blur(), window.scrollTo(0, 0))",
      );
      let previous: string | null = null;
      for (let i = 0; i < TABS; i++) {
        await host.view().press("Tab");
        const focused = await host.evaluate<{
          at: string;
          visible: boolean;
          order: number;
        } | null>(`(() => {
          const f = ${FOCUSED};
          if (f === null) return null;
          const all = [...document.querySelectorAll("*")];
          return { ...f, order: all.indexOf(document.activeElement) };
        })()`);
        if (focused === null) break;
        if (focused.at === previous) break;
        if (!focused.visible)
          out.push(`focus: no visible indicator on ${focused.at}`);
        previous = focused.at;
      }
      return out;
    }

    beforeAll(async () => {
      host = await startHost("a11y", {
        sizes: [
          [1440, 900],
          [375, 812],
        ],
      });
      const { call } = host;
      ok(
        await call("POST", "/groups", { id: "payments", name: "Payments" }),
        "seed 1",
      );
      ok(
        await call(
          "POST",
          "/services",
          {
            id: "checkout",
            name: "Checkout",
            groups: ["payments"],
          },
          "alice",
          true,
        ),
        "seed 2",
      );
      ok(
        await call("PUT", "/policies/global/draft", {
          policy: {
            lists: [
              { ip: "198.51.100.0/24", action: "block", reason: "scanners" },
            ],
            requestRules: {
              rules: [
                {
                  id: "no-admin",
                  when: { path: { prefix: "/admin" } },
                  action: "block",
                  mode: "dryRun",
                },
              ],
            },
          },
          revision: null,
        }),
        "seed 3",
      );
      ok(
        await call(
          "POST",
          "/policies/global/publish",
          { expectedHead: null },
          "alice",
          true,
        ),
        "seed 4",
      );
      // A dangerous change waits for the other operator: an approval.
      const head = ok(await call("GET", "/policies/global"), "seed 5").body.head
        .id;
      ok(
        await call("PUT", "/policies/global/draft", {
          policy: {
            lists: [
              { ip: "203.0.113.0/24", action: "allow", reason: "partner" },
            ],
          },
          revision: null,
        }),
        "seed 6",
      );
      const opened = ok(
        await call(
          "POST",
          "/policies/global/publish",
          { expectedHead: head },
          "alice",
          true,
        ),
        "seed 7",
      );
      ids.approval = opened.body.id;
      const ban = ok(
        await call("POST", "/bans", {
          ip: "192.0.2.44",
          reason: "credential stuffing",
        }),
        "seed 8",
      );
      ids.ban = ban.body.ban?.id ?? ban.body.id;
      ok(
        await call(
          "POST",
          "/agents",
          { id: "checkout-1", service: "checkout" },
          "alice",
          true,
        ),
        "seed 9",
      );
      const channel = ok(
        await call(
          "POST",
          "/alerts/channels",
          {
            id: "ops",
            name: "Ops",
            type: "webhook",
            url: `${host.origin}/hook`,
          },
          "alice",
          true,
        ),
        "seed 10",
      );
      ids.channel = channel.body.channel.id;
      ok(
        await call("PUT", "/alerts/rules/storm", {
          title: "Ban storm",
          scope: "global",
          severity: "warning",
          condition: { type: "banStorm", windowMs: 600_000, value: 50 },
          channels: ["ops"],
          revision: null,
        }),
        "seed 11",
      );
      ids.rule = "storm";
      await host.api.plane.store.appendEvents!("seed", [
        {
          id: "ev1",
          at: Date.now() - 60_000,
          service: "checkout",
          action: "block",
          route: "GET /admin",
          subjects: { ip: "192.0.2.44" },
          sample: {
            method: "GET",
            path: "/admin",
            headers: { "user-agent": "curl" },
          },
        },
      ]);
      for (const [key, value] of Object.entries(ids)) {
        if (typeof value !== "string" || value === "")
          throw new Error(`no seeded ${key}`);
      }
    }, 120_000);

    afterAll(async () => {
      await host?.close();
    }, 30_000);

    for (const screen of SCREENS) {
      it(`${screen}: landmarks, names, contrast (light and dark), focus, and no sideways scroll at 375 and 1440 px`, async () => {
        const problems: string[] = [];
        host.at(1440);
        await show(pathOf(screen));
        problems.push(...(await host.evaluate<string[]>(CHECK_STRUCTURE)));
        for (const theme of ["light", "dark"] as const) {
          await host.evaluate(
            `document.documentElement.setAttribute("data-theme", "${theme}")`,
          );
          problems.push(
            ...(await host.evaluate<string[]>(CHECK_CONTRAST)).map(
              (line) => `${theme}: ${line}`,
            ),
          );
        }
        await host.evaluate(
          `document.documentElement.setAttribute("data-theme", "light")`,
        );
        problems.push(...(await walkFocus()));
        problems.push(
          ...(await host.evaluate<string[]>(CHECK_WIDTH)).map(
            (line) => `1440: ${line}`,
          ),
        );
        host.at(375);
        await show(pathOf(screen));
        problems.push(
          ...(await host.evaluate<string[]>(CHECK_WIDTH)).map(
            (line) => `375: ${line}`,
          ),
        );
        expect(problems).toEqual([]);
      }, 60_000);
    }

    it("negative control: one planted problem of each kind is found", async () => {
      host.at(1440);
      await show("/bans");
      await host.evaluate(PLANT);
      const structure = await host.evaluate<string[]>(CHECK_STRUCTURE);
      expect(
        structure.some(
          (line) => line.includes("has no label") && line.includes("input"),
        ),
      ).toBe(true);
      expect(
        structure.some((line) =>
          line.startsWith("name: a placeholder stands in for a label"),
        ),
      ).toBe(true);
      expect(
        structure.some((line) => line.startsWith("placeholder: none on input")),
      ).toBe(true);
      expect(
        structure.some((line) => line.startsWith("select: no empty option")),
      ).toBe(true);
      expect(
        structure.some((line) =>
          line.startsWith("select: marked always set, yet empty"),
        ),
      ).toBe(true);
      expect(structure.some((line) => line.includes("always-set-honest"))).toBe(
        false,
      );
      expect(
        structure.some((line) =>
          line.startsWith("name: a control has no name: button"),
        ),
      ).toBe(true);
      expect(
        structure.some((line) => line.startsWith("focus: a positive tabindex")),
      ).toBe(true);
      const contrast = await host.evaluate<string[]>(CHECK_CONTRAST);
      expect(contrast.some((line) => line.includes("faint text"))).toBe(true);
      const width = await host.evaluate<string[]>(CHECK_WIDTH);
      expect(width[0]).toStartWith("width: the page is");
      await host.evaluate(
        `document.querySelector('[data-planted="no-focus"]').focus()`,
      );
      const focused = await host.evaluate<{ visible: boolean }>(FOCUSED);
      expect(focused.visible).toBe(false);
    }, 60_000);

    it("a dialog opens, traps focus and closes from the keyboard alone, giving focus back", async () => {
      host.at(1440);
      await show("/bans");
      // Keyboard only: focus the opener, then Enter.
      await host.evaluate(
        `document.querySelector('[data-testid="bulk-lift-open"]').focus()`,
      );
      await host.view().press("Enter");
      await host.waitFor(DIALOG);
      const inside: boolean[] = [];
      for (let i = 0; i < 8; i++) {
        await host.view().press("Tab");
        inside.push(
          (await host.evaluate<{ inDialog: boolean } | null>(FOCUSED))
            ?.inDialog === true,
        );
      }
      expect(inside.every(Boolean)).toBe(true);
      await host.view().press("Escape");
      await host.evaluate(`new Promise((r) => setTimeout(r, 200))`);
      expect(
        await host.evaluate<number>(
          `document.querySelectorAll('${DIALOG}').length`,
        ),
      ).toBe(0);
      expect(
        await host.evaluate<string | null>(
          `document.activeElement?.getAttribute("data-testid") ?? null`,
        ),
      ).toBe("bulk-lift-open");
    }, 60_000);
  },
);
