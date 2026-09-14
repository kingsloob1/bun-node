import type { RunnerContender } from "../../lib/types";
import { bunRunnerContenders } from "./bun-jobs";
import {
  agendaRunner,
  bree,
  croner,
  nodeCron,
  nodeSchedule,
  toadScheduler,
} from "./others";

/**
 * Every runner contender, ours first.
 *
 * The list mixes two kinds deliberately, and the report labels which is which:
 * runners that own a run and survive a restart, and cron timers that call a
 * function in the current process. Comparing them is the point — the timers
 * show what the guarantees cost.
 */
export function runnerContenders(): RunnerContender[] {
  return [
    ...bunRunnerContenders,
    bree,
    agendaRunner("mongodb"),
    agendaRunner("redis"),
    croner,
    nodeCron,
    nodeSchedule,
    toadScheduler,
  ];
}
