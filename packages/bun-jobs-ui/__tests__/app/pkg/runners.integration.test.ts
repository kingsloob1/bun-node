import type { BunRunner } from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The runner SCREENS against a REAL `createJobsApi` in mode `runner`, with a
 * real local `BunRunner` (in-process) that has run once: the list and the
 * runner screen show the API's name, status, schedule and history.
 *
 * Like `queues.integration.test.ts`, this project compiles without the DOM
 * lib, so the DOM side is loaded by dynamic imports the compiler does not
 * follow; the interfaces below restate the little this file uses of them.
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

/** What this file uses of `../runners/realApiScreen`. */
interface ScreenModule {
  /** Renders `/runners` over `fetch` and returns its rows. */
  mountRunnerList: (
    fetch: FetchLike,
  ) => Promise<{ id: string; text: string; href: string }[]>;
  /** Renders `/runners/<id>` over `fetch`, waiting for `runs` history rows. */
  mountRunnerScreen: (
    id: string,
    fetch: FetchLike,
    runs: number,
  ) => Promise<{
    heading: string;
    status: string;
    schedule: string;
    concurrency: string;
    history: string[];
    total: string;
  }>;
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

const BASE = "/jobs-api";

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

/** Resolves once `check` holds. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the runner");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-runners-integration",
    driver: new MemoryDriver(),
  });
  runner = jobs.runner({
    id: "nightly",
    name: "Nightly report",
    file: new URL("./fixtures/report-runner.ts", import.meta.url),
    executionMode: "in-process",
    schedule: { cron: "0 3 * * *", tz: "Europe/London" },
    waitToExit: false,
  });
  await runner.start();

  const api = createJobsApi({
    jobs,
    mode: "runner",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses;
  // nothing here is cancelled, so it is left out.
  fetchShim = async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const response = await root.fetch(
        new native.Request(new URL(input, "http://localhost").href, init),
      );
      // A plain copy the app reads the same under either implementation.
      return new Response(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });

  // One real run, finished before the screens look.
  await runner.trigger();
  await until(async () => (await runner.history()).length === 1);
  await until(async () => runner.activeRuns.size === 0);
});

afterAll(async () => {
  await jobs.close();
});

describe("the runner screens against a real API", () => {
  it("list the local runner by name with its status, linked to its screen", async () => {
    const screens = await load<ScreenModule>(
      ["..", "runners", "realApiScreen"].join("/"),
    );
    const rows = await screens.mountRunnerList(fetchShim);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("nightly");
    expect(rows[0]!.text).toContain("Nightly report");
    expect(rows[0]!.text).toContain("Local");
    // Started: the instance's status is `running` (its schedule is armed).
    expect(runner.status).toBe("running");
    expect(rows[0]!.text).toContain("Running");
    expect(rows[0]!.href).toBe("/jobs/runners/nightly");
  });

  it("show the runner's real name, status, schedule, stats and the run it made", async () => {
    const screens = await load<ScreenModule>(
      ["..", "runners", "realApiScreen"].join("/"),
    );
    const view = await screens.mountRunnerScreen("nightly", fetchShim, 1);
    expect(view.heading).toBe("Nightly report");
    expect(view.status).toBe("Running");
    expect(view.schedule).toBe("Cron 0 3 * * * in Europe/London");
    // Unlimited concurrency is Infinity on the server, left out of the JSON.
    expect(view.concurrency).toBe("unlimited");
    expect(view.total).toBe("1");
    expect(view.history).toHaveLength(1);
    expect(view.history[0]).toContain("Success");
    expect(view.history[0]).toContain("Manual");
    const [run] = await runner.history();
    expect(view.history[0]).toContain(run!.runId);
  });
});
