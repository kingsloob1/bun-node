import type {
  BunRunnerOptions,
  OutputLimitError,
  RunLogPage,
  RunRecord,
  SpawnOptions,
  WorkerTarget,
} from "../lib/index";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  BunRunner,
  ConfigError,
  MemoryDriver,
  runnerKey,
  SpawnExecutor,
} from "../lib/index";
import { canChangeIdentity } from "../lib/runner/executors/spawnHardening";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * The `child-process` hardening options beside the environment allowlist
 * (isolation PR-i0): `uid`/`gid`, a per-child `cgroup`, and `maxBuffer`.
 *
 * Each is checked on a real child. The two that need something this test
 * process does not have run in the probe process (`child-env-probe.ts`)
 * started the way a host would provide it: `unshare --map-root-user` for the
 * privilege to change a child's identity, `systemd-run --user --scope -p
 * Delegate=yes` for a cgroup subtree to write. Where neither is available the
 * test says so and skips, rather than passing on a host that proved nothing.
 */

const handler = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const PROBE = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "child-env-probe.ts",
);

/** Whether a command runs and exits 0. */
function works(cmd: string[]): boolean {
  try {
    return Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }).success;
  } catch {
    return false;
  }
}

const UNSHARE = ["unshare", "--map-root-user", "--map-auto"];
const DELEGATE = [
  "systemd-run",
  "--user",
  "--scope",
  "-q",
  "-p",
  "Delegate=yes",
];

const hasUserns = process.platform === "linux" && works([...UNSHARE, "true"]);
const hasDelegation =
  process.platform === "linux" &&
  existsSync("/sys/fs/cgroup/cgroup.controllers") &&
  works([...DELEGATE, "true"]);

/** What the probe printed. */
interface ProbeReport {
  /** The handler's result. */
  result?: any;
  /** The run's error. */
  error?: { name: string; message: string };
  /** The signal that ended a failed run's child. */
  signal?: string | null;
  /** The cgroups left under the parent afterwards. */
  leftover?: string[] | null;
  /** A refusal at construction. */
  thrown?: { name: string; message: string };
}

/** Runs the probe under `prefix`, and returns its report. */
async function probe(
  prefix: string[],
  spawn: SpawnOptions | Record<string, unknown>,
  name = "env-report",
  args: unknown = null,
  delegate = false,
): Promise<ProbeReport> {
  const proc = Bun.spawn(
    [
      ...prefix,
      process.execPath,
      PROBE,
      JSON.stringify(spawn),
      name,
      JSON.stringify(args),
      delegate ? "delegate" : "",
    ],
    {
      env: { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const line = out
    .split("\n")
    .reverse()
    .find((text) => text.startsWith("{"));
  if (!line) {
    throw new Error(`the probe printed no report; stderr:\n${err}`);
  }
  return JSON.parse(line) as ProbeReport;
}

/** Whether a process is alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const runners: BunRunner<any, any>[] = [];
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(runners.map((r) => r.stop({ force: true })));
  runners.length = 0;
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A child-process runner of `file`, tracked for cleanup. */
function makeRunner(
  file: string,
  options: Partial<BunRunnerOptions<any>> = {},
): { runner: BunRunner<any, any>; driver: MemoryDriver } {
  const driver = new MemoryDriver();
  const runner = new BunRunner({
    id: "hardening",
    namespace: testNamespace("harden"),
    file: handler(file),
    executionMode: "child-process",
    driver,
    waitToExit: false,
    logger: noopLogger,
    syncInterval: 0,
    ...options,
  } as BunRunnerOptions<any>);
  runners.push(runner);
  return { runner, driver };
}

/** Runs once and returns the record, its result and its error. */
async function runOnce(
  runner: BunRunner<any, any>,
  args?: unknown,
): Promise<{ record: RunRecord; result?: any; error?: Error }> {
  interface Settled {
    record: RunRecord;
    result?: any;
    error?: Error;
  }
  const settled = new Promise<Settled>((resolve) => {
    const finish = (record: RunRecord, result?: unknown): void =>
      resolve({ record, result });
    runner.once("finished", finish);
    runner.once("failed", (record, error) => resolve({ record, error }));
  });
  await runner.start();
  await runner.trigger({ args });
  return await settled;
}

/** A runner, or a queue worker's target, built with `spawn`: for refusals. */
const builders = {
  "a runner": (spawn: unknown) =>
    new BunRunner({
      id: "refuse",
      namespace: testNamespace(),
      file: handler("env-report"),
      executionMode: "child-process",
      driver: new MemoryDriver(),
      logger: noopLogger,
      spawn,
    } as BunRunnerOptions<any>),
  "a queue target": (spawn: unknown) =>
    new BunQueueWorker("refuse", handler("job-env-report"), {
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
      target: { kind: "child-process", spawn } as WorkerTarget,
    }),
};

describe("uid and gid", () => {
  for (const [label, build] of Object.entries(builders)) {
    it(`refuses what cannot work on ${label}, at construction`, () => {
      expect(() => build({ uid: 1.5, gid: 0 })).toThrow(
        /uid must be a non-negative integer/,
      );
      expect(() => build({ uid: process.getuid!() })).toThrow(
        /uid needs gid beside it/,
      );
      if (!canChangeIdentity()) {
        // Measured: the spawn would fail with EPERM at the first run.
        expect(() => build({ uid: 65534, gid: 65534 })).toThrow(ConfigError);
        expect(() => build({ uid: 65534, gid: 65534 })).toThrow(
          /needs CAP_SETUID and CAP_SETGID/,
        );
      }
      // One's own ids need no privilege.
      expect(() =>
        build({ uid: process.getuid!(), gid: process.getgid!() }),
      ).not.toThrow();
    });
  }

  it("runs the child as its own ids when given them", async () => {
    const { runner } = makeRunner("env-report", {
      spawn: { uid: process.getuid!(), gid: process.getgid!() },
    });
    const { record, result } = await runOnce(runner);
    expect(record.status).toBe("success");
    expect(result.uid).toBe(process.getuid!());
    expect(result.gid).toBe(process.getgid!());
  }, 30_000);

  it.skipIf(!hasUserns)(
    "runs the child as another user, with the privilege to (needs unshare --map-root-user)",
    async () => {
      // gid 0 in the namespace is this user's own group outside it, so the
      // child can still read the package's files through the group bits.
      const switched = await probe(UNSHARE, { uid: 65534, gid: 0 });
      expect(switched.thrown).toBeUndefined();
      expect(switched.result.uid).toBe(65534);
      expect(switched.result.gid).toBe(0);
      // Another user cannot read the parent's startup environment, which a
      // same-user child can (`child-env.test.ts`).
      expect(switched.result.parentEnviron).toBe(false);

      // The control: the same probe without the options runs as root there.
      const control = await probe(UNSHARE, {});
      expect(control.result.uid).toBe(0);
      expect(control.result.parentEnviron).toBe(true);
    },
    60_000,
  );
});

describe("cgroup", () => {
  for (const [label, build] of Object.entries(builders)) {
    it(`refuses a cgroup it cannot use on ${label}, at construction`, async () => {
      if (process.platform !== "linux") {
        expect(() => build({ cgroup: { parent: "/x" } })).toThrow(
          /cgroup is Linux only/,
        );
        return;
      }
      expect(() => build({ cgroup: { parent: "jobs" } })).toThrow(
        /cgroup.parent must be an absolute path/,
      );
      expect(() =>
        build({ cgroup: { parent: "/x", limits: { memory: "lots" } } }),
      ).toThrow(/cgroup.limits.memory must be a positive number of bytes/);
      expect(() =>
        build({ cgroup: { parent: "/x", limits: { pids: 0 } } }),
      ).toThrow(/cgroup.limits.pids must be a positive integer/);
      expect(() =>
        build({ cgroup: { parent: "/x", limits: { cpus: -1 } } }),
      ).toThrow(/cgroup.limits.cpus must be a positive number/);

      const tmp = await makeTmpDir("cgroup-not");
      try {
        expect(() => build({ cgroup: { parent: tmp.path } })).toThrow(
          /is not a cgroup v2 directory/,
        );
      } finally {
        await tmp.cleanup();
      }

      if (existsSync("/sys/fs/cgroup/cgroup.controllers")) {
        // The root cgroup: a real cgroup, and nobody but root writes it.
        // Measured: Bun.spawn into it fails with EACCES from clone3.
        if (process.geteuid?.() !== 0) {
          expect(() => build({ cgroup: { parent: "/sys/fs/cgroup" } })).toThrow(
            /is not writable by this process/,
          );
        }

        // This process's own cgroup, when it may write it: it holds a
        // process, so it can enable no controller for children.
        const own = `/sys/fs/cgroup${readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1]}`;
        let writable = false;
        try {
          accessSync(own, constants.W_OK);
          writable = true;
        } catch {}
        const enabled = readFileSync(
          join(own, "cgroup.subtree_control"),
          "utf8",
        );
        if (writable && !enabled.includes("memory")) {
          expect(() =>
            build({ cgroup: { parent: own, limits: { memory: "64mb" } } }),
          ).toThrow(/does not enable memory for its children/);
        }
      }
    });
  }

  it("fails a run whose cgroup cannot be made, without throwing", async () => {
    // The executor directly: the constructor checks would refuse this path,
    // and this is what a run meets if the parent disappears afterwards.
    const executor = new SpawnExecutor({
      stdout: "inherit",
      stderr: "inherit",
      startTimeout: 10_000,
      cgroup: { parent: "/sys/fs/cgroup/bun-jobs-no-such-parent" },
    });
    const handle = executor.start({
      context: {
        runId: "r1",
        runnerId: "x",
        runnerName: "x",
        namespace: "n",
        attempt: 1,
        source: "manual",
        mode: "child-process",
        startedAt: Date.now(),
        deadline: null,
        args: null,
      } as never,
      file: handler("env-report"),
      timeout: 0,
      closeTimeout: 1_000,
      killTimeout: 1_000,
      waitToExit: false,
      forwardLogs: false,
      events: {
        onProgress: () => {},
        onMessage: () => {},
        onLog: () => {},
        onOutput: () => {},
        onPid: () => {},
      },
    });
    const outcome = await handle.done;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toMatch(/ENOENT|no such file/);
  });

  it("fails a run whose child cannot be started, rather than leaving it running", async () => {
    // Before PR-i0 a throw from `Bun.spawn` escaped `start()`: `trigger()`
    // rejected and the history row stayed `running` for good. A uid or a
    // cgroup refused at spawn time ends that way too, so it is a failed run.
    const { runner } = makeRunner("env-report", {
      spawn: { execPath: "/nonexistent/bun-jobs-test/bun" },
    });
    const { record, error } = await runOnce(runner);
    expect(record.status).toBe("failed");
    expect(error?.message).toMatch(/ENOENT/);
    const [row] = await runner.history();
    expect(row?.status).toBe("failed");
  }, 30_000);

  it.skipIf(!hasDelegation)(
    "runs each child in a cgroup of its own, with its limits, and removes it (needs a delegated cgroup)",
    async () => {
      const report = await probe(
        DELEGATE,
        { cgroup: { limits: { memory: "64mb", pids: 64, cpus: 0.5 } } },
        "env-report",
        null,
        true,
      );
      expect(report.thrown).toBeUndefined();
      expect(report.error).toBeUndefined();
      expect(report.result.cgroup).toMatch(/\/jobs\/bun-jobs-[^/]+$/);
      expect(report.result.limits["memory.max"]).toBe(String(64 * 1024 ** 2));
      if (report.result.limits["memory.swap.max"] !== null) {
        expect(report.result.limits["memory.swap.max"]).toBe("0");
      }
      expect(report.result.limits["pids.max"]).toBe("64");
      expect(report.result.limits["cpu.max"]).toBe("50000 100000");
      expect(report.leftover).toEqual([]);
    },
    60_000,
  );

  it.skipIf(!hasDelegation)(
    "kills a child over its memory limit alone, and the run fails (needs a delegated cgroup)",
    async () => {
      const killed = await probe(
        DELEGATE,
        { cgroup: { limits: { memory: "64mb" } } },
        "memhog",
        { maxMb: 192 },
        true,
      );
      // The probe — the "worker" — lived to report it.
      expect(killed.error).toBeDefined();
      expect(killed.signal).toBe("SIGKILL");
      expect(killed.leftover).toEqual([]);

      // The control: the same handler with no limit finishes.
      const control = await probe(DELEGATE, {}, "memhog", { maxMb: 192 });
      expect(control.result).toEqual({ survivedMb: 192 });
    },
    60_000,
  );

  it.skipIf(!hasDelegation)(
    "kills what a job left running in its cgroup when it exits (needs a delegated cgroup)",
    async () => {
      const contained = await probe(
        DELEGATE,
        { cgroup: {} },
        "orphan",
        null,
        true,
      );
      expect(contained.result.orphan).toBeGreaterThan(0);
      expect(isAlive(contained.result.orphan)).toBe(false);

      // The control: without a cgroup, the orphan outlives the run.
      const control = await probe([], {}, "orphan");
      const pid = control.result.orphan as number;
      try {
        expect(isAlive(pid)).toBe(true);
      } finally {
        if (isAlive(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
    },
    60_000,
  );
});

describe("maxBuffer", () => {
  for (const [label, build] of Object.entries(builders)) {
    it(`refuses a maxBuffer it cannot apply on ${label}, at construction`, () => {
      expect(() => build({ maxBuffer: 0, stdout: "pipe" })).toThrow(
        /maxBuffer must be a positive whole number of bytes/,
      );
      expect(() =>
        build({ maxBuffer: 1024, stdout: "inherit", stderr: "ignore" }),
      ).toThrow(/maxBuffer counts piped output/);
      expect(() => build({ maxBuffer: 1024, stdout: "pipe" })).not.toThrow();
    });
  }

  /** Everything one run's log holds. */
  async function readLog(
    driver: MemoryDriver,
    runner: BunRunner<any, any>,
    runId: string,
  ): Promise<RunLogPage> {
    return await driver.getRunLog(
      runner.namespace,
      runnerKey(runner.id),
      runId,
      {
        offset: 0,
        limit: 10_000,
        order: "asc",
      },
    );
  }

  /** One line the `noisy` fixture writes, after redaction. */
  const LINE = /^\d{6} password=\[REDACTED\] x{100}$/;

  it("kills a child over it, keeps only whole lines, and fails the run", async () => {
    const { runner, driver } = makeRunner("noisy", {
      spawn: { maxBuffer: 5_000 },
    });
    const started = Date.now();
    // 60 lines of 125 bytes (7,500), then a 20 s wait: a run that ends
    // quickly was ended by the limit, not by finishing.
    const { record, error } = await runOnce(runner, {
      lines: 60,
      holdMs: 20_000,
    });

    expect(record.status).toBe("failed");
    expect(error).toBeInstanceOf(Error);
    expect(error?.name).toBe("OutputLimitError");
    expect((error as OutputLimitError).code).toBe("OUTPUT_LIMIT");
    expect(record.signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(15_000);

    const stdout = (await readLog(driver, runner, record.runId)).lines.filter(
      (line) => line.stream === "stdout",
    );
    expect(stdout.length).toBeGreaterThan(0);
    // Every stored line is whole, and redacted whole.
    for (const line of stdout) {
      expect(line.text).toMatch(LINE);
    }
    // Counted as the child wrote them (125 bytes with the newline), not as
    // stored: redaction makes a stored line longer.
    expect(stdout.length * 125).toBeLessThanOrEqual(5_000);
  }, 30_000);

  it("leaves a child under it alone (the control)", async () => {
    const { runner, driver } = makeRunner("noisy", {
      spawn: { maxBuffer: 1_000_000 },
    });
    const { record, result } = await runOnce(runner, { lines: 50 });
    expect(record.status).toBe("success");
    expect(result).toBe("finished");
    const stdout = (await readLog(driver, runner, record.runId)).lines.filter(
      (line) => line.stream === "stdout",
    );
    expect(stdout).toHaveLength(50);
  }, 30_000);

  it("fails a queue job whose child-process target goes over it", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = new BunQueue("noisy", {
      namespace,
      driver,
      logger: noopLogger,
    });
    const worker = new BunQueueWorker("noisy", handler("noisy"), {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 5,
      target: {
        kind: "child-process",
        spawn: { stdout: "pipe", maxBuffer: 2_000 },
      },
      waitToExit: false,
    });
    closers.push(
      () => queue.close(),
      () => worker.close({ force: true }),
    );
    void worker.run();
    // A job processor reads `job.data`, not run args: `noisy` takes either.
    const job = await queue.add(
      "noisy",
      { lines: 30 },
      { removeOnFail: false, attempts: 1 },
    );
    await waitFor(
      // Out of attempts, a failed job is buried: `dead`.
      async () => (await queue.getJob(job.id))?.state === "dead",
      { timeout: 20_000, message: "the job never failed" },
    );
    const failed = await queue.getJob(job.id);
    expect(failed?.failedReason?.message).toMatch(/over its maxBuffer of 2000/);
  }, 30_000);
});
