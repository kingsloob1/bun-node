import type { FetchLike } from "../../../app/api/client";
import { page, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the runner screens for `pkg/runners.integration.test.ts`, which runs
 * them against a REAL `createJobsApi`. That test is compiled without the DOM
 * lib, so everything touching the DOM lives here and the test loads it by a
 * dynamic import it does not follow. It returns what the screens show and
 * leaves the assertions to the test.
 */

/** One row of the rendered runner list. */
export interface RunnerListRow {
  /** The row's runner id (from its test id). */
  id: string;
  /** The row's text: name, where, status. */
  text: string;
  /** The link's `href`. */
  href: string;
}

/** What the rendered runner screen shows. */
export interface RunnerScreenView {
  /** The heading: the runner's name. */
  heading: string;
  /** The status badges' text. */
  status: string;
  /** The schedule in words. */
  schedule: string;
  /** The "Max concurrency" row. */
  concurrency: string;
  /** Each history row's text, newest first. */
  history: string[];
  /** The Total stat tile. */
  total: string;
}

/** Renders the app at `/runners` over `fetch` and returns the rows. */
export async function mountRunnerList(
  fetch: FetchLike,
): Promise<RunnerListRow[]> {
  visit("/jobs/runners");
  const rendered = renderApp({ fetch });
  const table = await page().findByRole("table", { name: "Runners" });
  const rows = Array.from(
    table.querySelectorAll<HTMLElement>("tbody tr"),
    (row) => ({
      id: row.dataset.testid?.replace(/^runner-row-/, "") ?? "",
      text: row.textContent ?? "",
      href: within(row).getByRole("link").getAttribute("href") ?? "",
    }),
  );
  rendered.unmount();
  return rows;
}

/** Renders the app at `/runners/<id>` over `fetch`, waits for `runs` history rows, and returns what it shows. */
export async function mountRunnerScreen(
  id: string,
  fetch: FetchLike,
  runs: number,
): Promise<RunnerScreenView> {
  visit(`/jobs/runners/${encodeURIComponent(id)}`);
  const rendered = renderApp({ fetch });
  const title = await page().findByRole("heading", { level: 1 });
  const table = await page().findByRole("table", { name: "Run history" });
  let history: string[] = [];
  await waitFor(() => {
    history = Array.from(
      table.querySelectorAll("tbody tr"),
      (row) => row.textContent ?? "",
    );
    if (history.length !== runs) {
      throw new Error(`${history.length} history rows`);
    }
  });
  const total = Array.from(
    page().getByTestId("runner-stats").querySelectorAll(".stat"),
  ).find((tile) => tile.querySelector("dt")?.textContent === "Total");
  const view: RunnerScreenView = {
    heading: title.textContent ?? "",
    status: page().getByTestId("runner-status").textContent ?? "",
    schedule: page().getByTestId("runner-schedule").textContent ?? "",
    concurrency: page().getByTestId("runner-concurrency").textContent ?? "",
    history,
    total: total?.querySelector("dd")?.textContent ?? "",
  };
  rendered.unmount();
  return view;
}
