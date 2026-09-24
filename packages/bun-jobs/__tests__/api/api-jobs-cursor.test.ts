import { Buffer } from "node:buffer";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { harness, openContexts, openHarnesses } from "./fixtures";

/**
 * `GET /queues/:queue/jobs?cursor=…` over `fetch()` — the wire half of the
 * jobs-list keyset cursor, with `validateResponses` on, so every page here is
 * also checked against `JobPageSchema`.
 *
 * The driver-level walk is covered on every backend in
 * `__tests__/jobs-list-cursor.test.ts`. What is left for this file is what only
 * the route decides: that a cursor comes back as `page.next`, that `null` is
 * the end, that a bad or foreign one is **400 `INVALID_ARGUMENT` and never a
 * 200 holding page one** (which a walking client cannot tell from the end of
 * the list), that `active` is refused, and that `offset` is ignored beside a
 * cursor.
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

/** The id of job `n`, padded so it sorts in add order. */
const id = (n: number) => `job-${String(n).padStart(3, "0")}`;

/** Seeds `count` waiting jobs with ids that sort in add order. */
async function seed(h: ReturnType<typeof harness>, count: number) {
  await h.jobs.queue("mail").addBulk(
    Array.from({ length: count }, (_, i) => ({
      name: "send",
      data: { i },
      opts: { jobId: id(i) },
    })),
  );
}

describe("jobs list cursor over the wire", () => {
  it("hands back a cursor, walks with it, and ends on null", async () => {
    const h = harness();
    await seed(h, 25);

    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let turn = 0; turn < 10; turn++) {
      const query =
        cursor === undefined || cursor === null
          ? "?state=waiting&limit=7&order=asc"
          : `?state=waiting&limit=7&order=asc&cursor=${encodeURIComponent(cursor)}`;
      const page = await h.call("GET", `/queues/mail/jobs${query}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((job: { id: string }) => job.id));
      cursor = page.body.page.next;
      if (cursor === null) {
        // `hasMore` and the end signal must agree, or a client watching one
        // and a client watching the other disagree about the same page.
        expect(page.body.page.hasMore).toBe(false);
        break;
      }
      expect(page.body.page.hasMore).toBe(true);
    }

    expect(cursor).toBeNull();
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => id(i)));
  });

  it("mints a cursor on an offset page too, so a client can jump then walk", async () => {
    const h = harness();
    await seed(h, 30);

    // Page 2 by offset — the one thing a cursor cannot do.
    const jumped = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&limit=10&order=asc&offset=10",
    );
    expect(jumped.status).toBe(200);
    expect(jumped.body.page.offset).toBe(10);
    expect(jumped.body.page.next).toBeTruthy();

    // …and walk on from it.
    const walked = await h.call(
      "GET",
      `/queues/mail/jobs?state=waiting&limit=10&order=asc&cursor=${encodeURIComponent(jumped.body.page.next)}`,
    );
    expect(walked.body.items.map((job: { id: string }) => job.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => id(i + 20)),
    );
  });

  it("ignores `offset` beside a cursor", async () => {
    const h = harness();
    await seed(h, 30);

    const first = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&limit=10&order=asc",
    );
    const second = await h.call(
      "GET",
      `/queues/mail/jobs?state=waiting&limit=10&order=asc&offset=25&cursor=${encodeURIComponent(first.body.page.next)}`,
    );
    expect(second.body.items.map((job: { id: string }) => job.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => id(i + 10)),
    );
  });

  it("counts on request, and the total does not change the walk", async () => {
    const h = harness();
    await seed(h, 22);

    const first = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&limit=10&order=asc&total=true&cursor=",
    );
    // An empty cursor is not a cursor: the schema's `minLength` refuses it
    // rather than letting it read as "start at the beginning".
    expect(first.status).toBe(400);

    const page = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&limit=10&order=asc&total=true",
    );
    expect(page.body.page.total).toBe(22);
    const next = await h.call(
      "GET",
      `/queues/mail/jobs?state=waiting&limit=10&order=asc&total=true&cursor=${encodeURIComponent(page.body.page.next)}`,
    );
    expect(next.body.page.total).toBe(22);
    expect(next.body.items.map((job: { id: string }) => job.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => id(i + 10)),
    );
  });

  it("refuses a cursor that is malformed or from another route", async () => {
    const h = harness();
    await seed(h, 5);

    const bad = [
      "jl1.",
      "jl1.!!!",
      `jl1.${Buffer.from('{"v":1}').toString("base64url")}`,
      // The runner history's prefix: a real cursor, for another route.
      `rh1.${Buffer.from(
        JSON.stringify({ v: 1, k: "runHistory", w: [], p: [1, "r"] }),
      ).toString("base64url")}`,
    ];

    for (const cursor of bad) {
      const page = await h.call(
        "GET",
        `/queues/mail/jobs?state=waiting&cursor=${encodeURIComponent(cursor)}`,
      );
      // Never a 200 holding page one, which reads to a walking client exactly
      // like the end of the list.
      expect(page.status, cursor).toBe(400);
      expect(page.body.code).toBe("INVALID_ARGUMENT");
      expect(page.body.detail).toContain("not one this walk issued");
    }
  });

  it("refuses a cursor belonging to another walk, and says which mistake it is", async () => {
    const h = harness();
    await seed(h, 12);
    await h.jobs.queue("reports").add("build", {}, { jobId: "r-1" });

    const first = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&limit=5&order=asc",
    );
    const cursor = encodeURIComponent(first.body.page.next);

    const foreign = [
      ["another queue", `/queues/reports/jobs?state=waiting&limit=5&order=asc`],
      ["other states", `/queues/mail/jobs?state=completed&limit=5&order=asc`],
      ["the other order", `/queues/mail/jobs?state=waiting&limit=5&order=desc`],
      [
        "another sort",
        `/queues/mail/jobs?state=waiting&limit=5&order=asc&sort=createdAt`,
      ],
    ] as const;

    for (const [what, path] of foreign) {
      const page = await h.call("GET", `${path}&cursor=${cursor}`);
      expect(page.status, what).toBe(400);
      expect(page.body.code).toBe("INVALID_ARGUMENT");
      expect(page.body.detail, what).toContain("belongs to another walk");
    }
  });

  it("is one walk whichever order the states were named in", async () => {
    const h = harness();
    await seed(h, 12);

    const first = await h.call(
      "GET",
      "/queues/mail/jobs?state=waiting&state=delayed&limit=5&order=asc",
    );
    const next = await h.call(
      "GET",
      `/queues/mail/jobs?state=delayed&state=waiting&limit=5&order=asc&cursor=${encodeURIComponent(first.body.page.next)}`,
    );
    // The same jobs in the same order, so refusing this would be a refusal
    // with no cause.
    expect(next.status).toBe(200);
    expect(next.body.items.map((job: { id: string }) => job.id)).toEqual(
      Array.from({ length: 5 }, (_, i) => id(i + 5)),
    );
  });

  it("refuses a cursor on `active` alone, and says what to do instead", async () => {
    const h = harness();
    await seed(h, 5);

    const page = await h.call(
      "GET",
      "/queues/mail/jobs?state=active&limit=5&cursor=jl1.anything",
    );
    expect(page.status).toBe(400);
    expect(page.body.code).toBe("INVALID_ARGUMENT");
    expect(page.body.detail).toContain("lockExpiresAt");
    expect(page.body.detail).toContain("sort=createdAt");

    // And it mints none either, so a client cannot be handed one that would
    // then be refused.
    const offset = await h.call(
      "GET",
      "/queues/mail/jobs?state=active&limit=5",
    );
    expect(offset.status).toBe(200);
    expect(offset.body.page.next).toBeNull();
  });

  it("refuses a cursor longer than the cap without reading it", async () => {
    const h = harness();
    await seed(h, 3);

    const page = await h.call(
      "GET",
      `/queues/mail/jobs?state=waiting&cursor=jl1.${"a".repeat(2100)}`,
    );
    expect(page.status).toBe(400);
    expect(page.body.code).toBe("VALIDATION");
  });
});
