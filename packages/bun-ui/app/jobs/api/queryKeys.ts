import type { PermissionsTarget } from "./client";

/**
 * TanStack Query keys. They mirror the routes, so a mutation can invalidate
 * the narrowest prefix: everything about one queue is under
 * `["queue", name]`, every list of queues under `["queues"]`.
 */
export const queryKeys = {
  /** Everything read from `/meta*`. */
  metaAll: ["meta"] as const,
  /** `GET /meta`. */
  meta: () => ["meta", "info"] as const,
  /** `GET /meta/permissions`, per target. */
  permissions: (target: PermissionsTarget = {}) =>
    [
      "meta",
      "permissions",
      { queue: target.queue ?? null, runner: target.runner ?? null },
    ] as const,
  /** Every `GET /overview` read, whatever window it covers: what an invalidation targets. */
  overviewAll: ["overview"] as const,
  /** `GET /overview`. */
  overview: (minutes?: number) =>
    ["overview", { minutes: minutes ?? null }] as const,
  /** Every `GET /queues` list. */
  queuesAll: ["queues"] as const,
  /** `GET /queues?search=`. */
  queues: (search?: string) => ["queues", { search: search || null }] as const,
  /** Everything about one queue. */
  queue: (queue: string) => ["queue", queue] as const,
  /** `GET /queues/:queue/throughput`. */
  queueThroughput: (queue: string, minutes?: number) =>
    ["queue", queue, "throughput", { minutes: minutes ?? null }] as const,
  /** `GET /workers`. */
  workers: () => ["workers"] as const,
};
