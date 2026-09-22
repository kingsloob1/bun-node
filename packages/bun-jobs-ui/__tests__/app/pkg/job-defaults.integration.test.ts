import type { BunQueue, JobOptions } from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  MemoryDriver,
  SqlDriver,
} from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The queue screen's Job defaults panel against a REAL `createJobsApi`:
 * `GET`/`PUT`/`DELETE /queues/:queue/job-defaults` and
 * `POST /queues/:queue/job-defaults/apply`. The panel was built against
 * mocked HTTP; this proves it sends what the API expects, reads back what it
 * answers, and that the jobs in the store end up as the screen says.
 *
 * Each deployment — memory, and SQLite in a temp dir — has one `BunJobs`
 * context whose queues declare {@link CODE} as their `defaultJobOptions`,
 * served by four APIs over it: `full` (every action, including the two
 * opt-ins, and `maxApplyDefaults` {@link BATCH} so a walk takes several
 * calls), `restricted` (both opt-ins left out) and `runner` (runner mode);
 * and two more contexts whose drivers lack what the feature flags need: one
 * without queue state (`features.jobDefaults` false) and one without the
 * batched rewrite (`features.jobDefaultsApply` false).
 *
 * Every scenario owns its queue, so the suite passes under
 * `bun test --randomize`. No worker runs on a scenario's queue except for a
 * moment while its Retrying job is made, so pending jobs stay pending.
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

/** One row of the panel's table (`../queues/realApiJobDefaults`' `DefaultsRow`). */
interface DefaultsRow {
  /** "A job gets". */
  gets: string;
  /** "Code". */
  code: string;
  /** "Override": "Overridden" or "code value". */
  override: string;
}

/** What the panel shows (`DefaultsPanelView`). */
interface DefaultsPanelView {
  /** The table's rows, by contract key. */
  rows: Record<string, DefaultsRow>;
  /** The note under the table. */
  note: string;
  /** The pending counts, by label. */
  pending: Record<string, string>;
  /** Whether Settings… is offered. */
  settings: boolean;
  /** The Apply button's label, or `null`. */
  apply: string | null;
  /** Why Apply is not offered, or `null`. */
  unavailable: string | null;
}

/** What the queue screen shows of its panels (`QueuePanelsView`). */
interface QueuePanelsView {
  /** The panel tabs' labels, or `null` without a panel card. */
  tabs: string[] | null;
  /** Whether the Job defaults panel is rendered. */
  panel: boolean;
  /** The whole screen's text. */
  text: string;
}

/** The open dialog (`DialogView`). */
interface DialogView {
  /** Its whole text. */
  text: string;
  /** An alert's text inside it, or `null`. */
  alert: string | null;
  /** The apply progress' text, or `null`. */
  progress: string | null;
  /** The last result's counts, by label, or `null`. */
  result: Record<string, string> | null;
  /** The exhausted warning's text, or `null`. */
  warning: string | null;
  /** The enabled buttons' labels. */
  buttons: string[];
}

/** What this file uses of `../queues/realApiJobDefaults`. */
interface HarnessModule {
  /** Renders the app on a queue's Job defaults tab. */
  mountJobDefaults: (
    fetch: FetchLike,
    csrfHeader: string,
    queue: string,
  ) => Promise<{
    panels: () => QueuePanelsView;
    view: () => DefaultsPanelView | null;
    awaitView: (
      ready: (view: DefaultsPanelView) => boolean,
      timeoutMs?: number,
    ) => Promise<DefaultsPanelView>;
    open: (name: string | RegExp) => Promise<void>;
    dialog: () => DialogView | null;
    awaitDialog: (
      ready: (view: DialogView) => boolean,
      timeoutMs?: number,
    ) => Promise<DialogView>;
    type: (label: string, value: string) => void;
    click: (name: string | RegExp, key?: string) => Promise<void>;
    resetNote: () => { text: string; beside: boolean; describes: boolean };
    toasts: () => string;
    awaitToast: (text: string) => Promise<string>;
    unmount: () => void;
  }>;
}

/** Which API answered. */
type ApiName = "full" | "restricted" | "runner" | "noDefaults" | "noApply";

/** One request made through a deployment's fetch, with what the API answered. */
interface Exchange {
  /** The method. */
  method: string;
  /** The path under the API's base, without the query. */
  path: string;
  /** The query string, without the `?`. */
  query: string;
  /** The CSRF header's value, or `null` when it was not sent. */
  csrf: string | null;
  /** The parsed request body, or `undefined` when there was none. */
  body: unknown;
  /** The status the API answered with. */
  status: number;
  /** The parsed answer, for a JSON body. */
  json: unknown;
  /** Whether the test made it directly, rather than the UI. */
  direct: boolean;
  /** Which API answered. */
  api: ApiName;
}

/**
 * Runs before a request reaches the API; resolving lets it through. The test
 * installs one to hold a call (to read the progress between batches) or to
 * change the defaults out of band just before the API sees it.
 */
type Interceptor = (request: {
  method: string;
  path: string;
  body: unknown;
}) => Promise<void> | void;

/** A context with its APIs. */
interface Served {
  /** The context. */
  jobs: BunJobs;
  /** The fetch into its API. */
  fetch: FetchLike;
}

/** One deployment under test. */
interface Deployment {
  /** How it is named in the test titles. */
  label: string;
  /** The context serving `full`, `restricted` and `runner`. */
  jobs: BunJobs;
  /** Every action, `maxApplyDefaults` {@link BATCH}. */
  full: FetchLike;
  /** Neither `queues.defaults` nor `queues.applyDefaults`. */
  restricted: FetchLike;
  /** `mode: "runner"`. */
  runner: FetchLike;
  /** A context whose driver has no queue state: `features.jobDefaults` false. */
  noDefaults: Served;
  /** A context whose driver has no batched rewrite: `features.jobDefaultsApply` false. */
  noApply: Served;
  /** Every request through any of its fetches, oldest first. */
  exchanges: Exchange[];
  /** See {@link Interceptor}; `null` lets everything through. */
  intercept: Interceptor | null;
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
/** The API's `limits.maxApplyDefaults`: one apply call examines at most this many jobs. */
const BATCH = 5;
/** Each scenario queue's code defaults: what `code` reports. */
const CODE = {
  attempts: 3,
  // Long enough that the Retrying job stays Retrying for the whole run.
  backoff: { type: "fixed", delay: 3_600_000 },
  timeout: 60_000,
} as const satisfies JobOptions;
/** Each scenario renders the whole app over real reads and writes. */
const TEST_TIMEOUT_MS = 30_000;
/** The panel's code-source hint (`app/screens/queues/panels/jobDefaults/text.ts`). */
const CODE_SOURCE_HINT =
  "“Code” is what this API's own service is configured with. A producer in another service may be configured differently; a stored value replaces them all alike.";
/** Beside Reset (`text.ts`' `RESET_CANNOT_RESTORE`). */
const RESET_CANNOT_RESTORE =
  "Resetting changes jobs added from now on. It cannot restore jobs already rewritten by Apply to pending jobs: they keep the values written to them.";
/** The apply confirmation's warning (`text.ts`' `EXHAUSTED_WARNING`). */
const EXHAUSTED_WARNING =
  "Attempts is being lowered. A job that has already made at least the new number of attempts is not dropped: it gets ONE final attempt, and dies if that fails.";

let tmp: string;
const deployments: Deployment[] = [];
/** Set while the test itself makes a request, so it is not taken for the UI's. */
let directCall = false;
/** Makes each scenario's queue name unique. */
let queueCount = 0;

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

/** Parses a JSON text, or `undefined`. */
function parse(text: string | undefined): unknown {
  if (text === undefined || text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Mounts an API over `jobs` and returns the recording fetch shim into it. */
function mountApi(
  deployment: Pick<Deployment, "exchanges" | "intercept">,
  jobs: BunJobs,
  which: ApiName,
): FetchLike {
  const api = createJobsApi({
    jobs,
    mode: which === "runner" ? "runner" : "both",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    csrf: { header: CSRF },
    limits: { queueCacheMs: 0, maxApplyDefaults: BATCH },
    actions:
      which === "restricted"
        ? JOBS_API_ACTIONS.filter(
            (action) =>
              action !== "queues.defaults" && action !== "queues.applyDefaults",
          )
        : [...JOBS_API_ACTIONS],
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses.
  return async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const url = new URL(input, "http://localhost");
      const path = url.pathname.slice(BASE.length);
      const body = parse(typeof init.body === "string" ? init.body : undefined);
      const direct = directCall;
      const method = init.method ?? "GET";
      if (!direct && deployment.intercept) {
        await deployment.intercept({ method, path, body });
      }
      const request = new native.Request(url.href, init);
      const response = await root.fetch(request);
      const text = await response.text();
      deployment.exchanges.push({
        method: request.method,
        path,
        query: url.search.replace(/^\?/, ""),
        csrf: request.headers.get(CSRF),
        body,
        status: response.status,
        json: parse(text),
        direct,
        api: which,
      });
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
}

/** A request the test makes itself, with the CSRF header. */
async function direct(
  fetch: FetchLike,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  directCall = true;
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        [CSRF]: "1",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: parse(text) ?? null };
  } finally {
    directCall = false;
  }
}

/** The UI's requests to `queue`'s job-defaults routes, from `from` on. */
function uiCalls(
  deploy: Deployment,
  queue: string,
  method?: string,
  suffix = "",
  from = 0,
): Exchange[] {
  const path = `/queues/${queue}/job-defaults${suffix}`;
  return deploy.exchanges
    .slice(from)
    .filter(
      (one) =>
        !one.direct &&
        one.path === path &&
        (method === undefined || one.method === method),
    );
}

/** A context over `driver`, its queues' code defaults {@link CODE}. */
function context(driver: MemoryDriver | SqlDriver, namespace: string): BunJobs {
  return new BunJobs({
    namespace,
    service: "api",
    driver,
    logger: noopLogger,
    defaultJobOptions: CODE,
  });
}

/** Hides `methods` from a driver, as a custom driver without them would be. */
function without<T extends object>(driver: T, methods: string[]): T {
  for (const method of methods) {
    Object.defineProperty(driver, method, {
      value: undefined,
      configurable: true,
    });
  }
  return driver;
}

/** Builds a deployment (see the file's comment). */
function populate(
  label: string,
  driver: () => MemoryDriver | SqlDriver,
  namespace: string,
): Deployment {
  const jobs = context(driver(), namespace);
  const partial = { exchanges: [] as Exchange[], intercept: null };
  const deployment = partial as unknown as Deployment;
  const noDefaults = context(
    without(driver(), ["getQueueState", "setQueueState"]),
    `${namespace}-nodefaults`,
  );
  const noApply = context(
    without(driver(), ["rewritePendingOptions"]),
    `${namespace}-noapply`,
  );
  Object.assign(deployment, {
    label,
    jobs,
    full: mountApi(deployment, jobs, "full"),
    restricted: mountApi(deployment, jobs, "restricted"),
    runner: mountApi(deployment, jobs, "runner"),
    noDefaults: {
      jobs: noDefaults,
      fetch: mountApi(deployment, noDefaults, "noDefaults"),
    },
    noApply: {
      jobs: noApply,
      fetch: mountApi(deployment, noApply, "noApply"),
    },
  });
  deployments.push(deployment);
  return deployment;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "bun-jobs-ui-defaults-"));
  let files = 0;
  populate("memory", () => new MemoryDriver(), "ui-defaults-memory");
  populate(
    "SQLite",
    () => new SqlDriver({ url: `sqlite://${join(tmp, `d${files++}.db`)}` }),
    "ui-defaults-sqlite",
  );
});

afterAll(async () => {
  for (const deployment of deployments) {
    for (const jobs of [
      deployment.jobs,
      deployment.noDefaults.jobs,
      deployment.noApply.jobs,
    ]) {
      await jobs.close().catch(() => undefined);
    }
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** The deployment named `label`, built in `beforeAll`. */
function deployment(label: string): Deployment {
  return deployments.find((one) => one.label === label)!;
}

/** Loads the harness. */
function harness(): Promise<HarnessModule> {
  return load<HarnessModule>(["..", "queues", "realApiJobDefaults"].join("/"));
}

/** A fresh queue in `jobs`, with the code defaults and no refresh window. */
function freshQueue(jobs: BunJobs, prefix: string): BunQueue {
  queueCount += 1;
  return jobs.queue(`${prefix}-${queueCount}`, {
    defaultJobOptions: CODE,
    jobDefaultsRefreshInterval: 0,
  });
}

/**
 * Makes job `id` Retrying on `queue`: a worker runs it once and it fails,
 * leaving it `failed` with {@link CODE}'s hour-long backoff before its next
 * attempt. The worker is closed before anything else is added.
 */
async function seedRetrying(jobs: BunJobs, queue: BunQueue, id: string) {
  const worker = jobs.worker(
    queue.name,
    async () => {
      throw new Error("fails on purpose");
    },
    { concurrency: 1, pollInterval: 10, waitToExit: false, logger: noopLogger },
  );
  void worker.run();
  await queue.add("retrying", {}, { jobId: id });
  await until(
    async () => (await queue.getJob(id))?.state === "failed",
    () => `${queue.name}: ${id} never became Retrying`,
  );
  await worker.close({ force: true });
}

/** Adds a parent waiting on one child that sits in another queue. */
async function seedWaitingChildren(queue: BunQueue, id: string) {
  await queue.addFlow({
    name: "parent",
    data: {},
    opts: { jobId: id },
    children: [{ name: "child", data: {}, queue: `${queue.name}-kids` }],
  });
}

/** A job's options as the library reads them back. */
async function optsOf(queue: BunQueue, id: string) {
  const job = await queue.getJob(id);
  if (!job) {
    throw new Error(`${queue.name}: no job ${id}`);
  }
  return {
    attempts: job.opts.attempts,
    timeout: job.opts.timeout,
    attemptsMade: job.attemptsMade,
    state: job.state,
  };
}

/** `GET /queues/:queue/job-defaults`' answer, as far as the test reads it. */
interface DefaultsDto {
  /** The version. */
  seq: number;
  /** What a job gets. */
  effective: Record<string, unknown>;
  /** What the code asks for. */
  code: Record<string, unknown>;
  /** Where `code` came from. */
  codeSource: string;
  /** The keys overridden. */
  overridden: string[];
  /** The stored override. */
  override: Record<string, unknown>;
  /** Pending, by state, and `total`. */
  pending: Record<string, number>;
}

/** One apply call's answer. */
interface ApplyDto {
  /** Counts. */
  examined: number;
  /** Counts. */
  rewritten: number;
  /** Counts. */
  unchanged: number;
  /** Counts. */
  skippedExplicit: number;
  /** Counts. */
  skippedUnmarked: number;
  /** Counts. */
  moved: number;
  /** Counts. */
  exhausted: number;
  /** The cursor. */
  next: string | null;
  /** `next === null`. */
  done: boolean;
  /** Whether it wrote nothing. */
  dryRun: boolean;
}

/** The apply body the UI sends. */
interface ApplyBody {
  /** The version. */
  seq: number;
  /** The batch. */
  limit: number;
  /** The cursor. */
  cursor?: string;
  /** Dry run. */
  dryRun: boolean;
  /** Include unmarked. */
  includeUnmarked: boolean;
  /** States. */
  states: string[];
}

/** Reads `queue`'s defaults straight from the API. */
async function readDefaults(
  deploy: Deployment,
  queue: string,
): Promise<DefaultsDto> {
  const { status, json } = await direct(
    deploy.full,
    "GET",
    `/queues/${queue}/job-defaults`,
  );
  expect(status).toBe(200);
  return json as DefaultsDto;
}

/** The sum of one walk's counts, and a check that each call adds up. */
function walkTotals(calls: Exchange[]) {
  const totals = {
    examined: 0,
    rewritten: 0,
    unchanged: 0,
    skippedExplicit: 0,
    skippedUnmarked: 0,
    moved: 0,
    exhausted: 0,
  };
  for (const call of calls) {
    const answer = call.json as ApplyDto;
    // The contract: the five add up to examined, exhausted within rewritten.
    expect(
      answer.rewritten +
        answer.unchanged +
        answer.skippedExplicit +
        answer.skippedUnmarked +
        answer.moved,
    ).toBe(answer.examined);
    expect(answer.exhausted).toBeLessThanOrEqual(answer.rewritten);
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[key] += answer[key];
    }
  }
  return totals;
}

/** Checks a walk's calls chain `cursor` → `next` until `done`, each within {@link BATCH}. */
function expectChained(calls: Exchange[], dryRun: boolean, seq: number) {
  expect(calls.length).toBeGreaterThan(1);
  calls.forEach((call, index) => {
    expect(call.status).toBe(200);
    expect(call.csrf).toBe("1");
    const body = call.body as ApplyBody;
    expect(body).toMatchObject({
      seq,
      limit: BATCH,
      dryRun,
      includeUnmarked: false,
      states: ["waiting", "delayed", "failed", "waiting-children"],
    });
    const answer = call.json as ApplyDto;
    expect(answer.dryRun).toBe(dryRun);
    expect(answer.examined).toBeLessThanOrEqual(BATCH);
    if (index === 0) {
      expect(body.cursor).toBeUndefined();
    } else {
      expect(body.cursor).toBe((calls[index - 1]!.json as ApplyDto).next ?? "");
    }
    const last = index === calls.length - 1;
    expect(answer.done).toBe(last);
    expect(answer.next === null).toBe(last);
  });
}

for (const label of ["memory", "SQLite"]) {
  describe(`the Job defaults panel against a real API (${label})`, () => {
    it(
      "shows the real effective, code and overridden values, and pending counts equal to the seeded jobs",
      async () => {
        const deploy = deployment(label);
        const queue = freshQueue(deploy.jobs, "shown");
        await seedRetrying(deploy.jobs, queue, "retrying");
        await queue.add("plain", {}, { jobId: "w1" });
        await queue.add("plain", {}, { jobId: "w2" });
        await queue.add("later", {}, { jobId: "d1", delay: 3_600_000 });
        await seedWaitingChildren(queue, "parent");
        await queue.setJobDefaults({ priority: 4 });

        const api = await readDefaults(deploy, queue.name);
        expect(api.codeSource).toBe("api");
        expect(api.overridden).toEqual(["priority"]);
        expect(api.code).toMatchObject({ attempts: 3, timeout: 60_000 });
        expect(api.effective).toMatchObject({
          attempts: 3,
          timeout: 60_000,
          priority: 4,
        });
        expect(api.pending).toEqual({
          waiting: 2,
          delayed: 1,
          failed: 1,
          "waiting-children": 1,
          total: 5,
        });

        const ui = await (
          await harness()
        ).mountJobDefaults(deploy.full, CSRF, queue.name);
        const view = await ui.awaitView((one) => one.pending.Total === "5");
        expect(view.rows.attempts).toEqual({
          gets: "3",
          code: "3",
          override: "code value",
        });
        expect(view.rows.timeout).toEqual({
          gets: "1m",
          code: "1m",
          override: "code value",
        });
        expect(view.rows.backoff).toEqual({
          gets: "fixed, 1h",
          code: "fixed, 1h",
          override: "code value",
        });
        expect(view.rows.priority).toEqual({
          gets: "4",
          code: "0",
          override: "Overridden",
        });
        expect(Object.keys(view.rows)).toHaveLength(8);
        expect(view.note).toContain(CODE_SOURCE_HINT);
        expect(view.pending).toEqual({
          Waiting: "2",
          Delayed: "1",
          Retrying: "1",
          "Waiting children": "1",
          Total: "5",
        });
        expect(view.settings).toBe(true);
        expect(view.apply).toBe("Apply to 5 pending jobs…");
        ui.unmount();

        const reads = uiCalls(deploy, queue.name, "GET");
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((one) => one.status === 200)).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "saves only the changed keys with expectedSeq, new jobs get them unless their add() passed its own, and Use code value / Reset restore the code's",
      async () => {
        const deploy = deployment(label);
        const queue = freshQueue(deploy.jobs, "saved");
        await queue.add("plain", {}, { jobId: "before" });
        const initial = await readDefaults(deploy, queue.name);
        expect(initial.overridden).toEqual([]);

        const ui = await (
          await harness()
        ).mountJobDefaults(deploy.full, CSRF, queue.name);
        await ui.awaitView((one) => one.settings);
        await ui.open("Settings…");
        ui.type("Attempts", "5");
        ui.type("Timeout (ms)", "30000");
        await ui.click("Save defaults");
        await ui.awaitToast("Saved the job defaults of");

        const puts = uiCalls(deploy, queue.name, "PUT");
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body).toEqual({
          attempts: 5,
          timeout: 30_000,
          expectedSeq: initial.seq,
        });
        expect(puts[0]!.csrf).toBe("1");
        expect(puts[0]!.status).toBe(200);
        const saved = puts[0]!.json as DefaultsDto;
        expect(saved.overridden).toEqual(["attempts", "timeout"]);
        expect(saved.effective).toMatchObject({
          attempts: 5,
          timeout: 30_000,
        });
        expect(saved.code).toMatchObject({ attempts: 3, timeout: 60_000 });
        expect(saved.seq).toBeGreaterThan(initial.seq);

        // The panel re-reads and shows them overridden.
        const after = await ui.awaitView(
          (one) => one.rows.attempts?.override === "Overridden",
        );
        expect(after.rows.attempts).toEqual({
          gets: "5",
          code: "3",
          override: "Overridden",
        });
        expect(after.rows.timeout).toEqual({
          gets: "30s",
          code: "1m",
          override: "Overridden",
        });

        // Jobs added now get them; one passing its own attempts keeps it; the
        // job added before keeps what it was added with.
        await queue.add("plain", {}, { jobId: "after" });
        await queue.add("own", {}, { jobId: "own", attempts: 2 });
        expect(await optsOf(queue, "after")).toMatchObject({
          attempts: 5,
          timeout: 30_000,
        });
        expect(await optsOf(queue, "own")).toMatchObject({
          attempts: 2,
          timeout: 30_000,
        });
        expect(await optsOf(queue, "before")).toMatchObject({
          attempts: 3,
          timeout: 60_000,
        });
        const own = await direct(
          deploy.full,
          "GET",
          `/queues/${queue.name}/jobs/own`,
        );
        expect((own.json as { opts: { explicit?: string[] } }).opts).toEqual(
          expect.objectContaining({ explicit: ["attempts"], attempts: 2 }),
        );
        const plain = await direct(
          deploy.full,
          "GET",
          `/queues/${queue.name}/jobs/after`,
        );
        expect(
          (plain.json as { opts: { explicit?: string[] } }).opts.explicit ?? [],
        ).toEqual([]);

        // "Use code value" sends null for that key alone.
        await ui.open("Settings…");
        await ui.click("Use code value", "attempts");
        await ui.click("Save defaults");
        await ui.awaitToast("Saved the job defaults of");
        const second = uiCalls(deploy, queue.name, "PUT")[1]!;
        expect(second.body).toEqual({
          attempts: null,
          expectedSeq: saved.seq,
        });
        const cleared = second.json as DefaultsDto;
        expect(cleared.overridden).toEqual(["timeout"]);
        expect(cleared.effective).toMatchObject({
          attempts: 3,
          timeout: 30_000,
        });

        // Reset: the note sits beside the button, and DELETE carries the seq.
        await ui.awaitView((one) => one.rows.attempts?.gets === "3");
        await ui.open("Settings…");
        const note = ui.resetNote();
        expect(note.text).toBe(RESET_CANNOT_RESTORE);
        expect(note.text).toContain("cannot restore jobs already rewritten");
        expect(note.beside).toBe(true);
        expect(note.describes).toBe(true);
        await ui.click("Reset to code values");
        await ui.awaitToast("Reset the job defaults of");
        const deletes = uiCalls(deploy, queue.name, "DELETE");
        expect(deletes).toHaveLength(1);
        expect(deletes[0]).toMatchObject({
          query: `expectedSeq=${cleared.seq}`,
          csrf: "1",
          body: undefined,
          status: 200,
        });
        const reset = deletes[0]!.json as DefaultsDto;
        expect(reset.overridden).toEqual([]);
        expect(reset.override).toEqual({});
        expect(reset.effective).toMatchObject({
          attempts: 3,
          timeout: 60_000,
        });
        expect(reset.seq).toBeGreaterThan(cleared.seq);
        const restored = await ui.awaitView(
          (one) => one.rows.timeout?.override === "code value",
        );
        expect(restored.rows.timeout!.gets).toBe("1m");
        ui.unmount();

        await queue.add("plain", {}, { jobId: "reset" });
        expect(await optsOf(queue, "reset")).toMatchObject({
          attempts: 3,
          timeout: 60_000,
        });
        // Reset changed new jobs only.
        expect(await optsOf(queue, "after")).toMatchObject({
          attempts: 5,
          timeout: 30_000,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "previews without writing, then applies batch by batch to the end, skipping explicit values and counting exhausted jobs",
      async () => {
        const deploy = deployment(label);
        const queue = freshQueue(deploy.jobs, "applied");
        await seedRetrying(deploy.jobs, queue, "retrying");
        const plain: string[] = [];
        for (let index = 1; index <= 12; index++) {
          plain.push(`p${index}`);
          await queue.add("plain", {}, { jobId: `p${index}` });
        }
        await queue.add("own", {}, { jobId: "own", attempts: 7 });
        await queue.add("later", {}, { jobId: "d1", delay: 3_600_000 });
        await seedWaitingChildren(queue, "parent");
        const pendingTotal = 16;
        const { seq } = await queue.setJobDefaults({ attempts: 1 });
        expect(await optsOf(queue, "retrying")).toMatchObject({
          attempts: 3,
          attemptsMade: 1,
          state: "failed",
        });

        const ui = await (
          await harness()
        ).mountJobDefaults(deploy.full, CSRF, queue.name);
        const view = await ui.awaitView(
          (one) => one.pending.Total === String(pendingTotal),
        );
        expect(view.apply).toBe(`Apply to ${pendingTotal} pending jobs…`);
        await ui.open(/^Apply to/);
        const confirm = ui.dialog()!;
        expect(confirm.text).toContain("Attempts: 1");
        // Lowering attempts below the code's warns before anything runs.
        expect(confirm.warning).toContain(EXHAUSTED_WARNING);

        // The dry run: every call dryRun, chained to the end, nothing written.
        await ui.click("Preview (dry run)");
        const previewed = await ui.awaitDialog((one) =>
          one.text.includes("Preview: nothing was written"),
        );
        const dry = uiCalls(deploy, queue.name, "POST", "/apply");
        expectChained(dry, true, seq);
        const dryTotals = walkTotals(dry);
        expect(dryTotals).toEqual({
          examined: pendingTotal,
          rewritten: 15,
          unchanged: 0,
          skippedExplicit: 1,
          skippedUnmarked: 0,
          moved: 0,
          exhausted: 1,
        });
        expect(previewed.result).toMatchObject({
          Examined: String(pendingTotal),
          "Would be rewritten": "15",
          "Skipped as explicit": "1",
          Exhausted: "1",
        });
        expect(previewed.warning).toContain("The preview found 1 such job.");
        for (const id of [...plain, "d1", "parent", "retrying"]) {
          expect((await optsOf(queue, id)).attempts).toBe(3);
        }

        // The real walk: hold its second call to read the progress between
        // batches, then let it run to the end.
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let posts = 0;
        let reachedSecond = false;
        deploy.intercept = async ({ method, path, body }) => {
          if (
            method === "POST" &&
            path.endsWith("/apply") &&
            !(body as ApplyBody).dryRun &&
            ++posts === 2
          ) {
            reachedSecond = true;
            await held;
          }
        };
        try {
          await ui.click(`Apply to ${pendingTotal} pending jobs`);
          await until(
            () => reachedSecond,
            () => "the second apply call was never sent",
          );
          const progress = await ui.awaitDialog(
            (one) => one.progress?.includes("(1 batch)") ?? false,
          );
          expect(progress.progress).toMatch(
            new RegExp(
              `^Applying… examined ${BATCH} of about ${pendingTotal}; rewritten \\d so far \\(1 batch\\)\\.$`,
            ),
          );
        } finally {
          release();
          deploy.intercept = null;
        }
        const done = await ui.awaitDialog((one) =>
          one.text.includes(
            "Applied to every pending job in the chosen states.",
          ),
        );
        const real = uiCalls(deploy, queue.name, "POST", "/apply").slice(
          dry.length,
        );
        expectChained(real, false, seq);
        const totals = walkTotals(real);
        expect(totals).toEqual(dryTotals);
        expect(done.result).toEqual({
          Examined: String(pendingTotal),
          Rewritten: "15",
          Unchanged: "0",
          "Skipped as explicit": "1",
          "Skipped, added before this version": "0",
          Moved: "0",
          Exhausted: "1",
        });
        expect(done.text).toContain("1 job got one final attempt");
        ui.unmount();

        // Straight from the store.
        for (const id of [...plain, "d1", "parent"]) {
          expect((await optsOf(queue, id)).attempts).toBe(1);
        }
        expect(await optsOf(queue, "own")).toMatchObject({ attempts: 7 });
        expect(await optsOf(queue, "retrying")).toMatchObject({
          attempts: 1,
          attemptsMade: 1,
          state: "failed",
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "refuses a save and a reset made against stale defaults with 409 CONTROL_CONTENDED, saves nothing, and re-reads",
      async () => {
        const deploy = deployment(label);
        const queue = freshQueue(deploy.jobs, "contended");
        await queue.add("plain", {}, { jobId: "w1" });
        const first = await queue.setJobDefaults({ priority: 2 });

        const ui = await (
          await harness()
        ).mountJobDefaults(deploy.full, CSRF, queue.name);
        await ui.awaitView((one) => one.rows.priority?.gets === "2");
        await ui.open("Settings…");
        // Someone else saves between the UI's read and its save.
        const other = await queue.setJobDefaults({ priority: 9 });
        ui.type("Attempts", "5");
        await ui.click("Save defaults");
        const refused = await ui.awaitDialog((one) => one.alert !== null);
        expect(refused.alert).toContain("changed since you opened them");
        expect(refused.alert).toContain("Nothing was saved");
        expect(refused.buttons).toContain("Re-read the defaults");
        const put = uiCalls(deploy, queue.name, "PUT")[0]!;
        expect(put.body).toEqual({ attempts: 5, expectedSeq: first.seq });
        expect(put.status).toBe(409);
        expect(put.json).toMatchObject({ code: "CONTROL_CONTENDED" });
        let stored = await queue.getJobDefaults();
        expect(stored.override).toEqual({ priority: 9 });
        expect(stored.seq).toBe(other.seq);

        // Re-read: the form starts over from the other save.
        await ui.click("Re-read the defaults");
        const reread = await ui.awaitDialog(
          (one) => one.alert === null && one.text.includes("Now: 9"),
        );
        expect(reread.text).toContain("Now: 9 · Code: 0");

        // Reset races too: DELETE ?expectedSeq= refuses it.
        const third = await queue.setJobDefaults({ priority: 11 });
        await ui.click("Reset to code values");
        await ui.awaitDialog((one) => one.alert !== null);
        const del = uiCalls(deploy, queue.name, "DELETE")[0]!;
        expect(del.query).toBe(`expectedSeq=${other.seq}`);
        expect(del.status).toBe(409);
        expect(del.json).toMatchObject({ code: "CONTROL_CONTENDED" });
        stored = await queue.getJobDefaults();
        expect(stored.override).toEqual({ priority: 11 });
        expect(stored.seq).toBe(third.seq);

        await ui.click("Re-read the defaults");
        await ui.awaitDialog((one) => one.text.includes("Now: 11"));
        await ui.click("Reset to code values");
        await ui.awaitToast("Reset the job defaults of");
        const reset = uiCalls(deploy, queue.name, "DELETE")[1]!;
        expect(reset.query).toBe(`expectedSeq=${third.seq}`);
        expect(reset.status).toBe(200);
        expect((await queue.getJobDefaults()).override).toEqual({});
        ui.unmount();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "stops an apply with 409 DEFAULTS_CHANGED when the defaults moved on after the preview, or mid-walk, and offers the re-read",
      async () => {
        const deploy = deployment(label);
        const queue = freshQueue(deploy.jobs, "changed");
        const ids: string[] = [];
        for (let index = 1; index <= 12; index++) {
          ids.push(`p${index}`);
          await queue.add("plain", {}, { jobId: `p${index}` });
        }
        const confirmed = await queue.setJobDefaults({ attempts: 2 });

        const ui = await (
          await harness()
        ).mountJobDefaults(deploy.full, CSRF, queue.name);
        await ui.awaitView((one) => one.apply !== null);
        await ui.open(/^Apply to/);
        await ui.click("Preview (dry run)");
        await ui.awaitDialog((one) =>
          one.text.includes("Preview: nothing was written"),
        );
        const previews = uiCalls(deploy, queue.name, "POST", "/apply").length;

        // Changed between the preview and the apply: the first call refuses.
        const moved = await queue.setJobDefaults({ attempts: 4 });
        await ui.click("Apply to 12 pending jobs");
        const conflict = await ui.awaitDialog(
          (one) => one.alert?.includes("changed since you confirmed") ?? false,
        );
        expect(conflict.alert).toContain("Nothing more was applied.");
        expect(conflict.alert).not.toContain("had already been rewritten");
        expect(conflict.buttons).toContain("Re-read the defaults");
        const refused = uiCalls(deploy, queue.name, "POST", "/apply").slice(
          previews,
        );
        expect(refused).toHaveLength(1);
        expect(refused[0]!.status).toBe(409);
        expect((refused[0]!.body as ApplyBody).seq).toBe(confirmed.seq);
        expect(refused[0]!.json).toMatchObject({
          code: "DEFAULTS_CHANGED",
          context: {
            queue: queue.name,
            expectedSeq: confirmed.seq,
            seq: moved.seq,
          },
        });
        for (const id of ids) {
          expect((await optsOf(queue, id)).attempts).toBe(3);
        }

        // Re-read: back to the choices, with the values now stored.
        await ui.click("Re-read the defaults");
        const fresh = await ui.awaitDialog((one) =>
          one.text.includes("Attempts: 4"),
        );
        expect(fresh.buttons).toContain("Apply to 12 pending jobs");

        // Changed mid-walk: the first batch lands, the second refuses, the
        // walk stops there.
        const before = uiCalls(deploy, queue.name, "POST", "/apply").length;
        let posts = 0;
        deploy.intercept = async ({ method, path }) => {
          if (method === "POST" && path.endsWith("/apply") && ++posts === 2) {
            await queue.setJobDefaults({ attempts: 6 });
          }
        };
        try {
          await ui.click("Apply to 12 pending jobs");
          const stopped = await ui.awaitDialog(
            (one) =>
              one.alert?.includes("changed since you confirmed") ?? false,
          );
          expect(stopped.alert).toContain(
            `${BATCH} jobs had already been rewritten with the values you confirmed.`,
          );
        } finally {
          deploy.intercept = null;
        }
        const walk = uiCalls(deploy, queue.name, "POST", "/apply").slice(
          before,
        );
        expect(walk.map((one) => one.status)).toEqual([200, 409]);
        expect((walk[0]!.json as ApplyDto).rewritten).toBe(BATCH);
        expect(walk[1]!.json).toMatchObject({ code: "DEFAULTS_CHANGED" });
        ui.unmount();
        const attempts = await Promise.all(
          ids.map(async (id) => (await optsOf(queue, id)).attempts),
        );
        expect(attempts.filter((one) => one === 4)).toHaveLength(BATCH);
        expect(attempts.filter((one) => one === 3)).toHaveLength(12 - BATCH);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "is a read-only summary without the opt-in actions, and writes nothing",
      async () => {
        const deploy = deployment(label);
        const queue = freshQueue(deploy.jobs, "restricted");
        await queue.add("plain", {}, { jobId: "w1" });
        await queue.setJobDefaults({ attempts: 2 });
        const permissions = await direct(
          deploy.restricted,
          "GET",
          "/meta/permissions",
        );
        const actions = (
          permissions.json as { actions: Record<string, boolean> }
        ).actions;
        expect("queues.defaults" in actions).toBe(false);
        expect("queues.applyDefaults" in actions).toBe(false);
        expect(actions["queues.read"]).toBe(true);

        const from = deploy.exchanges.length;
        const ui = await (
          await harness()
        ).mountJobDefaults(deploy.restricted, CSRF, queue.name);
        const view = await ui.awaitView((one) => one.pending.Total === "1");
        expect(view.rows.attempts).toEqual({
          gets: "2",
          code: "3",
          override: "Overridden",
        });
        expect(view.settings).toBe(false);
        expect(view.apply).toBeNull();
        expect(view.unavailable).toBeNull();
        ui.unmount();
        const sent = deploy.exchanges.slice(from).filter((one) => !one.direct);
        expect(sent.every((one) => one.api === "restricted")).toBe(true);
        expect(
          sent.some((one) => one.path === `/queues/${queue.name}/job-defaults`),
        ).toBe(true);
        expect(sent.filter((one) => one.method !== "GET")).toEqual([]);

        // What the missing buttons spare the user: an opt-in left out of
        // `actions` is not routed at all.
        const put = await direct(
          deploy.restricted,
          "PUT",
          `/queues/${queue.name}/job-defaults`,
          { attempts: 5 },
        );
        const apply = await direct(
          deploy.restricted,
          "POST",
          `/queues/${queue.name}/job-defaults/apply`,
          { seq: 1 },
        );
        for (const refused of [put, apply]) {
          expect(refused.status).toBe(404);
          expect(refused.json).toMatchObject({ code: "ROUTE_NOT_FOUND" });
        }
        expect((await queue.getJobDefaults()).override).toEqual({
          attempts: 2,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "has no panel and sends no request to the route where the flag is false, or in runner mode",
      async () => {
        const deploy = deployment(label);
        const { mountJobDefaults } = await harness();

        // A driver without queue state: `features.jobDefaults` false.
        const bare = freshQueue(deploy.noDefaults.jobs, "bare");
        await bare.add("plain", {}, { jobId: "w1" });
        const meta = await direct(deploy.noDefaults.fetch, "GET", "/meta");
        expect(
          (meta.json as { features: Record<string, boolean> }).features,
        ).toMatchObject({ jobDefaults: false, jobDefaultsApply: false });
        let from = deploy.exchanges.length;
        const off = await mountJobDefaults(
          deploy.noDefaults.fetch,
          CSRF,
          bare.name,
        );
        await until(
          () => (off.panels().tabs?.length ?? 0) > 0,
          () => `no panel tabs: ${off.panels().text}`,
        );
        expect(off.panels().tabs).not.toContain("Job defaults");
        expect(off.panels().panel).toBe(false);
        off.unmount();
        expect(
          deploy.exchanges
            .slice(from)
            .filter((one) => one.path.includes("job-defaults")),
        ).toEqual([]);

        // A driver without the batched rewrite: Settings…, and no Apply.
        const partial = freshQueue(deploy.noApply.jobs, "partial");
        await partial.add("plain", {}, { jobId: "w1" });
        await partial.setJobDefaults({ attempts: 2 });
        const partialMeta = await direct(deploy.noApply.fetch, "GET", "/meta");
        expect(
          (partialMeta.json as { features: Record<string, boolean> }).features,
        ).toMatchObject({ jobDefaults: true, jobDefaultsApply: false });
        from = deploy.exchanges.length;
        const settingsOnly = await mountJobDefaults(
          deploy.noApply.fetch,
          CSRF,
          partial.name,
        );
        const view = await settingsOnly.awaitView(
          (one) => one.pending.Total === "1",
        );
        expect(view.settings).toBe(true);
        expect(view.apply).toBeNull();
        expect(view.unavailable).toBeNull();
        settingsOnly.unmount();
        expect(
          deploy.exchanges
            .slice(from)
            .filter((one) => one.path.endsWith("/apply")),
        ).toEqual([]);

        // Runner mode: no queues at all, so no panel and no request.
        const queue = freshQueue(deploy.jobs, "runner");
        await queue.add("plain", {}, { jobId: "w1" });
        const runnerMeta = await direct(deploy.runner, "GET", "/meta");
        expect(
          (runnerMeta.json as { features: Record<string, boolean> }).features,
        ).toMatchObject({ jobDefaults: false, jobDefaultsApply: false });
        from = deploy.exchanges.length;
        const runner = await mountJobDefaults(deploy.runner, CSRF, queue.name);
        await until(
          () =>
            deploy.exchanges
              .slice(from)
              .some((one) => one.path === "/meta/permissions"),
          () => "the runner-mode app never read its permissions",
        );
        await until(
          () => !runner.panels().text.includes("Loading"),
          () => `still loading: ${runner.panels().text}`,
        );
        expect(runner.panels().panel).toBe(false);
        expect(runner.panels().tabs ?? []).not.toContain("Job defaults");
        runner.unmount();
        expect(
          deploy.exchanges
            .slice(from)
            .filter((one) => one.path.includes("job-defaults")),
        ).toEqual([]);
        const route = await direct(
          deploy.runner,
          "GET",
          `/queues/${queue.name}/job-defaults`,
        );
        expect(route.status).toBe(404);
      },
      TEST_TIMEOUT_MS,
    );
  });
}
