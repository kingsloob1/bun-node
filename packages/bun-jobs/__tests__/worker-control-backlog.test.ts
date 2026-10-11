import type { QueueRef } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueueWorker,
  MemoryDriver,
  WORKER_CONFIG_PREFIX,
  WORKER_CONTROL_PREFIX,
  WORKER_STOP_PREFIX,
  workerEvent,
  writeWorkerControl,
  writeWorkerStop,
} from "../lib/index";
import { bumpWorkerChanges } from "../lib/queue/workerControl";
import { testNamespace, waitFor } from "./helpers";

/**
 * A worker's control passes never pile up behind a slow control store.
 *
 * Passes are chained so two never overlap, and every control event, every
 * move of the change counter and every `syncControl()` asks for one. When a
 * pass's reads outlast the gap between those asks, one queued per ask made
 * the chain grow without bound: the backlog drained as a burst of redundant
 * reads once the store recovered, and a caller awaiting a pass
 * (`syncControl()`, a controller in this process) waited for all of it. At
 * most one pass runs and one waits; every pass asked for meanwhile joins the
 * waiting one, which reads the stored entries when it starts.
 *
 * Real timers throughout: the delay is a real `Bun.sleep` in a driver
 * wrapper, so events really do arrive while a pass is in flight.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** How long each slowed control read takes, in ms. A pass makes two. */
const readMs = 100;
/** How long one slowed pass takes: its config read and its instruction read. */
const passMs = 2 * readMs;
/** How often the scenario asks for a pass, in ms: ten per pass. */
const askEvery = 20;
/** How long the store stays slow before a scenario measures, in ms. */
const slowFor = 1_500;

/** Whether `name` is one of the entries a control pass reads. */
function isControlRead(name: string): boolean {
  return (
    name.startsWith(WORKER_CONFIG_PREFIX) ||
    name.startsWith(WORKER_CONTROL_PREFIX) ||
    name.startsWith(WORKER_STOP_PREFIX)
  );
}

/**
 * A memory driver whose control reads are slowed by `delayMs` (changeable
 * while it runs). A read takes its value when it starts and answers after the
 * delay, like a round trip to a slow store, so a pass that started before a
 * write does not see it. Records when each pass started — its config read,
 * which every pass makes exactly once — and how many ever ran at once.
 */
function slowStore(
  /** How long each control read waits, in ms; `0` slows nothing. */
  delayMs: number,
) {
  const driver = new MemoryDriver();
  const getQueueState = driver.getQueueState.bind(driver);
  const state = {
    /** The current delay, in ms. */
    delayMs,
    /** When each pass started, `performance.now()`. */
    passes: [] as number[],
    /** Passes running right now. */
    running: 0,
    /** The most passes that ever ran at once. */
    overlap: 0,
    /** How many reads were slowed. */
    delayed: 0,
    /** Called once by the next instruction read, when it takes its value. */
    onInstructionRead: undefined as (() => void) | undefined,
    /**
     * Whether the test itself is reading — the read a controller's write
     * makes first — so it is neither slowed nor counted as the worker's.
     */
    bypass: false,
  };
  driver.getQueueState = async (q, name) => {
    if (state.bypass) {
      return await getQueueState(q, name);
    }
    const pass = name.startsWith(WORKER_CONFIG_PREFIX);
    if (pass) {
      state.passes.push(performance.now());
      state.running++;
      state.overlap = Math.max(state.overlap, state.running);
    }
    try {
      const value = await getQueueState(q, name);
      if (name.startsWith(WORKER_CONTROL_PREFIX)) {
        const taken = state.onInstructionRead;
        state.onInstructionRead = undefined;
        taken?.();
      }
      if (isControlRead(name) && state.delayMs > 0) {
        state.delayed++;
        await Bun.sleep(state.delayMs);
      }
      return value;
    } finally {
      if (pass) {
        state.running--;
      }
    }
  };
  /**
   * Resolves once a pass has taken its instruction read: a write after that
   * is one the pass in flight cannot see.
   */
  const instructionRead = async (): Promise<void> =>
    await new Promise<void>((resolve) => {
      state.onInstructionRead = resolve;
    });
  return { driver, state, instructionRead };
}

/** How the scenario asks for passes. */
type Asker = "subscription" | "change counter";

/**
 * A controllable worker on `driver`, following control the way `asker`
 * needs: subscribed to the worker channel, or polling the change counter.
 * The heartbeat is slow enough to stay out of the way.
 */
function controlled(
  driver: MemoryDriver,
  /** How passes are asked for. */
  asker: Asker,
  /** Extra worker options. */
  extra: {
    /** Run it at once (default), or leave that to the test. */
    run?: boolean;
    /** Persist stops against the key. */
    keyStop?: boolean;
  } = {},
) {
  const ref: QueueRef = { ns: testNamespace(), queue: "control-backlog" };
  const worker = new BunQueueWorker<unknown, unknown>(
    ref.queue,
    async () => null,
    {
      namespace: ref.ns,
      driver,
      logger: noopLogger,
      control:
        asker === "subscription"
          ? { subscribe: true }
          : { subscribe: false, interval: 100 },
      reportInterval: 10_000,
      pollInterval: 10,
      waitToExit: false,
      ...(extra.keyStop === true ? { stopPersistence: "key" as const } : {}),
    },
  );
  closers.push(async () => await worker.close({ force: true }));
  if (extra.run !== false) {
    void worker.run();
  }
  return { worker, ref };
}

/**
 * Asks for a pass every {@link askEvery} ms the way `asker` does — a control
 * event addressed to the queue, or a move of the change counter — until the
 * returned function is called.
 */
function keepAsking(
  driver: MemoryDriver,
  ref: QueueRef,
  /** How. */
  asker: Asker,
): () => void {
  const timer = setInterval(() => {
    if (asker === "subscription") {
      void driver.publish(
        workerEvent(
          { ns: ref.ns, target: ref.queue, type: "control", origin: "test" },
          { action: "pause", seq: 1 },
        ),
      );
    } else {
      void bumpWorkerChanges(driver, ref);
    }
  }, askEvery);
  return () => clearInterval(timer);
}

/** The most entries of `times` that fall in any window `width` ms wide. */
function densest(times: number[], width: number): number {
  let most = 0;
  for (let i = 0; i < times.length; i++) {
    let n = 0;
    for (let j = i; j < times.length && times[j]! - times[i]! < width; j++) {
      n++;
    }
    most = Math.max(most, n);
  }
  return most;
}

/** Resolves `promise`'s duration in ms, or `undefined` past `limitMs`. */
async function timed(
  promise: Promise<unknown>,
  /** How long to wait for it, in ms. */
  limitMs: number,
): Promise<number | undefined> {
  const started = performance.now();
  const outcome = await Promise.race([
    promise.then(() => "done" as const),
    Bun.sleep(limitMs).then(() => "late" as const),
  ]);
  return outcome === "done" ? performance.now() - started : undefined;
}

/**
 * Writes a lifecycle instruction for `worker`'s current incarnation, at once:
 * the write's own reads bypass the slowed store, so it lands before the pass
 * in flight moves on.
 */
async function instruct(
  store: ReturnType<typeof slowStore>,
  worker: BunQueueWorker<unknown, unknown>,
  /** What it should be. */
  desired: "paused" | "running",
): Promise<void> {
  store.state.bypass = true;
  try {
    await writeWorkerControl(store.driver, worker.ref, {
      id: worker.id,
      key: worker.key,
      incarnation: worker.processStartedAt,
      state: desired,
    });
  } finally {
    store.state.bypass = false;
  }
}

describe("BunQueueWorker: control passes never pile up behind a slow store", () => {
  for (const asker of ["subscription", "change counter"] as const) {
    describe(`asked for by the ${asker}, faster than a pass takes`, () => {
      it("drains no backlog once the store recovers", async () => {
        const { driver, state } = slowStore(readMs);
        const { worker, ref } = controlled(driver, asker);
        await new Promise<void>((resolve) => worker.once("ready", resolve));

        const stop = keepAsking(driver, ref, asker);
        await Bun.sleep(slowFor);
        stop();
        // The slowness really ran, across many passes.
        expect(state.delayed).toBeGreaterThan(4);
        state.delayMs = 0;
        const recovered = performance.now();
        // The pass in flight finishes within one pass; anything queued
        // behind it runs then, back to back.
        await Bun.sleep(passMs + 300);

        const after = state.passes.filter((t) => t >= recovered);
        // The queued one, and nothing more: a backlog of about
        // (slowFor / askEvery − slowFor / passMs) ≈ 67 by subscription, or
        // ≈ 7 by the change counter, drained as a burst of that many passes.
        expect(after.length).toBeLessThanOrEqual(2);
        expect(densest(after, passMs)).toBeLessThanOrEqual(2);
        // And the chain still never overlaps two passes.
        expect(state.overlap).toBe(1);
      }, 30_000);

      it("lets syncControl() wait only for the pass in flight and its own", async () => {
        const store = slowStore(readMs);
        const { driver, state, instructionRead } = store;
        const { worker, ref } = controlled(driver, asker);
        await new Promise<void>((resolve) => worker.once("ready", resolve));

        const stop = keepAsking(driver, ref, asker);
        closers.push(async () => stop());
        await Bun.sleep(slowFor);
        expect(state.delayed).toBeGreaterThan(4);

        // Written just after the pass in flight read its instruction, so only
        // a pass that starts later can see it.
        await instructionRead();
        await instruct(store, worker, "paused");
        // The pass in flight, then its own: two passes, with room for a
        // loaded machine. Waiting for a backlog took one pass per ask.
        const took = await timed(worker.syncControl(), 5 * passMs);
        stop();
        expect(took).toBeDefined();
        // Its own pass read the instruction written before it was asked for:
        // it joined a pass that had not started, never the one in flight.
        expect(worker.isPaused()).toBe(true);
        expect(state.overlap).toBe(1);
      }, 60_000);

      it("loses no instruction written while a pass runs and one waits", async () => {
        const store = slowStore(readMs);
        const { driver, state, instructionRead } = store;
        const { worker, ref } = controlled(driver, asker);
        await new Promise<void>((resolve) => worker.once("ready", resolve));

        // Each written just after the pass in flight read its instruction,
        // and announced once, as a controller does, after which nothing more
        // is asked: the announcement's pass — the waiting one it joined, or
        // a new one — has to read it. The heartbeat is ten seconds away.
        for (const desired of ["paused", "running"] as const) {
          const stop = keepAsking(driver, ref, asker);
          closers.push(async () => stop());
          await Bun.sleep(slowFor / 3);
          await instructionRead();
          stop();
          await instruct(store, worker, desired);
          const announce = keepAsking(driver, ref, asker);
          await Bun.sleep(askEvery + 5);
          announce();
          await waitFor(() => worker.isPaused() === (desired === "paused"), {
            timeout: 4 * passMs,
            message: `the ${desired} instruction was never adopted`,
          });
        }
        expect(state.overlap).toBe(1);
      }, 30_000);
    });
  }

  it("keeps the startup pass's key-stop read when it joins a waiting pass", async () => {
    const { driver, state } = slowStore(readMs);
    const { worker, ref } = controlled(driver, "subscription", {
      run: false,
      keyStop: true,
    });
    await writeWorkerStop(driver, ref, worker.key, true);

    // One pass in flight and one waiting before `run()`: its startup pass,
    // which alone reads the stop recorded against the key, joins the waiting
    // one, which must then read it too.
    void worker.syncControl();
    void worker.syncControl();
    await Bun.sleep(readMs / 4);
    void worker.run();
    await new Promise<void>((resolve) => worker.once("ready", resolve));

    expect(worker.state).toBe("stopped");
    expect(state.overlap).toBe(1);
  }, 15_000);

  it("negative control: with the store instant, the same checks pass", async () => {
    const store = slowStore(0);
    const { driver, state } = store;
    const { worker, ref } = controlled(driver, "subscription");
    await new Promise<void>((resolve) => worker.once("ready", resolve));

    const stop = keepAsking(driver, ref, "subscription");
    closers.push(async () => stop());
    await Bun.sleep(slowFor / 3);
    expect(state.delayed).toBe(0);
    // Instant passes keep up with every ask.
    expect(state.passes.length).toBeGreaterThan(10);
    expect(state.overlap).toBe(1);

    await instruct(store, worker, "paused");
    const took = await timed(worker.syncControl(), 5 * passMs);
    stop();
    expect(took).toBeDefined();
    expect(worker.isPaused()).toBe(true);
  }, 15_000);
});
