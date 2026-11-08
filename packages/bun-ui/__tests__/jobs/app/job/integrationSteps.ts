import type { FetchLike } from "../../../app/api/client";

/**
 * The steps `pkg/job.integration.test.ts` drives through the real UI. This
 * file is DOM-free on purpose: the pkg project compiles without the DOM lib,
 * so it may import this interface but not the TSX harness implementing it
 * (`integrationHarness.tsx`), which it loads at run time instead.
 */

/** What the add-job step fills in. */
export interface AddJobInput {
  /** The queue to add to. */
  queue: string;
  /** The job name to pick. */
  name: string;
  /** The data, as JSON text. */
  data: string;
  /** A caller-chosen id. */
  jobId?: string;
}

/** What the job screen showed. */
export interface JobScreenView {
  /** The heading: the job's name and state. */
  heading: string;
  /** The id shown. */
  id: string;
  /** The Priority summary row. */
  priority: string;
}

/** The UI, driven step by step against whatever `fetch` it was given. */
export interface JobUiHarness {
  /** Opens the add-job dialog, fills it and submits; resolves the toast's text once the dialog closed. */
  addJob: (input: AddJobInput) => Promise<string>;
  /** Renders the app on a job's screen; resolves what it shows. */
  openJob: (queue: string, id: string) => Promise<JobScreenView>;
  /** On the open job screen: Edit → priority → Save; resolves the refreshed view. */
  updatePriority: (priority: number) => Promise<JobScreenView>;
  /** On the open job screen: Retry → confirm (reset attempts left ticked). */
  retry: () => Promise<void>;
  /** On the open job screen: Remove → confirm; resolves the path it navigated to. */
  remove: () => Promise<string>;
  /** On the open job screen: Fail… → reason → the typed confirmation → confirm; resolves the success toast's text. */
  fail: (reason: string, typed: string) => Promise<string>;
  /**
   * Renders the queue's repeatables panel and clicks the series' Disable or
   * Enable; resolves once the list shows the series in its new state.
   */
  toggleRepeatable: (
    queue: string,
    key: string,
    to: "disable" | "enable",
  ) => Promise<void>;
  /** Unmounts whatever is rendered. */
  cleanup: () => void;
}

/** Options of {@link CreateJobUiHarness}. */
export interface JobUiHarnessOptions {
  /** The `fetch` the app's client uses, e.g. a shim into a real API. */
  fetch: FetchLike;
  /** The CSRF header the API requires, or `null`. */
  csrfHeader: string | null;
}

/** Builds a {@link JobUiHarness}. */
export type CreateJobUiHarness = (options: JobUiHarnessOptions) => JobUiHarness;

/** What `integrationHarness.tsx` exports. */
export interface JobUiHarnessModule {
  /** Installs the DOM for the calling test file (its `setupDom`); call at the file's top level. */
  installDom: () => void;
  /** See {@link CreateJobUiHarness}. */
  createJobUiHarness: CreateJobUiHarness;
}
