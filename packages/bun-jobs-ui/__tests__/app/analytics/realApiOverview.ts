import type { FetchLike } from "../../../app/api/client";
import { page, visit, waitFor } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the Overview for `pkg/analytics.integration.test.ts`, which runs it
 * against a REAL `createJobsApi` over real workers and runners. That test is
 * compiled without the DOM lib, so everything touching the DOM lives here and
 * the test loads it by a dynamic import it does not follow. It returns what
 * the screen shows and leaves the assertions to the test.
 */

/** One row of an analytics section's table. */
export interface SectionRow {
  /** The row's entity: the runner id or the worker key, from its test id. */
  id: string;
  /** Each cell's text, the row header first. */
  cells: string[];
}

/** What one Overview section shows. */
export interface SectionView {
  /** The whole section's text. */
  text: string;
  /** The range caption, or `null` when the response was not clamped. */
  caption: { text: string; reason: string | null } | null;
  /** The table rows on screen (one page). */
  rows: SectionRow[];
  /** The "the N busiest of M" note, when the rows were capped. */
  truncated: string | null;
  /** The RANGE_NOT_RETAINED explanation, when the API gave one. */
  notRetained: string | null;
  /** An error alert's text, when the section failed. */
  alert: string | null;
  /** Every sparkline's accessible label in the section. */
  sparklines: string[];
  /** The headline figures, `label → value`. */
  figures: Record<string, string>;
}

/** The three sections this harness reads, by the prefix of their test ids. */
export type SectionId = "jobs" | "runners" | "workers";

/** The element a section's content sits in. */
function sectionRoot(id: SectionId): HTMLElement | null {
  if (id === "jobs") {
    // The Jobs card has no wrapper of its own: its caption, chart and
    // explanation all sit in the first card of the screen.
    const marker =
      document.querySelector('[data-testid="jobs-series"]') ??
      document.querySelector('[data-testid="jobs-range-not-retained"]') ??
      document.querySelector('[data-testid="jobs-range-caption"]');
    return (marker?.closest(".card") as HTMLElement | null) ?? null;
  }
  return document.querySelector<HTMLElement>(`[data-testid="${id}-analytics"]`);
}

/** Reads one section as it is now, or `null` while it is not on screen. */
export function readSection(id: SectionId): SectionView | null {
  const root = sectionRoot(id);
  if (!root) {
    return null;
  }
  const caption = root.querySelector<HTMLElement>(
    `[data-testid="${id}-range-caption"]`,
  );
  const rowPrefix =
    id === "runners" ? "runner-analytics-row-" : "worker-analytics-row-";
  const rows =
    id === "jobs"
      ? []
      : Array.from(
          root.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}"]`),
          (row) => ({
            id: row.dataset.testid!.slice(rowPrefix.length),
            cells: Array.from(row.children, (cell) => cell.textContent ?? ""),
          }),
        );
  const figures: Record<string, string> = {};
  for (const stat of root.querySelectorAll(".stat")) {
    const label = stat.querySelector("dt")?.textContent ?? "";
    figures[label] = stat.querySelector(".stat-value")?.textContent ?? "";
  }
  return {
    text: root.textContent ?? "",
    caption: caption
      ? {
          text: caption.textContent ?? "",
          reason: caption.getAttribute("data-clamp-reason"),
        }
      : null,
    rows,
    truncated:
      root.querySelector(`[data-testid="${id}-truncated"]`)?.textContent ??
      null,
    notRetained:
      root.querySelector(`[data-testid="${id}-range-not-retained"]`)
        ?.textContent ?? null,
    alert: root.querySelector('[role="alert"]')?.textContent ?? null,
    sparklines: Array.from(
      root.querySelectorAll('[role="img"]'),
      (image) => image.getAttribute("aria-label") ?? "",
    ),
    figures,
  };
}

/** A mounted Overview. */
export interface MountedOverview {
  /** Resolves with a section once `ready` holds for it, failing with the last view otherwise. */
  section: (
    id: SectionId,
    ready: (view: SectionView) => boolean,
    timeoutMs?: number,
  ) => Promise<SectionView>;
  /** Whether a section is on screen at all. */
  has: (id: SectionId) => boolean;
  /** Unmounts the app. */
  unmount: () => void;
}

/**
 * Renders the app at the Overview with `search` (e.g. `?range=60s`) over
 * `fetch`, and waits for the counts to render.
 */
export async function mountOverview(
  fetch: FetchLike,
  search = "",
): Promise<MountedOverview> {
  visit(`/jobs${search}`);
  const rendered = renderApp({ fetch });
  await page().findByTestId("overview");
  await page().findByTestId("state-counts", undefined, { timeout: 5_000 });
  return {
    section: async (id, ready, timeoutMs = 8_000) => {
      let last: SectionView | null = null;
      await waitFor(
        () => {
          last = readSection(id);
          if (!last || !ready(last)) {
            throw new Error(
              `section ${id} not ready: ${JSON.stringify(last)?.slice(0, 600)}`,
            );
          }
        },
        { timeout: timeoutMs, interval: 25 },
      );
      return last!;
    },
    has: (id) => sectionRoot(id) !== null,
    unmount: () => rendered.unmount(),
  };
}

/** One worker row of the Workers screen: the table's column headers, and the row's cells in the same order. */
export interface WorkerRowView {
  /** The table's column headers. */
  headers: string[];
  /** The row's cells, the row header first. */
  cells: string[];
}

/**
 * Renders the Workers screen over `fetch` and reads the row of worker `id`
 * once `ready` holds for it (the counts ride the heartbeat, so a test waits
 * for the one it expects).
 */
export async function readWorkerRow(
  fetch: FetchLike,
  id: string,
  ready: (view: WorkerRowView) => boolean,
): Promise<WorkerRowView> {
  visit("/jobs/workers");
  const rendered = renderApp({ fetch });
  let view: WorkerRowView | null = null;
  try {
    await waitFor(
      () => {
        const row = document.querySelector(`[data-testid="worker-row-${id}"]`);
        const table = row?.closest("table");
        if (!row || !table) {
          throw new Error(`no row for ${id}`);
        }
        view = {
          headers: Array.from(
            table.querySelectorAll("thead th"),
            (cell) => cell.textContent ?? "",
          ),
          cells: Array.from(row.children, (cell) => cell.textContent ?? ""),
        };
        if (!ready(view)) {
          throw new Error(`row not ready: ${JSON.stringify(view)}`);
        }
      },
      { timeout: 8_000, interval: 50 },
    );
    return view!;
  } finally {
    rendered.unmount();
  }
}
