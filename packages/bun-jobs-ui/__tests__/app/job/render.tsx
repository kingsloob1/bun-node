import type { ReactNode } from "react";
import type { JobDto, MetaDto, Permissions } from "../../../app/api/types";
import type { MockHandler, MockReply } from "../mockFetch";
import { createApiClient } from "../../../app/api/client";
import { jobScreenPath } from "../../../app/api/jobs";
import { AppProviders } from "../../../app/providers";
import { createQueryClient } from "../../../app/queryClient";
import { act, page, render, visit } from "../dom";
import { uiConfig } from "../fixtures";
import { mockFetch } from "../mockFetch";
import { renderApp } from "../renderApp";
import { allPermissions, jobApiPath, jobMeta } from "./fixtures";

/** Options of the job test renderers. */
export interface JobRenderOptions {
  /** `/meta`. Defaults to {@link jobMeta}. */
  meta?: MetaDto;
  /** `/meta/permissions`. Defaults to {@link allPermissions}. */
  permissions?: Permissions;
  /** More route handlers, merged over the defaults. */
  handlers?: Record<string, MockHandler | MockReply>;
}

/** The bootstrap handlers for `options`. */
function metaHandlers(options: JobRenderOptions) {
  return {
    "GET /meta": { body: options.meta ?? jobMeta() },
    "GET /meta/permissions": { body: options.permissions ?? allPermissions() },
  };
}

/**
 * Renders the whole app on a job's screen, answering `GET` of that job with
 * `job` (at its percent-encoded path, so a wrongly encoded request misses).
 */
export async function renderJobScreen(
  job: JobDto | MockHandler | MockReply,
  options: JobRenderOptions & {
    /** The job's id, when `job` is a handler. Defaults to the fixture id. */
    id?: string;
    /** The job's queue, when `job` is a handler. Defaults to `emails`. */
    queue?: string;
    /** Wait for the screen to render. Defaults to `true`; turn off under fake timers. */
    wait?: boolean;
  } = {},
) {
  const id = options.id ?? (isJob(job) ? job.id : "welcome/42 a");
  const queue = options.queue ?? (isJob(job) ? job.queue : "emails");
  visit(`/jobs${jobScreenPath(queue, id)}`);
  const result = renderApp({
    handlers: {
      ...metaHandlers(options),
      [`GET ${jobApiPath(id, queue)}`]: isJob(job) ? { body: job } : job,
      ...options.handlers,
    },
  });
  if (options.wait !== false) {
    await page().findByTestId(/job-(screen|not-found)/);
  }
  return result;
}

/** Whether a value is a job fixture (rather than a handler or reply). */
function isJob(value: unknown): value is JobDto {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    "queue" in value
  );
}

/** Renders `element` under the app's providers (no screens), once meta has loaded. */
export async function renderWithProviders(
  element: ReactNode,
  options: JobRenderOptions = {},
) {
  const config = uiConfig();
  const mock = mockFetch({ ...metaHandlers(options), ...options.handlers });
  const client = createApiClient(config, { fetch: mock.fetch });
  const queryClient = createQueryClient({ retry: false });
  const result = render(
    <AppProviders
      config={config}
      client={client}
      queryClient={queryClient}
    >
      <div data-testid="providers-ready">{element}</div>
    </AppProviders>,
  );
  await page().findByTestId("providers-ready");
  return { ...result, calls: mock.calls, queryClient };
}

/** TanStack batches observer notifications on a timer; this lets them land inside `act`. */
export async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Text of the polite (success/info) and assertive (error) toast regions. */
export function toastText() {
  return {
    polite:
      document.querySelector('.toast-viewport [aria-live="polite"]')
        ?.textContent ?? "",
    assertive:
      document.querySelector('.toast-viewport [aria-live="assertive"]')
        ?.textContent ?? "",
  };
}
