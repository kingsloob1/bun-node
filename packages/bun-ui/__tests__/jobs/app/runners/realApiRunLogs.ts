import type { FetchLike } from "../../../app/api/client";
import { visit, waitFor } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives one run's log view for `pkg/run-logs.integration.test.ts`, which
 * runs it against a REAL `createJobsApi` and real runs. That test compiles
 * without the DOM lib, so everything touching the DOM lives here and the
 * test loads it by a dynamic import the compiler does not follow.
 *
 * It lands the app on `/runners/<id>?logs=<runId>`, which the history row
 * reads as "expand this run and open its log", so nothing has to be clicked.
 */

/** What one rendered line shows. */
export interface RunLogLineView {
  /** The sequence number in the gutter. */
  seq: string;
  /** Which stream the line came from, as the view labels it. */
  stream: string;
  /** The level badge's text, or `""` when the line carries no level. */
  level: string;
  /** The line's text. */
  text: string;
}

/** What the rendered log view shows. */
export interface RunLogView {
  /** The lines, in the order shown. */
  lines: RunLogLineView[];
  /** The notes above the log ("N earlier lines dropped", the cap, the follow note), or `""`. */
  notes: string;
  /** The "this run logged nothing" line, or `null` when lines are shown. */
  empty: string | null;
  /** The whole section's text, for the copy that is neither a line nor a note. */
  text: string;
}

/** A handle on one mounted log view. */
export interface MountedRunLog {
  /** What the view shows right now. */
  read: () => RunLogView;
  /** Waits until the view holds at least `count` lines, then returns it. */
  awaitLines: (count: number, timeoutMs?: number) => Promise<RunLogView>;
  /** Waits until `text` appears in the section, then returns it. */
  awaitText: (text: string, timeoutMs?: number) => Promise<RunLogView>;
  /** Unmounts the app. */
  unmount: () => void;
}

/** Reads one rendered line. */
function lineOf(node: Element): RunLogLineView {
  return {
    seq: node.querySelector(".log-number")?.textContent ?? "",
    stream: node.querySelector(".run-log-stream")?.textContent ?? "",
    level: node.querySelector(".run-log-level")?.textContent ?? "",
    text: node.querySelector(".log-text")?.textContent ?? "",
  };
}

/**
 * Renders the app at `/runners/<runner>?logs=<runId>` over `fetch` and
 * returns a handle on the log view. `stream` adds the view's own filter
 * (`logStream`), exactly as choosing it in the UI would.
 */
export async function mountRunLog(
  runner: string,
  runId: string,
  fetch: FetchLike,
  stream?: string,
): Promise<MountedRunLog> {
  const query = new URLSearchParams({ logs: runId });
  if (stream !== undefined) {
    query.set("logStream", stream);
  }
  visit(`/jobs/runners/${encodeURIComponent(runner)}?${query.toString()}`);
  const rendered = renderApp({ fetch });
  // Either the log itself, or the note a run whose record already says it
  // logged nothing shows in its place.
  let section!: Element;
  await waitFor(
    () => {
      const node = document.querySelector(
        `[data-testid="run-logs-${runId}"], [data-testid="run-no-logs-${runId}"]`,
      );
      if (!node) {
        throw new Error("no log section yet");
      }
      section = node;
    },
    { timeout: 10_000, interval: 50 },
  );
  const read = (): RunLogView => ({
    lines: Array.from(section.querySelectorAll(".run-log-line"), lineOf),
    notes: section.querySelector(".run-log-notes")?.textContent ?? "",
    empty:
      section.querySelector("[data-testid='run-logs-empty']")?.textContent ??
      (section.getAttribute("data-testid") === `run-no-logs-${runId}`
        ? (section.textContent ?? "")
        : null),
    text: section.textContent ?? "",
  });
  return {
    read,
    awaitLines: async (count, timeoutMs = 10_000) => {
      await waitFor(
        () => {
          const view = read();
          if (view.lines.length < count) {
            throw new Error(`${view.lines.length} lines`);
          }
        },
        { timeout: timeoutMs, interval: 50 },
      );
      return read();
    },
    awaitText: async (text, timeoutMs = 10_000) => {
      await waitFor(
        () => {
          if (!read().text.includes(text)) {
            throw new Error(`no "${text}" yet`);
          }
        },
        { timeout: timeoutMs, interval: 50 },
      );
      return read();
    },
    unmount: () => rendered.unmount(),
  };
}
