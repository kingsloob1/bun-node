import type { BunRunner } from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The runner history's pager against a REAL `createJobsApi`, over a real
 * local `BunRunner` with more stored runs than a page holds.
 *
 * The point is that the pages come from the server: page two holds runs page
 * one never had, the total is the whole history rather than what was fetched,
 * and an offset past the end answers an empty page without claiming the
 * runner has never run. A mocked handler can be made to agree with any of
 * that; the route is what decides here.
 *
 * Like `runners.integration.test.ts`, this project compiles without the DOM
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

/** What this file uses of `../runners/realApiHistoryPaging`. */
interface PagingModule {
  /** Renders the runner screen and returns one view per page visited. */
  mountHistoryPages: (
    id: string,
    fetch: FetchLike,
    query: string,
    turns: number,
  ) => Promise<
    {
      /** The run ids in the table. */
      runIds: string[];
      /** The pager's range text. */
      range: string;
      /** Whether the page starts past the end of the history. */
      emptyPage: boolean;
      /** Whether the runner has never run. */
      neverRan: boolean;
      /** Whether Clear history… is disabled. */
      clearDisabled: boolean;
    }[]
  >;
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

/** Runs stored before the screens look; two pages of ten and a short third. */
const RUNS = 22;

/** The page size the screens ask for, as `?history=`. */
const PAGE = 10;

let jobs: BunJobs;
let runner: BunRunner;
let fetchShim: FetchLike;
/** Every `/history` request the API served, as its query string. */
let historyQueries: string[] = [];

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
async function until(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the runner");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-history-paging-integration",
    driver: new MemoryDriver(),
  });
  runner = jobs.runner({
    id: "nightly",
    name: "Nightly report",
    file: new URL("./fixtures/report-runner.ts", import.meta.url),
    executionMode: "in-process",
    // No schedule: every run here is one this test asked for.
    keepHistory: RUNS * 2,
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
      const url = new URL(input, "http://localhost");
      if (url.pathname.endsWith("/history")) {
        historyQueries.push(url.search);
      }
      const response = await root.fetch(new native.Request(url.href, init));
      // A plain copy the app reads the same under either implementation.
      return new Response(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });

  for (let index = 0; index < RUNS; index++) {
    await runner.trigger();
    // One at a time, settled before the next: `runMode: "single"` skips a
    // trigger that arrives while a run is in flight, and the history's order
    // is then the order they ran in.
    await until(
      async () =>
        runner.activeRuns.size === 0 &&
        (await runner.history()).length === index + 1,
    );
  }
  // 22 real in-process runs, one at a time: well past the default hook budget.
}, 120_000);

afterAll(async () => {
  await jobs.close();
});

describe("the runner history against a real API", () => {
  it("serves page two from the server, with the whole history's total", async () => {
    historyQueries = [];
    const screens = await load<PagingModule>(
      ["..", "runners", "realApiHistoryPaging"].join("/"),
    );
    const [first, second, third] = await screens.mountHistoryPages(
      "nightly",
      fetchShim,
      `?history=${PAGE}`,
      2,
    );

    expect(first!.runIds).toHaveLength(PAGE);
    expect(second!.runIds).toHaveLength(PAGE);
    expect(third!.runIds).toHaveLength(RUNS - 2 * PAGE);
    // Page two holds runs page one never had: the rows were read, not sliced.
    expect(
      first!.runIds.filter((id) => second!.runIds.includes(id)),
    ).toHaveLength(0);
    expect(
      new Set([...first!.runIds, ...second!.runIds, ...third!.runIds]).size,
    ).toBe(RUNS);

    // The total is the whole history, not the page.
    expect(first!.range).toBe(`1–${PAGE} of ${RUNS}`);
    expect(second!.range).toBe(`${PAGE + 1}–${2 * PAGE} of ${RUNS}`);
    expect(third!.range).toBe(`${2 * PAGE + 1}–${RUNS} of ${RUNS}`);

    // Every page is a request, and each carries the window it asked for.
    const offsets = historyQueries.map((search) =>
      new URLSearchParams(search).get("offset"),
    );
    expect(offsets).toContain("0");
    expect(offsets).toContain(String(PAGE));
    expect(offsets).toContain(String(2 * PAGE));
    for (const search of historyQueries) {
      const query = new URLSearchParams(search);
      expect(query.get("limit")).toBe(String(PAGE));
      expect(query.get("order")).toBe("desc");
    }

    // And the order the route promises: newest first, which is the last run
    // this test triggered.
    const stored = await runner.history();
    expect(first!.runIds[0]).toBe(stored[0]!.runId);
    expect(third!.runIds.at(-1)).toBe(stored.at(-1)!.runId);
  });

  it("answers an offset past the end with an empty page, not an empty history", async () => {
    const screens = await load<PagingModule>(
      ["..", "runners", "realApiHistoryPaging"].join("/"),
    );
    const [only] = await screens.mountHistoryPages(
      "nightly",
      fetchShim,
      `?history=${PAGE}&offset=${RUNS * 10}`,
      0,
    );
    expect(only!.runIds).toHaveLength(0);
    expect(only!.emptyPage).toBe(true);
    // The runner has run: the card must not say otherwise, and Clear
    // history… must not go dead on a page that happens to hold nothing.
    expect(only!.neverRan).toBe(false);
    expect(only!.clearDisabled).toBe(false);
    expect(only!.range).toBe(`0 of ${RUNS}`);
  });

  it("reaches a run past `limits.maxHistory` with a deep offset", async () => {
    // The cap bounds a page, never how far back a window may start — which is
    // what makes every stored run reachable.
    const screens = await load<PagingModule>(
      ["..", "runners", "realApiHistoryPaging"].join("/"),
    );
    const stored = await runner.history();
    const [deep] = await screens.mountHistoryPages(
      "nightly",
      fetchShim,
      `?history=${PAGE}&offset=${RUNS - 1}`,
      0,
    );
    expect(deep!.runIds).toEqual([stored.at(-1)!.runId]);
    expect(deep!.range).toBe(`${RUNS}–${RUNS} of ${RUNS}`);
  });
});
