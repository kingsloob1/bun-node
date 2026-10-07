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
 * The queue screen's Add flow dialog against a REAL `createJobsApi` (memory
 * driver, every action with the opt-in `jobs.add`, any name addable, CSRF
 * on): a flow with a child in a second queue is built and sent through the
 * dialog, then read back through the API, so this proves the body the UI
 * builds is one the API accepts and turns into a flow.
 *
 * Compiled without the DOM lib (see tsconfig.json): the DOM side is loaded by
 * a dynamic import the compiler does not follow, and the interfaces below
 * restate the little this file uses of it.
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

/** What this file uses of `../job/realApiAddFlow`. */
interface AddFlowModule {
  /** Renders `/queues/:queue` over `fetch` and returns a driver. */
  mountQueueForFlow: (
    fetch: FetchLike,
    csrfHeader: string,
    queue: string,
  ) => Promise<{
    addFlow: (input: {
      topName: string;
      childName: string;
      childQueue: string;
    }) => Promise<{ text: string; topHref: string }>;
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

let jobs: BunJobs;
let fetchApi: FetchLike;

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

/** `GET` of an API path, parsed. */
async function read<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetchApi(`${BASE}${path}`, { method: "GET" });
  return { status: response.status, body: (await response.json()) as T };
}

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-add-flow-integration",
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  const api = createJobsApi({
    jobs,
    mode: "jobs",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    limits: { queueCacheMs: 0 },
    csrf: { header: CSRF },
    // Every action, the opt-in jobs.add included, and any name.
    actions: [...JOBS_API_ACTIONS],
    addableNames: "any",
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  fetchApi = fetchOver(root);
});

afterAll(async () => {
  await jobs.close();
});

describe("the Add flow dialog against a real API", () => {
  it("adds a flow with a child in a second queue, the parent waiting on it", async () => {
    const meta = await read<{
      features: { addFlow: boolean };
      addableNames: string[] | null;
    }>("/meta");
    expect(meta.body.features.addFlow).toBe(true);
    expect(meta.body.addableNames).toBe(null);

    // The queue screen needs its queue to exist: one job makes it.
    const seeded = await fetchApi(`${BASE}/queues/emails/jobs`, {
      method: "POST",
      headers: { [CSRF]: "1", "content-type": "application/json" },
      body: JSON.stringify({ name: "seed", data: null }),
    });
    expect(seeded.status).toBe(201);

    const ui = await load<AddFlowModule>(
      ["..", "job", "realApiAddFlow"].join("/"),
    );
    const screen = await ui.mountQueueForFlow(fetchApi, CSRF, "emails");
    const outcome = await screen.addFlow({
      topName: "assemble-report",
      childName: "fetch-figures",
      childQueue: "reports",
    });
    screen.unmount();
    expect(outcome.text).toContain("Added 2 jobs.");
    const prefix = "/jobs/queues/emails/jobs/";
    expect(outcome.topHref.startsWith(prefix)).toBe(true);
    const topId = decodeURIComponent(outcome.topHref.slice(prefix.length));

    const top = await read<{ name: string; state: string }>(
      `/queues/emails/jobs/${encodeURIComponent(topId)}`,
    );
    expect(top.status).toBe(200);
    expect(top.body.name).toBe("assemble-report");
    expect(top.body.state).toBe("waiting-children");

    const children = await read<{
      pending: number;
      children: {
        queue: string;
        id: string;
        job: { name: string; state: string } | null;
      }[];
    }>(`/queues/emails/jobs/${encodeURIComponent(topId)}/children`);
    expect(children.status).toBe(200);
    expect(children.body.pending).toBe(1);
    expect(children.body.children).toHaveLength(1);
    const [child] = children.body.children;
    expect(child?.queue).toBe("reports");
    expect(child?.job?.name).toBe("fetch-figures");
    expect(child?.job?.state).toBe("waiting");
  }, 30_000);
});
