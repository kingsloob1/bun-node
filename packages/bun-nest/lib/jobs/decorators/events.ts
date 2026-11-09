import type {
  BunQueueEvents,
  BunQueueWorkerEvents,
  BunRunnerEvents,
  DriverEvent,
} from "@kingsleyweb/bun-jobs";
import type { QueueTokenClass } from "../queueToken";
import type { QueueJobData, QueueJobResult } from "./consumer";
import { EVENT_LISTENERS_METADATA } from "../metadata";
import { requireQueueToken } from "../queueToken";

/** Which subsystem a published event came from. */
export type JobsEventKind = DriverEvent["kind"];

/** The published events of one kind and, when given, one type. */
export type JobsEventOf<
  TKind extends JobsEventKind = JobsEventKind,
  TType extends string = string,
> = Extract<DriverEvent, { kind: TKind; type: TType }>;

/** What {@link OnJobsEvent} takes. */
export interface OnJobsEventOptions<
  TKind extends JobsEventKind = JobsEventKind,
  TType extends string = string,
> {
  /**
   * `"queue"`, `"runner"` or `"worker"`. Left out, it hears queues and runners:
   * worker events cost a second subscription per queue, so they are asked for by
   * name.
   */
  kind?: TKind;
  /** The event's name, such as `"completed"`; every event when left out. */
  type?: TType & JobsEventOf<TKind>["type"];
  /** The queue or runner it is about; every one in the namespace when left out. */
  target?: string;
  /** The context's `name`; the default context when left out. */
  context?: string;
}

/** What {@link OnQueueEvent} and {@link OnRunnerEvent} take. */
export interface OnEventOptions {
  /** The context's `name`; the default context when left out. */
  context?: string;
}

/** A method decorator whose method must fit one listener's signature. */
export type TypedListenerDecorator<TListener> = <M extends TListener>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<M>,
) => void;

/** What one event decorator recorded on a method. */
export type EventListenerMetadata =
  | {
      /** The processor's own worker. */
      readonly source: "worker";
      /** The event. */
      readonly event: string;
    }
  | {
      /** A queue's emitter. */
      readonly source: "queue";
      /** The queue. */
      readonly queue: string;
      /** The context's `name`. */
      readonly context: string | undefined;
      /** The event. */
      readonly event: string;
    }
  | {
      /** The namespace's published events. */
      readonly source: "jobs";
      /** Which events. */
      readonly options: OnJobsEventOptions<any, any>;
    }
  | {
      /** A runner's emitter. */
      readonly source: "runner";
      /** The runner's id. */
      readonly id: string;
      /** The context's `name`. */
      readonly context: string | undefined;
      /** The event. */
      readonly event: string;
    };

/** Adds one listener to what a method's decorators recorded. */
function recordListener(
  listener: EventListenerMetadata,
): (
  target: object,
  key: string | symbol,
  descriptor?: PropertyDescriptor,
) => void {
  return (target, _key, descriptor) => {
    const method = (descriptor?.value ?? target) as object;
    const existing = (Reflect.getOwnMetadata(
      EVENT_LISTENERS_METADATA,
      method,
    ) ?? []) as EventListenerMetadata[];
    Reflect.defineMetadata(
      EVENT_LISTENERS_METADATA,
      [...existing, listener],
      method,
    );
  };
}

/** What the event decorators recorded on a method. */
export function listenersOf(method: object): readonly EventListenerMetadata[] {
  return (Reflect.getMetadata(EVENT_LISTENERS_METADATA, method) ??
    []) as EventListenerMetadata[];
}

/**
 * Listens to this `@Processor` class's own worker, in this process, which classes
 * on one queue share. `completed:welcome` hears only jobs named `welcome`, and the
 * job events have that form. The method's parameters are checked against the event.
 *
 * ```ts
 * @OnWorkerEvent("failed")
 * failed(job: Job, error: Error) { … }
 * ```
 *
 * A listener observes: it never runs through the Nest pipeline, and an error in it,
 * thrown or rejected, is logged and affects no job. Its class must be a singleton.
 *
 * @param event The event, or `event:name`.
 */
export function OnWorkerEvent<E extends keyof BunQueueWorkerEvents>(
  event: E,
): TypedListenerDecorator<BunQueueWorkerEvents[E]>;
/**
 * The same, with the payload's types read from the queue's token class.
 *
 * @param queue The queue's token class, which must be the class's own queue.
 * @param event The event, or `event:name`.
 */
export function OnWorkerEvent<
  Q extends QueueTokenClass,
  E extends keyof BunQueueWorkerEvents,
>(
  queue: Q,
  event: E,
): TypedListenerDecorator<
  BunQueueWorkerEvents<QueueJobData<Q>, QueueJobResult<Q>>[E]
>;
export function OnWorkerEvent(
  first: string | QueueTokenClass,
  second?: string,
): (
  target: object,
  key: string | symbol,
  descriptor?: PropertyDescriptor,
) => void {
  return recordListener({
    source: "worker",
    event: (typeof first === "string" ? first : second) as string,
  });
}

/**
 * Listens to a queue's emitter from any singleton provider. Its events are local,
 * unless the queue was registered with `subscribe: true`, when other processes'
 * published events are heard too.
 *
 * @param queue The queue's name, or its token class for typed payloads.
 * @param event The event, or `event:name`.
 * @param options See {@link OnEventOptions}; a token class names its own context.
 */
export function OnQueueEvent<
  Q extends string | QueueTokenClass,
  E extends keyof BunQueueEvents,
>(
  queue: Q,
  event: E,
  options?: OnEventOptions,
): TypedListenerDecorator<
  Q extends QueueTokenClass
    ? BunQueueEvents<QueueJobData<Q>, QueueJobResult<Q>>[E]
    : BunQueueEvents[E]
> {
  const named =
    typeof queue === "string"
      ? { queue, context: options?.context }
      : requireQueueToken(queue, "@OnQueueEvent()");
  return recordListener({
    source: "queue",
    ...named,
    event: event as string,
  }) as never;
}

/**
 * Hears **every process's** published events in the namespace, from any singleton
 * provider: queue, runner and worker events, and summon events. Nothing is heard
 * that was never published, so the producing process needs `publishEvents: true`.
 * The module opens one notifier for these, at bootstrap and only if one exists,
 * following what the decorators name. Filtering by `kind` and `type` narrows the
 * event the method receives.
 *
 * ```ts
 * @OnJobsEvent({ kind: "queue", type: "completed", target: "emails" })
 * completed(event: JobsEventOf<"queue", "completed">) { … }
 * ```
 *
 * @param options See {@link OnJobsEventOptions}.
 */
export function OnJobsEvent<
  TKind extends JobsEventKind = JobsEventKind,
  TType extends string = string,
>(
  options: OnJobsEventOptions<TKind, TType> = {},
): TypedListenerDecorator<(event: JobsEventOf<TKind, TType>) => unknown> {
  return recordListener({ source: "jobs", options }) as never;
}

/**
 * Listens to a runner's emitter, from any singleton provider. The runner must exist
 * by bootstrap, or the boot fails naming it.
 *
 * @param id The runner's id.
 * @param event The event.
 * @param options See {@link OnEventOptions}.
 */
export function OnRunnerEvent<E extends keyof BunRunnerEvents>(
  id: string,
  event: E,
  options?: OnEventOptions,
): TypedListenerDecorator<BunRunnerEvents[E]> {
  return recordListener({
    source: "runner",
    id,
    context: options?.context,
    event: event as string,
  }) as never;
}
