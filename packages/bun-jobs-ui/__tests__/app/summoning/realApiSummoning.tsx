import type { FetchLike } from "../../../app/api/client";
import { fireEvent, page, visit, waitFor, within } from "../dom";
import { findDialog, notifications } from "../queues/fixtures";
import { renderApp } from "../renderApp";

/**
 * Drives the Summoning screen, and from it a queue's Summon panel, for
 * `pkg/summoning.integration.test.ts`, which runs them against a REAL
 * `createJobsApi` with a real summon controller. That test compiles without
 * the DOM lib, so everything touching the DOM lives here and the test loads
 * it by a dynamic import. It reports what the page shows and leaves the
 * assertions to the test.
 */

/** What the Summoning screen shows of one controller. */
export interface SummoningRowView {
  /** The row's whole text. */
  text: string;
  /** The readiness badge's text. */
  readiness: string;
  /** The budget's hour line. */
  hour: string;
  /** The budget's day line. */
  day: string;
  /** Where the queue name links, or `null` when it is not a link. */
  href: string | null;
}

/** What the Summon panel shows after a reset. */
export interface ResetView {
  /** The notifications region's text once the reset toasted. */
  toast: string;
  /** The panel's budget hour line once it re-read the status. */
  hour: string;
}

/** What the test can do with the mounted app. */
export interface SummoningDriver {
  /** Reads `queue`'s row once `ready` holds for it. */
  row: (
    queue: string,
    ready: (view: SummoningRowView) => boolean,
  ) => Promise<SummoningRowView>;
  /**
   * Follows `queue`'s link to its Summon tab, runs Reset… there (ticking
   * "Also clear budget usage" when `clearBudget`), and waits until the
   * panel's hour line satisfies `ready`.
   */
  resetFromRow: (
    queue: string,
    clearBudget: boolean,
    ready: (hour: string) => boolean,
  ) => Promise<ResetView>;
  /** Unmounts the app. */
  unmount: () => void;
}

/** The text of the element with `testId` inside `root`, `""` when there is none. */
function textOf(root: HTMLElement, testId: string): string {
  return within(root).queryByTestId(testId)?.textContent ?? "";
}

/** The view of `queue`'s row, once it is there. */
async function readRow(queue: string): Promise<SummoningRowView> {
  const row = await page().findByTestId(
    `summoning-row-${queue}`,
    {},
    { timeout: 10_000 },
  );
  const link = within(row).queryByRole("link");
  return {
    text: row.textContent ?? "",
    readiness: within(row).getByTestId("summoning-readiness").textContent ?? "",
    hour: textOf(row, `summoning-budget-${queue}-hour`),
    day: textOf(row, `summoning-budget-${queue}-day`),
    href: link?.getAttribute("href") ?? null,
  };
}

/** Renders the app on `/summon` over `fetch` and returns a driver. */
export async function mountSummoning(
  fetch: FetchLike,
  csrfHeader: string,
): Promise<SummoningDriver> {
  visit("/jobs/summon");
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  await page().findByTestId("summoning-screen", {}, { timeout: 10_000 });
  return {
    row: async (queue, ready) => {
      let view: SummoningRowView | null = null;
      await waitFor(
        async () => {
          const read = await readRow(queue);
          if (!ready(read)) {
            throw new Error(`row not ready yet: ${read.text}`);
          }
          view = read;
        },
        { timeout: 15_000 },
      );
      return view!;
    },
    resetFromRow: async (queue, clearBudget, ready) => {
      const row = await page().findByTestId(`summoning-row-${queue}`);
      fireEvent.click(within(row).getByRole("link", { name: queue }));
      const panel = await page().findByTestId(
        "queue-summon",
        {},
        { timeout: 10_000 },
      );
      const button = await within(panel).findByRole(
        "button",
        { name: "Reset…" },
        { timeout: 10_000 },
      );
      fireEvent.click(button);
      const dialog = await findDialog();
      if (clearBudget) {
        fireEvent.click(
          within(dialog).getByLabelText("Also clear budget usage"),
        );
      }
      fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
      let toast = "";
      await waitFor(
        () => {
          toast = notifications().textContent ?? "";
          if (!toast.includes("Reset the summon state")) {
            throw new Error("no reset toast yet");
          }
        },
        { timeout: 10_000 },
      );
      let hour = "";
      await waitFor(
        () => {
          hour =
            within(page().getByTestId("queue-summon")).getByTestId(
              "summon-budget-hour",
            ).textContent ?? "";
          if (!ready(hour)) {
            throw new Error(`panel not re-read yet: ${hour}`);
          }
        },
        { timeout: 10_000 },
      );
      return { toast, hour };
    },
    unmount: () => rendered.unmount(),
  };
}
