import type { JobsDriver, RunHistoryCursorKey, RunRecord } from "../lib/index";
import { Buffer } from "node:buffer";
import { afterAll, describe, expect, it } from "bun:test";
import {
  createDriver,
  decodeHistoryCursor,
  encodeHistoryCursor,
  MemoryDriver,
  pageRunHistory,
  readHistoryPage,
  runnerKey,
} from "../lib/index";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Walking `GET /runners/:runner/history` with a **keyset cursor**, on every
 * backend — the twin of `runner-history-paging.test.ts`, which does the same
 * for offsets.
 *
 * What is worth running eight times is the seek itself, because each backend
 * resolves it differently: memory, file and SQL share `pageRunHistory`,
 * MongoDB reads the array whole and seeks here, and Redis resolves it inside a
 * Lua script that computes indices rather than reversing the list. They must
 * agree exactly, and the interleaving tests below are what would catch one of
 * them being off by a row.
 *
 * **The contrast is the point.** Two tests here page the *same* interleaving
 * twice, once by offset and once by cursor, and assert that the offset walk
 * loses records and the cursor walk does not. A cursor test that only asserted
 * the cursor walk was complete would pass just as well on a history nothing
 * was writing to, which is the case where offset is correct too.
 *
 * Records go in through `appendHistory` — the very call a real run makes —
 * rather than by running a runner, because these need tens of records in a
 * known order and a run takes milliseconds.
 */

const cleanups: (() => Promise<void>)[] = [];
const purges: (() => Promise<void>)[] = [];

const READY = await crossProcessBackends({ cleanups });

afterAll(async () => {
  await Promise.allSettled(purges.map((purge) => purge()));
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** A record whose `runId` says where it belongs in the sequence. */
function record(n: number, startedAt?: number): RunRecord {
  return {
    runId: `run-${String(n).padStart(3, "0")}`,
    runnerId: "hist",
    attempt: 1,
    source: "manual",
    mode: "in-process",
    host: "test",
    startedAt: startedAt ?? 1_700_000_000_000 + n * 1000,
    finishedAt: (startedAt ?? 1_700_000_000_000 + n * 1000) + 500,
    durationMs: 500,
    status: "success",
  };
}

/** The ids of a page, in the order the driver answered. */
const ids = (records: readonly RunRecord[]) => records.map((r) => r.runId);

/** The id of record `n`, for writing expectations that read like the seeding. */
const id = (n: number) => `run-${String(n).padStart(3, "0")}`;

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
  describe.skipIf(!available)(`runner history cursor: ${name}`, () => {
    const ns = testNamespace("hist-cursor");
    let next = 0;

    /** A connected driver and a runner key of this test's own, dropped by name at the end. */
    async function connect(): Promise<{ driver: JobsDriver; key: string }> {
      const driver = build();
      await driver.connect();
      const key = runnerKey(`hcur-${++next}`);
      purges.push(async () => {
        try {
          await driver.clearHistory(ns, key);
        } finally {
          await driver.close();
        }
      });
      return { driver, key };
    }

    /** Writes records `from`..`to` oldest first, trimming to `keep`. */
    async function seed(
      driver: JobsDriver,
      key: string,
      from: number,
      to: number,
      keep = 1000,
    ): Promise<void> {
      for (let n = from; n <= to; n++) {
        await driver.appendHistory(ns, key, record(n), keep);
      }
    }

    /**
     * One page, read the way the route reads it: the seek, the resolved
     * offset, and the cursor for the page after — so a driver that forgot to
     * answer {@link RunHistoryPage.offset} fails here rather than silently
     * restarting at page one.
     */
    async function page(
      driver: JobsDriver,
      key: string,
      opts: {
        /** Records on the page. */
        limit: number;
        /** Which direction to walk. */
        order: "asc" | "desc";
        /** Where the previous page stopped, or undefined for the first. */
        after?: RunHistoryCursorKey;
      },
    ) {
      const result = await readHistoryPage(driver, ns, key, {
        offset: 0,
        limit: opts.limit,
        order: opts.order,
        ...(opts.after === undefined ? {} : { after: opts.after }),
      });
      // Every driver in this repo seeks, so every one must say where it landed.
      expect(result.offset, "resolved offset").toBeTypeOf("number");
      const offset = result.offset!;
      const hasMore = offset + result.records.length < result.total;
      const last = result.records.at(-1);
      return {
        ...result,
        offset,
        hasMore,
        /** The cursor for the next page, or null at the end of the walk. */
        next:
          hasMore && last !== undefined
            ? { startedAt: last.startedAt, runId: last.runId }
            : null,
      };
    }

    /** Walks the whole list with the cursor and returns every id shown, in order. */
    async function walk(
      driver: JobsDriver,
      key: string,
      order: "asc" | "desc",
      limit: number,
      /** Runs started between one page and the next. */
      between?: (turn: number) => Promise<void>,
    ): Promise<{ seen: string[]; turns: number }> {
      const seen: string[] = [];
      let after: RunHistoryCursorKey | undefined;
      let turns = 0;

      for (;;) {
        if (turns > 0) {
          await between?.(turns);
        }
        const result = await page(driver, key, { limit, order, after });
        seen.push(...ids(result.records));
        turns += 1;
        if (result.next === null || turns > 200) {
          return { seen, turns };
        }
        after = result.next;
      }
    }

    it("walks the whole history, in disjoint pages, both ways", async () => {
      const { driver, key } = await connect();
      await seed(driver, key, 1, 25);

      const desc = await walk(driver, key, "desc", 10);
      const asc = await walk(driver, key, "asc", 10);

      const oldestFirst = Array.from({ length: 25 }, (_, i) => id(i + 1));
      expect(asc.seen).toEqual(oldestFirst);
      expect(desc.seen).toEqual(oldestFirst.toReversed());
      // Three pages of 10, 10 and 5 — the walk stops on its own.
      expect(desc.turns).toBe(3);
      expect(asc.turns).toBe(3);
      // Disjoint, which is the whole feature: not "page two returned rows".
      expect(new Set(desc.seen).size).toBe(25);
      expect(new Set(asc.seen).size).toBe(25);
    });

    it("signals the end of the walk with a null cursor, not an empty page", async () => {
      const { driver, key } = await connect();
      await seed(driver, key, 1, 12);

      const first = await page(driver, key, { limit: 12, order: "desc" });
      // The page holds everything, so there is nothing after it — and a client
      // must learn that here rather than by turning one more page and getting
      // nothing, which is indistinguishable from a page it lost.
      expect(first.records).toHaveLength(12);
      expect(first.hasMore).toBe(false);
      expect(first.next).toBeNull();

      // One short of the end still has more, and its cursor is the last row's.
      const short = await page(driver, key, { limit: 11, order: "desc" });
      expect(short.hasMore).toBe(true);
      expect(short.next).toEqual({
        startedAt: record(2).startedAt,
        runId: id(2),
      });
      const last = await page(driver, key, {
        limit: 11,
        order: "desc",
        after: short.next!,
      });
      expect(ids(last.records)).toEqual([id(1)]);
      expect(last.next).toBeNull();
      // The resolved offset places the last page in the whole list.
      expect(last.offset).toBe(11);
      expect(last.total).toBe(12);
    });

    it("loses nothing an offset walk loses, on a FULL history with runs starting between pages", async () => {
      const { driver, key } = await connect();
      // `keepHistory` 60, 60 written: the history is full before paging
      // starts, which is the precondition the hazard needs. While it is still
      // filling, an `asc` offset walk is correct and this test would pass
      // without testing anything.
      const keep = 60;
      await seed(driver, key, 1, keep, keep);
      const start = await readHistoryPage(driver, ns, key, {
        offset: 0,
        limit: 1,
        order: "asc",
      });
      expect(start.total, "history must be FULL before paging").toBe(keep);

      /** Starts `n` runs, which prepends `n` records and trims `n` off the old end. */
      let written = keep;
      const startRuns = async (n: number) => {
        for (let i = 0; i < n; i++) {
          await driver.appendHistory(ns, key, record(++written), keep);
        }
      };

      // The offset walk, with two runs starting between every page turn.
      const byOffset: string[] = [];
      for (let p = 0; p < 4; p++) {
        if (p > 0) {
          await startRuns(2);
        }
        const result = await readHistoryPage(driver, ns, key, {
          offset: p * 10,
          limit: 10,
          order: "asc",
        });
        byOffset.push(...ids(result.records));
      }

      // The same interleaving again, from the same starting shape, walked with
      // the cursor. A fresh runner so the two walks cannot disturb each other.
      const { driver: driver2, key: key2 } = await connect();
      await seed(driver2, key2, 1, keep, keep);
      let written2 = keep;
      const { seen: byCursor } = await walk(
        driver2,
        key2,
        "asc",
        10,
        async (turn) => {
          if (turn >= 4) {
            return;
          }
          for (let i = 0; i < 2; i++) {
            await driver2.appendHistory(ns, key2, record(++written2), keep);
          }
        },
      );

      // The first 40 records of the history as it was: what the operator meant
      // to read. Six of them are trimmed away by the eight runs that start
      // during the walk, and nobody can show a record that no longer exists —
      // so the comparison is over the ones that survived.
      const meant = Array.from({ length: 40 }, (_, i) => id(i + 1));
      const survived = meant.slice(6);

      // THE CONTRAST. Offset steps over records as the window slides
      // backwards under it: this is the failure the cursor exists for, and if
      // it ever stops happening the test below stops meaning anything.
      const missedByOffset = survived.filter((run) => !byOffset.includes(run));
      // Two records per page turn, exactly the two the trim shifted the window
      // past: they were never claimed, never removed, and never shown.
      expect(missedByOffset).toEqual([11, 12, 23, 24, 35, 36].map(id));

      // And the cursor walk shows every one of them.
      expect(survived.filter((run) => !byCursor.includes(run))).toEqual([]);
      // No repeats either, which is the other half of a correct walk.
      expect(new Set(byCursor).size).toBe(byCursor.length);
    });

    it("keeps walking `asc` when the record the cursor names is trimmed away", async () => {
      const { driver, key } = await connect();
      const keep = 30;
      await seed(driver, key, 1, keep, keep);
      expect(
        (
          await readHistoryPage(driver, ns, key, {
            offset: 0,
            limit: 1,
            order: "asc",
          })
        ).total,
        "history must be FULL",
      ).toBe(keep);

      const first = await page(driver, key, { limit: 5, order: "asc" });
      expect(ids(first.records)).toEqual([1, 2, 3, 4, 5].map(id));
      // The cursor names run-005.
      expect(first.next).toEqual({
        startedAt: record(5).startedAt,
        runId: id(5),
      });

      // Eight runs start: run-001 … run-008 are trimmed, taking the record the
      // cursor names with them. A cursor that were a *position* would be lost
      // here; this one is a value, so the seek still knows where it was.
      for (let n = keep + 1; n <= keep + 8; n++) {
        await driver.appendHistory(ns, key, record(n), keep);
      }

      const second = await page(driver, key, {
        limit: 5,
        order: "asc",
        after: first.next!,
      });
      // Exactly the records after run-005 that survive: run-006 … run-008 went
      // with the trim, so the walk resumes at run-009 and skips nothing that
      // is still there.
      expect(ids(second.records)).toEqual([9, 10, 11, 12, 13].map(id));
      expect(second.offset).toBe(0);
    });

    it("ends a `desc` walk the trim has overtaken, rather than repeating rows", async () => {
      const { driver, key } = await connect();
      const keep = 20;
      await seed(driver, key, 1, keep, keep);

      const first = await page(driver, key, { limit: 5, order: "desc" });
      expect(ids(first.records)).toEqual([20, 19, 18, 17, 16].map(id));

      // Eighteen runs start, so run-001 … run-018 go. `desc` walks toward the
      // old end and the trim is eating that end: everything between the cursor
      // (run-016) and what survives (run-019, run-020 — already shown) is
      // gone. The walk ends. **This is irreducible** — the records the walk
      // had not reached no longer exist — and it is the one case the cursor
      // does not fix. An offset walk in the same place answers a second page
      // of rows it has already shown.
      for (let n = keep + 1; n <= keep + 18; n++) {
        await driver.appendHistory(ns, key, record(n), keep);
      }

      const second = await page(driver, key, {
        limit: 5,
        order: "desc",
        after: first.next!,
      });
      expect(second.records).toEqual([]);
      expect(second.next).toBeNull();
      expect(second.offset).toBe(second.total);

      // What offset does instead, from the same state: rows 5..9 of a list
      // that has shifted by 18 — all of them already shown.
      const byOffset = await readHistoryPage(driver, ns, key, {
        offset: 5,
        limit: 5,
        order: "desc",
      });
      expect(
        ids(byOffset.records).every((run) => ids(first.records).includes(run)),
      ).toBe(false);
    });

    it("seeks past a record that was removed rather than trimmed", async () => {
      const { driver, key } = await connect();
      await seed(driver, key, 1, 10);

      const first = await page(driver, key, { limit: 4, order: "desc" });
      expect(ids(first.records)).toEqual([10, 9, 8, 7].map(id));

      // The whole history goes and comes back without run-007 — a clear, or a
      // retention pass, removing the very record the cursor names. The seek
      // compares values, so it never needed it to still be there.
      await driver.clearHistory(ns, key);
      for (const n of [1, 2, 3, 4, 5, 6, 8, 9, 10]) {
        await driver.appendHistory(ns, key, record(n), 1000);
      }

      const second = await page(driver, key, {
        limit: 4,
        order: "desc",
        after: first.next!,
      });
      expect(ids(second.records)).toEqual([6, 5, 4, 3].map(id));
    });

    it("breaks ties between runs that started in the same millisecond", async () => {
      const { driver, key } = await connect();
      // Four runs sharing one `startedAt`: a parallel runner's records, which
      // `startedAt` alone cannot order. The run id is what makes the key
      // total, and the seek resolves the anchor by identity while it is still
      // there, so ties cannot repeat or skip a row either way.
      const same = 1_700_000_500_000;
      for (const n of [1, 2, 3, 4]) {
        await driver.appendHistory(ns, key, record(n, same), 1000);
      }

      const asc = await walk(driver, key, "asc", 2);
      const desc = await walk(driver, key, "desc", 2);
      expect(asc.seen).toHaveLength(4);
      expect(desc.seen).toHaveLength(4);
      expect(new Set(asc.seen).size).toBe(4);
      expect(new Set(desc.seen).size).toBe(4);
      expect(asc.seen).toEqual(desc.seen.toReversed());
    });

    it("resolves the anchor by identity, not by text quoting a run id", async () => {
      const { driver, key } = await connect();
      // A record whose *result* carries a `runId` field of its own, so the
      // stored JSON holds the literal text `"runId":"run-002"` outside the
      // record's own id — a string value could not do this, because
      // `JSON.stringify` escapes its quotes, but a nested object key can. The
      // Redis seek scans the encoded entries with a plain string search for
      // speed, so without the decode that confirms the hit this record is
      // taken for run-002 and the walk resumes in the wrong place.
      // `redis-history-match.test.ts` is the same family of bug, found in
      // `UPDATE_HISTORY`.
      for (const n of [1, 2, 3, 4]) {
        await driver.appendHistory(ns, key, record(n), 1000);
      }
      await driver.appendHistory(
        ns,
        key,
        { ...record(5), result: { runId: id(2) } },
        1000,
      );

      const asc = await walk(driver, key, "asc", 2);
      expect(asc.seen).toEqual([1, 2, 3, 4, 5].map(id));
    });

    it("ignores `offset` when a cursor is given", async () => {
      const { driver, key } = await connect();
      await seed(driver, key, 1, 20);

      const first = await page(driver, key, { limit: 5, order: "desc" });
      const second = await readHistoryPage(driver, ns, key, {
        // A nonsense offset that would land on a completely different page.
        offset: 15,
        limit: 5,
        order: "desc",
        after: first.next!,
      });
      expect(ids(second.records)).toEqual([15, 14, 13, 12, 11].map(id));
      expect(second.offset).toBe(5);
    });
  });
}

/* ------------------------------------------------------------------ *
 * The cursor's encoding — backend-independent, so once.
 * ------------------------------------------------------------------ */

describe("history cursor encoding", () => {
  const walk = { ns: "acme", runner: "nightly", order: "desc" } as const;
  const key = { startedAt: 1_700_000_000_000, runId: "run-007" };

  it("round-trips a key through an opaque, prefixed cursor", () => {
    const cursor = encodeHistoryCursor(walk, key);
    expect(cursor.startsWith("rh1.")).toBe(true);
    // Opaque to a client, but not a secret: it holds only what the response
    // already showed, and nothing here is signed.
    expect(cursor).not.toContain("run-007");
    expect(decodeHistoryCursor(cursor, walk)).toEqual(key);
  });

  it("refuses a cursor from another runner, another order or another namespace", () => {
    const cursor = encodeHistoryCursor(walk, key);
    for (const other of [
      { ...walk, runner: "hourly" },
      { ...walk, order: "asc" as const },
      { ...walk, ns: "other" },
    ]) {
      expect(() => decodeHistoryCursor(cursor, other)).toThrow(
        /belongs to another walk/,
      );
    }
  });

  it("refuses a cursor that is malformed, truncated or from another route", () => {
    for (const bad of [
      "",
      "nonsense",
      "rh1.",
      "rh1.!!!!",
      `rh1.${Buffer.from('{"v":1}').toString("base64url")}`,
      // A well-formed cursor of another kind: the apply-defaults walk's.
      `ja1.${Buffer.from(JSON.stringify({ v: 1, k: "runHistory", w: [], p: [] })).toString("base64url")}`,
      // Right prefix, wrong key types — a string where a `startedAt` belongs.
      `rh1.${Buffer.from(
        JSON.stringify({
          v: 1,
          k: "runHistory",
          w: ["acme", "nightly", "desc"],
          p: ["nope", "run-007"],
        }),
      ).toString("base64url")}`,
    ]) {
      expect(() => decodeHistoryCursor(bad, walk), bad).toThrow(
        /not one this walk issued/,
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * The fallback for a driver that does not seek.
 * ------------------------------------------------------------------ */

describe("history cursor fallback", () => {
  const history = Array.from({ length: 6 }, (_, i) => record(6 - i));

  it("seeks for a driver with no `pageHistory` at all", async () => {
    const page = await readHistoryPage(
      { listHistory: async () => history },
      "ns",
      "key",
      {
        offset: 0,
        limit: 2,
        order: "asc",
        after: { startedAt: record(2).startedAt, runId: "run-002" },
      },
    );
    expect(ids(page.records)).toEqual(["run-003", "run-004"]);
    expect(page.offset).toBe(2);
    expect(page.total).toBe(6);
  });

  it("discards a page from a `pageHistory` that ignored the cursor", async () => {
    let paged = 0;
    // A driver from before cursors existed: it slices by offset and says
    // nothing about where it landed. Answering its page-one would look exactly
    // like the end of the list to a walking client, so the page is thrown away
    // and the history read whole instead.
    const page = await readHistoryPage(
      {
        listHistory: async () => history,
        pageHistory: async (_ns, _key, opts) => {
          paged += 1;
          return {
            records: history.slice(opts.offset, opts.offset + opts.limit),
            total: history.length,
          };
        },
      },
      "ns",
      "key",
      {
        offset: 0,
        limit: 2,
        order: "desc",
        after: { startedAt: record(5).startedAt, runId: "run-005" },
      },
    );
    expect(paged).toBe(1);
    expect(ids(page.records)).toEqual(["run-004", "run-003"]);
    expect(page.offset).toBe(2);
  });

  it("uses such a driver's page unchanged when no cursor is given", async () => {
    const page = await readHistoryPage(
      {
        listHistory: async () => {
          throw new Error("must not read the history whole");
        },
        pageHistory: async (_ns, _key, opts) => ({
          records: history.slice(opts.offset, opts.offset + opts.limit),
          total: history.length,
        }),
      },
      "ns",
      "key",
      { offset: 2, limit: 2, order: "desc" },
    );
    expect(ids(page.records)).toEqual(["run-004", "run-003"]);
    // The offset it was asked for, filled in on its behalf.
    expect(page.offset).toBe(2);
  });

  it("is the same seek the shared helper does", () => {
    // `pageRunHistory` is what three drivers delegate to and what the fallback
    // uses, so the two paths above are one implementation.
    expect(
      ids(
        pageRunHistory(history, {
          offset: 99,
          limit: 3,
          order: "asc",
          after: { startedAt: record(1).startedAt, runId: "run-001" },
        }).records,
      ),
    ).toEqual(["run-002", "run-003", "run-004"]);
  });
});
