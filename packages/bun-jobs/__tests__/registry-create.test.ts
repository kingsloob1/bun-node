import type { BunQueue, Job, JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  BunJobs,
  ConfigError,
  createDriver,
  JobDraft,
  MemoryDriver,
} from "../lib/index";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * `jobs.create(name, data)`: a job described in Agenda's shape and written
 * only when it is saved.
 *
 * Every case checks what `save()` handed back *and* what the backend stored,
 * against every backend with a server configured plus memory — a draft that
 * returned a plausible job while writing something else would pass a test that
 * looked at only the first.
 */

const cleanups: (() => Promise<void>)[] = [];
const servers = await crossProcessBackends({ cleanups });

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/** A backend every case runs against. */
interface Backend {
  /** What the describe block is called. */
  name: string;
  /** Whether it can be reached; an unreachable one is skipped, visibly. */
  available: boolean;
  /** Builds a driver for it. */
  make: () => JobsDriver;
}

const backends: Backend[] = [
  { name: "memory", available: true, make: () => new MemoryDriver() },
  ...servers.map((server) => ({
    name: server.name,
    available: server.available,
    make: () => createDriver(server.config),
  })),
];

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** How many jobs the queue holds, in any state. */
async function total(
  queue: BunQueue<unknown, unknown, string>,
): Promise<number> {
  const counts = await queue.count();
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** What a promise rejected with, or `undefined` if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

for (const backend of backends) {
  describe.skipIf(!backend.available)(`jobs.create: ${backend.name}`, () => {
    let driver: JobsDriver;
    let jobs: BunJobs;
    /** The registry's queue, where a saved draft lands. */
    let queue: BunQueue<unknown, unknown, string>;

    beforeAll(async () => {
      driver = backend.make();
      await driver.connect();
    });

    afterAll(async () => {
      await driver.close();
    });

    beforeEach(() => {
      jobs = new BunJobs({
        namespace: testNamespace("create"),
        driver,
        logger: noopLogger,
        // The context's defaults, under the definition's and the draft's.
        defaultJobOptions: { keepStacktraces: 9 },
      });
      jobs.define("mail", async () => null, {
        attempts: 5,
        priority: 3,
        timeout: 1_000,
      });
      queue = jobs.queue("jobs");
    });

    afterEach(async () => {
      await jobs.purge().catch(() => {});
      await jobs.close();
    });

    describe("describing", () => {
      it("writes nothing until saved, then exactly what was described", async () => {
        const draft = jobs.create("mail", { to: "ops" }).priority(1);

        expect(draft).toBeInstanceOf(JobDraft);
        expect(draft.name).toBe("mail");
        expect(draft.isSaved).toBe(false);
        expect(draft.job).toBeUndefined();
        expect(await total(queue)).toBe(0);

        const job = await draft.save();

        expect(draft.isSaved).toBe(true);
        expect(draft.job).toBe(job);
        expect(job.wasAdded).toBe(true);

        const stored = await queue.getJob(job.id);
        for (const view of [job, stored!]) {
          expect(view.name).toBe("mail");
          expect(view.data).toEqual({ to: "ops" });
          expect(view.state).toBe("waiting");
          expect(view.opts.priority).toBe(1);
        }
        expect(await total(queue)).toBe(1);
      });

      it("sends every setter through to the stored job", async () => {
        const before = Date.now();
        const job = await jobs
          .create("mail", { to: "first" })
          .withData({ to: "second" })
          .jobId("all-setters")
          .priority(4)
          .attempts(7)
          .backoff({ type: "fixed", delay: 500 })
          .timeout("30 seconds")
          .removeOnComplete({ count: 5 })
          .removeOnFail(2)
          .keepStacktraces(2)
          .keepLogs(10)
          .deadLetter("mail-dead")
          .delay("5 minutes")
          .save();
        const after = Date.now();

        const stored = await queue.getJob("all-setters");
        expect(stored).not.toBeNull();

        for (const view of [job, stored!]) {
          expect(view.id).toBe("all-setters");
          expect(view.data).toEqual({ to: "second" });
          expect(view.state).toBe("delayed");
          expect(view.runAt).toBeGreaterThanOrEqual(before + 5 * 60_000);
          expect(view.runAt).toBeLessThanOrEqual(after + 5 * 60_000);
          expect(view.opts).toMatchObject({
            priority: 4,
            attempts: 7,
            backoff: { type: "fixed", delay: 500 },
            timeout: 30_000,
            removeOnComplete: { count: 5 },
            removeOnFail: 2,
            keepStacktraces: 2,
            keepLogs: 10,
            deadLetter: "mail-dead",
          });
        }
      });

      it("takes the same description as one object", async () => {
        const job = await jobs
          .create("mail")
          .withOptions({ unique: "as-object", priority: 6, in: "1 hour" })
          .save();

        const stored = await queue.getJob("as-object");
        for (const view of [job, stored!]) {
          expect(view.opts.priority).toBe(6);
          expect(view.state).toBe("delayed");
        }
      });

      it("treats unique as the idempotency key across drafts", async () => {
        const first = await jobs.create("mail", { n: 1 }).unique("once").save();
        const second = await jobs.create("mail", { n: 2 }).jobId("once").save();

        expect(first.wasAdded).toBe(true);
        expect(second.wasAdded).toBe(false);
        expect(second.id).toBe("once");
        // The stored job, untouched by the second draft.
        expect(second.data).toEqual({ n: 1 });
        expect(await total(queue)).toBe(1);
      });

      it("schedules at a Date, epoch milliseconds or words, over any delay", async () => {
        const at = Date.now() + HOUR;

        const byDate = await jobs.create("mail").schedule(new Date(at)).save();
        const byMs = await jobs
          .create("mail")
          .schedule(at + 1)
          .save();
        const before = Date.now();
        const byWords = await jobs
          .create("mail")
          .schedule("in 20 minutes")
          .save();
        // `runAt` wins over `delay` whichever was said first, as in JobOptions.
        const delayFirst = await jobs
          .create("mail")
          .delay(1_000)
          .schedule(at + 2)
          .save();
        const delayLast = await jobs
          .create("mail")
          .schedule(at + 3)
          .delay(1_000)
          .save();

        const expected: [Job<unknown, unknown>, number][] = [
          [byDate, at],
          [byMs, at + 1],
          [delayFirst, at + 2],
          [delayLast, at + 3],
        ];
        for (const [job, runAt] of expected) {
          expect(job.state).toBe("delayed");
          expect(job.runAt).toBe(runAt);
          expect((await queue.getJob(job.id))?.runAt).toBe(runAt);
        }

        expect(byWords.runAt).toBeGreaterThanOrEqual(before + 20 * 60_000);
        expect(byWords.runAt).toBeLessThan(before + 21 * 60_000);
      });

      it("lets the last schedule stand, phrase or instant", async () => {
        const at = Date.now() + 2 * HOUR;

        const job = await jobs
          .create("mail")
          .schedule("in 5 minutes")
          .schedule(new Date(at))
          .save();
        expect(job.runAt).toBe(at);

        // The same for where a series starts.
        const start = Date.now() + 3 * DAY;
        const series = await jobs
          .create("mail")
          .repeatEvery("1 day", { startAt: "in 5 minutes", key: "restated" })
          .repeatEvery("1 day", { startAt: start, key: "restated" })
          .save();
        expect(series.runAt).toBe(start);
      });

      it("starts a series at schedule(), in either order, where the queue would have ignored it", async () => {
        const at = Date.now() + 3 * DAY;

        const after = await jobs
          .create("mail")
          .repeatEvery("1 day", { key: "schedule-after" })
          .schedule(new Date(at))
          .save();
        const before = await jobs
          .create("mail")
          .schedule(at)
          .repeatEvery("1 day", { key: "schedule-before" })
          .save();

        const series = await queue.listRepeatables();
        for (const [job, key] of [
          [after, "schedule-after"],
          [before, "schedule-before"],
        ] as const) {
          expect(job.runAt).toBe(at);
          // A key the caller chose is stored namespaced, so it can never
          // equal a generated one.
          expect(series.find((record) => record.key === key)?.startAt).toBe(at);
        }

        // The same through the builder `schedule()` returns.
        const built = await jobs
          .schedule("mail")
          .every("1 day")
          .on(new Date(at))
          .withOptions({ repeatKey: "builder-on" })
          .start();
        expect(built.runAt).toBe(at);
      });

      it("reads a definition's runAt as where its series starts, below an explicit start", async () => {
        const at = Date.now() + 4 * DAY;
        const explicit = Date.now() + 6 * DAY;
        jobs.define("dated", async () => null, { runAt: at });

        const defaulted = await jobs
          .schedule("dated")
          .every("1 day")
          .withOptions({ repeatKey: "dated-default" })
          .start();
        const started = await jobs
          .create("dated")
          .repeatEvery("1 day", { key: "dated-explicit", startAt: explicit })
          .save();

        expect(defaulted.runAt).toBe(at);
        expect(started.runAt).toBe(explicit);

        const series = await queue.listRepeatables();
        expect(
          series.find((record) => record.key === "dated-default")?.startAt,
        ).toBe(at);
        expect(
          series.find((record) => record.key === "dated-explicit")?.startAt,
        ).toBe(explicit);
      });

      it("replaces the whole series description with each repeatEvery()", async () => {
        const start = Date.now() + 5 * DAY;

        await jobs
          .create("mail")
          .repeatEvery("1 day", {
            limit: 3,
            tz: "Europe/London",
            endAt: start + 30 * DAY,
            key: "replaced",
          })
          .repeatEvery("2 days", { key: "replaced" })
          .save();

        // A start given by an earlier repeatEvery() goes with it...
        await jobs
          .create("mail")
          .repeatEvery("1 day", { startAt: start, key: "start-dropped" })
          .repeatEvery("1 day", { key: "start-dropped" })
          .save();

        // ...but one given by schedule() is a separate statement, and stays.
        const kept = await jobs
          .create("mail")
          .schedule(start)
          .repeatEvery("1 day", { limit: 2, key: "start-kept" })
          .repeatEvery("2 days", { key: "start-kept" })
          .save();

        const series = await queue.listRepeatables();
        const replaced = series.find((record) => record.key === "replaced");
        expect(replaced?.every).toBe(2 * DAY);
        expect(replaced?.limit ?? undefined).toBeUndefined();
        expect(replaced?.tz ?? undefined).toBeUndefined();
        expect(replaced?.endAt ?? undefined).toBeUndefined();

        expect(
          series.find((record) => record.key === "start-dropped")?.startAt,
        ).not.toBe(start);

        expect(kept.runAt).toBe(start);
        const keptSeries = series.find((record) => record.key === "start-kept");
        expect(keptSeries?.startAt).toBe(start);
        expect(keptSeries?.limit ?? undefined).toBeUndefined();
      });

      it("lets the last start stand across every ordering of on() and startingAt()", async () => {
        /** One way of giving the builder a start. */
        type Say = (
          builder: ReturnType<typeof jobs.schedule>,
          days: number,
        ) => unknown;
        const ways: [string, Say][] = [
          ["on(phrase)", (b, days) => b.on(`in ${days} days`)],
          ["on(Date)", (b, days) => b.on(new Date(Date.now() + days * DAY))],
          ["startingAt(phrase)", (b, days) => b.startingAt(`in ${days} days`)],
          [
            "startingAt(Date)",
            (b, days) => b.startingAt(new Date(Date.now() + days * DAY)),
          ],
        ];

        let index = 0;
        for (const [firstName, first] of ways) {
          for (const [secondName, second] of ways) {
            const builder = jobs
              .schedule("mail")
              .every("1 day")
              .withOptions({ repeatKey: `order-${index++}` });
            first(builder, 5);
            second(builder, 9);

            const saidAt = Date.now();
            const job = await builder.start();

            // The second, later word: nine days out, not five.
            const days = (job.runAt - saidAt) / DAY;
            expect({
              order: `${firstName} then ${secondName}`,
              days: Math.round(days),
            }).toEqual({ order: `${firstName} then ${secondName}`, days: 9 });
          }
        }
      });

      it("lets the last start stand between the draft's schedule() and startAt, in every form", async () => {
        const forms: [string, (days: number) => Date | string][] = [
          ["phrase", (days) => `in ${days} days`],
          ["Date", (days) => new Date(Date.now() + days * DAY)],
        ];

        let index = 0;
        for (const [earlyForm, early] of forms) {
          for (const [lateForm, late] of forms) {
            const key = `draft-order-${index++}`;

            const scheduleLast = await jobs
              .create("mail")
              .repeatEvery("1 day", { key: `${key}-a`, startAt: early(5) })
              .schedule(late(9))
              .save();
            const startAtLast = await jobs
              .create("mail")
              .schedule(early(5))
              .repeatEvery("1 day", { key: `${key}-b`, startAt: late(9) })
              .save();

            for (const [label, job] of [
              ["schedule() last", scheduleLast],
              ["startAt last", startAtLast],
            ] as const) {
              expect({
                case: `${earlyForm} then ${lateForm}, ${label}`,
                days: Math.round((job.runAt - Date.now()) / DAY),
              }).toEqual({
                case: `${earlyForm} then ${lateForm}, ${label}`,
                days: 9,
              });
            }
          }
        }

        // And on a single job, phrase then instant and instant then phrase.
        const at = Date.now() + 2 * HOUR;
        const instantLast = await jobs
          .create("mail")
          .schedule("in 5 minutes")
          .schedule(new Date(at))
          .save();
        const phraseLast = await jobs
          .create("mail")
          .schedule(new Date(at))
          .schedule("in 5 minutes")
          .save();
        expect(instantLast.runAt).toBe(at);
        expect(Math.round((phraseLast.runAt - Date.now()) / 60_000)).toBe(5);
      });

      it("repeats on an interval or a cron expression, with the series options", async () => {
        const start = Date.now() + DAY;
        const end = start + 30 * DAY;

        const job = await jobs
          .create("mail", { r: 1 })
          .repeatEvery("2 days", {
            key: "every-2-days",
            limit: 3,
            startAt: start,
            endAt: end,
          })
          .save();

        expect(job.isRepeat).toBe(true);
        expect(job.repeatKey).toBe("every-2-days");
        expect(job.runAt).toBe(start);

        const series = (await queue.listRepeatables()).find(
          (record) => record.key === "every-2-days",
        );
        expect(series).toMatchObject({
          name: "mail",
          every: 2 * DAY,
          limit: 3,
          startAt: start,
          endAt: end,
        });
        // The definition's options reach every occurrence of the series.
        expect(series!.opts.attempts).toBe(5);

        const cron = await jobs
          .create("mail")
          .repeatEvery("0 9 * * 1", { tz: "Europe/London" })
          .save();
        expect(cron.repeatKey).toBe("mail|0 9 * * 1@Europe/London|");

        const immediate = await jobs
          .create("mail")
          .repeatEvery(60_000, { immediately: true, key: "immediate" })
          .save();
        expect(immediate.state).toBe("waiting");

        // On a series, unique names the series.
        const named = await jobs
          .create("mail")
          .unique("series-id")
          .repeatEvery("1 hour")
          .save();
        expect(named.repeatKey).toBe("series-id");
      });

      it("debounces and throttles through the queue's windows", async () => {
        const first = await jobs
          .create("mail", { v: 1 })
          .debounce("doc-1", "1 minute")
          .save();
        const second = await jobs
          .create("mail", { v: 2 })
          .debounce("doc-1", "1 minute")
          .save();

        expect(second.id).toBe(first.id);
        expect((await queue.getJob(first.id))?.data).toEqual({ v: 2 });

        const opened = await jobs
          .create("mail", { v: 1 })
          .throttle("t-1", 60_000)
          .save();
        const inside = await jobs
          .create("mail", { v: 2 })
          .throttle("t-1", 60_000)
          .save();

        expect(inside.id).toBe(opened.id);
        expect((await queue.getJob(opened.id))?.data).toEqual({ v: 1 });
        expect(await total(queue)).toBe(2);
      });

      it("says which setter could not read its argument", () => {
        const draft = jobs.create("mail");

        for (const [call, pattern] of [
          [() => draft.repeatEvery("whenever"), /repeatEvery\(\)/],
          [() => draft.delay("soonish"), /delay\(\)/],
          [() => draft.timeout("eventually"), /timeout\(\)/],
        ] as const) {
          expect(call).toThrow(ConfigError);
          expect(call).toThrow(pattern);
        }
      });
    });

    describe("defaults and validation", () => {
      it("puts the definition's options under the draft's, and the context's under both, as now() does", async () => {
        const drafted = await jobs.create("mail").priority(1).save();
        const viaNow = await jobs.now("mail", undefined, { priority: 1 });

        for (const job of [drafted, viaNow]) {
          const stored = await queue.getJob(job.id);
          for (const view of [job, stored!]) {
            // The draft's own word.
            expect(view.opts.priority).toBe(1);
            // The definition's, which the draft did not name.
            expect(view.opts.attempts).toBe(5);
            expect(view.opts.timeout).toBe(1_000);
            // The context's, which neither named.
            expect(view.opts.keepStacktraces).toBe(9);
          }
        }
        expect(drafted.opts).toEqual(viaNow.opts);

        // Saying nothing inherits the definition entirely.
        const bare = await jobs.create("mail").save();
        expect(bare.opts.priority).toBe(3);
      });

      it("refuses a name with no definition, as now() does", async () => {
        let thrown: unknown;
        try {
          jobs.create("neverDefined");
        } catch (error) {
          thrown = error;
        }

        const rejected = await rejection(jobs.now("neverDefined"));

        expect(thrown).toBeInstanceOf(ConfigError);
        expect(rejected).toBeInstanceOf(ConfigError);
        expect((thrown as Error).message).toBe((rejected as Error).message);
        expect(await total(queue)).toBe(0);
      });

      it("refuses a combination the queue refuses, at save, writing nothing", async () => {
        const drafts = [
          jobs.create("mail").repeatEvery("1 hour").debounce("d", 1_000),
          jobs.create("mail").repeatEvery("1 hour").throttle("d", 1_000),
          jobs.create("mail").debounce("d", 1_000).throttle("d", 1_000),
          jobs.create("mail").unique("u").debounce("d", 1_000),
          jobs.create("mail").unique("u").throttle("d", 1_000),
        ];

        for (const draft of drafts) {
          expect(await rejection(draft.save())).toBeInstanceOf(ConfigError);
          expect(draft.isSaved).toBe(false);
        }

        expect(await total(queue)).toBe(0);
        expect(await queue.listRepeatables()).toEqual([]);
      });
    });

    describe("dates read at save", () => {
      it("names schedule() and quotes the phrase when the date cannot be read", async () => {
        const draft = jobs.create("mail").schedule("the twelfth of Octember");

        // Nothing has been read yet: the phrase is parsed by `save()`, so
        // that "tomorrow" means tomorrow from the save.
        expect(draft.isSaved).toBe(false);

        const error = await rejection(draft.save());

        // Not `runAt could not be understood as a date` — a `JobOptions` name
        // the caller never wrote, from a call it did not make.
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toBe(
          'schedule() could not read "the twelfth of Octember" as a date',
        );
        expect(draft.isSaved).toBe(false);
        expect(await total(queue)).toBe(0);
      });

      it("leaves a readable phrase, and an unrelated failure, alone", async () => {
        const saved = await jobs.create("mail").schedule("in 2 hours").save();
        expect(saved.runAt).toBeGreaterThan(Date.now() + HOUR);

        // A different `ConfigError` from the same `save()` is not renamed.
        const other = jobs
          .create("mail")
          .schedule("in 2 hours")
          .unique("u")
          .debounce("d", 1_000);
        const error = await rejection(other.save());
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).not.toContain("schedule()");
      });
    });

    describe("series setters", () => {
      it("refuses one before repeatEvery(), writing nothing", async () => {
        for (const [call, pattern] of [
          [() => jobs.create("mail").limit(3), /limit\(\)/],
          [() => jobs.create("mail").tz("UTC"), /tz\(\)/],
          [() => jobs.create("mail").endingAt("in 2 days"), /endingAt\(\)/],
          [() => jobs.create("mail").catchUp(), /catchUp\(\)/],
          [() => jobs.create("mail").immediately(), /immediately\(\)/],
        ] as const) {
          expect(call).toThrow(ConfigError);
          expect(call).toThrow(pattern);
          expect(call).toThrow(/repeatEvery\(\)/);
        }

        expect(await total(queue)).toBe(0);
      });

      it("checks limit() and tz() in the setter, not at save()", async () => {
        const series = () => jobs.create("mail").repeatEvery("1 hour");

        // A limit is a whole number of occurrences, at least one.
        for (const bad of [0, -1, 1.5, Number.NaN]) {
          const call = () => series().limit(bad);
          expect(call, String(bad)).toThrow(ConfigError);
          expect(call, String(bad)).toThrow(/limit\(\)/);
        }

        // A zone is checked on an interval series too, where nothing would
        // otherwise read it until an occurrence was computed.
        const zone = () => series().tz("Mars/Olympus_Mons");
        expect(zone).toThrow(ConfigError);
        expect(zone).toThrow(/tz\(\) does not know the time zone/);

        // The controls: a good limit and a real zone go through.
        expect(() => series().limit(1).tz("Europe/London")).not.toThrow();
        expect(await total(queue)).toBe(0);
      });

      it("checks a zone given to repeatEvery() at the call, as tz() does", async () => {
        // Lagos is in Africa/: close enough to a real zone to pass a glance.
        for (const call of [
          () =>
            jobs.create("mail").repeatEvery("1 day", { tz: "Europe/Lagos" }),
          () =>
            jobs.schedule("mail").repeatEvery("1 day", { tz: "Europe/Lagos" }),
          () =>
            jobs
              .schedule("mail")
              .repeatEvery("0 9 * * *", { tz: "Europe/Lagos" }),
        ]) {
          let error: unknown;
          try {
            call();
          } catch (thrown) {
            error = thrown;
          }
          expect(error).toBeInstanceOf(ConfigError);
          expect((error as ConfigError).message).toBe(
            `repeatEvery() does not know the time zone "Europe/Lagos"`,
          );
          expect((error as ConfigError).context).toEqual({
            method: "repeatEvery()",
            tz: "Europe/Lagos",
          });
        }

        // The control: the real zone goes through, and is kept.
        await jobs
          .create("mail")
          .repeatEvery("1 day", { tz: "Africa/Lagos", key: "lagos" })
          .save();
        expect((await queue.listRepeatables())[0]?.tz).toBe("Africa/Lagos");
      });

      it("refuses a zone in withOptions({ repeat }) before anything is written", async () => {
        // A whole repeat object is taken as given at the call and read at
        // start(), where every repeat is normalised: the same check applies.
        const error = await rejection(
          jobs
            .schedule("mail")
            .withOptions({ repeat: { every: "1 day", tz: "Europe/Lagos" } })
            .start(),
        );
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toBe(
          `repeat.tz does not know the time zone "Europe/Lagos"`,
        );
        expect(await queue.listRepeatables()).toEqual([]);
        expect(await total(queue)).toBe(0);
      });

      it("guards the builder's limit() the same way", () => {
        // Without a series there is nothing to limit; spreading an absent one
        // used to invent `{ limit: 3 }`, a repeat with nothing to repeat.
        const bare = () => jobs.schedule("mail").limit(3);
        expect(bare).toThrow(ConfigError);
        expect(bare).toThrow(/limit\(\) sets one option of a repeating series/);

        expect(() =>
          jobs.schedule("mail").every("1 hour").limit(3),
        ).not.toThrow();
      });

      it("changes one field of the series, leaving the rest", async () => {
        await jobs
          .create("mail")
          .repeatEvery("1 hour", { limit: 9, tz: "UTC" })
          .limit(3)
          .catchUp(true)
          .save();

        // `limit` replaced; `tz` and `every` are still what `repeatEvery()`
        // gave — the setter changes one field, it does not rebuild the series.
        const [series] = await queue.listRepeatables();
        expect(series).toMatchObject({
          every: HOUR,
          limit: 3,
          tz: "UTC",
          catchUp: true,
        });
      });

      it("names endingAt() when its phrase cannot be read", async () => {
        const draft = jobs
          .create("mail")
          .repeatEvery("1 hour")
          .endingAt("the fifth of Octember");

        const error = await rejection(draft.save());

        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toBe(
          'endingAt() could not read "the fifth of Octember" as a date',
        );
      });

      it("is available after withOptions() described the series too", () => {
        // `withOptions({ every })` establishes a series just as `repeatEvery`
        // does, so the guard must see it — a flag set only by `repeatEvery()`
        // would reject this wrongly.
        expect(() =>
          jobs.create("mail").withOptions({ every: "2 days" }).limit(4),
        ).not.toThrow();
      });
    });

    describe("saving twice", () => {
      it("answers a second save with the same job and writes nothing", async () => {
        const draft = jobs.create("mail", { a: 1 });
        const first = await draft.save();

        const events: string[] = [];
        queue.on("added", (job) => events.push(`added:${job.id}`));
        queue.on("duplicate", (job) => events.push(`duplicate:${job.id}`));

        const again = await draft.save();

        expect(again).toBe(first);
        expect(events).toEqual([]);
        expect(await total(queue)).toBe(1);
      });

      it("adds one job when two saves of one draft race", async () => {
        const draft = jobs.create("mail", { a: 1 });
        const [a, b] = await Promise.all([draft.save(), draft.save()]);

        expect(a).toBe(b);
        expect(await total(queue)).toBe(1);
      });

      it("refuses to save a draft changed since it was saved", async () => {
        const draft = jobs.create("mail").priority(2);
        const job = await draft.save();

        draft.priority(9);
        const error = await rejection(draft.save());

        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toContain(job.id);
        // The stored job is as the first save left it, and there is one.
        expect((await queue.getJob(job.id))?.opts.priority).toBe(2);
        expect(await total(queue)).toBe(1);
      });

      it("refuses a save made while it was being saved, after a setter was called", async () => {
        const draft = jobs.create("mail");
        const saving = draft.save();
        draft.priority(7);

        // Joining the save in flight would hand back a job at priority 3 for a
        // draft that now says 7.
        const joined = await rejection(draft.save());
        expect(joined).toBeInstanceOf(ConfigError);
        expect((joined as Error).message).toContain("while it was being saved");

        const job = await saving;
        expect(job.opts.priority).toBe(3);
        expect(await total(queue)).toBe(1);
      });

      it("counts a setter called with the same value as a change", async () => {
        const draft = jobs.create("mail").priority(2);
        await draft.save();

        draft.priority(2);
        expect(await rejection(draft.save())).toBeInstanceOf(ConfigError);
      });

      it("counts an edit made while the save was in flight as a change", async () => {
        const draft = jobs.create("mail");
        const saving = draft.save();
        // Too late for the save above, which read the draft when it began.
        draft.priority(7);
        const job = await saving;

        expect(job.opts.priority).toBe(3);
        expect(await rejection(draft.save())).toBeInstanceOf(ConfigError);
      });

      it("lets a draft whose save failed be corrected and saved", async () => {
        const draft = jobs.create("mail").schedule("zzqx vbnm");
        const saving = draft.save();
        // An edit during a save that then fails is part of the next attempt.
        draft.priority(4);

        expect(await rejection(saving)).toBeInstanceOf(ConfigError);
        expect(draft.isSaved).toBe(false);
        expect(await total(queue)).toBe(0);

        const at = Date.now() + HOUR;
        const job = await draft.schedule(at).save();

        expect(job.runAt).toBe(at);
        expect(job.opts.priority).toBe(4);
        expect(draft.isSaved).toBe(true);
        expect(await total(queue)).toBe(1);

        // And, saved now, it saves again as any unchanged draft does: the
        // edit made during the failed attempt is not held against it.
        expect(await draft.save()).toBe(job);
      });
    });
  });
}
