import type { FetchLike } from "../../../app/api/client";
import { fireEvent, page, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the runner history's pager for
 * `pkg/runner-history-paging.integration.test.ts`, which runs it against a
 * REAL `createJobsApi`. That test is compiled without the DOM lib, so
 * everything touching the DOM lives here and the test loads it by a dynamic
 * import it does not follow. It returns what each page shows and leaves the
 * assertions to the test.
 */

/** What one page of the history shows. */
export interface HistoryPageView {
  /** The run ids in the table, in the order it lists them. */
  runIds: string[];
  /** The pager's range text, e.g. `"1–10 of 22"`; `""` with no pager. */
  range: string;
  /** Whether the card says this page starts past the end of the history. */
  emptyPage: boolean;
  /** Whether the card says the runner has never run. */
  neverRan: boolean;
  /** Whether Clear history… is disabled ("No runs to clear."). */
  clearDisabled: boolean;
}

/** What the history card shows right now. */
function view(): HistoryPageView {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid^="history-row-"]'),
    (row) => (row.dataset.testid ?? "").replace(/^history-row-/, ""),
  );
  const pager = document.querySelector('nav[aria-label="History pages"]');
  const clear = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent === "Clear history…");
  const text = document.body.textContent ?? "";
  return {
    runIds: rows,
    range: pager?.querySelector(".pager-range")?.textContent ?? "",
    emptyPage: text.includes("No runs on this page"),
    neverRan: text.includes("No runs yet"),
    clearDisabled: clear?.disabled ?? false,
  };
}

/** Waits until the card has settled on rows, or on one of its empty states. */
async function settled(): Promise<HistoryPageView> {
  let current = view();
  await waitFor(() => {
    current = view();
    if (
      current.runIds.length === 0 &&
      !current.emptyPage &&
      !current.neverRan
    ) {
      throw new Error("the history has not loaded");
    }
  });
  return current;
}

/**
 * Renders `/runners/<id><query>` over `fetch` and returns what the history
 * shows, then what it shows after each press of the pager's Next — one view
 * per page visited, `turns + 1` of them.
 *
 * @param id The runner's id.
 * @param fetch The app's `fetch`, pointed at the real API.
 * @param query The query string to land on, including the leading `?`.
 * @param turns How many times to press Next.
 */
export async function mountHistoryPages(
  id: string,
  fetch: FetchLike,
  query: string,
  turns: number,
): Promise<HistoryPageView[]> {
  visit(`/jobs/runners/${encodeURIComponent(id)}${query}`);
  const rendered = renderApp({ fetch });
  const views = [await settled()];
  for (let turn = 0; turn < turns; turn++) {
    const before = views[views.length - 1]!;
    const pager = page().getByRole("navigation", { name: "History pages" });
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    await waitFor(() => {
      const now = view();
      if (now.runIds.join() === before.runIds.join()) {
        throw new Error("the page has not turned");
      }
    });
    views.push(await settled());
  }
  rendered.unmount();
  return views;
}
