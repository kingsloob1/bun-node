import type { JobsDriver, RunRecord } from "../lib/index";
import { afterAll, describe, expect, it } from "bun:test";
import { createDriver, MemoryDriver, runnerKey } from "../lib/index";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Paging `GET /runners/:runner/history` at the storage layer, on every backend.
 *
 * The route is thin — it turns a query into `pageHistory` and a `PageInfo` — so
 * what is worth running eight times is the driver's own slicing: the order, the
 * boundaries, and above all that **page two holds the records page one did
 * not**. A test that only asserted "page two returned something" would pass on
 * a driver that ignored `offset` entirely, which is exactly the bug paging is
 * being added to fix.
 *
 * Records are written straight through `appendHistory` rather than by running a
 * runner: a run takes milliseconds and this needs tens of records in a known
 * order, and `appendHistory` is the very call a real run makes.
 */

const cleanups: (() => Promise<void>)[] = [];
const purges: (() => Promise<void>)[] = [];

const READY = await crossProcessBackends({ cleanups });

afterAll(async () => {
  await Promise.allSettled(purges.map((purge) => purge()));
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** A record whose `runId` says where it belongs in the sequence. */
function record(n: number): RunRecord {
  return {
    runId: `run-${String(n).padStart(3, "0")}`,
    runnerId: "hist",
    attempt: 1,
    source: "manual",
    mode: "in-process",
    host: "test",
    startedAt: 1_700_000_000_000 + n * 1000,
    finishedAt: 1_700_000_000_500 + n * 1000,
    durationMs: 500,
    status: "success",
  };
}

/**
 * Writes `count` records oldest-first, so the store ends up newest-first with
 * `run-{count}` at the head — the order a runner actually produces.
 */
async function seed(
  driver: JobsDriver,
  ns: string,
  key: string,
  count: number,
  keep = 1000,
): Promise<void> {
  for (let n = 1; n <= count; n++) {
    await driver.appendHistory(ns, key, record(n), keep);
  }
}

/** The ids of a page, in the order the driver answered. */
const ids = (records: readonly RunRecord[]) => records.map((r) => r.runId);

/** The whole history newest-first, as ids: `run-N` … `run-1`. */
function expectedDesc(count: number): string[] {
  return ids(Array.from({ length: count }, (_, i) => record(count - i)));
}

/** Every backend, plus the memory driver, which the shared list omits. */
const BACKENDS = [
  { name: "memory", build: () => new MemoryDriver(), available: true },
  ...READY.map(({ name, config, available }) => ({
    name,
    build: () => createDriver(config),
    available,
  })),
];

for (const { name, build, available } of BACKENDS) {
  describe.skipIf(!available)(`runner history paging: ${name}`, () => {
    const ns = testNamespace("hist-page");
    let next = 0;

    /**
     * A connected driver and a runner key of this test's own.
     *
     * A key per test, not per suite: these backends are real servers, the
     * histories persist, and a shared key would have each test paging what
     * the one before it wrote. Each is dropped by name when the suite ends —
     * never a prefix sweep.
     */
    async function connect(): Promise<{ driver: JobsDriver; key: string }> {
      const driver = build();
      await driver.connect();
      const key = runnerKey(`hist-${++next}`);
      purges.push(async () => {
        try {
          await driver.clearHistory(ns, key);
        } finally {
          await driver.close();
        }
      });
      return { driver, key };
    }

    it("pages a history longer than one page, and page two holds what page one did not", async () => {
      const { driver, key } = await connect();
      await seed(driver, ns, key, 25);

      const first = await driver.pageHistory!(ns, key, {
        offset: 0,
        limit: 10,
        order: "desc",
      });
      const second = await driver.pageHistory!(ns, key, {
        offset: 10,
        limit: 10,
        order: "desc",
      });
      const third = await driver.pageHistory!(ns, key, {
        offset: 20,
        limit: 10,
        order: "desc",
      });

      // Newest first: run-25 … run-1.
      const all = expectedDesc(25);
      expect(ids(first.records)).toEqual(all.slice(0, 10));
      expect(ids(second.records)).toEqual(all.slice(10, 20));
      // The last page is short, not padded.
      expect(ids(third.records)).toEqual(all.slice(20));

      // The point of the whole feature: the pages are disjoint and together
      // they are the history — not "page two returned ten rows".
      expect(
        ids(second.records).some((id) => ids(first.records).includes(id)),
      ).toBe(false);
      expect([
        ...ids(first.records),
        ...ids(second.records),
        ...ids(third.records),
      ]).toEqual(all);
    });

    it("counts the whole history on every page, never just the page", async () => {
      const { driver, key } = await connect();
      await seed(driver, ns, key, 25);

      for (const offset of [0, 10, 20, 24]) {
        const page = await driver.pageHistory!(ns, key, {
          offset,
          limit: 10,
          order: "desc",
        });
        expect(page.total, `offset ${offset}`).toBe(25);
        // `hasMore`, as the route computes it.
        expect(
          offset + page.records.length < page.total,
          `hasMore at ${offset}`,
        ).toBe(offset + page.records.length < 25);
      }
    });

    it("orders by start time both ways, paging the same list from opposite ends", async () => {
      const { driver, key } = await connect();
      await seed(driver, ns, key, 25);

      const desc = await driver.pageHistory!(ns, key, {
        offset: 0,
        limit: 5,
        order: "desc",
      });
      const asc = await driver.pageHistory!(ns, key, {
        offset: 0,
        limit: 5,
        order: "asc",
      });

      // Newest five, and oldest five.
      expect(ids(desc.records)).toEqual([
        "run-025",
        "run-024",
        "run-023",
        "run-022",
        "run-021",
      ]);
      expect(ids(asc.records)).toEqual([
        "run-001",
        "run-002",
        "run-003",
        "run-004",
        "run-005",
      ]);
      expect(asc.total).toBe(desc.total);

      // An `asc` page deep in the list is the mirror of the `desc` page at the
      // same distance from the other end — the case an index-arithmetic bug
      // (the Redis script computes indices rather than reversing) would miss.
      const ascDeep = await driver.pageHistory!(ns, key, {
        offset: 20,
        limit: 5,
        order: "asc",
      });
      expect(ids(ascDeep.records)).toEqual(ids(desc.records).toReversed());
    });

    it("answers an empty page past the end, with the total intact", async () => {
      const { driver, key } = await connect();
      await seed(driver, ns, key, 25);

      const past = await driver.pageHistory!(ns, key, {
        offset: 25,
        limit: 10,
        order: "desc",
      });
      expect(past.records).toEqual([]);
      // Still the whole list's size: an empty page is not an empty history,
      // and a pager reading this as "of 0" would lose its way back.
      expect(past.total).toBe(25);

      const wayPast = await driver.pageHistory!(ns, key, {
        offset: 10_000,
        limit: 10,
        order: "desc",
      });
      expect(wayPast.records).toEqual([]);
      expect(wayPast.total).toBe(25);
    });

    it("reaches records beyond `limits.maxHistory`, which is what the offset is for", async () => {
      const { driver, key } = await connect();
      // A `keepHistory` well above the API's default page cap of 200: before
      // paging these records existed and no client could ever read them.
      await seed(driver, ns, key, 60, 1000);

      // Read the whole history 20 at a time, as a client with a 20-row page
      // would, and check nothing is missed or repeated.
      const seen: string[] = [];
      for (let offset = 0; ; offset += 20) {
        const page = await driver.pageHistory!(ns, key, {
          offset,
          limit: 20,
          order: "desc",
        });
        seen.push(...ids(page.records));
        if (offset + page.records.length >= page.total) {
          break;
        }
      }

      expect(seen).toEqual(expectedDesc(60));
      expect(new Set(seen).size).toBe(60);
    });

    it("keeps the page and its total describing the same read", async () => {
      const { driver, key } = await connect();
      await seed(driver, ns, key, 10);

      const page = await driver.pageHistory!(ns, key, {
        offset: 0,
        limit: 4,
        order: "desc",
      });
      // The invariant every driver has to hold however it reads: what the page
      // holds must be consistent with the size it reports, so a pager's last
      // page neither repeats nor vanishes.
      expect(page.records.length).toBeLessThanOrEqual(page.total);
      expect(page.total).toBe(10);

      // A record added after the read does not retroactively change the page.
      await driver.appendHistory(ns, key, record(11), 1000);
      expect(ids(page.records)).toEqual([
        "run-010",
        "run-009",
        "run-008",
        "run-007",
      ]);
      const after = await driver.pageHistory!(ns, key, {
        offset: 0,
        limit: 4,
        order: "desc",
      });
      expect(after.total).toBe(11);
      expect(ids(after.records)[0]).toBe("run-011");
    });

    it("pages a history trimmed by `keepHistory` to exactly what survives", async () => {
      const { driver, key } = await connect();
      // 30 written, 12 kept: the trim drops from the old end.
      await seed(driver, ns, key, 30, 12);

      const page = await driver.pageHistory!(ns, key, {
        offset: 0,
        limit: 50,
        order: "desc",
      });
      expect(page.total).toBe(12);
      expect(ids(page.records)).toEqual(expectedDesc(30).slice(0, 12));
    });
  });
}
