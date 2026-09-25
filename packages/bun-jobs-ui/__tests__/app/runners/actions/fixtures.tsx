import type { QueryKey } from "@tanstack/react-query";
import type {
  MetaDto,
  Permissions,
  RunnerHistoryDto,
  RunnerInfoDto,
  RunRecordDto,
} from "../../../../app/api/types";
import type { MockHandler, MockReply, RecordedCall } from "../../mockFetch";
import { expect } from "bun:test";
import { createApiClient } from "../../../../app/api/client";
import { PermissionScope } from "../../../../app/meta/PermissionScope";
import { AppProviders } from "../../../../app/providers";
import { createQueryClient } from "../../../../app/queryClient";
import { RunnerActions } from "../../../../app/screens/runners/actions";
import { RunnerHistory } from "../../../../app/screens/runners/RunnerHistory";
import { fireEvent, page, render, waitFor, within } from "../../dom";
import { metaFixture, permissionsFixture, uiConfig } from "../../fixtures";
import { mockFetch } from "../../mockFetch";

/**
 * Renders {@link RunnerActions} alone, inside the app's providers and a
 * runner-scoped `PermissionScope`, as the runner screen mounts it. The
 * runner is a prop, so every state (paused, remote, running) is one fixture
 * away; `/meta/permissions?runner=` answers `scoped`, the untargeted one
 * `permissions`.
 */

/** A fixed "now" for timestamps. */
export const NOW = 1_789_730_520_000;

/** One active run. */
export function runFixture(
  overrides: Partial<RunRecordDto> = {},
): RunRecordDto {
  return {
    runId: "run-1",
    runnerId: "nightly",
    attempt: 1,
    source: "manual",
    mode: "worker",
    startedAt: NOW - 5_000,
    status: "running",
    ...overrides,
  };
}

/** `GET /runners/nightly/history` with one finished run: something to clear. */
export function finishedHistory(): RunnerHistoryDto {
  return {
    items: [
      runFixture({
        runId: "run-0",
        startedAt: NOW - 60_000,
        finishedAt: NOW - 50_000,
        durationMs: 10_000,
        status: "success",
      }),
    ],
    page: { offset: 0, limit: 50, total: 1, hasMore: false },
  };
}

/** A local, idle, cron-scheduled runner. */
export function runnerFixture(
  overrides: Partial<RunnerInfoDto> = {},
): RunnerInfoDto {
  return {
    id: "nightly",
    namespace: "shop",
    isLocal: true,
    name: "Nightly report",
    schedule: { cron: "0 3 * * *", tz: "UTC" },
    nextRunAt: NOW + 3_600_000,
    isPaused: false,
    isRunning: false,
    queuedTriggers: 0,
    stats: {
      success: 3,
      failed: 1,
      timeout: 0,
      killed: 0,
      skipped: 0,
      queued: 0,
      total: 4,
    },
    local: { status: "running", activeRuns: [], nextRunAt: NOW + 3_600_000 },
    ...overrides,
  };
}

/** A local runner with runs in flight here. */
export function runningRunner(
  runs: RunRecordDto[] = [runFixture()],
): RunnerInfoDto {
  return runnerFixture({
    isRunning: true,
    local: { status: "running", activeRuns: runs, nextRunAt: null },
  });
}

/** A runner registered only by another process. */
export function nonLocalRunner(
  overrides: Partial<RunnerInfoDto> = {},
): RunnerInfoDto {
  const { local: _local, ...rest } = runnerFixture({
    isLocal: false,
    isRunning: true,
    ...overrides,
  });
  return rest;
}

/** Options of {@link renderActions}. */
export interface RenderActionsOptions {
  /** The runner. Defaults to {@link runnerFixture}. */
  runner?: RunnerInfoDto;
  /** `GET /meta` overrides. */
  meta?: Partial<MetaDto>;
  /** The untargeted permission overrides. */
  permissions?: Permissions["actions"];
  /** The runner-scoped permission overrides (applied over `permissions`). */
  scoped?: Permissions["actions"];
  /** Extra handlers. */
  handlers?: Record<string, MockHandler | MockReply>;
  /**
   * When set, the History card is rendered too (as the runner screen mounts
   * it, with the runner as its `info`), `GET /runners/:runner/history`
   * answering this, and the render waits for it to load. That card is where
   * Clear history… lives. Absent, only the header actions render.
   */
  history?: RunnerHistoryDto;
}

/** Renders the actions and waits for the scoped permissions to apply. */
export async function renderActions(options: RenderActionsOptions = {}) {
  const runner = options.runner ?? runnerFixture();
  const config = uiConfig();
  const mock = mockFetch({
    "GET /meta": { body: metaFixture({ mode: "runner", ...options.meta }) },
    "GET /meta/permissions": (call) => ({
      body: permissionsFixture({
        ...options.permissions,
        ...(call.query.get("runner") === runner.id ? options.scoped : {}),
      }),
    }),
    ...(options.history
      ? {
          [`GET /runners/${encodeURIComponent(runner.id)}/history`]: {
            body: options.history,
          },
        }
      : {}),
    ...options.handlers,
  });
  const client = createApiClient(config, { fetch: mock.fetch });
  const queryClient = createQueryClient({ retry: false });
  const invalidated: QueryKey[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters, opts) => {
    if (filters?.queryKey) {
      invalidated.push(filters.queryKey);
    }
    return original(filters, opts);
  }) as typeof queryClient.invalidateQueries;
  const result = render(
    <AppProviders
      config={config}
      client={client}
      queryClient={queryClient}
    >
      <PermissionScope target={{ runner: runner.id }}>
        <div data-testid="host">
          <RunnerActions runner={runner} />
          {options.history && (
            <RunnerHistory
              runner={runner.id}
              info={runner}
            />
          )}
        </div>
      </PermissionScope>
    </AppProviders>,
  );
  await page().findByTestId("host");
  // Let the scoped permissions query answer.
  await waitFor(() =>
    expect(
      mock.calls.some(
        (call) =>
          call.path === "/meta/permissions" &&
          call.query.get("runner") === runner.id,
      ),
    ).toBe(true),
  );
  if (options.history) {
    // The history has answered: its rows, or its empty state, are in.
    await waitFor(() => {
      const card = historyCard();
      expect(
        card.querySelector('tr[data-testid^="history-row-"]') !== null ||
          within(card).queryByText("No runs yet") !== null,
      ).toBe(true);
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { ...result, calls: mock.calls, queryClient, invalidated, runner };
}

/** The action group, or `null` when nothing is offered. */
export function actionGroup(): HTMLElement | null {
  return page().queryByRole("group", { name: "Runner actions" });
}

/** The button named `name` in the action group (throws when absent). */
export function actionButton(name: string): HTMLButtonElement {
  return within(actionGroup()!).getByRole("button", {
    name,
  }) as HTMLButtonElement;
}

/** The names of the action group's buttons. */
export function actionNames(): string[] {
  const group = actionGroup();
  if (!group) {
    return [];
  }
  return within(group)
    .queryAllByRole("button")
    .map((button) => button.textContent ?? "");
}

/** The runner screen's History card (a region named "History"; throws when absent). */
export function historyCard(): HTMLElement {
  return page().getByRole("region", { name: "History" });
}

/** The History card's "Clear history…" button, or `null` when it is not offered. */
export function clearHistoryButton(): HTMLButtonElement | null {
  return within(historyCard()).queryByRole("button", {
    name: "Clear history…",
  }) as HTMLButtonElement | null;
}

/** Opens Clear history…'s dialog from the History card, where it lives. */
export async function openClearHistory(): Promise<HTMLElement> {
  const button = clearHistoryButton();
  if (!button) {
    throw new Error("Clear history… is not offered in the History card");
  }
  fireEvent.click(button);
  return findDialog();
}

/** The one call to a path. */
export function callTo(
  calls: RecordedCall[],
  method: string,
  path: string,
): RecordedCall | undefined {
  return calls.find((call) => call.method === method && call.path === path);
}

/** The toast region for successes/info. */
export function notifications(): HTMLElement {
  return document.querySelector<HTMLElement>('ol[aria-label="Notifications"]')!;
}

/** The toast region for errors. */
export function errorToasts(): HTMLElement {
  return document.querySelector<HTMLElement>('ol[aria-label="Errors"]')!;
}

/** The open dialog, if any. */
export function openDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>("dialog[open]");
}

/** Waits for a dialog to open and returns it. */
export async function findDialog(): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = openDialog();
    if (!found) {
      throw new Error("no open dialog");
    }
  });
  return found!;
}

/** Opens the dialog behind the action button `name`. */
export async function openAction(name: string): Promise<HTMLElement> {
  fireEvent.click(actionButton(name));
  return findDialog();
}

/** A dialog's button by name. */
export function dialogButton(
  dialog: HTMLElement,
  name: string,
): HTMLButtonElement {
  return within(dialog).getByRole("button", { name }) as HTMLButtonElement;
}

/** Types into a dialog's typed confirmation. */
export function typeConfirmation(dialog: HTMLElement, text: string): void {
  fireEvent.change(within(dialog).getByLabelText(/to confirm/), {
    target: { value: text },
  });
}

/** Waits for the success/info region to contain `text`. */
export async function toastSays(text: string): Promise<void> {
  await waitFor(() => expect(notifications().textContent).toContain(text));
}
