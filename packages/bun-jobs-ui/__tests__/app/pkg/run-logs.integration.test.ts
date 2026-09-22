import type { BunRunner } from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The RUN LOG view against a REAL `createJobsApi` with real runs that really
 * logged: the lines the view shows are the ones capture stored, a live run's
 * log is tailed with `?since=`, and the "N earlier lines dropped" copy is the
 * number the API reports after a cap bit.
 *
 * Like the other tests in this directory, it compiles without the DOM lib, so
 * the DOM side is loaded by dynamic imports the compiler does not follow and
 * the interfaces below restate the little this file uses of them.
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

/** One line as the view renders it. */
interface LineView {
  /** The sequence number in the gutter. */
  seq: string;
  /** The stream, as the view labels it. */
  stream: string;
  /** The level badge, or `""`. */
  level: string;
  /** The line's text. */
  text: string;
}

/** What the view shows. */
interface LogView {
  /** The lines, in the order shown. */
  lines: LineView[];
  /** The notes above the log. */
  notes: string;
  /** The "logged nothing" line, or `null`. */
  empty: string | null;
  /** The whole section's text. */
  text: string;
}

/** What this file uses of `../runners/realApiRunLogs`. */
interface RunLogsModule {
  /** Renders `/runners/<id>?logs=<runId>` over `fetch` and returns a handle. */
  mountRunLog: (
    runner: string,
    runId: string,
    fetch: FetchLike,
    stream?: string,
  ) => Promise<{
    read: () => LogView;
    awaitLines: (count: number, timeoutMs?: number) => Promise<LogView>;
    awaitText: (text: string, timeoutMs?: number) => Promise<LogView>;
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

/** Loads the DOM harness this file drives the view with. */
function screens(): Promise<RunLogsModule> {
  return load<RunLogsModule>(["..", "runners", "realApiRunLogs"].join("/"));
}

const BASE = "/jobs-api";

/** How many lines the trimmed runner's cap keeps. */
const TRIMMED_KEEPS = 3;
/** How many lines its run writes, so `TRIMMED_LINES - TRIMMED_KEEPS` are dropped. */
const TRIMMED_LINES = 7;

let jobs: BunJobs;
let fetchShim: FetchLike;
const runners = new Map<string, BunRunner>();
/** Every request the app made, so a test can prove how the view read. */
const requests: { path: string; query: string }[] = [];

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
  what: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** One runner of this suite, registered in `beforeAll`. */
function runnerOf(id: string): BunRunner {
  return runners.get(id)!;
}

/** The id of `runner`'s newest run. */
async function newestRun(id: string): Promise<string> {
  const [run] = await runnerOf(id).history();
  if (!run) {
    throw new Error(`runner ${id} has no run`);
  }
  return run.runId;
}

/** The log requests the app sent for one run since `from`, newest last. */
function logRequests(
  runId: string,
  from = 0,
): { path: string; query: string }[] {
  return requests
    .slice(from)
    .filter((one) => one.path.endsWith(`/runs/${runId}/logs`));
}

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-run-logs-integration",
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  const file = (name: string) =>
    new URL(`./fixtures/run-logs/${name}.ts`, import.meta.url);
  const defineRunner = (
    id: string,
    name: string,
    handler: string,
    extra: Record<string, unknown> = {},
  ) => {
    const runner = jobs.runner({
      id,
      name,
      file: file(handler),
      executionMode: "in-process",
      waitToExit: false,
      logger: noopLogger,
      ...extra,
    });
    runners.set(id, runner);
    return runner;
  };
  defineRunner("chatty", "Chatty report", "chatty-runner");
  defineRunner("quiet", "Quiet report", "quiet-runner");
  defineRunner("ticker", "Ticking report", "ticker-runner");
  // Keeps only the last few lines, so a run that writes more really drops
  // some and the API reports it.
  defineRunner("trimmed", "Trimmed report", "chatty-runner", {
    captureLogs: { maxLines: TRIMMED_KEEPS },
  });
  for (const runner of runners.values()) {
    await runner.start();
  }

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
      requests.push({
        path: url.pathname,
        query: url.search.replace(/^\?/, ""),
      });
      const response = await root.fetch(new native.Request(url.href, init));
      // A plain copy the app reads the same under either implementation.
      return new Response(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });

  // The finished runs, made before any screen looks at them.
  await runnerOf("chatty").trigger({ args: { lines: 4 } });
  await runnerOf("quiet").trigger();
  await runnerOf("trimmed").trigger({ args: { lines: TRIMMED_LINES } });
  for (const id of ["chatty", "quiet", "trimmed"]) {
    await until(
      async () => (await runnerOf(id).history()).length === 1,
      `runner ${id} never recorded its run`,
    );
    await until(
      () => runnerOf(id).activeRuns.size === 0,
      `runner ${id} never finished its run`,
    );
  }
});

afterAll(async () => {
  await jobs.close();
});

describe("the run log against a real API", () => {
  it("shows the lines capture really stored, with their stream, level and rendered fields", async () => {
    const runId = await newestRun("chatty");
    const view = await (
      await (await screens()).mountRunLog("chatty", runId, fetchShim)
    ).awaitLines(4);
    expect(view.lines).toHaveLength(4);
    expect(view.lines.map((line) => line.seq)).toEqual(["1", "2", "3", "4"]);
    // An in-process run has no pipes, so every line is the handler's own.
    expect(new Set(view.lines.map((line) => line.stream))).toEqual(
      new Set(["logger"]),
    );
    // `ctx.log`'s fields are rendered into the text at capture; there is
    // nothing structured left for the view to unpack.
    expect(view.lines[0]!.text).toBe("step 1 step=1 of=4");
    expect(view.lines[0]!.level).toBe("info");
    expect(view.lines[3]!.text).toBe("step 4 step=4 of=4");
    expect(view.lines[3]!.level).toBe("warn");
    // Nothing was dropped and the run has finished: no notes at all.
    expect(view.notes).toBe("");
    expect(view.text).toContain("is not captured here");
  }, 20_000);

  it("reads the first page with no `since`, and keeps the whole log on the `log` stream filter", async () => {
    const runId = await newestRun("chatty");
    const from = requests.length;
    const mounted = await (
      await screens()
    ).mountRunLog("chatty", runId, fetchShim, "log");
    const view = await mounted.awaitLines(4);
    expect(view.lines).toHaveLength(4);
    const sent = logRequests(runId, from);
    const first = sent[0]!;
    expect(first.query).toContain("limit=");
    expect(first.query).toContain("order=asc");
    expect(first.query).toContain("stream=log");
    expect(first.query).not.toContain("since=");
    mounted.unmount();
  }, 20_000);

  it("says a run logged nothing when its kept log is empty", async () => {
    const runId = await newestRun("quiet");
    const mounted = await (
      await screens()
    ).mountRunLog("quiet", runId, fetchShim);
    const view = await mounted.awaitText("This run logged nothing");
    expect(view.lines).toHaveLength(0);
    // A 200 with no lines, not a 409: the log is retained and empty.
    expect(view.text).not.toContain("Run logs are not retained");
    mounted.unmount();
  }, 20_000);

  it("reports the lines a cap really dropped, and does not claim the cap is still trimming a finished run", async () => {
    const runId = await newestRun("trimmed");
    const dropped = TRIMMED_LINES - TRIMMED_KEEPS;
    const mounted = await (
      await screens()
    ).mountRunLog("trimmed", runId, fetchShim);
    const view = await mounted.awaitLines(TRIMMED_KEEPS);
    expect(view.lines).toHaveLength(TRIMMED_KEEPS);
    // The numbering survives the trim, so the gap is where the lines went.
    expect(view.lines[0]!.seq).toBe(String(dropped + 1));
    expect(view.notes).toContain(`${dropped} earlier lines dropped`);
    // `capped` is the present tense, and this run has finished.
    expect(view.notes).not.toContain("A cap is trimming this log now");
    mounted.unmount();
  }, 20_000);

  it("tails a run that is still going, asking for the lines above the last seq it holds", async () => {
    const ticker = runnerOf("ticker");
    const from = requests.length;
    await ticker.trigger({ args: { lines: 8, everyMs: 300 } });
    await until(
      async () => (await ticker.history()).length >= 1,
      "the ticking run never started",
    );
    const runId = await newestRun("ticker");
    const mounted = await (
      await screens()
    ).mountRunLog("ticker", runId, fetchShim);
    const first = await mounted.awaitLines(1);
    expect(first.notes).toContain("Following this run");

    // More lines arrive only through a further read, and the tail asks for
    // the ones above what it holds.
    const later = await mounted.awaitLines(4, 15_000);
    // However many have landed by now, they are this run's own lines, in
    // order, from the first.
    expect(later.lines.slice(0, 4).map((line) => line.text)).toEqual([
      "tick 1",
      "tick 2",
      "tick 3",
      "tick 4",
    ]);
    const sent = logRequests(runId, from);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0]!.query).not.toContain("since=");
    expect(sent.some((one) => one.query.includes("since="))).toBe(true);
    // Every line once: the cursor never re-reads a line it already had.
    const seqs = later.lines.map((line) => line.seq);
    expect(new Set(seqs).size).toBe(seqs.length);

    await until(
      () => ticker.activeRuns.size === 0,
      "the ticking run never finished",
      20_000,
    );
    // Once the run has ended the log stops calling itself live.
    const settled = await mounted.awaitLines(8, 15_000);
    expect(settled.lines.at(-1)!.text).toBe("tick 8");
    mounted.unmount();
  }, 60_000);
});
