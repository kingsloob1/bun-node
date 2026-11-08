import type {
  JobCountsDto,
  JobDefaultsDto,
  JobDto,
  JobPageDto,
  QueueDetailDto,
  QueueListDto,
  RepeatableListDto,
  SummonStatusDto,
  WorkerListDto,
} from "../../../app/api/types";
import type { MockHandler, MockReply } from "../mockFetch";
import type { RenderAppOptions } from "../renderApp";
import { visit } from "../dom";
import { metaFixture, permissionsFixture } from "../fixtures";
import { renderApp } from "../renderApp";

/**
 * Fixtures of the queue screens, typed against the contract, and a helper
 * that lands the app on a queue URL with every route it reads answered.
 */

/** A fixed "now" the timestamps are relative to. */
export const NOW = 1_789_730_520_000;

/** Counts of the `emails` queue. */
export function countsFixture(
  overrides: Partial<JobCountsDto> = {},
): JobCountsDto {
  return {
    waiting: 3,
    delayed: 1,
    active: 0,
    completed: 10,
    failed: 2,
    dead: 1,
    "waiting-children": 0,
    ...overrides,
  };
}

/** `GET /queues/emails`. */
export function detailFixture(
  overrides: Partial<QueueDetailDto> = {},
): QueueDetailDto {
  const counts = countsFixture();
  return {
    name: "emails",
    counts,
    total: 17,
    paused: false,
    limits: { rate: { max: 10, duration: 60_000 }, concurrency: 4 },
    ...overrides,
  };
}

/** One job, failed by default. */
export function jobFixture(overrides: Partial<JobDto> = {}): JobDto {
  return {
    queue: "emails",
    id: "job-1",
    // Who ran the last attempt: none recorded, as on a backend without attribution.
    processedBy: null,
    name: "send",
    state: "failed",
    priority: 0,
    runAt: NOW - 60_000,
    createdAt: NOW - 120_000,
    processedOn: NOW - 90_000,
    finishedOn: NOW - 80_000,
    expiresAt: null,
    attemptsMade: 3,
    maxAttempts: 3,
    stalledCount: 0,
    progress: null,
    failedReason: { name: "Error", message: "SMTP refused the connection" },
    lockExpiresAt: null,
    workerId: null,
    repeatKey: null,
    flow: null,
    ...overrides,
  };
}

/** A page of three jobs; one id needs percent-encoding. */
export function jobPageFixture(
  overrides: Partial<JobPageDto> = {},
): JobPageDto {
  return {
    items: [
      jobFixture(),
      jobFixture({ id: "job-2", name: "digest" }),
      jobFixture({
        id: "a/b c",
        name: "send",
        state: "delayed",
        failedReason: null,
      }),
    ],
    page: { offset: 0, limit: 20, hasMore: false },
    ...overrides,
  };
}

/** `GET /queues` with `n` queues named `q-00`… */
export function queuePageFixture(
  n: number,
  page: Partial<QueueListDto["page"]> = {},
): QueueListDto {
  const items = Array.from({ length: n }, (_, index) => ({
    name: `q-${String(index).padStart(2, "0")}`,
    counts: countsFixture(),
    total: 17,
    paused: index === 1,
  }));
  const info = { offset: 0, limit: 20, total: n, hasMore: false, ...page };
  return { items, truncated: info.hasMore, page: info };
}

/** `GET /queues/emails/workers`. */
export const workersFixture: WorkerListDto = {
  items: [
    {
      id: "w-1",
      queue: "emails",
      concurrency: 4,
      active: 2,
      paused: false,
      startedAt: NOW - 3_600_000,
      heartbeatAt: NOW - 5_000,
      expiresAt: NOW + 25_000,
      host: "box-1",
      pid: 4242,
      rssBytes: 268_435_456,
      heartbeatRttMs: 12,
    },
  ],
};

/** `GET /queues/emails/repeatables?include=data`. */
export const repeatablesFixture: RepeatableListDto = {
  items: [
    {
      queue: "emails",
      key: "digest:cron",
      name: "digest",
      opts: {
        priority: 0,
        attempts: 1,
        backoff: 0,
        timeout: 0,
        removeOnComplete: true,
        removeOnFail: false,
        keepStacktraces: 5,
      },
      cron: "0 9 * * *",
      tz: "Europe/London",
      count: 4,
      nextRunAt: NOW + 3_600_000,
      nextJobId: "rep-5",
      disabled: false,
      createdAt: NOW - 86_400_000,
      updatedAt: NOW - 3_600_000,
      data: { list: "weekly" },
    },
  ],
};

/** Every route the `emails` queue screen reads. */
export function queueHandlers(): Record<string, MockHandler | MockReply> {
  return {
    "GET /queues/emails": { body: detailFixture() },
    "GET /queues/emails/counts": { body: countsFixture() },
    "GET /queues/emails/jobs": { body: jobPageFixture() },
    "GET /queues/emails/workers": { body: workersFixture },
    "GET /queues/emails/repeatables": { body: repeatablesFixture },
  };
}

/** Options of {@link renderQueue}. */
export interface RenderQueueOptions extends RenderAppOptions {
  /** The app path (under `/jobs`). Defaults to `/queues/emails`. */
  path?: string;
}

/** Renders the app at a queue path with the queue routes mocked (handlers merge over them). */
export function renderQueue(options: RenderQueueOptions = {}) {
  visit(`/jobs${options.path ?? "/queues/emails"}`);
  return renderApp({
    ...options,
    handlers: {
      "GET /meta": { body: metaFixture() },
      "GET /meta/permissions": { body: permissionsFixture() },
      ...queueHandlers(),
      ...options.handlers,
    },
  });
}

/** The toast region for successes/info. */
export function notifications(): HTMLElement {
  return document.querySelector<HTMLElement>('ol[aria-label="Notifications"]')!;
}

/** The toast region for errors. */
export function errorToasts(): HTMLElement {
  return document.querySelector<HTMLElement>('ol[aria-label="Errors"]')!;
}

/**
 * The open dialog (`dialog` or `alertdialog`), found by selector: role
 * queries over the whole page are slow in happy-dom once a table renders.
 */
export function openDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>("dialog[open]");
}

/** Waits for a dialog to open and returns it. */
export async function findDialog(): Promise<HTMLElement> {
  const { waitFor } = await import("../dom");
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = openDialog();
    if (!found) {
      throw new Error("no open dialog");
    }
  });
  return found!;
}

/**
 * `GET /queues/emails/summon`: a local, working controller with one attempt
 * on its way, its times relative to `now` (the calling file's, taken once
 * when it loads, so every status it builds agrees).
 */
export function summonStatusFixture(
  now: number,
  overrides: Partial<SummonStatusDto> = {},
): SummonStatusDto {
  return {
    queue: "emails",
    local: true,
    inert: false,
    summoner: {
      provider: {
        name: "@acme/bun-jobs-ecs",
        version: "1.2.0",
        kind: "ecs",
        displayName: "Amazon ECS",
        apiVersion: { core: "0.1", summon: "0.1" },
      },
      providerId: "@acme/bun-jobs-ecs@1.2.0~1",
      readiness: "ready",
      capabilities: {
        style: "launch",
        dedupe: { kind: "none" },
        passes: "argv",
        bootBudgetMs: 180_000,
        shutdown: { signal: "SIGTERM", graceMs: 10_000 },
        maxLifetimeMs: null,
        enforcesLifetime: false,
      },
      facts: { cluster: "jobs-prod", region: "eu-west-1" },
    },
    pending: [
      {
        id: "s-1",
        at: now - 20_000,
        until: now + 160_000,
        count: 1,
        kind: "ecs",
      },
    ],
    failures: 0,
    budget: {
      hour: 3,
      perHour: 30,
      day: 12,
      perDay: 300,
      hourResetsAt: Date.UTC(2026, 0, 1, 1),
      dayResetsAt: Date.UTC(2026, 0, 2),
    },
    last: { id: "s-1", outcome: "started", at: now - 20_000 },
    ...overrides,
  };
}

/** `GET /queues/emails/job-defaults`: attempts and timeout overridden, attempts LOWERED below the code's. */
export function jobDefaultsFixture(
  overrides: Partial<JobDefaultsDto> = {},
): JobDefaultsDto {
  const code: JobDefaultsDto["code"] = {
    attempts: 5,
    backoff: { type: "exponential", delay: 1_000 },
    timeout: 0,
    priority: 0,
    removeOnComplete: false,
    removeOnFail: { count: 100 },
    keepLogs: 0,
    keepStacktraces: 10,
  };
  return {
    queue: "emails",
    effective: { ...code, attempts: 3, timeout: 30_000 },
    code,
    codeSource: "api",
    overridden: ["attempts", "timeout"],
    override: { attempts: 3, timeout: 30_000 },
    seq: 4,
    updatedAt: NOW - 60_000,
    propagationMs: 1_000,
    pending: {
      waiting: 1_200,
      delayed: 10,
      failed: 5,
      "waiting-children": 0,
      total: 1_215,
    },
    ...overrides,
  };
}
