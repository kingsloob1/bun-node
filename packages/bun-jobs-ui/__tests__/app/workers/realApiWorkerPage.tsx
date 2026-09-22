import type { FetchLike } from "../../../app/api/client";
import { fireEvent, page, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the worker page (`/workers/:queue/:key`) for
 * `pkg/worker-transitions.integration.test.ts`, which runs it against a REAL
 * `createJobsApi`. That test compiles without the DOM lib, so everything
 * touching the DOM lives here and the test loads it by a dynamic import. It
 * reports what the page shows and leaves the assertions to the test.
 */

/** What the page's Configuration card shows while no instance is live. */
export interface OfflineConfigView {
  /** The "An override is stored…" sentence, or `null` when absent. */
  stored: string | null;
  /** The "No override is stored…" sentence, or `null` when absent. */
  noneStored: string | null;
  /** Whether "Reset to code values…" is offered. */
  offersReset: boolean;
}

/** What the test can do with the mounted worker page. */
export interface WorkerPageDriver {
  /** What the Configuration card shows now. */
  view: () => OfflineConfigView;
  /** Waits until `ready` holds for the view, and returns it. */
  awaitView: (
    ready: (view: OfflineConfigView) => boolean,
  ) => Promise<OfflineConfigView>;
  /** Presses "Reset to code values…" and confirms; resolves the success toast's text. */
  reset: () => Promise<string>;
  /** Unmounts the app. */
  unmount: () => void;
}

/** Reads the Configuration card of a key no instance of which is live. */
function read(): OfflineConfigView {
  const card = document.querySelector<HTMLElement>(
    '[data-testid="worker-config-offline"]',
  );
  return {
    stored:
      card?.querySelector('[data-testid="worker-config-stored"]')
        ?.textContent ?? null,
    noneStored:
      card?.querySelector('[data-testid="worker-config-none-stored"]')
        ?.textContent ?? null,
    offersReset:
      card !== null &&
      within(card).queryByRole("button", {
        name: "Reset to code values…",
      }) !== null,
  };
}

/** Renders the whole app on the page of worker key `key` of `queue` over `fetch`, and returns a driver. */
export async function mountWorkerPage(
  fetch: FetchLike,
  csrfHeader: string,
  queue: string,
  key: string,
): Promise<WorkerPageDriver> {
  visit(`/jobs/workers/${queue}/${key}`);
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  await page().findByTestId("worker-config-offline", {}, { timeout: 10_000 });
  const awaitView: WorkerPageDriver["awaitView"] = async (ready) => {
    let last: OfflineConfigView | null = null;
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
  };
  return {
    view: read,
    awaitView,
    reset: async () => {
      fireEvent.click(
        page().getByRole("button", { name: "Reset to code values…" }),
      );
      const dialog = await page().findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
      let toast = "";
      await waitFor(
        () => {
          toast =
            document.querySelector('ol[aria-label="Notifications"]')
              ?.textContent ?? "";
          if (!toast.includes("Reset")) {
            throw new Error("no toast yet");
          }
        },
        { timeout: 10_000 },
      );
      return toast;
    },
    unmount: () => rendered.unmount(),
  };
}
