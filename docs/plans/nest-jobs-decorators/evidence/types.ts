/**
 * Q: What can TypeScript enforce end to end, from an injected queue to a
 * decorated handler? Each line marked `@ts-expect-error` is a mistake the
 * design wants caught. Run tsc: an expect-error that is NOT needed shows up
 * as TS2578 ("Unused '@ts-expect-error' directive"), which means TypeScript
 * did NOT catch that mistake. Lines marked UNCAUGHT have no directive and are
 * mistakes that compile.
 *
 * Run: bunx tsc --noEmit -p . 2>&1 | grep types.ts
 */
import type { Job } from "@kingsleyweb/bun-jobs";
import { BunQueue } from "@kingsleyweb/bun-jobs";
import { Inject } from "@nestjs/common";

interface Email { to: string }
interface Wrong { count: number }

/* --- 1. A string token: the parameter's type is whatever you write. ------ */
const InjectQueue = (name: string) => Inject(`bun-jobs:queue:${name}`);
export class StringToken {
  // UNCAUGHT: the token names "emails", the type says Wrong. Nothing links them.
  constructor(@InjectQueue("emails") readonly queue: BunQueue<Wrong>) {}
  async send() {
    await this.queue.add("welcome", { count: 1 }); // compiles, and is wrong at runtime
  }
}

/* --- 2. A class token that IS the type: QueueToken<T>. -------------------- */
/** What `defineQueue<Email>("emails")` would return: an abstract class whose instance type is the typed queue. */
function defineQueue<TData, TResult = unknown, TName extends string = string>(name: string) {
  abstract class QueueToken extends BunQueue<TData, TResult, TName> {
    static readonly queueName = name;
    /** Phantom: lets a decorator read the queue's types back (emits nothing). */
    declare readonly __types: { data: TData; result: TResult; name: TName };
  }
  return QueueToken;
}
/*
 * 2a. FINDING: under `declaration: true` (the repo's base config, and any
 * library), an exported class whose constructor names this anonymous class
 * fails declaration emit with TS4094 (BunQueue's #private members) and TS4023.
 * See results-types.txt. So the factory-returns-a-class shape is out.
 */
const AnonymousEmailsQueue = defineQueue<Email, string, "welcome" | "digest">("emails");
export class UsesAnonymousToken {
  constructor(@Inject(AnonymousEmailsQueue) readonly emails: InstanceType<typeof AnonymousEmailsQueue>) {}
}

/*
 * 2b. A NAMED abstract class extending BunQueue: one line for the user,
 * declaration-safe, and still the token and the type at once. The provider
 * hands back the real BunQueue; nothing is ever an instance of this class.
 */
export abstract class EmailsQueue extends BunQueue<Email, string, "welcome" | "digest"> {
  static readonly queueName = "emails";
  /** Phantom: lets a decorator read the queue's types back (emits nothing). */
  declare readonly __types: { data: Email; result: string; name: "welcome" | "digest" };
}

export class ClassToken {
  // The token and the type are one symbol, so injecting it needs no @Inject at
  // all under emitDecoratorMetadata, and with @Inject the two cannot disagree
  // unless written twice differently.
  constructor(@Inject(EmailsQueue) readonly emails: EmailsQueue) {}
  async send() {
    await this.emails.add("welcome", { to: "ada@example.com" });
    // @ts-expect-error -- wrong payload
    await this.emails.add("welcome", { count: 1 });
    // @ts-expect-error -- a name the queue does not declare
    await this.emails.add("nope", { to: "ada@example.com" });
  }
}
export class ClassTokenWrittenTwice {
  // UNCAUGHT: @Inject(EmailsQueue) with a different declared type still compiles.
  constructor(@Inject(EmailsQueue) readonly emails: BunQueue<Wrong>) {}
}

/* --- 3. A method decorator can check the handler's signature. ------------ */
type Types<Q> = Q extends abstract new (...args: never[]) => { __types: infer T } ? T : never;
type DataOf<Q> = Types<Q> extends { data: infer D } ? D : never;
type ResultOf<Q> = Types<Q> extends { result: infer R } ? R : never;

/** `@Process(EmailsQueue, "welcome")` for a handler written as (job, ctx). */
function ProcessTyped<Q extends abstract new (...args: never[]) => BunQueue<any, any, any>>(_queue: Q, _name?: string) {
  return <M extends (job: Job<DataOf<Q>, ResultOf<Q>>, ...rest: never[]) => ResultOf<Q> | Promise<ResultOf<Q>>>(
    _target: object,
    _key: string | symbol,
    _descriptor: TypedPropertyDescriptor<M>,
  ): void => {};
}

/** A parameter decorator sees (target, key, index): never the parameter's type. */
const JobData = (): ParameterDecorator => () => {};
const UntypedProcess = (_name?: string): MethodDecorator => () => {};

export class Handlers {
  @ProcessTyped(EmailsQueue, "welcome")
  async ok(job: Job<Email, string>) {
    return `sent:${job.data.to}`;
  }

  // @ts-expect-error -- the job's payload type is wrong
  @ProcessTyped(EmailsQueue, "welcome")
  async wrongPayload(job: Job<Wrong, string>) {
    return `sent:${job.data.count}`;
  }

  // @ts-expect-error -- the result type is wrong (number, the queue says string)
  @ProcessTyped(EmailsQueue, "welcome")
  async wrongResult(job: Job<Email, string>) {
    return job.data.to.length;
  }

  // @ts-expect-error -- the typed form requires (job, ctx): a handler written with parameter decorators is refused, so the two styles do not combine
  @ProcessTyped(EmailsQueue, "welcome")
  async paramDecorated(@JobData() data: Email) {
    return data.to;
  }

  // UNCAUGHT: an untyped @Process with @JobData(): the parameter's type is whatever you write.
  @UntypedProcess("welcome")
  async untyped(@JobData() data: Wrong) {
    return data.count;
  }
}

/* --- 4. The name: a method decorator can also narrow the name. ----------- */
type NameOf<Q> = Types<Q> extends { name: infer N } ? N : never;
function ProcessNamed<Q extends abstract new (...args: never[]) => BunQueue<any, any, any>>(_queue: Q, _name: NameOf<Q>): MethodDecorator {
  return () => {};
}
export class Named {
  @ProcessNamed(EmailsQueue, "digest")
  digest() {}

  // @ts-expect-error -- not a declared name
  @ProcessNamed(EmailsQueue, "nope")
  nope() {}
}
