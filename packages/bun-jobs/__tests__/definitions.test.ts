import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunJobs, ConfigError, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * Jobs described by name, so one worker runs all of them.
 *
 * Without this a consumer writes the dispatch itself — a `switch (job.name)`
 * inside one worker, or a queue and a worker per kind of job. Both work, and
 * both leave nothing that can be asked *what jobs exist*, which is what a
 * dashboard, a health check and every per-name feature need.
 */

const contexts: BunJobs[] = [];

afterEach(async () => {
  await Promise.allSettled(contexts.map((jobs) => jobs.close()));
  contexts.length = 0;
});

/** A context on its own memory driver, tracked for cleanup. */
function makeJobs(): BunJobs {
  const jobs = new BunJobs({
    namespace: testNamespace(),
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  contexts.push(jobs);
  return jobs;
}

describe("defined jobs", () => {
  it("runs every defined name through one worker", async () => {
    const jobs = makeJobs();
    const ran: string[] = [];

    jobs.define("sendEmail", async () => {
      ran.push("sendEmail");
    });
    jobs.define("buildReport", async () => {
      ran.push("buildReport");
    });

    // One worker, not one per name — which is the whole point of the registry.
    await jobs.start({ pollInterval: 10, maxBlock: 20 });
    await jobs.now("sendEmail");
    await jobs.now("buildReport");

    await waitFor(() => ran.length === 2, {
      message: `only ran ${ran.join(", ")}`,
      timeout: 8_000,
    });
    expect(ran.sort()).toEqual(["buildReport", "sendEmail"]);
  }, 20_000);

  it("gives every job of a name the definition's options", async () => {
    const jobs = makeJobs();
    jobs.define("flaky", async () => null, { attempts: 5, priority: 3 });

    // Declared once on the definition rather than repeated at each call site,
    // which is how two call sites come to disagree.
    const job = await jobs.now("flaky");
    expect(job.opts.attempts).toBe(5);
    expect(job.opts.priority).toBe(3);
  }, 15_000);

  it("lets a call override what the definition set", async () => {
    const jobs = makeJobs();
    jobs.define("flaky", async () => null, { attempts: 5, priority: 3 });

    // The call wins for what it names, and inherits the rest: asking for a
    // different priority should not silently drop the retry policy.
    const job = await jobs.now("flaky", undefined, { priority: 9 });
    expect(job.opts.priority).toBe(9);
    expect(job.opts.attempts).toBe(5);
  }, 15_000);

  it("refuses to add or start a name it does not know", async () => {
    const jobs = makeJobs();

    // Rather than enqueueing something nothing can run.
    expect(jobs.now("neverDefined")).rejects.toThrow(ConfigError);

    // And starting with nothing defined is a mistake worth naming, not a
    // worker that sits there consuming a queue it can never satisfy.
    expect(jobs.start()).rejects.toThrow(ConfigError);
  }, 15_000);

  it("reads a schedule as a sentence", async () => {
    const jobs = makeJobs();
    jobs.define("later", async () => null);

    const at = new Date(Date.now() + 60_000);
    const scheduled = await jobs.schedule("later").on(at).start();
    expect(scheduled.runAt).toBe(at.getTime());
    expect(scheduled.state).toBe("delayed");

    // Durations in the words people use for them, rather than
    // `2 * 24 * 60 * 60 * 1000` at every call site.
    const repeating = await jobs.run("later").every("2 days").start();
    expect(repeating.isRepeat).toBe(true);
    expect(repeating.repeatKey).toContain(`every:${2 * 86_400_000}`);
  }, 15_000);

  it("takes the description in whatever order reads best", async () => {
    const jobs = makeJobs();
    jobs.define("mail", async () => null, { attempts: 4 });

    // Data after the schedule, which is the order the example reads in.
    const job = await jobs
      .process("mail")
      .every("30 minutes")
      .withData({ to: "ops" })
      .priority(2)
      .start();

    expect(job.data).toEqual({ to: "ops" });
    expect(job.opts.priority).toBe(2);
    // Still inherits what the definition said, which the builder did not name.
    expect(job.opts.attempts).toBe(4);
  }, 15_000);

  it("adds nothing until it is started", async () => {
    const jobs = makeJobs();
    jobs.define("unsent", async () => null);

    // Describing is not doing: a builder can be passed around and finished
    // elsewhere, and one that is dropped leaves no job behind.
    jobs.run("unsent").in("5 minutes").withData({ a: 1 });

    expect(await jobs.queue("jobs").count()).toMatchObject({ delayed: 0 });
  }, 15_000);

  it("tells a cron expression from a duration by its shape", async () => {
    const jobs = makeJobs();
    jobs.define("nightly", async () => null);

    const cron = await jobs.schedule("nightly").every("0 9 * * 1").start();
    expect(cron.repeatKey).toBe("nightly|0 9 * * 1|");

    const duration = await jobs.schedule("nightly").every("90s").start();
    expect(duration.repeatKey).toBe("nightly|every:90000|");
  }, 15_000);

  it("says which method could not read a phrase", async () => {
    const jobs = makeJobs();
    jobs.define("x", async () => null);

    // Naming the method matters: the caller wrote several in one sentence.
    expect(() => jobs.run("x").every("whenever")).toThrow(/every\(\)/);
    expect(() => jobs.run("x").in("soonish")).toThrow(/in\(\)/);
  }, 15_000);

  it("reports what it knows, for anything that needs to ask", async () => {
    const jobs = makeJobs();
    jobs.define("a", async () => null, { attempts: 2 });
    jobs.define("b", async () => null);

    expect(jobs.definitions().map((d) => d.name)).toEqual(["a", "b"]);
    expect(jobs.definitions()[0]!.options.attempts).toBe(2);

    // Defining a name again replaces it — what a caller reloading a module
    // expects, and not silent, because they called `define` again.
    jobs.define("a", async () => null, { attempts: 9 });
    expect(jobs.definitions()).toHaveLength(2);
    expect(jobs.definitions()[0]!.options.attempts).toBe(9);
  }, 15_000);

  it("starts once however many times it is asked", async () => {
    const jobs = makeJobs();
    jobs.define("x", async () => null);

    const first = await jobs.start({ pollInterval: 10, maxBlock: 20 });
    const second = await jobs.start();

    // A second consumer on the same queue would claim jobs the first was
    // about to, which is not what "start it" means.
    expect(second).toBe(first);
  }, 15_000);

  it("fails a job whose name this process does not define", async () => {
    const jobs = makeJobs();
    jobs.define("known", async () => null);
    await jobs.start({ pollInterval: 10, maxBlock: 20 });

    // Added straight to the registry's queue, as another deployment defining
    // a name this one does not would do.
    const queue = jobs.queue("jobs");
    const job = await queue.add("unknownHere", {});

    // Failing is right: the job belongs to a worker that knows the name, and
    // dropping it quietly would lose it.
    await waitFor(async () => (await queue.getJob(job.id))?.state === "dead", {
      message: "the unknown job should have failed",
      timeout: 8_000,
    });
  }, 20_000);
});

describe("saying when in words", () => {
  it("reads a date phrase through chrono", async () => {
    const jobs = makeJobs();
    jobs.define("annual", async () => null);

    // The case the optional peer exists for: natural language, which a
    // duration grammar cannot do and should not pretend to.
    const job = await jobs.process("annual").on("2nd december 2026").start();

    const at = new Date(job.runAt);
    expect(at.getFullYear()).toBe(2026);
    expect(at.getMonth()).toBe(11);
    expect(at.getDate()).toBe(2);
    expect(job.state).toBe("delayed");
  }, 15_000);

  it("reads a bare duration as from now, without chrono", async () => {
    const jobs = makeJobs();
    jobs.define("soon", async () => null);

    // "in 20 minutes" and "20 minutes" plainly mean the same thing, and only
    // one of them reads well at a call site — so both work, and neither needs
    // a parser.
    const before = Date.now();
    const job = await jobs.run("soon").on("in 20 minutes").start();

    expect(job.runAt).toBeGreaterThanOrEqual(before + 20 * 60_000);
    expect(job.runAt).toBeLessThan(before + 21 * 60_000);
  }, 15_000);

  it("starts a series at a phrase and repeats from there", async () => {
    const jobs = makeJobs();
    jobs.define("weekly", async () => null);

    // "every 2 weeks, starting next monday" is one sentence, so `on()` sets
    // where the series begins rather than fighting with `every()`.
    const job = await jobs
      .schedule("weekly")
      .every("2 weeks")
      .on("1 january 2027")
      .start();

    expect(job.isRepeat).toBe(true);
    expect(new Date(job.runAt).getFullYear()).toBe(2027);
  }, 15_000);
});

describe("withOptions", () => {
  /**
   * One object in place of a chain, for the call site where the description is
   * data — loaded from config, built by a form — and a chain would mean
   * unpacking an object only to repack it.
   */
  it("describes the same job the chain does", async () => {
    const jobs = makeJobs();
    jobs.define("mail", async () => null, { attempts: 2 });

    const chained = await jobs
      .schedule("mail")
      .every("2 days")
      .withData({ to: "ops" })
      .priority(4)
      .timeout("30 seconds")
      .unique("chained")
      .start();

    const described = await jobs
      .schedule("mail")
      .withOptions({
        every: "2 days",
        data: { to: "ops" },
        priority: 4,
        timeout: "30 seconds",
        unique: "described",
      })
      .start();

    // Everything but the id they were deliberately given apart — which, on a
    // repeating job, names the series.
    expect(described.data).toEqual(chained.data);
    expect(described.opts.priority).toBe(chained.opts.priority);
    expect(described.opts.timeout).toBe(30_000);
    expect(described.opts.timeout).toBe(chained.opts.timeout);
    expect(chained.repeatKey).toBe("chained");
    expect(described.repeatKey).toBe("described");
    // And the definition's defaults sit under both.
    expect(described.opts.attempts).toBe(2);
  }, 15_000);

  it("reads phrases and cron exactly as the methods do", async () => {
    const jobs = makeJobs();
    jobs.define("annual", async () => null);

    const dated = await jobs
      .process("annual")
      .withOptions({ on: "2nd december 2026", data: { year: 2026 } })
      .start();
    const at = new Date(dated.runAt);
    expect(at.getFullYear()).toBe(2026);
    expect(at.getMonth()).toBe(11);
    expect(at.getDate()).toBe(2);
    expect(dated.data).toEqual({ year: 2026 });

    const cron = await jobs
      .run("annual")
      .withOptions({ every: "0 9 * * 1", tz: "Europe/London" })
      .start();
    expect(cron.repeatKey).toBe("annual|0 9 * * 1@Europe/London|");
  }, 15_000);

  it("mixes with the chain, and the last word wins", async () => {
    const jobs = makeJobs();
    jobs.define("mixed", async () => null);

    const job = await jobs
      .run("mixed")
      .priority(1)
      .withOptions({ priority: 5, data: { a: 1 } })
      .withData({ a: 2 })
      .start();

    // As two method calls would: whatever was said later stands.
    expect(job.opts.priority).toBe(5);
    expect(job.data).toEqual({ a: 2 });
  }, 15_000);

  it("takes the raw option names as well", async () => {
    const jobs = makeJobs();
    jobs.define("raw", async () => null);

    // What the rest of the package documents, so a `JobOptions` object from
    // elsewhere can be passed straight in.
    const job = await jobs
      .run("raw")
      .withOptions({ jobId: "raw-1", delay: 60_000, removeOnComplete: true })
      .start();

    expect(job.id).toBe("raw-1");
    expect(job.state).toBe("delayed");
    expect(job.opts.removeOnComplete).toBe(true);
  }, 15_000);

  it("refuses the same thing under both of its names", async () => {
    const jobs = makeJobs();
    jobs.define("both", async () => null);

    // No order of precedence a reader could be expected to guess, so neither
    // silently wins.
    expect(() =>
      jobs.run("both").withOptions({ in: "5 minutes", delay: 1_000 }),
    ).toThrow(/"in" and "delay"/);
    expect(() =>
      jobs.run("both").withOptions({ on: Date.now(), runAt: Date.now() }),
    ).toThrow(/"on" and "runAt"/);
    expect(() =>
      jobs.run("both").withOptions({ unique: "a", jobId: "b" }),
    ).toThrow(/"unique" and "jobId"/);
  }, 15_000);

  it("fails on a phrase with the same message the method gives", async () => {
    const jobs = makeJobs();
    jobs.define("bad", async () => null);

    expect(() => jobs.run("bad").withOptions({ every: "whenever" })).toThrow(
      /every\(\)/,
    );
  }, 15_000);
});
