import type { FetchLike } from "../../../app/api/client";
import { page, visit, waitFor } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the worker page (`/workers/:queue/:key`) for
 * `pkg/worker-summon.integration.test.ts`, which runs it against a REAL
 * `createJobsApi` and real workers built with a `summon`. That test compiles
 * without the DOM lib, so everything touching the DOM lives here and the test
 * loads it by a dynamic import. It reports what the page shows and leaves the
 * assertions to the test.
 */

/** What the page shows of where the key's instances were summoned from. */
export interface SummonView {
  /** Whether the Target card has rendered, which the Summoned card renders beside. */
  ready: boolean;
  /** The summon badge in the Instances table's first row, or `null` when it shows none. */
  badge: string | null;
  /** The badge's tooltip, or `null` when there is no badge. */
  badgeHint: string | null;
  /** The Summoned card's column headers, or `null` when there is no card. */
  headers: string[] | null;
  /** The cells of the Summoned card's first row, or `null` when there is no card. */
  cells: string[] | null;
  /** The Summoned card's whole text, `""` when there is no card. */
  card: string;
}

/** What the test can do with the mounted worker page. */
export interface SummonPageDriver {
  /** What the page shows now. */
  view: () => SummonView;
  /** Waits until `ready` holds for the view, and returns it. */
  awaitView: (ready: (view: SummonView) => boolean) => Promise<SummonView>;
  /** Unmounts the app. */
  unmount: () => void;
}

/** Reads the page. */
function read(): SummonView {
  const badge = document.querySelector<HTMLElement>(
    '[data-testid="worker-instances"] [data-testid="worker-summon-badge"]',
  );
  const card = document.querySelector('[data-testid="worker-summon"]');
  const row = card?.querySelector("tbody tr");
  return {
    ready: document.querySelector('[data-testid="worker-target"]') !== null,
    badge: badge?.textContent ?? null,
    badgeHint: badge?.title ?? null,
    headers:
      card === null || card === undefined
        ? null
        : [...card.querySelectorAll("thead th")].map(
            (cell) => cell.textContent ?? "",
          ),
    cells:
      row === null || row === undefined
        ? null
        : [...row.children].map((cell) => cell.textContent ?? ""),
    card: card?.textContent ?? "",
  };
}

/** Renders the whole app on the page of worker key `key` of `queue` over `fetch`, and returns a driver. */
export async function mountSummonPage(
  fetch: FetchLike,
  csrfHeader: string,
  queue: string,
  key: string,
): Promise<SummonPageDriver> {
  visit(`/jobs/workers/${queue}/${key}`);
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  await page().findByTestId("worker-target", {}, { timeout: 10_000 });
  return {
    view: read,
    awaitView: async (ready) => {
      let last: SummonView | null = null;
      await waitFor(
        () => {
          last = read();
          if (!ready(last)) {
            throw new Error(`not ready: ${JSON.stringify(last)}`);
          }
        },
        { timeout: 10_000 },
      );
      return last!;
    },
    unmount: () => rendered.unmount(),
  };
}
