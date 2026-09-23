import type { FetchLike } from "../../../app/api/client";
import { createApiClient } from "../../../app/api/client";
import { queueKeys } from "../../../app/api/queues";
import { PermissionScope } from "../../../app/meta/PermissionScope";
import { AppProviders } from "../../../app/providers";
import { createQueryClient } from "../../../app/queryClient";
import { WorkersPanel } from "../../../app/screens/queues/panels/WorkersPanel";
import { page, render, waitFor } from "../dom";
import { uiConfig } from "../fixtures";

/**
 * Drives the queue screen's Workers panel — the real
 * {@link WorkersPanel}, reading `GET /queues/:queue/workers` — for
 * `pkg/sweeps-warning.integration.test.ts`, which runs it against a REAL
 * `createJobsApi` over real `BunQueueWorker`s. That test compiles without the
 * DOM lib, so everything touching the DOM lives here and the test loads it by
 * a dynamic import the compiler does not follow.
 *
 * It reports what the panel shows — the housekeeping note and the worker rows
 * — and leaves every assertion to the test. Nothing here knows what `sweeps`
 * is: the panel's note comes from whatever the live workers reported.
 */

/** The housekeeping note as the panel renders it. */
export interface SweepNote {
  /** Its whole text. */
  text: string;
  /** Its `data-uncertain` attribute, verbatim (`"true"` or `"false"`). */
  uncertain: string;
}

/** What the test can do with a mounted Workers panel. */
export interface WorkersPanelDriver {
  /** The housekeeping note now, or `null` while the panel shows none. */
  note: () => SweepNote | null;
  /** The ids of the worker rows on screen, sorted. */
  rows: () => string[];
  /** Resolves once the rows are exactly `ids`, failing with what was listed instead. */
  awaitRows: (ids: readonly string[]) => Promise<void>;
  /** Resolves the note once it is shown, failing if it never is. */
  awaitNote: () => Promise<SweepNote>;
  /** Resolves once the panel lists `ids` and shows no note, failing with the note it kept. */
  awaitNoNote: (ids: readonly string[]) => Promise<void>;
  /** Invalidates the panel's worker read, so it re-reads the API at once rather than on its own (10s) poll. */
  refresh: () => Promise<void>;
  /** Unmounts the panel, which stops its polling. */
  unmount: () => void;
}

/** The note element, or `null`. */
function noteElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="sweep-warning"]');
}

/** Reads the note, or `null` when the panel shows none. */
function readNote(): SweepNote | null {
  const element = noteElement();
  return element === null
    ? null
    : {
        text: element.textContent ?? "",
        uncertain: element.getAttribute("data-uncertain") ?? "",
      };
}

/**
 * Renders the Workers panel of `queue` over `fetch` and returns a driver for
 * it. The panel polls `GET /queues/:queue/workers` on its own schedule; a
 * test that must not wait ten seconds for the next read calls `refresh()`.
 */
export async function mountWorkersPanel(
  queue: string,
  fetch: FetchLike,
  csrfHeader: string,
): Promise<WorkersPanelDriver> {
  const config = uiConfig({ csrfHeader });
  const client = createApiClient(config, { fetch });
  const queryClient = createQueryClient({ retry: false });
  const rendered = render(
    <AppProviders
      config={config}
      client={client}
      queryClient={queryClient}
    >
      <PermissionScope target={{ queue }}>
        <div data-testid="workers-panel-host">
          <WorkersPanel queue={queue} />
        </div>
      </PermissionScope>
    </AppProviders>,
  );
  await page().findByTestId("workers-panel-host", {}, { timeout: 10_000 });

  const rows = (): string[] =>
    [
      ...document.querySelectorAll<HTMLElement>('[data-testid^="worker-row-"]'),
    ].map((row) => row.dataset.testid!.slice("worker-row-".length));

  const awaitRows = async (ids: readonly string[]): Promise<void> => {
    const wanted = [...ids].sort().join(", ");
    await waitFor(
      () => {
        const listed = rows().sort().join(", ");
        if (listed !== wanted) {
          throw new Error(
            `the panel lists [${listed || "nothing"}], not [${wanted}]`,
          );
        }
      },
      { timeout: 20_000, interval: 50 },
    );
  };

  return {
    note: readNote,
    rows: () => rows().sort(),
    awaitRows,
    awaitNote: async () => {
      await waitFor(
        () => {
          if (noteElement() === null) {
            throw new Error(
              `no housekeeping note; the panel lists [${rows().join(", ") || "nothing"}]`,
            );
          }
        },
        { timeout: 20_000, interval: 50 },
      );
      return readNote()!;
    },
    awaitNoNote: async (ids) => {
      await awaitRows(ids);
      await waitFor(
        () => {
          const note = readNote();
          if (note !== null) {
            throw new Error(`the panel still says: ${note.text}`);
          }
        },
        { timeout: 20_000, interval: 50 },
      );
    },
    refresh: async () => {
      await queryClient.invalidateQueries({
        queryKey: queueKeys.workers(queue),
      });
    },
    unmount: () => rendered.unmount(),
  };
}
