import type { FetchLike } from "../../../app/api/client";
import { createApiClient } from "../../../app/api/client";
import { PermissionScope } from "../../../app/meta/PermissionScope";
import { AppProviders } from "../../../app/providers";
import { createQueryClient } from "../../../app/queryClient";
import { fireEvent, page, render, waitFor, within } from "../dom";
import { uiConfig } from "../fixtures";
import { WorkersHarness } from "./realApiHarness";

/**
 * Drives one worker's row — {@link WorkerTable} and the `WorkerActions` in its
 * last cell — for `pkg/worker-actions.integration.test.ts`, which runs it
 * against a REAL `createJobsApi` and a real `BunQueueWorker`. That test
 * compiles without the DOM lib, so everything touching the DOM lives here and
 * the test loads it by a dynamic import.
 *
 * Every method returns what the user is actually shown — the state badge, the
 * toast's text — rather than waiting for the wording the test hopes for, so a
 * wrong message fails on its content instead of timing out.
 */

/** One lifecycle button the row offers. */
export type LifecycleButton = "Pause" | "Resume" | "Start";

/** What the test can do with one worker's row. */
export interface WorkerRowDriver {
  /** The state its badge reads now (`Running`, `Paused`, `Stopped`, …), or `""` while the row is absent. */
  state: () => string;
  /** Resolves once the badge reads `label`, failing with what it read instead. */
  awaitState: (label: string) => Promise<void>;
  /** Whether the row offers a button with this accessible name right now. */
  offers: (name: string) => boolean;
  /** Resolves once the row offers a button with this name. */
  awaitButton: (name: string) => Promise<void>;
  /** The hint saying why no lifecycle action is offered (`worker-blocked-<id>`), or `null` when the row shows none. */
  blockedHint: () => string | null;
  /** Clicks a lifecycle button; resolves the success toast it raised. */
  lifecycle: (name: LifecycleButton) => Promise<string>;
  /** Clicks a lifecycle button expected to be refused; resolves the error toast's whole text (headline and explanation). */
  refuse: (name: LifecycleButton) => Promise<string>;
  /** Stops through the Stop… dialog; resolves the success toast it raised. */
  stop: () => Promise<string>;
  /** Opens Settings…, types `value` into `setting` and saves; resolves the success toast it raised. */
  configure: (setting: string, value: number) => Promise<string>;
  /** Opens Settings… and presses "Reset to code values"; resolves the success toast it raised. */
  resetConfig: () => Promise<string>;
  /** Opens Settings… and resolves the dialog's whole text, then closes it again. */
  settingsText: () => Promise<string>;
}

/** The success toasts, newest last. */
function notifications(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      'ol[aria-label="Notifications"] > li',
    ),
  ];
}

/** The error toasts, newest last. */
function errors(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>('ol[aria-label="Errors"] > li'),
  ];
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

/**
 * Renders the row for the worker `id` on `queue` over `fetch`, and returns a
 * driver for it. `pollMs` is how often `GET /workers` is re-read, so the row
 * follows the live worker without the test refreshing it by hand.
 */
export async function mountWorkerRow(
  queue: string,
  id: string,
  fetch: FetchLike,
  csrfHeader: string,
  pollMs = 150,
): Promise<WorkerRowDriver> {
  const config = uiConfig({ csrfHeader });
  const client = createApiClient(config, { fetch });
  render(
    <AppProviders
      config={config}
      client={client}
      queryClient={createQueryClient({ retry: false })}
    >
      <PermissionScope target={{ queue }}>
        <WorkersHarness
          queue={queue}
          pollMs={pollMs}
        />
      </PermissionScope>
    </AppProviders>,
  );
  await page().findByTestId("worker-actions-host", {}, { timeout: 10_000 });

  /** The row, once the listing carries this worker. */
  const row = async (): Promise<HTMLElement> =>
    page().findByTestId(`worker-row-${id}`, {}, { timeout: 10_000 });

  /** The row now, or `null` while the listing has not carried it yet. */
  const rowNow = (): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-testid="worker-row-${id}"]`);

  /** The action group of the row. */
  const group = async (): Promise<HTMLElement> =>
    within(await row()).findByRole(
      "group",
      { name: `Actions for worker ${id}` },
      { timeout: 10_000 },
    );

  const state = (): string =>
    rowNow()?.querySelectorAll("td")[0]?.textContent?.trim() ?? "";

  const offers = (name: string): boolean => {
    const here = rowNow();
    return here === null
      ? false
      : within(here).queryByRole("button", { name }) !== null;
  };

  const awaitButton = async (name: string): Promise<void> => {
    await waitFor(
      () => {
        if (!offers(name)) {
          throw new Error(
            `no "${name}" button on ${id}; it is ${state() || "not listed"}`,
          );
        }
      },
      { timeout: 10_000 },
    );
  };

  /** Clicks `name` and resolves the text of the toast it raised, from `list`. */
  const clickFor = async (
    name: LifecycleButton,
    list: () => HTMLElement[],
  ): Promise<string> => {
    await awaitButton(name);
    const before = list().length;
    fireEvent.click(within(await group()).getByRole("button", { name }));
    await waitFor(
      () => {
        if (list().length <= before) {
          throw new Error(`no toast after ${name} on ${id}`);
        }
      },
      { timeout: 10_000 },
    );
    return list().at(-1)?.textContent ?? "";
  };

  /** Opens Settings… and returns its dialog. */
  const openSettings = async (): Promise<HTMLElement> => {
    await awaitButton("Settings…");
    fireEvent.click(
      within(await group()).getByRole("button", { name: "Settings…" }),
    );
    return dialog();
  };

  /** Presses `name` in the settings dialog and resolves the toast it raised. */
  const saveWith = async (open: HTMLElement, name: string): Promise<string> => {
    const before = notifications().length;
    fireEvent.click(within(open).getByRole("button", { name }));
    await waitFor(
      () => {
        const problem = open.querySelector(".problem-banner")?.textContent;
        if (problem) {
          throw new Error(`the dialog showed a problem: ${problem}`);
        }
        if (notifications().length <= before) {
          throw new Error(`no toast after "${name}" on ${id}`);
        }
      },
      { timeout: 10_000 },
    );
    return notifications().at(-1)?.textContent ?? "";
  };

  return {
    state,
    awaitState: async (label) => {
      await waitFor(
        () => {
          if (!state().startsWith(label)) {
            throw new Error(`${id} reads "${state()}", not "${label}"`);
          }
        },
        { timeout: 10_000 },
      );
    },
    offers,
    awaitButton,
    blockedHint: () => {
      const hint = rowNow()?.querySelector(
        `[data-testid="worker-blocked-${id}"]`,
      );
      return hint?.textContent ?? null;
    },
    lifecycle: (name) => clickFor(name, notifications),
    refuse: (name) => clickFor(name, errors),
    stop: async () => {
      await awaitButton("Stop…");
      fireEvent.click(
        within(await group()).getByRole("button", { name: "Stop…" }),
      );
      const open = await dialog();
      const before = notifications().length;
      fireEvent.click(
        within(open).getByRole("button", { name: "Stop worker" }),
      );
      await waitFor(
        () => {
          if (notifications().length <= before) {
            throw new Error(`no toast after stopping ${id}`);
          }
        },
        { timeout: 10_000 },
      );
      return notifications().at(-1)?.textContent ?? "";
    },
    configure: async (setting, value) => {
      const open = await openSettings();
      fireEvent.change(within(open).getByLabelText(new RegExp(`^${setting}`)), {
        target: { value: String(value) },
      });
      return saveWith(open, "Save settings");
    },
    resetConfig: async () => {
      const open = await openSettings();
      return saveWith(open, "Reset to code values");
    },
    settingsText: async () => {
      const open = await openSettings();
      const text = open.textContent ?? "";
      fireEvent.click(within(open).getByRole("button", { name: "Cancel" }));
      return text;
    },
  };
}
