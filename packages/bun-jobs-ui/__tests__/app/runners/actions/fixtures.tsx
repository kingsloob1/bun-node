import type { QueryKey } from "@tanstack/react-query";
import type {
  MetaDto,
  Permissions,
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
export function remoteRunner(
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
