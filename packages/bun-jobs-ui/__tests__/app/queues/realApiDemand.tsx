import type { FetchLike } from "../../../app/api/client";
import { page, visit, waitFor } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the queue screen's Demand panel and the Overview's Demand column for
 * `pkg/queue-demand.integration.test.ts`, which runs them against a REAL
 * `createJobsApi`. That test compiles without the DOM lib, so everything
 * touching the DOM lives here and the test loads it by a dynamic import. It
 * reports what the page shows and leaves the assertions to the test.
 */

/** What the Demand panel shows. */
export interface DemandPanelView {
  /** Each figure's text, by name (`demand`, `waiting`, …, `workers`). */
  figures: Record<string, string>;
  /** Which notes are shown: `paused`, `capped`, `approximate`. */
  notes: string[];
  /** The JSON and Prometheus URLs it gives. */
  urls: { json: string; prometheus: string };
  /** Whether it shows a next due time (rather than "None scheduled"). */
  nextDue: boolean;
}

/** The test ids of the panel's figures. */
const FIGURES = [
  "demand",
  "outstanding",
  "waiting",
  "dueNow",
  "stalled",
  "active",
  "workers",
];

/** The text of the element with this test id, or `""`. */
function text(testId: string): string {
  return document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

/** Renders the app on `queue`'s Demand panel over `fetch`, and reads it once it shows `ready`. */
export async function readDemandPanel(
  fetch: FetchLike,
  csrfHeader: string,
  queue: string,
): Promise<{ view: DemandPanelView; unmount: () => void }> {
  visit(`/jobs/queues/${encodeURIComponent(queue)}?panel=demand`);
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  await page().findByTestId("queue-demand", {}, { timeout: 10_000 });
  let view: DemandPanelView | null = null;
  await waitFor(
    () => {
      const figures = Object.fromEntries(
        FIGURES.map((name) => [name, text(`demand-${name}`)]),
      );
      if (figures.demand === "") {
        throw new Error("no figures yet");
      }
      view = {
        figures,
        notes: ["paused", "capped", "approximate"].filter(
          (note) =>
            document.querySelector(`[data-testid="demand-${note}"]`) !== null,
        ),
        urls: {
          json: text("demand-url-json"),
          prometheus: text("demand-url-prometheus"),
        },
        nextDue:
          document.querySelector('[data-testid="demand-next-due"] time') !==
          null,
      };
    },
    { timeout: 10_000 },
  );
  return { view: view!, unmount: () => rendered.unmount() };
}

/** Renders the Overview over `fetch` and reads the Demand column's cell of each of `queues`. */
export async function readOverviewDemand(
  fetch: FetchLike,
  csrfHeader: string,
  queues: readonly string[],
): Promise<{ cells: Record<string, string>; unmount: () => void }> {
  visit("/jobs");
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  let cells: Record<string, string> = {};
  await waitFor(
    () => {
      cells = Object.fromEntries(
        queues.map((queue) => [queue, text(`queue-demand-${queue}`)]),
      );
      if (Object.values(cells).includes("")) {
        throw new Error(
          `not every row has its demand: ${JSON.stringify(cells)}`,
        );
      }
    },
    { timeout: 10_000 },
  );
  return { cells, unmount: () => rendered.unmount() };
}
