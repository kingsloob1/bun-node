import type { LogEvent } from "@kingsleyweb/bun-common/lib/logging";
import type { SerializedError } from "@kingsleyweb/bun-common/lib/utils/native";
import type { ProcessorContext } from "../../queue/types";
import type { IsolatedJob } from "../executors/executor";
import type {
  ChildToParent,
  JobChannelOperation,
  JobChannelReplies,
  JobChannelReply,
  ParentToChild,
  SerializableContext,
} from "../protocol";
import type { RunContext, RunProgress } from "../types";
import process from "node:process";
// Deep paths, deliberately, not the `@kingsleyweb/bun-common` barrel.
//
// This module is the whole of a child's start-up, and the barrel re-exports
// bun-common's HTTP layer — which pulls in `file-type`, `busboy`, `accepts`,
// `type-is` and `parse-domain` at module scope, none of which a runner child
// ever touches. Measured on Bun 1.4.3: the barrel costs 58.5ms to import,
// `lib/logging` 1.4ms and `lib/utils/native` 8.0ms. Since a fresh child is
// created per run, that difference *was* the dispatch latency.
//
// `__tests__/runner-startup.test.ts` fails if the barrel comes back.
import { createLogger } from "@kingsleyweb/bun-common/lib/logging";
import {
  deserializeError,
  serializeError,
} from "@kingsleyweb/bun-common/lib/utils/native";
import { displayRepeatKey } from "../../queue/options";
import { DEFAULT_LOCK_DURATION } from "../../shared/constants";
import { ProtocolError } from "../../shared/errors";
import { toHandler } from "../executors/executor";
import { CLOSE_EXIT_CODE, JOB_CHANNEL } from "../protocol";

/**
 * The child half of the protocol, shared by the spawned-process and worker
 * entry points.
 *
 * Both differ only in how bytes move, so everything else — importing the
 * handler, building its context, honouring `close`, reporting the outcome —
 * lives here once. That is what makes the three execution modes genuinely
 * interchangeable rather than approximately so.
 *
 * A child runs whatever handler the file holds, so it never knows that
 * handler's declared argument or message types: those stay `unknown` here,
 * and are the handler's to narrow.
 */

/** How a child talks to its parent. */
export interface ChildTransport {
  /** Sends one message to the parent. */
  send: (message: ChildToParent) => void;
  /** Registers the parent-message listener. */
  onMessage: (listener: (message: ParentToChild) => void) => void;
  /** Closes the channel, when the transport has one. */
  disconnect?: () => void;
  /** Ends the process, when the transport can. */
  exit?: (code: number) => void;
}

/**
 * Settles one pending job-channel request with its reply as it arrived over
 * IPC: read as a `Partial`, so unchecked until {@link readReply} checks it.
 */
type ReplyResolver = (reply: Partial<JobChannelReply>) => void;

/** A check that a reply's value is what one operation answers. */
type ReplyCheck<TValue> = (value: unknown) => value is TValue;

/** Whether a value is a plain object keyed by strings. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How each operation's reply value is checked before a processor sees it. */
const REPLY_CHECKS: {
  [Operation in JobChannelOperation]: ReplyCheck<JobChannelReplies[Operation]>;
} = {
  log: (value): value is number =>
    typeof value === "number" && Number.isFinite(value),
  heartbeat: (value): value is boolean => typeof value === "boolean",
  childrenValues: isRecord,
  childrenFailures: (value): value is Record<string, SerializedError> =>
    isRecord(value) &&
    Object.values(value).every(
      (error) => isRecord(error) && typeof error.message === "string",
    ),
};

/**
 * The value a job-channel reply answers, checked against its operation.
 *
 * A reply the worker marked as an error rejects with that error, rebuilt. A
 * reply with no value — or a value of the wrong shape — rejects with a
 * {@link ProtocolError}. Those used to resolve `NaN` for `job.log()` and
 * `false` for `extendLock()`: numbers and flags a processor would act on,
 * invented from a message that did not say anything. The typed results of
 * `log()` (`number`) and `extendLock()` (`boolean`) leave no room for
 * `undefined` either, so rejecting is the one honest answer.
 */
function readReply<TOperation extends JobChannelOperation>(
  operation: TOperation,
  reply: Partial<JobChannelReply>,
): JobChannelReplies[TOperation] {
  if (reply.error !== undefined) {
    throw deserializeError(reply.error);
  }

  const what = `job channel "${operation}"`;

  if (reply.value === undefined) {
    throw new ProtocolError(what, "the reply carried no value", {
      seq: reply.seq,
    });
  }

  const check: ReplyCheck<JobChannelReplies[TOperation]> =
    REPLY_CHECKS[operation];
  if (!check(reply.value)) {
    throw new ProtocolError(
      what,
      `the reply's value is not what "${operation}" answers`,
      { seq: reply.seq, received: typeof reply.value },
    );
  }

  return reply.value;
}

/** How long before `closeTimeout` the child stops waiting and exits itself. */
const SELF_EXIT_MARGIN = 500;

/**
 * Runs the child protocol until the run settles.
 *
 * A child exits itself shortly before the parent's `closeTimeout` expires, so
 * the escalation to `SIGTERM` is a fallback for a wedged handler rather than
 * the normal path.
 */
export function runChildProtocol(transport: ChildTransport): void {
  let running = false;

  transport.onMessage((message) => {
    if (message?.t !== "start" || running) {
      // A second `start` is ignored: one child runs one run.
      return;
    }

    running = true;
    void execute(transport, message.ctx);
  });

  transport.send({
    t: "ready",
    pid: process.pid,
    protocol: 1,
  });
}

/** Imports the handler, runs it, and reports how it ended. */
async function execute(
  transport: ChildTransport,
  ctx: SerializableContext,
): Promise<void> {
  const controller = new AbortController();
  const listeners = new Set<(message: unknown) => void>();
  const pending: unknown[] = [];
  /** Replies awaited from the worker, by request number. */
  const replies = new Map<number, ReplyResolver>();
  let settled = false;

  transport.onMessage((message) => {
    if (message?.t === "message" && message.runId === ctx.runId) {
      const reply = message.data as Partial<JobChannelReply> | null;
      if (
        reply &&
        typeof reply === "object" &&
        reply[JOB_CHANNEL] === "reply"
      ) {
        replies.get(reply.seq ?? -1)?.(reply);
        replies.delete(reply.seq ?? -1);
        return;
      }

      if (listeners.size === 0) {
        pending.push(message.data);
        return;
      }
      for (const listener of listeners) {
        listener(message.data);
      }
      return;
    }

    if (message?.t === "close" && message.runId === ctx.runId) {
      controller.abort();
      scheduleSelfExit(ctx, () => settled, transport);
    }
  });

  const context: RunContext = {
    runId: ctx.runId,
    runnerId: ctx.runnerId,
    runnerName: ctx.runnerName,
    namespace: ctx.namespace,
    attempt: ctx.attempt,
    source: ctx.source,
    mode: ctx.mode,
    startedAt: ctx.startedAt,
    deadline: ctx.deadline,
    args: ctx.args,
    signal: controller.signal,
    logger: buildLogger(transport, ctx),
    progress: (value) => {
      transport.send({ t: "progress", runId: ctx.runId, value });
    },
    send: (data) => {
      transport.send({ t: "message", runId: ctx.runId, data });
    },
    onMessage: (listener) => {
      listeners.add(listener);
      while (pending.length > 0) {
        listener(pending.shift());
      }
      return () => listeners.delete(listener);
    },
    ...(ctx.driverConfig ? { driverConfig: ctx.driverConfig } : {}),
  };

  transport.send({ t: "started", runId: ctx.runId });

  try {
    const module: unknown = await import(ctx.file);
    const result =
      ctx.kind === "job" && ctx.job
        ? await toHandler(
            module,
            ctx.file,
            "job",
          )(...isolatedJob(transport, ctx, controller, replies))
        : await toHandler(module, ctx.file)(context);
    settled = true;
    transport.send({ t: "done", runId: ctx.runId, result: result ?? null });
    finish(transport, 0);
  } catch (error) {
    settled = true;
    transport.send({
      t: "error",
      runId: ctx.runId,
      error: serializeError(error),
    });
    finish(transport, 1);
  }
}

/**
 * The job and context an isolated processor is handed.
 *
 * The same shape a processor receives in the worker, less what needs a
 * driver: the child has none, so log lines and lock renewals are asked of the
 * worker and answered back, progress is forwarded, and the operations that
 * would change the stored job directly say plainly that they cannot be used
 * here rather than failing obscurely.
 */
function isolatedJob(
  transport: ChildTransport,
  ctx: SerializableContext,
  controller: AbortController,
  replies: Map<number, ReplyResolver>,
): [job: IsolatedJob, context: ProcessorContext] {
  const record = ctx.job!;
  let seq = 0;

  /**
   * Asks the worker for one job-channel operation and resolves its checked
   * answer. Rejects with the worker's error, or with a `ProtocolError` for a
   * reply that does not say what the operation answers (see `readReply`).
   */
  function ask(
    operation: "log",
    fields: { line: string },
  ): Promise<JobChannelReplies["log"]>;
  function ask(
    operation: "heartbeat",
    fields?: { ms: number },
  ): Promise<JobChannelReplies["heartbeat"]>;
  function ask(
    operation: "childrenValues",
  ): Promise<JobChannelReplies["childrenValues"]>;
  function ask(
    operation: "childrenFailures",
  ): Promise<JobChannelReplies["childrenFailures"]>;
  async function ask(
    operation: JobChannelOperation,
    fields: { line?: string; ms?: number } = {},
  ): Promise<JobChannelReplies[JobChannelOperation]> {
    return await new Promise((resolve, reject) => {
      const id = ++seq;
      replies.set(id, (reply) => {
        try {
          resolve(readReply(operation, reply));
        } catch (error) {
          reject(error);
        }
      });
      transport.send({
        t: "message",
        runId: ctx.runId,
        data: { [JOB_CHANNEL]: operation, seq: id, ...fields },
      });
    });
  }

  const unavailable = (method: string) => async () => {
    throw new Error(
      `job.${method}() is not available in an isolated job: it changes the stored job, and the driver stays in the worker process`,
    );
  };

  const log = async (line: string) => await ask("log", { line: String(line) });
  // Exactly what `Job.extendLock(ms)` does: the duration asked for, or
  // `DEFAULT_LOCK_DURATION` when none was, never the worker's `lockDuration`.
  // It used to ask for a plain heartbeat and so ignored `ms` altogether.
  const extendLock = async (ms?: number) =>
    await ask("heartbeat", { ms: ms ?? DEFAULT_LOCK_DURATION });

  const job: IsolatedJob = {
    id: record.id,
    name: record.name,
    data: record.data,
    opts: record.opts,
    state: record.state,
    priority: record.priority,
    runAt: record.runAt,
    createdAt: record.createdAt,
    processedOn: record.processedOn,
    finishedOn: record.finishedOn,
    expiresAt: record.expiresAt,
    attemptsMade: record.attemptsMade,
    maxAttempts: record.maxAttempts,
    stalledCount: record.stalledCount,
    progress: record.progress,
    // `?? null`, as `Job` has it: a record without one reads `null`, not
    // `undefined`.
    returnValue: record.returnValue ?? null,
    failedReason: record.failedReason
      ? deserializeError(record.failedReason)
      : null,
    stacktrace: record.stacktrace.map((entry) => deserializeError(entry)),
    workerId: record.workerId,
    // Shown as `Job` shows it: a caller's key without its stored `k:` prefix,
    // unless the key contains `|` (see `displayRepeatKey`). The raw stored
    // spelling made the same job report a different key once isolated.
    repeatKey:
      record.repeatKey === null ? null : displayRepeatKey(record.repeatKey),
    wasAdded: true,
    queue: { ns: ctx.namespace, queue: ctx.runnerId },
    isRepeat: record.repeatKey !== null,
    lockToken: record.lockToken,
    updateProgress: async (value: RunProgress) => {
      transport.send({ t: "progress", runId: ctx.runId, value });
    },
    log,
    extendLock,
    touch: extendLock,
    getLogs: unavailable("getLogs"),
    updateData: unavailable("updateData"),
    setPriority: unavailable("setPriority"),
    reschedule: unavailable("reschedule"),
    remove: unavailable("remove"),
    retry: unavailable("retry"),
    promote: unavailable("promote"),
    refresh: unavailable("refresh"),
    // Read from the record, exactly as `Job`'s constructor does: the child has
    // it already, so there is nothing to ask the worker.
    parent: record.flow?.parent ?? null,
    // Read fresh by the worker's real `Job`, which has the driver.
    getChildrenValues: async () => await ask("childrenValues"),
    getChildrenFailures: async () =>
      Object.fromEntries(
        Object.entries(await ask("childrenFailures")).map(([key, error]) => [
          key,
          deserializeError(error),
        ]),
      ),
    toJSON: () => ({ ...record }),
  };

  const context: ProcessorContext = {
    signal: controller.signal,
    logger: buildLogger(transport, ctx),
    workerId: ctx.runnerName,
    attempt: ctx.attempt,
    // A plain heartbeat, no duration: the worker renews for its own
    // `lockDuration`, exactly as the in-process `ctx.heartbeat()` does.
    heartbeat: async () => {
      await ask("heartbeat");
    },
    log,
  };

  return [job, context];
}

/**
 * A logger that either forwards to the parent (so its records surface as the
 * runner's `log` event) or writes to the child's own stdout.
 */
function buildLogger(transport: ChildTransport, ctx: SerializableContext) {
  if (!ctx.forwardLogs) {
    return createLogger({
      name: ctx.runnerName,
      bindings: { namespace: ctx.namespace, runId: ctx.runId },
    });
  }

  return createLogger({
    level: "trace",
    name: ctx.runnerName,
    bindings: { namespace: ctx.namespace, runId: ctx.runId },
    sink: (event: LogEvent) => {
      transport.send({
        t: "log",
        runId: ctx.runId,
        level: event.level,
        message: event.message,
        fields: { ...event.bindings, ...event.fields },
      });
    },
  });
}

/**
 * After a `close`, gives the handler until just before the parent's
 * `closeTimeout` and then exits — so a well-behaved child never needs a
 * signal, and a wedged one still stops before the escalation reaches it.
 */
function scheduleSelfExit(
  ctx: SerializableContext,
  hasSettled: () => boolean,
  transport: ChildTransport,
): void {
  const delay = Math.max(0, ctx.closeTimeout - SELF_EXIT_MARGIN);
  const timer = setTimeout(() => {
    if (!hasSettled()) {
      finish(transport, CLOSE_EXIT_CODE);
    }
  }, delay);
  timer.unref?.();
}

/** Closes the channel and ends the process. */
function finish(transport: ChildTransport, code: number): void {
  transport.disconnect?.();
  transport.exit?.(code);
}
