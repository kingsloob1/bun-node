import type { JobsApiConfig } from "../../lib/api/config";
import type {
  BunRunner,
  BunRunnerOptions,
  JobsDriver,
  RunLogCaps,
  RunLogInput,
  RunRecord,
} from "../../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { MemoryDriver, runnerKey } from "../../lib/index";
import {
  ECHO_HANDLER,
  harness,
  jobsContext,
  openContexts,
  openHarnesses,
} from "./fixtures";

/**
 * `GET /runners/:runner/runs/:runId/logs` over `fetch()`, with
 * `validateResponses` on, against a real driver.
 *
 * The distinction this route exists to get right is **409
 * `LOGS_NOT_RETAINED` against a 200 with no items**: a backend that keeps no
 * log for the run, and a run that simply logged nothing. Its test below reads
 * the *same* empty log through two backends and asserts the two answers
 * differ, so a route that conflated them could not pass.
 *
 * Once `RunRecord` carries `logLines` there are **three** readings of an empty
 * log, and "a retained run, an aged-out run and a run nobody has heard of"
 * below drives all three through one harness — 404, 409 and 200 — differing
 * only in the run id.
 */

/** The runner every case registers in this process. */
const RUNNER = "nightly";

/** Where that runner's state, history and logs live. */
const KEY = runnerKey(RUNNER);

/** Caps that bound nothing, so a case only feels the cap it asks for. */
const OPEN: RunLogCaps = { maxLines: 0, maxBytes: 0, keepRuns: 0 };

/** A time the assertions can name. */
const AT = 1_700_000_000_000;

/** Keeps each case's context in a namespace of its own. */
let namespaces = 0;

/** A driver with some optional methods hidden, as an older one would be. */
function without(driver: JobsDriver, methods: readonly string[]): JobsDriver {
  const hidden = new Set(methods);
  return new Proxy(driver, {
    get(target, key, receiver) {
      if (typeof key === "string" && hidden.has(key)) {
        return undefined;
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, key) {
      return typeof key === "string" && hidden.has(key)
        ? false
        : Reflect.has(target, key);
    },
  }) as JobsDriver;
}

/** A harness with `nightly` registered in this process, over `driver`. */
async function setup(
  overrides: Partial<JobsApiConfig> = {},
  driver: JobsDriver = new MemoryDriver(),
) {
  const jobs = jobsContext(`api-run-logs-${++namespaces}`, driver);
  const h = harness({ jobs, ...overrides });
  h.jobs.runner({
    id: RUNNER,
    file: ECHO_HANDLER,
    executionMode: "in-process",
  });
  await jobs.driver.connect();
  return h;
}

/** One line, at a time the assertions can name. */
function line(text: string, extra: Partial<RunLogInput> = {}): RunLogInput {
  return { stream: "stdout", at: AT, text, ...extra };
}

/**
 * The run-log counters a record carries, or `null` for a record that has
 * neither — a run captured before the counters existed, or one whose log has
 * aged out of the retained set while its history row survived.
 */
type Counters = Pick<RunRecord, "logLines" | "logsDropped"> | null;

/**
 * Puts a run in the runner's history, as a run itself would.
 *
 * `counters` defaults to `{ logLines: 0, logsDropped: 0 }` because that is
 * what a backend which retains run logs writes for even a silent run; a case
 * that wants the aged-out reading passes `null`.
 */
async function seedRun(
  driver: JobsDriver,
  namespace: string,
  runId: string,
  status: RunRecord["status"] = "success",
  counters: Counters = { logLines: 0, logsDropped: 0 },
): Promise<void> {
  await driver.appendHistory(
    namespace,
    KEY,
    {
      runId,
      runnerId: RUNNER,
      attempt: 1,
      source: "manual",
      mode: "in-process",
      host: "test-host",
      startedAt: AT,
      status,
      ...(status === "running" ? {} : { finishedAt: AT + 10, durationMs: 10 }),
      ...(counters ?? {}),
    },
    50,
  );
}

/** Appends captured lines to a run's log, as capture's flush would. */
async function seedLines(
  driver: JobsDriver,
  namespace: string,
  runId: string,
  lines: RunLogInput[],
  caps: RunLogCaps = OPEN,
): Promise<void> {
  await driver.appendRunLog!(namespace, KEY, runId, lines, caps);
}

/** The sequence numbers a page returned, in the order it returned them. */
function seqs(res: { body: any }): number[] {
  return res.body.items.map((item: { seq: number }) => item.seq);
}

/** The route's path for one run. */
function path(runId: string, query = ""): string {
  return `/runners/${RUNNER}/runs/${runId}/logs${query}`;
}

/** The handler fixture that writes `count` lines through `ctx.log()`. */
const LOG_MANY_HANDLER = new URL(
  "../fixtures/handlers/log-many.ts",
  import.meta.url,
);

/** Runners a case really started, stopped after it. */
const startedRunners: BunRunner<any, any>[] = [];

/**
 * A harness whose runner really runs, so the counters under test are the ones
 * capture wrote rather than ones the test invented. Resolves once the run has
 * settled and its record is in the history.
 */
async function runForReal(
  args: unknown,
  options: Partial<BunRunnerOptions<any>> = {},
): Promise<{ h: ReturnType<typeof harness>; record: RunRecord }> {
  const jobs = jobsContext(`api-run-logs-${++namespaces}`);
  const h = harness({ jobs });
  const runner = jobs.runner({
    id: RUNNER,
    file: LOG_MANY_HANDLER,
    executionMode: "in-process",
    waitToExit: false,
    logger: noopLogger,
    ...options,
  } as Omit<BunRunnerOptions<any>, "namespace" | "driver">);
  startedRunners.push(runner);

  await jobs.driver.connect();
  const settled = new Promise<RunRecord>((resolve) => {
    runner.once("finished", (record) => resolve(record as RunRecord));
    runner.once("failed", (record) => resolve(record as RunRecord));
  });
  await runner.start();
  await runner.trigger({ args });
  return { h, record: await settled };
}

afterEach(async () => {
  await Promise.allSettled(
    startedRunners.map((runner) => runner.stop({ force: true })),
  );
  startedRunners.length = 0;
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
});

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

describe("reading a run's log", () => {
  it("pages the lines in order, sending the store's text as message", async () => {
    const h = await setup();
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "run-1");
    await seedLines(h.jobs.driver, ns, "run-1", [
      line("starting"),
      line("oh no", { stream: "stderr" }),
      line("done", { stream: "log", level: "info" }),
      line("cut here", { truncated: true }),
    ]);

    const res = await h.call("GET", path("run-1"));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { seq: 1, at: AT, stream: "stdout", message: "starting" },
      { seq: 2, at: AT, stream: "stderr", message: "oh no" },
      { seq: 3, at: AT, stream: "log", message: "done", level: "info" },
      {
        seq: 4,
        at: AT,
        stream: "stdout",
        message: "cut here",
        truncated: true,
      },
    ]);
    expect(res.body.page).toEqual({
      offset: 0,
      limit: 100,
      total: 4,
      hasMore: false,
    });
    expect(res.body.dropped).toBe(0);
    expect(res.body.lastSeq).toBe(4);
    // Nothing carries the store's own name for the text.
    expect(res.text).not.toContain('"text"');
  });

  it("reads newest first when asked, and pages with offset and limit", async () => {
    const h = await setup();
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "run-1");
    await seedLines(
      h.jobs.driver,
      ns,
      "run-1",
      [1, 2, 3, 4, 5].map((n) => line(`line ${n}`)),
    );

    const desc = await h.call("GET", path("run-1", "?order=desc&limit=2"));
    expect(desc.status).toBe(200);
    expect(seqs(desc)).toEqual([5, 4]);
    expect(desc.body.page).toEqual({
      offset: 0,
      limit: 2,
      total: 5,
      hasMore: true,
    });

    const second = await h.call(
      "GET",
      path("run-1", "?order=desc&limit=2&offset=2"),
    );
    expect(seqs(second)).toEqual([3, 2]);
    expect(second.body.page.hasMore).toBe(true);

    const last = await h.call(
      "GET",
      path("run-1", "?order=desc&limit=2&offset=4"),
    );
    expect(seqs(last)).toEqual([1]);
    expect(last.body.page.hasMore).toBe(false);
  });
});

describe("tailing", () => {
  it("treats since as an exclusive cursor, so a tail neither repeats nor skips", async () => {
    const h = await setup();
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "run-1", "running");
    await seedLines(h.jobs.driver, ns, "run-1", [line("one"), line("two")]);

    const first = await h.call("GET", path("run-1"));
    expect(first.body.items).toHaveLength(2);
    expect(first.body.lastSeq).toBe(2);

    // Nothing new yet: the cursor reads empty, and the run is still live.
    const idle = await h.call("GET", path("run-1", "?since=2"));
    expect(idle.status).toBe(200);
    expect(idle.body.items).toEqual([]);
    expect(idle.body.page.total).toBe(0);
    expect(idle.body.lastSeq).toBe(2);
    expect(idle.body.live).toBe(true);

    await seedLines(h.jobs.driver, ns, "run-1", [line("three")]);
    const next = await h.call(
      "GET",
      path("run-1", `?since=${idle.body.lastSeq}`),
    );
    expect(next.body.items).toEqual([
      { seq: 3, at: AT, stream: "stdout", message: "three" },
    ]);
    expect(next.body.lastSeq).toBe(3);
  });

  it("resumes a filtered tail from the run's own lastSeq, not the last matching line", async () => {
    const h = await setup();
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "run-1", "running");
    await seedLines(h.jobs.driver, ns, "run-1", [
      line("out 1"),
      line("err 1", { stream: "stderr" }),
      line("out 2"),
    ]);

    const errors = await h.call("GET", path("run-1", "?stream=stderr"));
    expect(errors.status).toBe(200);
    expect(seqs(errors)).toEqual([2]);
    // `total` is the filtered count; `lastSeq` is the run's own, which is what
    // makes it a correct cursor — resuming from the last *matching* line (2)
    // would re-read "out 2".
    expect(errors.body.page.total).toBe(1);
    expect(errors.body.lastSeq).toBe(3);

    await seedLines(h.jobs.driver, ns, "run-1", [
      line("err 2", { stream: "stderr" }),
    ]);
    const next = await h.call(
      "GET",
      path("run-1", `?stream=stderr&since=${errors.body.lastSeq}`),
    );
    expect(next.body.items).toEqual([
      { seq: 4, at: AT, stream: "stderr", message: "err 2" },
    ]);
  });

  it("keeps dropped and lastSeq unfiltered while total follows the filter", async () => {
    const h = await setup();
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "run-1");
    // A cap of two lines, so three of the five are dropped.
    for (const n of [1, 2, 3, 4, 5]) {
      await seedLines(
        h.jobs.driver,
        ns,
        "run-1",
        [line(`line ${n}`, { stream: n % 2 === 0 ? "stderr" : "stdout" })],
        { ...OPEN, maxLines: 2 },
      );
    }

    const all = await h.call("GET", path("run-1"));
    expect(seqs(all)).toEqual([4, 5]);
    expect(all.body.dropped).toBe(3);
    expect(all.body.lastSeq).toBe(5);

    const filtered = await h.call("GET", path("run-1", "?stream=stderr"));
    expect(seqs(filtered)).toEqual([4]);
    expect(filtered.body.page.total).toBe(1);
    // Neither the filter nor `since` moves these two.
    expect(filtered.body.dropped).toBe(3);
    expect(filtered.body.lastSeq).toBe(5);

    const tail = await h.call("GET", path("run-1", "?since=5&stream=stdout"));
    expect(tail.body.items).toEqual([]);
    expect(tail.body.dropped).toBe(3);
    expect(tail.body.lastSeq).toBe(5);
  });
});

describe("capped and live, which the route derives", () => {
  it("says a live run whose cap is biting is a moving tail", async () => {
    const h = await setup();
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "run-1", "running");
    for (const n of [1, 2, 3]) {
      await seedLines(h.jobs.driver, ns, "run-1", [line(`line ${n}`)], {
        ...OPEN,
        maxLines: 2,
      });
    }

    const res = await h.call("GET", path("run-1"));
    expect(res.body.live).toBe(true);
    expect(res.body.dropped).toBe(1);
    expect(res.body.capped).toBe(true);
  });

  it("is live but not capped while a running log is still under its cap", async () => {
    const h = await setup();
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "run-1", "running");
    await seedLines(h.jobs.driver, ns, "run-1", [line("one")]);

    const res = await h.call("GET", path("run-1"));
    expect(res.body.live).toBe(true);
    expect(res.body.capped).toBe(false);
    expect(res.body.dropped).toBe(0);
  });

  it("is neither once the run has finished, dropped lines or not", async () => {
    const h = await setup();
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "run-1", "running");
    for (const n of [1, 2, 3]) {
      await seedLines(h.jobs.driver, ns, "run-1", [line(`line ${n}`)], {
        ...OPEN,
        maxLines: 2,
      });
    }
    const running = await h.call("GET", path("run-1"));
    expect(running.body).toMatchObject({ live: true, capped: true });

    // The same log, once the run settles: `dropped` is history, and nothing is
    // trimming it any more.
    await h.jobs.driver.updateHistory(ns, KEY, "run-1", {
      status: "success",
      finishedAt: AT + 10,
    });

    const settled = await h.call("GET", path("run-1"));
    expect(settled.body.live).toBe(false);
    expect(settled.body.capped).toBe(false);
    expect(settled.body.dropped).toBe(1);
  });
});

describe("a missing log against a silent run", () => {
  it("answers 200 with no items for a run that logged nothing, and 409 where no log is kept", async () => {
    // Identical requests: the same runner, the same run, the same empty log.
    // The only difference is the backend — one stores run logs, one cannot.
    const retaining = await setup();
    await seedRun(retaining.jobs.driver, retaining.jobs.namespace, "quiet");

    const base = new MemoryDriver();
    const notRetaining = await setup({}, without(base, ["appendRunLog"]));
    await seedRun(
      notRetaining.jobs.driver,
      notRetaining.jobs.namespace,
      "quiet",
    );

    const quiet = await retaining.call("GET", path("quiet"));
    const missing = await notRetaining.call("GET", path("quiet"));

    expect(quiet.status).toBe(200);
    expect(quiet.body.items).toEqual([]);
    expect(quiet.body.page).toEqual({
      offset: 0,
      limit: 100,
      total: 0,
      hasMore: false,
    });
    expect(quiet.body.dropped).toBe(0);
    expect(quiet.body.lastSeq).toBe(0);
    expect(quiet.body.live).toBe(false);
    expect(quiet.body.capped).toBe(false);

    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe("LOGS_NOT_RETAINED");
    expect(missing.body.title).toBe("Run logs are not retained");
    expect(missing.body.items).toBeUndefined();

    // The negative control: a route that conflated the two would answer both
    // the same way, and this is the assertion that would fail.
    expect(quiet.status).not.toBe(missing.status);
    expect(quiet.body.code).toBeUndefined();
  });

  it("says the backend keeps no logs however much the run logged", async () => {
    // Lines seeded through the real driver, then read through one that cannot
    // write them: the 409 is about the backend, never about this page.
    const base = new MemoryDriver();
    const h = await setup({}, without(base, ["appendRunLog"]));
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "run-1");
    await base.appendRunLog(ns, KEY, "run-1", [line("noisy")], OPEN);

    const res = await h.call("GET", path("run-1"));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LOGS_NOT_RETAINED");
  });

  it("reports `runnerLogs: false` for the very backend that answers 409", async () => {
    const base = new MemoryDriver();
    const h = await setup({}, without(base, ["appendRunLog"]));
    const meta = await h.call("GET", "/meta");
    expect(meta.body.features.runnerLogs).toBe(false);

    const retaining = await setup();
    const kept = await retaining.call("GET", "/meta");
    expect(kept.body.features.runnerLogs).toBe(true);
  });
});

describe("names it does not know", () => {
  it("answers an unknown runner exactly as the sibling runner routes do", async () => {
    const h = await setup();
    const mine = await h.call("GET", "/runners/nope/runs/run-1/logs");
    const sibling = await h.call("GET", "/runners/nope/history");

    expect(mine.status).toBe(sibling.status);
    expect(mine.body.code).toBe(sibling.body.code);
    expect(mine.status).toBe(404);
    expect(mine.body.code).toBe("RUNNER_NOT_FOUND");
  });

  it("answers a malformed runner id exactly as the sibling runner routes do", async () => {
    const h = await setup();
    const mine = await h.call("GET", "/runners/..%2Fetc/runs/run-1/logs");
    const sibling = await h.call("GET", "/runners/..%2Fetc/history");

    expect(mine.status).toBe(sibling.status);
    expect(mine.body.code).toBe(sibling.body.code);
    expect(mine.status).toBe(400);
    expect(mine.body.code).toBe("INVALID_NAME");
  });

  it("answers an unknown run on a known runner with the kill route's RUN_NOT_FOUND", async () => {
    const h = await setup();
    await seedRun(h.jobs.driver, h.jobs.namespace, "run-1");

    const mine = await h.call("GET", path("ghost"));
    const sibling = await h.call("POST", `/runners/${RUNNER}/kill`, {
      runId: "ghost",
    });

    expect(mine.status).toBe(404);
    expect(mine.body.code).toBe("RUN_NOT_FOUND");
    expect(sibling.status).toBe(mine.status);
    expect(sibling.body.code).toBe(mine.body.code);
    // And a run the backend does know reads fine on the same harness.
    expect((await h.call("GET", path("run-1"))).status).toBe(200);
  });
});

describe("limits and pruning", () => {
  it("clamps limit with limits.maxLogPage, exactly as the job-log route does", async () => {
    const h = await setup({ limits: { queueCacheMs: 0, maxLogPage: 2 } });
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "run-1");
    await seedLines(
      h.jobs.driver,
      ns,
      "run-1",
      [1, 2, 3].map((n) => line(`line ${n}`)),
    );

    const over = await h.call("GET", path("run-1", "?limit=3"));
    expect(over.status).toBe(400);
    expect(over.body.code).toBe("VALIDATION");
    expect(over.body.issues[0]).toMatchObject({
      target: "query",
      path: "limit",
    });

    const at = await h.call("GET", path("run-1", "?limit=2"));
    expect(at.status).toBe(200);
    expect(at.body.items).toHaveLength(2);

    // The default is `min(100, maxLogPage)`, so it is the cap here.
    const none = await h.call("GET", path("run-1"));
    expect(none.body.page.limit).toBe(2);
    expect(none.body.items).toHaveLength(2);
    expect(none.body.page.hasMore).toBe(true);

    // The same clamp the job-log route documents.
    const document = h.api.openapi() as any;
    const parameter = document.paths[
      "/runners/{runner}/runs/{runId}/logs"
    ].get.parameters.find((one: { name: string }) => one.name === "limit");
    expect(parameter.schema.maximum).toBe(2);
    expect(parameter.schema.default).toBe(2);
  });

  it("is pruned to 404 ROUTE_NOT_FOUND on a driver that cannot read run logs", async () => {
    const h = await setup({}, without(new MemoryDriver(), ["getRunLog"]));
    await seedRun(h.jobs.driver, h.jobs.namespace, "run-1");

    const res = await h.call("GET", path("run-1"));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ROUTE_NOT_FOUND");
    // Pruned, never 501: it is not in the document or the permissions either.
    const document = h.api.openapi() as any;
    expect(
      document.paths["/runners/{runner}/runs/{runId}/logs"],
    ).toBeUndefined();
    const permissions = await h.call("GET", "/meta/permissions");
    expect(permissions.body.actions["runners.logs"]).toBeUndefined();
  });

  it("documents the route as getRunLogs, with a RunLogPage of RunLogLines", async () => {
    const h = await setup();
    const document = h.api.openapi() as any;
    const operation = document.paths["/runners/{runner}/runs/{runId}/logs"].get;

    expect(operation.operationId).toBe("getRunLogs");
    expect(operation.tags).toEqual(["Runners"]);
    expect(
      operation.responses["200"].content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/RunLogPage" });
    expect(Object.keys(operation.responses)).toContain("409");
    expect(Object.keys(operation.responses)).toContain("404");

    const page = document.components.schemas.RunLogPage;
    expect(page.properties.items.items).toEqual({
      $ref: "#/components/schemas/RunLogLine",
    });
    expect(page.required).toEqual(
      expect.arrayContaining([
        "items",
        "page",
        "dropped",
        "capped",
        "live",
        "lastSeq",
      ]),
    );
    const lineSchema = document.components.schemas.RunLogLine;
    expect(lineSchema.properties.stream.enum).toEqual([
      "stdout",
      "stderr",
      "log",
    ]);
    expect(lineSchema.required).toEqual(["seq", "at", "stream", "message"]);
  });
});

describe("authorization", () => {
  it("asks authorize for runners.logs, on the runner, as a read", async () => {
    const h = await setup();
    await seedRun(h.jobs.driver, h.jobs.namespace, "run-1");
    await h.call("GET", path("run-1"));

    const asked = h.calls.filter(
      (context) => context.action === "runners.logs",
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ runner: RUNNER, mutation: false });
    expect(asked[0]!.route).toMatchObject({
      method: "GET",
      path: "/runners/:runner/runs/:runId/logs",
    });
  });

  it("enforces the decision: a denied runners.logs is 403 while the history stays readable", async () => {
    const h = await setup({
      authorize: (_req, context) => context.action !== "runners.logs",
    });
    await seedRun(h.jobs.driver, h.jobs.namespace, "run-1");

    const denied = await h.call("GET", path("run-1"));
    expect(denied.status).toBe(403);
    expect((await h.call("GET", `/runners/${RUNNER}/history`)).status).toBe(
      200,
    );
  });

  it("is on by default: an API that names no actions still serves it", async () => {
    // `actions: undefined` is "the default set", not "no actions" — the action
    // is a read, so it is neither a mutation nor opt-in.
    const h = await setup({ actions: undefined });
    await seedRun(h.jobs.driver, h.jobs.namespace, "run-1");

    const res = await h.call("GET", path("run-1"));
    expect(res.status).toBe(200);

    const permissions = await h.call("GET", "/meta/permissions");
    expect(permissions.body.actions["runners.logs"]).toBe(true);
  });

  it("is refused where the action is left out of actions", async () => {
    const h = await setup({ actions: ["runners.read"] });
    await seedRun(h.jobs.driver, h.jobs.namespace, "run-1");

    const res = await h.call("GET", path("run-1"));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ROUTE_NOT_FOUND");
  });
});

describe("the counters a run record carries", () => {
  it("carries a real run's logLines and logsDropped onto the wire, and the log route agrees", async () => {
    // A real runner, a real capture, a real cap: 20 lines through `ctx.log()`
    // with the store keeping five. Nothing here is seeded, so the numbers the
    // API reports are the ones capture and the store settled on between them.
    const { h, record } = await runForReal(
      { count: 20 },
      { captureLogs: { maxLines: 5 } },
    );
    expect(record.logLines).toBe(5);
    expect(record.logsDropped).toBe(15);

    const history = await h.call("GET", `/runners/${RUNNER}/history`);
    expect(history.status).toBe(200);
    const item = history.body.items.find(
      (run: { runId: string }) => run.runId === record.runId,
    );
    expect(item).toMatchObject({
      runId: record.runId,
      status: "success",
      logLines: 5,
      logsDropped: 15,
    });

    // The same run read through the log route: the record's counters are the
    // page's own numbers, which is the whole reason a client may trust them.
    const logs = await h.call("GET", path(record.runId));
    expect(logs.status).toBe(200);
    expect(logs.body.page.total).toBe(item.logLines);
    expect(logs.body.dropped).toBe(item.logsDropped);
    expect(logs.body.items).toHaveLength(5);

    // And through the runner's own view, which shapes the record separately.
    const info = await h.call("GET", `/runners/${RUNNER}`);
    expect(info.status).toBe(200);
    expect(info.body.lastRun).toMatchObject({ logLines: 5, logsDropped: 15 });
  });

  it("sends a quiet run's counters as zeros, which is not the same as sending nothing", async () => {
    const { h, record } = await runForReal({ count: 0 });
    expect(record.logLines).toBe(0);

    const history = await h.call("GET", `/runners/${RUNNER}/history`);
    const item = history.body.items.find(
      (run: { runId: string }) => run.runId === record.runId,
    );
    expect(item.logLines).toBe(0);
    expect(item.logsDropped).toBe(0);
    expect(Object.keys(item)).toContain("logLines");
  });

  it("leaves both keys out of a record that has neither, rather than sending zeros", async () => {
    // Two rows in one response: one a log-keeping backend wrote, one from
    // before the counters existed. The serializer must not flatten them.
    const h = await setup();
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "counted", "success", {
      logLines: 2,
      logsDropped: 1,
    });
    await seedRun(h.jobs.driver, ns, "uncounted", "success", null);

    const res = await h.call("GET", `/runners/${RUNNER}/history`);
    expect(res.status).toBe(200);
    const byId = new Map<string, any>(
      res.body.items.map((run: { runId: string }) => [run.runId, run]),
    );

    expect(byId.get("counted")).toMatchObject({ logLines: 2, logsDropped: 1 });
    const uncounted = byId.get("uncounted");
    expect(Object.keys(uncounted)).not.toContain("logLines");
    expect(Object.keys(uncounted)).not.toContain("logsDropped");
    // In the JSON too: `logLines` appears exactly once across both rows, so a
    // fabricated `0` on the second could not hide behind an `undefined`.
    expect(res.text.match(/"logLines"/g)).toHaveLength(1);
    expect(res.text).not.toContain('"logLines":0');
  });
});

describe("a retained run, an aged-out run and a run nobody has heard of", () => {
  it("splits the three of them on one harness, differing only in the run id", async () => {
    // One harness, one log-keeping backend, one empty log store. Every
    // difference below comes from the run's own history record.
    const h = await setup();
    const ns = h.jobs.driver;
    // Retained and quiet: capture ran and stored nothing.
    await seedRun(ns, h.jobs.namespace, "quiet", "success", {
      logLines: 0,
      logsDropped: 0,
    });
    // Retained no longer: the history row outlived the log.
    await seedRun(ns, h.jobs.namespace, "aged", "success", null);
    // "ghost" is deliberately not seeded at all.

    const quiet = await h.call("GET", path("quiet"));
    const aged = await h.call("GET", path("aged"));
    const ghost = await h.call("GET", path("ghost"));

    expect(quiet.status).toBe(200);
    expect(quiet.body.items).toEqual([]);
    expect(quiet.body.page.total).toBe(0);
    expect(quiet.body.code).toBeUndefined();

    expect(aged.status).toBe(409);
    expect(aged.body.code).toBe("LOGS_NOT_RETAINED");
    expect(aged.body.title).toBe("Run logs are not retained");
    expect(aged.body.context).toMatchObject({ runner: RUNNER, runId: "aged" });
    expect(aged.body.items).toBeUndefined();

    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe("RUN_NOT_FOUND");

    // The negative control. A route that collapsed *any two* of the three —
    // the old rule collapsed aged-out into 404, and a naive one would collapse
    // both empties into 200 — fails one of these three inequalities.
    expect(quiet.status).not.toBe(aged.status);
    expect(aged.status).not.toBe(ghost.status);
    expect(quiet.status).not.toBe(ghost.status);
    const codes = new Set([quiet.body.code, aged.body.code, ghost.body.code]);
    expect(codes.size).toBe(3);
  });

  it("makes a fourth case of a run still going: no counters yet is not aged out", async () => {
    // Capture writes the counters when the run settles, so a run in flight
    // has none and its store is empty until the first flush — indisputably a
    // live run with nothing logged yet, and answering 409 there would tell a
    // client the log is gone while it is actively being written.
    const h = await setup();
    await seedRun(h.jobs.driver, h.jobs.namespace, "inflight", "running", null);

    const res = await h.call("GET", path("inflight"));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.live).toBe(true);
    expect(res.body.code).toBeUndefined();

    // The control: the same record, settled, is the aged-out 409 — so the
    // exemption is the run's status and nothing else.
    await seedRun(h.jobs.driver, h.jobs.namespace, "inflight", "success", null);
    const settled = await h.call("GET", path("inflight"));
    expect(settled.status).toBe(409);
    expect(settled.body.code).toBe("LOGS_NOT_RETAINED");
  });

  it("reads logLines, not either counter: logsDropped alone is still not retained", async () => {
    const h = await setup();
    await seedRun(h.jobs.driver, h.jobs.namespace, "half", "success", {
      logsDropped: 3,
    });

    const res = await h.call("GET", path("half"));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LOGS_NOT_RETAINED");
  });

  it("still serves a pre-counter run whose lines are in the store", async () => {
    // The 409 is gated on the store being empty as well, so a record written
    // before the counters existed never hides lines that are really there.
    const h = await setup();
    const ns = h.jobs.namespace;
    await seedRun(h.jobs.driver, ns, "old", "success", null);
    await seedLines(h.jobs.driver, ns, "old", [line("still here")]);

    const res = await h.call("GET", path("old"));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { seq: 1, at: AT, stream: "stdout", message: "still here" },
    ]);
  });

  it("shows the aged-out run in the history it 409s for, with no logLines", async () => {
    // The two surfaces have to tell the same story: the history lists the run
    // (so it is not a 404) and omits `logLines` (so it is not a 200).
    const h = await setup();
    await seedRun(h.jobs.driver, h.jobs.namespace, "aged", "success", null);

    const history = await h.call("GET", `/runners/${RUNNER}/history`);
    const item = history.body.items.find(
      (run: { runId: string }) => run.runId === "aged",
    );
    expect(item).toBeDefined();
    expect(item.logLines).toBeUndefined();

    expect((await h.call("GET", path("aged"))).status).toBe(409);
  });

  it("keeps answering 409 for the backend that stores no run logs at all", async () => {
    // The other road to the same code, unchanged by the aged-out case: the
    // record here does carry `logLines`, and the 409 is still right because
    // *this* backend cannot have written the log.
    const h = await setup({}, without(new MemoryDriver(), ["appendRunLog"]));
    await seedRun(h.jobs.driver, h.jobs.namespace, "run-1", "success", {
      logLines: 4,
      logsDropped: 0,
    });

    const res = await h.call("GET", path("run-1"));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LOGS_NOT_RETAINED");
  });
});
