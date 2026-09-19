import type { RouteDef } from "../../../app/routing";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { EmptyState } from "../../../app/components/EmptyState";
import { ErrorView } from "../../../app/components/ErrorView";
import { Link, RouterProvider, Routes } from "../../../app/router";
import { onDemand } from "../../../app/screens/lazy";
import { act, fireEvent, page, render, setupDom, visit } from "../dom";
import { auditDocument, formatFindings } from "./audit";

setupDom();

// React reports every caught render error on console.error; the crashes
// here are deliberate.
let quiet: ReturnType<typeof spyOn>;
beforeEach(() => {
  quiet = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => quiet.mockRestore());

/** Findings of the audit over `html`, for the rules named. */
function audit(html: string, rules: string[]): string[] {
  document.body.innerHTML = html;
  const skip = [
    "one-h1",
    "heading-order",
    "landmarks",
    "control-name",
    "button-name",
    "table",
    "aria-refs",
    "unique-ids",
    "tabindex",
  ].filter((rule) => !rules.includes(rule));
  return formatFindings(auditDocument({ skip }));
}

describe("the structural audit (negative controls)", () => {
  it("counts h1s and catches a skipped heading level", () => {
    expect(audit("<h2>a</h2>", ["one-h1"])).toEqual(["one-h1: 0 h1 elements"]);
    expect(audit("<h1>a</h1><h1>b</h1>", ["one-h1"])[0]).toContain(
      "2 h1 elements",
    );
    expect(audit("<h1>a</h1><h3>b</h3>", ["heading-order"])[0]).toContain(
      "is an h3 after an h1",
    );
    expect(
      audit("<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2>", ["heading-order"]),
    ).toEqual([]);
    // A dialog's heading starts its own outline.
    expect(
      audit("<h1>a</h1><dialog open><h2>d</h2></dialog><h2>b</h2>", [
        "heading-order",
        "one-h1",
      ]),
    ).toEqual([]);
  });

  it("catches unnamed controls and buttons, and accepts every way of naming one", () => {
    expect(audit('<input type="text">', ["control-name"])).toHaveLength(1);
    expect(
      audit(
        '<label for="x">X</label><input id="x"><label>Y <input></label><input aria-label="Z"><span id="n">N</span><select aria-labelledby="n"></select>',
        ["control-name"],
      ),
    ).toEqual([]);
    expect(
      audit('<button><span aria-hidden="true">×</span></button>', [
        "button-name",
      ]),
    ).toHaveLength(1);
    expect(
      audit(
        '<button aria-label="Close"><span aria-hidden="true">×</span></button><a href="/x">Go</a>',
        ["button-name"],
      ),
    ).toEqual([]);
  });

  it("catches an unnamed table, a header cell without scope, a missing ARIA target and a positive tabindex", () => {
    expect(audit("<table><tr><th>A</th></tr></table>", ["table"])).toHaveLength(
      2,
    );
    expect(
      audit(
        '<table><caption>T</caption><tr><th scope="col">A</th></tr></table>',
        ["table"],
      ),
    ).toEqual([]);
    expect(
      audit('<div aria-labelledby="nope"></div>', ["aria-refs"])[0],
    ).toContain("missing #nope");
    expect(audit('<i id="a"></i><b id="a"></b>', ["unique-ids"])).toEqual([
      "unique-ids: #a appears 2 times",
    ]);
    expect(audit('<div tabindex="2"></div>', ["tabindex"])).toHaveLength(1);
  });
});

describe("EmptyState and ErrorView as a screen's heading", () => {
  it("render their title as a paragraph by default, and as the level asked for", () => {
    render(
      <>
        <EmptyState title="Plain" />
        <EmptyState
          title="Runner not found"
          headingLevel={1}
        />
        <ErrorView
          error={new Error("boom")}
          title="Could not load"
          headingLevel={1}
        />
        <ErrorView error={new Error("boom")} />
      </>,
    );
    expect(page().getByText("Plain").tagName).toBe("P");
    expect(
      page().getByRole("heading", { level: 1, name: "Runner not found" }),
    ).toBeTruthy();
    expect(
      page().getByRole("heading", { level: 1, name: "Could not load" }),
    ).toBeTruthy();
    expect(page().getByText("Something went wrong").tagName).toBe("P");
  });
});

/** Whether the throwing screen should throw on its next render. */
let explode = true;

/** A screen that crashes while `explode` is set. */
function Fragile() {
  if (explode) {
    throw new Error("render exploded");
  }
  return <h1>Fragile, recovered</h1>;
}

/** Routes with one screen that crashes and one that does not. */
function renderRoutes() {
  const routes: RouteDef[] = [
    { path: "/fragile", element: <Fragile /> },
    { path: "/fine", element: <h1>Fine</h1> },
  ];
  return render(
    <RouterProvider basePath="/jobs">
      <nav aria-label="Sections">
        <Link to="/fine">Fine</Link>
      </nav>
      <main>
        <Routes
          routes={routes}
          notFound={<h1>Nothing</h1>}
        />
      </main>
    </RouterProvider>,
  );
}

describe("the per-screen error boundary", () => {
  it("shows a recoverable panel in place of a crashed screen, and keeps the app around it", async () => {
    explode = true;
    visit("/jobs/fragile");
    renderRoutes();
    const panel = await page().findByTestId("screen-error");
    expect(panel.textContent).toContain("render exploded");
    expect(
      page().getByRole("heading", {
        level: 1,
        name: "This screen failed to show",
      }),
    ).toBeTruthy();
    expect(page().getByRole("alert")).toBeTruthy();
    // The frame survives: the nav is still there and usable.
    expect(page().getByRole("navigation", { name: "Sections" })).toBeTruthy();

    // Reload this screen: mounted again, and fine this time.
    explode = false;
    fireEvent.click(page().getByRole("button", { name: "Reload this screen" }));
    expect(
      await page().findByRole("heading", { name: "Fragile, recovered" }),
    ).toBeTruthy();
    expect(page().queryByTestId("screen-error")).toBeNull();
  });

  it("stays failed on a reload that crashes again, and recovers by navigating away", async () => {
    explode = true;
    visit("/jobs/fragile");
    renderRoutes();
    await page().findByTestId("screen-error");
    fireEvent.click(page().getByRole("button", { name: "Reload this screen" }));
    expect(await page().findByTestId("screen-error")).toBeTruthy();

    await act(async () => {
      fireEvent.click(page().getByRole("link", { name: "Fine" }));
    });
    expect(page().getByRole("heading", { name: "Fine" })).toBeTruthy();
    expect(page().queryByTestId("screen-error")).toBeNull();
  });

  it("retries a lazy screen whose chunk failed to load", async () => {
    let attempts = 0;
    const Lazy = onDemand(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("chunk failed to load");
      }
      return function Loaded() {
        return <h1>Loaded on retry</h1>;
      };
    }, "Loading the lazy screen");
    visit("/jobs/lazy");
    render(
      <RouterProvider basePath="/jobs">
        <Routes
          routes={[{ path: "/lazy", element: <Lazy /> }]}
          notFound={null}
        />
      </RouterProvider>,
    );
    const panel = await page().findByTestId("screen-error");
    expect(panel.textContent).toContain("chunk failed to load");
    fireEvent.click(page().getByRole("button", { name: "Reload this screen" }));
    expect(
      await page().findByRole("heading", { name: "Loaded on retry" }),
    ).toBeTruthy();
    expect(attempts).toBe(2);
  });
});
