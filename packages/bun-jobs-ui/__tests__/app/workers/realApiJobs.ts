import type { FetchLike } from "../../../app/api/client";
import { fireEvent, page, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the worker page's jobs section and the job screen's "Processed by"
 * line for `pkg/job-attribution.integration.test.ts`, which runs them against
 * a REAL `createJobsApi` over real workers. That test is compiled without the
 * DOM lib, so everything touching the DOM lives here and the test loads it by
 * a dynamic import it does not follow. Every read returns what the screen
 * shows and leaves the assertions to the test.
 */

/** What the worker page's jobs section shows now. */
export interface WorkerJobsView {
  /** The ids of the job rows on screen, in order. */
  rows: string[];
  /** Whether the "No jobs" empty state is shown. */
  empty: boolean;
  /** Whether the section says this backend records no attribution. */
  unrecorded: boolean;
  /** Whether it is still loading. */
  loading: boolean;
  /** The range note (`Finished in: …`), or `null` when no range applies. */
  range: string | null;
  /** The "no date range applies" note, or `null` when a range does. */
  noRange: string | null;
  /** An error alert's text, or `null`. */
  alert: string | null;
  /** The whole section's text. */
  text: string;
}

/** A mounted worker page. */
export interface MountedWorkerPage {
  /** The jobs section as it is now, or `null` while it is not on screen. */
  view: () => WorkerJobsView | null;
  /** Resolves the section once `ready` holds for it, failing with the last view otherwise. */
  awaitView: (
    ready: (view: WorkerJobsView) => boolean,
    timeoutMs?: number,
  ) => Promise<WorkerJobsView>;
  /** Resolves once the rest of the page (the key's settings card) has rendered. */
  settled: () => Promise<void>;
  /** Clicks the section's state tab named `name` (`All`, `Active`, …). */
  tab: (name: string) => void;
  /** The `href` of the row link for job `id`, or `null` when it is not a link. */
  rowHref: (id: string) => string | null;
  /** Unmounts the app. */
  unmount: () => void;
}

/** The jobs section's root. */
function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="worker-jobs"]');
}

/** Reads the jobs section. */
function readView(): WorkerJobsView | null {
  const root = card();
  if (!root) {
    return null;
  }
  const prefix = "job-row-";
  return {
    rows: Array.from(
      root.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`),
      (row) => row.dataset.testid!.slice(prefix.length),
    ),
    empty: root.querySelector('[data-testid="worker-jobs-empty"]') !== null,
    unrecorded:
      root.querySelector('[data-testid="worker-jobs-unrecorded"]') !== null,
    loading: root.querySelector('[role="status"]') !== null,
    range:
      root.querySelector('[data-testid="worker-jobs-range"]')?.textContent ??
      null,
    noRange:
      root.querySelector('[data-testid="worker-jobs-no-range"]')?.textContent ??
      null,
    alert: root.querySelector('[role="alert"]')?.textContent ?? null,
    text: root.textContent ?? "",
  };
}

/** Renders the app at the worker page of `key` on `queue` over `fetch`. */
export async function mountWorkerPage(
  fetch: FetchLike,
  queue: string,
  key: string,
): Promise<MountedWorkerPage> {
  visit(
    `/jobs/workers/${encodeURIComponent(queue)}/${encodeURIComponent(key)}`,
  );
  const rendered = renderApp({ fetch });
  await page().findByTestId("worker-jobs", undefined, { timeout: 8_000 });
  return {
    view: readView,
    awaitView: async (ready, timeoutMs = 8_000) => {
      let last: WorkerJobsView | null = null;
      await waitFor(
        () => {
          last = readView();
          if (!last || !ready(last)) {
            throw new Error(
              `jobs section not ready: ${JSON.stringify(last)?.slice(0, 800)}`,
            );
          }
        },
        { timeout: timeoutMs, interval: 25 },
      );
      return last!;
    },
    settled: async () => {
      await page().findByTestId("worker-config", undefined, {
        timeout: 8_000,
      });
    },
    tab: (name) => {
      fireEvent.click(
        within(card()!).getByRole("tab", { name: new RegExp(`^${name}`) }),
      );
    },
    rowHref: (id) =>
      card()
        ?.querySelector(`[data-testid="job-row-${id}"] a`)
        ?.getAttribute("href") ?? null,
    unmount: () => rendered.unmount(),
  };
}

/** What the job screen's "Processed by" row shows. */
export interface ProcessedByView {
  /** Whether the summary has a "Processed by" row at all. */
  present: boolean;
  /** The row's whole text (value and hint), or `""` when absent. */
  text: string;
  /** The key's text, or `null` when no key is shown. */
  key: string | null;
  /** The key link's `href`, or `null` when the key is not a link. */
  href: string | null;
  /** The "No worker recorded" text, or `null` when a worker is shown. */
  none: string | null;
}

/**
 * Renders the app at job `id` of `queue` over `fetch` and reads its
 * "Processed by" row once the summary has rendered.
 */
export async function readProcessedBy(
  fetch: FetchLike,
  queue: string,
  id: string,
): Promise<ProcessedByView> {
  visit(
    `/jobs/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}`,
  );
  const rendered = renderApp({ fetch });
  try {
    await page().findByTestId("job-id", undefined, { timeout: 8_000 });
    let summary: Element | null = null;
    await waitFor(
      () => {
        summary = document.querySelector(".job-summary");
        if (!summary) {
          throw new Error("no job summary");
        }
      },
      { timeout: 8_000, interval: 25 },
    );
    const row = Array.from(
      summary!.querySelectorAll<HTMLElement>(".kv-row"),
    ).find(
      (candidate) =>
        candidate.querySelector("dt")?.textContent === "Processed by",
    );
    if (!row) {
      return { present: false, text: "", key: null, href: null, none: null };
    }
    const key = row.querySelector<HTMLElement>(
      '[data-testid="job-processed-by-key"]',
    );
    return {
      present: true,
      text: row.textContent ?? "",
      key: key?.textContent ?? null,
      href: key?.getAttribute("href") ?? null,
      none:
        row.querySelector('[data-testid="job-processed-by-none"]')
          ?.textContent ?? null,
    };
  } finally {
    rendered.unmount();
  }
}
