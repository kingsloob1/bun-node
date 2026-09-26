import type {
  RunnerContender,
  RunnerHandle,
  RunnerSetupContext,
} from "../../lib/types";
import { basename, dirname } from "node:path";
import { deferred } from "../../lib/harness";

/**
 * Everything `BunRunner` is measured against.
 *
 * Two different things sit in this file, and the report keeps them apart.
 * Bree and Agenda are runners in the same sense: they own a run, they can be
 * asked for one on demand, and something survives the process. croner,
 * node-cron, node-schedule and toad-scheduler are cron *timers* — they call a
 * function in the current process and keep no state at all. They are here as
 * the floor: whatever they cost is what a run costs when nothing is isolated
 * and nothing is durable.
 */

/* ------------------------------------------------------------------ *
 * Bree — a file per run, in a worker thread
 * ------------------------------------------------------------------ */

/** Bree, the closest thing on npm to what `BunRunner` does. */
export const bree: RunnerContender = {
  id: "bree",
  label: "Bree",
  backend: "memory",
  execution: "worker-thread",
  durable: false,
  note: "a fresh Worker per run, like BunRunner's worker-thread mode; keeps no state between processes",
  async setup(ctx: RunnerSetupContext): Promise<RunnerHandle> {
    const Bree = (await import("bree")).default;

    // Bree resolves a job by name inside `root`, so the fixture's directory
    // is the root and its basename is the job.
    const root = dirname(ctx.file);
    const jobName = basename(ctx.file).replace(/\.[cm]?js$/, "");

    let instance: InstanceType<typeof Bree> | undefined;
    let onFire: ((at: number) => void) | undefined;

    /**
     * Builds a Bree, optionally on a cron.
     *
     * A schedule has to be declared in the job Bree is constructed with —
     * adding one to a live instance and restarting that job does not arm it —
     * so the instance is rebuilt when the scenario needs a different shape.
     */
    const build = async (cron: string | null) => {
      await instance?.stop().catch(() => {});

      instance = new Bree({
        root,
        jobs: [
          cron ? { name: jobName, cron, hasSeconds: true } : { name: jobName },
        ],
        logger: false,
        // Nothing may run until it is asked for, or the dispatch figure
        // would be racing a start-up run.
        timeout: false,
        interval: 0,
        errorHandler: (error: unknown) => ctx.onError(error),
        workerMessageHandler: (metadata: { message?: unknown }) => {
          if (metadata?.message !== "done") ctx.onStart(performance.now());
        },
      });

      // Drift is scheduler accuracy, so the timestamp is taken where Bree
      // decides to fire. Waiting for the worker's first message instead would
      // add its start-up to the figure — that cost is what `dispatch`
      // measures, and charging it twice would misreport both.
      instance.on("worker created", (name: string) => {
        if (name === jobName) onFire?.(Date.now());
      });

      await instance.start();
      return instance;
    };

    await build(null);

    return {
      async trigger() {
        const live = instance!;
        const gate = deferred<void>();
        const finished = (name: string) => {
          if (name !== jobName) return;
          live.removeListener("worker deleted", finished);
          ctx.onFinish(performance.now());
          gate.resolve();
        };
        live.on("worker deleted", finished);
        await live.run(jobName);
        await gate.promise;
      },

      async schedule(fire) {
        onFire = fire;
        await build("* * * * * *");
      },

      async unschedule() {
        onFire = undefined;
        await instance?.stop().catch(() => {});
      },

      async close() {
        await instance?.stop().catch(() => {});
      },
    };
  },
};

/* ------------------------------------------------------------------ *
 * Agenda — a durable scheduler, but the handler is a function
 * ------------------------------------------------------------------ */

/** Agenda on one of its storage backends. */
export function agendaRunner(kind: "mongodb" | "redis"): RunnerContender {
  return {
    id: `agenda-${kind}`,
    label: `Agenda (${kind})`,
    backend: kind,
    execution: "in-process",
    durable: true,
    note:
      "durable and exclusive across processes, but the handler is an " +
      "in-process function, not a file — no isolation to pay for",
    async setup(ctx: RunnerSetupContext): Promise<RunnerHandle> {
      const { Agenda } = await import("agenda");

      const backend = await (async () => {
        if (kind === "redis") {
          const { RedisBackend } = await import("@agendajs/redis-backend");
          return new RedisBackend({
            connectionString: ctx.url,
            keyPrefix: `bench-runner:${ctx.name}`,
          });
        }
        const { MongoBackend } = await import("@agendajs/mongo-backend");
        return new MongoBackend({
          address: ctx.url,
          collection: `benchRunner_${ctx.name}`,
        });
      })();

      // A number, not a string: Agenda parses a string with `human-interval`,
      // which returns NaN for "50 ms" and silently falls back to its 5-second
      // default. 50ms matches what the queue benchmarks give every polling
      // library.
      const agenda = new Agenda({
        backend,
        processEvery: 50,
        // Parity with the queue entries: nothing here keeps a history.
        removeOnComplete: true,
      });
      agenda.on("error", ctx.onError);

      let onFire: ((at: number) => void) | undefined;
      /** Settles the trigger currently in flight, if any. */
      let pending: (() => void) | null = null;

      agenda.define(ctx.name, async () => {
        ctx.onStart(performance.now());
        onFire?.(Date.now());
      });

      agenda.on(`success:${ctx.name}`, () => {
        ctx.onFinish(performance.now());
        pending?.();
        pending = null;
      });
      agenda.on(`fail:${ctx.name}`, (error: unknown) => {
        ctx.onError(error);
        pending?.();
        pending = null;
      });

      await agenda.start();

      return {
        async trigger() {
          const gate = deferred<void>();
          pending = gate.resolve;
          await agenda.now(ctx.name, {});
          await gate.promise;
        },

        async schedule(fire) {
          onFire = fire;
          await agenda.every("* * * * * *", ctx.name, {});
        },

        async unschedule() {
          onFire = undefined;
          await agenda.cancel({ name: ctx.name });
        },

        async close() {
          await agenda.cancel({ name: ctx.name }).catch(() => {});
          await agenda.stop().catch(() => {});
          await (backend as unknown as { close?: () => Promise<void> })
            .close?.()
            .catch(() => {});
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * In-process cron timers — the floor
 * ------------------------------------------------------------------ */

/** What every in-process timer shares. */
const TIMER_NOTE =
  "an in-process timer: no isolation, no persistence, no exclusivity — " +
  "this is what a run costs when none of that is provided";

/** croner. */
export const croner: RunnerContender = {
  id: "croner",
  label: "croner",
  backend: "memory",
  execution: "in-process",
  durable: false,
  note: TIMER_NOTE,
  async setup(ctx: RunnerSetupContext): Promise<RunnerHandle> {
    const { Cron } = await import("croner");
    let onFire: ((at: number) => void) | undefined;
    let job: InstanceType<typeof Cron> | undefined;

    /** The body every contender in this group runs. */
    const body = () => {
      ctx.onStart(performance.now());
      onFire?.(Date.now());
    };

    return {
      async trigger() {
        body();
        ctx.onFinish(performance.now());
      },

      async schedule(fire) {
        onFire = fire;
        job = new Cron("* * * * * *", body);
      },

      async unschedule() {
        onFire = undefined;
        job?.stop();
        job = undefined;
      },

      async close() {
        job?.stop();
      },
    };
  },
};

/** node-cron. */
export const nodeCron: RunnerContender = {
  id: "node-cron",
  label: "node-cron",
  backend: "memory",
  execution: "in-process",
  durable: false,
  note: TIMER_NOTE,
  async setup(ctx: RunnerSetupContext): Promise<RunnerHandle> {
    const { schedule } = await import("node-cron");
    let onFire: ((at: number) => void) | undefined;
    let task: ReturnType<typeof schedule> | undefined;

    const body = () => {
      ctx.onStart(performance.now());
      onFire?.(Date.now());
    };

    return {
      async trigger() {
        body();
        ctx.onFinish(performance.now());
      },

      async schedule(fire) {
        onFire = fire;
        task = schedule("* * * * * *", body);
      },

      async unschedule() {
        onFire = undefined;
        await task?.destroy();
        task = undefined;
      },

      async close() {
        // node-cron's `destroy()` may hand back a plain value, not a promise.
        await Promise.resolve(task?.destroy()).catch(() => {});
      },
    };
  },
};

/** node-schedule. */
export const nodeSchedule: RunnerContender = {
  id: "node-schedule",
  label: "node-schedule",
  backend: "memory",
  execution: "in-process",
  durable: false,
  note: TIMER_NOTE,
  async setup(ctx: RunnerSetupContext): Promise<RunnerHandle> {
    const scheduleModule = await import("node-schedule");
    let onFire: ((at: number) => void) | undefined;
    let job: ReturnType<typeof scheduleModule.scheduleJob> | undefined;

    const body = () => {
      ctx.onStart(performance.now());
      onFire?.(Date.now());
    };

    return {
      async trigger() {
        body();
        ctx.onFinish(performance.now());
      },

      async schedule(fire) {
        onFire = fire;
        job = scheduleModule.scheduleJob("* * * * * *", body);
      },

      async unschedule() {
        onFire = undefined;
        job?.cancel();
        job = undefined;
      },

      async close() {
        job?.cancel();
        await scheduleModule.gracefulShutdown().catch(() => {});
      },
    };
  },
};

/** toad-scheduler. */
export const toadScheduler: RunnerContender = {
  id: "toad-scheduler",
  label: "toad-scheduler",
  backend: "memory",
  execution: "in-process",
  durable: false,
  note: TIMER_NOTE,
  unsupported: {
    dispatch:
      "no on-demand trigger — toad-scheduler only runs jobs on its own schedule",
    cycle:
      "no on-demand trigger — toad-scheduler only runs jobs on its own schedule",
  },
  async setup(ctx: RunnerSetupContext): Promise<RunnerHandle> {
    const { ToadScheduler, CronJob, Task } = await import("toad-scheduler");
    const scheduler = new ToadScheduler();
    let onFire: ((at: number) => void) | undefined;

    return {
      async trigger() {
        throw new Error("toad-scheduler has no on-demand trigger");
      },

      async schedule(fire) {
        onFire = fire;
        const task = new Task(ctx.name, () => {
          ctx.onStart(performance.now());
          onFire?.(Date.now());
        });
        scheduler.addCronJob(
          new CronJob({ cronExpression: "* * * * * *" }, task, {
            id: ctx.name,
          }),
        );
      },

      async unschedule() {
        onFire = undefined;
        scheduler.stop();
      },

      async close() {
        scheduler.stop();
      },
    };
  },
};
