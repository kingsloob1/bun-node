import type { ReactNode } from "react";
import type {
  AddJobInput,
  JobScreenView,
  JobUiHarness,
  JobUiHarnessOptions,
} from "./integrationSteps";
import { expect } from "bun:test";
import { createApiClient } from "../../../app/api/client";
import { jobScreenPath } from "../../../app/api/jobs";
import { App } from "../../../app/App";
import { AppProviders } from "../../../app/providers";
import { createQueryClient } from "../../../app/queryClient";
import { AddJobDialog } from "../../../app/screens/job";
import {
  act,
  cleanup,
  fireEvent,
  page,
  render,
  setupDom,
  visit,
  waitFor,
  within,
} from "../dom";
import { uiConfig } from "../fixtures";

/**
 * The DOM side of `pkg/job.integration.test.ts`: renders the real app
 * against the `fetch` it is given and drives it like a user. See
 * `integrationSteps.ts` for why it is loaded at run time.
 */

/** How long a step may wait for the real API and React. */
const STEP_TIMEOUT_MS = 3_000;

/** See `JobUiHarnessModule.installDom`. */
export const installDom = setupDom;

/** Matches a label with or without its required marker. */
function labelled(label: string): RegExp {
  return new RegExp(`^${label}(\\s*\\*)?$`);
}

/** Reads the job screen. */
async function readJobScreen(): Promise<JobScreenView> {
  const heading = await page().findByRole(
    "heading",
    { level: 1 },
    { timeout: STEP_TIMEOUT_MS },
  );
  const rows = Array.from(document.querySelectorAll(".job-summary .kv-row"));
  const row = rows.find(
    (candidate) => candidate.querySelector("dt")?.textContent === "Priority",
  );
  const priority = row?.querySelector("dd")?.textContent;
  return {
    heading: heading.textContent ?? "",
    id: page().getByTestId("job-id").textContent ?? "",
    priority: priority ?? "",
  };
}

/** Clicks a job action and confirms it in its dialog. */
async function confirmAction(action: string, role: "dialog" | "alertdialog") {
  fireEvent.click(
    within(page().getByRole("group", { name: "Job actions" })).getByRole(
      "button",
      { name: action },
    ),
  );
  const dialog = await page().findByRole(role);
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: action }));
  });
  await waitFor(() => expect(page().queryByRole(role)).toBeNull(), {
    timeout: STEP_TIMEOUT_MS,
  });
}

/** Builds the harness. */
export function createJobUiHarness({
  fetch,
  csrfHeader,
}: JobUiHarnessOptions): JobUiHarness {
  const config = uiConfig({ csrfHeader });

  /** Renders `element` under fresh providers. */
  const mount = (element: ReactNode) => {
    cleanup();
    render(
      <AppProviders
        config={config}
        client={createApiClient(config, { fetch })}
        queryClient={createQueryClient({ retry: false })}
      >
        {element}
      </AppProviders>,
    );
  };

  return {
    async addJob({ queue, name, data, jobId }: AddJobInput) {
      let closed = false;
      mount(
        <AddJobDialog
          queue={queue}
          open
          onClose={() => {
            closed = true;
          }}
        />,
      );
      const dialog = await page().findByRole(
        "dialog",
        {},
        { timeout: STEP_TIMEOUT_MS },
      );
      const nameControl = within(dialog).getByLabelText(labelled("Name"));
      fireEvent.change(nameControl, { target: { value: name } });
      fireEvent.change(within(dialog).getByLabelText(labelled("Data")), {
        target: { value: data },
      });
      if (jobId !== undefined) {
        fireEvent.change(within(dialog).getByLabelText("Job id"), {
          target: { value: jobId },
        });
      }
      await act(async () => {
        fireEvent.click(
          within(dialog).getByRole("button", { name: "Add job" }),
        );
      });
      await waitFor(() => expect(closed).toBe(true), {
        timeout: STEP_TIMEOUT_MS,
      });
      const toasts = document.querySelector(
        '.toast-viewport [aria-live="polite"]',
      );
      return toasts?.textContent ?? "";
    },

    async openJob(queue, id) {
      visit(`/jobs${jobScreenPath(queue, id)}`);
      mount(<App />);
      return await readJobScreen();
    },

    async updatePriority(priority) {
      fireEvent.click(page().getByRole("button", { name: "Edit" }));
      const dialog = await page().findByRole("dialog", { name: "Edit job" });
      fireEvent.change(within(dialog).getByLabelText("Priority"), {
        target: { value: String(priority) },
      });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
      });
      await waitFor(() => expect(page().queryByRole("dialog")).toBeNull(), {
        timeout: STEP_TIMEOUT_MS,
      });
      await waitFor(
        async () =>
          expect((await readJobScreen()).priority).toBe(String(priority)),
        { timeout: STEP_TIMEOUT_MS },
      );
      return await readJobScreen();
    },

    async retry() {
      await confirmAction("Retry", "dialog");
    },

    async remove() {
      const before = window.location.pathname;
      await confirmAction("Remove", "alertdialog");
      await waitFor(() => expect(window.location.pathname).not.toBe(before), {
        timeout: STEP_TIMEOUT_MS,
      });
      return window.location.pathname;
    },

    cleanup: () => cleanup(),
  };
}
