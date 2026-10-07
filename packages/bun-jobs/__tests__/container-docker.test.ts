import type { ContainerTarget } from "../lib/index";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  IsolationUnavailableError,
  MemoryDriver,
} from "../lib/index";
import { ContainerEngine } from "../lib/queue/container/engine";
import { ContainerExecutor } from "../lib/queue/container/executor";
import { resolveContainerTarget } from "../lib/queue/container/target";
import { buildChildEnv } from "../lib/shared/childEnv";
import { testNamespace, waitFor } from "./helpers";

/**
 * The `container` target against a real engine: what a fake cannot show —
 * that the hardening holds inside a real container, that a close written
 * before the container exists still reaches it through the engine's attach,
 * that a kill leaves nothing behind, and that the sweep finds real labels.
 *
 * Needs a Docker the current user can reach and the `oven/bun:1` image
 * (`I1_TEST_IMAGE` overrides it); without either, every test here **skips,
 * and says why** on stderr. The repo itself is bind-mounted read-only at its
 * own path, so the image needs nothing installed: the processor and
 * bun-jobs are the worktree's own. On snap Docker, whose AppArmor profile
 * refuses `no-new-privileges`, the target asks for the snap's profile, and
 * one test shows the probe refusing to run without it.
 *
 * Every container is labelled with a worker key starting `i1test-`, and only
 * those keys' containers are ever removed.
 */

const IMAGE = process.env.I1_TEST_IMAGE ?? "oven/bun:1";
const ROOT = resolve(import.meta.dir, "..", "..", "..");
const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "container", `${name}.ts`);

/** Runs `docker` with an explicit environment, as the target does. */
function docker(args: string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const env = buildChildEnv({
    passEnv: ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"],
  });
  const path = Bun.which("docker", { PATH: env.PATH ?? "" });
  if (!path) {
    return { code: 127, stdout: "", stderr: "docker is not on PATH" };
  }
  const result = Bun.spawnSync([path, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Why the suite cannot run here, or `undefined` when it can. */
const skipReason = (() => {
  const version = docker(["version", "--format={{.Server.Version}}"]);
  if (version.code !== 0) {
    return `no reachable Docker (${version.stderr.trim() || `exit ${version.code}`})`;
  }
  if (docker(["image", "inspect", "--format={{.Id}}", IMAGE]).code !== 0) {
    return `the image ${IMAGE} is not present (docker pull ${IMAGE})`;
  }
  return undefined;
})();

if (skipReason) {
  // eslint-disable-next-line no-console -- the output is what the test reads
  console.warn(`[container-docker.test.ts] SKIPPED, every test: ${skipReason}`);
}

/** Snap Docker: its AppArmor profile breaks no-new-privileges under docker-default. */
const SNAP = (Bun.which("docker") ?? "").startsWith("/snap/");
const SECURITY: ContainerTarget["security"] = SNAP
  ? { apparmor: "snap.docker.dockerd" }
  : undefined;

/** A writable directory under the repo (snap Docker cannot read /tmp). */
const SCRATCH = join(import.meta.dir, `.container-scratch-${process.pid}`);

/** The worker keys this run used, whose containers it may remove. */
const keys = new Set<string>();
const cleanups: (() => Promise<unknown> | unknown)[] = [];

// Closing a worker on a loaded machine (a forced close's reap, an engine's
// CLI) can outlast the default 5 s hook budget.
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await Promise.resolve(cleanup()).catch(() => undefined);
  }
}, 60_000);

// One listing and one removal for every key this run used, rather than two
// engine calls per key: on a loaded machine those outlasted the default hook
// budget, the hook was abandoned, and containers were left behind.
afterAll(() => {
  if (keys.size > 0) {
    const ids = lines(
      docker([
        "ps",
        "--all",
        `--format={{.ID}} {{.Label "bun-jobs.worker-key"}}`,
        "--filter=label=bun-jobs.worker-key",
      ]).stdout,
    )
      .map((line) => line.split(" "))
      .filter(([, key]) => key !== undefined && keys.has(key))
      .map(([id]) => id!);
    if (ids.length > 0) {
      docker(["rm", "--force", ...ids]);
    }
  }
  rmSync(SCRATCH, { recursive: true, force: true });
}, 60_000);

/** A fresh marker directory the container (uid 65534) can write. */
function markerDir(): string {
  const dir = join(SCRATCH, Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  chmodSync(SCRATCH, 0o777);
  chmodSync(dir, 0o777);
  return dir;
}

/** A test-only worker key, remembered for the cleanup. */
function testKey(): string {
  const key = `i1test-${Math.random().toString(36).slice(2, 10)}`;
  keys.add(key);
  return key;
}

/** The target every test starts from: the repo mounted at its own path. */
function target(
  extra: Partial<ContainerTarget> = {},
  scratch?: string,
): ContainerTarget {
  return {
    kind: "container",
    image: IMAGE,
    pull: "never",
    closeTimeout: 2000,
    mounts: [
      { source: ROOT, target: ROOT },
      ...(scratch
        ? [{ source: scratch, target: scratch, readOnly: false }]
        : []),
    ],
    ...(SECURITY ? { security: SECURITY } : {}),
    ...extra,
  };
}

/** A queue and a worker on the real engine. */
function setup(
  processor: string,
  extra: Partial<ContainerTarget> = {},
  scratch?: string,
) {
  const driver = new MemoryDriver();
  const namespace = testNamespace("i1d");
  const key = testKey();
  const queue = new BunQueue("boxed", {
    namespace,
    driver,
    logger: noopLogger,
  });
  const worker = new BunQueueWorker("boxed", fixture(processor), {
    namespace,
    driver,
    key,
    logger: noopLogger,
    pollInterval: 10,
    waitToExit: false,
    target: target(extra, scratch),
  });
  cleanups.push(
    () => queue.close(),
    () => worker.close({ force: true }),
  );
  return { queue, worker, key };
}

/** This key's containers, as the engine lists them. */
function containersOf(key: string): string[] {
  return lines(
    docker([
      "ps",
      "--all",
      "--quiet",
      `--filter=label=bun-jobs.worker-key=${key}`,
    ]).stdout,
  );
}

/** The non-empty lines of a command's output. */
function lines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

async function settled(
  queue: BunQueue,
  id: string,
  states = ["completed", "dead"],
) {
  await waitFor(
    async () => states.includes((await queue.getJob(id))?.state ?? ""),
    {
      timeout: 60_000,
      interval: 50,
      message: async () => `job ${id} is ${(await queue.getJob(id))?.state}`,
    },
  );
  return (await queue.getJob(id))!;
}

describe.skipIf(skipReason !== undefined)(
  "the container target on a real Docker",
  () => {
    it("runs a job in a hardened container: nobody, no capabilities, no network, read-only root, no host env", async () => {
      process.env.I1_SECRET_PROBE = "s3cret";
      cleanups.push(() => delete process.env.I1_SECRET_PROBE);
      const { queue, worker, key } = setup("echo", {
        env: { NODE_ENV: "test" },
      });
      void worker.run();
      const job = await queue.add(
        "echo",
        { n: 1 },
        { removeOnComplete: false },
      );
      const stored = await settled(queue, job.id);
      expect(stored.state).toBe("completed");
      const result = stored.returnValue as {
        data: unknown;
        uid: number;
        mode: string;
        env: string[];
        secret: string | null;
        lockHeld: boolean;
      };
      expect(result.data).toEqual({ n: 1 });
      expect(result.uid).toBe(65534);
      expect(result.mode).toBe("container");
      expect(result.secret).toBeNull();
      expect(result.lockHeld).toBe(true);
      expect(result.env).not.toContain("I1_SECRET_PROBE");
      expect(result.env).toContain("NODE_ENV");
      expect(stored.progress).toBe(50);
      const { logs } = await queue.getJobLogs(job.id);
      expect([...logs].sort()).toEqual(
        [
          "a line on stderr",
          "a line through the channel",
          "hello from the container",
        ].sort(),
      );
      await waitFor(() => containersOf(key).length === 0, { timeout: 10_000 });
    }, 120_000);

    it("holds the fixed hardening inside the container", async () => {
      const { queue, worker } = setup("hardening");
      void worker.run();
      const job = await queue.add("hardening", {}, { removeOnComplete: false });
      const stored = await settled(queue, job.id);
      expect(stored.returnValue).toMatchObject({
        uid: 65534,
        gid: 65534,
        capEff: "0000000000000000",
        noNewPrivs: "1",
        writeRoot: "EROFS",
        writeTmp: "ok",
      });
      expect((stored.returnValue as { network: string }).network).not.toBe(
        "reached",
      );
    }, 120_000);

    it("times out a container that blocks its thread, kills it, and leaves nothing behind", async () => {
      const { queue, worker, key } = setup("spin");
      void worker.run();
      const job = await queue.add("spin", {}, { timeout: 3000, attempts: 1 });
      const stored = await settled(queue, job.id, ["dead"]);
      expect(stored.failedReason?.name).toBe("JobTimeoutError");
      await waitFor(() => containersOf(key).length === 0, {
        timeout: 30_000,
        message: () => `left behind: ${containersOf(key).join(", ")}`,
      });
    }, 120_000);

    describe("an attempt stopped by the executor", () => {
      function executor(
        processor: string,
        scratch: string,
        extra: Partial<ContainerTarget> = {},
      ) {
        const key = testKey();
        return {
          key,
          executor: new ContainerExecutor(
            resolveContainerTarget(
              target({ env: { MARKER_DIR: scratch }, ...extra }, scratch),
            ),
            {
              workerKey: key,
              workerId: `${key}.1`,
              namespace: "ns",
              queue: "q",
            },
            fixture(processor),
          ),
        };
      }

      function start(executorToStart: ContainerExecutor) {
        return executorToStart.start({
          context: {
            runId: "job-1.1",
            runnerId: "q",
            runnerName: "w",
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
          file: "unused",
          timeout: 0,
          closeTimeout: 2000,
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
            attemptsMade: 1,
            maxAttempts: 1,
            stacktrace: [],
            repeatKey: null,
          } as never,
          events: {
            onProgress: () => {},
            onMessage: () => {},
            onLog: () => {},
            onOutput: () => {},
            onPid: () => {},
          },
        });
      }

      it("ends a container stopped from outside (docker stop) as a close: 143, RunKilledError", async () => {
        const scratch = markerDir();
        const { executor: container, key } = executor("abortable", scratch);
        const handle = start(container);
        await waitFor(() => existsSync(join(scratch, "started")), {
          timeout: 60_000,
          interval: 50,
        });
        const [id] = containersOf(key);
        expect(id).toBeDefined();
        // `-t 30`: without a SIGTERM handler, Bun as PID 1 would sit out all
        // 30 s and be killed (137).
        const started = performance.now();
        expect(docker(["stop", "-t", "30", id!]).code).toBe(0);
        const outcome = await handle.done;
        expect(performance.now() - started).toBeLessThan(25_000);
        expect(outcome.exitCode).toBe(143);
        expect(outcome.status).toBe("failed");
        expect(outcome.error?.name).toBe("RunKilledError");
        expect(existsSync(join(scratch, "aborted"))).toBe(true);
        await handle.exited;
        expect(containersOf(key)).toEqual([]);
      }, 120_000);

      it("kills a container that ignores its close: exit 137, removed before exited settles", async () => {
        const scratch = markerDir();
        const { executor: container, key } = executor("spin", scratch);
        const handle = start(container);
        await waitFor(() => existsSync(join(scratch, "started")), {
          timeout: 60_000,
          interval: 50,
        });
        handle.stop("a test");
        const outcome = await handle.done;
        expect(outcome.status).toBe("killed");
        expect(outcome.exitCode).toBe(137);
        await handle.exited;
        expect(containersOf(key)).toEqual([]);
      }, 120_000);

      it("ends a close sent while the container is still being created, without importing the processor", async () => {
        const scratch = markerDir();
        const { executor: container, key } = executor(
          "import-marker",
          scratch,
          {
            closeTimeout: 30_000,
          },
        );
        const handle = start(container);
        // At once: the CLI has only just been spawned, nothing exists yet.
        handle.stop("close");
        const outcome = await handle.done;
        expect(outcome.status).toBe("killed");
        expect(outcome.error?.name).toBe("RunKilledError");
        expect(outcome.exitCode).toBe(143);
        expect(existsSync(join(scratch, "imported"))).toBe(false);
        await handle.exited;
        expect(containersOf(key)).toEqual([]);
      }, 120_000);

      it("removes a container a forced stop reached before it existed, without importing the processor", async () => {
        const scratch = markerDir();
        const { executor: container, key } = executor("import-marker", scratch);
        const handle = start(container);
        handle.stop("close", { force: true });
        const outcome = await handle.done;
        expect(outcome.status).toBe("killed");
        expect(outcome.exitCode).toBe(137);
        await handle.exited;
        expect(containersOf(key)).toEqual([]);
        expect(existsSync(join(scratch, "imported"))).toBe(false);
      }, 120_000);
    });

    it("reads results and answers requests after output without a trailing newline", async () => {
      for (const [processor, expected] of [
        ["partial-write", "ok"],
        ["partial-then-log", { count: expect.any(Number) }],
      ] as const) {
        const { queue, worker } = setup(processor);
        void worker.run();
        const job = await queue.add(
          "p",
          {},
          {
            removeOnComplete: false,
            attempts: 1,
            timeout: 30_000,
          },
        );
        const stored = await settled(queue, job.id);
        expect({ processor, state: stored.state }).toEqual({
          processor,
          state: "completed",
        });
        expect(stored.returnValue).toEqual(expected);
      }
    }, 120_000);

    it("ends a run whose processor sends itself SIGTERM, rather than hanging", async () => {
      const { queue, worker } = setup("sigterm-self");
      void worker.run();
      const started = performance.now();
      const job = await queue.add("s", {}, { attempts: 1, timeout: 60_000 });
      const stored = await settled(queue, job.id);
      expect(stored.state).toBe("dead");
      expect(stored.failedReason?.name).toBe("RunKilledError");
      // closeTimeout is 2 s; the job's own timeout, 60 s, never fired.
      expect(performance.now() - started).toBeLessThan(30_000);
    }, 120_000);

    it("stops a blocked processor's container within seconds of its worker being SIGKILLed", async () => {
      const scratch = markerDir();
      const key = testKey();
      const extra = target({ env: { MARKER_DIR: scratch } }, scratch);
      const child = Bun.spawn(
        [
          process.execPath,
          fixture("worker-process"),
          fixture("spin"),
          IMAGE,
          key,
          JSON.stringify({
            closeTimeout: extra.closeTimeout,
            env: extra.env,
            mounts: extra.mounts,
            ...(extra.security ? { security: extra.security } : {}),
          }),
        ],
        {
          env: buildChildEnv({
            passEnv: ["DOCKER_HOST"],
            env: { MARKER_DIR: scratch },
          }),
          stdout: "pipe",
          stderr: "inherit",
        },
      );
      cleanups.push(() => child.kill("SIGKILL"));
      const reader = child.stdout.getReader();
      let said = "";
      while (!said.includes("STARTED")) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        said += new TextDecoder().decode(value);
      }
      expect(containersOf(key)).toHaveLength(1);
      const killed = performance.now();
      child.kill("SIGKILL");
      await child.exited;
      await waitFor(() => containersOf(key).length === 0, {
        timeout: 20_000,
        interval: 200,
        message: () => `still there: ${containersOf(key).join(", ")}`,
      });
      // closeTimeout is 2 s: well inside 15.
      expect(performance.now() - killed).toBeLessThan(15_000);
    }, 120_000);

    it("sweeps a dead worker's containers by their labels, and keeps a live one's", async () => {
      const key = testKey();
      const namespace = "i1d-sweep";
      const labelled = (name: string, workerId: string) =>
        docker([
          "run",
          "--detach",
          `--name=${name}`,
          "--network=none",
          `--label=bun-jobs.worker-key=${key}`,
          `--label=bun-jobs.worker-id=${workerId}`,
          `--label=bun-jobs.namespace=${namespace}`,
          "--label=bun-jobs.queue=boxed",
          "--entrypoint=sleep",
          ...(SNAP ? ["--security-opt=apparmor=snap.docker.dockerd"] : []),
          IMAGE,
          "300",
        ]);
      const suffix = Math.random().toString(36).slice(2, 8);
      // Removed by this test itself, not only by the run's afterAll.
      cleanups.push(() =>
        docker([
          "rm",
          "--force",
          `${key}-dead-${suffix}`,
          `${key}-live-${suffix}`,
        ]),
      );
      expect(labelled(`${key}-dead-${suffix}`, "dead.1").code).toBe(0);
      expect(labelled(`${key}-live-${suffix}`, "live.1").code).toBe(0);

      const engine = new ContainerEngine({ cli: "docker", host: undefined });
      const removed = await engine.sweep(
        { workerKey: key, workerId: "me.1", namespace, queue: "boxed" },
        new Set(["live.1"]),
        noopLogger,
        { minAge: 0 },
      );
      expect(removed).toEqual([`${key}-dead-${suffix}`]);
      const left = lines(
        docker([
          "ps",
          "--all",
          "--format={{.Names}}",
          `--filter=label=bun-jobs.worker-key=${key}`,
        ]).stdout,
      );
      expect(left).toEqual([`${key}-live-${suffix}`]);
    }, 120_000);

    it("fails fast with the image step for an image that is missing under pull: never", async () => {
      const { worker } = setup("echo", {
        image: "i1test/does-not-exist:never",
      });
      const error = await worker.run().then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(IsolationUnavailableError);
      expect((error as IsolationUnavailableError).context.step).toBe("image");
    }, 120_000);

    it.skipIf(!SNAP)(
      "on snap Docker, fails the probe without the snap's AppArmor profile, saying so",
      async () => {
        const driver = new MemoryDriver();
        const worker = new BunQueueWorker("boxed", fixture("echo"), {
          namespace: testNamespace("i1d"),
          driver,
          key: testKey(),
          logger: noopLogger,
          target: { ...target(), security: undefined },
        });
        cleanups.push(() => worker.close({ force: true }));
        const error = await worker.run().then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(IsolationUnavailableError);
        const isolation = error as IsolationUnavailableError;
        expect(isolation.context.step).toBe("probe");
        expect(isolation.context.stderr).toContain("operation not permitted");
        expect(isolation.message).toContain('apparmor: "snap.docker.dockerd"');
      },
      120_000,
    );
  },
);
