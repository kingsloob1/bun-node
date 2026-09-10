import type { QueueContender } from "../../lib/types";
import { bunJobsContenders } from "./bun-jobs";
import {
  agendaMongo,
  agendaPostgres,
  graphileWorker,
  pgBoss,
} from "./postgres-group";
import { agendaRedis, beeQueue, bullmq, nodeResque } from "./redis-group";

/**
 * Every queue contender, in the order they should appear within a backend
 * group: ours first, then the alternatives.
 */

/**
 * Builds the registry.
 *
 * The poll interval is a single shared knob rather than each library's own
 * default, because those defaults differ by two orders of magnitude
 * (graphile-worker 2s, node-resque 5s, bun-jobs 1s) and a comparison of
 * defaults would be a comparison of documentation, not of code. Libraries that
 * wait on the backend instead of polling ignore it, and their rows say so.
 */
export function queueContenders(pollIntervalMs: number): QueueContender[] {
  return [
    ...bunJobsContenders,
    bullmq,
    beeQueue,
    nodeResque(pollIntervalMs),
    agendaRedis(pollIntervalMs),
    pgBoss(pollIntervalMs),
    graphileWorker(pollIntervalMs),
    agendaPostgres(pollIntervalMs),
    agendaMongo(pollIntervalMs),
  ];
}

/** The id of every contender, for `--help` and validation. */
export function queueContenderIds(): string[] {
  return queueContenders(50).map((contender) => contender.id);
}
