/**
 * The jobs app's frame under each `chrome` (embedding.md §2; the user's
 * decision 2026-11-18, §12 item 7), its sections as one list (the nav reads
 * the browser contract's `JOBS_SECTIONS`, filtered by the kit's
 * `sectionsFor`, then by what the API serves), and the theme toggle applying
 * to the UI's root rather than always to `<html>`.
 */
import type { JobsApiAction } from "../../../app/jobs/api/contract";
import { describe, expect, it } from "bun:test";
import { parseUiConfig, UiConfigError } from "../../../app/jobs/config";
import { UiConfigContext } from "../../../app/jobs/context";
import { buildNav } from "../../../app/jobs/layout/nav";
import { ThemeToggle } from "../../../app/jobs/layout/ThemeToggle";
import { UiRootContext } from "../../../app/kit/frame";
import { JOBS_SECTIONS } from "../../../lib/jobs/browser/sections";
import { sectionsFor } from "../../../lib/kit/browser/sections";
import { expectNone, expectUndefined } from "../../harness/assert";
import { fireEvent, LOADED, page, render, setupDom, within } from "./dom";
import { metaFixture, permissionsFixture, uiConfig } from "./fixtures";
import { renderApp } from "./renderApp";

setupDom();

/** Every action granted, the opt-in `providers.read` included. */
const ALL = permissionsFixture({ "providers.read": true });

/** The nav for `granted`, everything served (mode both, every feature). */
function nav(granted: (action: JobsApiAction) => boolean) {
  return buildNav({
    meta: metaFixture({
      features: { ...metaFixture().features, providers: true },
    }),
    sections: { manage: true, docs: true },
    can: granted,
  });
}

describe("JOBS_SECTIONS is the nav's list", () => {
  it("in order, id, label and path, with everything granted and served", () => {
    expect(
      nav((action) => ALL.actions[action] === true).map(
        ({ id, label, to }) => ({ id, label, path: to }),
      ),
    ).toEqual(
      JOBS_SECTIONS.map(({ id, label, path }) => ({ id, label, path })),
    );
  });

  it("filtered as sectionsFor filters it, when the API serves every section", () => {
    const cases: JobsApiAction[][] = [
      ["metrics.read"],
      ["queues.list"],
      ["workers.list", "docs.read"],
      ["events.connect", "runners.list", "providers.read"],
      [],
    ];
    for (const granted of cases) {
      const can = (action: JobsApiAction) => granted.includes(action);
      expect(nav(can).map((item) => item.id)).toEqual(
        sectionsFor(JOBS_SECTIONS, can).map((section) => section.id),
      );
    }
  });

  it("Overview needs either metrics.read or queues.list (a list: any one is enough)", () => {
    const only = (action: JobsApiAction) =>
      nav((asked) => asked === action).map((item) => item.id);
    expect(only("metrics.read")).toEqual(["overview"]);
    expect(only("queues.list")).toEqual(["overview", "queues", "summoning"]);
    // Negative control: neither, no Overview.
    expect(only("workers.list")).toEqual(["workers"]);
  });
});

describe("chrome", () => {
  it('"full" (the default): the header and the side nav', async () => {
    renderApp();
    const ready = await page().findByTestId("app-ready", {}, LOADED);
    expect(ready.dataset.chrome).toBe("full");
    expect(page().getByRole("banner")).toBeTruthy();
    expect(page().getByRole("navigation", { name: "Sections" }).className).toBe(
      "app-nav",
    );
    expectNone(page().queryAllByTestId("app-bar"), "compact bars");
  });

  it('"tabs": the top-level sections as tabs and the live badge; no brand, chips or theme toggle', async () => {
    renderApp({ config: { chrome: "tabs" } });
    const tabs = await page().findByTestId("section-tabs", {}, LOADED);
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([
      "Overview",
      "Queues",
      "Workers",
      "Summoning",
      "Runners",
      "Events",
      "API docs",
    ]);
    const bar = page().getByTestId("app-bar");
    expect(within(bar).getByTestId("live-status")).toBeTruthy();
    expectNone(page().queryAllByRole("banner"), "headers");
    expectNone(page().queryAllByLabelText("API"), "chip groups");
    expectNone(
      page().queryAllByRole("button", { name: /^Theme:/ }),
      "theme toggles",
    );
    expect(page().getByTestId("app-ready").dataset.chrome).toBe("tabs");
    // The current section's tab is current; the screen is under the bar.
    expect(
      within(tabs)
        .getByRole("link", { name: "Overview" })
        .getAttribute("aria-current"),
    ).toBe("page");
    await page().findByTestId("overview", {}, LOADED);
  });

  it('"none": the screen alone, no bar, header or nav', async () => {
    renderApp({ config: { chrome: "none" } });
    await page().findByTestId("overview", {}, LOADED);
    expect(page().getByTestId("app-ready").dataset.chrome).toBe("none");
    expectNone(page().queryAllByTestId("app-bar"), "compact bars");
    expectNone(page().queryAllByRole("banner"), "headers");
    expectNone(page().queryAllByRole("navigation"), "navs");
    expect(page().getByRole("main")).toBeTruthy();
  });

  it("keeps the keyboard shortcuts in every mode: ? opens the help", async () => {
    for (const chrome of ["full", "tabs", "none"] as const) {
      const { unmount } = renderApp({ config: { chrome } });
      await page().findByTestId("app-ready", {}, LOADED);
      fireEvent.keyDown(document.body, { key: "?" });
      expect(
        await page().findByRole(
          "dialog",
          { name: "Keyboard shortcuts" },
          LOADED,
        ),
      ).toBeTruthy();
      unmount();
    }
  });
});

describe("the theme toggle themes the UI's root", () => {
  /** Renders the toggle alone, inside `root`'s context when given one. */
  function renderToggle(root?: HTMLElement) {
    const toggle = (
      <UiConfigContext value={uiConfig()}>
        <ThemeToggle />
      </UiConfigContext>
    );
    render(
      root ? <UiRootContext value={root}>{toggle}</UiRootContext> : toggle,
    );
  }

  it("sets data-theme on the mount element, leaving <html> alone", () => {
    const element = document.createElement("div");
    document.body.append(element);
    renderToggle(element);
    fireEvent.click(page().getByRole("button", { name: /^Theme:/ }));
    expect(element.dataset.theme).toBe("light");
    expectUndefined(document.documentElement.dataset.theme, "<html>'s theme");
  });

  it("negative control: without a mount element, the shell's root, <html>", () => {
    renderToggle();
    fireEvent.click(page().getByRole("button", { name: /^Theme:/ }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("parseUiConfig: chrome", () => {
  it("takes a missing chrome as full (an older shell), keeps a valid one, refuses a bad one", () => {
    const { chrome: _chrome, ...without } = uiConfig();
    expect(parseUiConfig(without).chrome).toBe("full");
    expect(parseUiConfig(uiConfig({ chrome: "none" })).chrome).toBe("none");
    for (const bad of [null, "Tabs", 0]) {
      expect(() => parseUiConfig({ ...uiConfig(), chrome: bad })).toThrow(
        UiConfigError,
      );
    }
  });
});
