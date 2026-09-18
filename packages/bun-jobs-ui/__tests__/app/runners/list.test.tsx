import { afterEach, describe, expect, it, jest } from "bun:test";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import { permissionsFixture, problem } from "../fixtures";
import {
  advance,
  AWKWARD_RUNNER,
  AWKWARD_RUNNER_ENCODED,
  renderRunner,
  runnerListFixture,
} from "./fixtures";

// Ahead of setupDom()'s hooks, which need real timers to settle.
afterEach(() => {
  jest.useRealTimers();
});

setupDom();

/** The rows' ids, in order, from their test ids. */
function rowIds(table: HTMLElement): string[] {
  return Array.from(
    table.querySelectorAll<HTMLElement>("tbody tr"),
    (row) => row.dataset.testid?.replace(/^runner-row-/, "") ?? "",
  );
}

describe("the runner list screen", () => {
  it("shows a remote runner's shared paused flag, and any runner's run in flight", async () => {
    renderRunner({ path: "/runners" });
    const table = await page().findByRole("table", { name: "Runners" });
    const billing = within(table).getByTestId("runner-row-billing");
    expect(billing.textContent).toContain("Paused");
    expect(billing.textContent).not.toContain("Run in flight");
    const awkward = within(table).getByTestId(`runner-row-${AWKWARD_RUNNER}`);
    expect(awkward.textContent).toContain("Active");
    // `sync` is local, started, and has a run holding its lock.
    const sync = within(table).getByTestId("runner-row-sync");
    expect(sync.textContent).toContain("Running");
    expect(sync.textContent).toContain("Run in flight");
    expect(
      within(table).getByTestId("runner-row-nightly").textContent,
    ).not.toContain("Run in flight");
  });

  it("lists local runners first with name and status, then remote ids marked remote", async () => {
    renderRunner({
      path: "/runners",
      handlers: {
        // Remote first on the wire: the screen still puts local runners first.
        "GET /runners": {
          body: {
            items: [
              {
                id: "billing",
                local: false,
                isLocal: false,
                isPaused: false,
                isRunning: false,
              },
              ...runnerListFixture().items.filter((item) => item.local),
              {
                id: AWKWARD_RUNNER,
                local: false,
                isLocal: false,
                isPaused: false,
                isRunning: false,
              },
            ],
          },
        },
      },
    });
    const table = await page().findByRole("table", { name: "Runners" });
    expect(rowIds(table)).toEqual([
      "nightly",
      "sync",
      "billing",
      AWKWARD_RUNNER,
    ]);

    const nightly = within(table).getByTestId("runner-row-nightly");
    expect(nightly.textContent).toContain("Nightly report");
    expect(nightly.textContent).toContain("nightly");
    expect(nightly.textContent).toContain("Local");
    expect(nightly.textContent).toContain("Idle");
    expect(within(table).getByTestId("runner-row-sync").textContent).toContain(
      "Running",
    );

    const remote = within(table).getByTestId("runner-row-billing");
    expect(remote.textContent).toContain("Remote");
    expect(remote.textContent).not.toContain("Idle");
    expect(within(remote).getByRole("link").textContent).toBe("billing");

    expect(
      within(table)
        .getByRole("link", { name: "Nightly report" })
        .getAttribute("href"),
    ).toBe("/jobs/runners/nightly");
    expect(
      within(table)
        .getByRole("link", { name: AWKWARD_RUNNER })
        .getAttribute("href"),
    ).toBe(`/jobs/runners/${AWKWARD_RUNNER_ENCODED}`);
    expect(page().getByTestId("runners-count").textContent).toBe(
      "2 local runners, 2 remote runners",
    );
  });

  it("filters by id or name in the browser, keeps the filter in the URL, and says when nothing matches", async () => {
    const { calls } = renderRunner({ path: "/runners" });
    const table = await page().findByRole("table", { name: "Runners" });
    const filter = page().getByLabelText("Filter runners by id or name");

    fireEvent.change(filter, { target: { value: "REPORT" } });
    await waitFor(() =>
      expect(rowIds(table)).toEqual(["nightly", AWKWARD_RUNNER]),
    );
    expect(window.location.search).toBe("?search=REPORT");
    expect(page().getByTestId("runners-count").textContent).toContain(
      "(2 shown)",
    );
    // Client-side: the request never carries the filter.
    expect(
      calls
        .filter((call) => call.path === "/runners")
        .every((call) => call.query.toString() === ""),
    ).toBe(true);

    fireEvent.change(filter, { target: { value: "ghost" } });
    await page().findByText("No runners match");
    fireEvent.change(filter, { target: { value: "" } });
    const again = await page().findByRole("table", { name: "Runners" });
    expect(rowIds(again)).toHaveLength(4);
  });

  it("starts from the filter in the URL", async () => {
    renderRunner({ path: "/runners?search=bill" });
    const table = await page().findByRole("table", { name: "Runners" });
    expect(rowIds(table)).toEqual(["billing"]);
    expect(
      (
        page().getByLabelText(
          "Filter runners by id or name",
        ) as HTMLInputElement
      ).value,
    ).toBe("bill");
  });

  it("says when there are no runners", async () => {
    renderRunner({
      path: "/runners",
      handlers: { "GET /runners": { body: { items: [] } } },
    });
    expect(await page().findByText("No runners yet")).toBeTruthy();
  });

  it("shows a load failure with a retry", async () => {
    let fail = true;
    renderRunner({
      path: "/runners",
      handlers: {
        "GET /runners": () =>
          fail
            ? {
                status: 500,
                body: problem(500, "INTERNAL", "Internal error"),
              }
            : { body: runnerListFixture() },
      },
    });
    expect(await page().findByText("Could not load runners")).toBeTruthy();
    fail = false;
    fireEvent.click(page().getByRole("button", { name: "Retry" }));
    await page().findByRole("table", { name: "Runners" });
  });

  it("shows a spinner while loading", async () => {
    let answer: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    renderRunner({
      path: "/runners",
      handlers: {
        "GET /runners": async () => {
          await answered;
          return { body: runnerListFixture() };
        },
      },
    });
    expect(await page().findByText("Loading runners")).toBeTruthy();
    answer?.();
    await page().findByRole("table", { name: "Runners" });
  });

  it("has no runners section, and never requests the list, without runners.list", async () => {
    const { calls } = renderRunner({
      path: "/runners",
      permissions: permissionsFixture({ "runners.list": false }),
    });
    await page().findByTestId("not-found");
    expect(page().queryByTestId("runners-list")).toBeNull();
    expect(calls.some((call) => call.path === "/runners")).toBe(false);
  });

  it("re-reads the list every 10 s", async () => {
    jest.useFakeTimers();
    const { calls } = renderRunner({ path: "/runners" });
    await advance(100, 10);
    const reads = () => calls.filter((call) => call.path === "/runners").length;
    expect(reads()).toBe(1);
    await advance(9_000);
    expect(reads()).toBe(1);
    await advance(1_000);
    expect(reads()).toBe(2);
    await advance(10_000);
    expect(reads()).toBe(3);
  });
});
