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
 * The queue screen's HOUSEKEEPING NOTE against a REAL `createJobsApi` with
 * real `BunQueueWorker`s: what `maintenance` does to a worker, what the API
 * then reports as `WorkerDto.sweeps`, and what the Workers panel says about
 * it.
 *
 * Nothing here fakes `sweeps`. Every value asserted came off
 * `GET /queues/:queue/workers` after a live worker wrote it with its
 * heartbeat, which is the only way to prove the UI's rule is about the real
 * field and not about a fixture's spelling of it.
 *
 * The last scenario is the reason the field exists: `maintenance: false`
 * turns off the queue's TIDYING only. Liveness — promoting a delayed job,
 * retrying a failed one — is unconditional, so a queue whose only worker
 * sweeps nothing still runs its jobs. That is asserted against the real API
 * rather than taken from the option's documentation.
 *
 * Compiled without the DOM lib (see tsconfig.json): the DOM side is loaded by
 * dynamic imports the compiler does not follow, and the interfaces below
 * restate the little this file uses of them.
 *
 * Each scenario owns its own queue and workers, so no test depends on another
 * having run (the suite must pass under `bun test --randomize`).
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

/** The housekeeping note as the panel renders it. */
interface SweepNote {
  /** Its whole text. */
  text: string;
  /** Its `data-uncertain` attribute, verbatim. */
  uncertain: string;
}

/** What this file uses of `../workers/realApiSweeps`. */
interface SweepsModule {
  /** Renders one queue's Workers panel over `fetch` and returns a driver for it. */
  mountWorkersPanel: (
    queue: string,
    fetch: FetchLike,
    csrfHeader: string,
  ) => Promise<{
    note: () => SweepNote | null;
    rows: () => string[];
    awaitRows: (ids: readonly string[]) => Promise<void>;
    awaitNote: () => Promise<SweepNote>;
    awaitNoNote: (ids: readonly string[]) => Promise<void>;
    refresh: () => Promise<void>;
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
const SERVICE = "billing";

/** The queue each scenario owns; one per scenario, so they never interfere. */
const QUEUES = {
  /** One worker, `maintenance: false`: the note, without hedging. */
  untidy: "emails",
  /** A `maintenance: false` worker joined by a sweeping one: the note goes. */
  joined: "reports",
  /** One worker with `maintenance` left alone: never a note. */
  tidy: "digests",
  /** One worker, `maintenance: false`: its jobs still run. */
  liveness: "invoices",
} as const;

/** A generous ceiling for a scenario that waits on heartbeats and polls. */
const TEST_TIMEOUT_MS = 60_000;

let jobs: BunJobs;
let fetchShim: FetchLike;
/** Every worker started here, closed in `afterAll` whoever started it. */
const started: BunQueueWorker<unknown, unknown>[] = [];
/** The jobs the liveness queue's worker ran, by the `kind` in their data. */
const ran: string[] = [];
/** Whether the liveness queue's retry job has already failed once. */
let failedOnce = false;

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
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${what()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Starts a worker on `queue` and registers it for cleanup. `maintenance` is
 * passed only when the scenario asks for one, so the "tidy" queues run the
 * option's real default rather than an explicit `true`.
 */
function startWorker(
  queue: string,
  maintenance?: boolean,
): BunQueueWorker<unknown, unknown> {
  const worker = jobs.worker<unknown, unknown>(
    queue,
    async (job) => {
      const kind = (job.data as { kind?: string } | undefined)?.kind;
      if (kind === "retry" && !failedOnce) {
        failedOnce = true;
        throw new Error("the first attempt fails on purpose");
      }
      if (kind !== undefined) {
        ran.push(kind);
      }
      return "ok";
    },
    {
      concurrency: 1,
      reportInterval: 1_000,
      pollInterval: 10,
      waitToExit: false,
      logger: noopLogger,
      ...(maintenance === undefined ? {} : { maintenance }),
    },
  );
  started.push(worker);
  void worker.run();
  return worker;
}

/** The items of a listing, from `path` under the API's base. */
async function listed(path: string): Promise<Record<string, unknown>[]> {
  const response = await fetchShim(`${BASE}${path}`, { method: "GET" });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    items: Record<string, unknown>[];
  };
  return body.items;
}

/**
 * The live worker records `GET /queues/:queue/workers` reports, by id.
 *
 * A queue the driver has not heard of yet is a 404 `QUEUE_NOT_FOUND`, which
 * is how this reads in the moment between starting a worker and its first
 * heartbeat: no workers, rather than a failure.
 */
async function reportedWorkers(
  queue: string,
): Promise<Map<string, Record<string, unknown>>> {
  const response = await fetchShim(`${BASE}/queues/${queue}/workers`, {
    method: "GET",
  });
  if (response.status === 404) {
    const problem = (await response.json()) as { code?: string };
    expect(problem.code).toBe("QUEUE_NOT_FOUND");
    return new Map();
  }
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    items: Record<string, unknown>[];
  };
  return new Map(body.items.map((item) => [item.id as string, item]));
}

/** What the API reports as `sweeps` for worker `id` on `queue`. */
async function reportedSweeps(
  queue: string,
  id: string,
): Promise<boolean | undefined> {
  return (await reportedWorkers(queue)).get(id)?.sweeps as boolean | undefined;
}

/** Waits until `GET /queues/:queue/workers` lists exactly `ids`. */
async function awaitRegistered(queue: string, ids: readonly string[]) {
  let seen: string[] = [];
  await until(
    async () => {
      const listing = await reportedWorkers(queue);
      seen = [...listing.keys()];
      return listing.size === ids.length && ids.every((id) => listing.has(id));
    },
    () => `${queue} lists [${seen.join(", ")}], not [${ids.join(", ")}]`,
  );
}

/** Mounts the Workers panel of `queue`. */
async function mount(queue: string) {
  const module = await load<SweepsModule>(
    ["..", "workers", "realApiSweeps"].join("/"),
  );
  return module.mountWorkersPanel(queue, fetchShim, CSRF);
}

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-sweeps-warning-integration",
    service: SERVICE,
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  const api = createJobsApi({
    jobs,
    mode: "jobs",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    csrf: { header: CSRF },
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
});

afterAll(async () => {
  for (const worker of started) {
    await worker.close({ force: true }).catch(() => undefined);
  }
  // The memory driver holds this namespace alone, so closing it removes
  // exactly what this file created and nothing a neighbour owns.
  await jobs.close();
});

describe("the housekeeping note against a real API", () => {
  it(
    "warns when the queue's only live worker really runs no sweeps",
    async () => {
      const queue = QUEUES.untidy;
      const worker = startWorker(queue, false);
      await awaitRegistered(queue, [worker.id]);

      // (1) The value under test came off the real API, written by the live
      // worker's own heartbeat — never a fixture.
      expect(await reportedSweeps(queue, worker.id)).toBe(false);

      const panel = await mount(queue);
      const note = await panel.awaitNote();
      // Certain, because the one live worker answered.
      expect(note.uncertain).toBe("false");
      expect(note.text).toContain(
        "No live worker on this queue runs housekeeping",
      );
      // And it says the queue is untidy, not stopped.
      expect(note.text).toContain("Jobs still run");
      expect(note.text).not.toContain("stuck");
      panel.unmount();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drops the note once a second live worker really sweeps",
    async () => {
      const queue = QUEUES.joined;
      const first = startWorker(queue, false);
      await awaitRegistered(queue, [first.id]);
      expect(await reportedSweeps(queue, first.id)).toBe(false);

      const panel = await mount(queue);
      await panel.awaitRows([first.id]);
      expect((await panel.awaitNote()).uncertain).toBe("false");

      // (2) A worker with `maintenance` left at its default joins the queue.
      const second = startWorker(queue);
      await awaitRegistered(queue, [first.id, second.id]);
      let seen: boolean | undefined;
      await until(
        async () => {
          seen = await reportedSweeps(queue, second.id);
          return seen === true;
        },
        () => `the API reports sweeps=${String(seen)} for ${second.id}`,
      );
      // The first worker still reports `false`: nothing about it changed.
      expect(await reportedSweeps(queue, first.id)).toBe(false);
      expect(await reportedSweeps(queue, second.id)).toBe(true);

      // On the panel's next read of the same endpoint, the note is gone.
      await panel.refresh();
      await panel.awaitNoNote([first.id, second.id]);
      panel.unmount();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "says nothing about a queue whose worker sweeps by default",
    async () => {
      const queue = QUEUES.tidy;
      const worker = startWorker(queue);
      await awaitRegistered(queue, [worker.id]);

      // (3) `maintenance` defaults to on, and the worker reports it.
      expect(await reportedSweeps(queue, worker.id)).toBe(true);

      const panel = await mount(queue);
      await panel.awaitNoNote([worker.id]);
      // Still nothing after another real read, not merely before the first.
      await panel.refresh();
      await panel.awaitRows([worker.id]);
      expect(panel.note()).toBeNull();
      panel.unmount();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps running jobs on a queue whose only worker sweeps nothing",
    async () => {
      const queue = QUEUES.liveness;
      const worker = startWorker(queue, false);
      await awaitRegistered(queue, [worker.id]);
      expect(await reportedSweeps(queue, worker.id)).toBe(false);

      // (4) Both of the promotions `maintenance: false` used to strand: a
      // delayed job becoming due, and a failed job's retry coming back out of
      // `delayed`.
      const delayed = await jobs
        .queue(queue)
        .add("later", { kind: "delayed" }, { delay: 300, attempts: 1 });
      const retried = await jobs
        .queue(queue)
        .add("flaky", { kind: "retry" }, { attempts: 2, backoff: 200 });

      await until(
        () => ran.includes("delayed") && ran.includes("retry"),
        () => `the worker ran [${ran.join(", ")}]`,
      );
      // The API agrees: both jobs are completed, on a queue nobody sweeps.
      await until(
        async () => {
          const completed = await listed(
            `/queues/${queue}/jobs?state=completed`,
          );
          const ids = new Set(completed.map((job) => job.id as string));
          return ids.has(delayed.id) && ids.has(retried.id);
        },
        () => "the API never reported both jobs completed",
      );
      // The retry really did take a second attempt through `delayed`.
      expect(failedOnce).toBe(true);
      // And the worker that ran them still reports that it sweeps nothing.
      expect(await reportedSweeps(queue, worker.id)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
