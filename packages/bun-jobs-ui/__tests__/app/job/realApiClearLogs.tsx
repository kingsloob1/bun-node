import type { FetchLike } from "../../../app/api/client";
import { jobScreenPath } from "../../../app/api/jobs";
import { act, fireEvent, page, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the job screen's "Clear logs…" for
 * `pkg/clear-actions.integration.test.ts`, which runs it against a REAL
 * `createJobsApi`. That test compiles without the DOM lib, so everything
 * touching the DOM lives here and the test loads it by a dynamic import. It
 * reports what the screen shows and leaves the assertions to the test.
 */

/** What the job screen's Logs card shows. */
export interface ClearLogsView {
  /** "Clear logs…": absent, or present and enabled or disabled. */
  button: "absent" | "enabled" | "disabled";
  /** The reason shown beside a disabled button, or `null`. */
  reason: string | null;
  /** The "N lines in all" count, or `null` while the logs load. */
  total: number | null;
  /** The log lines on screen, as `[gutter number, text]`. */
  lines: [number, string][];
  /** Whether "No log lines yet." is shown. */
  empty: boolean;
}

/** What the test can do with the mounted job screen. */
export interface ClearLogsDriver {
  /** What the Logs card shows now. */
  view: () => ClearLogsView;
  /** Waits until `ready` holds for the view, and returns it. */
  awaitView: (
    ready: (view: ClearLogsView) => boolean,
    timeoutMs?: number,
  ) => Promise<ClearLogsView>;
  /**
   * Clicks "Clear logs…" and confirms; resolves the confirmation's text (read
   * before confirming) and the success toast's.
   */
  clear: () => Promise<{ confirmation: string; toast: string }>;
  /** Unmounts the app. */
  unmount: () => void;
}

/** The success toasts' text. */
function toastText(): string {
  return (
    document.querySelector('ol[aria-label="Notifications"]')?.textContent ?? ""
  );
}

/** The error toasts' text. */
function errorText(): string {
  return document.querySelector('ol[aria-label="Errors"]')?.textContent ?? "";
}

/** Reads the Logs card. */
function read(): ClearLogsView {
  const button = page().queryByRole("button", {
    name: "Clear logs…",
  }) as HTMLButtonElement | null;
  const totalText = document.querySelector(".job-logs-total")?.textContent;
  const list = document.querySelector('ol[aria-label="Log lines"]');
  return {
    button:
      button === null ? "absent" : button.disabled ? "disabled" : "enabled",
    reason: page().queryByTestId("clear-logs-reason")?.textContent ?? null,
    total:
      totalText === undefined ? null : Number(totalText.replace(/\D/g, "")),
    lines: Array.from(list?.querySelectorAll("li") ?? [], (line) => [
      Number(line.querySelector(".log-number")?.textContent),
      line.querySelector(".log-text")?.textContent ?? "",
    ]),
    empty: page().queryByText("No log lines yet.") !== null,
  };
}

/** Renders the whole app on job `id` of `queue` over `fetch`, and returns a driver. */
export async function mountJobLogs(
  fetch: FetchLike,
  csrfHeader: string,
  queue: string,
  id: string,
): Promise<ClearLogsDriver> {
  visit(`/jobs${jobScreenPath(queue, id)}`);
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  const awaitView: ClearLogsDriver["awaitView"] = async (
    ready,
    timeoutMs = 5_000,
  ) => {
    let last: ClearLogsView | null = null;
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
  await awaitView((view) => view.total !== null);
  return {
    view: read,
    awaitView,
    clear: async () => {
      fireEvent.click(page().getByRole("button", { name: "Clear logs…" }));
      const dialog = await page().findByRole("alertdialog");
      const confirmation = dialog.textContent ?? "";
      await act(async () => {
        fireEvent.click(
          within(dialog).getByRole("button", { name: "Clear logs" }),
        );
      });
      await waitFor(
        () => {
          if (errorText()) {
            throw new Error(`error toast: ${errorText()}`);
          }
          if (!toastText().includes("Cleared")) {
            throw new Error("no toast yet");
          }
        },
        { timeout: 5_000 },
      );
      return { confirmation, toast: toastText() };
    },
    unmount: () => rendered.unmount(),
  };
}
