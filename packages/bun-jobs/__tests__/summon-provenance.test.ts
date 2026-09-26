import type {
  BunRunnerOptions,
  ExecutionMode,
  JobsDriver,
  WorkerInfo,
  WorkerSummonProvenance,
} from "../lib/index";
import type { ProbeReport } from "./fixtures/processes/spawnProbe";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { toWorkerDto } from "../lib/api/serialize";
import {
  BunQueueWorker,
  BunRunner,
  CHILD_ENV,
  ConfigError,
  createDriver,
  listWorkerRecords,
  MemoryDriver,
  SUMMON_ARGS,
  summonedFromArgs,
} from "../lib/index";
import { parseSummonArgs } from "../lib/summon/args";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Summon provenance (Phase 1.5, PR-2): a worker says it was summoned, by what
 * and until when, on its heartbeat record and through the management API;
 * and `summonedFromArgs()` builds that from the `--bun-jobs-summon-*=`
 * arguments a summon passes.
 *
 * Reworked after the bun-jobs session's review (2026-09-26): identity travels
 * **only as arguments**, because an environment leaks to every descendant —
 * `Bun.spawn` with no `env` passes the environment the process started with,
 * whatever `process.env` says now. The descendant tests below prove the fix
 * and carry the leak itself as their negative control.
 */

const fixture = (kind: "handlers" | "processes", name: string) =>
  join(import.meta.dir, "fixtures", kind, `${name}.ts`);

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

const cleanups: (() => Promise<void>)[] = [];
const servers = await crossProcessBackends({ cleanups });

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/** Sets `vars` on `process.env` for the length of `body`, then restores them. */
async function withEnv<T>(
  vars: Record<string, string>,
  body: () => T | Promise<T>,
): Promise<T> {
  const before = new Map(
    Object.keys(vars).map((key) => [key, process.env[key]] as const),
  );
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** Every summon argument, as a controller's summon would pass them. */
const FULL_ARGS = [
  "bun",
  "worker.ts",
  `${SUMMON_ARGS.id}=attempt-1`,
  `${SUMMON_ARGS.kind}=ecs`,
  `${SUMMON_ARGS.mode}=until-stopped`,
  `${SUMMON_ARGS.namespace}=shop`,
  `${SUMMON_ARGS.queue}=emails`,
  `${SUMMON_ARGS.maxLifetimeMs}=60000`,
  `${SUMMON_ARGS.graceMs}=10000`,
];

/* --- summonedFromArgs ------------------------------------------------------ */

describe("summonedFromArgs", () => {
  it("names every argument under --bun-jobs-summon-", () => {
    for (const name of Object.values(SUMMON_ARGS)) {
      expect(name.startsWith("--bun-jobs-summon-")).toBe(true);
    }
  });

  it("is undefined when no summon id is on the command line", () => {
    expect(summonedFromArgs([])).toBeUndefined();
    expect(summonedFromArgs(["bun", "worker.ts", "--verbose"])).toBeUndefined();
    // An empty id counts as absent.
    expect(summonedFromArgs([`${SUMMON_ARGS.id}=`])).toBeUndefined();
  });

  it("keys summoned on the id: other summon arguments alone are not a summon", () => {
    expect(
      summonedFromArgs([
        `${SUMMON_ARGS.kind}=ecs`,
        `${SUMMON_ARGS.mode}=exit-on-idle`,
        `${SUMMON_ARGS.queue}=emails`,
        `${SUMMON_ARGS.maxLifetimeMs}=1000`,
      ]),
    ).toBeUndefined();
    // Negative control: the same arguments plus an id are one.
    expect(
      summonedFromArgs([`${SUMMON_ARGS.kind}=ecs`, `${SUMMON_ARGS.id}=a1`]),
    ).toEqual({ id: "a1", kind: "ecs" });
  });

  it("reads every argument, and computes the deadline from its own clock", () => {
    const before = Date.now();
    const summon = summonedFromArgs(FULL_ARGS);
    const after = Date.now();

    expect(summon).toMatchObject({
      id: "attempt-1",
      kind: "ecs",
      mode: "until-stopped",
      namespace: "shop",
      queue: "emails",
      maxLifetimeMs: 60_000,
      graceMs: 10_000,
    });
    expect(summon!.deadlineAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(summon!.deadlineAt).toBeLessThanOrEqual(after + 60_000);
    expect(summon).not.toHaveProperty("handle");
  });

  it("never invents a mode or a deadline the summoner did not pass", () => {
    const summon = summonedFromArgs([`${SUMMON_ARGS.id}=a1`]);
    expect(summon).toEqual({ id: "a1" });
    expect(summon).not.toHaveProperty("mode");
    expect(summon).not.toHaveProperty("deadlineAt");
  });

  it("reads only the = form, and the last of a repeated argument wins", () => {
    expect(
      summonedFromArgs([
        `${SUMMON_ARGS.id}=first`,
        `${SUMMON_ARGS.id}=second`,
        SUMMON_ARGS.kind,
        "render",
      ]),
    ).toEqual({ id: "second" });
    // A bare flag followed by a value is not read.
    expect(summonedFromArgs([SUMMON_ARGS.id, "a1"])).toBeUndefined();
  });

  it("refuses a malformed mode or duration rather than recording it", () => {
    const id = `${SUMMON_ARGS.id}=a1`;
    for (const mode of ["launch", "in-handler", "service"]) {
      expect(() =>
        summonedFromArgs([id, `${SUMMON_ARGS.mode}=${mode}`]),
      ).toThrow(ConfigError);
    }
    for (const bad of ["5s", "-1", "1.5", "1e3", "abc"]) {
      expect(() =>
        summonedFromArgs([id, `${SUMMON_ARGS.maxLifetimeMs}=${bad}`]),
      ).toThrow(ConfigError);
      expect(() =>
        summonedFromArgs([id, `${SUMMON_ARGS.graceMs}=${bad}`]),
      ).toThrow(ConfigError);
    }
    for (const mode of ["exit-on-idle", "until-stopped", "in-invocation"]) {
      expect(summonedFromArgs([id, `${SUMMON_ARGS.mode}=${mode}`])?.mode).toBe(
        mode as WorkerSummonProvenance["mode"],
      );
    }
  });

  it("never reads provenance from the environment", async () => {
    await withEnv(
      {
        BUN_JOBS_SUMMON_ID: "from-env",
        BUN_JOBS_SUMMON_KIND: "ecs",
        BUN_JOBS_SUMMON_MODE: "exit-on-idle",
      },
      () => {
        expect(summonedFromArgs([])).toBeUndefined();
        // The default argv is this test runner's, which carries no summon.
        expect(summonedFromArgs()).toBeUndefined();
      },
    );
  });

  it("reads process.argv by default", () => {
    const saved = process.argv;
    process.argv = [...saved, `${SUMMON_ARGS.id}=from-argv`];
    try {
      expect(summonedFromArgs()).toEqual({ id: "from-argv" });
    } finally {
      process.argv = saved;
    }
    expect(summonedFromArgs()).toBeUndefined();
  });
});

/* --- the runner-child marker, layer by layer ------------------------------- */

describe("the runner-child marker: refuse-only defence in depth", () => {
  const argv = [`${SUMMON_ARGS.id}=attempt-1`];

  it("refuses provenance when the marker is set, even with the arguments visible", () => {
    // A `Worker` thread runs in its parent's process. Bun gives it an empty
    // argv today; Node copies the parent's. This is the thread that *does*
    // see the arguments, as it would under Node's semantics.
    expect(parseSummonArgs(argv, "1")).toBeUndefined();
  });

  it("negative control: without the marker layer, that thread would claim the attempt", () => {
    expect(parseSummonArgs(argv, undefined)).toEqual({ id: "attempt-1" });
    // A marker value the runner never writes refuses nothing.
    expect(parseSummonArgs(argv, "0")).toEqual({ id: "attempt-1" });
  });

  it("summonedFromArgs reads the real marker from process.env", async () => {
    expect(process.env[CHILD_ENV.marker]).toBeUndefined();
    expect(summonedFromArgs(argv)?.id).toBe("attempt-1");
    await withEnv({ [CHILD_ENV.marker]: "1" }, () => {
      expect(summonedFromArgs(argv)).toBeUndefined();
    });
  });

  it("the marker only refuses: it never makes an unsummoned process summoned", async () => {
    for (const marker of ["0", "1"]) {
      await withEnv({ [CHILD_ENV.marker]: marker }, () => {
        expect(summonedFromArgs([])).toBeUndefined();
      });
    }
  });
});

/* --- a runner child's own arguments ---------------------------------------- */

describe("a runner child's own arguments never read as a summon", () => {
  const cases: {
    mode: ExecutionMode;
    options: Partial<BunRunnerOptions<any>>;
  }[] = [
    {
      mode: "child-process",
      options: { spawn: { args: [`${SUMMON_ARGS.id}=attempt-1`] } },
    },
    {
      mode: "worker-thread",
      options: { worker: { argv: [`${SUMMON_ARGS.id}=attempt-1`] } },
    },
  ];

  for (const { mode, options } of cases) {
    it(`in a runner's ${mode} child`, async () => {
      const runner = new BunRunner({
        id: `summon-args-${mode}`,
        namespace: testNamespace(),
        file: fixture("handlers", "summon-args"),
        executionMode: mode,
        driver: new MemoryDriver(),
        waitToExit: false,
        logger: noopLogger,
        ...options,
      } as BunRunnerOptions<any>);
      closers.push(() => runner.stop({ force: true }));
      await runner.start();

      const settled = new Promise<{
        summon: unknown;
        argv: string[];
        marker: string | null;
      }>((resolve, reject) => {
        runner.once("finished", (_record, result) => {
          resolve(result as never);
        });
        runner.once("failed", (_record, error) => reject(error));
      });
      await runner.trigger({});
      const report = await settled;

      // The child's own arguments do carry a summon id...
      expect(report.argv).toContain(`${SUMMON_ARGS.id}=attempt-1`);
      expect(report.marker).toBe("1");
      // ...and the marker is what refuses it.
      expect(report.summon).toBeNull();
    }, 20_000);
  }
});

/* --- descendants of a summoned process ------------------------------------- */

/** What `summoned-parent.ts` prints. */
interface ParentReport {
  /** `summonedFromArgs()` in the summoned parent itself. */
  self: { id: string; kind?: string } | null;
  /** `BUN_JOBS_SUMMON_ID` in the parent after it deleted it. */
  envAfterDelete: string | null;
  /** A `Bun.spawn` child of the main thread. */
  mainThread: ProbeReport;
  /** A `Bun.spawn` child of an in-process processor. */
  inProcess: ProbeReport;
  /** A worker-thread target's thread, and a `Bun.spawn` child of it. */
  workerThread: {
    here: unknown;
    hereArgv: string[];
    hereMarker: string | null;
    spawned: ProbeReport;
  };
}

/** Runs `summoned-parent.ts` once, as a summon would start it. */
async function runSummonedParent(): Promise<ParentReport> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      fixture("processes", "summoned-parent"),
      `${SUMMON_ARGS.id}=attempt-1`,
      `${SUMMON_ARGS.kind}=ecs`,
    ],
    // Also in the parent's *startup* environment, which is what `Bun.spawn`
    // with no `env` hands on: the old channel's leak, reproduced.
    env: { ...process.env, BUN_JOBS_SUMMON_ID: "attempt-1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`summoned-parent exited ${code}: ${err}`);
  }
  return JSON.parse(out.trim().split("\n").at(-1)!) as ParentReport;
}

describe("descendants of a summoned process", () => {
  let parent: Promise<ParentReport> | undefined;
  /** The parent's report, run once for every case below. */
  const report = () => (parent ??= runSummonedParent());

  it("positive control: the parent itself is summoned, and deleted the variable", async () => {
    const { self, envAfterDelete } = await report();
    expect(self).toEqual({ id: "attempt-1", kind: "ecs" });
    expect(envAfterDelete).toBeNull();
  }, 60_000);

  const spawned: [string, (r: ParentReport) => ProbeReport][] = [
    ["from the main thread", (r) => r.mainThread],
    ["from an in-process processor", (r) => r.inProcess],
    ["from a worker-thread target's thread", (r) => r.workerThread.spawned],
  ];

  for (const [where, pick] of spawned) {
    it(`a Bun.spawn child with no env, ${where}, is not summoned`, async () => {
      const probe = pick(await report());
      expect(probe.args).toBeNull();
      // Arguments are not inherited: that is the fix, and the reason.
      expect(probe.argv).toEqual([]);
      // Nor did the marker do the work: the probe is not a runner child.
      expect(probe.marker).toBeNull();
    }, 60_000);

    it(`negative control: the env channel would have leaked ${where}`, async () => {
      // The draft read BUN_JOBS_SUMMON_ID. The parent deleted it, and the
      // child still has it: `Bun.spawn` passed the startup environment.
      expect(pick(await report()).legacyEnv).toBe("attempt-1");
    }, 60_000);
  }

  it("the worker-thread target's thread itself is not summoned", async () => {
    const thread = (await report()).workerThread;
    expect(thread.here).toBeNull();
    // Both layers hold independently here: Bun gives the thread no argv...
    expect(thread.hereArgv).toEqual([]);
    // ...and the thread carries the marker that would refuse it anyway.
    expect(thread.hereMarker).toBe("1");
  }, 60_000);
});

/* --- the heartbeat record -------------------------------------------------- */

/** A reporting worker on `driver`, and a way to read its record. */
function reporting(
  driver: JobsDriver,
  summon: WorkerSummonProvenance | undefined,
) {
  const namespace = testNamespace();
  const worker = new BunQueueWorker("summoned", async () => null, {
    namespace,
    driver,
    logger: noopLogger,
    reportInterval: 40,
    pollInterval: 10,
    waitToExit: false,
    ...(summon === undefined ? {} : { summon }),
  });
  closers.push(() => worker.close({ force: true }));
  void worker.run();
  return {
    worker,
    /** The record, once a report newer than heartbeat `after` has landed. */
    async record(after = 0): Promise<WorkerInfo> {
      let found: WorkerInfo | undefined;
      await waitFor(
        async () => {
          found = (
            await listWorkerRecords(
              driver,
              { ns: namespace, queue: "summoned" },
              Date.now(),
            )
          ).find((info) => info.id === worker.id);
          return found !== undefined && found.heartbeatAt > after;
        },
        { timeout: 10_000, message: "the worker never reported" },
      );
      return found!;
    },
  };
}

/** A memory driver that cannot store worker records (`supportsWorkers` false). */
function recordlessDriver(): MemoryDriver {
  const driver = new MemoryDriver();
  for (const method of ["registerWorker", "getQueueState"]) {
    Object.defineProperty(driver, method, { value: undefined });
  }
  return driver;
}

describe("summon: the heartbeat record", () => {
  it("writes the option on the first report, and on every report after", async () => {
    const summon = {
      id: "a1",
      kind: "ecs",
      handle: "arn:aws:ecs:eu-west-1:123456789012:task/c/1",
      mode: "exit-on-idle" as const,
      deadlineAt: 1_900_000_000_000,
    };
    const { record } = reporting(new MemoryDriver(), summon);

    const first = await record();
    expect(first.summon).toEqual(summon);
    const later = await record(first.heartbeatAt);
    expect(later.summon).toEqual(summon);
  });

  it("writes only the five provenance fields, not summonedFromArgs' extras", async () => {
    const fromArgs = summonedFromArgs(FULL_ARGS)!;
    const { record } = reporting(new MemoryDriver(), fromArgs);

    const { summon } = await record();
    expect(summon).toEqual({
      id: "attempt-1",
      kind: "ecs",
      mode: "until-stopped",
      deadlineAt: fromArgs.deadlineAt!,
    });
    for (const extra of ["namespace", "queue", "maxLifetimeMs", "graceMs"]) {
      expect(summon).not.toHaveProperty(extra);
    }
  });

  it("leaves a mode the summoner did not request absent on the record and DTO", async () => {
    const { record } = reporting(new MemoryDriver(), { id: "a1" });
    const info = await record();
    expect(info.summon).toEqual({ id: "a1" });
    expect("mode" in info.summon!).toBe(false);
    const dto = toWorkerDto(info, { exposeHosts: true });
    expect(dto.summon).toEqual({ id: "a1" });
  });

  it("leaves summon off an unsummoned worker's record: absent, never defaulted", async () => {
    for (const summon of [undefined, summonedFromArgs([])]) {
      const { record } = reporting(new MemoryDriver(), summon);
      const info = await record();
      expect("summon" in info).toBe(false);
      expect("summon" in toWorkerDto(info, { exposeHosts: true })).toBe(false);
    }
  });

  it("refuses summon with reportInterval 0: the attempt could never be released", () => {
    const driver = new MemoryDriver();
    expect(
      () =>
        new BunQueueWorker("q", async () => null, {
          namespace: testNamespace(),
          driver,
          reportInterval: 0,
          summon: { id: "a1" },
        }),
    ).toThrow(ConfigError);
    // Negative control: the same worker without `summon` is fine.
    const plain = new BunQueueWorker("q", async () => null, {
      namespace: testNamespace(),
      driver,
      reportInterval: 0,
      logger: noopLogger,
    });
    closers.push(() => plain.close({ force: true }));
  });

  it("refuses summon on a driver that cannot store worker records", () => {
    expect(
      () =>
        new BunQueueWorker("q", async () => null, {
          namespace: testNamespace(),
          driver: recordlessDriver(),
          summon: { id: "a1" },
        }),
    ).toThrow(ConfigError);
    // Negative controls: that driver without `summon`, and `summon` on an
    // ordinary memory driver, are both fine.
    const fine: [MemoryDriver, WorkerSummonProvenance | undefined][] = [
      [recordlessDriver(), undefined],
      [new MemoryDriver(), { id: "a1" }],
    ];
    for (const [driver, summon] of fine) {
      const worker = new BunQueueWorker("q", async () => null, {
        namespace: testNamespace(),
        driver,
        logger: noopLogger,
        ...(summon === undefined ? {} : { summon }),
      });
      closers.push(() => worker.close({ force: true }));
    }
  });

  it("refuses a malformed summon option in the constructor", () => {
    const bad: unknown[] = [
      {},
      { mode: "exit-on-idle" },
      { id: "" },
      { id: 7 },
      { id: "a1", mode: "launch" },
      { id: "a1", kind: "" },
      { id: "a1", kind: 7 },
      { id: "a1", deadlineAt: Number.NaN },
      { id: "a1", deadlineAt: 1.5 },
      { id: "a1", deadlineAt: -1 },
      "a1",
      null,
    ];
    for (const summon of bad) {
      expect(
        () =>
          new BunQueueWorker("q", async () => null, {
            namespace: testNamespace(),
            driver: new MemoryDriver(),
            summon: summon as WorkerSummonProvenance,
          }),
      ).toThrow(ConfigError);
    }
  });

  for (const server of servers) {
    it.skipIf(!server.available)(
      `round-trips summon through ${server.name}`,
      async () => {
        const driver = createDriver(server.config);
        closers.push(() => driver.close());
        const summon = {
          id: "a1",
          kind: "fly",
          mode: "in-invocation" as const,
          deadlineAt: 1_900_000_000_000,
        };
        const { record, worker } = reporting(driver, summon);

        expect((await record()).summon).toEqual(summon);
        await worker.close();
      },
      30_000,
    );
  }
});

/* --- the DTO --------------------------------------------------------------- */

describe("summon: WorkerDto", () => {
  /** A stored record carrying a summon, as a driver returns it. */
  const record = (summon: WorkerInfo["summon"]): WorkerInfo => ({
    id: "w",
    queue: "mail",
    host: "h",
    pid: 1,
    concurrency: 1,
    active: 0,
    paused: false,
    startedAt: 1,
    heartbeatAt: 2,
    expiresAt: 3,
    ...(summon === undefined ? {} : { summon }),
  });
  const arn = "arn:aws:ecs:eu-west-1:123456789012:task/c/1";

  it("withholds the platform handle by default, even with exposeHosts on", () => {
    const info = record({
      id: "a1",
      kind: "ecs",
      handle: arn,
      mode: "exit-on-idle",
      deadlineAt: 9,
    });

    expect(toWorkerDto(info, { exposeHosts: true }).summon).toEqual({
      id: "a1",
      kind: "ecs",
      mode: "exit-on-idle",
      deadlineAt: 9,
    });
    expect(
      toWorkerDto(info, { exposeHosts: true, exposeSummonHandles: false })
        .summon,
    ).not.toHaveProperty("handle");
  });

  it("serves the handle with exposeSummonHandles, whatever exposeHosts says", () => {
    const info = record({ id: "a1", handle: arn });
    for (const exposeHosts of [true, false]) {
      expect(
        toWorkerDto(info, { exposeHosts, exposeSummonHandles: true }).summon,
      ).toEqual({ id: "a1", handle: arn });
    }
  });

  it("copies field by field, so nothing else on a stored summon leaks", () => {
    const info = record({
      id: "a1",
      secret: "x",
    } as unknown as WorkerSummonProvenance);
    expect(
      toWorkerDto(info, { exposeHosts: true, exposeSummonHandles: true })
        .summon,
    ).toEqual({ id: "a1" });
  });

  it("leaves summon off a record from an older worker", () => {
    expect(
      "summon" in toWorkerDto(record(undefined), { exposeHosts: true }),
    ).toBe(false);
  });
});
