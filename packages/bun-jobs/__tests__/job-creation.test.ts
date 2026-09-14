import type { BunQueue, JobsDriver, RepeatRecord } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunJobs, ConfigError, FileDriver, MemoryDriver } from "../lib/index";
import { readRecurrence } from "../lib/shared/humanTime";
import { makeJob, makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * Every way there is to create a job and put it on a queue.
 *
 * They are spread across four layers — the driver, `BunQueue`, the `BunJobs`
 * context, and the fluent builder with its method chain and its options
 * object — and each layer was tested where it was written, which leaves no
 * one place that says what the whole set is or that they agree. This is that
 * place.
 *
 * Every case checks two things: the job it was handed back, and the record
 * actually stored. A builder that returned a plausible `Job` and wrote
 * something different would pass a test that only looked at the first.
 *
 * It runs against the memory and file drivers, which need no server; the
 * driver contract suite already covers the rest of the backends at the layer
 * underneath.
 */

/** A backend to run every case against. */
interface Backend {
  /** What the describe block is called. */
  name: string;
  /** Builds a driver, and whatever removing it afterwards takes. */
  make: () => Promise<{ driver: JobsDriver; cleanup: () => Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "memory",
    make: async () => ({
      driver: new MemoryDriver(),
      cleanup: async () => {},
    }),
  },
  {
    name: "file",
    make: async () => {
      const tmp = await makeTmpDir("job-creation");
      return {
        driver: new FileDriver({ root: tmp.path }),
        cleanup: tmp.cleanup,
      };
    },
  },
];

/** A date's local calendar day, which is how chrono reads a phrase. */
function calendarDay(ms: number | undefined): [number, number, number] {
  const date = new Date(ms ?? Number.NaN);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
}

for (const backend of backends) {
  describe(`creating jobs: ${backend.name}`, () => {
    let driver: JobsDriver;
    let cleanup: () => Promise<void>;
    let jobs: BunJobs;
    /** The registry's queue, where `now`, `schedule`, `run` and `process` add. */
    let queue: BunQueue<unknown, unknown, string>;

    beforeEach(async () => {
      ({ driver, cleanup } = await backend.make());
      jobs = new BunJobs({
        namespace: testNamespace(),
        driver,
        logger: noopLogger,
      });

      jobs.define("mail", async () => null, { attempts: 3, priority: 2 });
      jobs.define("report", async () => null);
      queue = jobs.queue("jobs");
    });

    afterEach(async () => {
      await jobs.close();
      // Handed in as an instance, so the context leaves closing it to us.
      await driver.close();
      await cleanup();
    });

    /** The series a repeating job belongs to, as stored. */
    async function seriesOf(repeatKey: string | null): Promise<RepeatRecord> {
      const series = (await queue.listRepeatables()).find(
        (record) => record.key === repeatKey,
      );
      expect(series).toBeDefined();
      return series!;
    }

    /* --- 1. the driver ---------------------------------------------------- */

    describe("through the driver", () => {
      it("addJob stores one record", async () => {
        const ref = { ns: jobs.namespace, queue: "jobs" };
        const { job, added } = await driver.addJob(
          ref,
          makeJob({ id: "driver-one", name: "mail" }),
        );

        expect(added).toBe(true);
        expect(job.id).toBe("driver-one");
        expect((await queue.getJob("driver-one"))?.name).toBe("mail");
      });

      it("addJobs stores a batch, and says which were new", async () => {
        const ref = { ns: jobs.namespace, queue: "jobs" };
        await driver.addJob(ref, makeJob({ id: "driver-taken" }));

        const results = await driver.addJobs(ref, [
          makeJob({ id: "driver-a" }),
          makeJob({ id: "driver-taken" }),
          makeJob({ id: "driver-b" }),
        ]);

        expect(results.map((result) => result.added)).toEqual([
          true,
          false,
          true,
        ]);
        expect(await queue.count("waiting")).toBe(3);
      });
    });

    /* --- 2. BunQueue ------------------------------------------------------ */

    describe("through BunQueue", () => {
      it("add(name, data)", async () => {
        const job = await queue.add("mail", { to: "ops" });

        expect(job.wasAdded).toBe(true);
        expect(job.state).toBe("waiting");

        const stored = await queue.getJob(job.id);
        expect(stored?.name).toBe("mail");
        expect(stored?.data).toEqual({ to: "ops" });
      });

      it("add with a jobId is idempotent", async () => {
        const first = await queue.add("mail", { v: 1 }, { jobId: "fixed" });
        const again = await queue.add("mail", { v: 2 }, { jobId: "fixed" });

        expect(first.id).toBe("fixed");
        expect(again.wasAdded).toBe(false);
        // Ignored, not overwritten: the second call gets what is stored.
        expect(again.data).toEqual({ v: 1 });
        expect((await queue.getJob("fixed"))?.data).toEqual({ v: 1 });
      });

      it("add with a delay", async () => {
        const before = Date.now();
        const job = await queue.add("mail", {}, { delay: 60_000 });

        expect(job.state).toBe("delayed");
        expect(job.runAt).toBeGreaterThanOrEqual(before + 60_000);
        expect((await queue.getJob(job.id))?.state).toBe("delayed");
      });

      it("add with runAt as a Date or a timestamp", async () => {
        const at = Date.now() + 120_000;

        const byDate = await queue.add("mail", {}, { runAt: new Date(at) });
        const byNumber = await queue.add("mail", {}, { runAt: at });

        expect(byDate.runAt).toBe(at);
        expect(byNumber.runAt).toBe(at);
        expect((await queue.getJob(byNumber.id))?.state).toBe("delayed");
      });

      it("add with priority, attempts, backoff and timeout", async () => {
        const job = await queue.add(
          "mail",
          {},
          {
            priority: 7,
            attempts: 4,
            backoff: { type: "exponential", delay: 500 },
            timeout: 9_000,
          },
        );

        const stored = await queue.getJob(job.id);
        expect(stored?.priority).toBe(7);
        expect(stored?.maxAttempts).toBe(4);
        expect(stored?.opts.timeout).toBe(9_000);
        expect(stored?.opts.backoff).toMatchObject({ type: "exponential" });
      });

      it("add with repeat.every", async () => {
        const job = await queue.add(
          "report",
          {},
          { repeat: { every: 30_000 } },
        );

        expect(job.isRepeat).toBe(true);
        expect((await seriesOf(job.repeatKey)).every).toBe(30_000);
      });

      it("add with repeat.cron and a time zone", async () => {
        const job = await queue.add(
          "report",
          {},
          { repeat: { cron: "0 9 * * 1", tz: "Europe/London" } },
        );

        const series = await seriesOf(job.repeatKey);
        expect(series.cron).toBe("0 9 * * 1");
        expect(series.tz).toBe("Europe/London");
      });

      it("add with repeat.immediately runs the first occurrence now", async () => {
        const job = await queue.add(
          "report",
          {},
          { repeat: { every: 3_600_000, immediately: true } },
        );

        expect(job.runAt).toBeLessThanOrEqual(Date.now());
        expect(job.state).toBe("waiting");
      });

      it("add with repeat.every as a duration, a word, or cron", async () => {
        const duration = await queue.add(
          "report",
          {},
          { repeat: { every: "every 2 days" } },
        );
        const word = await queue.add(
          "report",
          {},
          { repeat: { every: "weekly" } },
        );
        const cron = await queue.add(
          "report",
          {},
          { repeat: { every: "*/10 * * * *", tz: "Asia/Tokyo" } },
        );

        expect((await seriesOf(duration.repeatKey)).every).toBe(2 * 86_400_000);
        expect((await seriesOf(word.repeatKey)).every).toBe(7 * 86_400_000);
        const series = await seriesOf(cron.repeatKey);
        expect(series.cron).toBe("*/10 * * * *");
        expect(series.every).toBeUndefined();
        expect(series.tz).toBe("Asia/Tokyo");
      });

      it("add with repeat.every as a phrase that names a start and an end", async () => {
        const job = await queue.add(
          "report",
          {},
          {
            repeat: { every: "every 2 days from 1 dec 2026 until 31 dec 2026" },
          },
        );

        const series = await seriesOf(job.repeatKey);
        expect(series.every).toBe(2 * 86_400_000);
        const [start, end] = [
          calendarDay(series.startAt),
          calendarDay(series.endAt),
        ];
        expect(start).toEqual([2026, 12, 1]);
        expect(end).toEqual([2026, 12, 31]);
        // The first occurrence is the start itself, not one interval after it.
        expect(job.runAt).toBe(series.startAt!);
      });

      it("add with repeat.startAt and endAt as words", async () => {
        const job = await queue.add(
          "report",
          {},
          {
            repeat: {
              every: "1 hour",
              startAt: "2nd december 2026",
              endAt: "in 400 days",
            },
          },
        );

        const series = await seriesOf(job.repeatKey);
        const day = calendarDay(series.startAt);
        expect(day).toEqual([2026, 12, 2]);
        expect(series.endAt).toBeGreaterThan(Date.now() + 399 * 86_400_000);
      });

      it("an explicit repeat.startAt wins over a date inside the phrase", async () => {
        const explicit = new Date(2027, 0, 5).getTime();
        const job = await queue.add(
          "report",
          {},
          {
            repeat: {
              every: "every 2 weeks starting 1st december 2026",
              startAt: explicit,
            },
          },
        );

        expect((await seriesOf(job.repeatKey)).startAt).toBe(explicit);
      });

      it("re-adding a phrase with a fixed start is the same series", async () => {
        const repeat = { every: "every 2 weeks starting 1st december 2026" };
        const first = await queue.add("report", {}, { repeat });
        const again = await queue.add("report", {}, { repeat });

        expect(again.id).toBe(first.id);
        expect(again.wasAdded).toBe(false);
        expect(await queue.listRepeatables()).toHaveLength(1);
      });

      it("addBulk with a phrase repeat entry", async () => {
        const added = await queue.addBulk([
          { name: "mail", data: {} },
          {
            name: "report",
            data: {},
            opts: {
              repeat: { every: "every 3 days starting 2nd december 2026" },
            },
          },
        ]);

        const series = await seriesOf(added[1]!.repeatKey);
        expect(series.every).toBe(3 * 86_400_000);
        const day = calendarDay(series.startAt);
        expect(day).toEqual([2026, 12, 2]);
      });

      it("refuses a repeat.every it cannot read, naming the option", async () => {
        await expect(
          queue.add("report", {}, { repeat: { every: "whenever" } }),
        ).rejects.toThrow(/repeat\.every/);
        await expect(
          queue.add("report", {}, { repeat: { every: "sometimes" } }),
        ).rejects.toThrow(ConfigError);
        // Nothing half-made was left behind.
        expect(await queue.listRepeatables()).toHaveLength(0);
      });

      it("addBulk stores every entry", async () => {
        const added = await queue.addBulk([
          { name: "mail", data: { n: 1 } },
          { name: "mail", data: { n: 2 } },
          { name: "report", data: { n: 3 } },
        ]);

        expect(added).toHaveLength(3);
        expect(added.every((job) => job.wasAdded)).toBe(true);
        expect(await queue.count("waiting")).toBe(3);
      });

      it("addBulk reports an id that was already taken", async () => {
        await queue.add("mail", {}, { jobId: "bulk-taken" });

        const added = await queue.addBulk([
          { name: "mail", data: {}, opts: { jobId: "bulk-new" } },
          { name: "mail", data: {}, opts: { jobId: "bulk-taken" } },
        ]);

        expect(added.map((job) => job.wasAdded)).toEqual([true, false]);
      });

      it("a queue from the context stores under the context's namespace", async () => {
        const custom = jobs.queue("custom");
        const job = await custom.add("anything", { x: 1 });

        const ref = { ns: jobs.namespace, queue: "custom" };
        expect((await driver.getJob(ref, job.id))?.data).toEqual({ x: 1 });
      });
    });

    /* --- 3. the context's shorthands -------------------------------------- */

    describe("through BunJobs", () => {
      it("now(name)", async () => {
        const job = await jobs.now("mail");

        expect(job.state).toBe("waiting");
        expect((await queue.getJob(job.id))?.name).toBe("mail");
      });

      it("now(name, data) takes the definition's options", async () => {
        const job = await jobs.now("mail", { to: "ops" });

        const stored = await queue.getJob(job.id);
        expect(stored?.data).toEqual({ to: "ops" });
        expect(stored?.maxAttempts).toBe(3);
        expect(stored?.priority).toBe(2);
      });

      it("now(name, data, options) overrides what it names, and only that", async () => {
        const job = await jobs.now("mail", {}, { priority: 9 });

        const stored = await queue.getJob(job.id);
        expect(stored?.priority).toBe(9);
        expect(stored?.maxAttempts).toBe(3);
      });

      it("refuses a name that was never defined", async () => {
        await expect(jobs.now("undefined-name")).rejects.toThrow(ConfigError);
        expect(() => jobs.schedule("undefined-name")).toThrow(ConfigError);
      });
    });

    /* --- 4. the builder: entry points ------------------------------------- */

    describe("through the builder: entry points", () => {
      it("schedule, run and process build the same job", async () => {
        const built = await Promise.all([
          jobs.schedule("mail", { via: "x" }).priority(5).start(),
          jobs.run("mail", { via: "x" }).priority(5).start(),
          jobs.process("mail", { via: "x" }).priority(5).start(),
        ]);

        for (const job of built) {
          const stored = await queue.getJob(job.id);
          expect(stored?.name).toBe("mail");
          expect(stored?.data).toEqual({ via: "x" });
          expect(stored?.priority).toBe(5);
          expect(stored?.maxAttempts).toBe(3);
        }
      });

      it("data given up front, or later with withData", async () => {
        const upFront = await jobs.run("mail", { a: 1 }).start();
        const later = await jobs.run("mail").withData({ a: 1 }).start();
        const replaced = await jobs
          .run("mail", { a: 1 })
          .withData({ a: 2 })
          .start();

        expect((await queue.getJob(upFront.id))?.data).toEqual({ a: 1 });
        expect((await queue.getJob(later.id))?.data).toEqual({ a: 1 });
        expect((await queue.getJob(replaced.id))?.data).toEqual({ a: 2 });
      });

      it("adds nothing until start()", async () => {
        jobs.run("mail").in("5 minutes").withData({ unsent: true });

        const counts = await queue.count();
        expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(0);
      });
    });

    /* --- 5. the builder: when --------------------------------------------- */

    describe("through the builder: when it runs", () => {
      it("in(ms), in('5 minutes'), in('in 5 minutes')", async () => {
        const before = Date.now();

        for (const delay of [300_000, "5 minutes", "in 5 minutes"] as const) {
          const job = await jobs.run("mail").in(delay).start();
          const stored = await queue.getJob(job.id);

          expect(stored?.state).toBe("delayed");
          expect(stored?.runAt).toBeGreaterThanOrEqual(before + 300_000);
          expect(stored?.runAt).toBeLessThan(before + 301_000);
        }
      });

      it("on(Date) and on(timestamp)", async () => {
        const at = Date.now() + 600_000;

        const byDate = await jobs.run("mail").on(new Date(at)).start();
        const byNumber = await jobs.run("mail").on(at).start();

        expect((await queue.getJob(byDate.id))?.runAt).toBe(at);
        expect((await queue.getJob(byNumber.id))?.runAt).toBe(at);
      });

      it("on() in the past is claimable at once", async () => {
        const job = await jobs
          .run("mail")
          .on(Date.now() - 1_000)
          .start();
        expect((await queue.getJob(job.id))?.state).toBe("waiting");
      });

      it("on('in 20 minutes') needs no parser", async () => {
        const before = Date.now();
        const job = await jobs.run("mail").on("in 20 minutes").start();

        expect(job.runAt).toBeGreaterThanOrEqual(before + 1_200_000);
        expect(job.runAt).toBeLessThan(before + 1_260_000);
      });

      it("on('2nd december 2026') reads a date phrase", async () => {
        const job = await jobs.process("mail").on("2nd december 2026").start();

        const day = calendarDay((await queue.getJob(job.id))?.runAt);
        expect(day).toEqual([2026, 12, 2]);
      });
    });

    /* --- 6. the builder: repeating ---------------------------------------- */

    describe("through the builder: repeating", () => {
      it("every(ms)", async () => {
        const job = await jobs.run("report").every(45_000).start();
        expect((await seriesOf(job.repeatKey)).every).toBe(45_000);
      });

      it("every('2 days') and every('every 2 days')", async () => {
        const bare = await jobs.run("report").every("2 days").start();
        const worded = await jobs.run("report").every("every 3 days").start();

        expect((await seriesOf(bare.repeatKey)).every).toBe(2 * 86_400_000);
        expect((await seriesOf(worded.repeatKey)).every).toBe(3 * 86_400_000);
      });

      it("every('daily'), every('every other day'), every('weekly')", async () => {
        const daily = await jobs.run("report").every("daily").start();
        const other = await jobs.run("report").every("every other day").start();
        const weekly = await jobs.run("report").every("weekly").start();

        expect((await seriesOf(daily.repeatKey)).every).toBe(86_400_000);
        expect((await seriesOf(other.repeatKey)).every).toBe(2 * 86_400_000);
        expect((await seriesOf(weekly.repeatKey)).every).toBe(7 * 86_400_000);
      });

      it("every(cron)", async () => {
        const job = await jobs.run("report").every("*/15 * * * *").start();
        expect((await seriesOf(job.repeatKey)).cron).toBe("*/15 * * * *");
      });

      it("every('every 2 weeks starting 1st december 2026') sets the start", async () => {
        const job = await jobs
          .schedule("report")
          .every("every 2 weeks starting 1st december 2026")
          .start();

        const series = await seriesOf(job.repeatKey);
        expect(series.every).toBe(14 * 86_400_000);
        expect(calendarDay(series.startAt)).toEqual([2026, 12, 1]);
      });

      it("every('every 2 days from 1 dec 2026 until 31 dec 2026') sets the window", async () => {
        const job = await jobs
          .schedule("report")
          .every("every 2 days from 1 dec 2026 until 31 dec 2026")
          .start();

        const series = await seriesOf(job.repeatKey);
        expect(series.every).toBe(2 * 86_400_000);
        expect(calendarDay(series.startAt)).toEqual([2026, 12, 1]);
        expect(calendarDay(series.endAt)).toEqual([2026, 12, 31]);
      });

      it("every('every day at 9am') is daily from the next 9am", async () => {
        const job = await jobs.run("report").every("every day at 9am").start();

        const series = await seriesOf(job.repeatKey);
        expect(series.every).toBe(86_400_000);
        expect(new Date(series.startAt!).getHours()).toBe(9);
      });

      it("every('every monday') is weekly from a monday", async () => {
        const job = await jobs.run("report").every("every monday").start();

        const series = await seriesOf(job.repeatKey);
        expect(series.every).toBe(7 * 86_400_000);
        expect(new Date(series.startAt!).getDay()).toBe(1);
      });

      it("an explicit startingAt wins over a date inside the phrase", async () => {
        const explicit = new Date(2027, 0, 5).getTime();
        const job = await jobs
          .run("report")
          .every("every 2 weeks starting 1st december 2026")
          .startingAt(explicit)
          .start();

        expect((await seriesOf(job.repeatKey)).startAt).toBe(explicit);
      });

      it("calling every() again replaces the schedule and its dates", async () => {
        const job = await jobs
          .run("report")
          .every("every 2 days from 1 dec 2026 until 31 dec 2026")
          .every(5_000)
          .start();

        const series = await seriesOf(job.repeatKey);
        expect(series.every).toBe(5_000);
        expect(series.cron).toBeUndefined();
        expect(series.startAt).toBeUndefined();
        expect(series.endAt).toBeUndefined();
      });

      it("startingAt, endingAt and limit", async () => {
        const start = Date.now() + 3_600_000;
        const end = start + 7 * 86_400_000;

        const job = await jobs
          .run("report")
          .every("1 hour")
          .startingAt(start)
          .endingAt(end)
          .limit(10)
          .start();

        const series = await seriesOf(job.repeatKey);
        expect(series.startAt).toBe(start);
        expect(series.endAt).toBe(end);
        expect(series.limit).toBe(10);
      });

      it("startingAt a phrase", async () => {
        const job = await jobs
          .run("report")
          .every("1 day")
          .startingAt("2nd december 2026")
          .start();

        const day = calendarDay((await seriesOf(job.repeatKey)).startAt);
        expect(day).toEqual([2026, 12, 2]);
      });

      it("tz, catchUp and immediately", async () => {
        const zoned = await jobs
          .run("report")
          .every("0 9 * * *")
          .tz("Asia/Tokyo")
          .catchUp()
          .start();
        const series = await seriesOf(zoned.repeatKey);
        expect(series.tz).toBe("Asia/Tokyo");
        expect(series.catchUp).toBe(true);

        const now = await jobs
          .run("mail")
          .every("1 hour")
          .immediately()
          .start();
        expect(now.state).toBe("waiting");
      });

      it("fails on a phrase it cannot read, naming every()", () => {
        expect(() => jobs.run("report").every("whenever")).toThrow(/every\(\)/);
        expect(() => jobs.run("report").every("sometimes on tuesdays")).toThrow(
          ConfigError,
        );
      });
    });

    /* --- 7. the builder: policy ------------------------------------------- */

    describe("through the builder: how it runs", () => {
      it("priority, attempts, timeout and backoff", async () => {
        const job = await jobs
          .run("report")
          .priority(1)
          .attempts(6)
          .timeout("30 seconds")
          .backoff({ type: "fixed", delay: 250 })
          .start();

        const stored = await queue.getJob(job.id);
        expect(stored?.priority).toBe(1);
        expect(stored?.maxAttempts).toBe(6);
        expect(stored?.opts.timeout).toBe(30_000);
        expect(stored?.opts.backoff).toMatchObject({ type: "fixed" });
      });

      it("unique(id) is idempotent", async () => {
        const first = await jobs.run("mail", { v: 1 }).unique("once").start();
        const again = await jobs.run("mail", { v: 2 }).unique("once").start();

        expect(first.id).toBe("once");
        expect(again.wasAdded).toBe(false);
        expect((await queue.getJob("once"))?.data).toEqual({ v: 1 });
      });

      it("unique(id) on a repeating job names the series, and stays idempotent", async () => {
        const first = await jobs
          .run("report")
          .every("1 hour")
          .unique("hourly")
          .start();
        const again = await jobs
          .run("report")
          .every("1 hour")
          .unique("hourly")
          .start();

        expect(first.repeatKey).toBe("hourly");
        expect(again.id).toBe(first.id);
        expect(again.wasAdded).toBe(false);
        expect(await queue.listRepeatables()).toHaveLength(1);
      });

      it("the definition's options, and a builder overriding one of them", async () => {
        const inherited = await jobs.run("mail").start();
        const overridden = await jobs.run("mail").attempts(8).start();

        expect((await queue.getJob(inherited.id))?.maxAttempts).toBe(3);
        const stored = await queue.getJob(overridden.id);
        expect(stored?.maxAttempts).toBe(8);
        expect(stored?.priority).toBe(2);
      });
    });

    /* --- 8. the builder: one options object ------------------------------- */

    describe("through the builder: withOptions", () => {
      it("in the builder's own words", async () => {
        const job = await jobs
          .schedule("report")
          .withOptions({
            data: { list: "weekly" },
            every: "every 2 weeks starting 1st december 2026",
            limit: 4,
            priority: 3,
            timeout: "1 minute",
            unique: "digest",
          })
          .start();

        // On a series, unique names the series; occurrence ids stay derived.
        expect(job.repeatKey).toBe("digest");
        const stored = await queue.getJob(job.id);
        expect(stored?.data).toEqual({ list: "weekly" });
        expect(stored?.priority).toBe(3);
        expect(stored?.opts.timeout).toBe(60_000);

        const series = await seriesOf(job.repeatKey);
        expect(series.every).toBe(14 * 86_400_000);
        expect(series.limit).toBe(4);
        expect(calendarDay(series.startAt)).toEqual([2026, 12, 1]);
      });

      it("in the raw JobOptions names", async () => {
        const job = await jobs
          .run("mail")
          .withOptions({
            jobId: "raw",
            delay: 90_000,
            removeOnComplete: true,
            keepStacktraces: 2,
          })
          .start();

        const stored = await queue.getJob("raw");
        expect(job.id).toBe("raw");
        expect(stored?.state).toBe("delayed");
        expect(stored?.opts.removeOnComplete).toBe(true);
        expect(stored?.opts.keepStacktraces).toBe(2);
      });

      it("with a date phrase", async () => {
        const job = await jobs
          .process("mail")
          .withOptions({ on: "2nd december 2026", data: { year: 2026 } })
          .start();

        const day = calendarDay((await queue.getJob(job.id))?.runAt);
        expect(day).toEqual([2026, 12, 2]);
      });

      it("mixed with the chain, the last word winning", async () => {
        const job = await jobs
          .run("mail")
          .priority(1)
          .withOptions({ priority: 4, data: { a: 1 } })
          .withData({ a: 2 })
          .start();

        const stored = await queue.getJob(job.id);
        expect(stored?.priority).toBe(4);
        expect(stored?.data).toEqual({ a: 2 });
      });

      it("refuses one thing given under both of its names", () => {
        expect(() =>
          jobs.run("mail").withOptions({ in: "1 minute", delay: 60_000 }),
        ).toThrow(ConfigError);
      });
    });

    /* --- 9. they all make jobs a worker runs ------------------------------ */

    it("every path above produces a job the worker actually runs", async () => {
      const ran = new Set<string>();
      jobs.define("mail", async (job) => {
        ran.add(job.id);
      });

      const created = [
        await driver
          .addJob(
            { ns: jobs.namespace, queue: "jobs" },
            makeJob({ id: "e2e-driver", name: "mail" }),
          )
          .then(({ job }) => job.id),
        (await queue.add("mail", {})).id,
        ...(
          await queue.addBulk([
            { name: "mail", data: {} },
            { name: "mail", data: {} },
          ])
        ).map((job) => job.id),
        (await jobs.now("mail")).id,
        (await jobs.run("mail").withData({ via: "chain" }).start()).id,
        (
          await jobs
            .run("mail")
            .on(Date.now() - 1_000)
            .start()
        ).id,
        (
          await jobs
            .run("mail")
            .withOptions({ data: { via: "options" } })
            .start()
        ).id,
      ];

      await jobs.start({ pollInterval: 10, maxBlock: 20 });

      await waitFor(() => created.every((id) => ran.has(id)), {
        message: () =>
          `never ran: ${created.filter((id) => !ran.has(id)).join(", ")}`,
        timeout: 15_000,
      });
    }, 30_000);
  });
}

/* --- the phrase reader, against a fixed clock ----------------------------- */

describe("reading a recurring phrase", () => {
  /** A fixed reference instant, so dates in these cases never drift. */
  const NOW = new Date(2026, 8, 14, 10, 0, 0).getTime();
  const DAY = 86_400_000;

  it.each([
    ["2 days", 2 * DAY],
    ["every 90 minutes", 90 * 60_000],
    ["each hour", 3_600_000],
    ["daily", DAY],
    ["nightly", DAY],
    ["weekly", 7 * DAY],
    ["fortnightly", 14 * DAY],
    ["every other week", 14 * DAY],
    ["every fortnight", 14 * DAY],
  ])("reads %p as an interval with no dates", (phrase, every) => {
    expect(readRecurrence(phrase, "every()", NOW)).toEqual({ every });
  });

  it("reads a start", () => {
    const read = readRecurrence(
      "every 3 hours starting tomorrow at 9am",
      "every()",
      NOW,
    );

    expect(read.every).toBe(3 * 3_600_000);
    expect(new Date(read.startAt!)).toEqual(new Date(2026, 8, 15, 9, 0, 0));
    expect(read.endAt).toBeUndefined();
  });

  it("reads a range as start and end", () => {
    const read = readRecurrence(
      "every 30 minutes between 1 jan 2027 and 2 jan 2027",
      "every()",
      NOW,
    );

    expect(read.every).toBe(30 * 60_000);
    expect(calendarDay(read.startAt)).toEqual([2027, 1, 1]);
    expect(calendarDay(read.endAt)).toEqual([2027, 1, 2]);
  });

  it("reads 'weekly starting …' with the interval after the dates are taken out", () => {
    const read = readRecurrence(
      "weekly starting 2nd december 2026",
      "every()",
      NOW,
    );

    expect(read.every).toBe(7 * DAY);
    expect(calendarDay(read.startAt)).toEqual([2026, 12, 2]);
  });

  it("refuses what it cannot account for", () => {
    // A guess at "on a whim" would be worse than saying so.
    expect(() =>
      readRecurrence("every 2 days on a whim", "every()", NOW),
    ).toThrow(ConfigError);
    // Dates with no interval anywhere.
    expect(() =>
      readRecurrence("from 1 dec 2026 to 5 dec 2026", "every()", NOW),
    ).toThrow(/how often/);
  });
});
