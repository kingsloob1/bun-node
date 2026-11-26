/**
 * The jobs app's frame under each `shell` (embedding.md §2; the user's
 * decision 2026-11-18, §12 item 7), its sections as one list (the nav reads
 * the browser contract's `JOBS_SECTIONS`, filtered by the kit's
 * `sectionsFor`, then by what the API serves), and the theme toggle applying
 * to the UI's root rather than always to `<html>`.
 */
import type { JobsApiAction } from "../../../app/jobs/api/contract";
import type { MetaDto } from "../../../app/jobs/api/types";
import { describe, expect, it } from "bun:test";
import { parseUiConfig, UiConfigError } from "../../../app/jobs/config";
import { UiConfigContext } from "../../../app/jobs/context";
import { buildNav } from "../../../app/jobs/layout/nav";
import { ThemeToggle } from "../../../app/jobs/layout/ThemeToggle";
import { UiRootContext } from "../../../app/kit/frame";
import type { JobsSectionsMeta } from "../../../lib/jobs/browser/sections";
import {
  JOBS_SECTIONS,
  jobsSectionsFor,
} from "../../../lib/jobs/browser/sections";
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

describe("jobsSectionsFor is the nav's rule (#881)", () => {
  const base = metaFixture();
  /** Every combination of mode, feature, socket and docs the rule reads. */
  const metas = ["jobs", "runner", "both"].flatMap((mode) =>
    [false, true].flatMap((workers) =>
      [false, true, undefined].flatMap((summonList) =>
        [false, true].flatMap((providers) =>
          [false, true].flatMap((socket) =>
            [false, true].map((docs): MetaDto => ({
              ...base,
              mode: mode as MetaDto["mode"],
              features: {
                ...base.features,
                workers,
                // Absent on an older API.
                summonList: summonList as boolean,
                providers,
              },
              websocket: socket ? base.websocket : null,
              docs: docs ? base.docs : null,
            })),
          ),
        ),
      ),
    ),
  );
  const grants: ((action: JobsApiAction) => boolean)[] = [
    (action) => ALL.actions[action] === true,
    () => false,
    (action) => action === "queues.list" || action === "docs.read",
    (action) => action !== "metrics.read" && action !== "runners.list",
  ];
  const parts = [
    { manage: true, docs: true },
    { manage: true, docs: false },
    { manage: false, docs: true },
  ];

  it("gives the nav's sections, in its order, for every mode, feature, grant and part", () => {
    let compared = 0;
    for (const meta of metas) {
      for (const can of grants) {
        for (const sections of parts) {
          expect(
            jobsSectionsFor(meta, can, sections).map(
              (section): string => section.id,
            ),
          ).toEqual(
            buildNav({ meta, sections, can }).map((item): string => item.id),
          );
          compared += 1;
        }
      }
    }
    expect(compared).toBe(3 * 2 * 3 * 2 * 2 * 2 * 4 * 3);
  });

  it("drops what the API does not serve, which sectionsFor alone keeps (the control)", () => {
    const runnerOnly: MetaDto = {
      ...base,
      mode: "runner",
      features: { ...base.features, providers: false },
      websocket: null,
      docs: null,
    };
    const can = (action: JobsApiAction) => ALL.actions[action] === true;
    expect(
      jobsSectionsFor(runnerOnly, can).map((section) => section.id),
    ).toEqual(["runners"]);
    // Permission alone links to pages this API answers with not-found.
    expect(
      sectionsFor(JOBS_SECTIONS, can).map((section) => section.id),
    ).not.toEqual(["runners"]);
  });

  it("defaults both parts on, and takes MetaDto as it is", () => {
    const meta: JobsSectionsMeta = metaFixture();
    const can = (action: JobsApiAction) => ALL.actions[action] === true;
    expect(jobsSectionsFor(meta, can)).toEqual(
      jobsSectionsFor(meta, can, { manage: true, docs: true }),
    );
    expect(
      jobsSectionsFor(meta, can, { docs: false }).map((section) => section.id),
    ).not.toContain("docs");
  });
});

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

describe("shell", () => {
  it('"full" (the default): the header and the side nav', async () => {
    renderApp();
    const ready = await page().findByTestId("app-ready", {}, LOADED);
    expect(ready.dataset.shell).toBe("full");
    expect(page().getByRole("banner")).toBeTruthy();
    expect(page().getByRole("navigation", { name: "Sections" }).className).toBe(
      "app-nav",
    );
    expectNone(page().queryAllByTestId("app-bar"), "compact bars");
  });

  it('"tabs": the top-level sections as tabs and the live badge; no brand, chips or theme toggle', async () => {
    renderApp({ config: { shell: "tabs" } });
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
    expect(page().getByTestId("app-ready").dataset.shell).toBe("tabs");
    // The current section's tab is current; the screen is under the bar.
    expect(
      within(tabs)
        .getByRole("link", { name: "Overview" })
        .getAttribute("aria-current"),
    ).toBe("page");
    await page().findByTestId("overview", {}, LOADED);
  });

  it('"none": the screen alone, no bar, header or nav', async () => {
    renderApp({ config: { shell: "none" } });
    await page().findByTestId("overview", {}, LOADED);
    expect(page().getByTestId("app-ready").dataset.shell).toBe("none");
    expectNone(page().queryAllByTestId("app-bar"), "compact bars");
    expectNone(page().queryAllByRole("banner"), "headers");
    expectNone(page().queryAllByRole("navigation"), "navs");
    expect(page().getByRole("main")).toBeTruthy();
  });

  it("keeps the keyboard shortcuts in every mode: ? opens the help", async () => {
    for (const shell of ["full", "tabs", "none"] as const) {
      const { unmount } = renderApp({ config: { shell } });
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

describe("parseUiConfig: shell", () => {
  it("takes a missing shell as full (an older shell), keeps a valid one, refuses a bad one", () => {
    const { shell: _chrome, ...without } = uiConfig();
    expect(parseUiConfig(without).shell).toBe("full");
    expect(parseUiConfig(uiConfig({ shell: "none" })).shell).toBe("none");
    for (const bad of [null, "Tabs", 0]) {
      expect(() => parseUiConfig({ ...uiConfig(), shell: bad })).toThrow(
        UiConfigError,
      );
    }
  });
});
