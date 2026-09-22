import type {
  JobsApiAckMessage,
  JobsApiErrorMessage,
  JobsApiEventMessage,
  JobsApiGapMessage,
  JobsApiHeartbeatMessage,
  JobsApiHelloMessage,
  JobsApiPingMessage,
  JobsApiPongMessage,
  JobsApiSubscribeMessage,
  JobsApiUnsubscribeMessage,
  QueueEventWire,
  RunnerEventWire,
  WorkerEventWire,
} from "../contract/ws";
import type { EventDescriptor } from "../ws/events";
import { encodeJobId } from "../contract/constants";

/**
 * One example per AsyncAPI message: every control frame and every event type.
 *
 * Each table is typed by the contract's own frame and event types, so an
 * example that drifts from the wire shape is a compile error; a test also
 * validates every example against its message's payload schema in the
 * generated document, so the schema side cannot drift either.
 */

/** One entry of an AsyncAPI 3.0 message's `examples` (a Message Example Object). */
export interface AsyncApiMessageExample {
  /** Machine-readable name of the example. */
  name: string;
  /** A one-line summary of what the example shows. */
  summary: string;
  /** The frame itself, exactly as it travels. */
  payload: unknown;
}

/** When every example happens: 2026-09-19T09:00:00Z, epoch ms. */
const AT = 1_789_808_400_000;

/** The server epoch every example belongs to. */
const EPOCH = "5f0c3a52-8e1d-4c6b-9a57-2b8f1d0e6c43";

/** The queue the queue examples happen on. */
const QUEUE = "mail";

/** The job the single-job queue examples are about. */
const JOB_ID = "welcome:ada@example.com";

/** The runner the runner examples happen on. */
const RUNNER = "nightly-report";

/** The run the runner examples are about. */
const RUN_ID = "run-01J8ZQ4K7N3V";

/** The fields every queue event example shares. */
const QUEUE_BASE = { v: 1, kind: "queue", target: QUEUE } as const;

/** The fields every runner event example shares. */
const RUNNER_BASE = { v: 1, kind: "runner", target: RUNNER } as const;

/** An example queue event of each type. */
const QUEUE_EVENT_EXAMPLES: {
  [K in QueueEventWire["type"]]: Extract<QueueEventWire, { type: K }>;
} = {
  added: {
    ...QUEUE_BASE,
    type: "added",
    id: JOB_ID,
    at: AT,
    payload: { id: JOB_ID },
  },
  duplicate: {
    ...QUEUE_BASE,
    type: "duplicate",
    id: JOB_ID,
    at: AT + 5,
    payload: { id: JOB_ID },
  },
  waiting: {
    ...QUEUE_BASE,
    type: "waiting",
    id: JOB_ID,
    at: AT + 10,
    payload: { id: JOB_ID },
  },
  delayed: {
    ...QUEUE_BASE,
    type: "delayed",
    id: "digest:2026-09-19",
    at: AT + 15,
    payload: { id: "digest:2026-09-19", runAt: AT + 3_600_000 },
  },
  active: {
    ...QUEUE_BASE,
    type: "active",
    id: JOB_ID,
    at: AT + 20,
    payload: { id: JOB_ID },
  },
  progress: {
    ...QUEUE_BASE,
    type: "progress",
    id: JOB_ID,
    at: AT + 120,
    payload: { id: JOB_ID, progress: { sent: 3, total: 4 } },
  },
  completed: {
    ...QUEUE_BASE,
    type: "completed",
    id: JOB_ID,
    at: AT + 240,
    payload: {
      id: JOB_ID,
      returnValue: { messageId: "<0192f1c4@mail.example.com>" },
    },
  },
  failed: {
    ...QUEUE_BASE,
    type: "failed",
    id: JOB_ID,
    at: AT + 240,
    payload: {
      id: JOB_ID,
      error: {
        name: "Error",
        message: "connect ECONNREFUSED 10.0.0.25:587",
        code: "ECONNREFUSED",
      },
    },
  },
  retrying: {
    ...QUEUE_BASE,
    type: "retrying",
    id: JOB_ID,
    at: AT + 240,
    payload: {
      id: JOB_ID,
      error: {
        name: "Error",
        message: "connect ECONNREFUSED 10.0.0.25:587",
        code: "ECONNREFUSED",
      },
      runAt: AT + 2_240,
    },
  },
  dead: {
    ...QUEUE_BASE,
    type: "dead",
    id: JOB_ID,
    at: AT + 30_240,
    payload: {
      id: JOB_ID,
      error: {
        name: "SmtpError",
        message: "550 5.1.1 mailbox unavailable",
        code: 550,
        data: { recipient: "ada@example.com" },
      },
    },
  },
  stalled: {
    ...QUEUE_BASE,
    type: "stalled",
    at: AT + 60_000,
    payload: { ids: [JOB_ID, "welcome:grace@example.com"] },
  },
  removed: {
    ...QUEUE_BASE,
    type: "removed",
    id: JOB_ID,
    at: AT + 300,
    payload: { id: JOB_ID },
  },
  promoted: {
    ...QUEUE_BASE,
    type: "promoted",
    id: "digest:2026-09-19",
    at: AT + 400,
    payload: { id: "digest:2026-09-19" },
  },
  paused: { ...QUEUE_BASE, type: "paused", at: AT + 500, payload: {} },
  resumed: { ...QUEUE_BASE, type: "resumed", at: AT + 900, payload: {} },
  drained: {
    ...QUEUE_BASE,
    type: "drained",
    at: AT + 1_000,
    payload: { count: 12 },
  },
  cleaned: {
    ...QUEUE_BASE,
    type: "cleaned",
    at: AT + 1_100,
    payload: {
      ids: ["welcome:alan@example.com", "welcome:edsger@example.com"],
      state: "completed",
    },
  },
  retried: {
    ...QUEUE_BASE,
    type: "retried",
    at: AT + 1_200,
    payload: { ids: [JOB_ID, "welcome:grace@example.com"] },
  },
  debounced: {
    ...QUEUE_BASE,
    type: "debounced",
    id: "digest:2026-09-19",
    at: AT + 1_300,
    payload: { id: "digest:2026-09-19" },
  },
  throttled: {
    ...QUEUE_BASE,
    type: "throttled",
    id: "reminder:ada@example.com",
    at: AT + 1_400,
    payload: { id: "reminder:ada@example.com" },
  },
  repeatScheduled: {
    ...QUEUE_BASE,
    type: "repeatScheduled",
    at: AT + 1_500,
    payload: { key: "digest", nextRunAt: AT + 86_400_000 },
  },
};

/** An example runner event of each type. */
const RUNNER_EVENT_EXAMPLES: {
  [K in RunnerEventWire["type"]]: Extract<RunnerEventWire, { type: K }>;
} = {
  control: {
    ...RUNNER_BASE,
    type: "control",
    at: AT,
    payload: { action: "trigger" },
  },
  started: {
    ...RUNNER_BASE,
    type: "started",
    id: RUN_ID,
    at: AT + 10,
    payload: { runId: RUN_ID },
  },
  succeeded: {
    ...RUNNER_BASE,
    type: "succeeded",
    id: RUN_ID,
    at: AT + 42_010,
    payload: { runId: RUN_ID, durationMs: 42_000 },
  },
  failed: {
    ...RUNNER_BASE,
    type: "failed",
    id: RUN_ID,
    at: AT + 5_010,
    payload: {
      runId: RUN_ID,
      error: {
        name: "TypeError",
        message: "Cannot read properties of undefined (reading 'rows')",
      },
    },
  },
  queued: {
    ...RUNNER_BASE,
    type: "queued",
    id: "run-01J8ZQ5B2D9X",
    at: AT + 20,
    payload: { runId: "run-01J8ZQ5B2D9X" },
  },
  skipped: {
    ...RUNNER_BASE,
    type: "skipped",
    at: AT + 30,
    payload: { reason: "lock-held" },
  },
  timeout: {
    ...RUNNER_BASE,
    type: "timeout",
    id: RUN_ID,
    at: AT + 300_010,
    payload: { runId: RUN_ID },
  },
  killed: {
    ...RUNNER_BASE,
    type: "killed",
    id: RUN_ID,
    at: AT + 60_010,
    payload: { runId: RUN_ID, reason: "killed" },
  },
  logs: {
    ...RUNNER_BASE,
    type: "logs",
    id: RUN_ID,
    at: AT + 750,
    payload: { runId: RUN_ID, lastSeq: 42 },
  },
};

/** The worker the worker examples are about. */
const WORKER_ID = "billing.mail.7f3a1c";

/** That worker's stable key: the one every replica of it carries. */
const WORKER_KEY = "billing.mail";

/** The fields every worker event example shares: the target is the queue. */
const WORKER_BASE = { v: 1, kind: "worker", target: QUEUE } as const;

/**
 * An example worker event of each type. The target is the queue, never the
 * worker — worker events are grouped per queue — and `id`, where the event is
 * about one worker, is its incarnation id.
 */
const WORKER_EVENT_EXAMPLES: {
  [K in WorkerEventWire["type"]]: Extract<WorkerEventWire, { type: K }>;
} = {
  control: {
    ...WORKER_BASE,
    type: "control",
    at: AT,
    payload: { worker: WORKER_ID, action: "pause", seq: 4 },
  },
  state: {
    ...WORKER_BASE,
    type: "state",
    id: WORKER_ID,
    at: AT + 30,
    payload: {
      worker: WORKER_ID,
      key: WORKER_KEY,
      state: "paused",
      previous: "running",
      reason: "control",
      at: AT + 30,
    },
  },
  config: {
    ...WORKER_BASE,
    type: "config",
    id: WORKER_ID,
    at: AT + 60,
    payload: {
      worker: WORKER_ID,
      key: WORKER_KEY,
      seq: 9,
      overridden: ["concurrency", "pollInterval"],
    },
  },
};

/** The job channel of the single-job examples, as a client names it. */
const JOB_CHANNEL = `queue/${QUEUE}/job/${encodeJobId(JOB_ID)}`;

/** The control frames' examples, by message id. */
const CONTROL_EXAMPLES: {
  /** A subscribe that resumes after a reconnect. */
  subscribe: JobsApiSubscribeMessage;
  /** An unsubscribe. */
  unsubscribe: JobsApiUnsubscribeMessage;
  /** A ping. */
  ping: JobsApiPingMessage;
  /** The greeting. */
  hello: JobsApiHelloMessage;
  /** An ack with one refused channel. */
  ack: JobsApiAckMessage;
  /** A gap after an expired resume. */
  gap: JobsApiGapMessage;
  /** A heartbeat. */
  heartbeat: JobsApiHeartbeatMessage;
  /** A pong. */
  pong: JobsApiPongMessage;
  /** A refused subscribe. */
  error: JobsApiErrorMessage;
} = {
  subscribe: {
    op: "subscribe",
    id: "sub-1",
    channels: [`queue/${QUEUE}`, JOB_CHANNEL, `runner/${RUNNER}`],
    events: ["added", "progress", "completed", "failed", "succeeded"],
    resume: { epoch: EPOCH, afterSeq: 41 },
  },
  unsubscribe: { op: "unsubscribe", id: "unsub-1", channels: [JOB_CHANNEL] },
  ping: { op: "ping", id: "ping-7" },
  hello: {
    type: "hello",
    protocol: 1,
    sessionId: "0b7e6d1a-3f24-4c9e-8d2b-6a1f5e9c7b30",
    epoch: EPOCH,
    seq: 42,
    mode: "both",
    heartbeatMs: 30_000,
    maxSubscriptions: 50,
    events: "push",
  },
  ack: {
    type: "ack",
    id: "sub-1",
    op: "subscribe",
    channels: [`queue/${QUEUE}`, JOB_CHANNEL],
    rejected: [
      {
        channel: `runner/${RUNNER}`,
        code: "FORBIDDEN",
        status: 403,
        detail: "events.subscribe was refused for this runner.",
      },
    ],
    resumed: true,
    seq: 44,
  },
  gap: {
    type: "gap",
    epoch: EPOCH,
    fromSeq: 42,
    toSeq: 57,
    reason: "resume-expired",
    channels: [`queue/${QUEUE}`],
  },
  heartbeat: { type: "heartbeat", seq: 57, at: AT + 30_000 },
  pong: { type: "pong", id: "ping-7", at: AT + 31_250 },
  error: {
    type: "error",
    id: "sub-2",
    code: "VALIDATION",
    status: 400,
    detail: "channels must contain at least 1 item.",
  },
};

/** The control message ids that have examples. */
export type ControlMessageId = keyof typeof CONTROL_EXAMPLES;

/** What each control example shows. */
const CONTROL_EXAMPLE_SUMMARIES: Record<ControlMessageId, string> = {
  subscribe:
    "Subscribe to a queue, one of its jobs and a runner, resuming after a reconnect.",
  unsubscribe: "Leave a job's channel.",
  ping: "Ask for a pong.",
  hello: "The greeting a connection opens with.",
  ack: "A subscribe answered with one channel refused.",
  gap: "Events a resume could no longer replay.",
  heartbeat: "Liveness, with the latest global seq.",
  pong: "The answer to a ping.",
  error: "A frame that failed validation.",
};

/** The example of a control message, as the document's `examples`. */
export function controlMessageExamples(
  id: ControlMessageId,
): AsyncApiMessageExample[] {
  const payload: unknown = CONTROL_EXAMPLES[id];
  return [
    {
      name: id,
      summary: CONTROL_EXAMPLE_SUMMARIES[id],
      payload: structuredClone(payload),
    },
  ];
}

/** Whether a string names a control message that has examples. */
export function isControlMessageId(id: string): id is ControlMessageId {
  return Object.hasOwn(CONTROL_EXAMPLES, id);
}

/**
 * The example of one event type's message: an `event` frame on its queue's
 * or runner's channel, numbered after the hello's `seq`.
 */
export function eventMessageExamples(
  descriptor: EventDescriptor,
): AsyncApiMessageExample[] {
  const table: Record<
    string,
    QueueEventWire | RunnerEventWire | WorkerEventWire
  > =
    descriptor.kind === "queue"
      ? QUEUE_EVENT_EXAMPLES
      : descriptor.kind === "runner"
        ? RUNNER_EVENT_EXAMPLES
        : WORKER_EVENT_EXAMPLES;
  const event = table[descriptor.type];
  if (event === undefined) {
    return [];
  }
  const frame: JobsApiEventMessage = {
    type: "event",
    seq: 43,
    epoch: EPOCH,
    subscriptions: [
      descriptor.kind === "queue"
        ? `queue/${QUEUE}`
        : descriptor.kind === "runner"
          ? `runner/${RUNNER}`
          : `queue/${QUEUE}/workers`,
    ],
    event: structuredClone(event),
  };
  return [
    {
      name: descriptor.messageName,
      summary: descriptor.summary,
      payload: frame,
    },
  ];
}
