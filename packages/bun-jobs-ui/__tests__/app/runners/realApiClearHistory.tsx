import type { FetchLike } from "../../../app/api/client";
import { runnerPath } from "../../../app/api/runners";
import { act, fireEvent, page, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the runner screen's "Clear history…" for
 * `pkg/clear-actions.integration.test.ts`, which runs it against a REAL
 * `createJobsApi`. That test compiles without the DOM lib, so everything
 * touching the DOM lives here and the test loads it by a dynamic import. It
 * reports what the screen shows and leaves the assertions to the test.
 */

/** What the runner screen shows. */
export interface ClearHistoryView {
  /**
   * Whether "Clear history…" is offered anywhere on the screen. It lives in
   * the History card's header; the harness also checks it never shows in
   * the "Runner actions" group, so either place counts here.
   */
  offered: boolean;
  /** Whether "Clear history…" is in the History card's header. */
  inHistoryCard: boolean;
  /** Whether "Clear history…" is in the "Runner actions" group (it should never be). */
  inActionGroup: boolean;
  /** Whether the "Runner actions" group is rendered at all. */
  hasActionGroup: boolean;
  /** Whether the History card is rendered at all. */
  hasHistoryCard: boolean;
  /** The "registered in another process" hint's text, or `null` when absent. */
  remoteHint: string | null;
  /** The run ids of the history rows, newest first; `[]` for "No runs yet". */
  history: string[];
  /** Whether the "No runs yet" empty state is shown. */
  empty: boolean;
  /** The stat tiles, label to value. */
  stats: Record<string, string>;
}

/** What the test can do with the mounted runner screen. */
export interface ClearHistoryDriver {
  /** What the screen shows now. */
  view: () => ClearHistoryView;
  /** Waits until `ready` holds for the view, and returns it. */
  awaitView: (
    ready: (view: ClearHistoryView) => boolean,
    timeoutMs?: number,
  ) => Promise<ClearHistoryView>;
  /**
   * Clicks "Clear history…" and confirms; resolves the dialog's text (read
   * before confirming) and the success toast's.
   */
  clear: () => Promise<{ dialog: string; toast: string }>;
  /** Unmounts the app. */
  unmount: () => void;
}

/** The success toasts' text. */
function toastText(): string {
  return (
    document.querySelector('ol[aria-label="Notifications"]')?.textContent ?? ""
  );
}

/** The History card's "Clear history…", or `null` when it is not offered. */
function historyButton(): HTMLElement | null {
  const card = page().queryByRole("region", { name: "History" });
  return card
    ? within(card).queryByRole("button", { name: "Clear history…" })
    : null;
}

/** Reads the runner screen. */
function read(): ClearHistoryView {
  const group = page().queryByRole("group", { name: "Runner actions" });
  const inActionGroup =
    group !== null &&
    within(group).queryByRole("button", { name: "Clear history…" }) !== null;
  const inHistoryCard = historyButton() !== null;
  const stats: Record<string, string> = {};
  for (const tile of document.querySelectorAll(
    '[data-testid="runner-stats"] .stat',
  )) {
    stats[tile.querySelector("dt")?.textContent ?? ""] =
      tile.querySelector("dd")?.textContent ?? "";
  }
  return {
    offered:
      inHistoryCard ||
      inActionGroup ||
      page().queryAllByRole("button", { name: "Clear history…" }).length > 0,
    inHistoryCard,
    inActionGroup,
    hasActionGroup: group !== null,
    hasHistoryCard: page().queryByRole("region", { name: "History" }) !== null,
    remoteHint: page().queryByTestId("runner-remote-hint")?.textContent ?? null,
    history: Array.from(
      document.querySelectorAll<HTMLElement>('tr[data-testid^="history-row-"]'),
      (row) => row.dataset.testid!.slice("history-row-".length),
    ),
    empty: page().queryByText("No runs yet") !== null,
    stats,
  };
}

/** Renders the whole app on runner `id` over `fetch`, and returns a driver. */
export async function mountRunnerHistory(
  fetch: FetchLike,
  csrfHeader: string,
  id: string,
): Promise<ClearHistoryDriver> {
  visit(`/jobs${runnerPath(id)}`);
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  const awaitView: ClearHistoryDriver["awaitView"] = async (
    ready,
    timeoutMs = 5_000,
  ) => {
    let last: ClearHistoryView | null = null;
    await waitFor(
      () => {
        last = read();
        if (!ready(last)) {
          throw new Error(`not ready: ${JSON.stringify(last)}`);
        }
      },
      { timeout: timeoutMs },
    );
    return last!;
  };
  // Loaded: the stats and the history (rows or the empty state) are in.
  await awaitView(
    (view) =>
      Object.keys(view.stats).length > 0 &&
      (view.empty || view.history.length > 0),
  );
  return {
    view: read,
    awaitView,
    clear: async () => {
      const button = historyButton();
      if (!button) {
        throw new Error("Clear history… is not in the History card");
      }
      fireEvent.click(button);
      let dialog: HTMLElement | null = null;
      await waitFor(() => {
        dialog = document.querySelector<HTMLElement>("dialog[open]");
        if (!dialog) {
          throw new Error("no dialog");
        }
      });
      const text = dialog!.textContent ?? "";
      await act(async () => {
        fireEvent.click(
          within(dialog!).getByRole("button", { name: "Clear history" }),
        );
      });
      await waitFor(
        () => {
          const open = document.querySelector("dialog[open]");
          if (!toastText().includes("Cleared")) {
            throw new Error(
              `no toast yet${open ? `; dialog: ${open.textContent}` : ""}`,
            );
          }
        },
        { timeout: 5_000 },
      );
      return { dialog: text, toast: toastText() };
    },
    unmount: () => rendered.unmount(),
  };
}
