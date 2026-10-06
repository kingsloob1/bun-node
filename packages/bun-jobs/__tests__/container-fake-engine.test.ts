import type { ContainerTarget } from "../lib/index";
import type { RunOutcome } from "../lib/runner/executors/executor";
import type { FakeEngine, FakeEngineConfig } from "./helpers/fakeEngine";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  IsolationUnavailableError,
  MemoryDriver,
} from "../lib/index";
import {
  ContainerExecutor,
  containerMarkers,
} from "../lib/queue/container/executor";
import {
  CONTAINER_BOOTSTRAP,
  resolveContainerTarget,
} from "../lib/queue/container/target";
import { testNamespace, waitFor } from "./helpers";
import { installFakeEngine } from "./helpers/fakeEngine";

/**
 * The `container` target against a fake engine (`helpers/fakeEngine.ts`): a
 * `docker` on `PATH` that answers from a state directory and runs each
 * "container" as a local process with exactly the command and `--env` values
 * it was given. So everything bun-jobs does — the argument list, the CLI's
 * environment, the probe's steps, the channel, the kill sequence, the sweep —
 * runs for real, without a daemon. `container-docker.test.ts` repeats the
 * parts that need one.
 */

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "container", `${name}.ts`);

const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await Promise.resolve(cleanup()).catch(() => undefined);
  }
});

/** A fake engine for one test, with the test image present. */
function engine(config: FakeEngineConfig = {}): FakeEngine {
  const fake = installFakeEngine({ images: ["fake/bun:1"], ...config });
  cleanups.push(() => fake.uninstall());
  return fake;
}

/** A scratch directory the "container" (a local process) writes markers to. */
function markers(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-jobs-markers-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A queue and a worker on a container target, not yet running. */
function setup(
  processor: string,
  target: Partial<ContainerTarget> = {},
  options: {
    logger?: ReturnType<typeof createTestLogger>["logger"];
    key?: string;
  } = {},
) {
  const driver = new MemoryDriver();
  const namespace = testNamespace("i1");
  const queue = new BunQueue("boxed", {
    namespace,
    driver,
    logger: noopLogger,
  });
  const worker = new BunQueueWorker("boxed", fixture(processor), {
    namespace,
    driver,
    key: options.key ?? `i1test-${namespace}`,
    logger: options.logger ?? noopLogger,
    pollInterval: 5,
    waitToExit: false,
    target: {
      kind: "container",
      image: "fake/bun:1",
      closeTimeout: 1000,
      ...target,
    },
  });
  cleanups.push(
    () => queue.close(),
    () => worker.close({ force: true }),
  );
  return { queue, worker, driver, namespace };
}

/** Waits for a job to reach one of `states`. */
async function settled(
  queue: BunQueue,
  id: string,
  states: string[] = ["completed", "dead", "failed"],
) {
  await waitFor(
    async () => states.includes((await queue.getJob(id))?.state ?? ""),
    {
      timeout: 20_000,
      message: async () => `job ${id} is ${(await queue.getJob(id))?.state}`,
    },
  );
  return (await queue.getJob(id))!;
}

describe("a container attempt, end to end", () => {
  it("runs the processor in the container and settles it through the worker", async () => {
    const fake = engine();
    const { queue, worker } = setup("echo", { env: { NODE_ENV: "test" } });
    void worker.run();
    const job = await queue.add("echo", { n: 1 }, { removeOnComplete: false });
    const stored = await settled(queue, job.id);

    expect(stored.state).toBe("completed");
    const result = stored.returnValue as {
      data: unknown;
      mode: string;
      env: string[];
      lockHeld: boolean;
    };
    expect(result.data).toEqual({ n: 1 });
    expect(result.mode).toBe("container");
    expect(result.lockHeld).toBe(true);
    // Only the literal env and bun-jobs' markers (the fake adds PATH and
    // HOME, as an image's defaults would be).
    expect(result.env).toEqual([
      "BUN_JOBS_CHILD",
      "BUN_JOBS_FILE",
      "BUN_JOBS_MODE",
      "BUN_JOBS_NAMESPACE",
      "BUN_JOBS_RUNNER_ID",
      "BUN_JOBS_RUN_ID",
      "HOME",
      "NODE_ENV",
      "PATH",
    ]);
    expect(stored.progress).toBe(50);
    // The job's own stdout and stderr became log lines, beside the line it
    // logged through the channel; the channel's own lines did not.
    const { logs } = await queue.getJobLogs(job.id);
    expect([...logs].sort()).toEqual(
      [
        "a line on stderr",
        "a line through the channel",
        "hello from the container",
      ].sort(),
    );
    expect(fake.containers()).toEqual([]);
  }, 30_000);

  it("reports target.kind container with the image, on the record listWorkers returns", async () => {
    engine();
    const { queue, worker } = setup("echo", {
      runtime: "runc",
      env: { SECRET: "s3cret" },
    });
    void worker.run();
    await waitFor(async () => (await queue.listWorkers()).length === 1, {
      timeout: 10_000,
    });
    const [record] = await queue.listWorkers();
    expect(record?.target).toEqual({
      kind: "container",
      processor: "file",
      container: { image: "fake/bun:1", runtime: "runc" },
      file: fixture("echo"),
    });
    expect(JSON.stringify(record)).not.toContain("s3cret");
  }, 30_000);

  it("runs the CLI with an explicit environment from the live process.env: no secret, deleted or not", async () => {
    const fake = engine();
    // Set now, after this process started: a plain `Bun.spawn` would pass
    // the startup environment and miss both changes.
    process.env.I1_TEST_SECRET = "s3cret";
    process.env.DOCKER_CONFIG = "/i1/live-docker-config";
    const startupOnly = Object.keys(process.env).find(
      (name) =>
        !/^(?:PATH|HOME|TMPDIR|LANG|TERM|USER|SHELL|DOCKER_|XDG_|CONTAINER)/.test(
          name,
        ),
    );
    const removed = startupOnly ? process.env[startupOnly] : undefined;
    if (startupOnly) {
      delete process.env[startupOnly];
    }
    cleanups.push(() => {
      delete process.env.I1_TEST_SECRET;
      delete process.env.DOCKER_CONFIG;
      if (startupOnly && removed !== undefined) {
        process.env[startupOnly] = removed;
      }
    });

    const { queue, worker } = setup("echo", {
      engine: { host: "unix:///i1/fake.sock" },
    });
    void worker.run();
    const job = await queue.add("echo", {});
    expect((await settled(queue, job.id)).state).toBe("completed");

    const calls = fake.calls();
    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) {
      expect(call.env.I1_TEST_SECRET).toBeUndefined();
      if (startupOnly) {
        expect(call.env[startupOnly]).toBeUndefined();
      }
      expect(call.env.DOCKER_CONFIG).toBe("/i1/live-docker-config");
      expect(call.env.DOCKER_HOST).toBe("unix:///i1/fake.sock");
    }
    // And none of it reached the container.
    const env = (await queue.getJob(job.id))!.returnValue as { env: string[] };
    expect(env.env).not.toContain("DOCKER_HOST");
    expect(env.env).not.toContain("I1_TEST_SECRET");
  }, 30_000);

  it("gives the attempt and the probe the same hardened argument list", async () => {
    const fake = engine();
    const { queue, worker } = setup("echo");
    void worker.run();
    const job = await queue.add("echo", {});
    await settled(queue, job.id);

    const runs = fake.callsOf("run");
    const probe = runs.find((call) =>
      call.args.some((arg) => /^--name=.*-probe$/.test(arg)),
    );
    const attempt = runs.find((call) => call !== probe);
    expect(probe).toBeDefined();
    expect(attempt).toBeDefined();
    const flags = (args: string[]) =>
      args
        .slice(0, args.indexOf("fake/bun:1"))
        .filter((arg) => !/^--(?:name|env=BUN_JOBS_RUN_ID)=/.test(arg));
    expect(flags(probe!.args)).toEqual(flags(attempt!.args));
    for (const flag of [
      "--read-only",
      "--cap-drop=ALL",
      "--ipc=none",
      "--security-opt=no-new-privileges",
      "--network=none",
      "--user=65534:65534",
      "--pull=never",
    ]) {
      expect(attempt!.args).toContain(flag);
    }
  }, 30_000);

  it("gives a flow's parent its children's values and failures over the channel", async () => {
    engine();
    const driver = new MemoryDriver();
    const namespace = testNamespace("i1");
    const queue = new BunQueue("boxed", {
      namespace,
      driver,
      logger: noopLogger,
    });
    const worker = new BunQueueWorker(
      "boxed",
      join(import.meta.dir, "fixtures", "handlers", "job-children.ts"),
      {
        namespace,
        driver,
        key: `i1test-${namespace}`,
        logger: noopLogger,
        pollInterval: 5,
        concurrency: 2,
        target: { kind: "container", image: "fake/bun:1" },
      },
    );
    cleanups.push(
      () => queue.close(),
      () => worker.close({ force: true }),
    );
    void worker.run();
    const flow = await queue.addFlow({
      name: "parent",
      data: {},
      opts: { removeOnComplete: false },
      children: [
        { name: "ok", data: {}, queue: "boxed" },
        {
          name: "bad",
          data: {},
          queue: "boxed",
          opts: { ignoreFailure: true },
        },
      ],
    });
    const stored = await settled(queue, flow.job.id, ["completed", "dead"]);
    const ok = flow.children[0]!.job.id;
    const bad = flow.children[1]!.job.id;
    expect(stored.returnValue).toEqual({
      parent: null,
      values: {
        [`boxed:${ok}`]: { parent: { queue: "boxed", id: flow.job.id } },
      },
      failures: {
        [`boxed:${bad}`]: {
          isError: true,
          name: "UnrecoverableJobError",
          message: "optional source down",
        },
      },
    });
  }, 40_000);

  it("retries an ordinary failure, rebuilt from the container", async () => {
    engine();
    const { queue, worker } = setup("fail");
    void worker.run();
    const job = await queue.add("fail", {}, { attempts: 2, backoff: 1 });
    const stored = await settled(queue, job.id, ["dead"]);
    expect(stored.attemptsMade).toBe(2);
    expect(stored.failedReason?.message).toBe("boom in the container");
  }, 30_000);
});

describe("the start-up probe fails fast, never degrades", () => {
  /** Runs a worker whose probe should fail, and returns its error. */
  async function probeFailure(
    config: FakeEngineConfig,
    target: Partial<ContainerTarget> = {},
  ): Promise<{
    error: IsolationUnavailableError;
    fake: FakeEngine;
    claimed: boolean;
  }> {
    const fake = engine(config);
    const { queue, worker } = setup("echo", target);
    // Added first, so a worker that ran anyway would claim it.
    const job = await queue.add("echo", {});
    const error = await worker.run().then(
      () => {
        throw new Error("run() resolved");
      },
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(IsolationUnavailableError);
    const claimed = (await queue.getJob(job.id))?.state !== "waiting";
    return { error: error as IsolationUnavailableError, fake, claimed };
  }

  it("names the engine step when the engine does not answer, with its stderr", async () => {
    const { error, claimed, fake } = await probeFailure({ versionFails: true });
    expect(error.context.step).toBe("engine");
    expect(error.context.stderr).toContain(
      "Cannot connect to the Docker daemon",
    );
    expect(claimed).toBe(false);
    expect(fake.callsOf("run")).toEqual([]);
  }, 30_000);

  it("names the runtime step when the runtime is not listed", async () => {
    const { error, claimed } = await probeFailure(
      { runtimes: ["runc"] },
      { runtime: "runsc" },
    );
    expect(error.context.step).toBe("runtime");
    expect(error.message).toContain(
      '"runsc" is not one the engine lists (runc)',
    );
    expect(claimed).toBe(false);
  }, 30_000);

  it("names the image step when the image is missing and pull is never", async () => {
    const { error, fake } = await probeFailure(
      { images: [] },
      { pull: "never" },
    );
    expect(error.context.step).toBe("image");
    expect(fake.callsOf("pull")).toEqual([]);
  }, 30_000);

  it("names the image step when the pull fails", async () => {
    const { error } = await probeFailure({ images: [], pullFails: true });
    expect(error.context.step).toBe("image");
    expect(error.context.stderr).toContain("pull access denied");
  }, 30_000);

  it("names the probe step when a container with the exact flags cannot run, with the snap hint", async () => {
    const { error, claimed } = await probeFailure({
      probeFails: {
        code: 126,
        stderr:
          "exec /usr/local/bin/docker-entrypoint.sh: operation not permitted",
      },
    });
    expect(error.context.step).toBe("probe");
    expect(error.message).toContain("operation not permitted");
    expect(error.message).toContain('apparmor: "snap.docker.dockerd"');
    expect(claimed).toBe(false);
  }, 30_000);

  it("pulls a missing image under the default pull, then runs", async () => {
    const fake = engine({ images: [] });
    const { queue, worker } = setup("echo");
    void worker.run();
    const job = await queue.add("echo", {});
    expect((await settled(queue, job.id)).state).toBe("completed");
    expect(fake.callsOf("pull").map((call) => call.args)).toEqual([
      ["pull", "fake/bun:1"],
    ]);
  }, 30_000);

  it("is cut short by a close during start-up, which leaves no probe container", async () => {
    const fake = engine({ createDelayMs: 3000 });
    const { worker } = setup("echo");
    const running = worker.run();
    await waitFor(() => fake.callsOf("run").length > 0, { timeout: 10_000 });
    const started = performance.now();
    await worker.close();
    await running;
    // Well inside the 3 s the probe container would have taken.
    expect(performance.now() - started).toBeLessThan(2500);
    await waitFor(() => fake.containers().length === 0, { timeout: 5000 });
  }, 30_000);
});

describe("the orphan sweep", () => {
  it("removes this key's old containers whose worker is not live, and nothing else", async () => {
    const fake = engine();
    const { queue, worker, namespace } = setup(
      "echo",
      {},
      { key: "i1test-sweep" },
    );
    const labels = (
      key: string,
      id: string,
      ns = namespace,
      queueName = "boxed",
    ) => ({
      "bun-jobs.worker-key": key,
      "bun-jobs.worker-id": id,
      "bun-jobs.namespace": ns,
      "bun-jobs.queue": queueName,
    });
    const old = Date.now() - 10 * 60_000;
    fake.addContainer({
      name: "orphan",
      labels: labels("i1test-sweep", "dead.1"),
      created: old,
    });
    fake.addContainer({
      name: "young",
      labels: labels("i1test-sweep", "dead.2"),
      created: Date.now(),
    });
    fake.addContainer({
      name: "other-key",
      labels: labels("i1test-other", "dead.3"),
      created: old,
    });
    fake.addContainer({
      name: "other-ns",
      labels: labels("i1test-sweep", "dead.4", "elsewhere"),
      created: old,
    });
    fake.addContainer({ name: "unlabelled", labels: {}, created: old });

    void worker.run();
    await waitFor(async () => (await queue.listWorkers()).length === 1, {
      timeout: 10_000,
    });
    expect(fake.containers().sort()).toEqual([
      "other-key",
      "other-ns",
      "unlabelled",
      "young",
    ]);
  }, 30_000);

  it("keeps the containers of a worker that is live", async () => {
    const fake = engine();
    const { queue, worker, namespace } = setup(
      "echo",
      {},
      { key: "i1test-live" },
    );
    // Another live worker of the same key on the same queue.
    const peer = new BunQueueWorker("boxed", fixture("echo"), {
      namespace,
      driver: (queue as unknown as { driver: MemoryDriver }).driver,
      key: "i1test-live",
      logger: noopLogger,
      target: { kind: "container", image: "fake/bun:1" },
    });
    cleanups.push(() => peer.close({ force: true }));
    void peer.run();
    await waitFor(async () => (await queue.listWorkers()).length === 1, {
      timeout: 10_000,
    });
    fake.addContainer({
      name: "peers",
      labels: {
        "bun-jobs.worker-key": "i1test-live",
        "bun-jobs.worker-id": peer.id,
        "bun-jobs.namespace": namespace,
        "bun-jobs.queue": "boxed",
      },
      created: Date.now() - 10 * 60_000,
    });
    void worker.run();
    await waitFor(async () => (await queue.listWorkers()).length === 2, {
      timeout: 10_000,
    });
    expect(fake.containers()).toContain("peers");
  }, 30_000);
});

describe("stopping an attempt", () => {
  /** A container executor on the fake engine, for one processor. */
  function executor(
    processor: string,
    target: Partial<ContainerTarget> = {},
    env: Record<string, string> = {},
  ) {
    const resolved = resolveContainerTarget({
      kind: "container",
      image: "fake/bun:1",
      closeTimeout: 1000,
      env,
      ...target,
    });
    return new ContainerExecutor(
      resolved,
      {
        workerKey: "i1test-exec",
        workerId: "i1test-exec.1",
        namespace: "ns",
        queue: "q",
      },
      fixture(processor),
    );
  }

  /** Starts one attempt and returns its handle with the events it saw. */
  function start(container: ContainerExecutor) {
    const output: string[] = [];
    const handle = container.start({
      context: {
        runId: "job-1.1",
        runnerId: "q",
        runnerName: "i1test-exec.1",
        namespace: "ns",
        attempt: 1,
        source: "queued",
        mode: "child-process",
        startedAt: Date.now(),
        deadline: null,
        args: null,
        signal: new AbortController().signal,
        logger: noopLogger,
        log: () => {},
        flushLogs: async () => {},
        progress: () => {},
        send: () => {},
        onMessage: () => () => {},
      },
      file: fixture("unused"),
      timeout: 0,
      closeTimeout: 1000,
      killTimeout: 0,
      waitToExit: false,
      forwardLogs: true,
      kind: "job",
      job: {
        id: "job-1",
        name: "x",
        data: {},
        opts: {},
        state: "active",
        priority: 0,
        runAt: Date.now(),
        createdAt: Date.now(),
        processedOn: Date.now(),
        finishedOn: null,
        expiresAt: null,
        attemptsMade: 1,
        maxAttempts: 1,
        stalledCount: 0,
        progress: null,
        returnValue: null,
        failedReason: null,
        stacktrace: [],
        workerId: "i1test-exec.1",
        repeatKey: null,
        lockToken: "t",
      } as never,
      events: {
        onProgress: () => {},
        onMessage: () => {},
        onLog: () => {},
        onOutput: (_stream, line) => output.push(line),
        onPid: () => {},
      },
    });
    return { handle, output };
  }

  it("kills a container that ignores the close after closeTimeout: exit 137, and gone before exited", async () => {
    const fake = engine();
    const dir = markers();
    const { handle } = start(executor("spin", {}, { MARKER_DIR: dir }));
    await waitFor(() => existsSync(join(dir, "started")), { timeout: 15_000 });
    handle.stop("a test");
    const outcome: RunOutcome = await handle.done;
    expect(outcome.status).toBe("killed");
    expect(outcome.error?.name).toBe("RunKilledError");
    expect(outcome.exitCode).toBe(137);
    await handle.exited;
    expect(fake.containers()).toEqual([]);
    const { args } = fake.callsOf("run").at(-1)!;
    const name = args.find((arg) => arg.startsWith("--name="))!.slice(7);
    expect(fake.callsOf("kill").map((call) => call.args)).toContainEqual([
      "kill",
      "--signal=KILL",
      name,
    ]);
    expect(fake.callsOf("rm").map((call) => call.args)).toContainEqual([
      "rm",
      "--force",
      name,
    ]);
    // Killed in order: kill, then rm.
    const kill = fake.callsOf("kill").at(-1)!.at;
    const rm = fake.callsOf("rm").at(-1)!.at;
    expect(rm).toBeGreaterThanOrEqual(kill);
  }, 30_000);

  it("lets a container whose processor ignores the close exit itself: exit 143, not a kill", async () => {
    const fake = engine();
    const dir = markers();
    const { handle } = start(
      executor("hang", { closeTimeout: 3000 }, { MARKER_DIR: dir }),
    );
    await waitFor(() => existsSync(join(dir, "started")), { timeout: 15_000 });
    handle.stop("a test");
    const outcome = await handle.done;
    expect(outcome.status).toBe("killed");
    // The runner inside exits itself 500 ms before closeTimeout.
    expect(outcome.exitCode).toBe(143);
    expect(fake.callsOf("kill")).toEqual([]);
    await handle.exited;
  }, 30_000);

  it("kills at once on a forced stop", async () => {
    engine();
    const dir = markers();
    const { handle } = start(
      executor("spin", { closeTimeout: 60_000 }, { MARKER_DIR: dir }),
    );
    await waitFor(() => existsSync(join(dir, "started")), { timeout: 15_000 });
    handle.stop("close", { force: true });
    const outcome = await handle.done;
    expect(outcome.exitCode).toBe(137);
    await handle.exited;
  }, 30_000);

  it("ends a close that lands while the container is being created without importing the processor", async () => {
    const fake = engine({ createDelayMs: 1500 });
    const dir = markers();
    const { handle } = start(
      executor("import-marker", { closeTimeout: 10_000 }, { MARKER_DIR: dir }),
    );
    // Before the container exists: the CLI is still "creating" it.
    await waitFor(() => fake.callsOf("run").length > 0, { timeout: 10_000 });
    expect(fake.containers()).toEqual([]);
    handle.stop("close");
    const outcome = await handle.done;
    expect(outcome.status).toBe("killed");
    expect(outcome.error?.name).toBe("RunKilledError");
    // The runner inside saw the close before its start, so it never
    // imported the processor, and exited as a closed runner does.
    expect(outcome.exitCode).toBe(143);
    expect(existsSync(join(dir, "imported"))).toBe(false);
    await handle.exited;
  }, 30_000);

  it("removes a container a forced stop could not find yet, once it exists, without importing the processor", async () => {
    const fake = engine({ createDelayMs: 1500 });
    const dir = markers();
    const { handle } = start(
      executor("import-marker", {}, { MARKER_DIR: dir }),
    );
    await waitFor(() => fake.callsOf("run").length > 0, { timeout: 10_000 });
    handle.stop("close", { force: true });
    const outcome = await handle.done;
    expect(outcome.status).toBe("killed");
    expect(outcome.exitCode).toBe(137);
    await handle.exited;
    expect(fake.containers()).toEqual([]);
    expect(existsSync(join(dir, "imported"))).toBe(false);
    // The first removals found nothing; a later one found the container.
    expect(fake.callsOf("rm").length).toBeGreaterThan(1);
  }, 30_000);

  it("reports a container the engine could not start with its stderr, never the CLI's own exit code", async () => {
    engine({
      runFails: {
        code: 125,
        stderr: "docker: Error response from daemon: invalid mount config",
      },
    });
    const { handle } = start(executor("echo"));
    const outcome = await handle.done;
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error?.name).toBe("ChildExitError");
    expect(outcome.error?.data?.context).toMatchObject({
      reason: "the container could not be started",
      stderr: "docker: Error response from daemon: invalid mount config",
    });
    await handle.exited;
  }, 30_000);

  it("ends an attempt the worker times out, and the job is not held", async () => {
    engine();
    const { queue, worker } = setup("spin");
    void worker.run();
    const job = await queue.add("spin", {}, { timeout: 1500, attempts: 1 });
    const stored = await settled(queue, job.id, ["dead"]);
    expect(stored.failedReason?.name).toBe("JobTimeoutError");
  }, 30_000);
});

describe("the channel's bounds", () => {
  it("fails an oversize result for good, with no retry", async () => {
    engine();
    const { queue, worker } = setup("big-result");
    void worker.run();
    const job = await queue.add(
      "big",
      { bytes: 17 * 1024 * 1024 },
      { attempts: 3, backoff: 1 },
    );
    const stored = await settled(queue, job.id, ["dead"]);
    expect(stored.attemptsMade).toBe(1);
    expect(stored.failedReason?.name).toBe("UnrecoverableJobError");
    expect(stored.failedReason?.message).toContain(
      "over its limit of 16777216",
    );
  }, 60_000);

  it("keeps a result under the limit whole", async () => {
    engine();
    const { queue, worker } = setup("big-result");
    void worker.run();
    const job = await queue.add(
      "big",
      { bytes: 2 * 1024 * 1024 },
      { removeOnComplete: false },
    );
    const stored = await settled(queue, job.id);
    expect((stored.returnValue as string).length).toBe(2 * 1024 * 1024);
  }, 60_000);

  it("keeps the job's own output up to maxLogBytes, then says it was cut", async () => {
    engine();
    const { logger, events } = createTestLogger();
    const { queue, worker } = setup(
      "chatty",
      { maxLogBytes: 1000 },
      { logger },
    );
    void worker.run();
    const job = await queue.add(
      "chatty",
      { lines: 100 },
      { removeOnComplete: false },
    );
    const stored = await settled(queue, job.id);
    expect(stored.returnValue).toBe(100);
    const { logs } = await queue.getJobLogs(job.id, { limit: 1000 });
    // 101 bytes a line with its newline: nine fit in 1000.
    expect(logs.filter((line) => line.endsWith("y"))).toHaveLength(9);
    expect(logs.at(-1)).toContain(
      "container output cut at maxLogBytes (1000 bytes)",
    );
    expect(
      events.some((event) => event.message.includes("cut at maxLogBytes")),
    ).toBe(true);
  }, 30_000);
});

describe("the container entry", () => {
  /** Runs the entry as a container would, with its stdin under the test's control. */
  function entry(processor: string, env: Record<string, string> = {}) {
    const prefix = "b".repeat(32);
    const proc = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        CONTAINER_BOOTSTRAP,
        prefix,
        processor,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          ...containerMarkers(
            { workerKey: "k", workerId: "w", namespace: "ns", queue: "q" },
            "r.1",
            processor,
          ),
          ...env,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    cleanups.push(() => proc.kill("SIGKILL"));
    return { proc, prefix };
  }

  it("says ready on its first line, prefixed, with the protocol version", async () => {
    const dir = markers();
    const { proc, prefix } = entry(fixture("import-marker"), {
      MARKER_DIR: dir,
    });
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const line = new TextDecoder().decode(value).split("\n")[0]!;
    expect(line.startsWith(`${prefix} `)).toBe(true);
    expect(JSON.parse(line.slice(33))).toMatchObject({
      t: "ready",
      protocol: 1,
    });
    reader.releaseLock();
    proc.stdin.end();
    expect(await proc.exited).toBe(143);
  }, 15_000);

  it("exits 143 without importing the processor when its stdin ends before start", async () => {
    const dir = markers();
    const { proc } = entry(fixture("import-marker"), { MARKER_DIR: dir });
    proc.stdin.end();
    expect(await proc.exited).toBe(143);
    expect(existsSync(join(dir, "imported"))).toBe(false);
  }, 15_000);

  it("does nothing when imported without the container markers", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `await import(${JSON.stringify(join(import.meta.dir, "..", "lib", "runner", "bootstrap", "container-entry.ts"))}); console.log("loaded")`,
      ],
      { env: { PATH: process.env.PATH ?? "" }, stdin: "pipe", stdout: "pipe" },
    );
    cleanups.push(() => proc.kill("SIGKILL"));
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("loaded\n");
  }, 15_000);
});
