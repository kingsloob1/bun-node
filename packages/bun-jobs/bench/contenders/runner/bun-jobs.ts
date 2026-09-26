import type { DriverConfig } from "../../../lib/index";
import type {
  Backend,
  RunnerContender,
  RunnerHandle,
  RunnerSetupContext,
} from "../../lib/types";
import { BunRunner, createDriver } from "../../../lib/index";
import { deferred } from "../../lib/harness";

/**
 * `BunRunner` — the file runner this repository ships, in each of the three
 * ways it can execute a handler.
 *
 * The three differ only in `executionMode`, so the gap between them is the
 * price of isolation: a fresh process, a worker thread, or the caller's own.
 * The `single` entry adds a cluster-wide lock on top, which is what nothing
 * else in the comparison offers.
 */

/** Builds the driver config for one backend. */
function driverConfig(backend: Backend, url: string): DriverConfig {
  switch (backend) {
    case "memory":
      return { type: "memory" };
    case "file":
      return { type: "file", root: url };
    case "sqlite":
      return { type: "sql", url, adapter: "sqlite" };
    case "postgres":
      return { type: "sql", url, adapter: "postgres" };
    case "mysql":
      return { type: "sql", url, adapter: "mysql" };
    case "mariadb":
      return { type: "sql", url, adapter: "mariadb" };
    case "redis":
      return { type: "redis", url };
    case "mongodb":
      return { type: "mongodb", url };
  }
}

/** Builds one entry. */
function contender(options: {
  /** Command-line id. */
  id: string;
  /** Report label. */
  label: string;
  /** How the handler is executed. */
  execution: "in-process" | "worker-thread" | "child-process";
  /** Whether the trigger takes a cluster-wide lock first. */
  single: boolean;
  /** Backend the runner's state and lock live in. */
  backend: Backend;
  /** Footnote. */
  note?: string;
}): RunnerContender {
  return {
    id: options.id,
    label: options.label,
    backend: options.backend,
    ours: true,
    execution: options.execution,
    durable: options.single,
    note: options.note,
    async setup(ctx: RunnerSetupContext): Promise<RunnerHandle> {
      const driver = createDriver(driverConfig(options.backend, ctx.url));

      const runner = new BunRunner({
        id: ctx.name,
        namespace: "bench",
        file: ctx.file,
        driver,
        executionMode: options.execution,
        runMode: options.single ? "single" : "parallel",
        // A schedule is armed per scenario, not at construction, so the
        // dispatch and cycle figures are never disturbed by a tick.
        autostart: false,
        waitToExit: false,
        // In parallel mode a second trigger must not be refused while the
        // first is still settling, or the cycle loop would measure a skip.
        maxConcurrency: options.single ? 1 : 64,
      });

      // The handler's first act is to send this, which is the earliest moment
      // the parent can prove user code is running.
      runner.on("message", () => ctx.onStart(performance.now()));
      runner.on("error", ctx.onError);
      runner.on("failed", (_run, error) => ctx.onError(error));

      await runner.start();

      /**
       * Watches for the current run to reach a terminal state, either way.
       *
       * Declared as functions rather than arrows so each can detach the other:
       * a run settles once, and leaving the losing listener attached would
       * make the next run resolve early. `cancel` exists for the same reason —
       * a trigger that never became a run must take its listeners back.
       */
      const settled = (): { promise: Promise<void>; cancel: () => void } => {
        const gate = deferred<void>();

        function detach(): void {
          runner.off("finished", onFinished);
          runner.off("failed", onFailed);
        }

        function onFinished(): void {
          detach();
          ctx.onFinish(performance.now());
          gate.resolve();
        }

        function onFailed(_run: unknown, error: Error): void {
          detach();
          ctx.onError(error);
          gate.resolve();
        }

        runner.on("finished", onFinished);
        runner.on("failed", onFailed);
        return { promise: gate.promise, cancel: detach };
      };

      /** Skip reasons that mean "the previous run has not fully let go yet". */
      const transient = new Set(["lock-held", "busy", "max-concurrency"]);

      return {
        /**
         * Runs once, and waits for that run to finish.
         *
         * In `single` mode the cluster-wide lock is released *after* the
         * `finished` event, so a trigger issued the instant the previous run
         * reports done is legitimately refused. Retrying is what a caller
         * would do, and the wait lands in the throughput figure rather than in
         * the latency sample — which is correct either way: an exclusive run
         * genuinely cannot start until the last one has let go.
         */
        async trigger() {
          for (let attempt = 0; attempt < 1000; attempt++) {
            const done = settled();
            const outcome = await runner.trigger();

            if (outcome.outcome === "started") {
              await done.promise;
              return;
            }

            done.cancel();

            if (
              outcome.outcome === "skipped" &&
              transient.has(outcome.reason)
            ) {
              await Bun.sleep(1);
              continue;
            }

            throw new Error(
              `trigger was ${outcome.outcome}${
                outcome.outcome === "skipped" ? `: ${outcome.reason}` : ""
              }`,
            );
          }

          throw new Error("the runner never accepted a trigger");
        },

        async schedule(onFire) {
          runner.on("started", () => onFire(Date.now()));
          await runner.updateSchedule({ cron: "* * * * * *" });
        },

        async unschedule() {
          await runner.updateSchedule(null);
        },

        async close() {
          await runner.stop({ force: true, timeout: 3000 }).catch(() => {});
          await driver.close().catch(() => {});
        },
      };
    },
  };
}

/** Every `BunRunner` configuration under test. */
export const bunRunnerContenders: RunnerContender[] = [
  contender({
    id: "bun-runner-in-process",
    label: "BunRunner (in-process)",
    execution: "in-process",
    single: false,
    backend: "memory",
    note: "runs the handler in the caller's process — no isolation, the floor for this library",
  }),
  contender({
    id: "bun-runner-worker",
    label: "BunRunner (worker-thread)",
    execution: "worker-thread",
    single: false,
    backend: "memory",
    note: "a fresh Worker per run — the same isolation model as Bree",
  }),
  contender({
    id: "bun-runner-spawn",
    label: "BunRunner (child-process)",
    execution: "child-process",
    single: false,
    backend: "memory",
    note: "a fresh process per run, the default: full isolation, and the most expensive",
  }),
  contender({
    id: "bun-runner-single-redis",
    label: "BunRunner (single, child-process, redis)",
    execution: "child-process",
    single: true,
    backend: "redis",
    note:
      "a cluster-wide lock before every run *and* a fresh process to run it — " +
      "both guarantees at once, and the most either costs",
  }),
  contender({
    id: "bun-runner-single-inproc-redis",
    label: "BunRunner (single, in-process, redis)",
    execution: "in-process",
    single: true,
    backend: "redis",
    note:
      "the same cluster-wide lock, handler in the caller's process — the " +
      "like-for-like comparison with Agenda, and the price of exclusivity alone",
  }),
  contender({
    id: "bun-runner-single-postgres",
    label: "BunRunner (single, child-process, postgres)",
    execution: "child-process",
    single: true,
    backend: "postgres",
    note: "the same two guarantees, exclusivity held in Postgres rather than Redis",
  }),
];
