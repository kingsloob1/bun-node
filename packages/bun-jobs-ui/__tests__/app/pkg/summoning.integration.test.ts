import type { FetchLike } from "../../../app/api/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  defineSummoner,
  JOBS_API_ACTIONS,
} from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The Summoning screen and the Summon panel's "Also clear budget usage"
 * against a REAL `createJobsApi` over a `BunJobs` running a real summon
 * controller: what `GET /summon` lists, what the screen then shows, and that
 * a reset with the box ticked really clears the budget usage — read back from
 * the API, not from the screen.
 *
 * Summoning refuses the memory driver (it needs a store another process can
 * share), so the context runs on a SQLite file in a temporary directory,
 * deleted when the file ends. The summoner is a `defineSummoner` fake that
 * starts nothing; every trigger is off, so only the API's "summon now" runs a
 * check, and the counts are exactly what this file caused.
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

/** What the Summoning screen shows of one controller (`../summoning/realApiSummoning`). */
interface RowView {
  /** The row's whole text. */
  text: string;
  /** The readiness badge's text. */
  readiness: string;
  /** The budget's hour line. */
  hour: string;
  /** The budget's day line. */
  day: string;
  /** Where the queue name links, or `null`. */
  href: string | null;
}

/** What this file uses of `../summoning/realApiSummoning`. */
interface SummoningModule {
  /** Renders `/summon` over `fetch` and returns a driver. */
  mountSummoning: (
    fetch: FetchLike,
    csrfHeader: string,
  ) => Promise<{
    row: (queue: string, ready: (view: RowView) => boolean) => Promise<RowView>;
    resetFromRow: (
      queue: string,
      clearBudget: boolean,
      ready: (hour: string) => boolean,
    ) => Promise<{ toast: string; hour: string }>;
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
/**
 * The queues with a summon controller, one per case, so each case summons
 * once on a queue nothing else touched: a second check on one queue is
 * skipped while the first attempt is on its way, and the cases run in any
 * order (`--randomize`).
 */
const QUEUES = {
  /** The listing case's. */
  listed: "renders",
  /** The reset case's. */
  reset: "exports",
} as const;

let dir: string;
let jobs: BunJobs;
let fetchApi: FetchLike;
/** The summoner's calls, so a test knows an attempt really went out. */
let invoked = 0;

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

/** The budget `GET /summon` lists for `queue`. */
async function listedBudget(queue: string): Promise<Record<string, unknown>> {
  const response = await fetchApi(`${BASE}/summon`, { method: "GET" });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    controllers: { queue: string; budget: Record<string, unknown> }[];
  };
  const item = body.controllers.find((entry) => entry.queue === queue);
  if (!item) {
    throw new Error(`GET /summon does not list ${queue}`);
  }
  return item.budget;
}

/** Runs one "summon now" on `queue` through the API, as the panel's button does. */
async function summonNow(queue: string): Promise<void> {
  const response = await fetchApi(`${BASE}/queues/${queue}/summon`, {
    method: "POST",
    headers: { [CSRF]: "1", "content-type": "application/json" },
    body: JSON.stringify({ force: true }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { action: string };
  expect(body.action).toBe("summoned");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bun-jobs-ui-summoning-"));
  jobs = new BunJobs({
    namespace: `ui-summoning-${Date.now().toString(36)}`,
    driver: { type: "sql", url: `sqlite://${join(dir, "jobs.db")}` },
    logger: noopLogger,
    summon: Object.fromEntries(
      Object.values(QUEUES).map((queue) => [
        queue,
        {
          summoner: defineSummoner({
            kind: "fake",
            invoke: async () => {
              invoked += 1;
              return { status: "started", handles: [] };
            },
          }),
          triggers: { onAdd: false, events: false, poll: false },
          cooldown: 0,
        },
      ]),
    ),
  });
  const api = createJobsApi({
    jobs,
    mode: "jobs",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    csrf: { header: CSRF },
    // Every action, the opt-in `queues.summon` included.
    actions: [...JOBS_API_ACTIONS],
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  fetchApi = fetchOver(root);
  // Demand, so a check summons: one waiting job and no worker on each.
  for (const queue of Object.values(QUEUES)) {
    await jobs.queue(queue).add("work", { queue });
  }
});

afterAll(async () => {
  await jobs?.close();
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A predicate: whether a text starts with `prefix`. */
function startsWith(prefix: string): (text: string) => boolean {
  return (text) => text.startsWith(prefix);
}

/** The DOM side. */
function ui(): Promise<SummoningModule> {
  return load<SummoningModule>(
    ["..", "summoning", "realApiSummoning"].join("/"),
  );
}

/**
 * Summons once on `queue` and answers the usage `GET /summon` then lists for it. Each case
 * summons for itself and reads what is left from the API's own count, so the
 * cases hold in any order (`--randomize`) and whatever an earlier one left.
 */
async function summonAndRead(
  queue: string,
): Promise<{ hour: number; day: number }> {
  const before = invoked;
  await summonNow(queue);
  expect(invoked).toBe(before + 1);
  const budget = await listedBudget(queue);
  expect(budget).toMatchObject({ perHour: 30, perDay: 300 });
  const hour = budget.hour as number;
  const day = budget.day as number;
  expect(hour).toBeGreaterThan(0);
  expect(day).toBeGreaterThan(0);
  return { hour, day };
}

describe("the Summoning screen against a real summon controller", () => {
  it("lists the controller, and the screen shows its row with the budget left", async () => {
    const queue = QUEUES.listed;
    const used = await summonAndRead(queue);

    const screen = await (await ui()).mountSummoning(fetchApi, CSRF);
    const row = await screen.row(queue, (view) => view.hour !== "");
    expect(row.readiness).toBe("Ready");
    expect(row.text).toContain("fake");
    expect(row.text).toContain("Started");
    // The relative part is minutes, or hours from 45 minutes out, or "now".
    expect(row.hour).toMatch(
      new RegExp(
        `^${30 - used.hour} of 30 left this hour, resets at (\\d\\d:\\d\\d|midnight) UTC \\((in \\d+[smh]|now)\\)$`,
      ),
    );
    expect(
      row.day.startsWith(`${300 - used.day} of 300 left today, resets at `),
    ).toBe(true);
    expect(row.href).toBe(`/jobs/queues/${queue}?panel=summon`);
    screen.unmount();
  }, 30_000);

  it("a reset without the box keeps the usage; with it, clears it on the server", async () => {
    const queue = QUEUES.reset;
    const used = await summonAndRead(queue);

    // Without the box: the failures go, the usage stays.
    let screen = await (await ui()).mountSummoning(fetchApi, CSRF);
    await screen.row(queue, (view) => view.hour !== "");
    const kept = await screen.resetFromRow(
      queue,
      false,
      startsWith(`${30 - used.hour} of 30 left this hour`),
    );
    expect(kept.toast).toContain("failures, backoff and circuit cleared");
    expect(await listedBudget(queue)).toMatchObject(used);
    screen.unmount();

    // With it: the usage is 0 in the API's own answer, and on the panel.
    screen = await (await ui()).mountSummoning(fetchApi, CSRF);
    await screen.row(queue, (view) => view.hour !== "");
    const cleared = await screen.resetFromRow(
      queue,
      true,
      startsWith("30 of 30 left this hour"),
    );
    expect(cleared.toast).toContain(
      "failures, backoff, circuit and budget usage cleared",
    );
    expect(await listedBudget(queue)).toMatchObject({ hour: 0, day: 0 });
    screen.unmount();

    // And the Summoning screen reads the cleared usage back.
    screen = await (await ui()).mountSummoning(fetchApi, CSRF);
    const full = startsWith("30 of 30 left this hour");
    const row = await screen.row(queue, (view) => full(view.hour));
    expect(row.day).toMatch(/^300 of 300 left today/);
    screen.unmount();
  }, 60_000);
});
