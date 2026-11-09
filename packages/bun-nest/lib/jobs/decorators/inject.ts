import type { QueueTokenClass } from "../queueToken";
import { ConfigError } from "@kingsleyweb/bun-common";
import { Inject } from "@nestjs/common";
import { requireQueueToken } from "../queueToken";
import {
  getBunJobsToken,
  getJobsNotifierToken,
  getQueueToken,
  getWorkerToken,
} from "../tokens";
import { processorOf } from "./consumer";

/**
 * Injects a queue that `BunJobsModule.registerQueue()` registered, by name or
 * by its typed token class. A class token carries its own context, and is the
 * type too; with a name, the parameter's type is the caller's word.
 *
 * ```ts
 * constructor(
 *   @InjectQueue("emails") private readonly emails: BunQueue<Email>,
 *   @InjectQueue("invoices", "billing") private readonly invoices: BunQueue<Invoice>,
 *   @InjectQueue(ReportsQueue) private readonly reports: ReportsQueue,
 * ) {}
 * ```
 *
 * @param queue The queue's name, or its {@link QueueToken} class.
 * @param context With a name, the context's `name`; the default context when
 * left out.
 */
export function InjectQueue(
  queue: string | QueueTokenClass,
  context?: string,
): PropertyDecorator & ParameterDecorator {
  if (typeof queue === "string") {
    return Inject(getQueueToken(queue, context));
  }
  requireQueueToken(queue, "@InjectQueue()");
  return Inject(queue);
}

/**
 * Injects a `BunJobs` context. For the default context a plain
 * `constructor(jobs: BunJobs)` also works.
 *
 * @param context The context's `name`; the default context when left out.
 */
export function InjectBunJobs(
  context?: string,
): PropertyDecorator & ParameterDecorator {
  return Inject(getBunJobsToken(context));
}

/**
 * Injects a `WorkerRef`: a handle on the worker serving a `@Processor` class's
 * queue, or a queue by name. The worker is built at bootstrap, after injection,
 * so its `worker` getter throws a `ConfigError` before then.
 *
 * `BunJobsModule.registerQueue()` provides the handle, as it does the queue, so
 * import it where this is injected. A class must already be defined here: for a
 * class declared later, or across an import cycle, give the queue's name.
 *
 * @param target A `@Processor` class, or the queue's name.
 * @param context With a name, the context's `name`; the default context when
 * left out.
 * @throws ConfigError on a class with no `@Processor`.
 */
export function InjectWorker(
  target: string | (abstract new (...args: never[]) => unknown),
  context?: string,
): PropertyDecorator & ParameterDecorator {
  if (typeof target === "string") {
    return Inject(getWorkerToken(target, context));
  }
  const metadata =
    typeof target === "function" ? processorOf(target) : undefined;
  if (metadata === undefined) {
    throw new ConfigError(
      `@InjectWorker(): ${(target as { name?: string } | undefined)?.name ?? String(target)} has no @Processor. A class declared later in the file, or across an import cycle, reads as undefined here: give the queue's name instead`,
    );
  }
  return Inject(getWorkerToken(metadata.queue, metadata.context));
}

/**
 * Injects a `JobsNotifier` following the context's queues and runners, for a
 * provider that wants the stream itself (`notifier.on("event", …)`, or `for await`).
 * It costs a subscription per queue, so the module opens it only when a class asks
 * for it, while Nest builds providers, and closes it on `app.close()`. To hear worker
 * events, `notifier.hold("worker", queue)`. `@OnJobsEvent` needs none of this.
 *
 * @param context The context's `name`; the default context when left out.
 */
export function InjectJobsNotifier(
  context?: string,
): PropertyDecorator & ParameterDecorator {
  return Inject(getJobsNotifierToken(context));
}
