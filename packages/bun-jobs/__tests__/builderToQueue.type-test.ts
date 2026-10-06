import type { Job, JobBuilder, JobDraft, TypedJob } from "../lib/index";
import { BunJobs, MemoryDriver } from "../lib/index";

/**
 * Compile-time guarantees for sending a builder's job to a named queue:
 * `jobs.schedule(...).toQueue(name)` and `jobs.queue(name).<verb>(...)`.
 *
 * The registry queue keeps every check the map gives it, by either spelling;
 * `jobs.queue(other)` takes any name and payload, as its own worker decides.
 * `toQueue()` starts from a registry verb, so its name was already checked.
 *
 * Checked by the tests typecheck, not `bun test`. Each `@ts-expect-error` is a
 * negative control (`scripts/prove-type-controls.ts` proves each is live), and
 * each guarded call is kept to one line so the directive reaches it.
 */

/** Resolves to `true` only when `A` and `B` are the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Fails to compile unless given `true`. */
type Expect<T extends true> = T;

/** What this service's registry declares. */
interface Jobs {
  /** A payload and a result. */
  "send-report": { data: { month: string }; result: string };
  /** No payload. */
  reindex: { data: void };
}

/** A payload some other service's queue takes. */
interface Resize {
  /** The image. */
  id: string;
}

export async function builderToQueueChecks(): Promise<void> {
  const jobs = new BunJobs<Jobs>({
    namespace: "to-queue",
    driver: new MemoryDriver(),
  });

  /* --- toQueue(): checked at the verb, plain after ------------------- */

  const _moved = jobs.schedule("send-report", { month: "x" }).toQueue("images");
  type Moved = Equal<typeof _moved, JobBuilder<unknown, unknown>>;
  type _Moved = Expect<Moved>;

  // After toQueue() any payload goes: the other queue's worker decides.
  const _anyData = await _moved.withData({ anything: [1, 2] }).start();
  type AnyData = Equal<typeof _anyData, Job<unknown, unknown>>;
  type _AnyData = Expect<AnyData>;

  // Or the caller names the other queue's types, as jobs.queue<T>() does.
  const _named = jobs.schedule("reindex").toQueue<Resize, boolean>("images");
  type Named = Equal<typeof _named, JobBuilder<Resize, boolean>>;
  type _Named = Expect<Named>;

  // @ts-expect-error toQueue<Resize>() types withData by Resize
  _named.withData({ id: 1 });

  // run() and process() are schedule() under other names.
  jobs.run("reindex").toQueue("images");
  jobs.process("reindex").toQueue("images");

  // @ts-expect-error the registry still checks the payload at the verb
  jobs.schedule("send-report", { month: 8 }).toQueue("images");

  // One rule, typed or not: a name the registry does not define never reaches
  // toQueue() — here the map refuses it at the verb, and untyped the verb
  // throws. To send one, use jobs.queue(name).<verb>, below.
  // @ts-expect-error a name the map does not declare, at the verb
  jobs.schedule("resize").toQueue("images");

  const _draft = jobs.create("send-report", { month: "x" }).toQueue("images");
  type Draft = Equal<typeof _draft, JobDraft<unknown, unknown>>;
  type _Draft = Expect<Draft>;

  /* --- jobs.queue(name): a foreign queue takes anything --------------- */

  const images = jobs.queue("images");

  const _foreign = images.schedule("resize", { id: "a", width: 10 });
  type Foreign = Equal<typeof _foreign, JobBuilder<unknown, unknown>>;
  type _Foreign = Expect<Foreign>;

  const _foreignNow = images.now(
    "anything",
    { free: "shape" },
    { priority: 1 },
  );
  type ForeignNow = Equal<typeof _foreignNow, Promise<Job<unknown, unknown>>>;
  type _ForeignNow = Expect<ForeignNow>;

  const _foreignDraft = images.create("anything");
  type ForeignDraft = Equal<typeof _foreignDraft, JobDraft<unknown, unknown>>;
  type _ForeignDraft = Expect<ForeignDraft>;

  images.run("anything").in("5 minutes");
  images.now("no-payload");

  // A queue given its types checks them, as its add() does.
  const typedImages = jobs.queue<Resize>("typed-images");
  typedImages.schedule("resize", { id: "a" });

  // @ts-expect-error the queue's payload type is Resize
  typedImages.schedule("resize", { id: 1 });

  // @ts-expect-error now() needs the payload Resize requires
  typedImages.now("resize");

  /* --- jobs.queue("jobs"): the registry queue, by name ---------------- */

  const registry = jobs.queue("jobs");

  const _registryBuilder = registry.schedule("send-report", { month: "x" });
  type RegistryBuilder = Equal<
    typeof _registryBuilder,
    JobBuilder<{ month: string }, string, TypedJob<Jobs, "send-report">>
  >;
  type _RegistryBuilder = Expect<RegistryBuilder>;

  const _registryNow = await registry.now("send-report", { month: "x" });
  type RegistryNow = Equal<typeof _registryNow, TypedJob<Jobs, "send-report">>;
  type _RegistryNow = Expect<RegistryNow>;

  const _registryDraft = registry.create("reindex");
  type RegistryDraft = Equal<
    typeof _registryDraft,
    JobDraft<void, unknown, TypedJob<Jobs, "reindex">>
  >;
  type _RegistryDraft = Expect<RegistryDraft>;

  // @ts-expect-error month is a string
  registry.schedule("send-report", { month: 8 });

  // @ts-expect-error a name the map does not declare
  registry.schedule("nope");

  // @ts-expect-error a name the map does not declare
  registry.run("nope");

  // @ts-expect-error month is a string
  registry.now("send-report", { month: 8 });

  // @ts-expect-error the payload is required
  registry.now("send-report");

  // @ts-expect-error a name the map does not declare
  registry.create("nope");

  /* --- a renamed registry queue --------------------------------------- */

  const work = new BunJobs<Jobs, "work">({
    namespace: "to-queue-work",
    driver: new MemoryDriver(),
    registryQueue: "work",
  });

  work.queue("work").schedule("send-report", { month: "x" });
  // "jobs" is just another queue on this context.
  work.queue("jobs").schedule("anything", { at: "all" });

  // @ts-expect-error the renamed registry queue checks the map
  work.queue("work").schedule("anything");

  /* --- no map: every name, as ever ------------------------------------ */

  const loose = new BunJobs({ namespace: "loose", driver: new MemoryDriver() });
  // Compiles: with no map the name is only checked at runtime, where an
  // undefined one throws at the verb (builder-to-queue.test.ts).
  loose.schedule("anything", { a: 1 }).toQueue("images");
  loose.queue("jobs").schedule("anything", { a: 1 });
  loose.queue("images").create("anything").toQueue("elsewhere");
}
