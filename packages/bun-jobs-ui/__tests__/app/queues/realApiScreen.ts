import type { FetchLike } from "../../../app/api/client";
import { fireEvent, page, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the queue screen for `pkg/queues.integration.test.ts`, which runs it
 * against a REAL `createJobsApi`. That test is compiled without the DOM lib
 * (the bun-jobs source graph conflicts with it), so everything touching the
 * DOM lives here, in the DOM project, and the test loads it by a dynamic
 * import it does not follow. It returns what the screen shows and leaves
 * the assertions about the API's state to the test.
 */

/** What the test can do with the rendered screen. */
export interface QueueScreenDriver {
  /** The text of the state tab whose label is exactly `label` (e.g. `"Dead2"`). */
  tab: (label: string) => Promise<string>;
  /** The header's total, e.g. `"8 jobs"`. */
  total: () => string;
  /** Opens a state tab and waits for `rows` rows. Returns the rows' names. */
  openTab: (label: string, rows: number) => Promise<string[]>;
  /** Selects the whole page, retries it, and resolves the success toast's text. */
  retryPage: () => Promise<string>;
  /** Clicks Pause and waits for Resume to replace it. */
  pause: () => Promise<void>;
}

/** Waits for the state tab labelled `label` and returns its text. */
async function findTab(label: string): Promise<HTMLElement> {
  const tabs = await page().findByRole("tablist", { name: "Job states" });
  let found: HTMLElement | undefined;
  await waitFor(() => {
    found = within(tabs)
      .getAllByRole("tab")
      .find((tab) => tab.querySelector(".tab-label")?.textContent === label);
    if (!found) {
      throw new Error(`no tab ${label}`);
    }
  });
  return found!;
}

/** Renders the app at `/queues/<queue>` over `fetch` and returns a driver. */
export async function mountQueueScreen(
  queue: string,
  fetch: FetchLike,
  csrfHeader: string,
): Promise<QueueScreenDriver> {
  visit(`/jobs/queues/${encodeURIComponent(queue)}`);
  renderApp({ config: { csrfHeader }, fetch });
  await page().findByTestId("queue-total");
  return {
    tab: async (label) => (await findTab(label)).textContent ?? "",
    total: () => page().getByTestId("queue-total").textContent ?? "",
    openTab: async (label, rows) => {
      fireEvent.click(await findTab(label));
      const table = await page().findByRole("table", {
        name: `Jobs in ${queue}`,
      });
      let names: string[] = [];
      await waitFor(() => {
        const body = table.querySelectorAll("tbody tr");
        if (body.length !== rows) {
          throw new Error(`${body.length} rows`);
        }
        names = Array.from(body, (row) => row.children[2]?.textContent ?? "");
      });
      return names;
    },
    retryPage: async () => {
      fireEvent.click(page().getByLabelText("Select all jobs on this page"));
      fireEvent.click(page().getByRole("button", { name: "Retry selected" }));
      const toasts = document.querySelector<HTMLElement>(
        'ol[aria-label="Notifications"]',
      )!;
      await waitFor(() => {
        if (!toasts.textContent?.includes("Retried")) {
          throw new Error("no toast yet");
        }
      });
      return toasts.textContent ?? "";
    },
    pause: async () => {
      const actions = page().getByRole("group", { name: "Queue actions" });
      fireEvent.click(within(actions).getByRole("button", { name: "Pause" }));
      await within(actions).findByRole("button", { name: "Resume" });
    },
  };
}
