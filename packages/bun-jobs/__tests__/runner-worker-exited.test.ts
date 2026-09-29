import type {
  ExecutorEvents,
  ExecutorHandle,
  ExecutorStartOptions,
} from "../lib/runner/executors/executor";
import type { RunContext } from "../lib/runner/types";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { InProcessExecutor } from "../lib/runner/executors/in-process";
import { SpawnExecutor } from "../lib/runner/executors/spawn";
import { WorkerExecutor } from "../lib/runner/executors/worker";
import { makeTmpDir, waitFor } from "./helpers";
import { FakeWorker, installFakeWorker } from "./helpers/fakeWorker";

/**
 * `ExecutorHandle.exited`: when a `worker-thread` run's thread has actually
 * stopped, which is later than `done`. `done` settles the moment the executor
 * calls `terminate()`, which does not wait, and a busy Bun `Worker` keeps
 * running for a while after it (oven-sh/bun#44216) — so a close that awaited
 * `done` resolved with the thread still going.
 *
 * The real-thread tests place the thread's last side effect in time with a
 * stamp it writes on every turn (`spin-stamp.ts`). Those with a stand-in
 * `Worker` decide exactly when the "thread" stops, which a real one never
 * lets a test do.
 */

const handlers = join(import.meta.dir, "fixtures", "handlers");
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** One clock across threads, in milliseconds (see `spin-stamp.ts`). */
function now(): number {
  return performance.timeOrigin + performance.now();
}

/** Resolves with whether `promise` settled within `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true),
    Bun.sleep(ms).then(() => false),
  ]);
}

/** Events that record what arrived, and whether before or after `done`. */
function recordingEvents(): {
  events: ExecutorEvents;
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    events: {
      onProgress: (value) => seen.push(`progress:${JSON.stringify(value)}`),
      onMessage: (data) => seen.push(`message:${JSON.stringify(data)}`),
      onLog: (_level, message) => seen.push(`log:${message}`),
      onOutput: () => {},
      onConsole: (_stream, text) => seen.push(`console:${text.trim()}`),
      onPid: () => {},
    },
  };
}

/** Start options for `file`, with `args`, and nothing else of note. */
function startOptions(
  file: string,
  args: unknown,
  events: ExecutorEvents,
): ExecutorStartOptions {
  return {
    context: {
      runId: `r-${crypto.randomUUID()}`,
      runnerId: "exited",
      runnerName: "exited",
      namespace: "exited",
      attempt: 1,
      source: "manual",
      mode: "worker-thread",
      startedAt: Date.now(),
      deadline: null,
      args,
    } as unknown as RunContext,
    file,
    timeout: 0,
    closeTimeout: 10_000,
    killTimeout: 10_000,
    waitToExit: false,
    forwardLogs: true,
    captureConsole: true,
    events,
  };
}

/** Stops `handle` by force on the way out, whatever the test did. */
function reap(handle: ExecutorHandle): ExecutorHandle {
  cleanups.push(async () => {
    handle.stop("cleanup", { force: true });
    await within(handle.exited ?? handle.done, 5_000);
  });
  return handle;
}

/**
 * Reads `file` every 15 ms until it has not changed for 300 ms, for 5 s at
 * most: the value a thread left once it stopped writing, and whether it did.
 */
async function lastWrite(
  file: string,
): Promise<{ value: string; settled: boolean }> {
  const deadline = Date.now() + 5_000;
  let value = await Bun.file(file).text();
  let since = Date.now();
  while (Date.now() < deadline) {
    await Bun.sleep(15);
    const next = await Bun.file(file).text();
    if (next !== value) {
      value = next;
      since = Date.now();
    } else if (Date.now() - since >= 300) {
      return { value, settled: true };
    }
  }
  return { value, settled: false };
}

describe("WorkerExecutor: exited, with a real thread", () => {
  it("settles after done on a forced stop, and after the thread's last side effect", async () => {
    const tmp = await makeTmpDir("exited");
    cleanups.push(tmp.cleanup);
    const beacon = join(tmp.path, "beacon");
    const { events } = recordingEvents();
    const handle = reap(
      new WorkerExecutor({}).start(
        startOptions(
          join(handlers, "spin-stamp.ts"),
          { beaconFile: beacon, spinMs: 30_000 },
          events,
        ),
      ),
    );
    expect(handle.exited).toBeInstanceOf(Promise);
    await waitFor(async () => await Bun.file(beacon).exists(), {
      timeout: 10_000,
    });

    let doneAt = 0;
    let exitedAt = 0;
    void handle.done.then(() => {
      doneAt = now();
    });
    void handle.exited!.then(() => {
      exitedAt = now();
    });
    handle.stop("test", { force: true });
    expect((await handle.done).status).toBe("killed");
    // The thread always stops; how long Bun takes is not this test's claim.
    expect(await within(handle.exited!, 10_000)).toBe(true);

    const last = await lastWrite(beacon);
    expect(last.settled).toBe(true);
    expect(exitedAt).toBeGreaterThanOrEqual(doneAt);
    // Nothing the thread did came after `exited` said it had stopped.
    expect(Number(last.value)).toBeLessThanOrEqual(exitedAt);
  }, 30_000);

  it("settles when the run finishes on its own", async () => {
    const { events } = recordingEvents();
    const handle = new WorkerExecutor({}).start(
      startOptions(join(handlers, "echo.ts"), { value: 1 }, events),
    );
    const outcome = await handle.done;
    expect(outcome.status).toBe("success");
    const doneAt = now();
    expect(await within(handle.exited!, 5_000)).toBe(true);
    // Informational: what awaiting `exited` costs over `done` when the thread
    // was idle — its handler had returned — as `terminate()` took it.
    // eslint-disable-next-line no-console -- the gap is worth seeing in a run.
    console.info(
      `worker-thread exited ${(now() - doneAt).toFixed(1)} ms after done (run finished on its own)`,
    );
  });

  it("settles when the handler file does not exist", async () => {
    const { events } = recordingEvents();
    const handle = new WorkerExecutor({}).start(
      startOptions(join(handlers, "no-such-handler.ts"), null, events),
    );
    expect((await handle.done).status).toBe("failed");
    expect(await within(handle.exited!, 5_000)).toBe(true);
  });

  it("settles when the entry itself fails to load, before any run starts", async () => {
    const tmp = await makeTmpDir("exited-entry");
    cleanups.push(tmp.cleanup);
    const broken = join(tmp.path, "broken-entry.ts");
    writeFileSync(broken, `throw new Error("the entry failed to load");\n`);
    const entry = WorkerExecutor.entry;
    // `readonly` is a compile-time promise; the executor reads the static at
    // `start()`, so this points one run at an entry that throws on load.
    Object.defineProperty(WorkerExecutor, "entry", {
      value: new URL(`file://${broken}`),
      configurable: true,
    });
    let handle: ExecutorHandle;
    try {
      const { events } = recordingEvents();
      handle = new WorkerExecutor({}).start(
        startOptions(join(handlers, "echo.ts"), null, events),
      );
    } finally {
      Object.defineProperty(WorkerExecutor, "entry", {
        value: entry,
        configurable: true,
      });
    }
    expect((await handle.done).status).toBe("failed");
    expect(await within(handle.exited!, 5_000)).toBe(true);
  });

  it("stays settled, and hangs nothing, when stopped after the thread has gone", async () => {
    const { events } = recordingEvents();
    const handle = new WorkerExecutor({}).start(
      startOptions(join(handlers, "echo.ts"), { value: 2 }, events),
    );
    const outcome = await handle.done;
    await handle.exited;
    // Awaited again long after `close` fired, and after a `terminate()` on a
    // worker that has already exited: nothing waits for a second `close`.
    await Bun.sleep(50);
    handle.stop("late");
    handle.stop("later", { force: true });
    expect(await within(handle.exited!, 100)).toBe(true);
    expect(await handle.done).toBe(outcome);
  });
});

describe("WorkerExecutor: exited and late events, with a stand-in Worker", () => {
  it("stays pending until the thread's close, which settles it once", async () => {
    cleanups.push(installFakeWorker(false));
    const { events } = recordingEvents();
    const handle = new WorkerExecutor({}).start(
      startOptions("/unused.ts", null, events),
    );
    const fake = FakeWorker.instances[0]!;
    await waitFor(() => fake.received.some((message) => message.t === "start"));

    handle.stop("test", { force: true });
    expect((await handle.done).status).toBe("killed");
    expect(fake.terminations).toBe(1);
    expect(await within(handle.exited!, 100)).toBe(false);

    fake.exit();
    expect(await within(handle.exited!, 100)).toBe(true);
    // A second `close` (Bun sends one; a stand-in can send two) changes nothing.
    fake.closed = false;
    fake.exit();
    expect(await within(handle.exited!, 100)).toBe(true);
  });

  it("settles on a close that fired before anyone awaited it", async () => {
    cleanups.push(installFakeWorker(false));
    const { events } = recordingEvents();
    const handle = new WorkerExecutor({}).start(
      startOptions("/unused.ts", null, events),
    );
    const fake = FakeWorker.instances[0]!;
    await waitFor(() => fake.received.some((message) => message.t === "start"));
    // The thread ends before any result: `close` settles the run and `exited`.
    fake.exit();
    await Bun.sleep(20);
    expect((await handle.done).status).toBe("failed");
    expect(await within(handle.exited!, 100)).toBe(true);
  });

  it("settles on the close that follows an error before the run started", async () => {
    cleanups.push(installFakeWorker(false));
    const { events } = recordingEvents();
    const handle = new WorkerExecutor({}).start(
      startOptions("/unused.ts", null, events),
    );
    const fake = FakeWorker.instances[0]!;
    // What Bun does when the entry cannot load: `error`, then `close`.
    fake.dispatchEvent(
      new ErrorEvent("error", { message: "the entry failed to load" }),
    );
    expect((await handle.done).status).toBe("failed");
    fake.exit();
    expect(await within(handle.exited!, 100)).toBe(true);
  });

  it("drops a dying thread's progress and messages after settle, and still delivers its log lines and output", async () => {
    cleanups.push(installFakeWorker(false));
    const { events, seen } = recordingEvents();
    const options = startOptions("/unused.ts", null, events);
    const handle = new WorkerExecutor({}).start(options);
    const fake = FakeWorker.instances[0]!;
    await waitFor(() => fake.received.some((message) => message.t === "start"));
    const runId = options.context.runId;

    fake.emit({ t: "progress", runId, value: 1 });
    fake.emit({ t: "message", runId, data: "before" });
    handle.stop("test", { force: true });
    expect((await handle.done).status).toBe("killed");

    // Posted by the thread after the run was settled, before it stopped.
    fake.emit({ t: "progress", runId, value: 2 });
    fake.emit({ t: "message", runId, data: "after" });
    fake.emit({
      t: "log",
      runId,
      level: "warn",
      message: "last words",
      fields: {},
    });
    fake.emit({ t: "output", runId, stream: "stderr", chunk: "dying\n" });
    fake.exit();
    await handle.exited;

    expect(seen).toEqual([
      "progress:1",
      'message:"before"',
      "log:last words",
      "console:dying",
    ]);
  });
});

describe("exited on the other executors", () => {
  it("is absent where done already means the run has stopped", async () => {
    const { events } = recordingEvents();
    const spawned = new SpawnExecutor({
      stdout: "ignore",
      stderr: "ignore",
      startTimeout: 10_000,
    });
    const child = spawned.start({
      ...startOptions(join(handlers, "echo.ts"), { value: 3 }, events),
      captureConsole: false,
    });
    const inProcess = new InProcessExecutor().start(
      startOptions(join(handlers, "echo.ts"), { value: 4 }, events),
    );
    expect(child.exited).toBeUndefined();
    expect(inProcess.exited).toBeUndefined();
    expect((await child.done).status).toBe("success");
    expect((await inProcess.done).status).toBe("success");
  });
});
