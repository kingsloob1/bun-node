import type { JobsApiConfig } from "../../lib/api/config";
import type { JobsApiServerMessage } from "../../lib/api/ws/protocol";
import type {
  SummonEventPayload,
  SummonPolicy,
  SummonRequest,
} from "../../lib/index";
import { join } from "node:path";
import {
  BunHttpAdapter,
  createTestLogger,
  noopLogger,
} from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
  spyOn,
} from "bun:test";
import {
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
  JOBS_API_OPT_IN_ACTIONS,
  QUEUE_EVENT_TYPES,
} from "../../lib/api/contract/constants";
import { createJobsApi } from "../../lib/api/createJobsApi";
import { isServableFact, toEventDto } from "../../lib/api/serialize";
import { reachesJobChannel } from "../../lib/api/spec/asyncapi";
import { QUEUE_EVENTS } from "../../lib/api/ws/events";
import {
  BunJobs,
  BunQueue,
  ConfigError,
  defineSummoner,
} from "../../lib/index";
import { setReservedState } from "../../lib/queue/windows";
import { queueEvent } from "../../lib/shared/events";
import { FIND_SUMMON_CONTROLLER } from "../../lib/summon/controller";
import { SUMMON_MARKER } from "../../lib/summon/marker";
import { makeTmpDir, testNamespace, waitFor } from "../helpers";
import { harness, openHarnesses } from "./fixtures";

/**
 * The summon routes — `GET /queues/{queue}/summon`, "summon now" and reset —
 * over a real `BunJobs` whose `summon` option builds a controller, on SQLite
 * (a driver another process can share, which summoning needs): what they
 * answer, how the API finds a controller (and never builds one), 409
 * `SUMMON_NOT_CONFIGURED`, the `queues.summon` gating, what the status and
 * the `summon` event keep back, and the event on the socket.
 *
 * The controller's own behaviour is `summon-controller.test.ts`'s; these are
 * the API's side. Each case asserts what an input excludes as well as what it
 * keeps, and the key ones carry a negative control.
 */

setDefaultTimeout(30_000);

const tmp = await makeTmpDir("bun-jobs-api-summon");
afterAll(async () => {
  await tmp.cleanup();
});

/** Undo steps, run as each case ends, last first. */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** A platform identifier carrying an AWS account id: what must not leak. */
const ARN = "arn:aws:ecs:eu-west-1:123456789012:task/jobs/0f3a";

/** What the fake summoner does on its next call. */
type Behaviour = "start" | "throw";

/**
 * A context on SQLite with a summon controller for queue `work`, every
 * trigger off so only the API runs checks, and a summoner that records its
 * calls and describes itself with two credential-shaped facts, plus any
 * `facts` given.
 */
function summoning(
  policy: Partial<SummonPolicy> = {},
  facts: Record<string, string> = {},
): {
  jobs: BunJobs;
  calls: SummonRequest[];
  behave: (next: Behaviour) => void;
} {
  const namespace = testNamespace("api-summon");
  const calls: SummonRequest[] = [];
  let behaviour: Behaviour = "start";
  const jobs = new BunJobs({
    namespace,
    driver: { type: "sql", url: `sqlite://${join(tmp.path, "jobs.db")}` },
    logger: noopLogger,
    summon: {
      work: {
        summoner: defineSummoner({
          kind: "fake",
          dedupe: {
            kind: "token",
            maxLength: 64,
            charset: "A-Za-z0-9-",
            scope: "cluster",
            strict: true,
          },
          invoke: async (request) => {
            calls.push(request);
            if (behaviour === "throw") {
              throw new Error("platform refused");
            }
            return { status: "started", handles: [ARN] };
          },
          describe: () => ({
            cluster: "jobs",
            region: "eu-west-1",
            apiToken: "tok-must-not-leak",
            dbPassword: "pw-must-not-leak",
            ...facts,
          }),
        }),
        triggers: { onAdd: false, events: false, poll: false },
        cooldown: 60_000,
        ...policy,
      },
    },
  });
  cleanups.push(async () => {
    await jobs.close();
  });
  return { jobs, calls, behave: (next) => (behaviour = next) };
}

/** Adds `n` jobs to `queue`, so it has demand. */
async function backlog(jobs: BunJobs, n: number, queue = "work") {
  await jobs
    .queue(queue)
    .addBulk(
      Array.from({ length: n }, (_, index) => ({ name: "job", data: index })),
    );
}

describe("GET /queues/{queue}/summon", () => {
  it("answers the shared state and the summoner, secret-free", async () => {
    const { jobs } = summoning();
    const h = harness({ jobs });

    const response = await h.call("GET", "/queues/work/summon");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      queue: "work",
      local: true,
      inert: false,
      summoner: {
        provider: {
          name: "custom:fake",
          version: "0.0.0",
          kind: "fake",
          apiVersion: { core: "0.1", summon: "0.1" },
        },
        // The configured instance's id in this process, for "Test
        // connection", and ready: `defineSummoner` validates synchronously.
        providerId: expect.stringMatching(/^custom:fake@0\.0\.0~\d+$/),
        readiness: "ready",
        capabilities: {
          style: "launch",
          dedupe: {
            kind: "token",
            maxLength: 64,
            charset: "A-Za-z0-9-",
            scope: "cluster",
            strict: true,
          },
          passes: "argv",
          bootBudgetMs: 180_000,
          shutdown: { signal: "SIGTERM", graceMs: 10_000 },
          maxLifetimeMs: null,
          enforcesLifetime: false,
        },
        // `apiToken` and `dbPassword` are gone: keys that look like
        // credentials are dropped whatever `describe()` says.
        facts: { kind: "fake", cluster: "jobs", region: "eu-west-1" },
      },
      pending: [],
      failures: 0,
      budget: {
        hour: 0,
        perHour: 30,
        day: 0,
        perDay: 300,
        hourResetsAt: expect.any(Number),
        dayResetsAt: expect.any(Number),
      },
    });
    // Negative control: the controller itself reports them, so it is the
    // serializer that dropped them.
    const raw = await jobs[FIND_SUMMON_CONTROLLER]("work")!.status();
    expect(raw.summoner!.facts).toMatchObject({
      apiToken: "tok-must-not-leak",
      dbPassword: "pw-must-not-leak",
    });
    expect(response.text).not.toContain("must-not-leak");
    // A read: `queues.read`, about the queue, and never a mutation.
    expect(h.calls.at(-1)).toMatchObject({
      action: "queues.read",
      mutation: false,
      queue: "work",
    });
  });

  it("keeps a pending attempt's platform handles back unless exposeSummonHandles is on", async () => {
    const { jobs } = summoning();
    await backlog(jobs, 1);
    const hidden = harness({ jobs });
    expect((await hidden.call("POST", "/queues/work/summon")).status).toBe(200);

    const status = await hidden.call("GET", "/queues/work/summon");
    expect(status.body.pending).toHaveLength(1);
    expect(status.body.pending[0]).toEqual({
      id: expect.any(String),
      at: expect.any(Number),
      until: expect.any(Number),
      count: 1,
      kind: "fake",
    });
    expect(status.text).not.toContain("123456789012");

    // Negative control: the same state with the switch on shows them.
    const shown = harness({ jobs, serialize: { exposeSummonHandles: true } });
    const exposed = await shown.call("GET", "/queues/work/summon");
    expect(exposed.body.pending[0].handles).toEqual([ARN]);
  });
});

describe("summoner facts", () => {
  it("drops a key that has or ends with a credential word, failing safe, and keeps the rest", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "API_KEY",
      "api-key",
      "accessKeyId",
      "secretArn",
      "clientSecret",
      "password",
      "dbPassword",
      "token",
      "tokens",
      "sessionToken",
      // Joined lower case: one word each, caught by the ending. A whole-word
      // match alone served every one of these.
      "apikey",
      "APIKEY",
      "secretkey",
      "accesskey",
      "authtoken",
      "privatekey",
      "clientsecret",
      "sessiontoken",
      // The wider list.
      "passwd",
      "pwd",
      "credentials",
      "authorization",
      "bearer",
      // A credential word ending another word: dropped, the safe way.
      "monkey",
    ]) {
      expect({ key, served: isServableFact(key, "x", true) }).toEqual({
        key,
        served: false,
      });
    }
    // Negative controls: a credential word at the START of another word is
    // not one. The substring regex this replaced dropped both of the first two.
    for (const key of ["keyspace", "tokenizerModel", "cluster", "authors"]) {
      expect({ key, served: isServableFact(key, "x", true) }).toEqual({
        key,
        served: true,
      });
    }
  });

  it("drops a value holding a URL with userinfo, whatever its key", () => {
    expect(isServableFact("connectionUrl", "postgres://u:p@h/db", true)).toBe(
      false,
    );
    expect(isServableFact("endpoint", "https://tok@api.example", true)).toBe(
      false,
    );
    // Negative control: the same URL without userinfo is served.
    expect(isServableFact("connectionUrl", "postgres://h/db", true)).toBe(true);
    expect(isServableFact("contact", "ops@example.com", true)).toBe(true);
  });

  it("serves a host or hostname fact only with exposeHosts", () => {
    expect(isServableFact("host", "10.1.2.3", false)).toBe(false);
    expect(isServableFact("Hostname", "db-1", false)).toBe(false);
    expect(isServableFact("host", "10.1.2.3", true)).toBe(true);
    // Negative control: another key with the same value is not a host fact.
    expect(isServableFact("region", "10.1.2.3", false)).toBe(true);
  });

  it("applies all three on the status route", async () => {
    const { jobs } = summoning(
      {},
      {
        connectionUrl: "postgres://u:p@h/db",
        dashboard: "https://console.example/cluster/jobs",
        host: "10.1.2.3",
        keyspace: "jobs",
      },
    );
    const shown = harness({ jobs });
    const hidden = harness({ jobs, serialize: { exposeHosts: false } });
    const shownBody = (await shown.call("GET", "/queues/work/summon")).body;
    const hiddenBody = (await hidden.call("GET", "/queues/work/summon")).body;
    const withHosts = shownBody.summoner.facts;
    const withoutHosts = hiddenBody.summoner.facts;
    const kept = {
      kind: "fake",
      cluster: "jobs",
      region: "eu-west-1",
      dashboard: "https://console.example/cluster/jobs",
      keyspace: "jobs",
    };
    expect(withHosts).toEqual({ ...kept, host: "10.1.2.3" });
    expect(withoutHosts).toEqual(kept);
    // Negative control: the controller reports every one of them.
    const raw = await jobs[FIND_SUMMON_CONTROLLER]("work")!.status();
    expect(raw.summoner!.facts).toMatchObject({
      connectionUrl: "postgres://u:p@h/db",
      host: "10.1.2.3",
    });
  });
});

describe("POST /queues/{queue}/summon", () => {
  it("summons now, as a manual check, and answers what it did with the demand", async () => {
    const { jobs, calls } = summoning();
    await backlog(jobs, 2);
    const h = harness({ jobs });

    const response = await h.call("POST", "/queues/work/summon");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      action: "summoned",
      id: expect.stringMatching(/.+/),
      outcome: "started",
      demand: expect.objectContaining({
        queue: "work",
        waiting: 2,
        demand: 2,
        exact: true,
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.reason).toBe("manual");
    expect(calls[0]!.id).toBe(response.body.id);
    expect(h.calls.at(-1)).toMatchObject({
      action: "queues.summon",
      mutation: true,
      queue: "work",
    });

    // The attempt now counts as a worker on its way: a second press summons
    // nothing, and says why.
    const again = await h.call("POST", "/queues/work/summon", {});
    expect(again.body).toMatchObject({ action: "skipped", reason: "pending" });
    expect(calls).toHaveLength(1);
  });

  it("answers none, with the reading, when nothing needs a worker", async () => {
    const { jobs, calls } = summoning();
    const h = harness({ jobs });
    const response = await h.call("POST", "/queues/work/summon");
    expect(response.body).toEqual({
      action: "none",
      demand: expect.objectContaining({ queue: "work", demand: 0 }),
    });
    expect(calls).toHaveLength(0);
  });

  it("forces past the cooldown only, by default; force: false keeps it, and reset clears failures, backoff and the circuit", async () => {
    const { jobs, calls, behave } = summoning({ circuit: { failures: 1 } });
    await backlog(jobs, 1);
    const h = harness({ jobs });
    const check = spyOn(jobs[FIND_SUMMON_CONTROLLER]("work")!, "check");

    // A failed attempt: one failure, a backoff, and (at one failure) an
    // open circuit.
    behave("throw");
    expect((await h.call("POST", "/queues/work/summon")).body).toMatchObject({
      action: "summoned",
      outcome: "failed",
    });
    expect(check).toHaveBeenLastCalledWith({ reason: "manual", force: true });
    const failed = (await h.call("GET", "/queues/work/summon")).body;
    expect(failed).toMatchObject({
      failures: 1,
      backoffUntil: expect.any(Number),
      circuitOpenUntil: expect.any(Number),
      last: { outcome: "failed", detail: expect.any(String) },
    });

    // `force` never skips the circuit.
    behave("start");
    expect((await h.call("POST", "/queues/work/summon")).body).toMatchObject({
      action: "skipped",
      reason: "circuit-open",
    });
    expect(calls).toHaveLength(1);

    // Reset: a mutation of its own, answering the status after it.
    const reset = await h.call("POST", "/queues/work/summon/reset");
    expect(reset.status).toBe(200);
    expect(h.calls.at(-1)).toMatchObject({
      action: "queues.summon",
      mutation: true,
      queue: "work",
    });
    expect(reset.body.failures).toBe(0);
    expect(reset.body).not.toHaveProperty("backoffUntil");
    expect(reset.body).not.toHaveProperty("circuitOpenUntil");
    // The attempt history is kept: reset clears guards, not the record.
    expect(reset.body.last).toMatchObject({ outcome: "failed" });

    // Now only the cooldown is left, and `force: false` keeps it...
    const kept = await h.call("POST", "/queues/work/summon", { force: false });
    expect(kept.body).toMatchObject({ action: "skipped", reason: "cooldown" });
    expect(check).toHaveBeenLastCalledWith({ reason: "manual", force: false });
    expect(calls).toHaveLength(1);
    // ...while the default skips it.
    const forced = await h.call("POST", "/queues/work/summon");
    expect(forced.body).toMatchObject({
      action: "summoned",
      outcome: "started",
    });
    expect(calls).toHaveLength(2);
  });

  it("needs Content-Type: application/json even with no body, as every mutation does", async () => {
    const { jobs, calls } = summoning();
    await backlog(jobs, 1);
    const h = harness({ jobs });
    for (const path of ["/queues/work/summon", "/queues/work/summon/reset"]) {
      const bare = await h.root.fetch(`/admin/jobs${path}`, { method: "POST" });
      expect({ path, status: bare.status }).toEqual({ path, status: 415 });
      expect(((await bare.json()) as { code: string }).code).toBe(
        "UNSUPPORTED_MEDIA_TYPE",
      );
    }
    expect(calls).toHaveLength(0);
    // Negative control: the same bodyless POST with the header is served.
    expect((await h.call("POST", "/queues/work/summon")).status).toBe(200);
  });

  it("refuses a body that is not the schema's", async () => {
    const { jobs, calls } = summoning();
    const h = harness({ jobs });
    const response = await h.call("POST", "/queues/work/summon", {
      force: "yes",
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION");
    expect(calls).toHaveLength(0);
  });
});

describe("finding the controller", () => {
  it("answers 409 SUMMON_NOT_CONFIGURED on every route for a queue with no controller here", async () => {
    const { jobs } = summoning();
    await backlog(jobs, 1, "plain");
    const h = harness({ jobs });
    for (const [method, path] of [
      ["GET", "/queues/plain/summon"],
      ["POST", "/queues/plain/summon"],
      ["POST", "/queues/plain/summon/reset"],
    ] as const) {
      const response = await h.call(method, path);
      expect({ method, path, status: response.status }).toEqual({
        method,
        path,
        status: 409,
      });
      expect(response.body).toMatchObject({
        code: "SUMMON_NOT_CONFIGURED",
        status: 409,
      });
    }
    // Negative control: the queue with a controller answers.
    expect((await h.call("GET", "/queues/work/summon")).status).toBe(200);
  });

  it("finds a queue with a controller before its first job, and 404s an unknown one", async () => {
    const { jobs } = summoning();
    const h = harness({ jobs });
    // `work` has no job, so the backend does not list it yet.
    expect(await jobs.listQueues()).not.toContain("work");
    expect((await h.call("GET", "/queues/work/summon")).status).toBe(200);
    // Negative control: a name with neither jobs nor a controller.
    const unknown = await h.call("GET", "/queues/nowhere/summon");
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("QUEUE_NOT_FOUND");
    // And a configured list still restricts, controller or not.
    const listed = harness({ jobs, queues: [jobs.queue("other")] });
    expect((await listed.call("GET", "/queues/work/summon")).status).toBe(404);
  });

  it("never builds a controller: it looks one up, and never calls summonController()", async () => {
    const { jobs } = summoning();
    await backlog(jobs, 1, "plain");
    const build = spyOn(jobs, "summonController");
    const h = harness({ jobs });
    expect((await h.call("GET", "/queues/work/summon")).status).toBe(200);
    expect((await h.call("POST", "/queues/work/summon")).status).toBe(200);
    expect((await h.call("POST", "/queues/work/summon/reset")).status).toBe(
      200,
    );
    expect((await h.call("GET", "/queues/plain/summon")).status).toBe(409);
    expect(build).not.toHaveBeenCalled();
    // The lookup answers only what exists: nothing for `plain`, and nothing
    // once the context is closed — where `summonController()` would build one
    // from the `summon` option (the negative control).
    expect(jobs[FIND_SUMMON_CONTROLLER]("plain")).toBeUndefined();
    build.mockRestore();
    await jobs.close();
    expect(jobs[FIND_SUMMON_CONTROLLER]("work")).toBeUndefined();
    const built = jobs.summonController("work");
    expect(jobs[FIND_SUMMON_CONTROLLER]("work")).toBe(built);
    await built.close();
  });

  it("documents 409 SUMMON_NOT_CONFIGURED and 503 DRIVER_ERROR, and answers the 503 once the context is closed", async () => {
    const { jobs } = summoning();
    const h = harness({ jobs });
    const spec = (await h.call("GET", "/openapi.json")).body;
    const operations: Record<string, Record<string, unknown>> = {};
    for (const methods of Object.values(spec.paths) as Record<
      string,
      { operationId?: string; responses: Record<string, unknown> }
    >[]) {
      for (const operation of Object.values(methods)) {
        if (operation.operationId !== undefined) {
          operations[operation.operationId] = operation.responses;
        }
      }
    }
    for (const id of ["getQueueSummon", "summonQueue", "resetQueueSummon"]) {
      const responses = operations[id]!;
      expect({ id, codes: responses["409"] }).toMatchObject({
        id,
        codes: {
          "x-bun-jobs-codes": expect.arrayContaining(["SUMMON_NOT_CONFIGURED"]),
        },
      });
      expect({ id, codes: responses["503"] }).toMatchObject({
        id,
        codes: { "x-bun-jobs-codes": ["DRIVER_ERROR"] },
      });
    }
    expect(
      (operations.resetQueueSummon!["409"] as { "x-bun-jobs-codes": string[] })[
        "x-bun-jobs-codes"
      ],
    ).toEqual(["SUMMON_MARKER_CONTENDED", "SUMMON_NOT_CONFIGURED"]);

    // And the 503 is real: closing the context closes its driver.
    await jobs.close();
    const closed = await h.call("GET", "/queues/work/summon");
    expect(closed.status).toBe(503);
    expect(closed.body.code).toBe("DRIVER_ERROR");
  });

  it("answers 409 on an API built without jobs", async () => {
    const { jobs } = summoning();
    const h = harness({ jobs: undefined, queues: [jobs.queue("work")] });
    const response = await h.call("GET", "/queues/work/summon");
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("SUMMON_NOT_CONFIGURED");
  });
});

describe("the queues.summon action", () => {
  it("is a mutation, opt-in, and the only action the two writes ask", () => {
    expect(JOBS_API_ACTIONS).toContain("queues.summon");
    expect(JOBS_API_MUTATIONS.has("queues.summon")).toBe(true);
    expect(JOBS_API_OPT_IN_ACTIONS.has("queues.summon")).toBe(true);
  });

  it("is off by default: the status is served, the two writes are not", async () => {
    const { jobs, calls } = summoning();
    await backlog(jobs, 1);
    const h = harness({ jobs, actions: undefined });
    expect((await h.call("GET", "/queues/work/summon")).status).toBe(200);
    for (const path of ["/queues/work/summon", "/queues/work/summon/reset"]) {
      const response = await h.call("POST", path);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("ROUTE_NOT_FOUND");
    }
    expect(calls).toHaveLength(0);
    const operations = h.api.routes.map((route) => route.operationId);
    expect(operations).toContain("getQueueSummon");
    expect(operations).not.toContain("summonQueue");
    expect(operations).not.toContain("resetQueueSummon");
  });

  it("is removed by readOnly, even when actions names it", async () => {
    const { jobs, calls } = summoning();
    await backlog(jobs, 1);
    const h = harness({ jobs, readOnly: true });
    expect((await h.call("GET", "/queues/work/summon")).status).toBe(200);
    expect((await h.call("POST", "/queues/work/summon")).status).toBe(404);
    expect((await h.call("POST", "/queues/work/summon/reset")).status).toBe(
      404,
    );
    expect(calls).toHaveLength(0);
  });

  it("works once opted in, and a refusing authorize summons nothing", async () => {
    const { jobs, calls } = summoning();
    await backlog(jobs, 1);
    const actions = JOBS_API_ACTIONS.filter(
      (action) =>
        !JOBS_API_OPT_IN_ACTIONS.has(action) || action === "queues.summon",
    );
    const refused = harness({
      jobs,
      actions,
      authorize: (_req, context) => context.action !== "queues.summon",
    });
    const denied = await refused.call("POST", "/queues/work/summon");
    expect(denied.status).toBe(403);
    expect(calls).toHaveLength(0);

    const allowed = harness({ jobs, actions });
    const response = await allowed.call("POST", "/queues/work/summon");
    expect(response.status).toBe(200);
    expect(response.body.action).toBe("summoned");
    expect(calls).toHaveLength(1);
  });

  it("is served in jobs mode and pruned in runner mode", async () => {
    const { jobs } = summoning();
    const both = harness({ jobs });
    expect((await both.call("GET", "/queues/work/summon")).status).toBe(200);
    const runner = harness({ jobs, mode: "runner" });
    const pruned = await runner.call("GET", "/queues/work/summon");
    expect(pruned.status).toBe(404);
    expect(pruned.body.code).toBe("ROUTE_NOT_FOUND");
  });
});

describe("the summon event", () => {
  it("is a queue event that never reaches a job channel, with no envelope id", () => {
    expect(QUEUE_EVENT_TYPES).toContain("summon");
    const descriptor = QUEUE_EVENTS.find((event) => event.type === "summon")!;
    expect(reachesJobChannel(descriptor)).toBe(false);
    // Negative control: a job event with the same `id` field does.
    const added = QUEUE_EVENTS.find((event) => event.type === "added")!;
    expect(reachesJobChannel(added)).toBe(true);

    const event = queueEvent(
      { ns: "n", target: "work", type: "summon", origin: "o" },
      { id: "s-1", outcome: "started", kind: "fake" },
    );
    expect(event).not.toHaveProperty("id");
    expect(
      queueEvent(
        { ns: "n", target: "work", type: "added", origin: "o" },
        { id: "j-1" },
      ).id,
    ).toBe("j-1");
  });

  it("keeps handles off the wire unless exposeSummonHandles is on", () => {
    const event = queueEvent(
      { ns: "n", target: "work", type: "summon", origin: "o" },
      {
        id: "s-1",
        outcome: "started",
        kind: "fake",
        count: 1,
        handles: [ARN],
        reason: "manual",
      },
    );
    const base = {
      exposeStacks: false,
      exposeRunnerFiles: false,
      exposeProcessorFiles: false,
      exposeHosts: true,
    };
    const hidden = toEventDto(event, undefined as never, {
      ...base,
      exposeSummonHandles: false,
    });
    expect(hidden!.payload).toEqual({
      id: "s-1",
      outcome: "started",
      kind: "fake",
      count: 1,
      reason: "manual",
    });
    const shown = toEventDto(event, undefined as never, {
      ...base,
      exposeSummonHandles: true,
    });
    expect((shown!.payload as { handles?: string[] }).handles).toEqual([ARN]);
  });

  it("is published for every outcome, budget-exhausted included, whatever publishEvents says", async () => {
    const { jobs, behave } = summoning({
      budget: { perHour: 1 },
      backoff: { initial: 1, max: 1 },
    });
    await backlog(jobs, 1);
    // Another queue object on the same backend, as another process would
    // hold: it hears only what crossed the driver.
    const listener = new BunQueue("work", {
      namespace: jobs.namespace,
      driver: jobs.driver,
      logger: noopLogger,
      subscribe: true,
    });
    cleanups.push(async () => await listener.close());
    const heard: SummonEventPayload[] = [];
    listener.on("summon", (event) => heard.push(event));
    await listener.connect();
    const h = harness({ jobs });

    // The hour's one attempt fails; the next check finds the budget spent.
    behave("throw");
    await h.call("POST", "/queues/work/summon");
    await Bun.sleep(5);
    expect((await h.call("POST", "/queues/work/summon")).body).toMatchObject({
      action: "skipped",
      reason: "budget",
    });
    await waitFor(() => heard.length >= 2, {
      timeout: 10_000,
      message: () => `heard ${JSON.stringify(heard)}`,
    });
    expect(heard.map((event) => event.outcome)).toEqual([
      "failed",
      "budget-exhausted",
    ]);
    expect(heard[1]).toEqual({
      id: "",
      outcome: "budget-exhausted",
      kind: "fake",
    });
  });

  it("reaches the socket's queue channel when the API summons, and not the job channel", async () => {
    const { jobs } = summoning();
    await backlog(jobs, 1);
    const { logger } = createTestLogger();
    const config: JobsApiConfig = {
      jobs,
      basePath: "/admin/jobs",
      authorize: () => true,
      logger,
      actions: [...JOBS_API_ACTIONS],
    };
    const api = createJobsApi(config);
    const adapter = new BunHttpAdapter(0, { logger: noopLogger });
    adapter.use(api.basePath, api.router);
    api.websocket!.attach(adapter);
    const server = await adapter.listen(0);
    cleanups.push(async () => {
      await api.close();
      await adapter.close();
    });

    const frames: JobsApiServerMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/admin/jobs/ws`);
    ws.onmessage = (message) =>
      frames.push(JSON.parse(String(message.data)) as JobsApiServerMessage);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the upgrade was refused"));
    });
    cleanups.push(async () => ws.close());
    ws.send(
      JSON.stringify({
        op: "subscribe",
        id: "1",
        channels: ["queue/work", "queue/work/job/anything"],
      }),
    );
    await waitFor(() => frames.some((frame) => frame.type === "ack"), {
      timeout: 5000,
    });

    const summoned = await fetch(
      `http://127.0.0.1:${server.port}/admin/jobs/queues/work/summon`,
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    const body = (await summoned.json()) as { id: string };
    expect(summoned.status).toBe(200);

    const summonEvents = () =>
      frames.filter(
        (frame) => frame.type === "event" && frame.event.type === "summon",
      );
    await waitFor(() => summonEvents().length > 0, {
      timeout: 10_000,
      message: () => `no summon event; frames: ${JSON.stringify(frames)}`,
    });
    const [frame] = summonEvents();
    if (frame?.type !== "event") {
      throw new Error("unreachable");
    }
    expect(frame.event).toEqual({
      v: 1,
      kind: "queue",
      type: "summon",
      target: "work",
      at: expect.any(Number),
      payload: {
        id: body.id,
        outcome: "started",
        kind: "fake",
        count: 1,
        reason: "manual",
      },
    });
    // Once, on the queue channel alone: never on a job channel.
    expect(frame.subscriptions).toEqual(["queue/work"]);
    expect(JSON.stringify(frames)).not.toContain("123456789012");
  });
});

describe("the summon option", () => {
  it("refuses a policy on a driver that cannot summon, so the API never sees one", () => {
    expect(
      () =>
        new BunJobs({
          namespace: "n",
          logger: noopLogger,
          summon: { work: { summoner: async () => {} } },
        }),
    ).toThrow(ConfigError);
  });
});

describe("the summon budget on the wire", () => {
  it("says off, with no limits, for a policy that turns the budget off, and when each window resets", async () => {
    const { jobs } = summoning({ budget: false });
    const h = harness({ jobs });
    const before = Date.now();
    const response = await h.call("GET", "/queues/work/summon");
    expect(response.status).toBe(200);
    expect(response.body.budget).toEqual({
      hour: 0,
      day: 0,
      off: true,
      hourResetsAt: expect.any(Number),
      dayResetsAt: expect.any(Number),
    });
    expect(response.body.budget.hourResetsAt % 3_600_000).toBe(0);
    expect(response.body.budget.dayResetsAt % 86_400_000).toBe(0);
    expect(response.body.budget.hourResetsAt).toBeGreaterThan(before);
    // Control: the defaults have limits and no `off`.
    const { jobs: limited } = summoning();
    const on = (
      await harness({ jobs: limited }).call("GET", "/queues/work/summon")
    ).body.budget;
    expect(on).toMatchObject({ perHour: 30, perDay: 300 });
    expect(on).not.toHaveProperty("off");
  });
});

describe("POST /queues/{queue}/summon/reset with a body", () => {
  it("clears the budget usage only when asked to", async () => {
    const { jobs, calls } = summoning({ cooldown: 0 });
    await backlog(jobs, 1);
    const h = harness({ jobs });
    expect((await h.call("POST", "/queues/work/summon")).body).toMatchObject({
      outcome: "started",
    });
    expect(calls).toHaveLength(1);

    const plain = await h.call("POST", "/queues/work/summon/reset");
    expect(plain.status).toBe(200);
    expect(plain.body.budget).toMatchObject({ hour: 1, day: 1 });
    const no = await h.call("POST", "/queues/work/summon/reset", {
      budget: false,
    });
    expect(no.body.budget).toMatchObject({ hour: 1, day: 1 });

    const cleared = await h.call("POST", "/queues/work/summon/reset", {
      budget: true,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.budget).toMatchObject({ hour: 0, day: 0 });
    // The attempt in flight is kept, as a plain reset keeps it.
    expect(cleared.body.pending).toHaveLength(1);
    expect(h.calls.at(-1)).toMatchObject({
      action: "queues.summon",
      mutation: true,
      queue: "work",
    });
  });

  it("refuses a body that is not the schema's, and changes nothing", async () => {
    const { jobs } = summoning({ cooldown: 0 });
    await backlog(jobs, 1);
    const h = harness({ jobs });
    await h.call("POST", "/queues/work/summon");
    for (const body of [{ budget: "yes" }, { budget: 1 }, { extra: true }]) {
      const response = await h.call("POST", "/queues/work/summon/reset", body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
      expect(response.body.code).toBe("VALIDATION");
    }
    expect(
      (await h.call("GET", "/queues/work/summon")).body.budget,
    ).toMatchObject({ hour: 1 });
  });

  it("is advertised by /meta.features.summonResetBudget, which runner mode turns off", async () => {
    const { jobs } = summoning();
    const served = await harness({ jobs }).call("GET", "/meta");
    expect(served.body.features.summonResetBudget).toBe(true);
    const runner = await harness({ jobs, mode: "runner" }).call("GET", "/meta");
    expect(runner.body.features.summonResetBudget).toBe(false);
  });

  it("documents the body in the OpenAPI document", async () => {
    const { jobs } = summoning();
    const spec = (await harness({ jobs }).call("GET", "/openapi.json")).body;
    const reset = spec.paths["/queues/{queue}/summon/reset"].post;
    const schema = reset.requestBody.content["application/json"].schema;
    expect(schema.properties.budget).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(reset.requestBody.required).toBeFalsy();
  });
});

describe("GET /summon", () => {
  /** A context with controllers on `work` (from the option) and `other`. */
  function two(policy: Partial<SummonPolicy> = {}) {
    const made = summoning(policy);
    made.jobs.summonController("other", {
      summoner: defineSummoner({
        kind: "second",
        invoke: async () => ({ status: "unavailable", reason: "no capacity" }),
      }),
      triggers: { onAdd: false, events: false, poll: false },
      budget: false,
    });
    return made;
  }

  it("lists every controller in the API's process, by queue, with its budget usage", async () => {
    const { jobs } = two({ cooldown: 0 });
    await backlog(jobs, 1);
    await backlog(jobs, 1, "other");
    const h = harness({ jobs });
    await h.call("POST", "/queues/work/summon");
    await h.call("POST", "/queues/other/summon");

    const response = await h.call("GET", "/summon");
    expect(response.status).toBe(200);
    expect(
      h.calls.filter((ctx) => ctx.action === "queues.list").length,
    ).toBeGreaterThan(0);
    expect(response.body).toEqual({
      controllers: [
        {
          namespace: jobs.namespace,
          queue: "other",
          kind: "second",
          readiness: "ready",
          inert: false,
          last: {
            id: expect.any(String),
            outcome: "unavailable",
            at: expect.any(Number),
            detail: "no capacity",
          },
          budget: {
            hour: 1,
            day: 1,
            off: true,
            hourResetsAt: expect.any(Number),
            dayResetsAt: expect.any(Number),
          },
        },
        {
          namespace: jobs.namespace,
          queue: "work",
          kind: "fake",
          readiness: "ready",
          inert: false,
          last: {
            id: expect.any(String),
            outcome: "started",
            at: expect.any(Number),
          },
          budget: {
            hour: 1,
            perHour: 30,
            day: 1,
            perDay: 300,
            hourResetsAt: expect.any(Number),
            dayResetsAt: expect.any(Number),
          },
        },
      ],
    });
    // The per-queue status agrees with the list's entry.
    const work = (await h.call("GET", "/queues/work/summon")).body;
    expect(response.body.controllers[1].budget).toEqual(work.budget);
    expect(response.body.controllers[1].last).toEqual(work.last);
  });

  it("says a controller is inert, and why, as the per-queue status does", async () => {
    const { jobs } = summoning();
    // A summon state written by a newer bun-jobs: the controller leaves it
    // alone and goes inert.
    const ref = { ns: jobs.namespace, queue: "work" };
    await jobs.queue("work").add("x", {});
    expect(
      await setReservedState(jobs.driver, ref, SUMMON_MARKER, { v: 99 }, null),
    ).not.toBeNull();
    const h = harness({ jobs });
    const item = (await h.call("GET", "/summon")).body.controllers[0];
    expect(item).toMatchObject({
      queue: "work",
      readiness: "ready",
      inert: true,
      inertReason: "newer-marker",
    });
    const status = (await h.call("GET", "/queues/work/summon")).body;
    expect([item.inert, item.inertReason]).toEqual([
      status.inert,
      status.inertReason,
    ]);
  });

  it("answers an empty list, not 409, when no controller runs here", async () => {
    const h = harness();
    const response = await h.call("GET", "/summon");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ controllers: [] });
    // An API built without `jobs` has no controllers to list.
    const { jobs } = summoning();
    const without = await harness({
      jobs: undefined,
      queues: [jobs.queue("work")],
    }).call("GET", "/summon");
    expect(without.status).toBe(200);
    expect(without.body).toEqual({ controllers: [] });
  });

  it("hides what the allowlist hides", async () => {
    const { jobs } = two();
    const queues = (response: { body: { controllers: { queue: string }[] } }) =>
      response.body.controllers.map((one) => one.queue);

    // Control: both.
    expect(queues(await harness({ jobs }).call("GET", "/summon"))).toEqual([
      "other",
      "work",
    ]);
    expect(
      queues(
        await harness({ jobs, queues: [jobs.queue("work")] }).call(
          "GET",
          "/summon",
        ),
      ),
    ).toEqual(["work"]);
  });

  for (const listQueues of ["all", "authorized"] as const) {
    it(`is never looser than GET /queues/{queue}/summon, under an allow-list or a deny-list (listQueues: ${listQueues})`, async () => {
      const { jobs } = two();
      const queues = (response: {
        body: { controllers: { queue: string }[] };
      }) => response.body.controllers.map((one) => one.queue);

      // An allow-list policy: queues.read only on `work`.
      const seen: {
        action: string;
        queue?: string;
        route?: { method: string; path: string };
      }[] = [];
      const allowList = harness({
        jobs,
        listQueues,
        authorize: (_req, ctx) => {
          seen.push(ctx);
          return ctx.action !== "queues.read" || ctx.queue === "work";
        },
      });
      expect((await allowList.call("GET", "/queues/work/summon")).status).toBe(
        200,
      );
      expect((await allowList.call("GET", "/queues/other/summon")).status).toBe(
        403,
      );
      seen.length = 0;
      const allowed = await allowList.call("GET", "/summon");
      expect(allowed.status).toBe(200);
      expect(queues(allowed)).toEqual(["work"]);
      // The route itself asked `queues.list`, then `queues.read` per
      // controller exactly as the per-queue route asks it.
      const asked = seen;
      expect(asked).toHaveLength(3);
      expect(asked[0]).toMatchObject({ action: "queues.list" });
      expect(asked[0]).not.toHaveProperty("queue");
      expect(
        asked
          .slice(1)
          .map((ctx) => ({
            action: ctx.action,
            queue: ctx.queue,
            route: ctx.route,
          }))
          .sort((a, b) => String(a.queue).localeCompare(String(b.queue))),
      ).toEqual([
        {
          action: "queues.read",
          queue: "other",
          route: { method: "GET", path: "/queues/:queue/summon" },
        },
        {
          action: "queues.read",
          queue: "work",
          route: { method: "GET", path: "/queues/:queue/summon" },
        },
      ]);

      // A deny-list policy: queues.read refused on `other` alone.
      const denyList = harness({
        jobs,
        listQueues,
        authorize: (_req, ctx) =>
          !(ctx.action === "queues.read" && ctx.queue === "other"),
      });
      expect((await denyList.call("GET", "/queues/other/summon")).status).toBe(
        403,
      );
      const denied = await denyList.call("GET", "/summon");
      expect(denied.status).toBe(200);
      expect(queues(denied)).toEqual(["work"]);
      expect(denied.text).not.toContain("no capacity");
    });
  }

  it("is advertised by /meta.features.summonList, which runner mode turns off", async () => {
    const { jobs } = two();
    const served = await harness({ jobs }).call("GET", "/meta");
    expect(served.body.features.summonList).toBe(true);
    const runner = await harness({ jobs, mode: "runner" }).call("GET", "/meta");
    expect(runner.body.features.summonList).toBe(false);
    // The flag follows the route: pruned, it says so.
    expect(
      (await harness({ jobs, mode: "runner" }).call("GET", "/summon")).status,
    ).toBe(404);
  });

  it("is refused without queues.list, empty without queues.read, pruned in runner mode, and in the OpenAPI document", async () => {
    const { jobs } = two();
    const denied = harness({
      jobs,
      authorize: (_req, ctx) => ctx.action !== "queues.list",
    });
    expect((await denied.call("GET", "/summon")).status).toBe(403);
    const unread = harness({
      jobs,
      authorize: (_req, ctx) => ctx.action !== "queues.read",
    });
    const empty = await unread.call("GET", "/summon");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ controllers: [] });
    const runner = await harness({ jobs, mode: "runner" }).call(
      "GET",
      "/summon",
    );
    expect(runner.status).toBe(404);
    const spec = (await harness({ jobs }).call("GET", "/openapi.json")).body;
    expect(spec.paths["/summon"].get.operationId).toBe("listSummonControllers");
  });
});
