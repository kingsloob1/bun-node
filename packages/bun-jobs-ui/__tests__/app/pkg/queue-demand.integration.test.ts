import type { FetchLike } from "../../../app/api/client";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * A queue's demand against a REAL `createJobsApi`: what `GET
 * /queues/:queue/demand` and `GET /demand` answer, and what the queue
 * screen's Demand panel and the Overview's Demand column then show.
 *
 * Two deployments. One on the memory driver, which counts demand directly
 * (`exact: true`). One on a memory driver with `countDemand` shadowed, so the
 * API takes its fallback and answers `exact: false` — the case the UI must
 * mark approximate, since `/meta` carries no signal for it.
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

/** What the Demand panel shows (`../queues/realApiDemand`). */
interface DemandPanelView {
  /** Each figure's text, by name. */
  figures: Record<string, string>;
  /** Which notes are shown: `paused`, `capped`, `approximate`. */
  notes: string[];
  /** The JSON and Prometheus URLs it gives. */
  urls: { json: string; prometheus: string };
  /** Whether it shows a next due time. */
  nextDue: boolean;
}

/** What this file uses of `../queues/realApiDemand`. */
interface DemandModule {
  /** Renders `queue`'s Demand panel over `fetch` and reads it. */
  readDemandPanel: (
    fetch: FetchLike,
    csrfHeader: string,
    queue: string,
  ) => Promise<{ view: DemandPanelView; unmount: () => void }>;
  /** Renders the Overview over `fetch` and reads each queue's Demand cell. */
  readOverviewDemand: (
    fetch: FetchLike,
    csrfHeader: string,
    queues: readonly string[],
  ) => Promise<{ cells: Record<string, string>; unmount: () => void }>;
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
/** A queue with work to claim and a delayed job an hour out. */
const BUSY = "orders";
/** A queue with a backlog, paused. */
const PAUSED = "exports";

/** A memory driver whose `countDemand` is absent, so the API falls back. */
class FallbackDriver extends MemoryDriver {}
Object.defineProperty(FallbackDriver.prototype, "countDemand", {
  value: undefined,
});

/** One deployment: its context and a `fetch` over its API. */
interface Deployment {
  /** The context. */
  jobs: BunJobs;
  /** Reads through its API. */
  fetch: FetchLike;
}

let exact: Deployment;
let fallback: Deployment;

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

/** Builds a deployment on `driver` with the two queues seeded. */
async function deploy(
  namespace: string,
  driver: MemoryDriver,
): Promise<Deployment> {
  const jobs = new BunJobs({ namespace, driver, logger: noopLogger });
  const busy = jobs.queue(BUSY);
  for (let i = 0; i < 3; i++) {
    await busy.add("ship", { i });
  }
  await busy.add("remind", {}, { delay: 3_600_000 });
  const paused = jobs.queue(PAUSED);
  await paused.add("export", {});
  await paused.add("export", {});
  await paused.pause();
  const api = createJobsApi({
    jobs,
    mode: "jobs",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    csrf: { header: CSRF },
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  return { jobs, fetch: fetchOver(root) };
}

/** What `GET /queues/:queue/demand` answers through `deployment`. */
async function answered(
  deployment: Deployment,
  queue: string,
): Promise<Record<string, unknown>> {
  const response = await deployment.fetch(`${BASE}/queues/${queue}/demand`, {
    method: "GET",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** The DOM side. */
function ui(): Promise<DemandModule> {
  return load<DemandModule>(["..", "queues", "realApiDemand"].join("/"));
}

beforeAll(async () => {
  exact = await deploy("ui-demand-exact", new MemoryDriver());
  fallback = await deploy("ui-demand-fallback", new FallbackDriver());
});

afterAll(async () => {
  await exact.jobs.close();
  await fallback.jobs.close();
});

describe("a queue's demand against a real API", () => {
  it("shows the figures the API answers for a queue with work, exact and unmarked", async () => {
    const served = await answered(exact, BUSY);
    expect(served).toMatchObject({
      queue: BUSY,
      paused: false,
      waiting: 3,
      demand: 3,
      outstanding: 3,
      exact: true,
      capped: false,
    });
    expect(typeof served.nextDueAt).toBe("number");

    const { view, unmount } = await (
      await ui()
    ).readDemandPanel(exact.fetch, CSRF, BUSY);
    expect(view.figures).toMatchObject({
      demand: "3",
      outstanding: "3",
      waiting: "3",
      dueNow: String(served.dueNow),
      stalled: "0",
      active: "0",
      workers: "0",
    });
    expect(view.notes).toEqual([]);
    expect(view.nextDue).toBe(true);
    expect(new URL(view.urls.json).pathname).toBe(
      `${BASE}/queues/${BUSY}/demand`,
    );
    unmount();
  }, 30_000);

  it("says a paused queue demands nothing over its backlog", async () => {
    expect(await answered(exact, PAUSED)).toMatchObject({
      paused: true,
      waiting: 2,
      demand: 0,
      outstanding: 0,
    });
    const { view, unmount } = await (
      await ui()
    ).readDemandPanel(exact.fetch, CSRF, PAUSED);
    expect(view.figures.demand).toBe("0");
    expect(view.figures.waiting).toBe("2");
    expect(view.notes).toEqual(["paused"]);
    unmount();
  }, 30_000);

  it("serves the Prometheus exposition at the URL the panel gives", async () => {
    const response = await exact.fetch(
      `${BASE}/queues/${BUSY}/demand?format=prometheus`,
      { method: "GET" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("marks the fallback's figures approximate where the backend cannot count demand", async () => {
    expect(await answered(fallback, BUSY)).toMatchObject({
      waiting: 3,
      exact: false,
    });
    const { view, unmount } = await (
      await ui()
    ).readDemandPanel(fallback.fetch, CSRF, BUSY);
    expect(view.figures.demand.startsWith("≈")).toBe(true);
    expect(view.figures.dueNow.startsWith("≈")).toBe(true);
    // Counted directly even by the fallback.
    expect(view.figures.waiting).toBe("3");
    expect(view.notes).toEqual(["approximate"]);
    unmount();
  }, 30_000);

  it("fills the Overview's Demand column from one GET /demand", async () => {
    const { cells, unmount } = await (
      await ui()
    ).readOverviewDemand(exact.fetch, CSRF, [BUSY, PAUSED]);
    expect(cells).toEqual({ [BUSY]: "3", [PAUSED]: "0" });
    unmount();

    const approximate = await (
      await ui()
    ).readOverviewDemand(fallback.fetch, CSRF, [BUSY]);
    expect(approximate.cells[BUSY]).toBe("≈3");
    approximate.unmount();
  }, 30_000);
});
