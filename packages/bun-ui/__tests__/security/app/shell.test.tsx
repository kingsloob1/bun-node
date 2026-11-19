/**
 * The security app's frame under each `shell` (embedding.md §2; the user's
 * decision 2026-11-18, §12 item 7), and its sections as one list: the nav
 * renders the browser contract's `SECURITY_SECTIONS`, filtered by the kit's
 * `sectionsFor` exactly as a host's side menu would be.
 */
import type { SecurityApiPermission } from "@kingsleyweb/bun-security/control/contract";
import { describe, expect, it } from "bun:test";
import { readUiConfig } from "../../../app/security/config";
import { BREAK_GLASS_STORAGE_KEY } from "../../../app/security/session/breakGlass";
import { SECURITY_UI_CONFIG_ELEMENT_ID } from "../../../lib/security/browser/config.ts";
import { sectionsFor } from "../../../lib/kit/browser/sections";
import { SECURITY_SECTIONS } from "../../../lib/security/browser/sections";
import { expectAbsent, expectNone } from "../../harness/assert";
import { LOADED, page, setupDom, within } from "./dom";
import { securityConfig } from "./config";
import { defaultRoutes } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** The labels of the links inside the element with `testId`. */
async function linkLabels(testId: string): Promise<string[]> {
  const nav = await page().findByTestId(testId, {}, LOADED);
  return within(nav)
    .queryAllByRole("link")
    .map((link) => link.textContent ?? "");
}

/** Every permission, granted: what the default routes grant on the global scope. */
const EVERYTHING = () => true;

describe("SECURITY_SECTIONS is the nav's list", () => {
  it("in order, label and path, for an operator granted everything", async () => {
    renderApp();
    expect(await linkLabels("nav")).toEqual(
      SECURITY_SECTIONS.map((section) => section.label),
    );
    const hrefs = within(page().getByTestId("nav"))
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(
      SECURITY_SECTIONS.map((section) =>
        section.path === "/" ? "/security" : `/security${section.path}`,
      ),
    );
    expect(
      sectionsFor(SECURITY_SECTIONS, EVERYTHING).map((s) => s.label),
    ).toEqual(SECURITY_SECTIONS.map((s) => s.label));
  });

  it("filtered as sectionsFor filters it, for an operator granted part", async () => {
    const granted: Partial<Record<SecurityApiPermission, true>> = {
      "bans:read": true,
      "audit:read": true,
    };
    // An explicit scope: the default is global only with policy:read there.
    renderApp({
      path: "/?scope=global",
      routes: defaultRoutes({ permissions: { global: granted } }),
    });
    const expected = sectionsFor(
      SECURITY_SECTIONS,
      (permission) => granted[permission] === true,
    ).map((section) => section.label);
    expect(expected).toEqual(["Bans", "Audit", "API reference"]);
    expect(await linkLabels("nav")).toEqual(expected);
  });
});

describe("shell", () => {
  it('"full" (the default): the header, its brand and theme toggle, and the side nav', async () => {
    renderApp();
    await page().findByTestId("nav", {}, LOADED);
    expect(page().getByTestId("app-ready").dataset.shell).toBe("full");
    expect(page().getByRole("banner")).toBeTruthy();
    expect(page().getByRole("button", { name: /^Theme:/ })).toBeTruthy();
    expectNone(page().queryAllByTestId("app-bar"), "compact bars");
  });

  it('"tabs": the sections as tabs, with the scope picker and live badge; no brand, nav or theme toggle', async () => {
    renderApp({ config: { shell: "tabs" } });
    expect(await linkLabels("section-tabs")).toEqual(
      SECURITY_SECTIONS.map((section) => section.label),
    );
    const bar = page().getByTestId("app-bar");
    expect(within(bar).getByTestId("scope-picker")).toBeTruthy();
    expect(within(bar).getByTestId("live-status")).toBeTruthy();
    expect(page().getByTestId("app-ready").dataset.shell).toBe("tabs");
    expectNone(page().queryAllByRole("banner"), "headers");
    expectNone(page().queryAllByTestId("nav"), "side navs");
    expectNone(
      page().queryAllByRole("button", { name: /^Theme:/ }),
      "theme toggles",
    );
    // The screen is there, under the bar.
    await page().findByTestId("analytics", {}, LOADED);
    // A tab keeps the scope, as the side nav's links do.
    expect(
      within(page().getByTestId("section-tabs"))
        .getByRole("link", { name: "Bans" })
        .getAttribute("href"),
    ).toBe("/security/bans");
  });

  it('"tabs" keeps the operator\'s permissions: a section they lack is no tab', async () => {
    renderApp({
      path: "/?scope=global",
      config: { shell: "tabs" },
      routes: defaultRoutes({ permissions: { global: { "bans:read": true } } }),
    });
    expect(await linkLabels("section-tabs")).toEqual(["Bans", "API reference"]);
  });

  it('"none": the screen under a bar of the scope picker alone; no tabs, nav, header or live badge', async () => {
    renderApp({ config: { shell: "none" } });
    await page().findByTestId("analytics", {}, LOADED);
    const bar = page().getByTestId("app-bar");
    expect(within(bar).getByTestId("scope-picker")).toBeTruthy();
    expectNone(within(bar).queryAllByTestId("live-status"), "live badges");
    expectNone(page().queryAllByTestId("section-tabs"), "tab bars");
    expectNone(page().queryAllByTestId("nav"), "side navs");
    expectNone(page().queryAllByRole("banner"), "headers");
    expect(page().getByTestId("app-ready").dataset.shell).toBe("none");
  });

  it('"none" still shows an elevated session: the break-glass badge stays in the bar', async () => {
    window.sessionStorage.setItem(
      BREAK_GLASS_STORAGE_KEY,
      JSON.stringify({
        token: "bg-token",
        expiresAt: Date.now() + 60_000,
        header: "x-bun-security-break-glass",
      }),
    );
    try {
      renderApp({ config: { shell: "none", breakGlass: true } });
      const badge = await page().findByTestId(
        "break-glass-session",
        {},
        LOADED,
      );
      expect(page().getByTestId("app-bar").contains(badge)).toBe(true);
    } finally {
      window.sessionStorage.removeItem(BREAK_GLASS_STORAGE_KEY);
    }
  });

  it("negative control: without a session, no break-glass badge", async () => {
    renderApp({ config: { shell: "none", breakGlass: true } });
    await page().findByTestId("app-bar", {}, LOADED);
    expectAbsent(page().queryByTestId("break-glass-session"));
  });
});

describe("readUiConfig: shell", () => {
  /** Reads `config` back from a page's config element. */
  function read(config: object) {
    const element = document.createElement("script");
    element.type = "application/json";
    element.id = SECURITY_UI_CONFIG_ELEMENT_ID;
    element.textContent = JSON.stringify(config);
    document.body.append(element);
    try {
      return readUiConfig(document);
    } finally {
      element.remove();
    }
  }

  it("takes a missing shell as full (an older shell), keeps a valid one, refuses a bad one", () => {
    const { shell: _chrome, ...without } = securityConfig();
    expect(read(without).shell).toBe("full");
    expect(read(securityConfig({ shell: "tabs" })).shell).toBe("tabs");
    for (const bad of [null, "side", 2]) {
      expect(() => read({ ...securityConfig(), shell: bad })).toThrow(
        '"shell" must be',
      );
    }
  });
});
