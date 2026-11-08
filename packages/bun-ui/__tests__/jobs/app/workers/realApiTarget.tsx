import type { FetchLike } from "../../../app/api/client";
import { page, visit, waitFor } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the worker page (`/workers/:queue/:key`) for
 * `pkg/worker-target.integration.test.ts`, which runs it against a REAL
 * `createJobsApi` and real workers built with a target. That test compiles
 * without the DOM lib, so everything touching the DOM lives here and the test
 * loads it by a dynamic import. It reports what the page shows and leaves the
 * assertions to the test.
 */

/** What the page shows of where the key's attempts run. */
export interface TargetView {
  /** The target badge in the Instances table's first row (its whole text, "Runs in: " included), or `null` when it shows none. */
  badge: string | null;
  /** The Target card's "Runs in" value, or `null` when absent. */
  kind: string | null;
  /** The Target card's "Processor" value, or `null` when absent. */
  processor: string | null;
  /** The Target card's "File" value, or `null` when the card shows none. */
  file: string | null;
  /** The Target card's row labels ("Runs in", "Processor", …), in order. */
  labels: string[];
  /** The Target card's whole text. */
  card: string;
}

/** What the test can do with the mounted worker page. */
export interface TargetPageDriver {
  /** What the page shows now. */
  view: () => TargetView;
  /** Waits until `ready` holds for the view, and returns it. */
  awaitView: (ready: (view: TargetView) => boolean) => Promise<TargetView>;
  /** Unmounts the app. */
  unmount: () => void;
}

/** The text of the element with this test id, or `null` when absent. */
function text(testId: string): string | null {
  return (
    document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
  );
}

/** Reads the page. */
function read(): TargetView {
  return {
    badge:
      document.querySelector('[data-testid="worker-instances"] .worker-target')
        ?.textContent ?? null,
    kind: text("worker-target-kind"),
    processor: text("worker-target-processor"),
    file: text("worker-target-file"),
    labels: [
      ...document.querySelectorAll('[data-testid="worker-target"] dt'),
    ].map((label) => label.textContent ?? ""),
    card: text("worker-target") ?? "",
  };
}

/** Renders the whole app on the page of worker key `key` of `queue` over `fetch`, and returns a driver. */
export async function mountTargetPage(
  fetch: FetchLike,
  csrfHeader: string,
  queue: string,
  key: string,
): Promise<TargetPageDriver> {
  visit(`/jobs/workers/${queue}/${key}`);
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  await page().findByTestId("worker-target", {}, { timeout: 10_000 });
  return {
    view: read,
    awaitView: async (ready) => {
      let last: TargetView | null = null;
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
