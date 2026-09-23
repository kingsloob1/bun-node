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
 * The worker CONTROL surface against a REAL `createJobsApi` with real
 * `BunQueueWorker`s: pausing, resuming, stopping, starting and reconfiguring
 * from a worker's row really change the worker, as the API and the worker
 * object then both report.
 *
 * Compiled without the DOM lib (see tsconfig.json): the DOM side is loaded by
 * dynamic imports the compiler does not follow, and the interfaces below
 * restate the little this file uses of them.
 *
 * Each scenario owns its own queue and worker, so no test depends on another
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

/** One lifecycle button a row offers. */
type LifecycleButton = "Pause" | "Resume" | "Start";

/** What this file uses of `../workers/realApiActions`. */
interface ActionsModule {
  /** Renders one worker's row over `fetch` and returns a driver for it. */
  mountWorkerRow: (
    queue: string,
    id: string,
    fetch: FetchLike,
    csrfHeader: string,
    pollMs?: number,
  ) => Promise<{
    state: () => string;
    awaitState: (label: string) => Promise<void>;
    offers: (name: string) => boolean;
    memory: () => string;
    awaitButton: (name: string) => Promise<void>;
    lifecycle: (name: LifecycleButton) => Promise<string>;
    refuse: (name: LifecycleButton) => Promise<string>;
    stop: () => Promise<string>;
    configure: (setting: string, value: number) => Promise<string>;
    resetConfig: () => Promise<string>;
    settingsText: () => Promise<string>;
  }>;
}

/** One request the UI made, with what the API answered. */
interface Exchange {
  /** The method. */
  method: string;
  /** The path, without the query. */
  path: string;
  /** The query string, without the `?`. */
  query: string;
  /** The request body as sent, or `undefined` when there was none. */
  body: string | undefined;
  /** The status the API answered with. */
  status: number;
  /** The parsed answer, for a JSON body. */
  json: unknown;
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
/** The queue each scenario consumes; one per scenario, so they never interfere. */
const QUEUES = {
  /** Pause, resume and the `?wait=` proof. */
  lifecycle: "emails",
  /** Stop keeping the worker registered, then Start. */
  parking: "reports",
  /** The config override and its reset. */
  config: "digests",
  /** The refusal after the worker moved on. */
  refusal: "invoices",
  /** The Memory column, read from what a live worker really reports. */
  memory: "memos",
} as const;

/** What the workers' own code asks for, so an override is recognisable as one. */
const CODE_CONCURRENCY = 2;

let jobs: BunJobs;
let fetchShim: FetchLike;
const workers = new Map<string, BunQueueWorker<unknown, unknown>>();
const exchanges: Exchange[] = [];

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

/** The worker consuming `queue`, started in `beforeAll`. */
function workerOf(queue: string): BunQueueWorker<unknown, unknown> {
  return workers.get(queue)!;
}

/** Every exchange whose path ends with `suffix`, oldest first. */
function callsTo(suffix: string): Exchange[] {
  return exchanges.filter((one) => one.path.endsWith(suffix));
}

/** The worker records a listing reports, from `path`. */
async function listed(path: string): Promise<Record<string, unknown>[]> {
  const response = await fetchShim(`${BASE}${path}`, { method: "GET" });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    items: Record<string, unknown>[];
  };
  return body.items;
}

/** The one worker record `GET /queues/:queue/workers` reports for `queue`. */
async function reported(queue: string): Promise<Record<string, unknown>> {
  return (await listed(`/queues/${queue}/workers`))[0] ?? {};
}

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-worker-actions-integration",
    service: SERVICE,
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  for (const queue of Object.values(QUEUES)) {
    const worker = jobs.worker<unknown, unknown>(queue, async () => "ok", {
      concurrency: CODE_CONCURRENCY,
      reportInterval: 1_000,
      pollInterval: 10,
      waitToExit: false,
      logger: noopLogger,
    });
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
    // `workers.configure` is opt-in, so the default list leaves it out.
    actions: [...JOBS_API_ACTIONS],
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses.
  fetchShim = async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const url = new URL(input, "http://localhost");
      const body = typeof init.body === "string" ? init.body : undefined;
      const response = await root.fetch(new native.Request(url.href, init));
      const text = await response.text();
      let json: unknown;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      exchanges.push({
        method: (init.method ?? "GET").toUpperCase(),
        path: url.pathname,
        query: url.search.replace(/^\?/, ""),
        body,
        status: response.status,
        json,
      });
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });

  // Every worker must be in the registry before a row can control it.
  for (const queue of Object.values(QUEUES)) {
    const id = workerOf(queue).id;
    await until(
      async () => (await reported(queue)).id === id,
      () => `worker ${id} never registered on ${queue}`,
    );
  }
});

afterAll(async () => {
  for (const worker of workers.values()) {
    await worker.close({ force: true }).catch(() => undefined);
  }
  await jobs.close();
});

/**
 * Mounts the row of the worker consuming `queue`. `pollMs` is how often the
 * row re-reads `GET /workers` on its own; a scenario that needs the row to
 * hold a view the worker has moved on from passes a long one.
 */
async function mount(queue: string, pollMs?: number) {
  const actions = await load<ActionsModule>(
    ["..", "workers", "realApiActions"].join("/"),
  );
  return actions.mountWorkerRow(
    queue,
    workerOf(queue).id,
    fetchShim,
    CSRF,
    pollMs,
  );
}

describe("a worker's row against a real API", () => {
  it("pauses and resumes the live worker, waiting for it through `?wait=`", async () => {
    const queue = QUEUES.lifecycle;
    const worker = workerOf(queue);
    const ui = await mount(queue);
    await ui.awaitState("Running");

    const paused = await ui.lifecycle("Pause");
    // (4) The wait travels in the query, so the memory driver's worker
    // acknowledges within the call: the message is the done one.
    const pauseCall = callsTo(`/workers/${worker.id}/pause`).at(-1)!;
    expect(pauseCall.query).toBe("wait=2000");
    expect(pauseCall.body).toBeUndefined();
    expect(pauseCall.status).toBe(200);
    expect(pauseCall.json).toMatchObject({ desired: "paused", applied: true });
    expect(paused).toContain(`Paused ${worker.id}`);
    expect(paused).not.toContain("Asked");

    // (1) The real worker is paused, and the API says so too.
    expect(worker.state).toBe("paused");
    expect(worker.isPaused()).toBe(true);
    expect((await reported(queue)).state).toBe("paused");
    await ui.awaitState("Paused");

    const resumed = await ui.lifecycle("Resume");
    const resumeCall = callsTo(`/workers/${worker.id}/resume`).at(-1)!;
    expect(resumeCall.query).toBe("wait=2000");
    expect(resumeCall.status).toBe(200);
    expect(resumeCall.json).toMatchObject({
      desired: "running",
      applied: true,
    });
    expect(resumed).toContain(`Resumed ${worker.id}`);
    expect(resumed).not.toContain("Asked");
    expect(worker.state).toBe("running");
    expect(worker.isPaused()).toBe(false);
    expect((await reported(queue)).state).toBe("running");
    await ui.awaitState("Running");
  }, 30_000);

  it("stops the worker but keeps it listed, and starts it again", async () => {
    const queue = QUEUES.parking;
    const worker = workerOf(queue);
    const ui = await mount(queue);
    await ui.awaitState("Running");

    // (2) Stop parks the worker; it stays in the registry so Start can reach it.
    const stopped = await ui.stop();
    expect(stopped).toContain(`Stopped ${worker.id}`);
    await until(
      () => worker.state === "stopped",
      () => `the worker is ${worker.state}`,
    );

    const record = await reported(queue);
    expect(record.id).toBe(worker.id);
    expect(record.state).toBe("stopped");
    // Still listed by the namespace-wide read the Workers screen uses — the
    // whole point of Stop over closing the worker in code.
    expect(
      (await listed("/workers")).find((one) => one.id === worker.id),
    ).toMatchObject({ id: worker.id, queue, state: "stopped" });
    await ui.awaitState("Stopped");
    expect(ui.offers("Pause")).toBe(false);
    expect(ui.offers("Resume")).toBe(false);
    await ui.awaitButton("Start");

    const started = await ui.lifecycle("Start");
    expect(started).toContain(`Started ${worker.id}`);
    await until(
      () => worker.state === "running",
      () => `the worker is ${worker.state}`,
    );
    expect((await reported(queue)).state).toBe("running");
    await ui.awaitState("Running");
  }, 30_000);

  it("writes a config override the live worker adopts, then resets it", async () => {
    const queue = QUEUES.config;
    const worker = workerOf(queue);
    const key = `${SERVICE}.${queue}`;
    expect(worker.key).toBe(key);
    const ui = await mount(queue);
    await ui.awaitState("Running");
    expect(worker.concurrency).toBe(CODE_CONCURRENCY);

    // (3) The dialog writes against the STABLE KEY, not the incarnation id.
    const saved = await ui.configure("concurrency", 5);
    expect(saved).toContain(`Saved the settings of ${key}`);
    const put = callsTo(`/worker-configs/${key}`).filter(
      (one) => one.method === "PUT",
    );
    expect(put).toHaveLength(1);
    expect(put[0]!.status).toBe(200);
    expect(JSON.parse(put[0]!.body!)).toEqual({
      concurrency: 5,
      expectedSeq: 0,
    });

    // The live worker adopts it, and then reports it as an override.
    await until(
      () => worker.concurrency === 5,
      () => `concurrency is ${worker.concurrency}`,
    );
    await until(
      async () => {
        const config = (await reported(queue)).config as
          | { overridden: string[] }
          | undefined;
        return config?.overridden.includes("concurrency") === true;
      },
      () => "the worker never reported the override",
    );
    const overridden = (await reported(queue)).config as {
      effective: Record<string, number>;
      code: Record<string, number>;
      overridden: string[];
    };
    expect(overridden.effective.concurrency).toBe(5);
    expect(overridden.code.concurrency).toBe(CODE_CONCURRENCY);
    expect(overridden.overridden).toEqual(["concurrency"]);

    // The dialog now shows it as an override of what the code asks for.
    await until(
      async () => (await ui.settingsText()).includes("Overridden"),
      () => "the dialog never called concurrency overridden",
    );
    expect(await ui.settingsText()).toContain(
      `Overridden; its code asks for ${CODE_CONCURRENCY}`,
    );

    const reset = await ui.resetConfig();
    expect(reset).toContain(`Reset ${key} to the values in its code`);
    await until(
      () => worker.concurrency === CODE_CONCURRENCY,
      () => `concurrency is ${worker.concurrency}`,
    );
    await until(
      async () => {
        const config = (await reported(queue)).config as
          | { overridden: string[] }
          | undefined;
        return config?.overridden.length === 0;
      },
      () => "the worker never dropped the override",
    );
  }, 60_000);

  it("explains a refusal when the worker moved on behind the row", async () => {
    const queue = QUEUES.refusal;
    const worker = workerOf(queue);
    // No polling: the row must keep the view it had when the operator read
    // it, which is the only way this refusal happens to a real user.
    const ui = await mount(queue, 600_000);
    await ui.awaitState("Running");

    // Pause through the row, so it offers Resume…
    expect(await ui.lifecycle("Pause")).toContain("Paused");
    await ui.awaitButton("Resume");

    // …then somebody stops it elsewhere, without the row hearing of it.
    await jobs.workers.remote(queue).stop({ id: worker.id });
    await until(
      () => worker.state === "stopped",
      () => `the worker is ${worker.state}`,
    );

    // (5) Resume on a stopped worker is 409 WORKER_STATE_CONFLICT, and the
    // row says what to do instead.
    const refused = await ui.refuse("Resume");
    const call = callsTo(`/workers/${worker.id}/resume`).at(-1)!;
    expect(call.status).toBe(409);
    expect(call.json).toMatchObject({ code: "WORKER_STATE_CONFLICT" });
    expect(refused).toContain(`Could not resume ${worker.id}`);
    expect(refused).toContain("no longer in the state that action needs");
    expect(refused).toContain("a stopped worker is started, not resumed");
  }, 30_000);

  it("shows the process memory a live worker really reports", async () => {
    const queue = QUEUES.memory;
    // What the worker wrote with its heartbeat, straight off the API.
    const rssBytes = (await reported(queue)).rssBytes;
    expect(typeof rssBytes).toBe("number");
    // A Bun process: more than a megabyte, less than a terabyte.
    expect(rssBytes as number).toBeGreaterThan(1024 * 1024);
    expect(rssBytes as number).toBeLessThan(1024 ** 4);

    const ui = await mount(queue);
    await ui.awaitState("Running");
    // The column is there, and carries a size — never the dash, and never 0 B.
    await until(
      () => /^[\d,.]+ (?:B|KiB|MiB|GiB)$/.test(ui.memory()),
      () => `the Memory cell reads "${ui.memory()}"`,
    );
    const shown = ui.memory();
    expect(shown).not.toBe("—");
    expect(shown).not.toBe("0 B");
    expect(Number.parseFloat(shown.replace(/,/g, ""))).toBeGreaterThan(0);
  }, 30_000);
});
