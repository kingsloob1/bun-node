import type { WorkerConfigKey } from "../../../api/contract";

/** What each setting is, in one line: under its input in the Settings dialog, and as the title of its row on the worker page. */
export const SETTING_HINT: Readonly<Record<WorkerConfigKey, string>> = {
  concurrency: "How many jobs this worker runs at once.",
  pollInterval: "How often it looks for work when nothing woke it, in ms.",
  maxBlock: "How long one wait for work may block, in ms.",
  lockDuration:
    "How long a job's lock lasts before another worker may claim it, in ms.",
  heartbeatInterval:
    "How often a held lock is renewed, in ms. Must be at most half the lock duration.",
  stalledInterval: "How often stalled jobs are looked for, in ms.",
  maxStalledCount: "How often one job may stall before it is failed.",
  reportInterval:
    "How often this worker reports itself to the registry, in ms.",
  drainDelay: "How long it waits before declaring the queue drained, in ms.",
};
