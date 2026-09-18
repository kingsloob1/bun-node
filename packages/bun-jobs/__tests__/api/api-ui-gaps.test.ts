import type { MetaDto, OverviewDto } from "@kingsleyweb/bun-jobs/api/contract";
import type { JobsApiAuthorizeContext } from "../../lib/api/config";
import type { BunJobs } from "../../lib/index";
import {
  MAX_JOB_ID_LENGTH,
  MAX_JOB_REF_LENGTH,
  NAME_PARAM_PATTERN,
} from "@kingsleyweb/bun-jobs/api/contract";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { resolveConfig } from "../../lib/api/config";
import { parseChannel } from "../../lib/api/ws/channels";
import { BunQueueWorker } from "../../lib/index";
import { waitFor } from "../helpers";
import {
  ECHO_HANDLER,
  harness,
  jobsContext,
  openContexts,
  openHarnesses,
} from "./fixtures";

/**
 * What a management UI needs from the API beyond the first cut: the CSRF
 * rules, limits, addable names and socket port in `/meta` and `api.info`
 * (G1, G2, G4, G10); the job-id cap (G6); CSRF and name patterns in the
 * OpenAPI document (G9); the namespace-wide throughput series (G11); queue
 * paging, case-insensitive queue search and the channel preview (G12). The
 * last block checks real responses against the generated OpenAPI document
 * itself, with ajv.
 */

/** Things to close after each test, newest first. */
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
  while (closers.length > 0) {
    await closers.pop()!().catch(() => undefined);
  }
});

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

/** A harness whose API is closed after the test (it may own a socket port). */
function closing(overrides: Parameters<typeof harness>[0] = {}) {
  const h = harness(overrides);
  closers.push(async () => await h.api.close());
  return h;
}

/** Starts a worker on a queue, closed after the test. */
function startWorker(jobs: BunJobs, queue: string): void {
  const worker = new BunQueueWorker(queue, async () => "ok", {
    namespace: jobs.namespace,
    driver: jobs.driver,
    pollInterval: 10,
  });
  closers.push(async () => await worker.close({ timeout: 1_000 }));
  void worker.run();
}

/** `GET /meta`, typed. */
async function meta(h: ReturnType<typeof harness>): Promise<MetaDto> {
  const res = await h.call("GET", "/meta");
  expect(res.status).toBe(200);
  return res.body as MetaDto;
}

describe("G1: CSRF rules in /meta and api.info", () => {
  it("reports the defaults, a header, and csrf: false", async () => {
    const plain = closing();
    expect((await meta(plain)).csrf).toEqual({
      header: null,
      requireJson: true,
    });
    expect(plain.api.info.csrf).toEqual({ header: null, requireJson: true });

    // The header is reported as it is enforced: lower case.
    const header = closing({ csrf: { header: "X-CSRF-Token" } });
    expect((await meta(header)).csrf).toEqual({
      header: "x-csrf-token",
      requireJson: true,
    });
    const refused = await header.call("POST", "/queues/mail/pause");
    expect(refused.status).toBe(403);
    expect(refused.body.context).toEqual({ header: "x-csrf-token" });

    const loose = closing({ csrf: { requireJson: false } });
    expect((await meta(loose)).csrf).toEqual({
      header: null,
      requireJson: false,
    });

    const off = closing({ csrf: false });
    expect((await meta(off)).csrf).toEqual({
      header: null,
      requireJson: false,
    });
    expect(off.api.info.csrf).toEqual({ header: null, requireJson: false });
  });
});

describe("G1: api.info", () => {
  it("reports the resolved configuration, frozen", () => {
    const h = closing({ basePath: "/admin/jobs/", readOnly: true });
    expect(h.api.info).toEqual({
      basePath: "/admin/jobs",
      namespace: h.jobs.namespace,
      mode: "both",
      readOnly: true,
      csrf: { header: null, requireJson: true },
      docs: {
        openapi: "/admin/jobs/openapi.json",
        asyncapi: "/admin/jobs/asyncapi.json",
      },
      websocket: { path: "/admin/jobs/ws" },
    });
    expect(Object.isFrozen(h.api.info)).toBe(true);
    expect(Object.isFrozen(h.api.info.csrf)).toBe(true);
    expect(Object.isFrozen(h.api.info.docs)).toBe(true);
    expect(Object.isFrozen(h.api.info.websocket)).toBe(true);
  });

  it("follows the docs and socket options, and what is actually routed", () => {
    const moved = closing({
      docs: { openapiPath: "/spec.json", asyncapiPath: "/events.json" },
      websocket: { path: "/live" },
    });
    expect(moved.api.info.docs).toEqual({
      openapi: "/admin/jobs/spec.json",
      asyncapi: "/admin/jobs/events.json",
    });
    expect(moved.api.info.websocket).toEqual({ path: "/admin/jobs/live" });

    const noSocket = closing({ websocket: false });
    expect(noSocket.api.info.websocket).toBeNull();
    expect(noSocket.api.info.docs).toEqual({
      openapi: "/admin/jobs/openapi.json",
    });

    const noDocs = closing({ docs: false });
    expect(noDocs.api.info.docs).toBeNull();

    // `docs.read` not allowed: the documents are not routed, so not reported.
    const unreadable = closing({ actions: ["meta.read", "queues.list"] });
    expect(unreadable.api.info.docs).toBeNull();
    expect(unreadable.api.info.websocket).toBeNull();
  });

  it("reports a dedicated socket's bound port, as the socket does", () => {
    const h = closing({ websocket: { port: 0 } });
    const port = h.api.info.websocket?.port;
    expect(port).toBeGreaterThan(0);
    expect(port).toBe(h.api.websocket!.port!);
  });
});

describe("G2: limits in /meta, each the one the routes enforce", () => {
  /** Small, distinct caps, so a probe cannot pass by accident. */
  const limits = {
    defaultPageSize: 3,
    maxPageSize: 7,
    maxBulkIds: 4,
    maxRetryAll: 5,
    maxClean: 6,
    maxLogPage: 8,
    maxHistory: 9,
    maxJobDataBytes: 2048,
    maxQueues: 2,
  };

  it("reports the defaults when none are configured", async () => {
    const h = closing();
    expect((await meta(h)).limits).toEqual({
      defaultPageSize: 20,
      maxPageSize: 100,
      maxBulkIds: 1000,
      maxRetryAll: 10_000,
      maxRetryAllIds: 1000,
      maxClean: 10_000,
      defaultClean: 1000,
      maxLogPage: 500,
      maxHistory: 200,
      maxJobDataBytes: 1_048_576,
      maxQueues: 500,
    });
  });

  it("reports every configured cap, and every one of them is the cap a route enforces", async () => {
    const h = closing({
      limits: { ...limits, queueCacheMs: 0 },
      addableNames: "any",
    });
    const reported = (await meta(h)).limits;
    // Two are not options: the clean default follows maxClean, and the id cap
    // of a retry-all's answer is fixed.
    expect(reported).toEqual({
      ...limits,
      defaultClean: Math.min(1000, limits.maxClean),
      maxRetryAllIds: 1000,
    });

    const queue = h.jobs.queue("mail");
    const job = await queue.add("send", {});
    await h.jobs.queue("other").add("send", {});
    await h.jobs.queue("third").add("send", {});
    h.jobs.runner({
      id: "nightly",
      file: ECHO_HANDLER,
      executionMode: "in-process",
    });

    /** Asserts `ok` answers 2xx and `over` answers `status` with `code`. */
    const edge = async (
      ok: () => Promise<{ status: number }>,
      over: () => Promise<{ status: number; body: { code?: string } }>,
      status: number,
      code: string,
    ) => {
      const accepted = await ok();
      expect(accepted.status).toBeGreaterThanOrEqual(200);
      expect(accepted.status).toBeLessThan(300);
      const refused = await over();
      expect({ status: refused.status, code: refused.body.code }).toEqual({
        status,
        code,
      });
    };
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => `id-${index}`);

    /** Adds `count` waiting jobs to a queue of their own. */
    const waiting = async (queueName: string, count: number) => {
      await h.jobs.queue(queueName).addBulk(
        Array.from({ length: count }, (_, index) => ({
          name: "send",
          data: { index },
        })),
      );
    };

    const probes: Record<keyof typeof reported, () => Promise<void>> = {
      defaultPageSize: async () => {
        const page = await h.call("GET", "/queues/mail/jobs");
        expect(page.body.page.limit).toBe(reported.defaultPageSize);
      },
      maxPageSize: () =>
        edge(
          () =>
            h.call("GET", `/queues/mail/jobs?limit=${reported.maxPageSize}`),
          () =>
            h.call(
              "GET",
              `/queues/mail/jobs?limit=${reported.maxPageSize + 1}`,
            ),
          400,
          "VALIDATION",
        ),
      maxBulkIds: () =>
        edge(
          () =>
            h.call("POST", "/queues/mail/jobs/lookup", {
              ids: ids(reported.maxBulkIds),
            }),
          () =>
            h.call("POST", "/queues/mail/jobs/lookup", {
              ids: ids(reported.maxBulkIds + 1),
            }),
          400,
          "BULK_LIMIT",
        ),
      maxRetryAll: () =>
        edge(
          () =>
            h.call("POST", "/queues/mail/jobs/retry-all", {
              state: "dead",
              limit: reported.maxRetryAll,
            }),
          () =>
            h.call("POST", "/queues/mail/jobs/retry-all", {
              state: "dead",
              limit: reported.maxRetryAll + 1,
            }),
          400,
          "VALIDATION",
        ),
      defaultClean: async () => {
        // Exactly the default is all cleaned; one more leaves exactly one.
        const clean = () =>
          h.call("POST", "/queues/cleaning/clean", {
            state: "waiting",
            olderThan: 0,
          });
        await waiting("cleaning", reported.defaultClean);
        await Bun.sleep(5);
        expect((await clean()).body.count).toBe(reported.defaultClean);
        await waiting("cleaning", reported.defaultClean + 1);
        await Bun.sleep(5);
        expect((await clean()).body.count).toBe(reported.defaultClean);
        expect(await h.jobs.queue("cleaning").count("waiting")).toBe(1);
      },
      maxRetryAllIds: async () => {
        // maxRetryAll here is below the id cap, so the cap is probed on an
        // API with the default maxRetryAll, over the same backend.
        const wide = closing({ jobs: h.jobs, limits: { queueCacheMs: 0 } });
        const retryAll = async () =>
          await wide.call("POST", "/queues/redrive/jobs/retry-all", {
            state: "completed",
          });
        const finish = async (count: number) => {
          await waiting("redrive", count);
          const ref = { ns: h.jobs.namespace, queue: "redrive" };
          for (let index = 0; index < count; index++) {
            const token = `t-${index}`;
            const record = await h.jobs.driver.claimJob(ref, {
              workerId: "probe",
              token,
              lockMs: 60_000,
              now: Date.now(),
            });
            await h.jobs.driver.completeJob(
              ref,
              record!.id,
              token,
              "ok",
              false,
              Date.now(),
            );
          }
        };

        await finish(reported.maxRetryAllIds);
        const at = await retryAll();
        expect(at.body).toMatchObject({
          count: reported.maxRetryAllIds,
          truncated: false,
        });
        expect(at.body.ids).toHaveLength(reported.maxRetryAllIds);
        await h.jobs.queue("redrive").drain();

        await finish(reported.maxRetryAllIds + 1);
        const over = await retryAll();
        expect(over.body).toMatchObject({
          count: reported.maxRetryAllIds + 1,
          truncated: true,
        });
        expect(over.body.ids).toHaveLength(reported.maxRetryAllIds);
      },
      maxClean: () =>
        edge(
          () =>
            h.call("POST", "/queues/mail/clean", {
              state: "completed",
              olderThan: 0,
              limit: reported.maxClean,
            }),
          () =>
            h.call("POST", "/queues/mail/clean", {
              state: "completed",
              olderThan: 0,
              limit: reported.maxClean + 1,
            }),
          400,
          "VALIDATION",
        ),
      maxLogPage: () =>
        edge(
          () =>
            h.call(
              "GET",
              `/queues/mail/jobs/${job.id}/logs?limit=${reported.maxLogPage}`,
            ),
          () =>
            h.call(
              "GET",
              `/queues/mail/jobs/${job.id}/logs?limit=${reported.maxLogPage + 1}`,
            ),
          400,
          "VALIDATION",
        ),
      maxHistory: () =>
        edge(
          () =>
            h.call(
              "GET",
              `/runners/nightly/history?limit=${reported.maxHistory}`,
            ),
          () =>
            h.call(
              "GET",
              `/runners/nightly/history?limit=${reported.maxHistory + 1}`,
            ),
          400,
          "VALIDATION",
        ),
      maxJobDataBytes: () => {
        // A body of exactly the cap is read; one byte more is refused unread.
        const sized = (bytes: number) => {
          const shell = JSON.stringify({ name: "send", data: "" });
          return JSON.stringify({
            name: "send",
            data: "x".repeat(bytes - shell.length),
          });
        };
        expect(sized(reported.maxJobDataBytes)).toHaveLength(
          reported.maxJobDataBytes,
        );
        return edge(
          () =>
            h.call(
              "POST",
              "/queues/mail/jobs",
              sized(reported.maxJobDataBytes),
            ),
          () =>
            h.call(
              "POST",
              "/queues/mail/jobs",
              sized(reported.maxJobDataBytes + 1),
            ),
          413,
          "PAYLOAD_TOO_LARGE",
        );
      },
      maxQueues: async () => {
        await edge(
          () => h.call("GET", `/queues?limit=${reported.maxQueues}`),
          () => h.call("GET", `/queues?limit=${reported.maxQueues + 1}`),
          400,
          "VALIDATION",
        );
        const overview = await h.call("GET", "/overview");
        expect(overview.body).toMatchObject({
          queues: reported.maxQueues,
          truncated: true,
        });
      },
    };

    // A limit reported without a probe here fails this line.
    expect(Object.keys(probes).sort()).toEqual(Object.keys(reported).sort());
    for (const [name, probe] of Object.entries(probes)) {
      try {
        await probe();
      } catch (error) {
        throw new Error(`limit ${name}: ${String(error)}`);
      }
    }
  });
});

describe("G4: the socket's dedicated port in /meta", () => {
  it("is reported when the socket has its own port, and absent otherwise", async () => {
    const dedicated = closing({ websocket: { port: 0 } });
    const reported = (await meta(dedicated)).websocket;
    expect(reported?.port).toBe(dedicated.api.websocket!.port!);
    expect(reported?.port).toBeGreaterThan(0);

    const shared = closing();
    const sharedSocket = (await meta(shared)).websocket;
    expect(sharedSocket).not.toBeNull();
    expect(sharedSocket).not.toHaveProperty("port");
  });
});

describe("G6: a new job id is capped where bun-jobs caps it; existing ids stay reachable", () => {
  it("still reads, looks up and removes a stored job whose id is longer than the new-id cap", async () => {
    const h = closing();
    const legacy = "L".repeat(1000);
    // Stored directly through the queue, as an older version could have.
    await h.jobs.queue("mail").add("send", {}, { jobId: legacy });

    const read = await h.call("GET", `/queues/mail/jobs/${legacy}`);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(legacy);
    const looked = await h.call("POST", "/queues/mail/jobs/lookup", {
      ids: [legacy],
    });
    expect(looked.status).toBe(200);
    expect(looked.body.items[0].id).toBe(legacy);
    const removed = await h.call("POST", "/queues/mail/jobs/remove", {
      ids: [legacy],
    });
    expect(removed.body).toEqual({ removed: [legacy], skipped: [] });
    // Past the addressing cap is still a validation error.
    const overRef = await h.call(
      "GET",
      `/queues/mail/jobs/${"L".repeat(MAX_JOB_REF_LENGTH + 1)}`,
    );
    expect(overRef.status).toBe(400);
    expect(overRef.body.code).toBe("VALIDATION");
  });

  it("adds a 191-character opts.jobId and refuses 192 as a validation error", async () => {
    const h = closing({ addableNames: "any" });
    await h.jobs.queue("mail").add("send", {});
    const add = (jobId: string) =>
      h.call("POST", "/queues/mail/jobs", {
        name: "send",
        data: null,
        opts: { jobId },
      });

    const added = await add("j".repeat(MAX_JOB_ID_LENGTH));
    expect(added.status).toBe(201);
    expect(added.body.job.id).toBe("j".repeat(MAX_JOB_ID_LENGTH));
    const overCap = await add("j".repeat(MAX_JOB_ID_LENGTH + 1));
    expect(overCap.status).toBe(400);
    expect(overCap.body.code).toBe("VALIDATION");
    expect(overCap.body.issues[0].path).toBe("opts.jobId");
  });

  it("documents 191 on opts.jobId and 1024 wherever an id addresses a job", () => {
    const document = closing().api.openapi() as any;
    const params = document.paths["/queues/{queue}/jobs/{id}"].get.parameters;
    const id = params.find((param: { name: string }) => param.name === "id");
    expect(id.schema.maxLength).toBe(MAX_JOB_REF_LENGTH);
    const body = (path: string) =>
      document.paths[path].post.requestBody.content["application/json"].schema;
    expect(
      body("/queues/{queue}/jobs").properties.opts.properties.jobId.maxLength,
    ).toBe(MAX_JOB_ID_LENGTH);
    for (const path of [
      "/queues/{queue}/jobs/lookup",
      "/queues/{queue}/jobs/retry",
      "/queues/{queue}/jobs/remove",
      "/queues/{queue}/jobs/promote",
    ]) {
      expect({ path, max: body(path).properties.ids.items.maxLength }).toEqual({
        path,
        max: MAX_JOB_REF_LENGTH,
      });
    }
  });
});

describe("G9: the OpenAPI document states the CSRF rules and name patterns", () => {
  /** An operation of a generated document. */
  const op = (document: any, path: string, method: string) =>
    document.paths[path][method];

  it("declares the CSRF header on every mutation, and only there", () => {
    const document = closing({
      csrf: { header: "X-CSRF-Token" },
    }).api.openapi() as any;
    for (const [path, item] of Object.entries<any>(document.paths)) {
      for (const [method, operation] of Object.entries<any>(item)) {
        const header = (operation.parameters ?? []).find(
          (param: { in: string }) => param.in === "header",
        );
        if (operation["x-bun-jobs-mutation"]) {
          expect({ path, method, header }).toEqual({
            path,
            method,
            header: expect.objectContaining({
              name: "x-csrf-token",
              in: "header",
              required: true,
            }),
          });
          expect(operation["x-bun-jobs-csrf"].header).toBe("x-csrf-token");
        } else {
          expect({ path, method, header }).toEqual({
            path,
            method,
            header: undefined,
          });
          expect(operation["x-bun-jobs-csrf"]).toBeUndefined();
        }
      }
    }
  });

  it("says a bodiless POST still needs Content-Type: application/json — and it does", async () => {
    const h = closing();
    const document = h.api.openapi() as any;
    const pause = op(document, "/queues/{queue}/pause", "post");
    expect(pause.requestBody.required).toBe(false);
    expect(pause.requestBody.description).toContain(
      "Content-Type: application/json",
    );
    expect(Object.keys(pause.requestBody.content)).toEqual([
      "application/json",
    ]);
    expect(pause["x-bun-jobs-csrf"]).toEqual({
      header: null,
      requireJson: true,
    });
    // An optional-body POST says the same about its body.
    const drain = op(document, "/queues/{queue}/drain", "post");
    expect(drain.requestBody.description).toContain(
      "Content-Type: application/json",
    );
    // A DELETE with no body needs no media type.
    expect(
      op(document, "/queues/{queue}/jobs/{id}", "delete").requestBody,
    ).toBeUndefined();

    // What the document says is what the API does.
    await h.jobs.queue("mail").add("send", {});
    const bare = await h.root.fetch("/admin/jobs/queues/mail/pause", {
      method: "POST",
    });
    expect(bare.status).toBe(415);
    const typed = await h.root.fetch("/admin/jobs/queues/mail/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(typed.status).toBe(200);
  });

  it("says nothing about the media type when requireJson is off, nor anything with csrf: false", () => {
    const loose = closing({
      csrf: { requireJson: false },
    }).api.openapi() as any;
    const pause = op(loose, "/queues/{queue}/pause", "post");
    expect(pause.requestBody).toBeUndefined();
    expect(pause["x-bun-jobs-csrf"]).toEqual({
      header: null,
      requireJson: false,
    });
    const off = closing({ csrf: false }).api.openapi() as any;
    expect(
      op(off, "/queues/{queue}/pause", "post").requestBody,
    ).toBeUndefined();
    expect(
      op(off, "/queues/{queue}/pause", "post")["x-bun-jobs-csrf"],
    ).toBeUndefined();
  });

  it("gives :queue and :runner the pattern the routes enforce, which the validator does not", async () => {
    const h = closing();
    const document = h.api.openapi() as any;
    const param = (path: string, method: string, name: string) =>
      op(document, path, method).parameters.find(
        (entry: { name: string }) => entry.name === name,
      );
    expect(param("/queues/{queue}", "get", "queue").schema).toMatchObject({
      pattern: NAME_PARAM_PATTERN,
      maxLength: 200,
    });
    expect(
      param("/queues/{queue}/jobs/{id}", "get", "queue").schema.pattern,
    ).toBe(NAME_PARAM_PATTERN);
    expect(param("/runners/{runner}", "get", "runner").schema).toMatchObject({
      pattern: NAME_PARAM_PATTERN,
      maxLength: 200,
    });
    // The rule is still the route's own, answered as INVALID_NAME.
    const bad = await h.call("GET", "/queues/bad%20name");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_NAME");
  });
});

describe("G10: addable names and trigger args in /meta", () => {
  it("reports the defined names by default, read at request time", async () => {
    const h = closing();
    expect((await meta(h)).addableNames).toEqual([]);
    h.jobs.define("send", async () => {});
    h.jobs.define("report", async () => {});
    expect((await meta(h)).addableNames).toEqual(["send", "report"]);
    // …and they are exactly what the route accepts.
    await h.jobs.queue("mail").add("send", {});
    const ok = await h.call("POST", "/queues/mail/jobs", {
      name: "send",
      data: {},
    });
    expect(ok.status).toBe(201);
    const refused = await h.call("POST", "/queues/mail/jobs", {
      name: "other",
      data: {},
    });
    expect(refused.body.code).toBe("NAME_NOT_ADDABLE");
  });

  it("is null for any name, the list when configured, and [] when adding is not routed", async () => {
    expect((await meta(closing({ addableNames: "any" }))).addableNames).toBe(
      null,
    );
    expect(
      (await meta(closing({ addableNames: ["a", "b", "a"] }))).addableNames,
    ).toEqual(["a", "b"]);

    const defaults = closing({ actions: undefined, addableNames: "any" });
    expect(defaults.api.routes.some((r) => r.operationId === "addJob")).toBe(
      false,
    );
    expect((await meta(defaults)).addableNames).toEqual([]);
    expect(
      (await meta(closing({ readOnly: true, addableNames: "any" })))
        .addableNames,
    ).toEqual([]);
  });

  it("reports runnerTriggerArgs only when trigger is routed and takes args", async () => {
    expect((await meta(closing())).runnerTriggerArgs).toBe(false);
    const on = closing({ runnerTriggerArgs: true });
    expect((await meta(on)).runnerTriggerArgs).toBe(true);
    const unrouted = closing({
      runnerTriggerArgs: true,
      actions: ["meta.read", "runners.read"],
    });
    expect((await meta(unrouted)).runnerTriggerArgs).toBe(false);
  });
});

describe("G11: the namespace-wide throughput series", () => {
  it("sums every queue's buckets minute by minute, in a queue's own shape", async () => {
    const jobs = jobsContext("api-ui-gaps-series");
    const h = closing({ jobs });
    await jobs.queue("mail").add("send", {});
    await jobs.queue("mail").add("send", {});
    await jobs.queue("reports").add("build", {});
    startWorker(jobs, "mail");
    startWorker(jobs, "reports");
    await waitFor(
      async () =>
        (await jobs.queue("mail").count("completed")) === 2 &&
        (await jobs.queue("reports").count("completed")) === 1,
    );
    // Throughput can be written up to a second after completion.
    await waitFor(
      async () =>
        (await jobs.queue("mail").getThroughput({ minutes: 5 })).completed ===
          2 &&
        (await jobs.queue("reports").getThroughput({ minutes: 5 }))
          .completed === 1,
    );

    const res = await h.call("GET", "/overview?minutes=5");
    expect(res.status).toBe(200);
    const body = res.body as OverviewDto;
    // The existing field is untouched.
    expect(body.throughput).toEqual({ minutes: 5, completed: 3, failed: 0 });
    const series = body.throughputSeries!;
    expect(series.interval).toBe(60_000);
    expect(series.buckets).toHaveLength(5);
    expect(series.to - series.from).toBe(4 * 60_000);
    expect(series.buckets[0]!.at).toBe(series.from);
    expect(series.buckets.at(-1)!.at).toBe(series.to);
    expect(series.completed).toBe(3);
    expect(series.failed).toBe(0);

    const mail = await h.call("GET", "/queues/mail/throughput?minutes=5");
    const reports = await h.call("GET", "/queues/reports/throughput?minutes=5");
    for (const bucket of series.buckets) {
      const sum = [mail.body, reports.body]
        .map(
          (read: { buckets: { at: number; completed: number }[] }) =>
            read.buckets.find((one) => one.at === bucket.at)?.completed ?? 0,
        )
        .reduce((a, b) => a + b, 0);
      expect({ at: bucket.at, completed: bucket.completed }).toEqual({
        at: bucket.at,
        completed: sum,
      });
    }
  });

  it("is absent exactly when throughput is", async () => {
    const h = closing();
    await h.jobs.queue("mail").add("send", {});
    const body = (await h.call("GET", "/overview")).body as OverviewDto;
    expect(body.throughput).toBeDefined();
    expect(body.throughputSeries?.buckets).toHaveLength(60);
  });
});

describe("G12: queue search, paging and the channel preview", () => {
  it("searches queue names ignoring case, like job search", async () => {
    const h = closing();
    await h.jobs.queue("Mail").add("send", {});
    await h.jobs.queue("reports").add("build", {});
    const names = async (search: string) =>
      (await h.call("GET", `/queues?search=${search}`)).body.items.map(
        (item: { name: string }) => item.name,
      );
    expect(await names("mail")).toEqual(["Mail"]);
    expect(await names("MAIL")).toEqual(["Mail"]);
    expect(await names("REP")).toEqual(["reports"]);
  });

  it("pages queues with offset and limit, past maxQueues", async () => {
    const h = closing({ limits: { queueCacheMs: 0, maxQueues: 2 } });
    for (const name of ["a", "b", "c", "d", "e"]) {
      await h.jobs.queue(name).add("send", {});
    }
    const page = async (query: string) =>
      (await h.call("GET", `/queues${query}`)).body;

    const first = await page("");
    expect(first.items.map((item: { name: string }) => item.name)).toEqual([
      "a",
      "b",
    ]);
    expect(first.truncated).toBe(true);
    expect(first.page).toEqual({
      offset: 0,
      limit: 2,
      total: 5,
      hasMore: true,
    });

    const last = await page("?offset=4");
    expect(last.items.map((item: { name: string }) => item.name)).toEqual([
      "e",
    ]);
    expect(last.truncated).toBe(false);
    expect(last.page).toEqual({
      offset: 4,
      limit: 2,
      total: 5,
      hasMore: false,
    });

    const narrowed = await page("?offset=1&limit=1&search=D");
    expect(narrowed.items).toEqual([]);
    expect(narrowed.page).toEqual({
      offset: 1,
      limit: 1,
      total: 1,
      hasMore: false,
    });
  });

  it("previews a channel as a subscribe frame would be decided", async () => {
    const calls: JobsApiAuthorizeContext[] = [];
    const h = closing({
      authorize: (_req, context) => {
        calls.push(context);
        return !(
          context.action === "events.subscribe" && context.queue === "secret"
        );
      },
    });
    const preview = async (channel: string) => {
      const res = await h.call(
        "GET",
        `/meta/permissions?channel=${encodeURIComponent(channel)}`,
      );
      expect(res.status).toBe(200);
      return res.body.channel;
    };

    expect(await preview("queue/mail")).toEqual({
      channel: "queue/mail",
      key: "queue/mail",
      allowed: true,
    });
    const subscribe = calls.filter(
      (call) => call.action === "events.subscribe" && call.channel,
    );
    expect(subscribe.at(-1)).toMatchObject({
      action: "events.subscribe",
      transport: "ws",
      channel: "queue/mail",
      queue: "mail",
      mutation: false,
    });

    expect(await preview("queue/secret")).toEqual({
      channel: "queue/secret",
      key: "queue/secret",
      allowed: false,
      code: "FORBIDDEN",
      status: 403,
      detail: "Not allowed to perform this action",
    });
    expect(await preview("queue/mail/job/a%2Fb")).toMatchObject({
      key: "queue/mail/job/a%2Fb",
      allowed: true,
    });
    expect(await preview("bogus")).toMatchObject({
      allowed: false,
      code: "INVALID_CHANNEL",
      status: 400,
    });
    expect((await h.call("GET", "/meta/permissions")).body).not.toHaveProperty(
      "channel",
    );

    const jobsOnly = closing({ mode: "jobs" });
    const unavailable = await jobsOnly.call(
      "GET",
      "/meta/permissions?channel=runner/nightly",
    );
    expect(unavailable.body.channel).toMatchObject({
      allowed: false,
      code: "CHANNEL_NOT_AVAILABLE",
      status: 404,
    });

    const listed = closing({ queues: ["mail"] });
    expect(
      (await listed.call("GET", "/meta/permissions?channel=queue/other")).body
        .channel,
    ).toMatchObject({ allowed: false, code: "QUEUE_NOT_FOUND" });
  });
});

describe("a channel preview's key", () => {
  it("is present whenever the channel parsed, refused afterwards or not", async () => {
    const preview = async (h: ReturnType<typeof harness>, channel: string) => {
      const res = await h.call(
        "GET",
        `/meta/permissions?channel=${encodeURIComponent(channel)}`,
      );
      expect(res.status).toBe(200);
      return res.body.channel;
    };

    // Parsed, then refused by the mode: the key is the canonical name.
    const jobsOnly = closing({ mode: "jobs" });
    expect(await preview(jobsOnly, "runner/nightly")).toMatchObject({
      channel: "runner/nightly",
      key: "runner/nightly",
      code: "CHANNEL_NOT_AVAILABLE",
    });

    // Parsed, then refused by a configured list: canonical, the job id
    // re-encoded (a lower-case escape comes back upper-case).
    const listed = closing({ queues: ["mail"] });
    expect(await preview(listed, "queue/other")).toMatchObject({
      key: "queue/other",
      code: "QUEUE_NOT_FOUND",
    });
    expect(await preview(listed, "queue/other/job/a%2fb")).toMatchObject({
      channel: "queue/other/job/a%2fb",
      key: "queue/other/job/a%2Fb",
      code: "QUEUE_NOT_FOUND",
    });
    const context = jobsContext();
    const nightly = context.runner({
      id: "nightly",
      file: ECHO_HANDLER,
      executionMode: "in-process",
    });
    const oneRunner = closing({ jobs: context, runners: [nightly] });
    expect(await preview(oneRunner, "runner/ghost")).toMatchObject({
      key: "runner/ghost",
      code: "RUNNER_NOT_FOUND",
    });

    // Did not parse: no key.
    for (const bad of ["bogus", "queue/bad name", "queue/mail/job/%E0%A4%A"]) {
      const refused = await preview(listed, bad);
      expect(refused).toMatchObject({ code: "INVALID_CHANNEL" });
      expect(refused).not.toHaveProperty("key");
    }
  });

  it("is not added to a subscribe ack's rejections", () => {
    const config = resolveConfig({
      jobs: jobsContext(),
      basePath: "/admin/jobs",
      authorize: () => true,
      queues: ["mail"],
    });
    const result = parseChannel("queue/other", config);
    expect(result).toMatchObject({ ok: false, key: "queue/other" });
    expect(result.ok ? undefined : result.rejection).toEqual({
      code: "QUEUE_NOT_FOUND",
      status: 404,
      detail: 'Queue "other" was not found',
    });
  });
});

describe("real responses match the generated OpenAPI document", () => {
  /** Validates bodies against the document's own response schemas, with ajv. */
  function openApiValidator(document: any) {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const base = "urn:bun-jobs:test:ui-gaps";
    ajv.addSchema({ $id: base, components: document.components });
    return (
      method: string,
      template: string,
      status: number,
      body: unknown,
    ) => {
      const operation = document.paths[template]?.[method.toLowerCase()];
      expect(operation).toBeDefined();
      const response = operation.responses[String(status)];
      expect({ template, status, declared: response !== undefined }).toEqual({
        template,
        status,
        declared: true,
      });
      const schema = JSON.parse(
        JSON.stringify(response.content["application/json"].schema).replaceAll(
          '"#/components/',
          `"${base}#/components/`,
        ),
      ) as object;
      const validate = ajv.compile(schema);
      return validate(body) ? null : validate.errors;
    };
  }

  it("for every read and write a UI makes", async () => {
    const h = closing({
      addableNames: "any",
      runnerTriggerArgs: true,
      csrf: { header: "x-csrf" },
      websocket: { port: 0 },
    });
    const headers = { "x-csrf": "1" };
    h.jobs.define("send", async () => {});
    const mail = h.jobs.queue("mail");
    const parent = await mail.add("send", { to: "a" });
    await mail.add("send", { to: "b" }, { delay: 60_000 });
    await h.jobs.queue("reports").add("build", {});
    h.jobs.runner({
      id: "nightly",
      file: ECHO_HANDLER,
      executionMode: "in-process",
    });

    const check = openApiValidator(h.api.openapi());
    const calls: [string, string, string, unknown?][] = [
      ["GET", "/meta", "/meta"],
      ["GET", "/meta/permissions?queue=mail", "/meta/permissions"],
      ["GET", "/meta/permissions?channel=queue/mail", "/meta/permissions"],
      ["GET", "/meta/permissions?channel=nope", "/meta/permissions"],
      ["GET", "/overview?minutes=3", "/overview"],
      ["GET", "/queues?search=MA&limit=1", "/queues"],
      ["GET", "/queues/mail", "/queues/{queue}"],
      ["GET", "/queues/mail/counts", "/queues/{queue}/counts"],
      ["GET", "/queues/mail/limits", "/queues/{queue}/limits"],
      [
        "GET",
        "/queues/mail/throughput?minutes=2",
        "/queues/{queue}/throughput",
      ],
      ["GET", "/queues/mail/workers", "/queues/{queue}/workers"],
      ["GET", "/workers", "/workers"],
      [
        "GET",
        "/queues/mail/jobs?include=data,opts&total=true",
        "/queues/{queue}/jobs",
      ],
      ["GET", `/queues/mail/jobs/${parent.id}`, "/queues/{queue}/jobs/{id}"],
      [
        "GET",
        `/queues/mail/jobs/${parent.id}/logs`,
        "/queues/{queue}/jobs/{id}/logs",
      ],
      [
        "GET",
        `/queues/mail/jobs/${parent.id}/children`,
        "/queues/{queue}/jobs/{id}/children",
      ],
      [
        "POST",
        "/queues/mail/jobs/lookup",
        "/queues/{queue}/jobs/lookup",
        { ids: [parent.id, "missing"] },
      ],
      ["GET", "/queues/mail/repeatables", "/queues/{queue}/repeatables"],
      ["GET", "/definitions", "/definitions"],
      [
        "POST",
        "/queues/mail/jobs",
        "/queues/{queue}/jobs",
        { name: "send", data: { to: "c" }, opts: { jobId: "fixed" } },
      ],
      [
        "POST",
        "/queues/mail/jobs",
        "/queues/{queue}/jobs",
        { name: "send", data: { to: "c" }, opts: { jobId: "fixed" } },
      ],
      [
        "POST",
        "/queues/mail/jobs/retry-all",
        "/queues/{queue}/jobs/retry-all",
        { state: "dead" },
      ],
      [
        "POST",
        "/queues/mail/jobs/promote",
        "/queues/{queue}/jobs/promote",
        { ids: ["missing"] },
      ],
      [
        "POST",
        "/queues/mail/clean",
        "/queues/{queue}/clean",
        { state: "completed", olderThan: 0 },
      ],
      ["POST", "/queues/reports/pause", "/queues/{queue}/pause"],
      ["POST", "/queues/reports/resume", "/queues/{queue}/resume"],
      ["GET", "/runners", "/runners"],
      ["GET", "/runners/nightly", "/runners/{runner}"],
      ["GET", "/runners/nightly/stats", "/runners/{runner}/stats"],
      ["GET", "/runners/nightly/history", "/runners/{runner}/history"],
      ["POST", "/runners/nightly/pause", "/runners/{runner}/pause"],
      [
        "POST",
        "/runners/nightly/trigger",
        "/runners/{runner}/trigger",
        { args: { a: 1 } },
      ],
      ["POST", "/runners/nightly/resume", "/runners/{runner}/resume"],
      [
        "PUT",
        "/runners/nightly/schedule",
        "/runners/{runner}/schedule",
        { schedule: 60_000 },
      ],
    ];

    for (const [method, path, template, body] of calls) {
      const res = await h.call(method, path, body, headers);
      expect({ path, status: res.status }).toEqual({
        path,
        status: expect.any(Number),
      });
      expect(res.status).toBeLessThan(300);
      expect({
        method,
        path,
        errors: check(method, template, res.status, res.body),
      }).toEqual({ method, path, errors: null });
    }

    // The control: a body that breaks the document is caught.
    const metaBody = (await h.call("GET", "/meta")).body;
    expect(
      check("GET", "/meta", 200, { ...metaBody, limits: { maxBulkIds: "x" } }),
    ).not.toBeNull();
    expect(
      check("GET", "/meta", 200, { ...metaBody, csrf: undefined }),
    ).not.toBeNull();
  });
});
