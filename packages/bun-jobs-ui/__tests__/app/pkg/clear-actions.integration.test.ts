import type {
  BunQueueWorker,
  BunRunner,
  JobsDriver,
} from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  FileDriver,
  JOBS_API_ACTIONS,
  MemoryDriver,
  SqlDriver,
} from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GATES } from "./fixtures/clear-actions/gated-runner";

/**
 * The two clear actions against a REAL `createJobsApi`, over real workers and
 * real runners doing real work: the job screen's "Clear logs…"
 * (`DELETE /queues/:queue/jobs/:id/logs`) and the runner screen's "Clear
 * history…" (`DELETE /runners/:runner/history`). Both were built against
 * mocked HTTP; this proves they send what the API expects and read back what
 * it answers.
 *
 * Each deployment — memory, a file store and SQLite, in a temp dir — has two
 * contexts sharing ONE driver: `api`, whose process serves the API and runs
 * the worker and a local runner, and `remote`, which runs a second runner the
 * API's context knows only through the store. The worker's jobs:
 *
 * - `logged` logs {@link LOGGED_LINES} lines and completes;
 * - `held` logs two lines, then stays active until its test releases it;
 * - `silent` logs nothing and completes;
 * - `gated` logs three lines and completes (the permission scenario's).
 *
 * The local runner finishes three runs and holds a fourth in progress; the
 * remote one finishes two and holds a third.
 *
 * Compiled without the DOM lib (see tsconfig.json): the DOM side is loaded by
 * dynamic imports the compiler does not follow, and the interfaces below
 * restate the little this file uses of them. Each scenario owns its job or
 * runner, so the suite passes under `bun test --randomize`.
 */

/** What this file uses of `../dom`. */
interface DomModule {
  /** Registers happy-dom and the per-test cleanup. */
  setupDom: () => void;
}

/** What this file uses of `../register-dom`. */
interface RegisterDomModule {
  /** Bun's own networking globals, captured before happy-dom replaced them. */
  native: { Request: typeof Request; Response: typeof Response };
}

/** What the job screen's Logs card shows (`../job/realApiClearLogs`' `ClearLogsView`). */
interface ClearLogsView {
  /** "Clear logs…": absent, or present and enabled or disabled. */
  button: "absent" | "enabled" | "disabled";
  /** The reason shown beside a disabled button, or `null`. */
  reason: string | null;
  /** The "N lines in all" count, or `null` while the logs load. */
  total: number | null;
  /** The log lines on screen, as `[gutter number, text]`. */
  lines: [number, string][];
  /** Whether "No log lines yet." is shown. */
  empty: boolean;
}

/** What this file uses of `../job/realApiClearLogs`. */
interface ClearLogsModule {
  /** Renders the app on a job's screen. */
  mountJobLogs: (
    fetch: FetchLike,
    csrfHeader: string,
    queue: string,
    id: string,
  ) => Promise<{
    view: () => ClearLogsView;
    awaitView: (
      ready: (view: ClearLogsView) => boolean,
      timeoutMs?: number,
    ) => Promise<ClearLogsView>;
    clear: () => Promise<{ confirmation: string; toast: string }>;
    unmount: () => void;
  }>;
}

/** What the runner screen shows (`../runners/realApiClearHistory`' `ClearHistoryView`). */
interface ClearHistoryView {
  /** Whether "Clear history…" is offered anywhere on the screen. */
  offered: boolean;
  /** Whether it is in the History card's header, where it lives. */
  inHistoryCard: boolean;
  /** Whether it is in the "Runner actions" group (never, since it moved). */
  inActionGroup: boolean;
  /** Whether the "Runner actions" group is rendered at all. */
  hasActionGroup: boolean;
  /** Whether the History card is rendered at all. */
  hasHistoryCard: boolean;
  /** The "registered in another process" hint's text, or `null`. */
  nonLocalHint: string | null;
  /** The history rows' run ids, newest first. */
  history: string[];
  /** Whether "No runs yet" is shown. */
  empty: boolean;
  /** The stat tiles, label to value. */
  stats: Record<string, string>;
}

/** What this file uses of `../runners/realApiClearHistory`. */
interface ClearHistoryModule {
  /** Renders the app on a runner's screen. */
  mountRunnerHistory: (
    fetch: FetchLike,
    csrfHeader: string,
    id: string,
  ) => Promise<{
    view: () => ClearHistoryView;
    awaitView: (
      ready: (view: ClearHistoryView) => boolean,
      timeoutMs?: number,
    ) => Promise<ClearHistoryView>;
    clear: () => Promise<{ dialog: string; toast: string }>;
    unmount: () => void;
  }>;
}

/** One request made through a deployment's fetch, with what the API answered. */
interface Exchange {
  /** The method. */
  method: string;
  /** The path under the API's base, without the query. */
  path: string;
  /** The query string, without the `?`. */
  query: string;
  /** The CSRF header's value, or `null` when it was not sent. */
  csrf: string | null;
  /** The request body as sent, or `undefined` when there was none. */
  body: string | undefined;
  /** The status the API answered with. */
  status: number;
  /** The parsed answer, for a JSON body. */
  json: unknown;
  /** Whether the test made it directly, rather than the UI. */
  direct: boolean;
  /** Which API answered: the full one, or the one without the clear actions. */
  api: "full" | "restricted";
}

/** What a job asks the worker to do. */
interface JobData {
  /** How many lines to log first. */
  lines?: number;
  /** The gate to wait on after logging, keeping the job active. */
  hold?: string;
}

/** One deployment under test. */
interface Deployment {
  /** How it is named in the test titles. */
  label: string;
  /** The context serving the API, running the worker and the local runner. */
  api: BunJobs;
  /** The context running the remote runner, sharing `api`'s driver. */
  remote: BunJobs;
  /** The fetch into the API with every default action. */
  fetch: FetchLike;
  /** The fetch into an API whose `actions` leave out both clear actions. */
  restricted: FetchLike;
  /** Every request made through either fetch, oldest first. */
  exchanges: Exchange[];
  /** The worker on {@link QUEUE}. */
  worker: BunQueueWorker<JobData, string>;
  /** The runner registered in `api`. */
  local: BunRunner;
  /** The runner registered in `remote`. */
  nonLocalRunner: BunRunner;
  /** The finished runs of each runner, by runner id. */
  finished: Record<string, string[]>;
  /** The run each runner holds in progress, by runner id. */
  holding: Record<string, string>;
}

/** Imports a module by a specifier the compiler does not resolve. */
function load<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

const dom = await load<DomModule>(["..", "dom"].join("/"));
const { native } = await load<RegisterDomModule>(
  ["..", "register-dom"].join("/"),
);
dom.setupDom();

const CSRF = "x-bun-jobs-csrf";
const BASE = "/jobs-api";
const QUEUE = "emails";
/** How many lines the `logged` job writes. */
const LOGGED_LINES = 7;
const LOCAL_RUNNER = "local-report";
const REMOTE_RUNNER = "remote-report";
/** Finished runs made before each runner's held one. */
const FINISHED_RUNS = { [LOCAL_RUNNER]: 3, [REMOTE_RUNNER]: 2 } as const;
const RUNNER_FILE = join(
  import.meta.dir,
  "fixtures",
  "clear-actions",
  "gated-runner.ts",
);
/** Each scenario renders the whole app over real reads. */
const TEST_TIMEOUT_MS = 30_000;
/** The reasons `app/screens/job/clearLogs.ts` shows. */
const ACTIVE_REASON =
  "Clear logs once the job finishes — a running job is still writing to them.";
const EMPTY_REASON = "No lines to clear.";

/** The gates held runs and jobs wait on, shared with the in-process runner. */
const gates = new Map<string, Promise<void>>();
(globalThis as Record<symbol, unknown>)[GATES] = gates;
const releases = new Map<string, () => void>();

/** Creates the gate `name`. */
function gate(name: string): string {
  gates.set(
    name,
    new Promise<void>((resolve) => {
      releases.set(name, resolve);
    }),
  );
  return name;
}

/** Opens the gate `name`. */
function release(name: string): void {
  releases.get(name)?.();
}

let tmp: string;
const deployments: Deployment[] = [];
/** Set while the test itself makes a request, so it is not taken for the UI's. */
let directCall = false;

/**
 * Runs `fn` with Bun's `Response` as the global: the API builds its
 * responses from the global, which happy-dom has replaced.
 */
async function withBunGlobals<T>(fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.Response;
  globalThis.Response = native.Response;
  try {
    return await fn();
  } finally {
    globalThis.Response = saved;
  }
}

/** Resolves once `check` holds, reporting `what` if it never does. */
async function until(
  check: () => boolean | Promise<boolean>,
  what: () => string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${what()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Mounts an API over `jobs` and returns the recording fetch shim into it. */
function mountApi(
  jobs: BunJobs,
  exchanges: Exchange[],
  which: Exchange["api"],
): FetchLike {
  const api = createJobsApi({
    jobs,
    mode: "both",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    csrf: { header: CSRF },
    ...(which === "restricted"
      ? {
          actions: JOBS_API_ACTIONS.filter(
            (action) =>
              action !== "jobs.clearLogs" && action !== "runners.clearHistory",
          ),
        }
      : {}),
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses.
  return async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const url = new URL(input, "http://localhost");
      const request = new native.Request(url.href, init);
      const csrf = request.headers.get(CSRF);
      const response = await root.fetch(request);
      const text = await response.text();
      let json: unknown;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      exchanges.push({
        method: request.method,
        path: url.pathname.slice(BASE.length),
        query: url.search.replace(/^\?/, ""),
        csrf,
        body: typeof init.body === "string" ? init.body : undefined,
        status: response.status,
        json,
        direct: directCall,
        api: which,
      });
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
}

/** A request the test makes itself, through the full API, with the CSRF header. */
async function direct(
  deployment: Deployment,
  method: string,
  path: string,
): Promise<{ status: number; json: unknown }> {
  directCall = true;
  try {
    const response = await deployment.fetch(`${BASE}${path}`, {
      method,
      headers: { [CSRF]: "1" },
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  } finally {
    directCall = false;
  }
}

/** A direct read that must succeed. */
async function read<T>(deployment: Deployment, path: string): Promise<T> {
  const { status, json } = await direct(deployment, "GET", path);
  expect(`${path} ${status}`).toBe(`${path} 200`);
  return json as T;
}

/** Every DELETE the UI sent, to anything. */
function uiDeletes(deployment: Deployment): Exchange[] {
  return deployment.exchanges.filter(
    (one) => !one.direct && one.method === "DELETE",
  );
}

/** A job's state, as the library reads it. */
async function stateOf(deployment: Deployment, id: string) {
  return (await deployment.api.queue<JobData>(QUEUE).getJob(id))?.state;
}

/** Adds job `id` and waits until it reaches `state`. */
async function addJob(
  deployment: Deployment,
  id: string,
  data: JobData,
  state: "completed" | "active",
) {
  await deployment.api.queue<JobData>(QUEUE).add("notify", data, {
    jobId: id,
    attempts: 1,
  });
  await until(
    async () => (await stateOf(deployment, id)) === state,
    () => `${deployment.label}: ${id} never reached ${state}`,
  );
}

/** Triggers `runner`, waiting for the run to be recorded — settled, unless `hold` names a gate. */
async function run(runner: BunRunner, hold?: string): Promise<string> {
  const outcome = await runner.trigger(
    hold === undefined ? {} : { args: { hold } },
  );
  if (outcome.outcome !== "started") {
    throw new Error(`${runner.id}: trigger ${JSON.stringify(outcome)}`);
  }
  const { runId } = outcome;
  await until(
    async () => {
      const record = (await runner.history()).find(
        (one) => one.runId === runId,
      );
      return hold === undefined
        ? record !== undefined && record.status !== "running"
        : record?.status === "running";
    },
    () => `${runner.id}: run ${runId} never ${hold ? "recorded" : "settled"}`,
  );
  return runId;
}

/** Starts a runner in `jobs` over the gated fixture. */
async function startRunner(jobs: BunJobs, id: string): Promise<BunRunner> {
  const runner = jobs.runner({
    id,
    name: id,
    file: RUNNER_FILE,
    executionMode: "in-process",
    waitToExit: false,
    logger: noopLogger,
  });
  await runner.start();
  return runner;
}

/** Builds a deployment over `driver` (see the file's comment). */
async function populate(
  label: string,
  driver: JobsDriver,
  namespace: string,
): Promise<Deployment> {
  const api = new BunJobs({
    namespace,
    service: "api",
    driver,
    logger: noopLogger,
  });
  const remote = new BunJobs({
    namespace,
    service: "remote",
    driver,
    logger: noopLogger,
  });
  const exchanges: Exchange[] = [];
  const worker = api.worker<JobData, string>(
    QUEUE,
    async (job) => {
      for (let line = 1; line <= (job.data?.lines ?? 0); line++) {
        await job.log(`line ${line}`);
      }
      if (job.data?.hold !== undefined) {
        await gates.get(job.data.hold);
      }
      return "ok";
    },
    {
      concurrency: 2,
      reportInterval: 500,
      pollInterval: 10,
      waitToExit: false,
      logger: noopLogger,
    },
  );
  void worker.run();
  const deployment: Deployment = {
    label,
    api,
    remote,
    fetch: mountApi(api, exchanges, "full"),
    restricted: mountApi(api, exchanges, "restricted"),
    exchanges,
    worker,
    local: await startRunner(api, LOCAL_RUNNER),
    nonLocalRunner: await startRunner(remote, REMOTE_RUNNER),
    finished: {},
    holding: {},
  };
  deployments.push(deployment);

  await addJob(deployment, "logged", { lines: LOGGED_LINES }, "completed");
  await addJob(deployment, "silent", {}, "completed");
  await addJob(deployment, "gated", { lines: 3 }, "completed");
  await addJob(
    deployment,
    "held",
    { lines: 2, hold: gate(`${label}:job`) },
    "active",
  );

  for (const runner of [deployment.local, deployment.nonLocalRunner]) {
    const finished: string[] = [];
    for (
      let index = 0;
      index < FINISHED_RUNS[runner.id as keyof typeof FINISHED_RUNS];
      index++
    ) {
      finished.push(await run(runner));
    }
    deployment.finished[runner.id] = finished;
    deployment.holding[runner.id] = await run(
      runner,
      gate(`${label}:${runner.id}`),
    );
  }
  return deployment;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "bun-jobs-ui-clear-"));
  await populate("memory", new MemoryDriver(), "ui-clear-memory");
  await populate(
    "file",
    new FileDriver({ root: join(tmp, "file") }),
    "ui-clear-file",
  );
  await populate(
    "SQLite",
    new SqlDriver({ url: `sqlite://${join(tmp, "clear.db")}` }),
    "ui-clear-sqlite",
  );
}, 120_000);

afterAll(async () => {
  for (const open of releases.values()) {
    open();
  }
  for (const deployment of deployments) {
    await deployment.worker.close({ force: true }).catch(() => undefined);
    for (const runner of [deployment.local, deployment.nonLocalRunner]) {
      await runner.stop({ force: true }).catch(() => undefined);
    }
    // The contexts share one driver, which the first to close closes.
    await deployment.remote.close().catch(() => undefined);
    await deployment.api.close().catch(() => undefined);
  }
  delete (globalThis as Record<symbol, unknown>)[GATES];
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** Loads the job screen's harness. */
function jobHarness(): Promise<ClearLogsModule> {
  return load<ClearLogsModule>(["..", "job", "realApiClearLogs"].join("/"));
}

/** Loads the runner screen's harness. */
function runnerHarness(): Promise<ClearHistoryModule> {
  return load<ClearHistoryModule>(
    ["..", "runners", "realApiClearHistory"].join("/"),
  );
}

/** `GET /queues/:queue/jobs/:id/logs`' answer. */
interface LogPage {
  /** The lines. */
  items: string[];
  /** The page, with the whole log's count. */
  page: { total: number };
}

/** A run record as `GET /runners/:runner/history` lists it. */
interface RunItem {
  /** The run's id. */
  runId: string;
  /** Its status. */
  status: string;
}

/** The deployment named `label`, built in `beforeAll`. */
function deployment(label: string): Deployment {
  return deployments.find((one) => one.label === label)!;
}

for (const label of ["memory", "file", "SQLite"]) {
  describe(`clearing a job's log against a real API (${label})`, () => {
    it(
      "clears a completed job's lines, and the next line is numbered 1 again",
      async () => {
        const deploy = deployment(label);
        const path = `/queues/${QUEUE}/jobs/logged/logs`;
        expect(
          (await read<LogPage>(deploy, `${path}?limit=100`)).page.total,
        ).toBe(LOGGED_LINES);

        const ui = await (
          await jobHarness()
        ).mountJobLogs(deploy.fetch, CSRF, QUEUE, "logged");
        const before = await ui.awaitView(
          (view) => view.lines.length === LOGGED_LINES,
        );
        expect(before.button).toBe("enabled");
        expect(before.reason).toBeNull();
        expect(before.total).toBe(LOGGED_LINES);

        const { confirmation, toast } = await ui.clear();
        expect(confirmation).toContain(
          `Clear the ${LOGGED_LINES} log lines of this job?`,
        );
        expect(confirmation).toContain("its next line is numbered 1 again");

        // The one request the UI sent: a bodiless DELETE with the CSRF header.
        const deletes = uiDeletes(deploy).filter((one) => one.path === path);
        expect(deletes).toHaveLength(1);
        expect(deletes[0]).toMatchObject({
          method: "DELETE",
          path,
          query: "",
          csrf: "1",
          body: undefined,
          status: 200,
          json: { removed: LOGGED_LINES },
        });
        expect(toast).toContain(`Cleared ${LOGGED_LINES} lines`);

        // The log section re-reads, and the real answer is empty.
        const after = await ui.awaitView((view) => view.empty);
        expect(after.total).toBe(0);
        expect(after.lines).toEqual([]);
        expect(after.button).toBe("disabled");
        expect(after.reason).toBe(EMPTY_REASON);
        const deleteAt = deploy.exchanges.indexOf(deletes[0]!);
        const reread = deploy.exchanges
          .slice(deleteAt + 1)
          .find(
            (one) => !one.direct && one.method === "GET" && one.path === path,
          );
        expect(reread?.status).toBe(200);
        expect((reread?.json as LogPage).page.total).toBe(0);
        expect((reread?.json as LogPage).items).toEqual([]);
        ui.unmount();

        // Straight from the store: nothing left, and the job is untouched.
        const queue = deploy.api.queue<JobData>(QUEUE);
        expect(await queue.getJobLogs("logged")).toEqual({
          logs: [],
          count: 0,
        });
        expect(await stateOf(deploy, "logged")).toBe("completed");

        // The confirmation's promise: the next line is the first again.
        const job = (await queue.getJob("logged"))!;
        expect(await job.log("after the clear")).toBe(1);
        const again = await (
          await jobHarness()
        ).mountJobLogs(deploy.fetch, CSRF, QUEUE, "logged");
        const relogged = await again.awaitView(
          (view) => view.lines.length === 1,
        );
        expect(relogged.lines).toEqual([[1, "after the clear"]]);
        expect(relogged.total).toBe(1);
        again.unmount();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "disables the button while a worker holds the job, and the API refuses with 409",
      async () => {
        const deploy = deployment(label);
        const path = `/queues/${QUEUE}/jobs/held/logs`;
        expect(await stateOf(deploy, "held")).toBe("active");

        const ui = await (
          await jobHarness()
        ).mountJobLogs(deploy.fetch, CSRF, QUEUE, "held");
        const active = await ui.awaitView((view) => view.lines.length === 2);
        expect(active.button).toBe("disabled");
        expect(active.reason).toBe(ACTIVE_REASON);

        // What the button spares the user: the real refusal.
        const refused = await direct(deploy, "DELETE", path);
        expect(refused.status).toBe(409);
        expect(refused.json).toMatchObject({
          code: "JOB_ACTIVE",
          context: { state: "active" },
        });
        expect((await deploy.api.queue(QUEUE).getJobLogs("held")).count).toBe(
          2,
        );
        expect(uiDeletes(deploy).filter((one) => one.path === path)).toEqual(
          [],
        );

        // Released, the job completes, and the screen (polling an unfinished
        // job) re-reads it and offers the clear.
        release(`${label}:job`);
        await until(
          async () => (await stateOf(deploy, "held")) === "completed",
          () => "the held job never completed",
        );
        const done = await ui.awaitView(
          (view) => view.button === "enabled",
          15_000,
        );
        expect(done.reason).toBeNull();
        expect(done.total).toBe(2);
        ui.unmount();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "disables the button on a job that never logged, and the API answers 0",
      async () => {
        const deploy = deployment(label);
        const path = `/queues/${QUEUE}/jobs/silent/logs`;
        const ui = await (
          await jobHarness()
        ).mountJobLogs(deploy.fetch, CSRF, QUEUE, "silent");
        const view = await ui.awaitView((one) => one.empty);
        expect(view.total).toBe(0);
        expect(view.button).toBe("disabled");
        expect(view.reason).toBe(EMPTY_REASON);
        ui.unmount();
        expect(uiDeletes(deploy).filter((one) => one.path === path)).toEqual(
          [],
        );

        const cleared = await direct(deploy, "DELETE", path);
        expect(cleared).toEqual({ status: 200, json: { removed: 0 } });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe(`clearing a runner's history against a real API (${label})`, () => {
    it(
      "clears a local runner's finished runs and keeps the one in progress",
      async () => {
        const deploy = deployment(label);
        const id = LOCAL_RUNNER;
        await expectClear(deploy, id, { isLocal: true });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "offers and clears the history of a runner registered in another context",
      async () => {
        const deploy = deployment(label);
        const id = REMOTE_RUNNER;
        await expectClear(deploy, id, { isLocal: false });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe(`the clear actions left out of \`actions\` (${label})`, () => {
    it(
      "shows neither button and sends nothing",
      async () => {
        const deploy = deployment(label);
        const permissions = async (fetch: FetchLike) => {
          directCall = true;
          try {
            const response = await fetch(`${BASE}/meta/permissions`, {
              method: "GET",
            });
            return (
              (await response.json()) as {
                actions: Record<string, boolean>;
              }
            ).actions;
          } finally {
            directCall = false;
          }
        };
        const full = await permissions(deploy.fetch);
        expect(full["jobs.clearLogs"]).toBe(true);
        expect(full["runners.clearHistory"]).toBe(true);
        const restricted = await permissions(deploy.restricted);
        expect("jobs.clearLogs" in restricted).toBe(false);
        expect("runners.clearHistory" in restricted).toBe(false);
        // Other mutations are still granted, so the screens are writable.
        expect(restricted["jobs.remove"]).toBe(true);
        expect(restricted["runners.trigger"]).toBe(true);

        const jobs = await jobHarness();
        const runners = await runnerHarness();

        // The control: over the full API both are offered.
        const offeredJob = await jobs.mountJobLogs(
          deploy.fetch,
          CSRF,
          QUEUE,
          "gated",
        );
        expect(
          (await offeredJob.awaitView((view) => view.total === 3)).button,
        ).toBe("enabled");
        offeredJob.unmount();
        const offeredRunner = await runners.mountRunnerHistory(
          deploy.fetch,
          CSRF,
          LOCAL_RUNNER,
        );
        expect(offeredRunner.view()).toMatchObject({
          offered: true,
          inHistoryCard: true,
          inActionGroup: false,
        });
        offeredRunner.unmount();

        const from = deploy.exchanges.length;
        const job = await jobs.mountJobLogs(
          deploy.restricted,
          CSRF,
          QUEUE,
          "gated",
        );
        const jobView = await job.awaitView((view) => view.total === 3);
        expect(jobView.button).toBe("absent");
        expect(jobView.reason).toBeNull();
        job.unmount();
        const runner = await runners.mountRunnerHistory(
          deploy.restricted,
          CSRF,
          LOCAL_RUNNER,
        );
        // The history is in, so the card rendered without it; nor is it in
        // the header's actions, which are there.
        await runner.awaitView((view) => view.history.length > 0);
        expect(runner.view()).toMatchObject({
          offered: false,
          inHistoryCard: false,
          inActionGroup: false,
          hasActionGroup: true,
          hasHistoryCard: true,
        });
        runner.unmount();

        const sent = deploy.exchanges.slice(from);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.every((one) => one.api === "restricted")).toBe(true);
        expect(sent.filter((one) => one.method !== "GET")).toEqual([]);
        expect((await deploy.api.queue(QUEUE).getJobLogs("gated")).count).toBe(
          3,
        );
      },
      TEST_TIMEOUT_MS,
    );
  });
}

/**
 * Clears runner `id`'s history through its screen and checks the request,
 * the answer, the toast, the re-read history and the untouched counters.
 */
async function expectClear(
  deploy: Deployment,
  id: string,
  { isLocal }: { isLocal: boolean },
) {
  const path = `/runners/${id}/history`;
  const finished = deploy.finished[id]!;
  const holding = deploy.holding[id]!;
  expect(
    (await read<{ isLocal: boolean }>(deploy, `/runners/${id}`)).isLocal,
  ).toBe(isLocal);
  const listed = await read<{ items: RunItem[] }>(deploy, path);
  expect(listed.items.map((one) => one.runId).sort()).toEqual(
    [...finished, holding].sort(),
  );
  const statsBefore = await read<Record<string, number>>(
    deploy,
    `/runners/${id}/stats`,
  );
  expect(statsBefore.success).toBe(finished.length);

  const ui = await (
    await runnerHarness()
  ).mountRunnerHistory(deploy.fetch, CSRF, id);
  const before = await ui.awaitView(
    (view) => view.history.length === finished.length + 1,
  );
  expect(before).toMatchObject({
    offered: true,
    inHistoryCard: true,
    inActionGroup: false,
  });
  if (isLocal) {
    expect(before.nonLocalHint).toBeNull();
  } else {
    // The hint names what a remote runner cannot do here; clearing is not
    // among them.
    expect(before.nonLocalHint ?? "").not.toMatch(/clear|history/i);
  }

  const { dialog, toast } = await ui.clear();
  expect(dialog).toContain(`Clear the run history of ${id}?`);
  // Single mode: the lock vouches for a remote run, so no caveat applies.
  expect(dialog).not.toContain("its runs may overlap");

  const deletes = uiDeletes(deploy).filter((one) => one.path === path);
  expect(deletes).toHaveLength(1);
  expect(deletes[0]).toMatchObject({
    method: "DELETE",
    query: "",
    csrf: "1",
    body: undefined,
    status: 200,
    json: { removed: finished.length, kept: [holding] },
  });
  expect(toast).toContain(
    `Cleared ${finished.length} runs, kept 1 in progress`,
  );
  expect(toast).toContain(`Kept: ${holding}`);

  // The history re-reads: only the run in progress is left.
  const after = await ui.awaitView((view) => view.history.length === 1);
  expect(after.history).toEqual([holding]);
  // The counters are untouched, on screen and in the API.
  expect(after.stats).toEqual(before.stats);
  ui.unmount();
  expect(
    await read<Record<string, number>>(deploy, `/runners/${id}/stats`),
  ).toEqual(statsBefore);
  const remaining = await read<{ items: RunItem[] }>(deploy, path);
  expect(remaining.items.map((one) => [one.runId, one.status])).toEqual([
    [holding, "running"],
  ]);
}
