import type { FetchLike } from "../../../app/api/client";
import { act, fireEvent, page, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the queue screen's Job defaults panel for
 * `pkg/job-defaults.integration.test.ts`, which runs it against a REAL
 * `createJobsApi`. That test compiles without the DOM lib, so everything
 * touching the DOM lives here and the test loads it by a dynamic import. It
 * reports what the screen shows and leaves the assertions to the test.
 */

/** One row of the panel's table. */
export interface DefaultsRow {
  /** "A job gets". */
  gets: string;
  /** "Code". */
  code: string;
  /** "Override": "Overridden" or "code value". */
  override: string;
}

/** What the Job defaults panel shows. */
export interface DefaultsPanelView {
  /** The table's rows, by contract key. */
  rows: Record<string, DefaultsRow>;
  /** The note under the table (the code-source hint). */
  note: string;
  /** The pending counts, by label ("Waiting", "Retrying", …, "Total"). */
  pending: Record<string, string>;
  /** Whether Settings… is offered. */
  settings: boolean;
  /** The Apply button's label, or `null` when it is not offered. */
  apply: string | null;
  /** Why Apply is not offered, or `null`. */
  unavailable: string | null;
}

/** What the queue screen shows of its panels. */
export interface QueuePanelsView {
  /** The panel tabs' labels, or `null` when there is no panel card. */
  tabs: string[] | null;
  /** Whether the Job defaults panel is rendered. */
  panel: boolean;
  /** The whole screen's text. */
  text: string;
}

/** The open dialog's pieces the test reads. */
export interface DialogView {
  /** Its whole text. */
  text: string;
  /** An alert's text inside it, or `null`. */
  alert: string | null;
  /** The apply progress' text, or `null`. */
  progress: string | null;
  /** The last result's counts (the finished walk's, else the preview's), by label, or `null`. */
  result: Record<string, string> | null;
  /** The exhausted warning's text, or `null`. */
  warning: string | null;
  /** The labels of the enabled buttons in it. */
  buttons: string[];
}

/** What the test can do with the mounted screen. */
export interface JobDefaultsDriver {
  /** The panels' state. */
  panels: () => QueuePanelsView;
  /** The panel's view, or `null` while it is not rendered. */
  view: () => DefaultsPanelView | null;
  /** Waits until `ready` holds for the panel view, and returns it. */
  awaitView: (
    ready: (view: DefaultsPanelView) => boolean,
    timeoutMs?: number,
  ) => Promise<DefaultsPanelView>;
  /** Clicks the panel button named `name` and waits for its dialog. */
  open: (name: string | RegExp) => Promise<void>;
  /** The open dialog, or `null`. */
  dialog: () => DialogView | null;
  /** Waits until `ready` holds for the open dialog, and returns it. */
  awaitDialog: (
    ready: (view: DialogView) => boolean,
    timeoutMs?: number,
  ) => Promise<DialogView>;
  /** Sets the input labelled `label` in the dialog to `value`. */
  type: (label: string, value: string) => void;
  /** Clicks the dialog button named `name`, inside the fieldset of `key` when given. */
  click: (name: string | RegExp, key?: string) => Promise<void>;
  /** Reset's note: its text and whether it sits beside the button, describing it. */
  resetNote: () => { text: string; beside: boolean; describes: boolean };
  /** The success toasts' text. */
  toasts: () => string;
  /** Waits for a success toast containing `text`, failing fast on an error toast. */
  awaitToast: (text: string) => Promise<string>;
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

/** A `KeyValue`'s rows, label to value (its hint left out). */
function keyValues(list: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of list.querySelectorAll(".kv-row")) {
    const label = row.querySelector(".kv-label")?.textContent ?? "";
    const value = row.querySelector(".kv-value");
    const hint = value?.querySelector(".kv-hint")?.textContent ?? "";
    const text = value?.textContent ?? "";
    out[label] = hint ? text.slice(0, text.length - hint.length) : text;
  }
  return out;
}

/** Reads the panel. */
function readPanel(): DefaultsPanelView | null {
  const panel = page().queryByTestId("job-defaults-panel");
  if (!panel) {
    return null;
  }
  const rows: Record<string, DefaultsRow> = {};
  for (const row of panel.querySelectorAll<HTMLElement>(
    "[data-testid^='job-default-row-']",
  )) {
    const key = row.dataset.testid!.slice("job-default-row-".length);
    const cells = row.querySelectorAll("td");
    rows[key] = {
      gets: cells[0]?.textContent ?? "",
      code: cells[1]?.textContent ?? "",
      override: cells[2]?.textContent ?? "",
    };
  }
  const pendingList = panel.querySelector(".job-defaults-pending");
  const apply = within(panel).queryByRole("button", { name: /^Apply to/ });
  return {
    rows,
    note: panel.querySelector(".job-defaults-note")?.textContent ?? "",
    pending: pendingList ? keyValues(pendingList) : {},
    settings:
      within(panel).queryByRole("button", { name: "Settings…" }) !== null,
    apply: apply?.textContent ?? null,
    unavailable:
      within(panel).queryByTestId("apply-unavailable")?.textContent ?? null,
  };
}

/** The open dialog element, or `null`. */
function openDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>("dialog[open]");
}

/** Reads the open dialog. */
function readDialog(): DialogView | null {
  const dialog = openDialog();
  if (!dialog) {
    return null;
  }
  const results = dialog.querySelectorAll(".job-defaults-result");
  const last = results[results.length - 1];
  return {
    text: dialog.textContent ?? "",
    alert: dialog.querySelector("[role='alert']")?.textContent ?? null,
    progress:
      dialog.querySelector("[data-testid='apply-progress']")?.textContent ??
      null,
    result: last ? keyValues(last) : null,
    warning:
      dialog.querySelector("[data-testid='exhausted-warning']")?.textContent ??
      null,
    buttons: Array.from(
      dialog.querySelectorAll<HTMLButtonElement>("button"),
      (button) => (button.disabled ? "" : (button.textContent ?? "")),
    ).filter(Boolean),
  };
}

/** Waits until `read()` answers something `ready` accepts. */
async function awaitRead<T>(
  read: () => T | null,
  ready: (view: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  let last: T | null = null;
  await waitFor(
    () => {
      last = read();
      if (last === null || !ready(last)) {
        throw new Error(`not ready: ${JSON.stringify(last)}`);
      }
    },
    { timeout: timeoutMs },
  );
  return last!;
}

/**
 * Renders the whole app on `queue`'s screen, on the Job defaults panel's tab,
 * over `fetch`, and returns a driver once the screen has loaded (the panel
 * itself may be absent: see {@link JobDefaultsDriver.panels}).
 */
export async function mountJobDefaults(
  fetch: FetchLike,
  csrfHeader: string,
  queue: string,
): Promise<JobDefaultsDriver> {
  visit(`/jobs/queues/${encodeURIComponent(queue)}?panel=job-defaults`);
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  return {
    panels: () => {
      const list = page().queryByRole("tablist", { name: "Queue details" });
      return {
        tabs: list
          ? within(list)
              .getAllByRole("tab")
              .map((tab) => tab.textContent ?? "")
          : null,
        panel: page().queryByTestId("job-defaults-panel") !== null,
        text: document.body.textContent ?? "",
      };
    },
    view: readPanel,
    awaitView: (ready, timeoutMs = 5_000) =>
      awaitRead(readPanel, ready, timeoutMs),
    open: async (name) => {
      const panel = page().getByTestId("job-defaults-panel");
      await act(async () => {
        fireEvent.click(within(panel).getByRole("button", { name }));
      });
      await awaitRead(readDialog, () => true, 5_000);
    },
    dialog: readDialog,
    awaitDialog: (ready, timeoutMs = 5_000) =>
      awaitRead(readDialog, ready, timeoutMs),
    type: (label, value) => {
      fireEvent.change(within(openDialog()!).getByLabelText(label), {
        target: { value },
      });
    },
    click: async (name, key) => {
      const dialog = openDialog()!;
      const scope = key
        ? within(dialog).getByTestId(`job-default-${key}`)
        : dialog;
      await act(async () => {
        fireEvent.click(within(scope).getByRole("button", { name }));
      });
    },
    resetNote: () => {
      const reset = within(openDialog()!).getByRole("button", {
        name: "Reset to code values",
      });
      const id = reset.getAttribute("aria-describedby");
      const note = openDialog()!.querySelector(".job-defaults-reset-note");
      return {
        text: note?.textContent ?? "",
        beside: note !== null && note.parentElement === reset.parentElement,
        describes: id !== null && note?.id === id,
      };
    },
    toasts: toastText,
    awaitToast: async (text) => {
      await waitFor(
        () => {
          if (errorText()) {
            throw new Error(`error toast: ${errorText()}`);
          }
          if (!toastText().includes(text)) {
            throw new Error(`no toast "${text}" yet: ${toastText()}`);
          }
        },
        { timeout: 5_000 },
      );
      return toastText();
    },
    unmount: () => rendered.unmount(),
  };
}
