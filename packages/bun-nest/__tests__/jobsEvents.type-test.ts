/**
 * What the types of the event decorators catch (plan nest-jobs-decorators §6.1,
 * §10.1). Checked by `bun run check`; each `@ts-expect-error` is its own negative
 * control (TS2578 when unused).
 */
import type { Job, JobsNotifier, RunRecord } from "@kingsleyweb/bun-jobs";
import type { JobsEventOf } from "../lib/jobs/index";
import { BunQueue } from "@kingsleyweb/bun-jobs";
import {
  InjectJobsNotifier,
  OnJobsEvent,
  OnQueueEvent,
  OnRunnerEvent,
  OnWorkerEvent,
  QueueToken,
} from "../lib/jobs/index";

interface Email {
  to: string;
}

@QueueToken("emails")
export abstract class EmailsQueue extends BunQueue<Email, string, "welcome"> {}

export class WorkerListeners {
  @OnWorkerEvent("completed")
  completed(job: Job, result: unknown) {
    return [job.id, result];
  }

  @OnWorkerEvent("failed")
  async failed(job: Job, error: Error) {
    return [job.id, error.message];
  }

  @OnWorkerEvent("ready")
  ready() {}

  @OnWorkerEvent("stalled")
  stalled(ids: string[]) {
    return ids.length;
  }

  @OnWorkerEvent("completed:welcome")
  scoped(job: Job, result: unknown) {
    return [job.id, result];
  }

  // @ts-expect-error -- `completed` hands the job first, not a string
  @OnWorkerEvent("completed")
  wrongFirst(id: string) {
    return id;
  }

  // @ts-expect-error -- `ready` carries nothing
  @OnWorkerEvent("ready")
  wrongReady(job: Job) {
    return job;
  }

  // @ts-expect-error -- no such event
  @OnWorkerEvent("nope")
  nope() {}

  // @ts-expect-error -- `ready` is about the worker, so it has no scoped form
  @OnWorkerEvent("ready:welcome")
  scopedNotJob() {}

  // @ts-expect-error -- a listener on the plain form hears any job on the queue
  @OnWorkerEvent("completed")
  plainIsNotTyped(job: Job<Email, string>) {
    return job.data.to;
  }

  /* The token form reads the payload's types from the queue. */
  @OnWorkerEvent(EmailsQueue, "completed")
  typed(job: Job<Email, string>, result: string) {
    return `${job.data.to}:${result}`;
  }

  // @ts-expect-error -- the queue's payload is an Email
  @OnWorkerEvent(EmailsQueue, "completed")
  typedWrong(job: Job<{ count: number }, string>) {
    return job.data.count;
  }

  // @ts-expect-error -- the queue's result is a string
  @OnWorkerEvent(EmailsQueue, "completed")
  typedWrongResult(_job: Job<Email, string>, result: number) {
    return result;
  }
}

export class QueueListeners {
  @OnQueueEvent("emails", "added")
  added(job: Job) {
    return job.id;
  }

  @OnQueueEvent("emails", "repeatScheduled", { context: "billing" })
  repeat(key: string, next: number) {
    return [key, next];
  }

  @OnQueueEvent("emails", "completed:welcome")
  scoped(job: Job, result: unknown) {
    return [job.id, result];
  }

  @OnQueueEvent(EmailsQueue, "completed")
  typed(job: Job<Email, string>, result: string) {
    return [job.data.to, result];
  }

  // @ts-expect-error -- `removed` carries an id
  @OnQueueEvent("emails", "removed")
  wrong(job: Job) {
    return job;
  }

  // @ts-expect-error -- `removed` carries an id, so it has no scoped form
  @OnQueueEvent("emails", "removed:welcome")
  scopedNotJob() {}
}

export class JobsListeners {
  @OnJobsEvent()
  everything(event: JobsEventOf) {
    return event.target;
  }

  @OnJobsEvent({ kind: "queue", type: "completed", target: "emails" })
  completed(event: JobsEventOf<"queue", "completed">) {
    return event.payload.id;
  }

  @OnJobsEvent({ kind: "runner" })
  runners(event: JobsEventOf<"runner">) {
    return event.type;
  }

  @OnJobsEvent({ kind: "worker", type: "state" })
  state(event: JobsEventOf<"worker", "state">) {
    return event.payload.state;
  }

  // @ts-expect-error -- `succeeded` is a runner's event, not a queue's
  @OnJobsEvent({ kind: "queue", type: "succeeded" })
  wrongPair() {}

  // @ts-expect-error -- the kind says queue
  @OnJobsEvent({ kind: "queue" })
  wrongParam(event: JobsEventOf<"runner">) {
    return event;
  }
}

export class RunnerListeners {
  @OnRunnerEvent("cleanup", "failed")
  failed(run: RunRecord, error: Error) {
    return [run, error];
  }

  // @ts-expect-error -- no such runner event
  @OnRunnerEvent("cleanup", "nope")
  nope() {}

  // @ts-expect-error -- `failed` hands the run first
  @OnRunnerEvent("cleanup", "failed")
  wrong(id: string) {
    return id;
  }
}

export class Stream {
  constructor(@InjectJobsNotifier() readonly notifier: JobsNotifier) {}
}
