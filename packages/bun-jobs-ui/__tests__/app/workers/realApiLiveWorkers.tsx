import type { FetchLike } from "../../../app/api/client";
import type { LiveSocketConstructor } from "../../../app/live/client";
import { visit, waitFor } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the whole app, WITH its live-events socket, for
 * `pkg/worker-first-start.integration.test.ts`, which runs it against a REAL
 * `createJobsApi` served on a port. That test compiles without the DOM lib,
 * so everything touching the DOM lives here and the test loads it by a
 * dynamic import. It reports what the page shows and leaves the assertions
 * to the test.
 */

/** What the test can do with the mounted app. */
export interface LiveAppDriver {
  /** The header badge's `data-state` (`live`, `connecting`, `off`, …), or `""` before it renders. */
  liveState: () => string;
  /** Resolves once the header badge reads `state`, failing with what it read instead. */
  awaitLive: (state?: string) => Promise<void>;
  /** Whether the row of worker `id` is on the page now. */
  hasRow: (id: string) => boolean;
  /** The state the row of worker `id` reads (`Running`, `Paused`, …), or `""` while it is absent. */
  rowState: (id: string) => string;
  /** Resolves once the row of worker `id` reads `label`, failing after `timeoutMs` with what it read instead. */
  awaitRow: (id: string, label: string, timeoutMs?: number) => Promise<void>;
  /** Resolves once the page shows `text` anywhere. */
  awaitText: (text: string) => Promise<void>;
  /** Unmounts the app, which stops its live client. */
  unmount: () => void;
}

/**
 * Renders the whole app at `route` (e.g. `/jobs/workers`) over `fetch`, with
 * live updates ON through `socket`, and returns a driver.
 */
export function mountLiveApp(
  route: string,
  fetch: FetchLike,
  csrfHeader: string,
  socket: LiveSocketConstructor,
): LiveAppDriver {
  visit(route);
  const rendered = renderApp({
    fetch,
    config: { csrfHeader },
    live: { WebSocket: socket, backoffInitialMs: 50, backoffMaxMs: 200 },
  });

  /** The row of worker `id`, or `null`. */
  const row = (id: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-testid="worker-row-${id}"]`);

  const liveState = (): string =>
    document
      .querySelector<HTMLElement>('[data-testid="live-status"]')
      ?.getAttribute("data-state") ?? "";

  /**
   * The text of the row's State cell. The column moves with the table's
   * options (queue, host and pid columns come and go), so it is found by the
   * header that names it.
   */
  const rowState = (id: string): string => {
    const here = row(id);
    const headers = [
      ...(here?.closest("table")?.querySelectorAll("thead th") ?? []),
    ];
    const column = headers.findIndex(
      (header) => header.textContent?.trim() === "State",
    );
    if (!here || column < 0) {
      return "";
    }
    return here.children[column]?.textContent?.trim() ?? "";
  };

  return {
    liveState,
    awaitLive: async (state = "live") => {
      await waitFor(
        () => {
          if (liveState() !== state) {
            throw new Error(`live status is "${liveState()}", not "${state}"`);
          }
        },
        { timeout: 10_000 },
      );
    },
    hasRow: (id) => row(id) !== null,
    rowState,
    awaitRow: async (id, label, timeoutMs = 10_000) => {
      await waitFor(
        () => {
          if (!rowState(id).startsWith(label)) {
            throw new Error(
              `${id} reads "${rowState(id) || "(no row)"}", not "${label}"`,
            );
          }
        },
        { timeout: timeoutMs, interval: 20 },
      );
    },
    awaitText: async (text) => {
      await waitFor(
        () => {
          if (!document.body.textContent?.includes(text)) {
            throw new Error(`the page does not show "${text}"`);
          }
        },
        { timeout: 10_000 },
      );
    },
    unmount: () => rendered.unmount(),
  };
}
