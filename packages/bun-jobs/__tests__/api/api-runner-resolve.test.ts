import type { ResolvedJobsApiConfig } from "../../lib/api/config";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_JOBS_API_LIMITS, resolveConfig } from "../../lib/api/config";
import { ApiError } from "../../lib/api/errors";
import { RunnerSource } from "../../lib/api/sources";
import {
  ECHO_HANDLER,
  harness,
  jobsContext,
  openContexts,
  openHarnesses,
  registerRunnerElsewhere,
} from "./fixtures";

/**
 * Resolving a runner id against the cached discovery.
 *
 * The lookup is cached (`limits.queueCacheMs`) so a client cannot make a
 * backend read per request out of it, but a miss on a *cached* discovery is
 * not the last word: another process may have started the runner since the
 * cache was filled. `TtlSet.has` is what reconciles the two — one extra read
 * per cache window, shared by every miss in it — and these tests hold both
 * halves of that bargain in place: the new runner is found at once, and an id
 * nothing knows still cannot be made to hammer the driver.
 */

afterEach(() => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
});

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

/** A controllable clock. */
function clock() {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** Resolves a configuration around `jobs`. */
function resolve(
  jobs: ReturnType<typeof jobsContext>,
  overrides: Record<string, unknown> = {},
): ResolvedJobsApiConfig {
  return resolveConfig({
    jobs,
    basePath: "/admin/jobs",
    authorize: () => true,
    logger: createTestLogger().logger,
    ...overrides,
  });
}

/**
 * A source whose manager counts its discovery reads, over the default cache
 * window and a clock the test moves.
 */
function countingSource(namespace: string) {
  const jobs = jobsContext(namespace);
  let discoveries = 0;
  const discover = jobs.runners.discover.bind(jobs.runners);
  jobs.runners.discover = async () => {
    discoveries++;
    return await discover();
  };
  const time = clock();
  const source = new RunnerSource(resolve(jobs), { now: time.now });
  return { jobs, source, time, reads: () => discoveries };
}

/** Awaits `promise`, expecting an ApiError with this code and status. */
async function expectApiError(
  promise: Promise<unknown>,
  code: string,
  status: number,
) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  expect((error as ApiError).status).toBe(status);
}

describe("runner lookup after the discovery cache was filled", () => {
  it("finds a runner another context started, at once, with the default queueCacheMs", async () => {
    // The default cache window, not the route suites' `queueCacheMs: 0`: this
    // is exactly the configuration the bug was reported against.
    const h = harness({
      jobs: jobsContext("api-runner-resolve-http"),
      limits: { queueCacheMs: DEFAULT_JOBS_API_LIMITS.queueCacheMs },
    });
    h.jobs.runner({
      id: "nightly",
      file: ECHO_HANDLER,
      executionMode: "in-process",
    });

    // A first request fills the discovery cache, as the reported repro's
    // `PUT /runners/report/config` did.
    expect((await h.call("GET", "/runners")).status).toBe(200);

    // Another context starts a runner the cached discovery has never seen.
    await registerRunnerElsewhere(h.jobs, "keys-report");

    // Before the fix this was 404 for the rest of the cache window.
    const read = await h.call("GET", "/runners/keys-report");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: "keys-report", isLocal: false });

    // And every other route reaching the same runner, which all resolve it.
    expect((await h.call("GET", "/runners/keys-report/stats")).status).toBe(
      200,
    );
    expect((await h.call("POST", "/runners/keys-report/pause")).status).toBe(
      200,
    );
  });

  it("re-reads at most once per window for an unknown id, and still 404s it", async () => {
    const { jobs, source, time, reads } = countingSource(
      "api-runner-resolve-unknown",
    );
    await registerRunnerElsewhere(jobs, "known");

    // One read fills the cache.
    expect(await source.list()).toEqual({ local: [], remote: ["known"] });
    expect(reads()).toBe(1);

    // A miss on the cached discovery spends the window's one re-read...
    await expectApiError(source.resolve("ghost"), "RUNNER_NOT_FOUND", 404);
    expect(reads()).toBe(2);

    // ...and a second lookup of the same unknown id inside the window does
    // not read again, nor does a different unknown id.
    await expectApiError(source.resolve("ghost"), "RUNNER_NOT_FOUND", 404);
    await expectApiError(source.resolve("spectre"), "RUNNER_NOT_FOUND", 404);
    expect(reads()).toBe(2);

    // A runner registered elsewhere meanwhile has to wait for the window,
    // which is the price of that bound.
    await registerRunnerElsewhere(jobs, "later");
    await expectApiError(source.resolve("later"), "RUNNER_NOT_FOUND", 404);
    expect(reads()).toBe(2);

    // Past the window, a miss may re-read again — and finds it.
    time.advance(DEFAULT_JOBS_API_LIMITS.queueCacheMs);
    expect((await source.resolve("later")).local).toBe(false);
    expect(reads()).toBe(3);
  });

  it("shares one re-read between lookups arriving together", async () => {
    const { jobs, source, reads } = countingSource("api-runner-resolve-share");
    await registerRunnerElsewhere(jobs, "known");
    expect((await source.resolve("known")).local).toBe(false);
    expect(reads()).toBe(1);

    await registerRunnerElsewhere(jobs, "fresh");
    const settled = await Promise.all([
      source.resolve("fresh").then(
        () => "found",
        () => "missing",
      ),
      source.resolve("fresh").then(
        () => "found",
        () => "missing",
      ),
      source.resolve("ghost").then(
        () => "found",
        () => "missing",
      ),
    ]);
    expect(settled).toEqual(["found", "found", "missing"]);
    expect(reads()).toBe(2);
  });

  it("leaves a runner the configuration refuses a 404, with no extra read", async () => {
    const jobs = jobsContext("api-runner-resolve-refused");
    let discoveries = 0;
    const discover = jobs.runners.discover.bind(jobs.runners);
    jobs.runners.discover = async () => {
      discoveries++;
      return await discover();
    };
    const listed = jobs.runner({
      id: "listed",
      file: ECHO_HANDLER,
      executionMode: "in-process",
    });
    await registerRunnerElsewhere(jobs, "remote");

    // A fixed `runners` list is not discovery at all: a runner the backend
    // knows but the list does not is 404, however fresh it is, and no read is
    // made to decide that.
    const fixed = new RunnerSource(resolve(jobs, { runners: [listed] }));
    expect((await fixed.resolve("listed")).local).toBe(true);
    await expectApiError(fixed.resolve("remote"), "RUNNER_NOT_FOUND", 404);
    await expectApiError(fixed.resolve("remote"), "RUNNER_NOT_FOUND", 404);
    expect(discoveries).toBe(0);
  });

  it("leaves an authorised-away runner a 403, not a lookup", async () => {
    const h = harness({
      jobs: jobsContext("api-runner-resolve-authz"),
      limits: { queueCacheMs: DEFAULT_JOBS_API_LIMITS.queueCacheMs },
      authorize: (_req, context) => context.runner !== "keys-report",
    });
    h.jobs.runner({
      id: "nightly",
      file: ECHO_HANDLER,
      executionMode: "in-process",
    });
    expect((await h.call("GET", "/runners")).status).toBe(200);
    await registerRunnerElsewhere(h.jobs, "keys-report");

    // The refusal comes from `authorize`, before the runner is looked up, so
    // the re-read never runs and the answer is 403 rather than 404 — whether
    // the runner exists or not.
    const refused = await h.call("GET", "/runners/keys-report");
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect((await h.call("GET", "/runners/nightly")).status).toBe(200);
  });
});
