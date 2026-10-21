import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { harness, openContexts, openHarnesses } from "./fixtures";

/**
 * The management API over job data schemas (bun-validate V5a): what an
 * enqueue-time check in `BunQueue` makes of the add and update routes, and
 * that `GET /definitions` serves plain options with the schema lifted out.
 *
 * V5a only maps the queue's `JobDataValidationError` to a problem; V5b makes
 * these routes check whatever the policy says, and adds the schemas to
 * `/definitions`.
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
