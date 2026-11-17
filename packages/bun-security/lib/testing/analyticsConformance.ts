/**
 * The security store kit's analytics cases (README §8, storage.md §3.1, §9),
 * registered by `runSecurityStoreConformance` for a driver whose
 * `capabilities.analytics` is set: event batches stored once, event pages
 * and filters, counters added by upsert, series and top-K, rollups that
 * count each bucket once and carry a late row up, retention that never
 * deletes what is not rolled up, concurrent writers, and refused input.
 */
import type {
  CounterRow,
  EventListQuery,
  SecurityEvent,
  SecurityStoreDriver,
} from "../store/types";
import { describe, expect, test } from "bun:test";

/** Runs a case on a fresh store. */
export type WithStore = (
  body: (store: SecurityStoreDriver) => Promise<void>,
) => Promise<void>;

/** An analytics-capable store: every analytics operation present. */
type AnalyticsStore = SecurityStoreDriver &
  Required<
    Pick<
      SecurityStoreDriver,
      | "appendEvents"
      | "addCounters"
      | "listEvents"
      | "series"
      | "topK"
      | "rollup"
      | "deleteBefore"
    >
  >;

/** The store, with its analytics operations asserted present. */
function analytics(store: SecurityStoreDriver): AnalyticsStore {
  for (const operation of [
    "appendEvents",
    "addCounters",
    "listEvents",
    "series",
    "topK",
    "rollup",
    "deleteBefore",
  ] as const) {
    if (typeof store[operation] !== "function") {
      throw new TypeError(
        `${store.name} advertises analytics but has no ${operation}()`,
      );
    }
  }
  return store as AnalyticsStore;
}

/** A minute. */
const MINUTE = 60_000;
/** An hour. */
const HOUR = 3_600_000;
/** A day. */
const DAY = 86_400_000;
/** A fixed day's start, so buckets are known: 2026-11-17T00:00Z. */
const T0 = Date.UTC(2026, 10, 17);

/** Whether `run` rejects. */
async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

/** An event, with defaults. */
function event(
  id: string,
  at: number,
  extra: Partial<SecurityEvent> = {},
): SecurityEvent {
  return { id, at, service: "api", action: "block", rule: "r1", ...extra };
}

/** Every event of a walk, page by page. */
async function walkEvents(
  store: AnalyticsStore,
  query: Omit<EventListQuery, "cursor">,
): Promise<SecurityEvent[]> {
  const seen: SecurityEvent[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 1_000; pages++) {
    const page = await store.listEvents({ ...query, cursor });
    seen.push(...page.items);
    if (page.next === undefined) return seen;
    cursor = page.next;
  }
  throw new Error("the walk never ended");
}

/** A minute counter row of `api`. */
function row(
  metric: string,
  at: number,
  value: number,
  dims?: Record<string, string>,
  service = "api",
): CounterRow {
  return {
    service,
    metric,
    at,
    value,
    ...(dims === undefined ? {} : { dims }),
  };
}

/**
 * How long one analytics case may take, ms. A case makes from a few to a
 * few dozen transactions, some racing for the analytics lock: well under a
 * second on an idle server, and several on a loaded one, past bun:test's
 * 5 s default (measured at a load of 55 on 16 cores).
 */
const CASE_TIMEOUT_MS = 30_000;

/** A case with {@link CASE_TIMEOUT_MS}. */
function check(name: string, body: () => Promise<void>): void {
  test(name, body, CASE_TIMEOUT_MS);
}

/** Registers the analytics cases. */
export function analyticsConformance(withStore: WithStore): void {
  describe("analytics (README §8)", () => {
    check(
      "a batch is stored once: a resent batch id writes no event and no counter",
      async () => {
        await withStore(async (raw) => {
          const store = analytics(raw);
          const events = [
            event("e1", T0 + 1_000, {
              subjects: { ip: "203.0.113.7", username: "h:abc" },
              rules: ["r1", "r2"],
              country: "NG",
              asn: 64_500,
              latencyMs: 0.25,
              status: 403,
              route: "POST /login",
              sample: {
                headers: { "user-agent": "x" },
                nested: [1, { a: null }],
              },
            }),
            event("e2", T0 + 2_000, { action: "challenge" }),
          ];
          const counters = [row("requests", T0, 5, { action: "block" })];
          expect(await store.appendEvents("b1", events, counters)).toEqual({
            duplicate: false,
          });
          expect(await store.appendEvents("b1", events, counters)).toEqual({
            duplicate: true,
          });
          // Another batch repeating an event id: the event is skipped, the batch kept.
          expect(
            await store.appendEvents("b2", [
              event("e1", T0 + 9_000),
              event("e3", T0 + 3_000),
            ]),
          ).toEqual({ duplicate: false });
          const page = await store.listEvents({ limit: 10 });
          expect(page.items.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
          expect(page.items[2]).toEqual(events[0]);
          const [total] = await store.series({
            metric: "requests",
            from: T0,
            to: T0 + MINUTE,
          });
          expect(total?.value).toBe(5);
        });
      },
    );

    check("events are filtered by every indexed field", async () => {
      await withStore(async (raw) => {
        const store = analytics(raw);
        await store.appendEvents("b", [
          event("a", T0 + 1, {
            service: "api",
            subjects: { ip: "1.1.1.1", user: "u1" },
            country: "NG",
            asn: 1,
          }),
          event("b", T0 + 2, {
            service: "web",
            action: "challenge",
            rule: "r2",
            route: "GET /",
            subjects: { apiKey: "k1" },
          }),
          event("c", T0 + 3, {
            dryRun: true,
            action: "log",
            subjects: { username: "h:1" },
          }),
          event("d", T0 + 4, {
            asn: 2,
            country: "GH",
            subjects: { ip: "2.2.2.2" },
          }),
        ]);
        const ids = async (
          query: Omit<EventListQuery, "limit">,
        ): Promise<string[]> =>
          (
            await store.listEvents({ limit: 100, direction: "asc", ...query })
          ).items.map((e) => e.id);
        expect(await ids({})).toEqual(["a", "b", "c", "d"]);
        expect(await ids({ service: "web" })).toEqual(["b"]);
        expect(await ids({ from: T0 + 2, to: T0 + 4 })).toEqual(["b", "c"]);
        expect(await ids({ action: "block" })).toEqual(["a", "d"]);
        expect(await ids({ rule: "r2" })).toEqual(["b"]);
        expect(await ids({ route: "GET /" })).toEqual(["b"]);
        expect(await ids({ ip: "2.2.2.2" })).toEqual(["d"]);
        expect(await ids({ user: "u1" })).toEqual(["a"]);
        expect(await ids({ apiKey: "k1" })).toEqual(["b"]);
        expect(await ids({ username: "h:1" })).toEqual(["c"]);
        expect(await ids({ country: "GH" })).toEqual(["d"]);
        expect(await ids({ asn: 1 })).toEqual(["a"]);
        expect(await ids({ dryRun: true })).toEqual(["c"]);
        expect(await ids({ dryRun: false, service: "api" })).toEqual([
          "a",
          "d",
        ]);
        expect(await ids({ service: "nope" })).toEqual([]);
      });
    });

    for (const direction of ["desc", "asc"] as const) {
      check(
        `walks events ${direction}, each once, ties on time broken by id`,
        async () => {
          await withStore(async (raw) => {
            const store = analytics(raw);
            const all = Array.from({ length: 23 }, (_, i) =>
              event(`e${String(i).padStart(2, "0")}`, T0 + Math.floor(i / 3), {
                action: i % 2 === 0 ? "block" : "challenge",
              }),
            );
            await store.appendEvents("b", all);
            const seen = await walkEvents(store, {
              limit: 4,
              direction,
              action: "block",
            });
            const expected = all
              .filter((e) => e.action === "block")
              .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
            if (direction === "desc") expected.reverse();
            expect(seen.map((e) => e.id)).toEqual(expected.map((e) => e.id));
          });
        },
      );
    }

    check(
      "an event cursor is bound to its walk: another filter or direction refuses it",
      async () => {
        await withStore(async (raw) => {
          const store = analytics(raw);
          await store.appendEvents("b", [
            event("a", T0),
            event("b", T0 + 1),
            event("c", T0 + 2),
          ]);
          const first = await store.listEvents({ limit: 1, action: "block" });
          expect(first.next).toBeString();
          expect(
            await rejects(() =>
              store.listEvents({ limit: 1, cursor: first.next }),
            ),
          ).toBe(true);
          expect(
            await rejects(() =>
              store.listEvents({
                limit: 1,
                action: "block",
                direction: "asc",
                cursor: first.next,
              }),
            ),
          ).toBe(true);
          expect(
            await rejects(() =>
              store.listEvents({ limit: 1, cursor: "se1.garbage" }),
            ),
          ).toBe(true);
          // The control: the same walk takes it.
          const second = await store.listEvents({
            limit: 1,
            action: "block",
            cursor: first.next,
          });
          expect(second.items.map((e) => e.id)).toEqual(["b"]);
        });
      },
    );

    check(
      "counters add by service, tier, bucket, metric and dims, in any order of dims",
      async () => {
        await withStore(async (raw) => {
          const store = analytics(raw);
          await store.addCounters([
            row("rules", T0 + 5_000, 2, { rule: "r1", action: "block" }),
            row("rules", T0 + 50_000, 3, { action: "block", rule: "r1" }),
            row("rules", T0 + MINUTE, 7, { rule: "r1", action: "block" }),
            row("rules", T0, 1, { rule: "r2", action: "log" }),
            row("rules", T0, 4, { rule: "r1", action: "block" }, "web"),
          ]);
          await store.addCounters([
            row("rules", T0, 10, { rule: "r1", action: "block" }),
          ]);
          expect(
            await store.series({
              service: "api",
              metric: "rules",
              from: T0,
              to: T0 + 2 * MINUTE,
            }),
          ).toEqual([
            { at: T0, dims: { action: "block", rule: "r1" }, value: 15 },
            { at: T0, dims: { action: "log", rule: "r2" }, value: 1 },
            {
              at: T0 + MINUTE,
              dims: { action: "block", rule: "r1" },
              value: 7,
            },
          ]);
          // Every service summed, and a partial match on the dims.
          expect(
            await store.series({
              metric: "rules",
              from: T0,
              to: T0 + MINUTE,
              dims: { rule: "r1" },
            }),
          ).toEqual([
            { at: T0, dims: { action: "block", rule: "r1" }, value: 19 },
          ]);
          // A range of a day reads the hourly tier by default: nothing rolled up yet.
          expect(
            await store.series({ metric: "rules", from: T0, to: T0 + DAY }),
          ).toEqual([]);
        });
      },
    );

    check(
      "dims match whole values: a wildcard or a prefix in a value never widens it",
      async () => {
        await withStore(async (raw) => {
          const store = analytics(raw);
          await store.addCounters([
            row("m", T0, 1, { route: "a_c" }),
            row("m", T0, 2, { route: "abc" }),
            row("m", T0, 4, { route: "a%" }),
            row("m", T0, 8, { route: "a" }),
            row("m", T0, 16, { route: "x&route=a", other: "=" }),
          ]);
          const value = async (route: string): Promise<number[]> =>
            (
              await store.series({
                metric: "m",
                from: T0,
                to: T0 + MINUTE,
                dims: { route },
              })
            ).map((p) => p.value);
          expect(await value("a_c")).toEqual([1]);
          expect(await value("a%")).toEqual([4]);
          expect(await value("a")).toEqual([8]);
          expect(await value("x&route=a")).toEqual([16]);
          expect(
            (
              await store.series({
                metric: "m",
                from: T0,
                to: T0 + MINUTE,
                dims: { other: "=" },
              })
            )[0]?.dims,
          ).toEqual({ other: "=", route: "x&route=a" });
        });
      },
    );

    check(
      "a services filter reads a set of services: their sum, their events, none for []",
      async () => {
        await withStore(async (raw) => {
          const store = analytics(raw);
          await store.appendEvents(
            "b",
            ["a", "b", "c"].map((service, i) =>
              event(`e${i}`, T0 + i, { service }),
            ),
            ["a", "b", "c"].map((service, i) =>
              row("requests", T0, i + 1, undefined, service),
            ),
          );
          const sum = async (services: string[]): Promise<number[]> =>
            (
              await store.series({
                metric: "requests",
                from: T0,
                to: T0 + MINUTE,
                services,
              })
            ).map((p) => p.value);
          expect(await sum(["a", "c"])).toEqual([1 + 3]);
          expect(await sum([])).toEqual([]);
          expect(
            (
              await store.topK({
                metric: "requests",
                from: T0,
                to: T0 + MINUTE,
                services: ["b"],
                limit: 5,
              })
            )[0]?.value,
          ).toBe(2);
          const ids = async (services: string[]): Promise<string[]> =>
            (
              await store.listEvents({ limit: 10, direction: "asc", services })
            ).items.map((e) => e.id);
          expect(await ids(["c", "a"])).toEqual(["e0", "e2"]);
          expect(
            (await store.listEvents({ limit: 10, id: "e1" })).items.map(
              (e) => e.service,
            ),
          ).toEqual(["b"]);
          expect(await ids([])).toEqual([]);
          // A cursor is bound to its set.
          const first = await store.listEvents({
            limit: 1,
            services: ["a", "b"],
          });
          expect(
            await rejects(() =>
              store.listEvents({
                limit: 1,
                services: ["a"],
                cursor: first.next,
              }),
            ),
          ).toBe(true);
          expect(
            (
              await store.listEvents({
                limit: 1,
                services: ["b", "a"],
                cursor: first.next,
              })
            ).items,
          ).toHaveLength(1);
          expect(
            await rejects(() =>
              store.series({
                metric: "requests",
                from: T0,
                to: T0 + 1,
                services: Array.from({ length: 1_001 }, (_, i) => `s${i}`),
              }),
            ),
          ).toBe(true);
        });
      },
    );

    check(
      "top-K sums a range per dims, the largest first, ties by dims",
      async () => {
        await withStore(async (raw) => {
          const store = analytics(raw);
          await store.addCounters([
            row("top.refused", T0, 5, { kind: "ip", subject: "1.1.1.1" }),
            row("top.refused", T0 + MINUTE, 6, {
              kind: "ip",
              subject: "1.1.1.1",
            }),
            row("top.refused", T0, 9, { kind: "ip", subject: "2.2.2.2" }),
            row("top.refused", T0, 9, { kind: "ip", subject: "0.0.0.9" }),
            row("top.refused", T0, 50, { kind: "user", subject: "u" }),
            row("top.refused", T0 + 10 * MINUTE, 99, {
              kind: "ip",
              subject: "3.3.3.3",
            }),
          ]);
          expect(
            await store.topK({
              metric: "top.refused",
              from: T0,
              to: T0 + 5 * MINUTE,
              dims: { kind: "ip" },
              limit: 2,
            }),
          ).toEqual([
            { dims: { kind: "ip", subject: "1.1.1.1" }, value: 11 },
            { dims: { kind: "ip", subject: "0.0.0.9" }, value: 9 },
          ]);
        });
      },
    );

    check(
      "a rollup counts each bucket once, closed buckets only, and a late row is carried up",
      async () => {
        await withStore(async (raw) => {
          const store = analytics(raw);
          await store.addCounters([
            row("requests", T0 + 1 * MINUTE, 1, { action: "allow" }),
            row("requests", T0 + 59 * MINUTE, 2, { action: "allow" }),
            row("requests", T0 + HOUR + MINUTE, 4, { action: "allow" }),
            row("requests", T0 + 2 * HOUR, 8, { action: "allow" }),
          ]);
          // Until 2h30: hours 0 and 1 are closed; hour 2 is not.
          expect(
            await store.rollup("minute", "hour", T0 + 2 * HOUR + 30 * MINUTE),
          ).toBe(2);
          expect(
            await store.rollup("minute", "hour", T0 + 2 * HOUR + 30 * MINUTE),
          ).toBe(0);
          const hours = async (): Promise<[number, number][]> =>
            (
              await store.series({
                tier: "hour",
                metric: "requests",
                from: T0,
                to: T0 + DAY,
              })
            ).map((p) => [p.at - T0, p.value]);
          expect(await hours()).toEqual([
            [0, 3],
            [HOUR, 4],
          ]);
          // A late row for a rolled-up hour reaches it; one for an open hour waits.
          await store.addCounters([
            row("requests", T0 + 30 * MINUTE, 16, { action: "allow" }),
            row("requests", T0 + 2 * HOUR + 5 * MINUTE, 32, {
              action: "allow",
            }),
          ]);
          expect(await hours()).toEqual([
            [0, 19],
            [HOUR, 4],
          ]);
          expect(await store.rollup("minute", "hour", T0 + 3 * HOUR)).toBe(1);
          expect(await hours()).toEqual([
            [0, 19],
            [HOUR, 4],
            [2 * HOUR, 40],
          ]);
          // Hours into the day, and a late minute then reaches the day too.
          expect(await store.rollup("hour", "day", T0 + DAY)).toBe(1);
          await store.addCounters([
            row("requests", T0 + 10 * MINUTE, 64, { action: "allow" }),
          ]);
          const [day] = await store.series({
            tier: "day",
            metric: "requests",
            from: T0,
            to: T0 + DAY,
          });
          expect(day?.value).toBe(19 + 4 + 40 + 64);
          // The minutes themselves are untouched by the rollups.
          const minutes = await store.series({
            tier: "minute",
            metric: "requests",
            from: T0,
            to: T0 + 3 * HOUR,
          });
          expect(minutes.reduce((sum, p) => sum + p.value, 0)).toBe(
            1 + 2 + 4 + 8 + 16 + 32 + 64,
          );
        });
      },
    );

    check(
      "racing writers lose no increment, even across a rollup",
      async () => {
        await withStore(async (raw) => {
          const store = analytics(raw);
          const writes = Array.from({ length: 40 }, (_, i) =>
            store.addCounters([
              row("requests", T0 + (i % 5) * MINUTE, 1, { action: "allow" }),
            ]),
          );
          const rollups = Array.from({ length: 4 }, (_, i) =>
            store.rollup("minute", "hour", T0 + HOUR + i),
          );
          await Promise.all([...writes, ...rollups]);
          const [hour] = await store.series({
            tier: "hour",
            metric: "requests",
            from: T0,
            to: T0 + HOUR,
          });
          expect(hour?.value).toBe(40);
          const minutes = await store.series({
            metric: "requests",
            from: T0,
            to: T0 + HOUR,
          });
          expect(minutes.reduce((sum, p) => sum + p.value, 0)).toBe(40);
        });
      },
    );

    check(
      "retention deletes in bounded batches, and never a counter not yet rolled up",
      async () => {
        await withStore(async (raw) => {
          const store = analytics(raw);
          await store.appendEvents(
            "b",
            Array.from({ length: 5 }, (_, i) => event(`e${i}`, T0 + i)),
          );
          expect(await store.deleteBefore("events", T0 + 3, 2)).toBe(2);
          expect(await store.deleteBefore("events", T0 + 3, 2)).toBe(1);
          expect(await store.deleteBefore("events", T0 + 3, 2)).toBe(0);
          expect(
            (await store.listEvents({ limit: 10 })).items.map((e) => e.id),
          ).toEqual(["e4", "e3"]);

          await store.addCounters([
            row("m", T0, 1),
            row("m", T0 + HOUR, 1),
            row("m", T0 + 2 * HOUR, 1),
          ]);
          // Nothing is rolled up: no minute row may go.
          expect(await store.deleteBefore("minute", T0 + DAY, 100)).toBe(0);
          await store.rollup("minute", "hour", T0 + HOUR);
          expect(await store.deleteBefore("minute", T0 + DAY, 100)).toBe(1);
          const left = await store.series({
            tier: "minute",
            metric: "m",
            from: T0,
            to: T0 + 3 * HOUR,
          });
          expect(left.map((p) => p.at - T0)).toEqual([HOUR, 2 * HOUR]);
          expect(
            (
              await store.series({
                tier: "hour",
                metric: "m",
                from: T0,
                to: T0 + DAY,
              })
            )[0]?.value,
          ).toBe(1);
        });
      },
    );

    check("a batch id is forgotten only by retention", async () => {
      await withStore(async (raw) => {
        const store = analytics(raw);
        expect((await store.appendEvents("b", [])).duplicate).toBe(false);
        expect((await store.appendEvents("b", [])).duplicate).toBe(true);
        expect(
          await store.deleteBefore("batches", Number.MAX_SAFE_INTEGER, 10),
        ).toBe(1);
        expect((await store.appendEvents("b", [])).duplicate).toBe(false);
      });
    });

    check("refuses malformed input", async () => {
      await withStore(async (raw) => {
        const store = analytics(raw);
        const refused = [
          () => store.addCounters([row("Bad Metric", T0, 1)]),
          () => store.addCounters([row("m", T0, -1)]),
          () => store.addCounters([row("m", T0, 1.5)]),
          () =>
            store.addCounters([{ ...row("m", T0, 1), tier: "week" as never }]),
          () =>
            store.addCounters([
              row(
                "m",
                T0,
                1,
                Object.fromEntries(
                  Array.from({ length: 9 }, (_, i) => [`d${i}`, "x"]),
                ),
              ),
            ]),
          () => store.addCounters([row("m", T0, 1, { "bad name": "x" })]),
          () => store.appendEvents("", []),
          () => store.appendEvents("b", [{ ...event("e", T0), id: "" }]),
          () => store.appendEvents("b", [{ ...event("e", T0), sample: 1n }]),
          () =>
            store.appendEvents("b", [
              { ...event("e", T0), subjects: { phone: "x" } as never },
            ]),
          () => store.listEvents({ limit: 0 }),
          () => store.series({ metric: "m", from: T0 + 1, to: T0 }),
          () => store.topK({ metric: "m", from: T0, to: T0 + 1, limit: 0 }),
          () => store.rollup("hour", "minute", T0),
          () => store.rollup("minute", "day", T0),
          () => store.deleteBefore("audit" as never, T0, 1),
          () => store.deleteBefore("events", T0, 0),
        ];
        for (const run of refused) expect(await rejects(run)).toBe(true);
        // Nothing of a refused batch was written.
        expect((await store.listEvents({ limit: 10 })).items).toEqual([]);
        expect((await store.appendEvents("b", [])).duplicate).toBe(false);
      });
    });
  });
}
