/* eslint-disable no-console -- a benchmark's output is its product */
import type {
  Measurement,
  RunnerContender,
  RunnerHandle,
  RunnerScenario,
} from "./types";
import { waitFor } from "./harness";
import { rate, summarise } from "./stats";

/**
 * What each runner scenario measures.
 *
 * `dispatch` and `cycle` are about cost: how long from asking for a run until
 * user code is executing, and until it has finished. `drift` is about
 * accuracy. `exclusive` is about a property rather than a speed — three
 * replicas of a service, one cron job: does it run once or three times? — and
 * it is the dimension where the durable entries separate from the timers.
 */

/** Knobs a runner scenario is run with. */
export interface RunnerScenarioConfig {
  /** On-demand runs per measured pass. */
  runs: number;
  /** Scheduled fires to observe in `drift`. */
  fires: number;
  /** Live instances of one job in `exclusive`. */
  instances: number;
  /** Seconds to observe in `exclusive`. */
  observeSeconds: number;
  /** Seconds before a scenario gives up. */
  budgetSeconds: number;
  /** Runner/job name, unique per run. */
  name: string;
  /** Connection string for the contender's backend. */
  url: string;
  /** Absolute path of the handler file. */
  file: string;
}

/** Runs one scenario against one contender. */
export async function runRunnerScenario(
  contender: RunnerContender,
  scenario: RunnerScenario,
  config: RunnerScenarioConfig,
): Promise<Measurement> {
  const identity = {
    contender: contender.id,
    scenario,
    backend: contender.backend,
  };

  const unsupported = contender.unsupported?.[scenario];
  if (unsupported) {
    return { ...identity, count: 0, elapsedMs: 0, skipped: unsupported };
  }

  const errors: unknown[] = [];
  const handles: RunnerHandle[] = [];

  /** The most recent start and finish the contender reported. */
  let startedAt = 0;
  let finishedAt = 0;
  let fires: number[] = [];
  /**
   * Whether a handler start counts towards the exclusivity tally. Only that
   * scenario counts starts; `drift` times the schedule callback instead, and
   * counting both would double every fire.
   */
  let counting = false;

  const build = () =>
    contender.setup({
      name: config.name,
      url: config.url,
      file: config.file,
      onStart: (at) => {
        startedAt = at;
      },
      onFinish: (at) => {
        finishedAt = at;
      },
      onError: (error) => errors.push(error),
    });

  try {
    switch (scenario) {
      case "dispatch":
      case "cycle": {
        const handle = await build();
        handles.push(handle);

        // A first run pays for module resolution and, in spawn mode, for the
        // very first child; neither belongs in a steady-state figure.
        for (let i = 0; i < 3; i++) await handle.trigger();

        const samples: number[] = [];
        const started = performance.now();

        for (let i = 0; i < config.runs; i++) {
          const at = performance.now();
          startedAt = 0;
          finishedAt = 0;
          await handle.trigger();

          if (scenario === "dispatch") {
            if (startedAt === 0) {
              throw new Error("the handler never reported that it had started");
            }
            samples.push(startedAt - at);
          } else {
            samples.push((finishedAt || performance.now()) - at);
          }
        }

        const elapsedMs = performance.now() - started;

        return {
          ...identity,
          latency: summarise(samples),
          opsPerSec: rate(samples.length, elapsedMs),
          count: samples.length,
          elapsedMs,
        };
      }

      case "drift": {
        const handle = await build();
        handles.push(handle);

        if (!handle.schedule) {
          return {
            ...identity,
            count: 0,
            elapsedMs: 0,
            skipped: "no schedule support",
          };
        }

        fires = [];
        const started = performance.now();
        await handle.schedule((at) => fires.push(at));

        await waitFor(() => fires.length >= config.fires + 1, {
          timeoutMs: config.budgetSeconds * 1000,
          message: `only ${fires.length} of ${config.fires} scheduled fires arrived`,
          intervalMs: 25,
        });

        const elapsedMs = performance.now() - started;
        await handle.unschedule?.();

        // The first fire is dropped: arming mid-second makes its distance to
        // the boundary a property of when the benchmark started, not of the
        // scheduler.
        const deltas = fires.slice(1, config.fires + 1).map((at) => {
          const offset = at % 1000;
          return Math.min(offset, 1000 - offset);
        });

        const summary = summarise(deltas);

        return {
          ...identity,
          drift: {
            mean: summary.mean,
            p99: summary.p99,
            max: summary.max,
            fires: deltas.length,
          },
          count: deltas.length,
          elapsedMs,
        };
      }

      case "exclusive": {
        // Every instance carries the same job name, which is the whole point:
        // this is one job and several replicas of the service that owns it.
        const perInstance: number[] = [];

        for (let i = 0; i < config.instances; i++) {
          const index = i;
          perInstance.push(0);

          const handle = await contender.setup({
            name: config.name,
            url: config.url,
            file: config.file,
            onStart: () => {
              if (counting) perInstance[index] = (perInstance[index] ?? 0) + 1;
            },
            onFinish: () => {},
            onError: (error) => errors.push(error),
          });

          handles.push(handle);

          if (!handle.schedule) {
            return {
              ...identity,
              count: 0,
              elapsedMs: 0,
              skipped: "no schedule support",
            };
          }
        }

        // Arm everything first, then let a whole second pass before counting
        // starts. An instance that came up mid-second would otherwise miss the
        // first occurrence and make a correct scheduler look like it had
        // dropped one.
        // Each handle was checked for `schedule` as it was built above.
        for (const handle of handles) await handle.schedule?.(() => {});
        await Bun.sleep(1000 - (Date.now() % 1000) + 1200);

        const windowStart = Date.now();
        counting = true;
        const started = performance.now();

        await Bun.sleep(config.observeSeconds * 1000);

        counting = false;
        const windowEnd = Date.now();
        const elapsedMs = performance.now() - started;
        for (const handle of handles) await handle.unschedule?.();

        const runs = perInstance.reduce((sum, value) => sum + value, 0);

        // Occurrences are the second boundaries the window actually crossed,
        // counted from the clock rather than from the elapsed time, so a
        // window that starts at .999 is not credited with an extra one.
        const occurrences =
          Math.floor(windowEnd / 1000) - Math.floor(windowStart / 1000);

        return {
          ...identity,
          exclusivity: {
            instances: config.instances,
            occurrences,
            runs,
            perOccurrence: occurrences > 0 ? runs / occurrences : 0,
          },
          count: runs,
          elapsedMs,
        };
      }
    }
    // Every member of the union is handled above; this is the compiler's
    // proof, and it fires only if a scenario is added without a branch.
    throw new Error(`unhandled scenario: ${String(scenario)}`);
  } catch (error) {
    return {
      ...identity,
      count: 0,
      elapsedMs: 0,
      failed: error instanceof Error ? error.message : String(error),
    };
  } finally {
    for (const handle of handles) {
      await handle.close().catch(() => {});
    }
    if (errors.length > 0) {
      const first = errors[0];
      console.error(
        `  ! ${contender.id}/${scenario}: ${errors.length} runtime error(s), first: ${
          first instanceof Error ? first.message : String(first)
        }`,
      );
    }
  }
}
