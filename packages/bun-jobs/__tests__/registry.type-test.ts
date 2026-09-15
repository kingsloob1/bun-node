import type { Job, JobDraft, RepeatEveryOptions } from "../lib/index";
import { BunJobs, MemoryDriver } from "../lib/index";

/**
 * Compile-time guarantees for `jobs.create()` and `jobs.processEvery()`.
 *
 * Checked by the tests typecheck, not `bun test`. Each `@ts-expect-error`
 * is a negative control: if the line it guards stops being an error, the
 * directive itself becomes one.
 */

/** Resolves to `true` only when `A` and `B` are the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Fails to compile unless given `true`. */
type Expect<T extends true> = T;

/** Payload of the `mail` job used throughout. */
interface Mail {
  /** Recipient. */
  to: string;
}

export async function typeChecks(): Promise<void> {
  const jobs = new BunJobs({ namespace: "types", driver: new MemoryDriver() });

  // The data type given to create() flows into the draft and the saved job.
  const draft = jobs.create("mail", { to: "ops" } satisfies Mail);
  type _Draft = Expect<Equal<typeof draft, JobDraft<Mail, unknown>>>;

  const _saved = await draft.priority(1).attempts(3).save();
  type _Saved = Expect<Equal<typeof _saved, Job<Mail, unknown>>>;

  // An explicit result type is carried as well.
  const _typed = jobs.create<Mail, number>("mail");
  type _Typed = Expect<
    Equal<Awaited<ReturnType<typeof _typed.save>>, Job<Mail, number>>
  >;

  // Setters are chainable and keep the draft's type.
  const _chained = draft
    .unique("a")
    .schedule("in 5 minutes")
    .delay(1_000)
    .timeout("30 seconds")
    .removeOnComplete({ count: 10 })
    .removeOnFail(true)
    .repeatEvery("1 day", { tz: "Europe/London", limit: 3 });
  type _Chained = Expect<Equal<typeof _chained, JobDraft<Mail, unknown>>>;

  draft.withData({ to: "someone" });
  // @ts-expect-error data must match the draft's data type
  draft.withData({ from: 1 });

  // @ts-expect-error repeatEvery's options do not take a second schedule
  draft.repeatEvery("1 day", { every: 5 });

  const options: RepeatEveryOptions = {
    startAt: "tomorrow",
    immediately: true,
  };
  draft.repeatEvery("0 9 * * 1", options);

  // @ts-expect-error priority is numeric, not Agenda's named levels
  draft.priority("high");

  // processEvery takes milliseconds or a duration, and chains.
  const same: BunJobs = jobs.processEvery("5 seconds").processEvery(250);
  void same;

  // @ts-expect-error a Date is not an interval
  jobs.processEvery(new Date());

  // The same value, given at construction.
  const configured = [
    new BunJobs({ namespace: "a", processEvery: "5 seconds" }),
    new BunJobs({ namespace: "b", processEvery: 250 }),
  ];
  void configured;

  // @ts-expect-error a Date is not an interval here either
  void new BunJobs({ namespace: "c", processEvery: new Date() });
}
