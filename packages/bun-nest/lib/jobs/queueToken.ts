import type { BunQueue } from "@kingsleyweb/bun-jobs";
import { ConfigError } from "@kingsleyweb/bun-common";
import { QUEUE_TOKEN_METADATA } from "./metadata";

/**
 * A named class extending `BunQueue` that stands for one registered queue: the
 * injection token and the type at once. Nothing is ever an instance of the
 * class; the provider hands back the real queue.
 */
export type QueueTokenClass<
  TQueue extends BunQueue<any, any, any, any> = BunQueue<any, any, any, any>,
> = abstract new (...args: never[]) => TQueue;

/** What {@link QueueToken} recorded on a class. */
export interface QueueTokenTarget {
  /** The queue's name. */
  readonly queue: string;
  /** The context's `name`; `undefined` for the default context. */
  readonly context: string | undefined;
}

/**
 * Names the queue a token class stands for, and so types it. A wrong payload
 * or an undeclared job name is then a compile error wherever the queue is
 * injected:
 *
 * ```ts
 * @QueueToken("emails")
 * export abstract class EmailsQueue extends BunQueue<Email, string, "welcome" | "digest"> {}
 *
 * BunJobsModule.registerQueue(EmailsQueue);
 * constructor(private readonly emails: EmailsQueue) {}   // or @InjectQueue(EmailsQueue)
 * ```
 *
 * It must be a named class, as above: a function returning an anonymous class
 * fails declaration emit under `declaration: true` (`TS4094`).
 *
 * @param queue The queue's name.
 * @param context The context's `name`; the default context when left out.
 */
export function QueueToken(queue: string, context?: string) {
  return (target: QueueTokenClass): void => {
    const recorded: QueueTokenTarget = { queue, context };
    Reflect.defineMetadata(QUEUE_TOKEN_METADATA, recorded, target);
  };
}

/** What `@QueueToken()` recorded on a class, or `undefined` for any other class. */
export function queueTokenOf(
  /** The class to read. */
  target: QueueTokenClass,
): QueueTokenTarget | undefined {
  return Reflect.getOwnMetadata(QUEUE_TOKEN_METADATA, target) as
    QueueTokenTarget | undefined;
}

/**
 * What `@QueueToken()` recorded on a class.
 *
 * @throws ConfigError when the class has no `@QueueToken()`.
 */
export function requireQueueToken(
  /** The class to read. */
  target: QueueTokenClass,
  /** Who is asking, for the message. */
  caller: string,
): QueueTokenTarget {
  if (typeof target !== "function") {
    throw new ConfigError(
      `${caller}: expected a queue's name or a @QueueToken() class, got ${String(target)}. A class declared later in the file, or across an import cycle, reads as undefined here`,
    );
  }
  const recorded = queueTokenOf(target);
  if (recorded === undefined) {
    throw new ConfigError(
      `${caller}: ${target.name || "this class"} has no @QueueToken(name): a queue token class must say which queue it stands for`,
    );
  }
  return recorded;
}
