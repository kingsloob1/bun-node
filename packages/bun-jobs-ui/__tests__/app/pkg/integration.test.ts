import type { JobsApiConfig } from "@kingsleyweb/bun-jobs";
import type { FetchLike } from "../../../app/api/client";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createApiClient } from "../../../app/api/client";
import { ApiError } from "../../../app/api/errors";

/**
 * The app's client against a REAL `createJobsApi` (memory driver), through
 * the router's socket-free `fetch()`: proves the requests the client builds —
 * headers, query serialisation, bodiless mutations, CSRF — are the ones the
 * API accepts, not just the ones the mocks expect.
 */

const CSRF = "x-bun-jobs-csrf";
const BASE = "/jobs-api";

/** Everything opened, closed after the suite. */
const contexts: BunJobs[] = [];

/** A mounted API, and a `fetch` shim routing the client's requests into it. */
async function mount(overrides: Partial<JobsApiConfig> = {}) {
  const jobs = new BunJobs({
    namespace: `ui-integration-${contexts.length}`,
    driver: new MemoryDriver(),
  });
  contexts.push(jobs);
  const api = createJobsApi({
    jobs,
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    limits: { queueCacheMs: 0 },
    csrf: { header: CSRF },
    ...overrides,
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  const seen: { method: string; url: string; headers: Headers }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(new URL(input, "http://localhost").href, init);
    seen.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
    });
    return root.fetch(request);
  };
  await jobs.queue("emails").add("send", { to: "a@example.com" });
  await jobs.queue("reports").add("build", { day: 1 });
  return { jobs, api, fetch, seen };
}

/** Awaits a rejection as an ApiError. */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

let harness: Awaited<ReturnType<typeof mount>>;

beforeAll(async () => {
  harness = await mount();
});

afterAll(async () => {
  for (const jobs of contexts) {
    await jobs.close();
  }
});

describe("the app client against a real createJobsApi", () => {
  it("reads meta and permissions", async () => {
    const client = createApiClient(
      { apiBase: BASE, csrfHeader: CSRF },
      { fetch: harness.fetch },
    );
    const meta = await client.getMeta();
    expect(meta.namespace).toBe("ui-integration-0");
    expect(meta.driver.name).toBe("memory");
    expect(meta.protocol).toBe(1);

    const permissions = await client.getPermissions();
    expect(permissions.actions["meta.read"]).toBe(true);
    // Opt-in actions are pruned by default: absent, not false.
    expect("jobs.add" in permissions.actions).toBe(false);

    const targeted = await client.getPermissions({ queue: "emails" });
    expect(targeted.actions["queues.pause"]).toBe(true);
  });

  it("reads the overview, the queue list (with and without search), throughput and workers", async () => {
    const client = createApiClient(
      { apiBase: BASE, csrfHeader: CSRF },
      { fetch: harness.fetch },
    );
    const overview = await client.getOverview(15);
    expect(overview.queues).toBe(2);
    expect(overview.counts.waiting).toBe(2);
    expect(overview.throughput?.minutes).toBe(15);

    const all = await client.listQueues();
    expect(all.items.map((queue) => queue.name)).toEqual(["emails", "reports"]);
    // An empty search is sent as no key at all, which the API accepts.
    expect((await client.listQueues("")).items).toHaveLength(2);
    const some = await client.listQueues("mail");
    expect(some.items.map((queue) => queue.name)).toEqual(["emails"]);

    const throughput = await client.getQueueThroughput("emails", 3);
    expect(throughput.buckets).toHaveLength(3);
    expect(throughput.interval).toBe(60_000);

    const workers = await client.listWorkers();
    expect(workers.items).toEqual([]);
  });

  it("pauses and resumes a queue with a bodiless POST carrying the CSRF header", async () => {
    const client = createApiClient(
      { apiBase: BASE, csrfHeader: CSRF },
      { fetch: harness.fetch },
    );
    expect(await client.pauseQueue("emails")).toEqual({ paused: true });
    const request = harness.seen.at(-1)!;
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get(CSRF)).toBe("1");

    const listed = await client.listQueues("emails");
    expect(listed.items[0]!.paused).toBe(true);
    expect(await client.resumeQueue("emails")).toEqual({ paused: false });
  });

  it("is refused without the CSRF header the API requires (the control)", async () => {
    const client = createApiClient(
      { apiBase: BASE, csrfHeader: null },
      { fetch: harness.fetch },
    );
    const error = await rejection(client.pauseQueue("emails"));
    expect(error.status).toBe(403);
    expect(error.code).toBe("CSRF_REJECTED");
    expect(error.context).toEqual({ header: CSRF });
    expect(error.type).toBe("urn:bun-jobs:error:CSRF_REJECTED");
  });

  it("would be refused without Content-Type on a bodiless POST (why the client always sends it)", async () => {
    const response = await harness.fetch(`${BASE}/queues/emails/pause`, {
      method: "POST",
      headers: { [CSRF]: "1" },
    });
    expect(response.status).toBe(415);
  });

  it("accepts a same-origin browser Origin on a mutation", async () => {
    const client = createApiClient(
      { apiBase: BASE, csrfHeader: CSRF },
      {
        fetch: (input, init) =>
          harness.fetch(input, {
            ...init,
            headers: {
              ...(init.headers as Record<string, string>),
              Origin: "http://localhost",
              "Sec-Fetch-Site": "same-origin",
            },
          }),
      },
    );
    expect(await client.pauseQueue("reports")).toEqual({ paused: true });
    expect(await client.resumeQueue("reports")).toEqual({ paused: false });
  });

  it("turns the API's problems into ApiErrors", async () => {
    const client = createApiClient(
      { apiBase: BASE, csrfHeader: CSRF },
      { fetch: harness.fetch },
    );
    const missing = await rejection(client.getQueueThroughput("nope"));
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("QUEUE_NOT_FOUND");
    expect(missing.context).toEqual({ queue: "nope" });

    const invalid = await rejection(client.getOverview(5000));
    expect(invalid.status).toBe(400);
    expect(invalid.code).toBe("VALIDATION");
    expect(invalid.issues[0]).toMatchObject({
      target: "query",
      path: "minutes",
    });

    const unrouted = await rejection(client.request("GET", "/nope"));
    expect(unrouted.code).toBe("ROUTE_NOT_FOUND");
  });

  it("surfaces a denied bootstrap as a 401 problem", async () => {
    const denied = await mount({
      authorize: () => ({ allow: false, status: 401, reason: "Sign in" }),
    });
    const client = createApiClient(
      { apiBase: BASE, csrfHeader: CSRF },
      { fetch: denied.fetch },
    );
    const error = await rejection(client.getMeta());
    expect(error.status).toBe(401);
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.detail).toBe("Sign in");
  });
});
