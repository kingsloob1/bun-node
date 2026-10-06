import type {
  JobsDriver,
  SummonReleaseRequest,
  SummonRequest,
  WorkerInfo,
  WorkerSummonProvenance,
} from "../lib/index";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { toWorkerDto } from "../lib/api/serialize";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  createDriver,
  defineSummoner,
  listWorkerRecords,
  MemoryDriver,
  SUMMON_ARGS,
  SummonController,
  summonedFromArgs,
} from "../lib/index";
import { spawnUnit, unitLines } from "../lib/provider/testing/spawn";
import { parseSummonArgs } from "../lib/summon/args";
import { wireRequest } from "../lib/summon/controller";
import { attemptId, dedupeKeyFor } from "../lib/summon/marker";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Summon multi-queue, PR-B1 (`docs/plans/summon-multi-queue.md` §4.7, §4.8,
 * §6): the arguments repeat `--bun-jobs-summon-queue=` once per queue and add
 * `--bun-jobs-summon-group=`; `summonedFromArgs()` collects them; a worker
 * writes the group on its record; a request carries `queues`; and a
 * single-queue argv and attempt id stay byte-identical to what they were.
 */

const cleanups: (() => Promise<void>)[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});
afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});
const servers = await crossProcessBackends({ cleanups });

/** The context a controller builds a request in, for one queue. */
const ONE = {
  namespace: "shop",
  queue: "emails",
  kind: "ecs",
  style: "launch" as const,
  dedupeKey: dedupeKeyFor({ kind: "none" }),
  graceMs: 10_000,
  maxLifetime: 3_600_000,
  env: Object.freeze({ A: "1" }),
};

/** An attempt id, pinned: it must not change with this PR (§6). */
const PINNED_ID = "sm_gltizu3zmjlkpt5yrclffo6rdo";

/** The single-queue argv as `develop` wrote it before this PR, byte for byte. */
const PINNED_ARGV = [
  "--bun-jobs-summon-id=sm_gltizu3zmjlkpt5yrclffo6rdo",
  "--bun-jobs-summon-kind=ecs",
  "--bun-jobs-summon-mode=exit-on-idle",
  "--bun-jobs-summon-namespace=shop",
  "--bun-jobs-summon-queue=emails",
  "--bun-jobs-summon-max-lifetime-ms=3600000",
  "--bun-jobs-summon-grace-ms=10000",
];

/* --- the arguments a request carries --------------------------------------- */

describe("wireRequest: one queue is byte-identical (§6)", () => {
  it("keeps the attempt id and the argv exactly as before", () => {
    const id = attemptId("shop", "emails", "0123456789abcdef".repeat(2), 1);
    expect(id).toBe(PINNED_ID);
    const request = wireRequest({ id, count: 2, target: 3 }, ONE);
    expect([...request.argv]).toEqual(PINNED_ARGV);
    expect(request.argv.join("\u0000")).toBe(PINNED_ARGV.join("\u0000"));
    expect(request.queue).toBe("emails");
    expect(request.queues).toEqual(["emails"]);
    expect(Object.isFrozen(request.queues)).toBe(true);
    expect("group" in request).toBe(false);
    expect("demands" in request).toBe(false);
  });

  it("writes no group argument for one queue, even when given a group", () => {
    const request = wireRequest(
      { id: PINNED_ID, count: 1, target: 1 },
      { ...ONE, queues: ["emails"], group: "media" },
    );
    expect([...request.argv]).toEqual(PINNED_ARGV);
    expect("group" in request).toBe(false);
  });
});

describe("wireRequest: several queues (B5)", () => {
  const SHARED = {
    ...ONE,
    queue: "renders",
    queues: ["renders", "thumbs", "previews"],
    group: "media",
  };

  it("repeats the queue argument once per queue, in order, after the group", () => {
    const request = wireRequest({ id: PINNED_ID, count: 1, target: 1 }, SHARED);
    expect([...request.argv]).toEqual([
      `${SUMMON_ARGS.id}=${PINNED_ID}`,
      `${SUMMON_ARGS.kind}=ecs`,
      `${SUMMON_ARGS.mode}=exit-on-idle`,
      `${SUMMON_ARGS.namespace}=shop`,
      "--bun-jobs-summon-group=media",
      `${SUMMON_ARGS.queue}=renders`,
      `${SUMMON_ARGS.queue}=thumbs`,
      `${SUMMON_ARGS.queue}=previews`,
      `${SUMMON_ARGS.maxLifetimeMs}=3600000`,
      `${SUMMON_ARGS.graceMs}=10000`,
    ]);
    expect(request.queue).toBe("renders");
    expect(request.queues).toEqual(["renders", "thumbs", "previews"]);
    expect(request.group).toBe("media");
  });

  it("is a function of the policy's order, so a retried call is identical", () => {
    const one = wireRequest({ id: PINNED_ID, count: 1, target: 1 }, SHARED);
    const two = wireRequest({ id: PINNED_ID, count: 1, target: 1 }, SHARED);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    const reversed = wireRequest(
      { id: PINNED_ID, count: 1, target: 1 },
      {
        ...SHARED,
        queue: "previews",
        queues: ["previews", "thumbs", "renders"],
      },
    );
    expect(
      reversed.argv.filter((arg) => arg.startsWith(`${SUMMON_ARGS.queue}=`)),
    ).toEqual([
      `${SUMMON_ARGS.queue}=previews`,
      `${SUMMON_ARGS.queue}=thumbs`,
      `${SUMMON_ARGS.queue}=renders`,
    ]);
  });

  it("writes no group argument when several queues have no group", () => {
    const { group: _group, ...noGroup } = SHARED;
    const request = wireRequest(
      { id: PINNED_ID, count: 1, target: 1 },
      noGroup,
    );
    expect(request.argv.some((arg) => arg.includes("summon-group"))).toBe(
      false,
    );
    expect("group" in request).toBe(false);
  });

  it("refuses a queue named twice, and a first queue that is not `queue`", () => {
    expect(() =>
      wireRequest(
        { id: PINNED_ID, count: 1, target: 1 },
        { ...SHARED, queues: ["renders", "thumbs", "renders"] },
      ),
    ).toThrow(ConfigError);
    expect(() =>
      wireRequest(
        { id: PINNED_ID, count: 1, target: 1 },
        { ...SHARED, queue: "thumbs" },
      ),
    ).toThrow(ConfigError);
    expect(() =>
      wireRequest(
        { id: PINNED_ID, count: 1, target: 1 },
        { ...SHARED, queues: [] },
      ),
    ).toThrow(ConfigError);
  });
});

describe("wireRequest: the 8 KiB argument limit (Q10)", () => {
  /** `n` distinct queue names of `length` characters each. */
  const names = (n: number, length: number): string[] =>
    Array.from({ length: n }, (_, index) => `${index}`.padStart(length, "q"));
  /** The bytes an argv takes on a command line: each argument plus a separator. */
  const bytes = (argv: readonly string[]): number =>
    argv.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0);

  it("refuses an argv over 8 KiB with a ConfigError naming the size", () => {
    const queues = names(40, 200);
    let thrown: unknown;
    try {
      wireRequest(
        { id: PINNED_ID, count: 1, target: 1 },
        { ...ONE, queue: queues[0]!, queues, group: "big" },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toContain("8 KiB");
    expect((thrown as ConfigError).context).toMatchObject({
      limit: 8192,
      queues: 40,
    });
  });

  it("accepts one at exactly 8 KiB, and refuses one byte more", () => {
    // Find a queue count and a last name length that land on 8192 exactly.
    const base = (queues: string[]) =>
      wireRequest(
        { id: PINNED_ID, count: 1, target: 1 },
        { ...ONE, queue: queues[0]!, queues, group: "g" },
      ).argv;
    // The most full-length queues that leave room for one more, short one.
    const each = `${SUMMON_ARGS.queue}=`.length + 200 + 1;
    let short = names(1, 200);
    while (bytes(base(short)) + each < 8192) {
      short = names(short.length + 1, 200);
    }
    const room = 8192 - bytes(base(short)) - `${SUMMON_ARGS.queue}=`.length - 1;
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThanOrEqual(200);
    const exact = [...short, "x".repeat(room)];
    expect(bytes(base(exact))).toBe(8192);
    expect(() => base([...short, "x".repeat(room + 1)])).toThrow(ConfigError);
  });
});

/* --- summonedFromArgs ------------------------------------------------------ */

describe("summonedFromArgs: several queues and a group", () => {
  it("collects every queue argument in order, dropping repeats; queue is the first", () => {
    const summon = summonedFromArgs([
      "bun",
      "unit.ts",
      `${SUMMON_ARGS.id}=a1`,
      `${SUMMON_ARGS.queue}=renders`,
      `${SUMMON_ARGS.queue}=thumbs`,
      `${SUMMON_ARGS.queue}=renders`,
      `${SUMMON_ARGS.queue}=`,
      `${SUMMON_ARGS.queue}=previews`,
    ]);
    expect(summon?.queues).toEqual(["renders", "thumbs", "previews"]);
    expect(summon?.queue).toBe("renders");
  });

  it("answers queues [queue] for one queue, and no queues for none", () => {
    expect(
      summonedFromArgs([`${SUMMON_ARGS.id}=a1`, `${SUMMON_ARGS.queue}=emails`]),
    ).toEqual({ id: "a1", queue: "emails", queues: ["emails"] });
    expect(summonedFromArgs([`${SUMMON_ARGS.id}=a1`])).toEqual({ id: "a1" });
  });

  it("reads the group, and an empty one as absent", () => {
    expect(
      summonedFromArgs([
        `${SUMMON_ARGS.id}=a1`,
        "--bun-jobs-summon-group=media",
      ])?.group,
    ).toBe("media");
    expect(
      summonedFromArgs([`${SUMMON_ARGS.id}=a1`, "--bun-jobs-summon-group="]),
    ).toEqual({ id: "a1" });
  });

  it("round-trips what wireRequest writes", () => {
    const request = wireRequest(
      { id: PINNED_ID, count: 1, target: 1 },
      {
        ...ONE,
        queue: "b.2",
        queues: ["b.2", "a-1", "c_3", "2"],
        group: "media",
      },
    );
    const summon = parseSummonArgs(["bun", "x.ts", ...request.argv], undefined);
    expect(summon).toMatchObject({
      id: PINNED_ID,
      kind: "ecs",
      mode: "exit-on-idle",
      namespace: "shop",
      group: "media",
      queue: "b.2",
      queues: ["b.2", "a-1", "c_3", "2"],
      maxLifetimeMs: 3_600_000,
      graceMs: 10_000,
    });
    // One queue: what it answered before, plus queues.
    const one = parseSummonArgs(PINNED_ARGV, undefined)!;
    const { deadlineAt: _deadline, ...rest } = one;
    expect(rest).toEqual({
      id: PINNED_ID,
      kind: "ecs",
      mode: "exit-on-idle",
      namespace: "shop",
      queue: "emails",
      queues: ["emails"],
      maxLifetimeMs: 3_600_000,
      graceMs: 10_000,
    });
  });
});

/* --- the record ------------------------------------------------------------ */

/** A reporting worker on `driver` with `summon`, and a way to read its record. */
function reporting(
  driver: JobsDriver,
  summon: WorkerSummonProvenance,
): {
  worker: BunQueueWorker<unknown, null>;
  record: () => Promise<WorkerInfo>;
} {
  const namespace = testNamespace();
  const worker = new BunQueueWorker("summoned", async () => null, {
    namespace,
    driver,
    logger: noopLogger,
    reportInterval: 40,
    pollInterval: 10,
    waitToExit: false,
    summon,
  });
  closers.push(async () => await worker.close({ force: true }));
  void worker.run();
  return {
    worker,
    record: async () => {
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
          return found?.summon !== undefined;
        },
        { timeout: 10_000, message: "the worker never reported summon" },
      );
      return found!;
    },
  };
}

describe("summon.group on the record", () => {
  it("writes the group, and the DTO carries it", async () => {
    const fromArgs = summonedFromArgs([
      `${SUMMON_ARGS.id}=a1`,
      `${SUMMON_ARGS.kind}=ecs`,
      "--bun-jobs-summon-group=media",
      `${SUMMON_ARGS.queue}=summoned`,
      `${SUMMON_ARGS.queue}=thumbs`,
    ])!;
    const { record } = reporting(new MemoryDriver(), fromArgs);
    const info = await record();
    expect(info.summon).toEqual({ id: "a1", kind: "ecs", group: "media" });
    for (const extra of ["queue", "queues", "namespace"]) {
      expect(info.summon).not.toHaveProperty(extra);
    }
    expect(toWorkerDto(info, { exposeHosts: true }).summon).toEqual({
      id: "a1",
      kind: "ecs",
      group: "media",
    });
  });

  it("writes no group when none was passed", async () => {
    const { record } = reporting(new MemoryDriver(), { id: "a1" });
    expect(await record()).toMatchObject({ summon: { id: "a1" } });
    expect("group" in (await record()).summon!).toBe(false);
  });

  it("refuses a group that is not a non-empty string", () => {
    for (const group of ["", 7, null]) {
      expect(
        () =>
          new BunQueueWorker("q", async () => null, {
            namespace: testNamespace(),
            driver: new MemoryDriver(),
            summon: { id: "a1", group } as unknown as WorkerSummonProvenance,
          }),
      ).toThrow(ConfigError);
    }
  });

  const fixture = join(import.meta.dir, "fixtures", "summoned-worker.ts");
  for (const server of servers) {
    it.skipIf(!server.available)(
      `a summoned process with several queues writes its group, consuming the first, through ${server.name}`,
      async () => {
        const driver = createDriver(server.config);
        await driver.connect();
        const namespace = testNamespace("b1-xproc");
        closers.push(async () => {
          await driver.purge(namespace).catch(() => {});
          await driver.close();
        });
        // One job on the first queue: the unit consumes the first queue.
        const renders = new BunQueue("renders", {
          namespace,
          driver,
          logger: noopLogger,
        });
        closers.push(async () => await renders.close());
        await renders.add("a", {});
        const unit = spawnUnit(
          fixture,
          {
            SUMMON_TEST_DRIVER: JSON.stringify(server.config),
            SUMMON_TEST_IDLE_MS: "200",
          },
          [
            `${SUMMON_ARGS.id}=sm_b1xproc`,
            `${SUMMON_ARGS.kind}=test`,
            `${SUMMON_ARGS.namespace}=${namespace}`,
            "--bun-jobs-summon-group=media",
            `${SUMMON_ARGS.queue}=renders`,
            `${SUMMON_ARGS.queue}=thumbs`,
          ],
        );
        closers.push(async () => {
          unit.proc.kill("SIGKILL");
          await unit.exited;
        });
        const code = await unit.exited;
        expect(code, await unit.errors).toBe(0);
        const lines = await unitLines(unit);
        expect(lines.find((line) => line.event === "record")?.summon).toEqual({
          id: "sm_b1xproc",
          kind: "test",
          group: "media",
        });
        expect(lines.filter((line) => line.event === "processed")).toHaveLength(
          1,
        );
        expect((await renders.getDemand()).outstanding).toBe(0);
      },
      30_000,
    );
  }
});

/* --- what a controller sends ----------------------------------------------- */

describe("a single-queue controller's requests", () => {
  /** A controller over a SQLite file with a recording summoner. */
  async function controlled(style: "launch" | "scale") {
    const dir = await makeTmpDir("bun-jobs-b1-controller");
    cleanups.push(dir.cleanup);
    const driver = createDriver({
      type: "sql",
      url: `sqlite://${join(dir.path, "jobs.db")}`,
    });
    await driver.connect();
    const namespace = testNamespace("b1");
    const calls: SummonRequest[] = [];
    const releases: SummonReleaseRequest[] = [];
    const summoner = defineSummoner({
      kind: "rec",
      style,
      invoke: async (request) => {
        calls.push(request);
      },
      ...(style === "scale"
        ? {
            release: async (request: SummonReleaseRequest) => {
              releases.push(request);
            },
          }
        : {}),
    });
    const controller = new SummonController({
      driver,
      namespace,
      queue: "work",
      summoner,
      triggers: { onAdd: false, events: false, poll: false },
      cooldown: 0,
      scaleDown: { after: 0 },
      logger: noopLogger,
    });
    const queue = new BunQueue("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(async () => {
      await controller.close();
      await queue.close();
      await driver.purge(namespace);
      await driver.close();
    });
    return { controller, queue, calls, releases };
  }

  it("carry queues [queue], and no group or demands", async () => {
    const { controller, queue, calls } = await controlled("launch");
    await queue.add("a", {});
    expect(await controller.check()).toMatchObject({ action: "summoned" });
    const request = calls[0]!;
    expect(request.queue).toBe("work");
    expect(request.queues).toEqual(["work"]);
    expect("group" in request).toBe(false);
    expect("demands" in request).toBe(false);
    expect(
      request.argv.filter((arg) => arg.startsWith(`${SUMMON_ARGS.queue}=`)),
    ).toEqual([`${SUMMON_ARGS.queue}=work`]);
    expect(request.argv.some((arg) => arg.includes("summon-group"))).toBe(
      false,
    );
  });

  it("release a scale summoner with queues [queue]", async () => {
    const { controller, releases } = await controlled("scale");
    expect(await controller.check()).toMatchObject({ action: "released" });
    expect(releases).toEqual([
      expect.objectContaining({
        namespace: expect.any(String),
        queue: "work",
        queues: ["work"],
        target: 0,
      }),
    ]);
  });
});
