import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunJobs, ConfigError, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * The typed job registry, at runtime.
 *
 * The checking it adds is entirely compile-time — asserted in
 * `typedRegistry.type-test.ts` — so what matters here is that it changed
 * nothing underneath: a context that declares a {@link JobMap} behaves exactly
 * as one that does not, including still raising `ConfigError` for a name it
 * was never told about. The types make that unreachable from TypeScript; they
 * do not make it unreachable from JavaScript, and the guard has to stay.
 */

/** What the typed contexts in this file declare. */
interface Jobs {
  /** A payload and a result. */
  "send-report": { data: { month: string }; result: string };
  /** No payload. */
  reindex: { data: void };
}

const contexts: BunJobs<Jobs>[] = [];
const loose: BunJobs[] = [];

afterEach(async () => {
  await Promise.allSettled([...contexts, ...loose].map((jobs) => jobs.close()));
  contexts.length = 0;
  loose.length = 0;
});

/** A typed context on its own memory driver, tracked for cleanup. */
function makeTyped(): BunJobs<Jobs> {
  const jobs = new BunJobs<Jobs>({
    namespace: testNamespace(),
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  contexts.push(jobs);
  return jobs;
}

/** An untyped context, for comparing behaviour against. */
function makeLoose(): BunJobs {
  const jobs = new BunJobs({
    namespace: testNamespace(),
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  loose.push(jobs);
  return jobs;
}

describe("typed registry", () => {
  it("defines, adds and runs exactly as an untyped context does", async () => {
    const jobs = makeTyped();
    const ran: string[] = [];

    jobs.define("send-report", async (job) => {
      ran.push(job.data.month);
      return `report for ${job.data.month}`;
    });
    jobs.define("reindex", async () => {
      ran.push("reindex");
    });

    await jobs.start({ pollInterval: 10, maxBlock: 20 });
    await jobs.now("send-report", { month: "2026-08" });
    await jobs.now("reindex");

    await waitFor(() => ran.length === 2, {
      message: `only ran ${ran.join(", ")}`,
      timeout: 8_000,
    });
    expect(ran.sort()).toEqual(["2026-08", "reindex"]);
  }, 20_000);

  it("carries the definition's options, as the untyped path does", async () => {
    const jobs = makeTyped();
    jobs.define("send-report", async () => "done", {
      attempts: 5,
      priority: 3,
    });

    const job = await jobs.now("send-report", { month: "2026-08" });
    expect(job.opts.attempts).toBe(5);
    expect(job.opts.priority).toBe(3);

    // And the call still wins for what it names.
    const louder = await jobs.now(
      "send-report",
      { month: "2026-09" },
      { priority: 9 },
    );
    expect(louder.opts.priority).toBe(9);
    expect(louder.opts.attempts).toBe(5);
  }, 15_000);

  it("still throws ConfigError for a name it was never given", async () => {
    const jobs = makeTyped();
    jobs.define("reindex", async () => undefined);

    // The types make this unreachable from TypeScript. JavaScript can still
    // do it, so the runtime guard has to stay — and this is what proves the
    // typing did not quietly replace it.
    const untyped = jobs as unknown as BunJobs;

    expect(() => untyped.schedule("never-defined")).toThrow(ConfigError);
    await expect(untyped.now("never-defined")).rejects.toThrow(ConfigError);
    expect(() => untyped.create("never-defined")).toThrow(ConfigError);
  }, 15_000);

  it("saves a draft, and the job carries the declared payload", async () => {
    const jobs = makeTyped();
    jobs.define("send-report", async (job) => job.data.month);

    const draft = jobs
      .create("send-report", { month: "2026-08" })
      .unique("report-2026-08")
      .priority(1);

    const saved = await draft.save();
    expect(saved.id).toBe("report-2026-08");
    expect(saved.data).toEqual({ month: "2026-08" });
    expect(saved.opts.priority).toBe(1);

    // Saving again answers with the same job and writes nothing.
    expect((await draft.save()).id).toBe(saved.id);
  }, 15_000);

  it("adds through the registry queue, and through the escape hatch", async () => {
    const jobs = makeTyped();
    jobs.define("send-report", async (job) => job.data.month);

    const registry = jobs.queue("jobs");
    const declared = await registry.add("send-report", { month: "2026-10" });
    expect(declared.data).toEqual({ month: "2026-10" });

    // An unregistered name, with it and its payload type named explicitly.
    const adhoc = await registry.add<"scratch", { note: string }>("scratch", {
      note: "one off",
    });
    expect(adhoc.data).toEqual({ note: "one off" });
    expect(adhoc.name).toBe("scratch");
  }, 15_000);

  it("adds a void job with no payload, through now() and add()", async () => {
    const jobs = makeTyped();
    const ran: unknown[] = [];

    jobs.define("reindex", async (job) => {
      ran.push(job.data);
    });

    await jobs.start({ pollInterval: 10, maxBlock: 20 });

    // The payload is left out entirely, which the types now require be
    // allowed only for a job whose declared payload is void.
    const viaNow = await jobs.now("reindex");
    const viaAdd = await jobs.queue("jobs").add("reindex");
    const withOptions = await jobs.queue("jobs").add("reindex", undefined, {
      priority: 4,
    });

    // No payload is stored as null, on every driver (JSON has no undefined).
    expect(viaNow.data).toBeNull();
    expect(viaAdd.data).toBeNull();
    expect(withOptions.opts.priority).toBe(4);

    await waitFor(() => ran.length === 3, {
      message: () => `ran ${ran.length} of 3`,
      timeout: 8_000,
    });
    expect(ran).toEqual([null, null, null]);
  }, 20_000);

  it("fails an ad-hoc name on the registry queue in a service that does not define it", async () => {
    // What the README's escape-hatch table warns about: this service's own
    // registry worker claims every job on its queue, and it has no
    // definition for a name the map does not declare.
    const jobs = makeTyped();
    jobs.define("reindex", async () => undefined);

    await jobs.start({ pollInterval: 10, maxBlock: 20 });
    const registry = jobs.queue("jobs");
    const adhoc = await registry.add<"scratch", { note: string }>(
      "scratch",
      {
        note: "x",
      },
      { attempts: 1 },
    );

    let failed = await registry.getJob(adhoc.id);
    await waitFor(
      async () => {
        failed = await registry.getJob(adhoc.id);
        return failed?.state === "failed" || failed?.state === "dead";
      },
      { message: () => `state ${failed?.state}`, timeout: 8_000 },
    );
    expect(failed?.failedReason?.message).toContain(
      'No job is defined for "scratch"',
    );
  }, 20_000);

  it("runs ad-hoc work on a queue of its own, as the README says to", async () => {
    const jobs = makeTyped();
    const seen: string[] = [];

    const scratch = jobs.queue<{ note: string }>("scratch");
    const worker = jobs.worker<{ note: string }>(
      "scratch",
      async (job) => {
        seen.push(job.data.note);
      },
      { pollInterval: 10, maxBlock: 20 },
    );
    void worker.run();

    await scratch.add("scratch", { note: "one off" });
    await waitFor(() => seen.length === 1, { timeout: 8_000 });
    expect(seen).toEqual(["one off"]);
  }, 20_000);

  it("types and runs a registry queue with another name", async () => {
    const jobs = new BunJobs<Jobs, "work">({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
      registryQueue: "work",
    });
    contexts.push(jobs as unknown as BunJobs<Jobs>);
    const ran: string[] = [];

    jobs.define("send-report", async (job) => {
      ran.push(job.data.month);
      return job.data.month;
    });

    await jobs.start({ pollInterval: 10, maxBlock: 20 });
    const added = await jobs.now("send-report", { month: "2026-11" });

    // The job went on the declared queue, and that queue is the one the
    // typed overload hands back; "jobs" is a different, empty queue.
    const work = jobs.queue("work");
    expect((await work.getJob(added.id))?.name).toBe("send-report");
    expect(jobs.queue("jobs")).not.toBe(work);
    expect(await jobs.queue("jobs").getJob(added.id)).toBeNull();

    await waitFor(() => ran.length === 1, { timeout: 8_000 });
    expect(ran).toEqual(["2026-11"]);
  }, 20_000);

  it("reads back discriminated jobs, and hears scoped events with their result", async () => {
    const jobs = makeTyped();
    jobs.define("send-report", async (job) => `report ${job.data.month}`);
    jobs.define("reindex", async () => undefined);

    const registry = jobs.queue("jobs");

    const worker = await jobs.start({ pollInterval: 10, maxBlock: 20 });
    const workerResults: string[] = [];
    worker.on("completed:send-report", (_job, result) => {
      workerResults.push(result);
    });

    const added = await jobs.now("send-report", { month: "2026-12" });
    await waitFor(() => workerResults.length === 1, { timeout: 8_000 });

    const read = await registry.getJob(added.id);
    expect(read?.name).toBe("send-report");
    if (read?.name === "send-report") {
      expect(read.data.month).toBe("2026-12");
    }

    expect(workerResults).toEqual(["report 2026-12"]);
    expect(
      jobs
        .definitions()
        .map((definition) => definition.name)
        .sort(),
    ).toEqual(["reindex", "send-report"]);
  }, 20_000);

  it("gives the same queue instance back as an untyped context does", () => {
    const jobs = makeTyped();
    const registry = jobs.queue("jobs");

    expect(jobs.queue("jobs")).toBe(registry);

    // Naming a queue's types opts out of the registry typing; it does not
    // build a second queue.
    const mail = jobs.queue<{ to: string }>("mail");
    expect(jobs.queue<{ to: string }>("mail")).toBe(mail);
  });
});

describe("untyped registry", () => {
  it("is unchanged: any name, and TData from the argument", async () => {
    const jobs = makeLoose();
    const seen: unknown[] = [];

    jobs.define("anything", async (job) => {
      seen.push(job.data);
      return 1;
    });

    await jobs.start({ pollInterval: 10, maxBlock: 20 });
    await jobs.now("anything", { free: "shape" });

    await waitFor(() => seen.length === 1, { timeout: 8_000 });
    expect(seen).toEqual([{ free: "shape" }]);
  }, 20_000);

  it("still refuses a name that was never defined", async () => {
    const jobs = makeLoose();
    jobs.define("known", async () => null);

    expect(() => jobs.schedule("unknown")).toThrow(ConfigError);
    await expect(jobs.now("unknown")).rejects.toThrow(ConfigError);
  }, 15_000);
});
