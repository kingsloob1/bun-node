import type { FetchLike } from "../../../app/api/client";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The jobs table's cursor navigation against a REAL `createJobsApi`.
 *
 * The claim being tested is not "a cursor is sent" — a mocked handler can be
 * made to agree with anything. It is that **walking reaches jobs that paging
 * by offset does not**, on a queue that is draining while it is read, and
 * that the UI never sends a cursor where the route refuses one. So this file
 * runs the real route twice over two identically seeded queues, draining each
 * on the same schedule: the UI walks one, and the other is paged by offset
 * with the very parameters the UI sent, minus the cursor. The jobs still
 * waiting when both finish are the ones an operator meant to read, and they
 * are what the two arms are compared on.
 *
 * "Draining" here is `queue.remove` rather than a worker: a job a worker
 * claims leaves `waiting` exactly as one removed does, and the schedule has
 * to be exact for the comparison to mean anything.
 *
 * This project compiles without the DOM lib, so the DOM side is loaded by
 * dynamic imports the compiler does not follow; the interfaces below restate
 * the little this file uses of them.
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

/** What this file uses of `../queues/realApiJobWalk`. */
interface WalkModule {
  /** Renders the queue screen and returns one view per page visited. */
  mountJobPages: (
    queue: string,
    fetch: FetchLike,
    query: string,
    turns: number,
    beforeTurn?: (turn: number) => Promise<void>,
    thenOrder?: "asc" | "desc",
  ) => Promise<
    {
      /** The job ids in the table. */
      ids: string[];
      /** The pager's range text. */
      range: string;
      /** Whether Next can be pressed. */
      canNext: boolean;
      /** Whether Previous can be pressed. */
      canPrev: boolean;
      /** Whether the table says there is no job to show. */
      empty: boolean;
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

/** Jobs seeded in each queue: three pages of ten, with room to lose some. */
const SEEDED = 30;

/** The page size the screens ask for, as `?limit=`. */
const PAGE = 10;

/** Jobs that leave the queue between one page and the next. */
const DRAIN = 5;

let jobs: BunJobs;
let root: BunRouter;
let fetchShim: FetchLike;

/** One `GET /queues/:queue/jobs` the API served. */
interface JobsCall {
  /** The queue it listed. */
  queue: string;
  /** Its query. */
  query: URLSearchParams;
  /** The status it answered. */
  status: number;
}

/** Every jobs request served, in order. */
let jobsCalls: JobsCall[] = [];

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

/** Asks the API directly, as a client that is not the app. */
async function apiGet(path: string): Promise<{
  /** The status answered. */
  status: number;
  /** The parsed body. */
  body: {
    /** The jobs, on a page. */
    items?: { id: string }[];
    /** Where the page sits, on a page. */
    page?: { offset?: number; hasMore: boolean; next?: string | null };
    /** What went wrong, on a problem. */
    detail?: string;
  };
}> {
  return withBunGlobals(async () => {
    const response = await root.fetch(
      new native.Request(new URL(`${BASE}${path}`, "http://localhost").href),
    );
    const status = response.status;
    const body = (await response.json()) as Awaited<
      ReturnType<typeof apiGet>
    >["body"];
    if (new URL(`http://localhost${path}`).pathname.endsWith("/jobs")) {
      const url = new URL(`http://localhost${path}`);
      jobsCalls.push({
        queue: url.pathname.split("/")[2] ?? "",
        query: url.searchParams,
        status,
      });
    }
    return { status, body };
  });
}

/** Seeds `queue` with {@link SEEDED} waiting jobs and answers their ids, in order. */
async function seed(queue: string): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < SEEDED; index++) {
    const job = await jobs.queue(queue).add("page", { index }, { priority: 0 });
    ids.push(job.id);
  }
  return ids;
}

/** Removes the `count` oldest jobs still waiting in `queue`, and answers their ids. */
async function drain(queue: string, count: number): Promise<string[]> {
  const waiting = await jobs.queue(queue).list(["waiting"], {
    offset: 0,
    limit: count,
    order: "asc",
  });
  const gone: string[] = [];
  for (const job of waiting) {
    await jobs.queue(queue).remove(job.id);
    gone.push(job.id);
  }
  return gone;
}

/** The ids still waiting in `queue`. */
async function waitingIds(queue: string): Promise<string[]> {
  const list = await jobs
    .queue(queue)
    .list(["waiting"], { offset: 0, limit: SEEDED * 2, order: "asc" });
  return list.map((job) => job.id);
}

beforeAll(() => {
  jobs = new BunJobs({
    namespace: "ui-jobs-cursor-integration",
    driver: new MemoryDriver(),
  });
  const api = createJobsApi({
    jobs,
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    limits: { queueCacheMs: 0 },
  });
  root = new BunRouter();
  root.use(api.basePath, api.router);
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses;
  // nothing here is cancelled, so it is left out.
  fetchShim = async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const url = new URL(input, "http://localhost");
      const response = await root.fetch(new native.Request(url.href, init));
      if (url.pathname.endsWith("/jobs")) {
        jobsCalls.push({
          queue: url.pathname.split("/")[3] ?? "",
          query: url.searchParams,
          status: response.status,
        });
      }
      // A plain copy the app reads the same under either implementation.
      return new Response(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
});

afterAll(async () => {
  await jobs.close();
});

describe("the jobs table's cursor navigation against a real API", () => {
  it("walks past a draining queue and reaches jobs an offset page never shows", async () => {
    jobsCalls = [];
    const walked = await seed("walk-me");
    const sampled = await seed("sample-me");
    const screens = await load<WalkModule>(
      ["..", "queues", "realApiJobWalk"].join("/"),
    );

    // Oldest first: the direction the route measured its losses in, and the
    // one a reader working through a backlog is on.
    const views = await screens.mountJobPages(
      "walk-me",
      fetchShim,
      `?state=waiting&order=asc&limit=${PAGE}`,
      2,
      async () => {
        await drain("walk-me", DRAIN);
      },
    );
    expect(views).toHaveLength(3);

    // The UI walked: every page after the first was asked for by cursor, and
    // no request ever carried a cursor and an offset at once.
    const ours = jobsCalls.filter((call) => call.queue === "walk-me");
    expect(ours.length).toBeGreaterThanOrEqual(3);
    expect(ours.filter((call) => call.query.has("cursor")).length).toBe(2);
    for (const call of ours) {
      expect(call.status).toBe(200);
      expect(call.query.has("cursor") && call.query.has("offset")).toBe(false);
    }

    // The same route, the same parameters and the same draining schedule,
    // paged by offset instead — the arm the cursor replaces.
    const first = ours[0]!.query;
    const offsetQuery = (offset: number) => {
      const query = new URLSearchParams(first);
      query.delete("cursor");
      query.set("offset", String(offset));
      return query.toString();
    };
    const sampledSeen: string[] = [];
    for (let page = 0; page < 3; page++) {
      if (page > 0) {
        await drain("sample-me", DRAIN);
      }
      const answer = await apiGet(
        `/queues/sample-me/jobs?${offsetQuery(page * PAGE)}`,
      );
      expect(answer.status).toBe(200);
      sampledSeen.push(...(answer.body.items ?? []).map((job) => job.id));
    }

    // Both queues drained the same way, so both end with the same jobs left.
    const leftWalked = await waitingIds("walk-me");
    const leftSampled = await waitingIds("sample-me");
    expect(leftWalked).toHaveLength(SEEDED - 2 * DRAIN);
    expect(leftSampled).toHaveLength(SEEDED - 2 * DRAIN);
    expect(leftWalked.map((id) => walked.indexOf(id))).toEqual(
      leftSampled.map((id) => sampled.indexOf(id)),
    );

    // The claim: of the jobs nobody took — every one of which the operator
    // meant to read — the walk showed all, and the offset pages did not.
    const walkedSeen = new Set(views.flatMap((view) => view.ids));
    const missedByWalk = leftWalked.filter((id) => !walkedSeen.has(id));
    const missedByOffset = leftSampled.filter(
      (id) => !sampledSeen.includes(id),
    );
    expect(missedByWalk).toEqual([]);
    // Measured, and exactly what the arithmetic predicts: with five jobs
    // taken between pages, the offset's window slides back over five it has
    // not shown, twice — and the last five are then past the end of a list
    // that has shrunk. Ten jobs nobody claimed, in a queue of thirty.
    expect(missedByOffset.map((id) => sampled.indexOf(id)).join()).toBe(
      "10,11,12,13,14,25,26,27,28,29",
    );
    // The walk saw each page whole, in order, from where the one before
    // ended — the three pages the list would have had if nothing had moved.
    expect(views.map((view) => view.ids)).toEqual([
      walked.slice(0, PAGE),
      walked.slice(PAGE, 2 * PAGE),
      walked.slice(2 * PAGE, 3 * PAGE),
    ]);
    // The memory driver counts what precedes a walked page for free, so the
    // range stays numbered — and says where the seek landed in the list as
    // it is now, not where the walk started: "6–15" after five jobs went.
    expect(views[1]!.range).toBe(`${PAGE - DRAIN + 1}–${2 * PAGE - DRAIN}`);

    // And the offset arm announced none of it: no repeat, no error, no gap in
    // any field of the response — which is why the losses went unseen.
    expect(new Set(sampledSeen).size).toBe(sampledSeen.length);
  }, 30_000);

  it("jumps to a page by offset and then walks on from where the jump landed", async () => {
    jobsCalls = [];
    const ids = await seed("jump-me");
    const screens = await load<WalkModule>(
      ["..", "queues", "realApiJobWalk"].join("/"),
    );
    const views = await screens.mountJobPages(
      "jump-me",
      fetchShim,
      `?state=waiting&order=asc&limit=${PAGE}&offset=${PAGE}`,
      1,
    );

    // The jump: page two by offset, as a page number always has been.
    expect(views[0]!.ids).toEqual(ids.slice(PAGE, 2 * PAGE));
    expect(views[0]!.range).toBe(`${PAGE + 1}–${2 * PAGE}`);
    // Then the walk, which continues from that page rather than from the top:
    // the API mints a cursor on an offset page too, which is what lets a
    // reader jump to where they want to be and walk on without losing a row.
    expect(views[1]!.ids).toEqual(ids.slice(2 * PAGE, 3 * PAGE));
    expect(views[1]!.canPrev).toBe(true);

    const ours = jobsCalls.filter((call) => call.queue === "jump-me");
    expect(ours[0]!.query.get("offset")).toBe(String(PAGE));
    expect(ours[0]!.query.has("cursor")).toBe(false);
    const walkedCall = ours.find((call) => call.query.has("cursor"))!;
    expect(walkedCall.query.has("offset")).toBe(false);
    expect(walkedCall.status).toBe(200);
  }, 30_000);

  it("sends no cursor after a filter change, and the one it dropped would have been refused", async () => {
    jobsCalls = [];
    await seed("stale-me");
    const screens = await load<WalkModule>(
      ["..", "queues", "realApiJobWalk"].join("/"),
    );
    // Walk one page, then reverse the order on the same screen — the change a
    // reader makes with the Order select, and one a cursor cannot survive.
    await screens.mountJobPages(
      "stale-me",
      fetchShim,
      `?state=waiting&order=asc&limit=${PAGE}`,
      1,
      undefined,
      "desc",
    );
    const ours = jobsCalls.filter((call) => call.queue === "stale-me");
    const walkedCall = ours.find((call) => call.query.has("cursor"))!;
    expect(walkedCall.status).toBe(200);
    expect(walkedCall.query.has("order")).toBe(false);
    const cursor = walkedCall.query.get("cursor")!;

    // Every request the reversed order made started the walk again: the API
    // saw no cursor at all, so it never had to refuse one.
    const after = ours.slice(ours.indexOf(walkedCall) + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const call of after) {
      expect(call.query.get("order")).toBe("desc");
      expect(call.query.has("cursor")).toBe(false);
      expect(call.status).toBe(200);
    }
    expect(ours.every((call) => call.status === 200)).toBe(true);

    // Not theatre: that cursor sent into the new walk is a 400 naming the
    // walk, not a silent restart at page one — which a walking client could
    // not tell from the end of the list. Everything else about the request is
    // what minted it, so the order is the only difference.
    const reversed = new URLSearchParams(walkedCall.query);
    reversed.set("order", "desc");
    const refused = await apiGet(`/queues/stale-me/jobs?${reversed}`);
    expect(refused.status).toBe(400);
    expect(refused.body.detail ?? "").toMatch(/order|walk|issued/i);
    // The walk it does belong to still takes it, which is what makes the
    // refusal above about the walk rather than about the cursor.
    const accepted = await apiGet(`/queues/stale-me/jobs?${walkedCall.query}`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.page?.next).not.toBeUndefined();
    expect(cursor.length).toBeLessThanOrEqual(2048);
  }, 30_000);

  it("leaves the Active tab on the offset pager, which is all the route allows there", async () => {
    jobsCalls = [];
    await seed("active-me");
    const screens = await load<WalkModule>(
      ["..", "queues", "realApiJobWalk"].join("/"),
    );
    await screens.mountJobPages(
      "active-me",
      fetchShim,
      `?state=active&limit=${PAGE}`,
      0,
    );
    const ours = jobsCalls.filter((call) => call.queue === "active-me");
    expect(ours.length).toBeGreaterThan(0);
    for (const call of ours) {
      expect(call.query.getAll("state")).toEqual(["active"]);
      expect(call.query.has("cursor")).toBe(false);
      expect(call.status).toBe(200);
    }

    // The route mints no cursor there — its order is `lockExpiresAt`, which
    // every lock renewal rewrites — so the UI has nothing to walk with, and
    // one sent anyway is refused.
    const page = await apiGet(`/queues/active-me/jobs?state=active&limit=1`);
    expect(page.status).toBe(200);
    expect(page.body.page?.next ?? null).toBeNull();
    const refused = await apiGet(
      `/queues/active-me/jobs?state=active&limit=1&cursor=whatever`,
    );
    expect(refused.status).toBe(400);
    expect(refused.body.detail ?? "").toContain("active");
  }, 30_000);
});
