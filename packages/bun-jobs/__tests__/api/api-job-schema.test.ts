import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunQueue, MemoryDriver } from "../../lib/index";
import { testNamespace } from "../helpers";
import { harness, openContexts, openHarnesses } from "./fixtures";

/**
 * The management API over job data schemas (bun-validate V5a): what an
 * enqueue-time check in `BunQueue` makes of the add and update routes, and
 * that `GET /definitions` serves plain options with the schema lifted out.
 *
 * V5a only maps the queue's `JobDataValidationError` to a problem; V5b makes
 * these routes check whatever the policy says, and adds the schemas to
 * `/definitions`. V5c adds the flows route: each node against its own name's
 * schema on its own queue, a failure at its body path.
 */

afterEach(() => {
  // Every response matched its declared schema, the 400s included.
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
});

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

/** A value that must never come back in a response. */
const SECRET = "hunter2-not-an-email";

/** A harness whose registry defines `sendEmail` with a data schema. */
function withSchema() {
  const h = harness();
  h.jobs.define("sendEmail", async () => null, {
    attempts: 4,
    schema: {
      data: z.object({ to: z.email(), tags: z.array(z.string()).optional() }),
    },
  });
  return h;
}

describe("job data schemas over the management API", () => {
  it("answers an add whose data fails the definition's schema with 400 VALIDATION, at body paths", async () => {
    const h = withSchema();
    const refused = await h.call("POST", "/queues/jobs/jobs", {
      name: "sendEmail",
      data: { to: SECRET, tags: ["a", 7] },
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      code: "VALIDATION",
      detail: 'The job data did not match the schema of "sendEmail"',
    });
    expect(refused.body.issues).toEqual([
      expect.objectContaining({ target: "body", path: "data.to" }),
      expect.objectContaining({ target: "body", path: "data.tags.1" }),
    ]);
    expect(refused.text).not.toContain(SECRET);
    expect((await h.jobs.queue("jobs").count()).waiting).toBe(0);

    const added = await h.call("POST", "/queues/jobs/jobs", {
      name: "sendEmail",
      data: { to: "a@example.com" },
    });
    expect(added.status).toBe(201);
  });

  it("answers an update whose data fails the schema with 400 VALIDATION, leaving the job", async () => {
    const h = withSchema();
    const job = await h.jobs.now("sendEmail", { to: "a@example.com" });
    const refused = await h.call("PATCH", `/queues/jobs/jobs/${job.id}`, {
      data: { to: SECRET },
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "VALIDATION" });
    expect(refused.body.issues).toEqual([
      expect.objectContaining({ target: "body", path: "data.to" }),
    ]);
    expect(refused.text).not.toContain(SECRET);
    expect((await h.jobs.queue("jobs").getJob(job.id))?.data).toEqual({
      to: "a@example.com",
    });
  });

  it("serves GET /definitions with plain options: no schema in them", async () => {
    const h = withSchema();
    const listed = await h.call("GET", "/definitions");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      items: [{ name: "sendEmail", options: { attempts: 4 } }],
    });
  });
});

/** Every job a queue holds, in any state, read through the queue (not the API). */
async function total(queue: BunQueue<any, any, any, any>): Promise<number> {
  const counts = await queue.count();
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

describe("a flow's job data over the management API", () => {
  /** The registry defines `sendEmail` and `fetch` (data schemas), `report` and `notify` (none); `mail` has its own schema. */
  function withFlowSchemas() {
    const h = withSchema();
    h.jobs.define("report", async () => null);
    // Defined (so addable) with no schema: on `mail` that queue's own applies.
    h.jobs.define("notify", async () => null);
    h.jobs.define("fetch", async () => null, {
      schema: { data: z.object({ page: z.number() }) },
    });
    h.jobs.queue("mail", {
      schema: { data: z.object({ to: z.email() }) },
    });
    return h;
  }

  it("answers a bad node with 400 VALIDATION at its body path, writing nothing on any queue", async () => {
    const h = withFlowSchemas();
    const refused = await h.call("POST", "/queues/jobs/flows", {
      name: "report",
      data: {},
      children: [
        { name: "fetch", data: { page: 1 } },
        {
          name: "fetch",
          data: { page: 2 },
          children: [{ name: "sendEmail", data: { to: SECRET, tags: [7] } }],
        },
      ],
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      code: "VALIDATION",
      detail: 'The job data did not match the schema of "sendEmail"',
    });
    expect(refused.body.issues).toEqual([
      expect.objectContaining({
        target: "body",
        path: "children.1.children.0.data.to",
      }),
      expect.objectContaining({
        target: "body",
        path: "children.1.children.0.data.tags.0",
      }),
    ]);
    expect(refused.text).not.toContain(SECRET);
    expect(await total(h.jobs.queue("jobs"))).toBe(0);
  });

  it("checks a child on another queue against that queue's own schema", async () => {
    const h = withFlowSchemas();
    const refused = await h.call("POST", "/queues/jobs/flows", {
      name: "report",
      data: {},
      children: [{ name: "notify", data: { to: SECRET }, queue: "mail" }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.issues).toEqual([
      expect.objectContaining({ target: "body", path: "children.0.data.to" }),
    ]);
    expect(await total(h.jobs.queue("jobs"))).toBe(0);
    expect(await total(h.jobs.queue("mail"))).toBe(0);
  });

  it("reports the top job's data at `data`", async () => {
    const h = withFlowSchemas();
    const refused = await h.call("POST", "/queues/jobs/flows", {
      name: "fetch",
      data: { page: "one" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.issues).toEqual([
      expect.objectContaining({ target: "body", path: "data.page" }),
    ]);
  });

  it("adds a flow whose every node passes", async () => {
    const h = withFlowSchemas();
    const added = await h.call("POST", "/queues/jobs/flows", {
      name: "report",
      data: {},
      children: [
        { name: "fetch", data: { page: 1 } },
        { name: "notify", data: { to: "a@example.com" }, queue: "mail" },
      ],
    });
    expect(added.status).toBe(201);
    expect(await total(h.jobs.queue("jobs"))).toBe(2);
    expect(await total(h.jobs.queue("mail"))).toBe(1);
  });

  it("checks configured queues no context made, each with its own schema", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("v5c-api");
    const reports = new BunQueue("reports", {
      namespace,
      driver,
      logger: noopLogger,
    });
    const mail = new BunQueue("mail", {
      namespace,
      driver,
      logger: noopLogger,
      schema: { data: z.object({ to: z.email() }) },
    });
    const h = harness({
      jobs: undefined,
      queues: [reports, mail],
      addableNames: "any",
    });
    try {
      // `reports` alone cannot see `mail`'s schema; the route resolved both.
      const refused = await h.call("POST", "/queues/reports/flows", {
        name: "report",
        data: {},
        children: [{ name: "notify", data: { to: SECRET }, queue: "mail" }],
      });
      expect(refused.status).toBe(400);
      expect(refused.body.issues).toEqual([
        expect.objectContaining({ target: "body", path: "children.0.data.to" }),
      ]);
      expect(await total(reports)).toBe(0);
      expect(await total(mail)).toBe(0);
    } finally {
      await reports.close();
      await mail.close();
    }
  });
});
