import type { LogEvent } from "@kingsleyweb/bun-common";
import type {
  ChildToParent,
  ParentToChild,
  SerializableContext,
} from "../protocol";
import type { RunContext } from "../types";
import process from "node:process";
import { createLogger, serializeError } from "@kingsleyweb/bun-common";
import { toHandler } from "../executors/executor";
import { CLOSE_EXIT_CODE } from "../protocol";

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
  let settled = false;

  transport.onMessage((message) => {
    if (message?.t === "message" && message.runId === ctx.runId) {
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
    const result = await handler(context);
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
