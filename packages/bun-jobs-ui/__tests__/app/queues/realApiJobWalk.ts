import type { FetchLike } from "../../../app/api/client";
import { fireEvent, page, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the jobs table's pager for `pkg/jobs-cursor.integration.test.ts`,
 * which runs it against a REAL `createJobsApi`. That test is compiled without
 * the DOM lib, so everything touching the DOM lives here and the test loads
 * it by a dynamic import it does not follow. It returns what each page shows,
 * and calls back between pages so the test can change the queue underneath
 * the walk — which is the whole point of the walk.
 */

/** What one page of the jobs table shows. */
export interface JobsPageView {
  /** The job ids in the table, in the order it lists them. */
  ids: string[];
  /** The pager's range text, e.g. `"1–10"` or `"10 rows"`; `""` with no pager. */
  range: string;
  /** Whether Next can be pressed. */
  canNext: boolean;
  /** Whether Previous can be pressed. */
  canPrev: boolean;
  /** Whether the table says there is no job to show. */
  empty: boolean;
}

/** The job ids the table lists, in order. */
function rowIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid^="job-row-"]'),
    (row) => (row.dataset.testid ?? "").replace("job-row-", ""),
  );
}

/** The jobs pager, or `null` before the first page has loaded. */
function pager(): HTMLElement | null {
  return document.querySelector<HTMLElement>('nav[aria-label="Job pages"]');
}

/** Whether the pager's button called `name` is there and enabled. */
function enabled(name: "Next" | "Previous"): boolean {
  const nav = pager();
  if (nav === null) {
    return false;
  }
  const button = within(nav).queryByRole("button", { name });
  return button !== null && !(button as HTMLButtonElement).disabled;
}

/** What the jobs table shows right now. */
function view(): JobsPageView {
  return {
    ids: rowIds(),
    range: pager()?.querySelector(".pager-range")?.textContent ?? "",
    canNext: enabled("Next"),
    canPrev: enabled("Previous"),
    empty: (document.body.textContent ?? "").includes("No jobs"),
  };
}

/** Waits until the table has settled on rows, or on its empty state. */
async function settled(): Promise<JobsPageView> {
  let current = view();
  await waitFor(() => {
    current = view();
    if (current.ids.length === 0 && !current.empty) {
      throw new Error("the jobs table has not loaded");
    }
  });
  return current;
}

/**
 * Renders `/queues/<queue><query>` over `fetch` and returns what the jobs
 * table shows, then what it shows after each press of the pager's Next — one
 * view per page visited, `turns + 1` of them.
 *
 * @param queue The queue to open.
 * @param fetch The app's `fetch`, pointed at the real API.
 * @param query The query string to land on, including the leading `?`.
 * @param turns How many times to press Next.
 * @param beforeTurn Awaited before each press, so the test can change the
 *   queue between pages — jobs consumed, promoted, whatever it is measuring.
 * @param thenOrder An order to switch to once the walking is done, through
 *   the Order select, without leaving the screen. It is the filter change a
 *   cursor cannot survive, and the view after it is the last one returned.
 */
export async function mountJobPages(
  queue: string,
  fetch: FetchLike,
  query: string,
  turns: number,
  beforeTurn?: (turn: number) => Promise<void>,
  thenOrder?: "asc" | "desc",
): Promise<JobsPageView[]> {
  visit(`/jobs/queues/${encodeURIComponent(queue)}${query}`);
  const rendered = renderApp({ fetch });
  const views = [await settled()];
  for (let turn = 0; turn < turns; turn++) {
    await beforeTurn?.(turn);
    const before = views[views.length - 1]!;
    const nav = page().getByRole("navigation", { name: "Job pages" });
    fireEvent.click(within(nav).getByRole("button", { name: "Next" }));
    await waitFor(() => {
      const now = view();
      if (now.ids.join() === before.ids.join() && !now.empty) {
        throw new Error("the page has not turned");
      }
    });
    views.push(await settled());
  }
  if (thenOrder !== undefined) {
    const before = views[views.length - 1]!;
    fireEvent.change(page().getByLabelText("Order"), {
      target: { value: thenOrder },
    });
    await waitFor(() => {
      const now = view();
      if (now.ids.join() === before.ids.join() && !now.empty) {
        throw new Error("the order has not changed");
      }
    });
    views.push(await settled());
  }
  rendered.unmount();
  return views;
}
