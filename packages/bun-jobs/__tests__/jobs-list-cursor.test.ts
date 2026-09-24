import type {
  JobCursorKey,
  JobListWalk,
  JobQuery,
  JobsDriver,
  JobState,
} from "../lib/index";
import { Buffer } from "node:buffer";
import { afterAll, describe, expect, it } from "bun:test";
import {
  BunQueue,
  ConfigError,
  createDriver,
  decodeJobCursor,
  encodeJobCursor,
  findJobPage,
  jobCursorKey,
  jobOrderFields,
  jobWalkIsSeekable,
  MemoryDriver,
} from "../lib/index";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Walking `GET /queues/:queue/jobs` with a **keyset cursor**, on every
 * backend — the twin of the offset paging the same listing has always had.
 *
 * This is the route the whole cursor programme exists for. The offset probe
 * measured **1,259 unreachable jobs across 868 trials, every one of them
 * here**, and every one of them in a single cell: `states=waiting`,
 * `order=asc`, a queue that drains as fast as it fills. Jobs are claimed off
 * the head, so the window slides backwards under a fixed offset and the next
 * page steps straight over jobs in the middle that nobody touched.
 *
 * **The contrast is the point, and it names its arm.** One test here pages the
 * same* deterministic interleaving twice, once by offset and once by cursor,
 * and pins the ids the offset walk loses **by name** — so it fails if offset
 * ever stops failing, and the cursor assertion beside it stops being
 * decoration. Beside it sits the quiescent control: the same walk with nothing
 * leaving the list, where offset is correct and the test would pass without
 * testing anything.
 *
 * **What is worth running eight times is the seek**, because each backend
 * resolves it differently: SQL compares a dialect-specific keyset predicate,
 * MongoDB an `$or` disjunction, Redis a `(score, member)` rank inside Lua, and
 * the memory and file drivers an index into a list they materialised. They
 * must agree exactly, to the row.
 *
 * **Five key shapes, not seven states.** `jobOrderFields` gives every listing
 * one of five ordering keys, and the integration tests below cover one state
 * per shape: `waiting` (`priority`, `createdAt`), `delayed` (`runAt`, shared
 * with `failed`), `completed` (`finishedOn`, shared with `dead`), several
 * states (`createdAt`, shared with `waiting-children`), and `sort=createdAt`.
 * `active` is the fifth and is refused outright. The mapping from state to
 * shape is pinned by its own test, so a state added or moved cannot slip out
 * of coverage.
 */

const cleanups: (() => Promise<void>)[] = [];
const closers: (() => Promise<void>)[] = [];

const READY = await crossProcessBackends({ cleanups });

afterAll(async () => {
  while (closers.length > 0) {
    await closers.pop()!().catch(() => undefined);
  }
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** The id of job `n`, padded so it sorts in add order on every backend. */
const id = (n: number) => `job-${String(n).padStart(3, "0")}`;

/** The ids of a page, in the order the backend answered. */
const ids = (jobs: readonly { id: string }[]) => jobs.map((job) => job.id);

/** Every backend, plus the memory driver, which the shared list omits. */
const BACKENDS = [
  { name: "memory", build: () => new MemoryDriver(), available: true },
  ...READY.map(({ name, config, available }) => ({
    name,
    build: () => createDriver(config),
    available,
  })),
];

/** What one walk of a list saw, in order of first sight, and its repeats. */
interface Walked {
  /** Every id shown, in order of first sight. */
  seen: string[];
  /** Ids shown more than once — the failure an offset walk announces. */
  repeats: number;
  /** Each page's resolved `offset`, as the backend answered it. */
  offsets: (number | null)[];
}

for (const { name, build, available } of BACKENDS) {
  describe.skipIf(!available)(`jobs list cursor: ${name}`, () => {
    const ns = testNamespace("jl-cursor");
    let nth = 0;

    /**
     * One driver for the whole block. A driver per test exhausted PostgreSQL's
     * connection slots ("sorry, too many clients already") on a server the
     * other suites are using too, and every test here wants a queue of its
     * own, not a backend of its own.
     */
    let shared: JobsDriver | undefined;

    /** A connected queue of this test's own, on the block's driver. */
    async function connect(): Promise<{ queue: BunQueue; driver: JobsDriver }> {
      if (shared === undefined) {
        shared = build();
        await shared.connect();
        const driver = shared;
        closers.push(async () => {
          // Only this run's own namespace, never a prefix sweep: the shared
          // servers carry other suites' data.
          await driver.purge(ns).catch(() => undefined);
          await driver.close().catch(() => undefined);
        });
      }
      const driver = shared;
      const queue = new BunQueue(`jlc-${++nth}`, { namespace: ns, driver });
      await queue.connect();
      closers.push(async () => await queue.close().catch(() => undefined));
      return { queue, driver };
    }

    /** Adds jobs `from`..`to` with ids that sort in add order. */
    async function seed(
      queue: BunQueue,
      from: number,
      to: number,
      opts: Record<string, unknown> = {},
    ): Promise<void> {
      await queue.addBulk(
        Array.from({ length: to - from + 1 }, (_, i) => ({
          name: "row",
          data: { n: from + i },
          opts: { jobId: id(from + i), ...opts },
        })),
      );
    }

    /** Walks a listing to the end with the cursor, at most `guard` pages. */
    async function walk(
      queue: BunQueue,
      states: JobState[],
      limit: number,
      order: "asc" | "desc",
      sort?: "createdAt",
      between?: (turn: number) => Promise<void>,
      guard = 40,
    ): Promise<Walked> {
      const result: Walked = { seen: [], repeats: 0, offsets: [] };
      let after: JobCursorKey | undefined;

      for (let turn = 0; turn < guard; turn++) {
        if (turn > 0) {
          await between?.(turn);
        }
        const page = await queue.walk(states, {
          limit,
          order,
          ...(sort === undefined ? {} : { sort }),
          ...(after === undefined ? {} : { after }),
        });
        result.offsets.push(page.offset);
        for (const job of page.jobs) {
          if (result.seen.includes(job.id)) {
            result.repeats += 1;
          } else {
            result.seen.push(job.id);
          }
        }
        if (page.next === null) {
          return result;
        }
        after = page.next;
      }

      throw new Error("walk did not end within the guard");
    }

    /** The whole listing an offset walk gives over a list nothing is touching. */
    async function whole(
      queue: BunQueue,
      states: JobState[],
      order: "asc" | "desc",
      sort?: "createdAt",
    ): Promise<string[]> {
      const all: string[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await queue.list(states, {
          offset,
          limit: 200,
          order,
          ...(sort === undefined ? {} : { sort }),
        });
        all.push(...ids(page));
        if (page.length < 200) {
          return all;
        }
      }
    }

    /** Claims and completes the first `n` waiting jobs, giving them a `finishedOn`. */
    async function finish(
      queue: BunQueue,
      driver: JobsDriver,
      n: number,
    ): Promise<void> {
      for (let i = 0; i < n; i++) {
        const token = `tok-${i}-${Math.random().toString(36).slice(2, 8)}`;
        const claimed = await driver.claimJob(
          { ns, queue: queue.name },
          { workerId: "w", token, lockMs: 60_000, now: Date.now() },
        );
        if (!claimed) {
          throw new Error("nothing to claim");
        }
        // Distinct `finishedOn`s, so the order has something to order by —
        // and ties on it besides, which is what the id tie-break is for.
        await driver.completeJob(
          { ns, queue: queue.name },
          claimed.id,
          token,
          null,
          false,
          Date.now() + i,
        );
      }
    }

    /* --- every key shape the route offers --------------------------- */

    it("walks `waiting` in disjoint pages, both ways, and ends with a null cursor", async () => {
      const { queue } = await connect();
      await seed(queue, 1, 47);

      for (const order of ["asc", "desc"] as const) {
        const expected = await whole(queue, ["waiting"], order);
        const walked = await walk(queue, ["waiting"], 10, order);

        expect(walked.seen, `${order} walk`).toEqual(expected);
        expect(walked.repeats).toBe(0);
        // Every cursor page says whether it sought: a number where the
        // backend knew the position for free, `null` where counting it would
        // have cost what the offset cost. Never `undefined`, which would mean
        // the cursor was ignored.
        for (const offset of walked.offsets) {
          expect(offset === null || typeof offset === "number").toBe(true);
        }
      }
    });

    it("walks `delayed`, whose key is `runAt`", async () => {
      const { queue } = await connect();
      // Staggered delays, two jobs to a `runAt`, so the key orders them and
      // the id has ties to break.
      await queue.addBulk(
        Array.from({ length: 30 }, (_, i) => ({
          name: "row",
          data: { n: i },
          opts: { jobId: id(i), delay: 600_000 + Math.floor(i / 2) * 1000 },
        })),
      );

      for (const order of ["asc", "desc"] as const) {
        const expected = await whole(queue, ["delayed"], order);
        expect(expected.length).toBe(30);
        const walked = await walk(queue, ["delayed"], 7, order);
        expect(walked.seen, `${order} walk`).toEqual(expected);
        expect(walked.repeats).toBe(0);
      }
    });

    it("walks `completed`, whose key is `finishedOn`", async () => {
      const { queue, driver } = await connect();
      await seed(queue, 1, 24);
      await finish(queue, driver, 24);

      for (const order of ["asc", "desc"] as const) {
        const expected = await whole(queue, ["completed"], order);
        expect(expected.length).toBe(24);
        const walked = await walk(queue, ["completed"], 7, order);
        expect(walked.seen, `${order} walk`).toEqual(expected);
        expect(walked.repeats).toBe(0);
      }
    });

    it("walks several states at once, whose key is `createdAt`", async () => {
      const { queue, driver } = await connect();
      await seed(queue, 1, 30);
      await finish(queue, driver, 10);

      for (const order of ["asc", "desc"] as const) {
        const states: JobState[] = ["waiting", "completed"];
        const expected = await whole(queue, states, order);
        expect(expected.length).toBe(30);
        const walked = await walk(queue, states, 8, order);
        expect(walked.seen, `${order} walk`).toEqual(expected);
        expect(walked.repeats).toBe(0);
      }
    });

    it("walks `sort=createdAt` where the backend serves it", async () => {
      const { queue, driver } = await connect();
      await seed(queue, 1, 26);

      // Only a backend implementing `countAddedJobs` promises the sort; the
      // others refuse it, which is their documented answer and not a gap.
      const supported = await queue
        .list(["waiting"], { limit: 1, sort: "createdAt" })
        .then(
          () => true,
          () => false,
        );
      if (!supported) {
        return;
      }
      void driver;

      for (const order of ["asc", "desc"] as const) {
        const expected = await whole(queue, ["waiting"], order, "createdAt");
        const walked = await walk(queue, ["waiting"], 9, order, "createdAt");
        expect(walked.seen, `${order} walk`).toEqual(expected);
        expect(walked.repeats).toBe(0);
      }
    });

    /* --- the contrast, on the arm where offset fails ----------------- */

    it("loses nothing an offset walk loses, on a list jobs leave from the head", async () => {
      const { queue } = await connect();
      await seed(queue, 0, 99);

      /**
       * The arm. Jobs leave from the **head** while the walk runs, which is
       * what a queue being drained does and the only condition the probe
       * found silent. Two per page turn, removed deterministically so the
       * expectation below can be written down rather than observed.
       */
      const drainHead = async (turn: number) => {
        const head = await queue.list(["waiting"], {
          offset: 0,
          limit: 2,
          order: "asc",
        });
        expect(head.length, `turn ${turn} must have a head to drain`).toBe(2);
        for (const job of head) {
          expect(await queue.remove(job.id)).toBe(true);
        }
      };

      // The offset walk, with two jobs leaving the head between every turn.
      const byOffset: string[] = [];
      let offsetRepeats = 0;
      for (let p = 0; p < 5; p++) {
        if (p > 0) {
          await drainHead(p);
        }
        const page = await queue.list(["waiting"], {
          offset: p * 10,
          limit: 10,
          order: "asc",
        });
        for (const job of page) {
          if (byOffset.includes(job.id)) offsetRepeats += 1;
          else byOffset.push(job.id);
        }
      }

      // The precondition, asserted rather than assumed: the list really did
      // drain from the head, by exactly the eight jobs the interleaving
      // removed. Without that this measures a quiescent list, where offset is
      // correct and the comparison below would be vacuous.
      const left = await whole(queue, ["waiting"], "asc");
      expect(left.length).toBe(92);
      expect(left[0]).toBe(id(8));

      // The same interleaving from the same starting shape, walked with the
      // cursor. A fresh queue, so the two walks cannot disturb each other.
      const { queue: queue2 } = await connect();
      await seed(queue2, 0, 99);
      const byCursor: { seen: string[]; repeats: number } = {
        seen: [],
        repeats: 0,
      };
      let after: JobCursorKey | undefined;
      for (let p = 0; p < 5; p++) {
        if (p > 0) {
          const head = await queue2.list(["waiting"], {
            offset: 0,
            limit: 2,
            order: "asc",
          });
          expect(head.length, `turn ${p} must have a head to drain`).toBe(2);
          for (const job of head) {
            expect(await queue2.remove(job.id)).toBe(true);
          }
        }
        const page = await queue2.walk(["waiting"], {
          limit: 10,
          order: "asc",
          ...(after === undefined ? {} : { after }),
        });
        for (const job of page.jobs) {
          if (byCursor.seen.includes(job.id)) byCursor.repeats += 1;
          else byCursor.seen.push(job.id);
        }
        if (page.next !== null) after = page.next;
      }

      // The first 50 jobs as the list was: what the operator meant to read.
      // Eight of them were removed during the walk and nobody can show a job
      // that is not there, so the comparison is over the ones that survived.
      const meant = Array.from({ length: 50 }, (_, i) => id(i));
      const survived = meant.slice(8);

      // THE CONTRAST. Offset steps over jobs as the window slides backwards
      // under it: this is the failure the cursor exists for, and if it ever
      // stops happening the assertion below stops meaning anything. Two per
      // page turn, exactly the two the drain shifted the window past — never
      // claimed, never removed, and never shown.
      const missedByOffset = survived.filter((job) => !byOffset.includes(job));
      expect(missedByOffset).toEqual([10, 11, 22, 23, 34, 35, 46, 47].map(id));
      // And silently: not one repeat to tell the client anything moved.
      expect(offsetRepeats).toBe(0);

      // The cursor walk shows every one of them.
      expect(survived.filter((job) => !byCursor.seen.includes(job))).toEqual(
        [],
      );
      expect(byCursor.repeats).toBe(0);
    });

    it("is the control: with nothing leaving the list, the offset walk loses nothing either", async () => {
      // The arm that proves nothing, run deliberately. The probe found
      // `asc` with arrivals only clean in 217 of 217 trials under both
      // strategies, so a contrast measured here would be an artefact. It is
      // here so the test above can be shown to depend on its arm.
      const { queue } = await connect();
      await seed(queue, 0, 99);

      const byOffset: string[] = [];
      for (let p = 0; p < 5; p++) {
        // Arrivals only: `asc` puts them past the window, so nothing shifts.
        await queue.add("late", { p }, { jobId: `late-${p}` });
        const page = await queue.list(["waiting"], {
          offset: p * 10,
          limit: 10,
          order: "asc",
        });
        byOffset.push(...ids(page));
      }

      const meant = Array.from({ length: 50 }, (_, i) => id(i));
      expect(meant.filter((job) => !byOffset.includes(job))).toEqual([]);
    });

    /* --- the key is a value, not a position -------------------------- */

    it("seeks past a job that was removed after the page it ended", async () => {
      const { queue } = await connect();
      await seed(queue, 0, 29);

      const first = await queue.walk(["waiting"], { limit: 10, order: "asc" });
      expect(ids(first.jobs)).toEqual(
        Array.from({ length: 10 }, (_, i) => id(i)),
      );
      expect(first.next).not.toBeNull();

      // The job the cursor names is gone. A cursor that were a position could
      // not survive this; one that is a value seeks straight past it.
      expect(await queue.remove(id(9))).toBe(true);

      const second = await queue.walk(["waiting"], {
        limit: 10,
        order: "asc",
        after: first.next!,
      });
      expect(ids(second.jobs)).toEqual(
        Array.from({ length: 10 }, (_, i) => id(i + 10)),
      );
    });

    it("seeks past a job that left the states being listed", async () => {
      const { queue, driver } = await connect();
      await seed(queue, 0, 29);

      const first = await queue.walk(["waiting"], { limit: 10, order: "asc" });
      expect(first.next).not.toBeNull();

      // Claimed: still there, but no longer `waiting`, so the anchor has left
      // this listing exactly as a drain would take it.
      await finish(queue, driver, 10);

      const second = await queue.walk(["waiting"], {
        limit: 10,
        order: "asc",
        after: first.next!,
      });
      expect(ids(second.jobs)).toEqual(
        Array.from({ length: 10 }, (_, i) => id(i + 10)),
      );
    });

    it("keeps a several-state walk exact when the anchor is removed outright", async () => {
      // The sharpest case the fallback cannot serve, so every backend has to
      // serve it itself. On Redis the several-state listing is blocked by
      // state, each block in its own key order, and the shared scan seeks by
      // creation time — measured at 3 jobs lost and 3 repeated over 33 before
      // the driver did its own seek. Spread priorities so the `waiting` block's
      // own order and creation order genuinely disagree, or this passes
      // without testing anything.
      const { queue, driver } = await connect();
      await queue.addBulk(
        Array.from({ length: 18 }, (_, i) => ({
          name: "row",
          data: { n: i },
          opts: { jobId: id(i), priority: i % 3 },
        })),
      );
      await finish(queue, driver, 6);

      const states: JobState[] = ["waiting", "completed"];
      const before = await whole(queue, states, "asc");
      expect(before.length).toBe(18);

      for (const order of ["asc", "desc"] as const) {
        const start = await whole(queue, states, order);
        const seen: string[] = [];
        let repeats = 0;
        const removed: string[] = [];
        let after: JobCursorKey | undefined;

        for (let turn = 0; turn < 20; turn++) {
          if (after !== undefined) {
            // Removed outright, not claimed: the job's record is gone, so no
            // backend can find it and every one falls back on the key.
            expect(await queue.remove(after.id), `${order} remove`).toBe(true);
            removed.push(after.id);
          }
          const page = await queue.walk(states, {
            limit: 3,
            order,
            ...(after === undefined ? {} : { after }),
          });
          for (const job of page.jobs) {
            if (seen.includes(job.id)) repeats += 1;
            else seen.push(job.id);
          }
          if (page.next === null) break;
          after = page.next;
        }

        const survived = start.filter((job) => !removed.includes(job));
        expect(
          survived.filter((job) => !seen.includes(job)),
          `${order}: nothing that survived may be lost`,
        ).toEqual([]);
        expect(repeats, `${order}: nothing may repeat`).toBe(0);
      }
    });

    it("breaks ties between jobs added in one bulk", async () => {
      // After one `addBulk` essentially every adjacent pair ties on
      // `(priority, createdAt)`, so the tie-break decides the whole order, not
      // an edge case. A cursor that got it wrong would be wrong on every row.
      const { queue } = await connect();
      await seed(queue, 0, 39);

      const expected = await whole(queue, ["waiting"], "asc");
      const walked = await walk(queue, ["waiting"], 6, "asc");
      expect(walked.seen).toEqual(expected);
      expect(walked.repeats).toBe(0);
      expect(new Set(walked.seen).size).toBe(40);
    });

    it("ignores `offset` when a cursor is given", async () => {
      const { queue } = await connect();
      await seed(queue, 0, 29);

      const first = await queue.walk(["waiting"], { limit: 10, order: "asc" });
      const second = await queue.walk(["waiting"], {
        limit: 10,
        order: "asc",
        // A nonsense offset, which a cursor page must not look at.
        offset: 25,
        after: first.next!,
      });
      expect(ids(second.jobs)).toEqual(
        Array.from({ length: 10 }, (_, i) => id(i + 10)),
      );
    });

    it("walks with a filter, and the cursor stays valid across one", async () => {
      const { queue } = await connect();
      await queue.addBulk(
        Array.from({ length: 30 }, (_, i) => ({
          name: i % 2 === 0 ? "even" : "odd",
          data: { i },
          opts: { jobId: id(i) },
        })),
      );

      const walked = await walk(queue, ["waiting"], 4, "asc");
      expect(walked.seen.length).toBe(30);

      const evens: string[] = [];
      let after: JobCursorKey | undefined;
      for (let turn = 0; turn < 20; turn++) {
        const page = await queue.walk(["waiting"], {
          limit: 4,
          order: "asc",
          name: "even",
          ...(after === undefined ? {} : { after }),
        });
        evens.push(...ids(page.jobs));
        if (page.next === null) break;
        after = page.next;
      }
      expect(evens).toEqual(Array.from({ length: 15 }, (_, i) => id(i * 2)));
    });

    it("refuses a cursor on `active` alone, which its lock renewals would invalidate", async () => {
      const { queue } = await connect();
      await seed(queue, 0, 4);

      await expect(
        queue.walk(["active"], { limit: 5, order: "asc" }),
      ).rejects.toThrow(ConfigError);
    });
  });
}

/* --- the codec, on no backend at all -------------------------------- */

describe("jobs list cursor: the cursor itself", () => {
  const walk: JobListWalk = {
    ns: "ns",
    queue: "orders",
    states: ["waiting"],
    sort: undefined,
    order: "asc",
  };
  const key: JobCursorKey = {
    values: [0, 1_700_000_000_000],
    id: "job-007",
    state: "waiting",
    // Empty on a single-state walk: the walk's own values are already that
    // state's key, so there is nothing else to carry.
    stateValues: [],
  };

  it("round-trips a key through an opaque, prefixed cursor", () => {
    const cursor = encodeJobCursor(walk, key);
    expect(cursor.startsWith("jl1.")).toBe(true);
    expect(decodeJobCursor(cursor, walk)).toEqual(key);
  });

  it("is the same walk whatever order the states were named in", () => {
    // A several-state walk, which is also the only shape that carries
    // `stateValues` — the anchor's place in its own state's order, for a
    // backend whose several-state listing is not the contract's.
    const several = {
      ...key,
      values: [1_700_000_000_000],
      stateValues: [3, 1_700_000_000_000],
    };
    const one = encodeJobCursor(
      { ...walk, states: ["waiting", "delayed"] },
      several,
    );
    // The same jobs in the same order, so refusing this would be a refusal
    // with no cause.
    expect(
      decodeJobCursor(one, { ...walk, states: ["delayed", "waiting"] }),
    ).toEqual(several);
  });

  it("carries the anchor's own state key only where a backend needs it", () => {
    // A single state's own key *is* the walk's key, so carrying it twice would
    // be dead weight in every cursor; several states are where they differ.
    const single = decodeJobCursor(encodeJobCursor(walk, key), walk);
    expect(single.stateValues).toEqual([]);

    const severalWalk = { ...walk, states: ["waiting", "dead"] as JobState[] };
    const several = {
      ...key,
      values: [1_700_000_000_000],
      stateValues: [7, 1_700_000_000_001],
    };
    expect(
      decodeJobCursor(encodeJobCursor(severalWalk, several), severalWalk)
        .stateValues,
    ).toEqual([7, 1_700_000_000_001]);
  });

  it("refuses a cursor from another walk, and says so differently", () => {
    const cursor = encodeJobCursor(walk, key);
    const others: [string, JobListWalk][] = [
      ["another namespace", { ...walk, ns: "other" }],
      ["another queue", { ...walk, queue: "other" }],
      ["other states", { ...walk, states: ["completed"] }],
      ["the other order", { ...walk, order: "desc" }],
    ];

    for (const [what, other] of others) {
      expect(() => decodeJobCursor(cursor, other), what).toThrow(
        "this cursor belongs to another walk",
      );
    }

    // The sort is part of the walk too, and changing it changes both the walk
    // binding and the shape of the key — so it is refused either way.
    expect(() =>
      decodeJobCursor(cursor, { ...walk, sort: "createdAt" }),
    ).toThrow(ConfigError);
  });

  it("refuses a cursor that is malformed, truncated or from another route", () => {
    const bad = [
      "",
      "jl1.",
      "jl1.!!!!",
      "rh1.abc",
      `jl1.${Buffer.from('{"v":1}').toString("base64url")}`,
      `jl1.${Buffer.from(
        JSON.stringify({ v: 2, k: "jobsList", w: [], p: [] }),
      ).toString("base64url")}`,
      // The right walk, but a key of the wrong shape for it: `waiting` needs
      // two numbers, an id and a state.
      `jl1.${Buffer.from(
        JSON.stringify({
          v: 1,
          k: "jobsList",
          w: ["ns", "orders", "waiting", "natural", "asc"],
          p: [0, "job-007", "waiting"],
        }),
      ).toString("base64url")}`,
    ];

    for (const cursor of bad) {
      expect(() => decodeJobCursor(cursor, walk), cursor).toThrow(
        "cursor is not one this walk issued",
      );
    }
  });

  it("maps every state onto one of the five ordering keys the tests cover", () => {
    // The mapping the integration tests above rest on. A state added, or one
    // moved from one key to another, changes this table and so has to change
    // the coverage with it.
    const shapes: Record<JobState, string> = {
      waiting: "priority,createdAt",
      delayed: "runAt",
      failed: "runAt",
      active: "lockExpiresAt",
      completed: "finishedOn",
      dead: "finishedOn",
      "waiting-children": "createdAt",
    };

    for (const [state, shape] of Object.entries(shapes)) {
      expect(
        jobOrderFields([state as JobState], "natural").join(","),
        state,
      ).toBe(shape);
    }
    // Several states share one key, and so does the explicit sort.
    expect(jobOrderFields(["waiting", "dead"], "natural")).toEqual([
      "createdAt",
    ]);
    expect(jobOrderFields(["completed"], "createdAt")).toEqual(["createdAt"]);
  });

  it("says `active` alone cannot be walked, and everything else can", () => {
    expect(jobWalkIsSeekable(["active"], "natural")).toBe(false);
    expect(jobWalkIsSeekable(["active"], undefined)).toBe(false);
    // With an immutable sort, or beside another state, it is walkable again:
    // the order is then `createdAt`, which no lock renewal touches.
    expect(jobWalkIsSeekable(["active"], "createdAt")).toBe(true);
    expect(jobWalkIsSeekable(["active", "waiting"], "natural")).toBe(true);
    for (const state of [
      "waiting",
      "delayed",
      "failed",
      "completed",
      "dead",
      "waiting-children",
    ] as JobState[]) {
      expect(jobWalkIsSeekable([state], "natural"), state).toBe(true);
    }
  });
});

/* --- the fallback paths --------------------------------------------- */

describe("jobs list cursor: drivers that cannot seek", () => {
  const closing: (() => Promise<void>)[] = [];

  afterAll(async () => {
    while (closing.length > 0) {
      await closing.pop()!().catch(() => undefined);
    }
  });

  /** A memory driver with `findJobs` shaped as this or that. */
  function driverWith(
    replace: (memory: MemoryDriver) => Partial<MemoryDriver>,
  ): MemoryDriver {
    const memory = new MemoryDriver();
    const overrides = replace(memory);
    return new Proxy(memory, {
      get(target, property) {
        if (property in overrides) {
          return overrides[property as keyof MemoryDriver];
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MemoryDriver;
  }

  /** A queue on a driver, closed at the end. */
  async function queueOn(driver: JobsDriver): Promise<BunQueue> {
    const queue = new BunQueue("fallback", {
      namespace: testNamespace("jlc-fb"),
      driver,
    });
    await queue.connect();
    closing.push(async () => await queue.close());
    await queue.addBulk(
      Array.from({ length: 25 }, (_, i) => ({
        name: "row",
        data: { i },
        opts: { jobId: id(i) },
      })),
    );
    return queue;
  }

  it("cannot seek a listing blocked by state, which is why such a driver must seek for itself", async () => {
    // **The gap this test exists for.** The shared scan's fallback compares
    // the walk's key — `(createdAt, id)` for several states — against the
    // listing it read. That is what memory, the file driver, SQL and MongoDB
    // actually answer, and it is what the driver contract says. The **Redis**
    // driver does not: it concatenates whole state sorted-sets, so its
    // several-state listing is blocked by state, each block in that state's
    // own key order. Comparing a `createdAt` key against that landed anywhere,
    // and measured 3 jobs lost and 3 repeated over a 33-job walk — **silently**,
    // which is the failure this whole cursor exists to remove. So the seek
    // checks the order it was actually given rather than assuming it.
    const blocked = driverWith((memory) => ({
      // Exactly Redis's shape: the states one after another, each in its own
      // natural order, reversed as a whole for `desc`.
      listJobs: async (
        q: never,
        states: JobState[],
        opts: { offset: number; limit: number; order: "asc" | "desc" },
      ) => {
        const all: Awaited<ReturnType<MemoryDriver["listJobs"]>> = [];
        for (const state of opts.order === "desc"
          ? [...states].reverse()
          : states) {
          all.push(
            ...(await memory.listJobs(q, [state], {
              offset: 0,
              limit: 100_000,
              order: opts.order,
            })),
          );
        }
        return all.slice(opts.offset, opts.offset + opts.limit);
      },
      // And, like Redis on a several-state walk whose anchor was removed
      // outright, it declines the seek — which is what hands the page to the
      // scan.
      findJobs: undefined,
    }));

    const queue = new BunQueue("blocked", {
      namespace: testNamespace("jlc-blocked"),
      driver: blocked,
    });
    await queue.connect();
    closing.push(async () => await queue.close());

    // Priorities spread across the `waiting` block, so its own order is by
    // priority and disagrees with creation order — the condition that makes
    // the two interpretations differ at all.
    await queue.addBulk(
      Array.from({ length: 18 }, (_, i) => ({
        name: "row",
        data: { i },
        opts: { jobId: id(i), priority: i % 3 },
      })),
    );
    await queue.addBulk(
      Array.from({ length: 9 }, (_, i) => ({
        name: "row",
        data: { i },
        opts: { jobId: id(100 + i), delay: 600_000 + i * 1000 },
      })),
    );

    const states: JobState[] = ["waiting", "delayed"];
    const expected: string[] = [];
    const seenCreated = new Map<string, number>();
    for (let offset = 0; ; offset += 50) {
      const page = await queue.list(states, {
        offset,
        limit: 50,
        order: "asc",
      });
      for (const job of page) {
        seenCreated.set(job.id, job.createdAt);
      }
      expected.push(...ids(page));
      if (page.length < 50) break;
    }
    expect(expected.length).toBe(27);

    // The walk, with the job the cursor names **removed outright** before
    // every following page — the one case the driver cannot seek itself.
    const seen: string[] = [];
    let repeats = 0;
    const removed: string[] = [];
    let after: JobCursorKey | undefined;
    for (let turn = 0; turn < 20; turn++) {
      if (after !== undefined) {
        expect(await queue.remove(after.id)).toBe(true);
        removed.push(after.id);
      }
      const page = await queue.walk(states, {
        limit: 4,
        order: "asc",
        ...(after === undefined ? {} : { after }),
      });
      for (const job of page.jobs) {
        if (seen.includes(job.id)) repeats += 1;
        else seen.push(job.id);
      }
      if (page.next === null) break;
      after = page.next;
    }

    // **The limit, pinned so it cannot become a surprise.** The scan seeks by
    // the walk's key — creation time, for several states — against a listing
    // that is not in creation order, and loses jobs. This assertion is the
    // documentation's evidence, and it is here rather than in a comment so
    // that a future attempt to repair the scan has something that turns green.
    const survived = expected.filter((job) => !removed.includes(job));
    const lost = survived.filter((job) => !seen.includes(job));
    expect(lost.length).toBeGreaterThan(0);
    // It repeats as well as loses, which is what an ordering it cannot
    // describe does — and the repeats are the half a client could have seen.
    expect(repeats).toBeGreaterThan(0);

    // And why it cannot be repaired here: the listing is *also* non-decreasing
    // by creation time, because one `addBulk` gives every job the same
    // millisecond. Nothing about these rows says which of the two orders they
    // are in, so the driver is the only place that knows — see
    // `scanAfterCursor`'s JSDoc, and Redis's own `SEEK_JOBS`.
    const created = expected.map((job) => seenCreated.get(job) ?? Number.NaN);
    expect(created.every((at, i) => i === 0 || at >= created[i - 1]!)).toBe(
      true,
    );
  });

  it("seeks for a driver with no `findJobs` at all", async () => {
    const driver = driverWith(() => ({ findJobs: undefined }));
    const queue = await queueOn(driver);

    const seen: string[] = [];
    let after: JobCursorKey | undefined;
    for (let turn = 0; turn < 10; turn++) {
      const page = await queue.walk(["waiting"], {
        limit: 7,
        order: "asc",
        ...(after === undefined ? {} : { after }),
      });
      // The shared scan counts as it goes, so it always knows the position.
      expect(typeof page.offset).toBe("number");
      seen.push(...ids(page.jobs));
      if (page.next === null) break;
      after = page.next;
    }

    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => id(i)));
  });

  it("discards a page from a `findJobs` that ignored the cursor", async () => {
    let served = 0;
    const driver = driverWith((memory) => ({
      findJobs: async (q: never, query: JobQuery) => {
        served += 1;
        // Exactly what a driver written before cursors does: the field is
        // unknown, so it answers page one and says nothing about a seek.
        const page = await memory.findJobs(q, { ...query, after: undefined });
        return {
          jobs: page.jobs,
          ...(page.total === undefined ? {} : { total: page.total }),
        };
      },
    }));
    const queue = await queueOn(driver);

    const first = await queue.walk(["waiting"], { limit: 7, order: "asc" });
    expect(ids(first.jobs)).toEqual(Array.from({ length: 7 }, (_, i) => id(i)));

    const second = await queue.walk(["waiting"], {
      limit: 7,
      order: "asc",
      after: first.next!,
    });
    // Not page one: the page that ignored the cursor was thrown away and the
    // query re-read by the scan, which seeks. Serving page one here would read
    // to a walking client exactly like the end of the list.
    expect(ids(second.jobs)).toEqual(
      Array.from({ length: 7 }, (_, i) => id(i + 7)),
    );
    expect(served).toBeGreaterThan(0);
  });

  it("uses such a driver's page unchanged when no cursor is given", async () => {
    const calls: JobQuery[] = [];
    const driver = driverWith((memory) => ({
      findJobs: async (q: never, query: JobQuery) => {
        calls.push(query);
        return await memory.findJobs(q, query);
      },
    }));
    const queue = await queueOn(driver);

    const page = await findJobPage(
      driver,
      { ns: queue.namespace, queue: queue.name },
      { states: ["waiting"], offset: 5, limit: 5, order: "asc" },
    );
    expect(ids(page.jobs)).toEqual(
      Array.from({ length: 5 }, (_, i) => id(i + 5)),
    );
    // One read, not two: nothing was discarded.
    expect(calls.length).toBe(1);
  });

  it("mints a key from the job the page ended on", async () => {
    const driver = new MemoryDriver();
    const queue = await queueOn(driver);

    const page = await queue.walk(["waiting"], { limit: 3, order: "asc" });
    const last = page.jobs.at(-1)!;
    expect(page.next).toEqual(
      jobCursorKey(last.toJSON(), jobOrderFields(["waiting"], "natural")),
    );
    expect(page.next!.id).toBe(id(2));
    expect(page.next!.state).toBe("waiting");
  });
});
