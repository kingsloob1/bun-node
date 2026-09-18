import type {
  ChildrenDto,
  DefinitionListDto,
  ErrorDto,
  JobDto,
  JobState,
  LogPageDto,
  MetaDto,
  Permissions,
} from "../../../app/api/types";
import { metaFixture, permissionsFixture } from "../fixtures";

/**
 * Fixtures of the job screen and the add-job dialog, typed against the
 * contract so a shape change fails the typecheck.
 */

/** The queue the fixtures live in. */
export const QUEUE = "emails";

/** A job id holding a `/` and a space, which must travel as ONE percent-encoded path segment. */
export const AWKWARD_ID = "welcome/42 a";

/** {@link AWKWARD_ID} as it appears in a request path. */
export const AWKWARD_ID_ENCODED = "welcome%2F42%20a";

/** A fixed "now" the timestamps sit around, epoch ms. */
export const NOW = 1_789_730_400_000;

/** The API path of a fixture job, percent-encoded as the client must send it. */
export function jobApiPath(id: string = AWKWARD_ID, queue: string = QUEUE) {
  return `/queues/${encodeURIComponent(queue)}/jobs/${encodeURIComponent(id)}`;
}

/** A failure with a two-level cause chain. */
export const failureFixture: ErrorDto = {
  name: "SmtpError",
  message: "connection refused",
  code: "ECONNREFUSED",
  data: { host: "smtp.example.com" },
  cause: {
    name: "SocketError",
    message: "socket hang up",
    cause: { name: "Error", message: "ETIMEDOUT" },
  },
};

/** Per-state overrides that make a job look like one really in that state. */
const STATE_SHAPES: Readonly<Record<JobState, Partial<JobDto>>> = {
  waiting: {},
  delayed: { runAt: NOW + 60_000 },
  active: {
    processedOn: NOW - 1_000,
    attemptsMade: 1,
    workerId: "worker-1",
    lockExpiresAt: NOW + 30_000,
  },
  completed: {
    processedOn: NOW - 2_000,
    finishedOn: NOW - 1_000,
    attemptsMade: 1,
    returnValue: { sent: true, messageId: "m-1" },
    expiresAt: NOW + 86_400_000,
  },
  failed: {
    processedOn: NOW - 2_000,
    finishedOn: NOW - 1_000,
    attemptsMade: 3,
    failedReason: failureFixture,
  },
  dead: {
    processedOn: NOW - 2_000,
    finishedOn: NOW - 1_000,
    attemptsMade: 3,
    failedReason: failureFixture,
  },
  "waiting-children": {},
};

/** `GET /queues/emails/jobs/:id` for a job in `state`. */
export function jobFixture(
  state: JobState = "waiting",
  overrides: Partial<JobDto> = {},
): JobDto {
  return {
    queue: QUEUE,
    id: AWKWARD_ID,
    name: "send-welcome",
    state,
    priority: 5,
    runAt: NOW,
    createdAt: NOW - 5_000,
    processedOn: null,
    finishedOn: null,
    expiresAt: null,
    attemptsMade: 0,
    maxAttempts: 3,
    stalledCount: 0,
    progress: null,
    failedReason: null,
    lockExpiresAt: null,
    workerId: null,
    repeatKey: null,
    flow: null,
    data: { to: "ada@example.com", template: "welcome" },
    returnValue: null,
    opts: {
      priority: 5,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      timeout: 30_000,
      removeOnComplete: false,
      removeOnFail: false,
      keepStacktraces: 10,
    },
    ...STATE_SHAPES[state],
    ...overrides,
  };
}

/** `GET …/logs` answering a window over `total` numbered lines. */
export function logPage(
  offset: number,
  limit: number,
  order: "asc" | "desc",
  total: number,
): LogPageDto {
  const items: string[] = [];
  for (let index = 0; index < limit; index++) {
    const position = offset + index;
    if (position >= total) {
      break;
    }
    const line = order === "asc" ? position + 1 : total - position;
    items.push(`line ${line}`);
  }
  return {
    items,
    page: { offset, limit, total, hasMore: offset + items.length < total },
  };
}

/** A flow parent's `GET …/children`: one completed child, one unreachable, one with an ignored failure. */
export function childrenFixture(
  overrides: Partial<ChildrenDto> = {},
): ChildrenDto {
  return {
    parent: null,
    pending: 1,
    children: [
      {
        queue: "images",
        id: "resize-1",
        job: {
          ...jobFixture("completed"),
          queue: "images",
          id: "resize-1",
          name: "resize",
        },
        value: { width: 640 },
      },
      { queue: "archive", id: "gone-7", job: null },
      {
        queue: "images",
        id: "resize-2",
        job: {
          ...jobFixture("failed"),
          queue: "images",
          id: "resize-2",
          name: "resize",
        },
        failure: { name: "ResizeError", message: "bad format" },
      },
    ],
    truncated: false,
    ...overrides,
  };
}

/** `GET /definitions`. */
export const definitionsFixture: DefinitionListDto = {
  items: [
    { name: "send-welcome", options: { attempts: 3 } },
    { name: "send-digest", options: {} },
  ],
};

/** `/meta` for the job screen: every feature, and `jobs.add` accepting any name. */
export function jobMeta(overrides: Partial<MetaDto> = {}): MetaDto {
  return metaFixture({ addableNames: null, ...overrides });
}

/** `/meta/permissions` with every action, the opt-ins `jobs.add` and `jobs.update` included. */
export function allPermissions(
  overrides: Permissions["actions"] = {},
): Permissions {
  return permissionsFixture({
    "jobs.add": true,
    "jobs.update": true,
    ...overrides,
  });
}
