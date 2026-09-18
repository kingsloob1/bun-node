import type {
  MetaDto,
  Overview,
  Permissions,
  ProblemDto,
  QueueList,
  QueueThroughput,
  WorkerList,
} from "../../app/api/types";
import type { UiConfig } from "../../shared/config.ts";
import { JOBS_API_ACTIONS } from "../../app/api/contract";

/**
 * Response fixtures, recorded from a real `createJobsApi` over the memory
 * driver (namespace `shop`, one queue) and typed against the package's
 * contract types, so a shape change fails the typecheck.
 */

/** A resolved UI config, as `jobsUi()` would inject it. */
export function uiConfig(overrides: Partial<UiConfig> = {}): UiConfig {
  return {
    version: 1,
    title: "Shop jobs",
    basePath: "/jobs",
    assetsPath: "/jobs/assets",
    apiBase: "/jobs-api",
    csrfHeader: null,
    websocket: { path: "/jobs-api/ws", port: null },
    docs: {
      openapi: "/jobs-api/openapi.json",
      asyncapi: "/jobs-api/asyncapi.json",
    },
    sections: { manage: true, docs: true },
    theme: "system",
    ...overrides,
  };
}

/** `GET /meta` from the memory driver in mode `both`. */
export function metaFixture(overrides: Partial<MetaDto> = {}): MetaDto {
  return {
    namespace: "shop",
    mode: "both",
    readOnly: false,
    protocol: 1,
    driver: {
      name: "memory",
      capabilities: {
        blockingWait: true,
        events: "local",
        multiProcess: false,
        multiHost: false,
      },
    },
    features: {
      logs: true,
      update: true,
      limits: true,
      flows: true,
      search: true,
      workers: true,
      throughput: true,
    },
    events: "local",
    publishing: null,
    websocket: {
      path: "/jobs-api/ws",
      heartbeatMs: 25000,
      maxSubscriptions: 50,
    },
    docs: {
      openapi: "/jobs-api/openapi.json",
      asyncapi: "/jobs-api/asyncapi.json",
    },
    csrf: { header: null, requireJson: true },
    limits: {
      defaultPageSize: 20,
      maxPageSize: 100,
      maxBulkIds: 1000,
      maxRetryAll: 10000,
      maxRetryAllIds: 1000,
      maxClean: 10000,
      defaultClean: 1000,
      maxLogPage: 500,
      maxHistory: 200,
      maxJobDataBytes: 1048576,
      maxQueues: 500,
    },
    addableNames: [],
    runnerTriggerArgs: false,
    ...overrides,
  };
}

/** `GET /meta/permissions` with every action granted (opt-ins `jobs.add`/`jobs.update` absent, as by default). */
export function permissionsFixture(
  overrides: Permissions["actions"] = {},
): Permissions {
  const actions: Permissions["actions"] = {};
  for (const action of JOBS_API_ACTIONS) {
    if (action !== "jobs.add" && action !== "jobs.update") {
      actions[action] = true;
    }
  }
  return { actions: { ...actions, ...overrides } };
}

/** `GET /overview`. */
export function overviewFixture(overrides: Partial<Overview> = {}): Overview {
  return {
    queues: 2,
    pausedQueues: 1,
    counts: {
      waiting: 1204,
      delayed: 3,
      active: 7,
      completed: 98231,
      failed: 12,
      dead: 2,
      "waiting-children": 0,
    },
    total: 99459,
    truncated: false,
    workers: 4,
    throughput: { minutes: 60, completed: 5120, failed: 9 },
    ...overrides,
  };
}

/** `GET /queues`. */
export function queueListFixture(
  overrides: Partial<QueueList> = {},
): QueueList {
  return {
    items: [
      {
        name: "emails",
        counts: {
          waiting: 1200,
          delayed: 3,
          active: 5,
          completed: 90000,
          failed: 10,
          dead: 2,
          "waiting-children": 0,
        },
        total: 91220,
        paused: false,
      },
      {
        name: "reports",
        counts: {
          waiting: 4,
          delayed: 0,
          active: 2,
          completed: 8231,
          failed: 2,
          dead: 0,
          "waiting-children": 0,
        },
        total: 8239,
        paused: true,
      },
    ],
    truncated: false,
    page: { offset: 0, limit: 500, total: 2, hasMore: false },
    ...overrides,
  };
}

/** `GET /queues/:queue/throughput?minutes=3`. */
export function throughputFixture(
  overrides: Partial<QueueThroughput> = {},
): QueueThroughput {
  return {
    interval: 60000,
    from: 1789730400000,
    to: 1789730520000,
    buckets: [
      { at: 1789730400000, completed: 10, failed: 0 },
      { at: 1789730460000, completed: 25, failed: 1 },
      { at: 1789730520000, completed: 7, failed: 0 },
    ],
    completed: 42,
    failed: 1,
    ...overrides,
  };
}

/** `GET /workers`. */
export const workersFixture: WorkerList = { items: [] };

/** A problem body, as the API sends it. */
export function problem(
  status: number,
  code: string,
  title: string,
  extra: Partial<ProblemDto> = {},
): ProblemDto {
  return {
    type: `urn:bun-jobs:error:${code}`,
    title,
    status,
    code,
    ...extra,
  };
}
