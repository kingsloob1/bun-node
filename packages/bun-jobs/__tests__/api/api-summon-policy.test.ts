import type {
  JobsApiAuthorize,
  JobsApiAuthorizeContext,
} from "../../lib/api/config";
import type { SummonOption, SummonPolicy } from "../../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { SummonStatusSchema } from "../../lib/api/schemas/queues";
import { toSummonPolicyDto } from "../../lib/api/serialize";
import { BunJobs, defineSummoner } from "../../lib/index";
import { makeTmpDir, testNamespace } from "../helpers";
import { harness, openHarnesses } from "./fixtures";

/**
 * `policy` on the management API's summon status ("policy visible", the
 * user's decisions of 2026-10-12): served on `GET /queues/{queue}/summon`
 * and the reset's answer for a controller in the API's process, absent read
 * from storage (`local: false`) and from `GET /summon` items; `jobsPerWorker`
 * `null` for `Infinity`; `env` by name only, whatever `serialize` exposes; a
 * shared unit's `perQueue` redacted like its `queues`; advertised by
 * `/meta.features.summonPolicy`. Responses are validated against their
 * schemas (`validateResponses`), and the status explicitly against
 * `SummonStatusSchema`.
 */

setDefaultTimeout(30_000);

const tmp = await makeTmpDir("bun-jobs-api-summon-policy");
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

/** Every trigger off: only the test runs checks. */
const QUIET: Partial<SummonPolicy> = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
};

const summoner = defineSummoner({
  kind: "fake",
  invoke: async () => ({ status: "started", handles: ["arn:aws:ecs:1"] }),
  describe: () => ({ host: "build-7.internal" }),
});

const MEDIA = ["renders", "thumbs", "previews"];

/** A context on one SQLite file with `summon`, in `namespace`, closed after the test. */
function context(
  summon: SummonOption | undefined,
  namespace = testNamespace("api-summon-policy"),
): BunJobs {
  const jobs = new BunJobs({
    namespace,
    driver: { type: "sql", url: `sqlite://${join(tmp.path, "jobs.db")}` },
    logger: noopLogger,
    ...(summon === undefined ? {} : { summon }),
  });
  cleanups.push(async () => {
    await jobs.purge().catch(() => undefined);
    await jobs.close();
  });
  return jobs;
}

/** An `authorize` refusing `queues.read` on the queues in `denied`. */
function denying(denied: readonly string[]): JobsApiAuthorize {
  return (_req: unknown, context: JobsApiAuthorizeContext) =>
    !(
      context.action === "queues.read" &&
      context.queue !== undefined &&
      denied.includes(context.queue)
    );
}

/** Whether `body` is a valid `SummonStatusDto`, by the route's own schema. */
async function validates(body: unknown): Promise<boolean> {
  const result = await SummonStatusSchema["~standard"].validate(body);
  return result.issues === undefined;
}

describe("GET /queues/{queue}/summon: policy", () => {
  it("serves the local controller's policy, with jobsPerWorker null for Infinity", async () => {
    const jobs = context({ work: { summoner, ...QUIET } });
    const h = harness({ jobs });
    const response = await h.call("GET", "/queues/work/summon");
    expect(response.status).toBe(200);
    expect(response.body.local).toBe(true);
    expect(response.body.policy).toEqual({
      triggers: [
        { kind: "onAdd", on: false, debounce: 250 },
        { kind: "events", on: false, debounce: 250 },
        { kind: "poll", on: false },
      ],
      bootBudget: 180_000,
      maxWorkers: 1,
      jobsPerWorker: null,
      maxPending: 1,
      cooldown: 0,
      backoff: { initial: 30_000, max: 900_000 },
      circuit: { failures: 5, resetAfter: 900_000 },
      maxLifetime: 3_600_000,
      servedBy: "any-worker",
      scaleDown: { after: 300_000 },
      summonTimeout: 30_000,
      env: [],
      fromSummoned: false,
      onSummonFailed: false,
      explicit: [
        "triggers.onAdd",
        "triggers.events",
        "triggers.poll",
        "cooldown",
      ],
    });
    // Negative: never absent, never a string (`JSON.stringify(Infinity)` is
    // `null` only because the serializer says so on purpose).
    expect(response.text).toContain('"jobsPerWorker":null');
    expect(await validates(response.body)).toBe(true);
  });

  it("serializes Infinity as null itself, never relying on JSON.stringify", async () => {
    const jobs = context({ work: { summoner, ...QUIET } });
    const policy = (await jobs.summonController("work").status()).policy!;
    expect(policy.jobsPerWorker).toBe(Infinity);
    // The DTO itself holds `null`: a server that validates its responses,
    // or a socket that does not go through JSON, sees what the type says.
    expect(toSummonPolicyDto(policy).jobsPerWorker).toBeNull();
    expect(
      toSummonPolicyDto({ ...policy, jobsPerWorker: 7 }).jobsPerWorker,
    ).toBe(7);
  });

  it("serves a finite jobsPerWorker as the number", async () => {
    const jobs = context({ work: { summoner, ...QUIET, jobsPerWorker: 2.5 } });
    const body = (await harness({ jobs }).call("GET", "/queues/work/summon"))
      .body;
    expect(body.policy.jobsPerWorker).toBe(2.5);
    expect(body.policy.explicit).toContain("jobsPerWorker");
  });

  it("validates against SummonStatusSchema, which refuses a policy with jobsPerWorker as a string", async () => {
    const jobs = context({ work: { summoner, ...QUIET } });
    const body = (await harness({ jobs }).call("GET", "/queues/work/summon"))
      .body;
    expect(await validates(body)).toBe(true);
    // Negative control: what a naive serializer would send for Infinity.
    expect(
      await validates({
        ...body,
        policy: { ...body.policy, jobsPerWorker: "Infinity" },
      }),
    ).toBe(false);
    // And one with no `explicit` is refused too.
    const { explicit: _explicit, ...withoutExplicit } = body.policy;
    expect(await validates({ ...body, policy: withoutExplicit })).toBe(false);
  });

  it("has no policy key on a status read from storage (local: false), and one for the same queue served locally", async () => {
    const namespace = testNamespace("api-summon-policy-stored");
    const writer = context({ work: { summoner, ...QUIET } }, namespace);
    await writer.queue("work").add("a", {});
    expect(await writer.summonController("work").check()).toMatchObject({
      action: "summoned",
    });
    // Another context on the same backend and namespace, with no controller.
    const reader = context(undefined, namespace);
    const stored = await harness({ jobs: reader }).call(
      "GET",
      "/queues/work/summon",
    );
    expect(stored.status).toBe(200);
    expect(stored.body.local).toBe(false);
    expect(Object.hasOwn(stored.body, "policy")).toBe(false);
    expect(stored.text).not.toContain('"policy"');
    // Negative: the very queue, served by the context running its controller.
    const local = await harness({ jobs: writer }).call(
      "GET",
      "/queues/work/summon",
    );
    expect(local.body.local).toBe(true);
    expect(Object.hasOwn(local.body, "policy")).toBe(true);
  });

  it("never sends an env value, even with exposeHosts and exposeSummonHandles", async () => {
    const jobs = context({
      work: { summoner, ...QUIET, env: { TOKEN: "s3cr3t", REGION: "eu-1" } },
    });
    await jobs.queue("work").add("a", {});
    await jobs.summonController("work").check();
    const h = harness({
      jobs,
      serialize: { exposeHosts: true, exposeSummonHandles: true },
    });
    const response = await h.call("GET", "/queues/work/summon");
    expect(response.body.policy.env).toEqual(["REGION", "TOKEN"]);
    expect(response.text).not.toContain("s3cr3t");
    expect(response.text).not.toContain("eu-1");
    // The options did expose what they govern, so the check is not vacuous.
    expect(response.text).toContain("build-7.internal");
    expect(response.text).toContain("arn:aws:ecs:1");
    const reset = await h.call("POST", "/queues/work/summon/reset");
    expect(reset.text).not.toContain("s3cr3t");
  });

  it("carries policy on the reset's answer too", async () => {
    const jobs = context({ work: { summoner, ...QUIET, maxWorkers: 2 } });
    const reset = await harness({ jobs }).call(
      "POST",
      "/queues/work/summon/reset",
      { budget: true },
    );
    expect(reset.status).toBe(200);
    // Validated first, and no asymmetric matcher below: Bun's `toMatchObject`
    // overwrites a received value an asymmetric matcher matched
    // (oven-sh/bun#3521), which would corrupt the body under test.
    expect(await validates(reset.body)).toBe(true);
    expect(reset.body.policy.maxWorkers).toBe(2);
    expect(reset.body.policy.explicit).toContain("maxWorkers");
  });

  it("leaves policy off GET /summon items", async () => {
    const jobs = context({ work: { summoner, ...QUIET } });
    const list = await harness({ jobs }).call("GET", "/summon");
    expect(list.status).toBe(200);
    const items = list.body.controllers as Record<string, unknown>[];
    expect(items.map((item) => item.queue)).toEqual(["work"]);
    expect(Object.hasOwn(items[0], "policy")).toBe(false);
    expect(list.text).not.toContain('"policy"');
  });
});

describe("a shared unit's policy.perQueue", () => {
  /** A context with a shared unit over `MEDIA`, `thumbs` overridden. */
  function unit(): BunJobs {
    return context([
      {
        queues: MEDIA,
        summoner,
        group: { name: "media", unit: "shared" },
        ...QUIET,
        maxWorkers: 3,
        overrides: { thumbs: { jobsPerWorker: 4 } },
      },
    ]);
  }

  it("keeps every queue for a caller who may read them all", async () => {
    const jobs = unit();
    const body = (await harness({ jobs }).call("GET", "/queues/thumbs/summon"))
      .body;
    expect(body.queues).toEqual(MEDIA);
    expect(body.policy.perQueue).toEqual({
      renders: { jobsPerWorker: null, maxWorkers: 3, explicit: [] },
      thumbs: { jobsPerWorker: 4, maxWorkers: 3, explicit: ["jobsPerWorker"] },
      previews: { jobsPerWorker: null, maxWorkers: 3, explicit: [] },
    });
    expect(await validates(body)).toBe(true);
  });

  it("drops a queue the caller may not read, as queues does", async () => {
    const jobs = unit();
    const h = harness({ jobs, authorize: denying(["previews"]) });
    const response = await h.call("GET", "/queues/thumbs/summon");
    expect(response.status).toBe(200);
    expect(response.body.queues).toEqual(["renders", "thumbs"]);
    expect(Object.keys(response.body.policy.perQueue)).toEqual([
      "renders",
      "thumbs",
    ]);
    expect(response.text).not.toContain("previews");
  });

  it("drops a queue this API cannot reach (its queues option), whatever authorize says", async () => {
    const jobs = unit();
    // A summon first, so the group's stored state names every member,
    // `previews` included: the route then asks `authorize` about it (and is
    // allowed), and only reachability keeps it out of the unit's fields.
    await jobs.queue("renders").add("a", {});
    expect(await jobs.summonController("renders").check()).toMatchObject({
      action: "summoned",
    });
    const h = harness({ jobs, queues: ["thumbs", "renders"] });
    const response = await h.call("GET", "/queues/thumbs/summon");
    expect(response.status).toBe(200);
    expect(Object.keys(response.body.group.queues)).toContain("previews");
    expect(
      h.calls.some(
        (call) => call.action === "queues.read" && call.queue === "previews",
      ),
    ).toBe(true);
    expect(response.body.queues).toEqual(["renders", "thumbs"]);
    expect(Object.keys(response.body.policy.perQueue)).toEqual([
      "renders",
      "thumbs",
    ]);
  });
});

describe("a per-queue group member's policy.circuit.group", () => {
  it("serves the group's shared-circuit thresholds, and the keys as set", async () => {
    const jobs = context([
      {
        queues: ["emails", "images"],
        summoner,
        ...QUIET,
        group: { name: "mail", circuit: { failures: 2 } },
      },
    ]);
    const response = await harness({ jobs }).call(
      "GET",
      "/queues/images/summon",
    );
    expect(response.status).toBe(200);
    expect(response.body.policy.circuit).toEqual({
      failures: 5,
      resetAfter: 900_000,
      group: { failures: 2, resetAfter: 900_000 },
    });
    expect(response.body.policy.explicit).toContain("group.circuit.failures");
    expect(response.body.policy.explicit).not.toContain(
      "group.circuit.resetAfter",
    );
    expect(await validates(response.body)).toBe(true);
  });
});

describe("/meta.features.summonPolicy", () => {
  it("is true in jobs mode and false in runner mode", async () => {
    const jobs = context({ work: { summoner, ...QUIET } });
    const served = await harness({ jobs }).call("GET", "/meta");
    expect(served.body.features.summonPolicy).toBe(true);
    const runner = await harness({ jobs, mode: "runner" }).call("GET", "/meta");
    expect(runner.body.features.summonPolicy).toBe(false);
  });
});

describe("the OpenAPI document", () => {
  it("names the policy SummonPolicyStatus, never SummonPolicy, and refers to it from the status", async () => {
    const jobs = context({ work: { summoner, ...QUIET } });
    const spec = (await harness({ jobs }).call("GET", "/openapi.json")).body;
    const schemas = spec.components.schemas;
    expect(schemas.SummonPolicyStatus).toBeDefined();
    expect(schemas.SummonPolicy).toBeUndefined();
    expect(schemas.SummonStatus.properties.policy).toEqual({
      $ref: "#/components/schemas/SummonPolicyStatus",
    });
    expect(schemas.SummonStatus.required).not.toContain("policy");
    const policy = schemas.SummonPolicyStatus;
    expect(policy.properties.jobsPerWorker.anyOf).toEqual([
      expect.objectContaining({ type: "number" }),
      { type: "null" },
    ]);
    expect(policy.properties.explicit.items.enum).toContain("bootBudget");
    expect(policy.properties.cooldown.description).toContain("in ms");
  });
});
