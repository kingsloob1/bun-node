import type { BunQueueWorker } from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The worker screens against a REAL `createJobsApi` where the worker is not
 * in a settled state — found by the examples, which drive the same API:
 *
 * - Reset with no live instance EMPTIES the stored entry (it keeps its seq)
 *   rather than deleting it, so the page must count an empty entry as
 *   nothing stored.
 * - Stop on a worker holding a job is accepted at once (`applied: true`) but
 *   the worker reads `stopping` until the job finishes, so the toast must not
 *   say "Stopped" yet — and the row, offering Settings… still, must say why
 *   Pause and Stop are gone.
 * - Pause on a worker holding a job, by contrast, is immediate: the worker
 *   reads `paused` in the same answer.
 *
 * Compiled without the DOM lib (see tsconfig.json): the DOM side is loaded by
 * dynamic imports the compiler does not follow, and the interfaces below
 * restate the little this file uses of them. Each scenario owns its queue.
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

/** What this file uses of `../workers/realApiActions`. */
interface ActionsModule {
  /** Renders one worker's row over `fetch` and returns a driver for it. */
  mountWorkerRow: (
    queue: string,
    id: string,
    fetch: FetchLike,
    csrfHeader: string,
  ) => Promise<{
    state: () => string;
    awaitState: (label: string) => Promise<void>;
    offers: (name: string) => boolean;
    awaitButton: (name: string) => Promise<void>;
    blockedHint: () => string | null;
    lifecycle: (name: "Pause" | "Resume" | "Start") => Promise<string>;
    stop: () => Promise<string>;
  }>;
}

/** What the page's Configuration card shows while no instance is live. */
interface OfflineConfigView {
  /** The "An override is stored…" sentence, or `null`. */
  stored: string | null;
  /** The "No override is stored…" sentence, or `null`. */
  noneStored: string | null;
  /** Whether "Reset to code values…" is offered. */
  offersReset: boolean;
}

/** What this file uses of `../workers/realApiWorkerPage`. */
interface WorkerPageModule {
  /** Renders the worker page over `fetch` and returns a driver for it. */
  mountWorkerPage: (
    fetch: FetchLike,
    csrfHeader: string,
    queue: string,
    key: string,
  ) => Promise<{
    view: () => OfflineConfigView;
    awaitView: (
      ready: (view: OfflineConfigView) => boolean,
    ) => Promise<OfflineConfigView>;
    reset: () => Promise<string>;
    unmount: () => void;
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
const SERVICE = "api";
/** One queue per scenario, so they never interfere. */
const QUEUES = {
  /** No worker at all: an override stored for a key, then reset. */
  offline: "digests",
  /** Stop while the worker holds a job. */
  draining: "mail",
  /** Pause while the worker holds a job. */
  pausing: "alerts",
} as const;

let jobs: BunJobs;
let fetchShim: FetchLike;
const workers = new Map<string, BunQueueWorker<unknown, unknown>>();
/** Releases the job each worker is holding, by queue. */
const gates = new Map<string, () => void>();

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

/** A JSON read through the API. */
async function read(path: string): Promise<Record<string, unknown>> {
  const response = await fetchShim(`${BASE}${path}`, { method: "GET" });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** The one worker record `GET /queues/:queue/workers` reports for `queue`. */
async function reported(queue: string): Promise<Record<string, unknown>> {
  const body = (await read(`/queues/${queue}/workers`)) as {
    items: Record<string, unknown>[];
  };
  return body.items[0] ?? {};
}

/** The worker consuming `queue`. */
function workerOf(queue: string): BunQueueWorker<unknown, unknown> {
  return workers.get(queue)!;
}

/** Enqueues one job on `queue` and resolves once its worker is running it. */
async function holdJob(queue: string): Promise<void> {
  await jobs.queue(queue).add("hold", {});
  await until(
    async () => (await reported(queue)).active === 1,
    () => `the worker on ${queue} never took the job`,
  );
}

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-worker-transitions-integration",
    service: SERVICE,
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  // Known to the API, but consumed by no worker.
  jobs.queue(QUEUES.offline);
  for (const queue of [QUEUES.draining, QUEUES.pausing]) {
    const held = new Promise<void>((resolve) => gates.set(queue, resolve));
    const worker = jobs.worker<unknown, unknown>(
      queue,
      async () => {
        await held;
        return "ok";
      },
      {
        concurrency: 1,
        reportInterval: 200,
        pollInterval: 10,
        waitToExit: false,
        logger: noopLogger,
      },
    );
    workers.set(queue, worker);
    void worker.run();
  }
  const api = createJobsApi({
    jobs,
    mode: "jobs",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    csrf: { header: CSRF },
    // `workers.configure` is opt-in: granted, so Settings… stays offered.
    actions: [...JOBS_API_ACTIONS],
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses.
  fetchShim = async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const url = new URL(input, "http://localhost");
      const response = await root.fetch(new native.Request(url.href, init));
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
  for (const queue of [QUEUES.draining, QUEUES.pausing]) {
    const id = workerOf(queue).id;
    await until(
      async () => (await reported(queue)).id === id,
      () => `worker ${id} never registered on ${queue}`,
    );
  }
});

afterAll(async () => {
  for (const release of gates.values()) {
    release();
  }
  for (const worker of workers.values()) {
    await worker.close({ force: true }).catch(() => undefined);
  }
  await jobs.close();
});

describe("the worker screens against a real API, mid-transition", () => {
  it("counts the entry Reset empties as nothing stored, and stops offering Reset", async () => {
    const queue = QUEUES.offline;
    const key = `${SERVICE}.${queue}`;
    await jobs.workers.remote(queue).setConfig(key, { concurrency: 4 });

    const { mountWorkerPage } = await load<WorkerPageModule>(
      ["..", "workers", "realApiWorkerPage"].join("/"),
    );
    const ui = await mountWorkerPage(fetchShim, CSRF, queue, key);
    const before = await ui.awaitView((view) => view.stored !== null);
    expect(before.stored).toContain("version 1");
    expect(before.offersReset).toBe(true);

    expect(await ui.reset()).toContain(
      `Reset ${key} to the values in its code`,
    );

    // The API's shape after the reset: the entry stays, emptied, at seq 2.
    const listing = (await read(
      `/workers?queue=${queue}&key=${key}&includeOffline=true`,
    )) as { items: unknown[]; offline: Record<string, unknown>[] };
    expect(listing.items).toEqual([]);
    expect(listing.offline).toHaveLength(1);
    expect(listing.offline[0]).toMatchObject({ key, values: {}, seq: 2 });

    const after = await ui.awaitView((view) => view.stored === null);
    expect(after.noneStored).toContain("No override is stored");
    expect(after.offersReset).toBe(false);
    ui.unmount();
  }, 30_000);

  it("says a stop on a busy worker is still draining, and why its row lost Pause and Stop", async () => {
    const queue = QUEUES.draining;
    const worker = workerOf(queue);
    await holdJob(queue);
    const { mountWorkerRow } = await load<ActionsModule>(
      ["..", "workers", "realApiActions"].join("/"),
    );
    const ui = await mountWorkerRow(queue, worker.id, fetchShim, CSRF);
    await ui.awaitState("Running");
    expect(ui.blockedHint()).toBeNull();

    const toast = await ui.stop();
    // The API accepted the stop, but the worker is finishing its job.
    expect(worker.state).toBe("stopping");
    const record = await reported(queue);
    expect(record.state).toBe("stopping");
    expect(record.control).toMatchObject({ pending: true });
    expect(toast).toContain(
      `Asked ${worker.id} to stop; it finishes its jobs first`,
    );
    expect(toast).not.toContain(`Stopped ${worker.id}`);

    // Settings… stays offered, so the row must still say why the rest went.
    await ui.awaitState("Stopping");
    expect(ui.offers("Settings…")).toBe(true);
    expect(ui.offers("Pause")).toBe(false);
    expect(ui.offers("Stop…")).toBe(false);
    expect(ui.blockedHint()).toContain("between states");

    gates.get(queue)!();
    await until(
      () => worker.state === "stopped",
      () => `the worker is ${worker.state}`,
    );
    await ui.awaitState("Stopped");
    expect(ui.blockedHint()).toBeNull();
  }, 30_000);

  it("pauses a busy worker at once: the toast's Paused is true", async () => {
    const queue = QUEUES.pausing;
    const worker = workerOf(queue);
    await holdJob(queue);
    const { mountWorkerRow } = await load<ActionsModule>(
      ["..", "workers", "realApiActions"].join("/"),
    );
    const ui = await mountWorkerRow(queue, worker.id, fetchShim, CSRF);
    await ui.awaitState("Running");

    const toast = await ui.lifecycle("Pause");
    expect(toast).toContain(`Paused ${worker.id}`);
    // Pausing stops claiming; the job it holds runs on, and the worker is
    // paused already — there is no `pausing` state to wait through.
    expect(worker.state).toBe("paused");
    const record = await reported(queue);
    expect(record).toMatchObject({ state: "paused", active: 1 });
    expect(record.control).toMatchObject({ pending: false });
  }, 30_000);
});
