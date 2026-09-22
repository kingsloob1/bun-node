import type { FetchLike } from "../../../app/api/client";
import { fireEvent, page, visit, waitFor } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the two screens `pkg/added-by-state.integration.test.ts` runs
 * against a REAL `createJobsApi`: the Overview's "Over the range" tile (both
 * of its groups) and a queue's jobs table on one state tab. That test is
 * compiled without the DOM lib, so everything touching the DOM lives here and
 * the test loads it by a dynamic import it does not follow. It returns what
 * the screens show and leaves the assertions to the test.
 */

export { ADDED_BY_STATE_POLL_MS } from "../../../app/api/added";
export { POLL_INTERVAL_MS } from "../../../app/queryClient";
export { mountOverview } from "./realApiOverview";

/** One labelled group of the tile: its heading and its `label → value` rows. */
export interface StatGroupView {
  /** The group's heading (`.range-group-title`), or `null` when it has none. */
  heading: string | null;
  /** Each row's label and value, in order. */
  rows: [label: string, value: string][];
}

/** What the "Over the range" tile shows. */
export interface RangeStatView {
  /** The tile's whole text. */
  text: string;
  /** The analytics series' group (by finish time), or `null` before it answered. */
  finished: StatGroupView | null;
  /** The added-by-state group (`range-stat-added`), or `null` when absent. */
  added: StatGroupView | null;
  /** Whether the added group is still loading (its spinner is up). */
  addedLoading: boolean;
}

/** Reads one `.range-group`. */
function readGroup(root: Element): StatGroupView {
  return {
    heading: root.querySelector(".range-group-title")?.textContent ?? null,
    rows: Array.from(
      root.querySelectorAll(".range-cell"),
      (row) =>
        [
          row.querySelector("dt")?.textContent ?? "",
          row.querySelector("dd")?.textContent ?? "",
        ] as [string, string],
    ),
  };
}

/** Reads the "Over the range" tile as it is now, or `null` while it is not on screen. */
export function readRangeStat(): RangeStatView | null {
  const tile = document.querySelector('[data-testid="range-stat"]');
  if (!tile) {
    return null;
  }
  const added = tile.querySelector('[data-testid="range-stat-added"]');
  const finished = Array.from(tile.querySelectorAll(".range-group")).find(
    (dd) => dd !== added,
  );
  return {
    text: tile.textContent ?? "",
    finished: finished ? readGroup(finished) : null,
    added: added ? readGroup(added) : null,
    addedLoading: added?.querySelector('[role="status"]') != null,
  };
}

/** Resolves with the tile once `ready` holds for it, failing with the last view otherwise. */
export async function awaitRangeStat(
  ready: (view: RangeStatView) => boolean,
  timeoutMs = 8_000,
): Promise<RangeStatView> {
  let last: RangeStatView | null = null;
  await waitFor(
    () => {
      last = readRangeStat();
      if (!last || !ready(last)) {
        throw new Error(
          `range stat not ready: ${JSON.stringify(last)?.slice(0, 800)}`,
        );
      }
    },
    { timeout: timeoutMs, interval: 25 },
  );
  return last!;
}

/** What a queue's jobs table shows. */
export interface JobsTableView {
  /** The job ids of the rows on screen, in order. */
  rows: string[];
  /** The "Count total" toggle's hint, or `null` when it shows none. */
  totalHint: string | null;
}

/** Reads the jobs table of `queue` as it is now. */
function readJobsTable(queue: string): JobsTableView | null {
  // The accessible name sits on the scrollable region around the table.
  const table = document.querySelector(
    `[role="region"][aria-label="Jobs in ${queue}"] table`,
  );
  const toggle = document.querySelector(".jobs-total");
  return table
    ? {
        rows: Array.from(
          table.querySelectorAll<HTMLElement>(
            'tbody [data-testid^="job-row-"]',
          ),
          (row) => row.dataset.testid!.slice("job-row-".length),
        ),
        totalHint:
          Array.from(toggle?.querySelectorAll("*") ?? [])
            .map((element) => element.textContent ?? "")
            .filter((text) => text.includes("creation order"))
            .at(-1) ?? null,
      }
    : null;
}

/** A mounted queue screen. */
export interface MountedJobsTable {
  /** Resolves with the table once `ready` holds for it. */
  awaitTable: (
    ready: (view: JobsTableView) => boolean,
    timeoutMs?: number,
  ) => Promise<JobsTableView>;
  /** Clicks "Count total". */
  toggleTotal: () => void;
  /** Unmounts the app. */
  unmount: () => void;
}

/** Renders the queue screen of `queue` at `search` (e.g. `?state=delayed`) over `fetch`. */
export async function mountJobsTable(
  fetch: FetchLike,
  queue: string,
  search: string,
): Promise<MountedJobsTable> {
  visit(`/jobs/queues/${encodeURIComponent(queue)}${search}`);
  const rendered = renderApp({ fetch });
  await page().findByTestId("queue-total", undefined, { timeout: 5_000 });
  return {
    awaitTable: async (ready, timeoutMs = 8_000) => {
      let last: JobsTableView | null = null;
      await waitFor(
        () => {
          last = readJobsTable(queue);
          if (!last || !ready(last)) {
            throw new Error(`table not ready: ${JSON.stringify(last)}`);
          }
        },
        { timeout: timeoutMs, interval: 25 },
      );
      return last!;
    },
    toggleTotal: () => fireEvent.click(page().getByLabelText("Count total")),
    unmount: () => rendered.unmount(),
  };
}
