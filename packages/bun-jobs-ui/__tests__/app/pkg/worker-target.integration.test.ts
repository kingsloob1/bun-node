import type { BunQueueWorker } from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { join } from "node:path";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * Where a worker's attempts run (`WorkerDto.target`), against a REAL
 * `createJobsApi` and real `BunQueueWorker`s built with a target: what the
 * worker reports, what the API serves of it, and what the worker page then
 * shows — the Instances table's badge and the Target card.
 *
 * The processor file's path is deployment detail, served only when the API
 * is built with `serialize.exposeProcessorFiles`. So the same workers are
 * read through two APIs, one with it and one without, and the card must show
 * the path through the first and nothing at all about one through the second.
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

/** What the worker page shows of the target (`../workers/realApiTarget`). */
interface TargetView {
  /** The Instances table's target badge, "Runs in: " included, or `null` when it shows none. */
  badge: string | null;
  /** The Target card's "Runs in" value, or `null` when absent. */
  kind: string | null;
  /** The Target card's "Processor" value, or `null` when absent. */
  processor: string | null;
  /** The Target card's "File" value, or `null` when the card shows none. */
  file: string | null;
  /** The Target card's row labels, in order. */
  labels: string[];
  /** The Target card's whole text. */
  card: string;
}

/** What this file uses of `../workers/realApiTarget`. */
interface TargetModule {
  /** Renders the worker page of `key` on `queue` over `fetch`, and returns a driver. */
  mountTargetPage: (
    fetch: FetchLike,
    csrfHeader: string,
    queue: string,
    key: string,
  ) => Promise<{
    view: () => TargetView;
    awaitView: (ready: (view: TargetView) => boolean) => Promise<TargetView>;
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
/** The processor file the child-process worker is built from. */
const PROCESSOR_FILE = join(
  import.meta.dir,
  "fixtures",
  "worker-target",
  "processor.ts",
);
/** One queue per worker, so each page lists exactly one instance. */
const QUEUES = {
  /** A processor file, each attempt in a fresh child process. */
  child: "exports",
  /** A function, in process: the default target. */
  inProcess: "pings",
} as const;

let jobs: BunJobs;
/** Reads through an API built WITHOUT `exposeProcessorFiles` (the default). */
let plainFetch: FetchLike;
/** Reads through an API built WITH `exposeProcessorFiles`. */
let exposedFetch: FetchLike;
const workers = new Map<string, BunQueueWorker<unknown, unknown>>();

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

/** A `fetch` for the app over `router`, which mounts an API at {@link BASE}. */
function fetchOver(router: BunRouter): FetchLike {
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses.
  return async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const url = new URL(input, "http://localhost");
      const response = await router.fetch(new native.Request(url.href, init));
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
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

/** The one worker record `GET /queues/:queue/workers` serves for `queue`, through `fetch`. */
async function reported(
  fetch: FetchLike,
  queue: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}/queues/${queue}/workers`, {
    method: "GET",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    items: Record<string, unknown>[];
  };
  return body.items[0] ?? {};
}

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-worker-target-integration",
    service: SERVICE,
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  const options = {
    reportInterval: 1_000,
    pollInterval: 10,
    waitToExit: false,
    logger: noopLogger,
  };
  workers.set(
    QUEUES.child,
    jobs.worker<unknown, unknown>(QUEUES.child, PROCESSOR_FILE, {
      ...options,
      target: "child-process",
    }),
  );
  workers.set(
    QUEUES.inProcess,
    jobs.worker<unknown, unknown>(QUEUES.inProcess, async () => "ok", options),
  );
  for (const worker of workers.values()) {
    void worker.run();
  }

  const build = (exposeProcessorFiles: boolean) => {
    const api = createJobsApi({
      jobs,
      mode: "jobs",
      basePath: BASE,
      authorize: () => true,
      logger: noopLogger,
      csrf: { header: CSRF },
      serialize: { exposeProcessorFiles },
    });
    const root = new BunRouter();
    root.use(api.basePath, api.router);
    return fetchOver(root);
  };
  plainFetch = build(false);
  exposedFetch = build(true);

  for (const [queue, worker] of workers) {
    await until(
      async () => (await reported(plainFetch, queue)).id === worker.id,
      () => `worker ${worker.id} never registered on ${queue}`,
    );
  }
});

afterAll(async () => {
  for (const worker of workers.values()) {
    await worker.close({ force: true }).catch(() => undefined);
  }
  await jobs.close();
});

/** Mounts the worker page of the worker consuming `queue`, over `fetch`. */
async function mount(fetch: FetchLike, queue: string) {
  const target = await load<TargetModule>(
    ["..", "workers", "realApiTarget"].join("/"),
  );
  return target.mountTargetPage(fetch, CSRF, queue, `${SERVICE}.${queue}`);
}

describe("a worker's target against a real API", () => {
  it("shows a child-process worker's target, with no file unless the API exposes it", async () => {
    const queue = QUEUES.child;
    // What the API serves by default: the target, without the path.
    const served = await reported(plainFetch, queue);
    expect(served.target).toEqual({ kind: "child-process", processor: "file" });

    const ui = await mount(plainFetch, queue);
    const view = await ui.awaitView((one) => one.kind !== null);
    expect(view.badge).toBe("Runs in: Child process");
    expect(view.kind).toBe("Child process");
    expect(view.processor).toBe("File");
    // Withheld, and nothing on the card hints that a path exists.
    expect(view.file).toBeNull();
    expect(view.labels).toEqual(["Runs in", "Processor"]);
    expect(view.card).not.toContain("processor.ts");
    ui.unmount();
  }, 30_000);

  it("shows the processor file's path through an API built with exposeProcessorFiles", async () => {
    const queue = QUEUES.child;
    const served = await reported(exposedFetch, queue);
    expect(served.target).toEqual({
      kind: "child-process",
      processor: "file",
      file: PROCESSOR_FILE,
    });

    const ui = await mount(exposedFetch, queue);
    const view = await ui.awaitView((one) => one.file !== null);
    expect(view.kind).toBe("Child process");
    expect(view.labels).toEqual(["Runs in", "Processor", "File"]);
    expect(view.file).toBe(PROCESSOR_FILE);
    ui.unmount();
  }, 30_000);

  it("shows a function worker as in process, with a function processor", async () => {
    const queue = QUEUES.inProcess;
    expect((await reported(plainFetch, queue)).target).toEqual({
      kind: "in-process",
      processor: "function",
    });

    const ui = await mount(plainFetch, queue);
    const view = await ui.awaitView((one) => one.kind !== null);
    expect(view.badge).toBe("Runs in: In process");
    expect(view.kind).toBe("In process");
    expect(view.processor).toBe("Function");
    expect(view.file).toBeNull();
    ui.unmount();
  }, 30_000);
});
