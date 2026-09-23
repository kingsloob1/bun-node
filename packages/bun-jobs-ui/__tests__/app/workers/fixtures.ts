import type { WorkerDto } from "../../../app/api/types";

/**
 * Worker fixtures for the Workers screen and the queue panel: a record
 * carrying every field the new contract added, so a test opts out of one
 * rather than building it up.
 */

/** A live, controllable worker, reporting now. */
export function workerFixture(overrides: Partial<WorkerDto> = {}): WorkerDto {
  const now = Date.now();
  return {
    id: "api.emails.9f3c1d20",
    key: "api.emails",
    service: "api",
    queue: "emails",
    state: "running",
    paused: false,
    concurrency: 3,
    active: 1,
    startedAt: now - 120_000,
    processStartedAt: now - 180_000,
    heartbeatAt: now - 1_000,
    expiresAt: now + 29_000,
    stale: false,
    version: "2.13.0",
    host: "api-1",
    pid: 100,
    rssBytes: 268_435_456,
    heartbeatRttMs: 12,
    config: {
      effective: {
        concurrency: 3,
        pollInterval: 1_000,
        maxBlock: 5_000,
        lockDuration: 30_000,
        heartbeatInterval: 10_000,
        stalledInterval: 30_000,
        maxStalledCount: 1,
        reportInterval: 10_000,
        drainDelay: 5_000,
      },
      code: {
        concurrency: 2,
        pollInterval: 1_000,
        maxBlock: 5_000,
        lockDuration: 30_000,
        heartbeatInterval: 10_000,
        stalledInterval: 30_000,
        maxStalledCount: 1,
        reportInterval: 10_000,
        drainDelay: 5_000,
      },
      overridden: ["concurrency"],
      seq: 4,
      updatedAt: now - 60_000,
    },
    control: {
      enabled: true,
      mode: "subscribe",
      appliedSeq: 4,
      configSeq: 4,
      pending: false,
      stopPersistence: "process",
      stopPersistenceOverridable: false,
    },
    ...overrides,
  };
}

/** What a control route answers when the worker acknowledged the instruction. */
export function controlResult(
  overrides: Partial<{
    desired: "running" | "paused" | "stopped";
    seq: number;
    applied: boolean;
    persisted: "process" | "key";
    worker: WorkerDto;
  }> = {},
) {
  return { desired: "paused", seq: 5, applied: true, ...overrides };
}

/** What a config write answers: the stored values and the workers carrying the key. */
export function configResult(
  overrides: Partial<{
    queue: string;
    key: string;
    values: Record<string, number>;
    seq: number;
    instances: { id: string; applied: boolean }[];
  }> = {},
) {
  return {
    queue: "emails",
    key: "api.emails",
    values: { concurrency: 5 },
    seq: 5,
    instances: [{ id: "api.emails.9f3c1d20", applied: true }],
    ...overrides,
  };
}
