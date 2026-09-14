import type { LogEvent } from "@kingsleyweb/bun-common/lib/logging";
import type {
  ChildToParent,
  JobChannelReply,
  ParentToChild,
  SerializableContext,
} from "../protocol";
import type { RunContext } from "../types";
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
    void execute(transport, message.ctx as SerializableContext<unknown>);
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
  ctx: SerializableContext<unknown>,
): Promise<void> {
  const controller = new AbortController();
  const listeners = new Set<(message: unknown) => void>();
  const pending: unknown[] = [];
  /** Replies awaited from the worker, by request number. */
  const replies = new Map<number, (value: unknown) => void>();
  let settled = false;

  transport.onMessage((message) => {
    if (message?.t === "message" && message.runId === ctx.runId) {
      const reply = message.data as Partial<JobChannelReply> | null;
      if (
        reply &&
        typeof reply === "object" &&
        reply[JOB_CHANNEL] === "reply"
      ) {
        replies.get(reply.seq ?? -1)?.(reply.value);
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

  const context: RunContext<unknown> = {
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
    const handler = toHandler(await import(ctx.file), ctx.file);
    const result =
      ctx.kind === "job" && ctx.job
        ? await (handler as unknown as IsolatedProcessorFn)(
            ...isolatedJob(transport, ctx, controller, replies),
          )
        : await handler(context);
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

/** A queue job processor, as a child calls it. */
type IsolatedProcessorFn = (job: unknown, context: unknown) => unknown;

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
  ctx: SerializableContext<unknown>,
  controller: AbortController,
  replies: Map<number, (value: unknown) => void>,
): [job: unknown, context: unknown] {
  const record = ctx.job!;
  let seq = 0;

  const ask = async (
    operation: "log" | "heartbeat",
    fields: { line?: string } = {},
  ): Promise<unknown> =>
    await new Promise((resolve) => {
      const id = ++seq;
      replies.set(id, resolve);
      transport.send({
        t: "message",
        runId: ctx.runId,
        data: { [JOB_CHANNEL]: operation, seq: id, ...fields },
      });
    });

  const unavailable = (method: string) => async () => {
    throw new Error(
      `job.${method}() is not available in an isolated job: it changes the stored job, and the driver stays in the worker process`,
    );
  };

  const log = async (line: string) =>
    Number(await ask("log", { line: String(line) }));
  const extendLock = async () => Boolean(await ask("heartbeat"));

  const job = {
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
    returnValue: record.returnValue,
    failedReason: record.failedReason
      ? deserializeError(record.failedReason)
      : null,
    stacktrace: record.stacktrace.map((entry) => deserializeError(entry)),
    workerId: record.workerId,
    repeatKey: record.repeatKey,
    wasAdded: true,
    queue: { ns: ctx.namespace, queue: ctx.runnerId },
    isRepeat: record.repeatKey !== null,
    lockToken: record.lockToken,
    updateProgress: async (value: unknown) => {
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
    toJSON: () => ({ ...record }),
  };

  const context = {
    signal: controller.signal,
    logger: buildLogger(transport, ctx),
    workerId: ctx.runnerName,
    attempt: ctx.attempt,
    heartbeat: async () => {
      await extendLock();
    },
    log,
  };

  return [job, context];
}

/**
 * A logger that either forwards to the parent (so its records surface as the
 * runner's `log` event) or writes to the child's own stdout.
 */
function buildLogger(
  transport: ChildTransport,
  ctx: SerializableContext<unknown>,
) {
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
  ctx: SerializableContext<unknown>,
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
