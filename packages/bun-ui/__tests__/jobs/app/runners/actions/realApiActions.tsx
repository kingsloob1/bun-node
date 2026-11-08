import type { FetchLike } from "../../../../app/api/client";
import { createApiClient } from "../../../../app/api/client";
import { PermissionScope } from "../../../../app/meta/PermissionScope";
import { AppProviders } from "../../../../app/providers";
import { createQueryClient } from "../../../../app/queryClient";
import { fireEvent, page, render, waitFor, within } from "../../dom";
import { uiConfig } from "../../fixtures";
import { RunnerHarness } from "./realApiHarness";

/**
 * Drives {@link RunnerActions} for `pkg/runner-actions.integration.test.ts`,
 * which runs it against a REAL `createJobsApi`. That test compiles without
 * the DOM lib, so everything touching the DOM lives here and the test loads
 * it by a dynamic import. The actions get the runner from
 * `GET /runners/:runner` (refetched after each write, as the runner screen
 * does), so a button that flips (Pause → Resume…) shows the API's state.
 */

/** What the test can do with the mounted actions. */
export interface RunnerActionsDriver {
  /** Clicks Pause and waits for Resume… to replace it. */
  pause: () => Promise<void>;
  /** Resumes through the dialog and waits for Pause to come back. */
  resume: () => Promise<void>;
  /** Triggers through the dialog; resolves the toast's text. */
  trigger: () => Promise<string>;
  /** Reschedules to every `hours` hours; resolves the toast's text. */
  rescheduleEveryHours: (hours: number) => Promise<string>;
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

/** The action group. */
function group(): HTMLElement {
  return page().getByRole("group", { name: "Runner actions" });
}

/** Waits for a dialog and returns it. */
async function dialog(): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = document.querySelector<HTMLElement>("dialog[open]");
    if (!found) {
      throw new Error("no dialog");
    }
  });
  return found!;
}

/** Waits for a toast containing `text`, failing fast on an error toast. */
async function toast(text: string): Promise<string> {
  await waitFor(
    () => {
      if (errorText()) {
        throw new Error(`error toast: ${errorText()}`);
      }
      if (!toastText().includes(text)) {
        throw new Error(`no "${text}" toast yet`);
      }
    },
    { timeout: 5_000 },
  );
  return toastText();
}

/** Renders the actions for `runner` over `fetch` and returns a driver. */
export async function mountRunnerActions(
  runner: string,
  fetch: FetchLike,
  csrfHeader: string,
): Promise<RunnerActionsDriver> {
  const config = uiConfig({ csrfHeader });
  const client = createApiClient(config, { fetch });
  render(
    <AppProviders
      config={config}
      client={client}
      queryClient={createQueryClient({ retry: false })}
    >
      <PermissionScope target={{ runner }}>
        <RunnerHarness runner={runner} />
      </PermissionScope>
    </AppProviders>,
  );
  await page().findByTestId("runner-actions-host", {}, { timeout: 5_000 });
  return {
    pause: async () => {
      fireEvent.click(
        await within(group()).findByRole("button", { name: "Pause" }),
      );
      await within(group()).findByRole(
        "button",
        { name: "Resume…" },
        { timeout: 5_000 },
      );
    },
    resume: async () => {
      fireEvent.click(within(group()).getByRole("button", { name: "Resume…" }));
      const open = await dialog();
      fireEvent.click(within(open).getByRole("button", { name: "Resume" }));
      await within(group()).findByRole(
        "button",
        { name: "Pause" },
        { timeout: 5_000 },
      );
    },
    trigger: async () => {
      fireEvent.click(
        within(group()).getByRole("button", { name: "Trigger…" }),
      );
      const open = await dialog();
      fireEvent.click(within(open).getByRole("button", { name: "Trigger" }));
      return toast(`on ${runner}`);
    },
    rescheduleEveryHours: async (hours) => {
      fireEvent.click(
        within(group()).getByRole("button", { name: "Reschedule…" }),
      );
      const open = await dialog();
      fireEvent.click(within(open).getByLabelText("Every"));
      fireEvent.change(within(open).getByLabelText(/^Interval/), {
        target: { value: String(hours) },
      });
      fireEvent.change(within(open).getByLabelText("Unit"), {
        target: { value: "hours" },
      });
      fireEvent.click(
        within(open).getByRole("button", { name: "Save schedule" }),
      );
      return toast(`Rescheduled ${runner}`);
    },
  };
}
