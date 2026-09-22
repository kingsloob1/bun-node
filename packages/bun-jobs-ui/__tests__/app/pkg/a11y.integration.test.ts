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
 * Every routed screen, rendered against a REAL `createJobsApi` (mode `both`,
 * with its socket, a queue holding jobs and a local runner that has run),
 * passes the structural accessibility audit in `../a11y/audit.ts`: one h1,
 * no skipped heading level, the landmarks and skip link, a name on every
 * control, button, link and table, a scope on every header cell, and no
 * ARIA reference to a missing id.
 *
 * This project compiles without the DOM lib (see tsconfig.json), so the DOM
 * side is loaded by dynamic imports the compiler does not follow.
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

/** What this file uses of `../a11y/realApiAudit`. */
interface AuditModule {
  /** Renders a route, waits for `ready`, and returns the audit's findings. */
  auditRoute: (
    path: string,
    fetch: FetchLike,
    ready: string,
  ) => Promise<string[]>;
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
const QUEUE = "emails";

let jobs: BunJobs;
let fetchShim: FetchLike;

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
async function until(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the runner");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The first seeded job, for the job screen's route. */
let firstJobId = "";

beforeAll(async () => {
  jobs = new BunJobs({
    namespace: "ui-a11y-integration",
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  const runner = jobs.runner({
    id: "nightly",
    name: "Nightly report",
    file: new URL("./fixtures/report-runner.ts", import.meta.url),
    executionMode: "in-process",
    schedule: { cron: "0 3 * * *", tz: "Europe/London" },
    waitToExit: false,
  });
  await runner.start();
  const api = createJobsApi({
    jobs,
    mode: "both",
    basePath: BASE,
    authorize: () => true,
    actions: [...JOBS_API_ACTIONS],
    addableNames: "any",
    websocket: {},
    logger: noopLogger,
    limits: { queueCacheMs: 0 },
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  fetchShim = async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const response = await root.fetch(
        new native.Request(new URL(input, "http://localhost").href, init),
      );
      return new Response(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
  const first = await jobs.queue(QUEUE).add("send", { to: "a@example.com" });
  firstJobId = first.id;
  await jobs.queue(QUEUE).add("send", { to: "b@example.com" });
  // A repeat series, so the repeatables panel has a row (and its buttons).
  await jobs
    .queue(QUEUE)
    .add("digest", {}, { repeat: { every: 3_600_000, key: "hourly-digest" } });
  await runner.trigger();
  await until(async () => (await runner.history()).length === 1);
  await until(async () => runner.activeRuns.size === 0);
});

afterAll(async () => {
  await jobs.close();
});

/**
 * Every routed screen this suite audits, with what shows it has loaded. The
 * job screen and the Repeatables panel are left out while another change
 * reworks them; add them back once it lands.
 */
const ROUTES: readonly { path: string; ready: string }[] = [
  { path: "/", ready: `[data-testid="queue-row-${QUEUE}"]` },
  { path: "/queues", ready: `[data-testid="queue-row-${QUEUE}"]` },
  { path: `/queues/${QUEUE}`, ready: '[data-testid^="job-row-"]' },
  { path: `/queues/${QUEUE}?panel=limits`, ready: '[data-testid^="job-row-"]' },
  {
    path: `/queues/${QUEUE}?panel=workers`,
    ready: '[data-testid^="job-row-"]',
  },
  {
    path: `/queues/${QUEUE}?panel=throughput`,
    ready: '[data-testid^="job-row-"]',
  },
  {
    path: `/queues/${QUEUE}?panel=repeatables`,
    ready: '[data-testid^="job-row-"]',
  },
  // The Workers page: audited with whatever workers this API has, so an
  // empty namespace audits its empty state rather than being skipped.
  { path: "/workers", ready: '[data-testid="workers-list"]' },
  {
    path: `/queues/${QUEUE}/jobs/missing-job`,
    ready: '[data-testid="job-not-found"]',
  },
  { path: "/runners", ready: '[data-testid="runner-row-nightly"]' },
  { path: "/runners/nightly", ready: '[data-testid^="history-row-"]' },
  { path: "/runners/missing", ready: '[data-testid="runner-not-found"]' },
  { path: "/events", ready: '[data-testid="events-screen"]' },
  { path: "/docs", ready: '[data-testid="docs-home"]' },
  { path: "/docs/http", ready: "a.http-op-link" },
  { path: "/docs/http/getMeta", ready: '[data-testid="http-operation"]' },
  { path: "/docs/http/nothing", ready: '[data-testid="http-docs"]' },
  { path: "/docs/ws", ready: '[data-testid="ws-main"]' },
  { path: "/docs/ws/nothing", ready: '[data-testid="ws-main"]' },
  { path: "/no/such/page", ready: '[data-testid="not-found"]' },
];

describe("every screen passes the structural accessibility audit", () => {
  for (const { path, ready } of ROUTES) {
    it(path, async () => {
      const audit = await load<AuditModule>(
        ["..", "a11y", "realApiAudit"].join("/"),
      );
      expect(await audit.auditRoute(path, fetchShim, ready)).toEqual([]);
    });
  }

  it("the job screen, for a real job", async () => {
    const audit = await load<AuditModule>(
      ["..", "a11y", "realApiAudit"].join("/"),
    );
    const path = `/queues/${QUEUE}/jobs/${encodeURIComponent(firstJobId)}`;
    expect(
      await audit.auditRoute(path, fetchShim, '[data-testid="job-screen"]'),
    ).toEqual([]);
  });
});
