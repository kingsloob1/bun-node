import type { FetchLike } from "../../../app/api/client";
import { runnerPath } from "../../../app/api/runners";
import { act, fireEvent, page, visit, waitFor, within } from "../dom";
import { renderApp } from "../renderApp";

/**
 * Drives the runner screen's "Settings…" editor and reads its summary rows
 * for `pkg/runner-config.integration.test.ts`, which runs them against a
 * REAL `createJobsApi`. That test compiles without the DOM lib, so everything
 * touching the DOM lives here and the test loads it by a dynamic import. It
 * reports what the screen shows and leaves the assertions to the test.
 */

/** One summary row: its value and the hint beside it. */
export interface SummaryRow {
  /** The row's value, without its hint. */
  value: string;
  /** The hint's text, or `null` when there is none. */
  hint: string | null;
}

/** What the runner screen shows. */
export interface ConfigScreenView {
  /** Whether "Settings…" is in the "Runner actions" group. */
  settingsOffered: boolean;
  /** Whether the "Runner actions" group is rendered at all. */
  hasActionGroup: boolean;
  /** The summary rows the editor touches, by label; `null` when absent. */
  summary: {
    /** "Execution mode". */
    executionMode: SummaryRow | null;
    /** "Run mode". */
    runMode: SummaryRow | null;
    /** "Max concurrency". */
    maxConcurrency: SummaryRow | null;
    /** "Settings override". */
    override: SummaryRow | null;
  };
}

/** What the open Settings dialog shows. */
export interface ConfigDialogView {
  /** The execution mode picker's option values, in order. */
  modeOptions: string[];
  /** The execution mode selected. */
  executionMode: string;
  /** The run mode selected. */
  runMode: string;
  /** The cap field's raw value (`""` for unlimited). */
  maxConcurrency: string;
  /** Whether the cap field is disabled. */
  capDisabled: boolean;
  /** The two "where this comes from" lines, by `data-testid` suffix. */
  sources: { executionMode: string; concurrency: string };
  /** The "not offered" note, or `null`. */
  modesLimited: string | null;
  /** The "owner refused" note, or `null`. */
  refused: string | null;
  /** The "not adopted yet" note, or `null`. */
  pending: string | null;
  /** The field hints, by label. */
  hints: { executionMode: string; runMode: string; maxConcurrency: string };
  /** Whether "Save settings" is disabled. */
  saveDisabled: boolean;
  /** Whether "Reset to code defaults" is offered. */
  resetOffered: boolean;
  /** The problem banner's text, or `null`. */
  banner: string | null;
}

/** What the test can do with the open dialog. */
export interface ConfigDialogDriver {
  /** What it shows now. */
  view: () => ConfigDialogView;
  /** Picks an execution mode. */
  setExecutionMode: (mode: string) => void;
  /** Picks a run mode. */
  setRunMode: (mode: string) => void;
  /** Types a cap (`""` for unlimited). */
  setMaxConcurrency: (value: string) => void;
  /** Clicks one setting's "Use the code default". */
  pickCodeDefault: (which: "execution-mode" | "concurrency") => void;
  /** Clicks "Save settings"; resolves once the dialog closed (the toast) or showed a banner. */
  save: () => Promise<{
    closed: boolean;
    toast: string;
    banner: string | null;
  }>;
  /** Clicks "Reset to code defaults"; resolves like {@link save}. */
  reset: () => Promise<{
    closed: boolean;
    toast: string;
    banner: string | null;
  }>;
  /** Clicks Cancel and waits for the dialog to close. */
  cancel: () => Promise<void>;
}

/** What the test can do with the mounted runner screen. */
export interface ConfigScreenDriver {
  /** What the screen shows now. */
  view: () => ConfigScreenView;
  /** Waits until `ready` holds for the view, and returns it. */
  awaitView: (
    ready: (view: ConfigScreenView) => boolean,
    timeoutMs?: number,
  ) => Promise<ConfigScreenView>;
  /** Opens "Settings…" and returns the dialog's driver. */
  openSettings: () => Promise<ConfigDialogDriver>;
  /** Re-reads everything, as a reload would (the idle screen polls every 15 s). */
  refresh: () => Promise<void>;
  /** Unmounts the app. */
  unmount: () => void;
}

/** The success toasts' text. */
function toastText(): string {
  return (
    document.querySelector('ol[aria-label="Notifications"]')?.textContent ?? ""
  );
}

/** A summary row by its label. */
function summaryRow(label: string): SummaryRow | null {
  const row = Array.from(
    document.querySelectorAll(".runner-summary .kv-row"),
  ).find((candidate) => candidate.querySelector("dt")?.textContent === label);
  if (!row) {
    return null;
  }
  const dd = row.querySelector("dd");
  const hint = dd?.querySelector(".kv-hint")?.textContent ?? null;
  const all = dd?.textContent ?? "";
  return {
    value: hint === null ? all : all.slice(0, all.length - hint.length),
    hint,
  };
}

/** Reads the runner screen. */
function read(): ConfigScreenView {
  const group = page().queryByRole("group", { name: "Runner actions" });
  return {
    settingsOffered:
      group !== null &&
      within(group).queryByRole("button", { name: "Settings…" }) !== null,
    hasActionGroup: group !== null,
    summary: {
      executionMode: summaryRow("Execution mode"),
      runMode: summaryRow("Run mode"),
      maxConcurrency: summaryRow("Max concurrency"),
      override: summaryRow("Settings override"),
    },
  };
}

/** The open dialog, or `null`. */
function openDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>("dialog[open]");
}

/** A dialog control by its field label. */
function control(dialog: HTMLElement, label: string): HTMLInputElement {
  return within(dialog).getByLabelText(label) as HTMLInputElement;
}

/** A field's hint, by its label. */
function hint(dialog: HTMLElement, label: string): string {
  const field = control(dialog, label).closest(".field");
  return field?.querySelector('[id$="-hint"]')?.textContent ?? "";
}

/** A dialog button by name. */
function button(dialog: HTMLElement, name: string): HTMLButtonElement | null {
  return within(dialog).queryByRole("button", {
    name,
  }) as HTMLButtonElement | null;
}

/** Reads the dialog. */
function readDialog(dialog: HTMLElement): ConfigDialogView {
  const text = (id: string) =>
    dialog.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
  const mode = control(
    dialog,
    "Execution mode",
  ) as unknown as HTMLSelectElement;
  const cap = control(dialog, "Max concurrency");
  return {
    modeOptions: Array.from(mode.options, (option) => option.value),
    executionMode: mode.value,
    runMode: control(dialog, "Run mode").value,
    maxConcurrency: cap.value,
    capDisabled: cap.disabled,
    sources: {
      executionMode: text("config-source-execution-mode") ?? "",
      concurrency: text("config-source-concurrency") ?? "",
    },
    modesLimited: text("config-modes-limited"),
    refused: text("config-refused"),
    pending: text("config-pending"),
    hints: {
      executionMode: hint(dialog, "Execution mode"),
      runMode: hint(dialog, "Run mode"),
      maxConcurrency: hint(dialog, "Max concurrency"),
    },
    saveDisabled: button(dialog, "Save settings")?.disabled ?? true,
    resetOffered: button(dialog, "Reset to code defaults") !== null,
    banner: within(dialog).queryByRole("alert")?.textContent ?? null,
  };
}

/** Clicks `name` in `dialog` and waits for it to close or show a banner. */
async function submit(
  dialog: HTMLElement,
  name: string,
): Promise<{ closed: boolean; toast: string; banner: string | null }> {
  const target = button(dialog, name);
  if (!target) {
    throw new Error(`no "${name}" button`);
  }
  if (target.disabled) {
    throw new Error(`"${name}" is disabled`);
  }
  await act(async () => {
    fireEvent.click(target);
  });
  await waitFor(
    () => {
      const banner = within(dialog).queryByRole("alert");
      if (openDialog() !== null && banner === null) {
        throw new Error("the dialog is still open, with no banner");
      }
      if (openDialog() === null && toastText() === "") {
        throw new Error("closed, but no toast yet");
      }
    },
    { timeout: 5_000 },
  );
  const open = openDialog();
  return {
    closed: open === null,
    toast: toastText(),
    banner: open
      ? (within(open).queryByRole("alert")?.textContent ?? null)
      : null,
  };
}

/** Renders the whole app on runner `id` over `fetch`, and returns a driver. */
export async function mountRunnerConfig(
  fetch: FetchLike,
  csrfHeader: string,
  id: string,
): Promise<ConfigScreenDriver> {
  visit(`/jobs${runnerPath(id)}`);
  const rendered = renderApp({ fetch, config: { csrfHeader } });
  const awaitView: ConfigScreenDriver["awaitView"] = async (
    ready,
    timeoutMs = 5_000,
  ) => {
    let last: ConfigScreenView | null = null;
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
  // Loaded: the summary and the action group (whose buttons wait for the
  // permissions) are in.
  await awaitView(
    (view) =>
      view.summary.executionMode !== null &&
      view.hasActionGroup &&
      page().queryByRole("button", { name: "Trigger…" }) !== null,
  );
  return {
    view: read,
    awaitView,
    openSettings: async () => {
      const group = page().getByRole("group", { name: "Runner actions" });
      fireEvent.click(within(group).getByRole("button", { name: "Settings…" }));
      let dialog: HTMLElement | null = null;
      await waitFor(() => {
        dialog = openDialog();
        if (!dialog) {
          throw new Error("no dialog");
        }
      });
      const open = dialog!;
      return {
        view: () => readDialog(open),
        setExecutionMode: (mode) => {
          fireEvent.change(control(open, "Execution mode"), {
            target: { value: mode },
          });
        },
        setRunMode: (mode) => {
          fireEvent.change(control(open, "Run mode"), {
            target: { value: mode },
          });
        },
        setMaxConcurrency: (value) => {
          fireEvent.change(control(open, "Max concurrency"), {
            target: { value },
          });
        },
        pickCodeDefault: (which) => {
          const line = open.querySelector(
            `[data-testid="config-source-${which}"]`,
          ) as HTMLElement | null;
          if (!line) {
            throw new Error(`no config-source-${which}`);
          }
          fireEvent.click(
            within(line).getByRole("button", { name: "Use the code default" }),
          );
        },
        save: () => submit(open, "Save settings"),
        reset: () => submit(open, "Reset to code defaults"),
        cancel: async () => {
          fireEvent.click(button(open, "Cancel")!);
          await waitFor(() => {
            if (openDialog() !== null) {
              throw new Error("still open");
            }
          });
        },
      };
    },
    refresh: async () => {
      await act(async () => {
        await rendered.queryClient.invalidateQueries();
      });
    },
    unmount: () => rendered.unmount(),
  };
}
