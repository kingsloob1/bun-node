import type {
  BunRunnerOptions,
  ExecutionMode,
  JobsDriver,
  WorkerInfo,
  WorkerSummonProvenance,
  WorkerTargetMode,
} from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { toWorkerDto } from "../lib/api/serialize";
import {
  BunQueue,
  BunQueueWorker,
  BunRunner,
  CHILD_ENV,
  ConfigError,
  createDriver,
  listWorkerRecords,
  MemoryDriver,
  SUMMON_ENV,
  summonedFromEnv,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Summon provenance (Phase 1.5, PR-2): a worker says it was summoned, by what
 * and until when, on its heartbeat record and through the management API; and
 * `summonedFromEnv()` builds that from the `BUN_JOBS_SUMMON_*` keys — except
 * inside a runner child, which inherits its parent's environment and must not
 * claim the parent's summon attempt.
 */

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

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
  body: () => Promise<T>,
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

/** Every summon key set, as a controller's summon would pass them. */
const FULL_ENV = {
  [SUMMON_ENV.id]: "attempt-1",
  [SUMMON_ENV.kind]: "ecs",
  [SUMMON_ENV.mode]: "until-stopped",
  [SUMMON_ENV.namespace]: "shop",
  [SUMMON_ENV.queue]: "emails",
  [SUMMON_ENV.maxLifetimeMs]: "60000",
  [SUMMON_ENV.graceMs]: "10000",
};

/* --- summonedFromEnv ------------------------------------------------------- */

describe("summonedFromEnv", () => {
  it("names every key under BUN_JOBS_SUMMON_*", () => {
    for (const key of Object.values(SUMMON_ENV)) {
      expect(key.startsWith("BUN_JOBS_SUMMON_")).toBe(true);
    }
    // Never the runner child's namespace key, whatever the summon passes.
    expect(Object.values(SUMMON_ENV)).not.toContain(CHILD_ENV.namespace);
  });

  it("is undefined when no summon key is set", () => {
    expect(summonedFromEnv({}, [])).toBeUndefined();
    expect(
      summonedFromEnv({ PATH: "/usr/bin", HOME: "/root" }, [
        "bun",
        "worker.ts",
      ]),
    ).toBeUndefined();
    // An empty value counts as unset.
    expect(summonedFromEnv({ [SUMMON_ENV.id]: "" }, [])).toBeUndefined();
  });

  it("reads every key, and computes the deadline from its own clock", () => {
    const before = Date.now();
    const summon = summonedFromEnv(FULL_ENV, []);
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
    // Never read from the environment: see its doc comment.
    expect(summon).not.toHaveProperty("handle");
  });

  it("defaults the mode to exit-on-idle, and leaves the rest absent", () => {
    expect(summonedFromEnv({ [SUMMON_ENV.id]: "a1" }, [])).toEqual({
      id: "a1",
      mode: "exit-on-idle",
    });
  });

  it("does not read the bare BUN_JOBS_NAMESPACE / BUN_JOBS_QUEUE keys", () => {
    // The draft's names. The first is the runner child's `CHILD_ENV.namespace`,
    // so it must never make a process look summoned.
    expect(
      summonedFromEnv(
        { BUN_JOBS_NAMESPACE: "shop", BUN_JOBS_QUEUE: "emails" },
        [],
      ),
    ).toBeUndefined();
  });

  it("reads --bun-jobs-summon-*= arguments, with the environment winning", () => {
    expect(
      summonedFromEnv({}, [
        "bun",
        "worker.ts",
        "--bun-jobs-summon-id=from-argv",
        "--bun-jobs-summon-kind=render",
        "--bun-jobs-summon-max-lifetime-ms=1000",
      ]),
    ).toMatchObject({
      id: "from-argv",
      kind: "render",
      mode: "exit-on-idle",
      maxLifetimeMs: 1_000,
    });

    const both = summonedFromEnv({ [SUMMON_ENV.id]: "from-env" }, [
      "--bun-jobs-summon-id=from-argv",
      "--bun-jobs-summon-kind=render",
    ]);
    expect(both).toMatchObject({ id: "from-env", kind: "render" });

    // The last of a repeated argument wins; a bare flag is not the `=` form.
    expect(
      summonedFromEnv({}, [
        "--bun-jobs-summon-id=first",
        "--bun-jobs-summon-id=second",
        "--bun-jobs-summon-kind",
      ]),
    ).toEqual({ id: "second", mode: "exit-on-idle" });
  });

  it("refuses a malformed mode or duration rather than recording it", () => {
    expect(() => summonedFromEnv({ [SUMMON_ENV.mode]: "launch" }, [])).toThrow(
      ConfigError,
    );
    expect(() =>
      summonedFromEnv({ [SUMMON_ENV.mode]: "in-handler" }, []),
    ).toThrow(ConfigError);
    for (const bad of ["5s", "-1", "1.5", "1e3", "abc"]) {
      expect(() =>
        summonedFromEnv({ [SUMMON_ENV.maxLifetimeMs]: bad }, []),
      ).toThrow(ConfigError);
      expect(() => summonedFromEnv({ [SUMMON_ENV.graceMs]: bad }, [])).toThrow(
        ConfigError,
      );
    }
    // Every approved mode parses.
    for (const mode of ["exit-on-idle", "until-stopped", "in-invocation"]) {
      expect(summonedFromEnv({ [SUMMON_ENV.mode]: mode }, [])?.mode).toBe(
        mode as WorkerSummonProvenance["mode"],
      );
    }
  });

  it("is undefined when the runner-child marker is set, and only then", () => {
    const child = { ...FULL_ENV, [CHILD_ENV.marker]: "1" };
    expect(summonedFromEnv(child, [])).toBeUndefined();
    // Nor does an argument get past the guard.
    expect(
      summonedFromEnv({ [CHILD_ENV.marker]: "1" }, [
        "--bun-jobs-summon-id=from-argv",
      ]),
    ).toBeUndefined();

    // Negative controls: the same keys without the marker, or with a marker
    // value the runner never writes, are a summoned process.
    expect(summonedFromEnv(FULL_ENV, [])?.id).toBe("attempt-1");
    expect(
      summonedFromEnv({ ...FULL_ENV, [CHILD_ENV.marker]: "0" }, [])?.id,
    ).toBe("attempt-1");
  });

  it("reads process.env and process.argv by default", async () => {
    expect(process.env[CHILD_ENV.marker]).toBeUndefined();
    await withEnv(
      { [SUMMON_ENV.id]: "defaults", [SUMMON_ENV.kind]: "fly" },
      async () => {
        expect(summonedFromEnv()).toEqual({
          id: "defaults",
          kind: "fly",
          mode: "exit-on-idle",
        });
      },
    );
    expect(summonedFromEnv()).toBeUndefined();
  });
});

/* --- inside a real runner child -------------------------------------------- */

/** The fixtures' report: what the child saw, and what it answered. */
interface ChildReport {
  /** `BUN_JOBS_CHILD` in the child. */
  marker: string | null;
  /** `BUN_JOBS_SUMMON_ID` in the child: proof the parent's key arrived. */
  inherited: string | null;
  /** `summonedFromEnv()` in the child. */
  summon: unknown;
  /** `summonedFromEnv()` over the child's env minus the marker. */
  unmarked: { id?: string } | null;
}

/** What every child below must report, having inherited `attempt-1`. */
function expectGuarded(report: ChildReport): void {
  expect(report.marker).toBe("1");
  // The key reached the child, so a null answer is the guard's doing...
  expect(report.inherited).toBe("attempt-1");
  expect(report.summon).toBeNull();
  // ...as the negative control shows: without the marker it parses.
  expect(report.unmarked?.id).toBe("attempt-1");
}

describe("summonedFromEnv inside a runner child", () => {
  const modes: ExecutionMode[] = ["spawn", "worker"];

  for (const mode of modes) {
    it(`answers undefined in a runner's ${mode} child that inherited the keys`, async () => {
      await withEnv(FULL_ENV, async () => {
        // The parent itself is summoned: the child inherits exactly that.
        expect(summonedFromEnv()?.id).toBe("attempt-1");

        const runner = new BunRunner({
          id: `summon-${mode}`,
          namespace: testNamespace(),
          file: fixture("summon-env"),
          executionMode: mode,
          driver: new MemoryDriver(),
          waitToExit: false,
          logger: noopLogger,
        } as BunRunnerOptions<any>);
        closers.push(() => runner.stop({ force: true }));
        await runner.start();

        const settled = new Promise<ChildReport>((resolve, reject) => {
          runner.once("finished", (_record, result) => {
            resolve(result as ChildReport);
          });
          runner.once("failed", (_record, error) => reject(error));
        });
        await runner.trigger({});
        expectGuarded(await settled);
      });
    }, 20_000);
  }

  const targets: WorkerTargetMode[] = ["child-process", "worker-thread"];

  for (const target of targets) {
    it(`answers undefined in a worker target's ${target}`, async () => {
      await withEnv(FULL_ENV, async () => {
        const driver = new MemoryDriver();
        const namespace = testNamespace();
        const queue = new BunQueue("summon-target", { namespace, driver });
        closers.push(() => queue.close());
        const worker = new BunQueueWorker(
          "summon-target",
          fixture("job-summon-env"),
          {
            namespace,
            driver,
            target,
            logger: noopLogger,
            pollInterval: 10,
            waitToExit: false,
          },
        );
        closers.push(() => worker.close({ force: true }));
        void worker.run();

        const job = await queue.add("probe", {}, { removeOnComplete: false });
        let report: ChildReport | undefined;
        await waitFor(
          async () => {
            const stored = await queue.getJob(job.id);
            report = stored?.returnValue as ChildReport | undefined;
            return stored?.state === "completed";
          },
          { timeout: 20_000, message: "the probe job never completed" },
        );
        expectGuarded(report!);
      });
    }, 30_000);
  }
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

describe("summon: the heartbeat record", () => {
  it("writes the option on the first report, and on every report after", async () => {
    const summon = {
      id: "a1",
      kind: "ecs",
      handle: "arn:task/1",
      mode: "exit-on-idle" as const,
      deadlineAt: 1_900_000_000_000,
    };
    const { record } = reporting(new MemoryDriver(), summon);

    const first = await record();
    expect(first.summon).toEqual(summon);
    const later = await record(first.heartbeatAt);
    expect(later.summon).toEqual(summon);
  });

  it("writes only the five provenance fields, not summonedFromEnv's extras", async () => {
    const fromEnv = summonedFromEnv(FULL_ENV, [])!;
    const { record } = reporting(new MemoryDriver(), fromEnv);

    const { summon } = await record();
    expect(summon).toEqual({
      id: "attempt-1",
      kind: "ecs",
      mode: "until-stopped",
      deadlineAt: fromEnv.deadlineAt!,
    });
    for (const extra of ["namespace", "queue", "maxLifetimeMs", "graceMs"]) {
      expect(summon).not.toHaveProperty(extra);
    }
  });

  it("leaves summon off an unsummoned worker's record: absent, never defaulted", async () => {
    for (const summon of [undefined, summonedFromEnv({}, [])]) {
      const { record } = reporting(new MemoryDriver(), summon);
      const info = await record();
      expect("summon" in info).toBe(false);
      const dto = toWorkerDto(info, { exposeHosts: true });
      expect("summon" in dto).toBe(false);
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
          summon: { mode: "exit-on-idle" },
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

  it("refuses a malformed summon option in the constructor", () => {
    const bad: unknown[] = [
      { mode: "launch" },
      { id: "a1" },
      { mode: "exit-on-idle", id: "" },
      { mode: "exit-on-idle", kind: 7 },
      { mode: "exit-on-idle", deadlineAt: Number.NaN },
      { mode: "exit-on-idle", deadlineAt: 1.5 },
      { mode: "exit-on-idle", deadlineAt: -1 },
      "exit-on-idle",
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
        // A closing worker removes its record, so nothing is left behind.
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

  it("withholds the platform handle unless exposeHosts is on", () => {
    const info = record({
      id: "a1",
      kind: "ecs",
      handle: "arn:task/1",
      mode: "exit-on-idle",
      deadlineAt: 9,
    });

    expect(toWorkerDto(info, { exposeHosts: false }).summon).toEqual({
      id: "a1",
      kind: "ecs",
      mode: "exit-on-idle",
      deadlineAt: 9,
    });
    expect(toWorkerDto(info, { exposeHosts: true }).summon).toEqual({
      id: "a1",
      kind: "ecs",
      handle: "arn:task/1",
      mode: "exit-on-idle",
      deadlineAt: 9,
    });
  });

  it("copies field by field, so nothing else on a stored summon leaks", () => {
    const info = record({
      mode: "until-stopped",
      secret: "x",
    } as unknown as WorkerSummonProvenance);
    expect(toWorkerDto(info, { exposeHosts: true }).summon).toEqual({
      mode: "until-stopped",
    });
  });

  it("leaves summon off a record from an older worker", () => {
    expect(
      "summon" in toWorkerDto(record(undefined), { exposeHosts: true }),
    ).toBe(false);
  });
});
