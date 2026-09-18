import type { FetchLike } from "../../../app/api/client";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The queue SCREEN against a REAL `createJobsApi` (memory driver): the
 * counts it shows are the API's, and a bulk retry and a pause made in the UI
 * really change the queue.
 *
 * This project compiles without the DOM lib (see tsconfig.json), so the DOM
 * side (happy-dom, Testing Library, the app) is loaded by dynamic imports
 * the compiler does not follow: `../dom` for the DOM hooks, and
 * `../queues/realApiScreen` for a small driver of the rendered screen. The
 * interfaces below restate the little this file uses of them.
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

/** What this file uses of `../queues/realApiScreen` (`QueueScreenDriver`). */
interface ScreenModule {
  /** Renders the queue screen over `fetch` and returns its driver. */
  mountQueueScreen: (
    queue: string,
    fetch: FetchLike,
    csrfHeader: string,
  ) => Promise<{
    tab: (label: string) => Promise<string>;
    total: () => string;
    openTab: (label: string, rows: number) => Promise<string[]>;
    retryPage: () => Promise<string>;
    pause: () => Promise<void>;
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

const CSRF = "x-bun-jobs-csrf";
const BASE = "/jobs-api";
const QUEUE = "emails";

let jobs: BunJobs;
let fetchShim: FetchLike;

/**
 * Runs `fn` with Bun's `Request`/`Response` as the globals: the API builds
 * its responses from the globals, which happy-dom has replaced.
 */
async function withBunGlobals<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { Request: globalThis.Request, Response: globalThis.Response };
  globalThis.Request = native.Request;
  globalThis.Response = native.Response;
  try {
    return await fn();
  } finally {
    globalThis.Request = saved.Request;
    globalThis.Response = saved.Response;
  }
}

/** Resolves once `check` holds, polling the real queue. */
async function until(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the queue");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-queues-integration",
    driver: new MemoryDriver(),
  });
  const api = createJobsApi({
    jobs,
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    limits: { queueCacheMs: 0 },
    csrf: { header: CSRF },
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

  const queue = jobs.queue(QUEUE);
  // Two completed and two dead (one attempt each), through a real worker.
  for (const name of ["ok", "boom", "ok", "boom"]) {
    await queue.add(name, { name }, { attempts: 1 });
  }
  const worker = jobs.worker(QUEUE, async (job) => {
    if (job.name === "boom") {
      throw new Error("SMTP refused");
    }
    return "sent";
  });
  void worker.run();
  await until(async () => {
    const counts = await queue.count();
    return counts.completed === 2 && counts.dead === 2;
  });
  await worker.close({ timeout: 1_000 });
  // Then three waiting and one delayed, which nothing consumes.
  for (let index = 0; index < 3; index++) {
    await queue.add("later", { index });
  }
  await queue.add("later", { delayed: true }, { delay: 3_600_000 });
});

afterAll(async () => {
  await jobs.close();
});

describe("the queue screen against a real API", () => {
  it("shows the real counts, retries the dead jobs in bulk, and pauses the queue", async () => {
    const screen = await load<ScreenModule>(
      ["..", "queues", "realApiScreen"].join("/"),
    );
    const ui = await screen.mountQueueScreen(QUEUE, fetchShim, CSRF);

    expect(await ui.tab("Dead")).toBe("Dead2");
    expect(await ui.tab("Waiting")).toBe("Waiting3");
    expect(await ui.tab("Completed")).toBe("Completed2");
    expect(await ui.tab("Delayed")).toBe("Delayed1");
    expect(ui.total()).toBe("8 jobs");

    expect(await ui.openTab("Dead", 2)).toEqual(["boom", "boom"]);
    expect(await ui.retryPage()).toContain("Retried 2, skipped 0");
    await until(async () => (await jobs.queue(QUEUE).count("dead")) === 0);
    expect(await jobs.queue(QUEUE).count("waiting")).toBe(5);

    expect(await jobs.queue(QUEUE).isPaused()).toBe(false);
    await ui.pause();
    expect(await jobs.queue(QUEUE).isPaused()).toBe(true);
  });
});
