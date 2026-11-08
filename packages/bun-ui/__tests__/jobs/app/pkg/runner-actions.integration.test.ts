import type { BunRunner } from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { join } from "node:path";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The runner ACTIONS against a REAL `createJobsApi` in mode `runner`, with a
 * real local `BunRunner`: pausing, resuming, triggering and rescheduling in
 * the UI really change the runner, as the API then reports it.
 *
 * Compiled without the DOM lib (see tsconfig.json): the DOM side is loaded by
 * dynamic imports the compiler does not follow, and the interfaces below
 * restate the little this file uses of them.
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

/** What this file uses of `../runners/actions/realApiActions`. */
interface ActionsModule {
  /** Renders the runner's actions over `fetch` and returns a driver. */
  mountRunnerActions: (
    runner: string,
    fetch: FetchLike,
    csrfHeader: string,
  ) => Promise<{
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    trigger: () => Promise<string>;
    rescheduleEveryHours: (hours: number) => Promise<string>;
  }>;
}

/** The runner as `GET /runners/:runner` answers (the fields asserted on). */
interface RunnerBody {
  /** Whether it is paused. */
  isPaused: boolean;
  /** The stored schedule. */
  schedule: unknown;
  /** When it next fires, epoch ms. */
  nextRunAt: number | null;
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
const RUNNER = "nightly-report";
const HOUR = 3_600_000;

let jobs: BunJobs;
let runner: BunRunner;
let fetchShim: FetchLike;

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

/** `GET` through the API, parsed. */
async function read<T>(path: string): Promise<T> {
  const response = await fetchShim(`${BASE}${path}`, { method: "GET" });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

/** Resolves once `check` holds. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-runner-actions-integration",
    driver: new MemoryDriver(),
  });
  runner = jobs.runner({
    id: RUNNER,
    name: "Nightly report",
    file: join(import.meta.dir, "fixtures", "runner-actions", "report.ts"),
    executionMode: "in-process",
    schedule: { cron: "0 3 * * *", tz: "UTC" },
    waitToExit: false,
    logger: noopLogger,
  });
  await runner.start();
  const api = createJobsApi({
    jobs,
    mode: "runner",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    csrf: { header: CSRF },
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses.
  fetchShim = async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const response = await root.fetch(
        new native.Request(new URL(input, "http://localhost").href, init),
      );
      return new Response(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
});

afterAll(async () => {
  await runner.stop({ force: true });
  await jobs.close();
});

describe("the runner actions against a real API", () => {
  it("pauses, resumes, triggers a run and reschedules", async () => {
    const actions = await load<ActionsModule>(
      ["..", "runners", "actions", "realApiActions"].join("/"),
    );
    const ui = await actions.mountRunnerActions(RUNNER, fetchShim, CSRF);

    await ui.pause();
    expect((await read<RunnerBody>(`/runners/${RUNNER}`)).isPaused).toBe(true);
    expect(runner.status).toBe("paused");

    await ui.resume();
    expect((await read<RunnerBody>(`/runners/${RUNNER}`)).isPaused).toBe(false);
    expect(runner.status).toBe("running");

    const started = await ui.trigger();
    expect(started).toContain(`Run started on ${RUNNER}`);
    await until(async () =>
      (
        await read<{ items: { status: string; source: string }[] }>(
          `/runners/${RUNNER}/history`,
        )
      ).items.some(
        (item) => item.source === "manual" && item.status === "success",
      ),
    );

    const before = Date.now();
    const rescheduled = await ui.rescheduleEveryHours(1);
    expect(rescheduled).toContain(`Rescheduled ${RUNNER}`);
    expect(rescheduled).toContain("Next run");
    const info = await read<RunnerBody>(`/runners/${RUNNER}`);
    expect(info.schedule).toEqual({ every: HOUR });
    expect(info.nextRunAt).not.toBeNull();
    expect(info.nextRunAt!).toBeGreaterThanOrEqual(before + HOUR - 1_000);
    expect(info.nextRunAt!).toBeLessThanOrEqual(Date.now() + HOUR + 1_000);
  });
});
