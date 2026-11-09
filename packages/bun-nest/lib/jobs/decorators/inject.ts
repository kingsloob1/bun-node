import type { QueueTokenClass } from "../queueToken";
import { Inject } from "@nestjs/common";
import { requireQueueToken } from "../queueToken";
import { getBunJobsToken, getQueueToken } from "../tokens";

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
