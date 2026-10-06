import type { LogEvent } from "@kingsleyweb/bun-common";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunJobs, MemoryDriver } from "../lib/index";
import { testNamespace } from "./helpers";

/**
 * `jobs.queue(name, options)` on a name that already has a queue.
 *
 * The context caches one queue per name, so options apply only when the
 * queue is created. A later call whose options differ from the ones the queue
 * was created with gets the cached queue unchanged, as before, plus one
 * warning per name naming the option keys it ignored. A call with no options,
 * or with the same ones, stays quiet: that is how most code reaches a queue.
 */

const contexts: BunJobs[] = [];

afterEach(async () => {
  await Promise.allSettled(contexts.map(async (jobs) => await jobs.close()));
  contexts.length = 0;
});

/** A context on a memory driver, logging into `events`, closed after the test. */
function makeJobs(
  options: Partial<ConstructorParameters<typeof BunJobs>[0]> = {},
): {
  /** The context. */
  jobs: BunJobs;
  /** Everything it logged. */
  events: LogEvent[];
  /** The logger it was given. */
  logger: ReturnType<typeof createTestLogger>["logger"];
} {
  const { logger, events } = createTestLogger();
  const jobs = new BunJobs({
    namespace: testNamespace("qopts"),
    driver: new MemoryDriver(),
    logger,
    ...options,
  });
  contexts.push(jobs);
  return { jobs, events, logger };
}

/** The ignored-options warnings among `events`. */
function ignoredWarnings(events: LogEvent[]): LogEvent[] {
  return events.filter(
    (event) => event.level === "warn" && "ignoredOptions" in event.fields,
  );
}

describe("jobs.queue(name, options) on an existing queue", () => {
  it("warns once, naming the queue and the keys, when defaultJobOptions differ", () => {
    const { jobs, events } = makeJobs();
    const first = jobs.queue("mail", { defaultJobOptions: { attempts: 3 } });

    const second = jobs.queue("mail", { defaultJobOptions: { attempts: 5 } });

    expect(second).toBe(first);
    const warnings = ignoredWarnings(events);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields).toEqual({
      queue: "mail",
      ignoredOptions: ["defaultJobOptions"],
    });
    expect(warnings[0]!.message).toContain('"mail"');
    expect(warnings[0]!.message).toContain("defaultJobOptions");
  });

  it("names every differing key, sorted, and none that match", () => {
    const { jobs, events } = makeJobs();
    jobs.queue("mail", {
      defaultJobOptions: { attempts: 3 },
      jobDefaultsRefreshInterval: 50,
      subscribe: false,
    });

    jobs.queue("mail", {
      subscribe: true,
      defaultJobOptions: { attempts: 4 },
      jobDefaultsRefreshInterval: 50,
    });

    expect(ignoredWarnings(events)[0]?.fields.ignoredOptions).toEqual([
      "defaultJobOptions",
      "subscribe",
    ]);
  });

  it("stays quiet for equal options in new objects", () => {
    const { jobs, events } = makeJobs();
    jobs.queue("mail", {
      defaultJobOptions: { attempts: 3, backoff: { type: "fixed", delay: 10 } },
      subscribe: true,
    });

    jobs.queue("mail", {
      subscribe: true,
      defaultJobOptions: { backoff: { delay: 10, type: "fixed" }, attempts: 3 },
    });

    expect(ignoredWarnings(events)).toEqual([]);
  });

  it("stays quiet for the queue's own defaults passed explicitly", () => {
    const { jobs, events } = makeJobs();
    jobs.queue("mail");

    jobs.queue("mail", {
      subscribe: false,
      publish: false,
      jobDefaultsRefreshInterval: 1000,
    });
    expect(ignoredWarnings(events)).toEqual([]);

    jobs.queue("mail", { publish: true });
    expect(ignoredWarnings(events)[0]?.fields.ignoredOptions).toEqual([
      "publish",
    ]);
  });

  it("stays quiet for a call with no options, or empty ones", () => {
    const { jobs, events } = makeJobs();
    jobs.queue("mail", { defaultJobOptions: { attempts: 3 } });

    jobs.queue("mail");
    jobs.queue("mail", {});
    jobs.queue("mail", { defaultJobOptions: undefined });

    expect(ignoredWarnings(events)).toEqual([]);
  });

  it("compares against what the queue was created with, context defaults included", () => {
    const { jobs, events, logger } = makeJobs({
      defaultJobOptions: { attempts: 2 },
    });
    // Created by a call with no options, as the registry and toQueue() do.
    jobs.queue("mail");

    jobs.queue("mail", {
      defaultJobOptions: { attempts: 2 },
      logger,
    });
    expect(ignoredWarnings(events)).toEqual([]);

    jobs.queue("mail", { defaultJobOptions: { attempts: 9 } });
    expect(ignoredWarnings(events)[0]?.fields.ignoredOptions).toEqual([
      "defaultJobOptions",
    ]);
  });

  it("compares a logger by identity", () => {
    const { jobs, events } = makeJobs();
    const own = createTestLogger().logger;
    jobs.queue("mail", { logger: own });

    jobs.queue("mail", { logger: own });
    expect(ignoredWarnings(events)).toEqual([]);

    jobs.queue("mail", { logger: createTestLogger().logger });
    expect(ignoredWarnings(events)[0]?.fields.ignoredOptions).toEqual([
      "logger",
    ]);
  });

  it("warns once per name, however many differing calls follow", () => {
    const { jobs, events } = makeJobs();
    jobs.queue("mail", { defaultJobOptions: { attempts: 3 } });
    jobs.queue("sms", { defaultJobOptions: { attempts: 3 } });

    jobs.queue("mail", { defaultJobOptions: { attempts: 5 } });
    jobs.queue("mail", { defaultJobOptions: { attempts: 7 } });
    jobs.queue("mail", { subscribe: true });
    jobs.queue("sms", { defaultJobOptions: { attempts: 5 } });

    expect(ignoredWarnings(events).map((event) => event.fields.queue)).toEqual([
      "mail",
      "sms",
    ]);
  });

  it("keeps the queue's original options: only the warning is new", async () => {
    const { jobs } = makeJobs();
    const queue = jobs.queue("mail", { defaultJobOptions: { attempts: 3 } });

    const again = jobs.queue("mail", {
      defaultJobOptions: { attempts: 5, priority: 9 },
    });
    const job = await again.add("welcome", {});

    expect(again).toBe(queue);
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.priority).toBe(0); // the default, not 9
  });
});
