import type { BunQueueWorker } from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * Where a summoned worker came from (`WorkerDto.summon`), against a REAL
 * `createJobsApi` and real `BunQueueWorker`s built with a `summon`: what the
 * worker records, what the API serves of it, and what the worker page then
 * shows — the Instances table's badge and the Summoned card.
 *
 * The platform handle is infrastructure detail (an ECS task ARN carries the
 * AWS account id), served only when the API is built with
 * `serialize.exposeSummonHandles`. So the same workers are read through two
 * APIs, one with it and one without, and the card must show the handle
 * through the first and nothing about one through the second.
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

/** What the worker page shows of the summon (`../workers/realApiSummon`). */
interface SummonView {
  /** Whether the Target card has rendered, which the Summoned card renders beside. */
  ready: boolean;
  /** The Instances table's summon badge, or `null` when it shows none. */
  badge: string | null;
  /** The badge's tooltip, or `null` when there is no badge. */
  badgeHint: string | null;
  /** The Summoned card's column headers, or `null` when there is no card. */
  headers: string[] | null;
  /** The cells of the Summoned card's first row, or `null` when there is no card. */
  cells: string[] | null;
  /** The Summoned card's whole text, `""` when there is no card. */
  card: string;
}

/** What this file uses of `../workers/realApiSummon`. */
interface SummonModule {
  /** Renders the worker page of `key` on `queue` over `fetch`, and returns a driver. */
  mountSummonPage: (
    fetch: FetchLike,
    csrfHeader: string,
    queue: string,
    key: string,
  ) => Promise<{
    view: () => SummonView;
    awaitView: (ready: (view: SummonView) => boolean) => Promise<SummonView>;
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
/** A platform handle carrying an account id: the reason it is withheld by default. */
const HANDLE = "arn:aws:ecs:eu-west-1:123456789012:task/jobs/5f0c2a";
/** The requested deadline: a whole epoch ms, an hour out. */
const DEADLINE = Math.floor(Date.now() / 1_000) * 1_000 + 3_600_000;
/** One queue per worker, so each page lists exactly one instance. */
const QUEUES = {
  /** Summoned, with every field the summoner can give. */
  full: "exports",
  /** Summoned, with nothing but the attempt's id. */
  bare: "imports",
  /** An ordinary worker: nobody summoned it. */
  plain: "pings",
} as const;

let jobs: BunJobs;
/** Reads through an API built WITHOUT `exposeSummonHandles` (the default). */
let plainFetch: FetchLike;
/** Reads through an API built WITH `exposeSummonHandles`. */
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
    namespace: "ui-worker-summon-integration",
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
  const processor = async () => "ok";
  workers.set(
    QUEUES.full,
    jobs.worker<unknown, unknown>(QUEUES.full, processor, {
      ...options,
      summon: {
        id: "sum-full",
        kind: "ecs",
        handle: HANDLE,
        mode: "exit-on-idle",
        deadlineAt: DEADLINE,
      },
    }),
  );
  workers.set(
    QUEUES.bare,
    jobs.worker<unknown, unknown>(QUEUES.bare, processor, {
      ...options,
      summon: { id: "sum-bare" },
    }),
  );
  workers.set(
    QUEUES.plain,
    jobs.worker<unknown, unknown>(QUEUES.plain, processor, options),
  );
  for (const worker of workers.values()) {
    void worker.run();
  }

  const build = (exposeSummonHandles: boolean) => {
    const api = createJobsApi({
      jobs,
      mode: "jobs",
      basePath: BASE,
      authorize: () => true,
      logger: noopLogger,
      csrf: { header: CSRF },
      serialize: { exposeSummonHandles },
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
  const summon = await load<SummonModule>(
    ["..", "workers", "realApiSummon"].join("/"),
  );
  return summon.mountSummonPage(fetch, CSRF, queue, `${SERVICE}.${queue}`);
}

describe("a summoned worker against a real API", () => {
  it("shows the summoner, the requested mode and deadline, and no handle unless the API exposes it", async () => {
    const queue = QUEUES.full;
    // What the API serves by default: the provenance, without the handle.
    expect((await reported(plainFetch, queue)).summon).toEqual({
      id: "sum-full",
      kind: "ecs",
      mode: "exit-on-idle",
      deadlineAt: DEADLINE,
    });

    const ui = await mount(plainFetch, queue);
    const view = await ui.awaitView((one) => one.cells !== null);
    expect(view.badge).toBe("Summoned by ecs");
    expect(view.badgeHint).toContain("attempt sum-full");
    expect(view.badgeHint).toContain("requested mode: Exit when idle");
    expect(view.headers).toEqual([
      "Instance",
      "Summon",
      "Summoner",
      "Requested mode",
      "Requested deadline",
    ]);
    expect(view.cells!.slice(1, 4)).toEqual([
      "sum-full",
      "ecs",
      "Exit when idle",
    ]);
    // Withheld, and nothing on the card hints that a handle exists.
    expect(view.card).not.toMatch(/handle/i);
    expect(view.card).not.toContain("123456789012");
    ui.unmount();
  }, 30_000);

  it("shows the handle through an API built with exposeSummonHandles", async () => {
    const queue = QUEUES.full;
    expect(
      (
        (await reported(exposedFetch, queue)).summon as {
          handle?: string;
        }
      ).handle,
    ).toBe(HANDLE);

    const ui = await mount(exposedFetch, queue);
    const view = await ui.awaitView((one) => one.cells !== null);
    expect(view.headers!.at(-1)).toBe("Handle");
    expect(view.cells!.at(-1)).toBe(HANDLE);
    ui.unmount();
  }, 30_000);

  it("shows a bare summon with its id alone, and defaults nothing the summoner did not give", async () => {
    const queue = QUEUES.bare;
    expect((await reported(plainFetch, queue)).summon).toEqual({
      id: "sum-bare",
    });

    const ui = await mount(plainFetch, queue);
    const view = await ui.awaitView((one) => one.cells !== null);
    expect(view.badge).toBe("Summoned");
    expect(view.badgeHint).not.toContain("requested");
    expect(view.headers).toEqual(["Instance", "Summon"]);
    expect(view.cells!.at(1)).toBe("sum-bare");
    ui.unmount();
  }, 30_000);

  it("shows neither badge nor card for a worker nobody summoned", async () => {
    const queue = QUEUES.plain;
    expect("summon" in (await reported(plainFetch, queue))).toBe(false);

    const ui = await mount(plainFetch, queue);
    const view = await ui.awaitView((one) => one.ready);
    expect(view.badge).toBeNull();
    expect(view.headers).toBeNull();
    expect(view.card).toBe("");
    ui.unmount();
  }, 30_000);
});
