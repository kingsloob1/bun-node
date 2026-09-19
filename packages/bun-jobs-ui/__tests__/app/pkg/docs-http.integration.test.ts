import type { FetchLike } from "../../../app/api/client";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The HTTP reference against a REAL `createJobsApi` (memory driver): the
 * document it renders is the one the API serves, and its try-it panel
 * really reaches the API — a read answers the real meta, and `pauseQueue`
 * really pauses the queue, CSRF header and `Content-Type` included.
 *
 * This project compiles without the DOM lib (see tsconfig.json), so the DOM
 * side is loaded by dynamic imports the compiler does not follow:
 * `../dom` for the DOM hooks, and `../docs/http/realApiScreen` for a small
 * driver of the rendered screen. The interfaces below restate the little
 * this file uses of them.
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

/** What this file uses of `../docs/http/realApiScreen` (`HttpDocsDriver`). */
interface ScreenModule {
  /** Renders the reference over `fetch` and returns its driver. */
  mountHttpDocs: (
    fetch: FetchLike,
    csrfHeader: string,
  ) => Promise<{
    operations: () => string[];
    openOperation: (operationId: string) => Promise<void>;
    fill: (name: string, value: string) => void;
    send: () => Promise<{ status: string; text: string }>;
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
/** Every request the app sent, as the API received it. */
const seen: { method: string; path: string; headers: Headers }[] = [];

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

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-docs-http-integration",
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
      const request = new native.Request(
        new URL(input, "http://localhost").href,
        init,
      );
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
      });
      const response = await root.fetch(request);
      // A plain copy the app reads the same under either implementation.
      return new Response(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
  await jobs.queue(QUEUE).add("send", { to: "a@example.com" });
});

afterAll(async () => {
  await jobs.close();
});

describe("the HTTP reference against a real API", () => {
  it("renders the served document, reads getMeta, and really pauses a queue", async () => {
    const screen = await load<ScreenModule>(
      ["..", "docs", "http", "realApiScreen"].join("/"),
    );
    const ui = await screen.mountHttpDocs(fetchShim, CSRF);

    // The sidebar is the served document's operations.
    const ids = ui.operations();
    expect(ids).toContain("getMeta");
    expect(ids).toContain("pauseQueue");
    expect(seen.some((call) => call.path === `${BASE}/openapi.json`)).toBe(
      true,
    );

    await ui.openOperation("getMeta");
    const meta = await ui.send();
    expect(meta.status).toBe("200");
    expect(meta.text).toContain("ui-docs-http-integration");

    expect(await jobs.queue(QUEUE).isPaused()).toBe(false);
    await ui.openOperation("pauseQueue");
    ui.fill("queue", QUEUE);
    const paused = await ui.send();
    expect(paused.status).toBe("200");
    expect(paused.text).toContain("paused");
    expect(await jobs.queue(QUEUE).isPaused()).toBe(true);

    const post = seen.find(
      (call) =>
        call.method === "POST" && call.path === `${BASE}/queues/${QUEUE}/pause`,
    )!;
    expect(post.headers.get(CSRF)).toBe("1");
    expect(post.headers.get("content-type")).toBe("application/json");
  });
});
