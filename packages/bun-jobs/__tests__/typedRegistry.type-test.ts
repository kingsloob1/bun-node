import type {
  BunQueueWorker,
  FlowNode,
  FlowResult,
  Job,
  JobBuilder,
  JobDataOf,
  JobDefinition,
  JobDraft,
  JobMap,
  JobMapResult,
  JobOptions,
  JobResultOf,
  RegistryBulkEntry,
  RegistryFlowNode,
  RegistryQueue,
  RegistryWorker,
  RetryAllOptions,
  TypedJob,
  TypedJobProcessor,
  UpdateDataOf,
} from "../lib/index";
import { BunJobs, BunQueue, jobsFromContext, MemoryDriver } from "../lib/index";

/**
 * Compile-time guarantees for the typed job registry.
 *
 * Checked by the tests typecheck, not `bun test`. Each `@ts-expect-error` is a
 * negative control: remove the directive and the typecheck must fail. That is
 * proved rather than assumed — `scripts/prove-type-controls.ts` deletes each
 * one in turn and requires an error to appear.
 *
 * Every guarded call is kept to a single line on purpose. A directive
 * suppresses only the line after it, so a call prettier wraps would put the
 * error out of its reach and turn a live control into an unused-directive
 * error instead. Each `Equal` gets its own alias for the same reason.
 */

/** Resolves to `true` only when `A` and `B` are the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Fails to compile unless given `true`. */
type Expect<T extends true> = T;

/**
 * `true` when each of `A` and `B` is assignable to the other. For a union
 * name's payload, which is an intersection of structurally identical shapes
 * (`{ userId: string } & { userId: string }`) rather than one of them.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** What this service's jobs carry, and what running them answers with. */
interface Jobs {
  /** A payload and a result. */
  "send-report": { data: { month: string }; result: string };
  /** No payload, and no result worth naming. */
  reindex: { data: void };
  /** A payload, with `result` left out so it is `unknown`. */
  "resize-image": { data: { id: string; width: number } };
  /** Two names carrying the same shape, for union names. */
  "notify-email": { data: { userId: string }; result: boolean };
  /** The other half of that pair. */
  "notify-sms": { data: { userId: string }; result: boolean };
  /** A payload that is itself a union, which must stay one. */
  toggle: { data: { on: true } | { off: true } };
  /** The same union again, under another name. */
  "toggle-again": { data: { on: true } | { off: true } };
}

/** A map where every entry names its result, so the union does not collapse. */
interface Results {
  /** Answers with a number. */
  count: { data: void; result: number };
  /** Answers with a string. */
  label: { data: void; result: string };
}

export async function typedRegistryChecks(): Promise<void> {
  const jobs = new BunJobs<Jobs>({
    namespace: "typed",
    driver: new MemoryDriver(),
  });

  /* --- define: data and return type come from the map ---------------- */

  jobs.define("send-report", async (job) => {
    type DefineData = Equal<typeof job.data, { month: string }>;
    type _DefineData = Expect<DefineData>;
    return job.data.month;
  });

  jobs.define("reindex", async (_job) => {
    type ReindexData = Equal<typeof _job.data, void>;
    type _ReindexData = Expect<ReindexData>;
  });

  // @ts-expect-error a name the map does not declare
  jobs.define("nope", async () => 1);

  // @ts-expect-error the handler must answer with the declared result type
  jobs.define("send-report", async () => 42);

  // @ts-expect-error job.data has no `year`
  jobs.define("send-report", async (job) => job.data.year);

  /* --- now: payload checked, result inferred ------------------------- */

  const report = await jobs.now("send-report", { month: "2026-08" });
  type NowJob = Equal<typeof report, TypedJob<Jobs, "send-report">>;
  type _NowJob = Expect<NowJob>;
  // Which is a Job of that name's types, with the name as its literal.
  type NowData = Equal<typeof report.data, { month: string }>;
  type _NowData = Expect<NowData>;
  type NowName = Equal<typeof report.name, "send-report">;
  type _NowName = Expect<NowName>;

  // @ts-expect-error the result is a string, not a number
  const _wrongResult: Job<{ month: string }, number> = report;

  // @ts-expect-error a name the map does not declare
  jobs.now("nope");

  // @ts-expect-error month is a string
  jobs.now("send-report", { month: 8 });

  // @ts-expect-error the payload has no `year`
  jobs.now("send-report", { year: "2026" });

  /* --- schedule / run / process -------------------------------------- */

  const _builder = jobs.schedule("resize-image", { id: "a", width: 10 });
  type BuilderTyped = Equal<
    typeof _builder,
    JobBuilder<
      { id: string; width: number },
      unknown,
      TypedJob<Jobs, "resize-image">
    >
  >;
  type _BuilderTyped = Expect<BuilderTyped>;

  // start() answers with a job of the builder's name, as now() does.
  const _started = await _builder.start();
  type StartedTyped = Equal<typeof _started, TypedJob<Jobs, "resize-image">>;
  type _StartedTyped = Expect<StartedTyped>;

  const _every = await jobs.schedule("reindex").every("1 hour").start();
  type EveryTyped = Equal<typeof _every, TypedJob<Jobs, "reindex">>;
  type _EveryTyped = Expect<EveryTyped>;

  const _later = await jobs.run("send-report").withData({ month: "x" }).start();
  type LaterTyped = Equal<typeof _later.name, "send-report">;
  type _LaterTyped = Expect<LaterTyped>;

  const _processed = await jobs.process("reindex").start();
  type ProcessedTyped = Equal<typeof _processed, TypedJob<Jobs, "reindex">>;
  type _ProcessedTyped = Expect<ProcessedTyped>;

  // @ts-expect-error the started job is resize-image's, not reindex's
  const _notReindex: TypedJob<Jobs, "reindex"> = await _builder.start();

  // @ts-expect-error a name the map does not declare
  jobs.schedule("nope");

  // @ts-expect-error width is a number
  jobs.schedule("resize-image", { id: "a", width: "10" });

  // @ts-expect-error a name the map does not declare
  jobs.run("nope");

  // @ts-expect-error a name the map does not declare
  jobs.process("nope");

  /* --- create: the draft and the job it saves ------------------------ */

  const draft = jobs.create("send-report", { month: "2026-08" });
  type DraftTyped = Equal<
    typeof draft,
    JobDraft<{ month: string }, string, TypedJob<Jobs, "send-report">>
  >;
  type _DraftTyped = Expect<DraftTyped>;

  const _saved = await draft.priority(1).attempts(3).save();
  type SavedTyped = Equal<typeof _saved, TypedJob<Jobs, "send-report">>;
  type _SavedTyped = Expect<SavedTyped>;

  // And so does the draft's `job`, once saved.
  type DraftJob = Equal<
    typeof draft.job,
    TypedJob<Jobs, "send-report"> | undefined
  >;
  type _DraftJob = Expect<DraftJob>;

  // @ts-expect-error the saved job's result is a string
  const _savedNumber: Job<{ month: string }, number> = await draft.save();

  // @ts-expect-error a name the map does not declare
  jobs.create("nope");

  // @ts-expect-error month is a string
  jobs.create("send-report", { month: 8 });

  // @ts-expect-error withData must match the declared payload
  draft.withData({ month: 8 });

  /* --- the registry queue, and BunQueue.add -------------------------- */

  const registry = jobs.queue("jobs");
  type RegistryBound = Equal<typeof registry, RegistryQueue<Jobs>>;
  type _RegistryBound = Expect<RegistryBound>;

  const _added = await registry.add("send-report", { month: "2026-09" });
  type AddTyped = Equal<typeof _added, TypedJob<Jobs, "send-report">>;
  type _AddTyped = Expect<AddTyped>;

  // @ts-expect-error a name the map does not declare
  registry.add("nope", { month: "x" });

  // @ts-expect-error month is a string
  registry.add("send-report", { month: 8 });

  // @ts-expect-error an unregistered payload must name its type
  registry.add("scratch", { note: "one off" });

  // The escape hatch: the name and its payload type, both explicit.
  const _scratch = await registry.add<"scratch", { note: string }>("scratch", {
    note: "x",
  });
  type ScratchTyped = Equal<typeof _scratch, Job<{ note: string }, unknown>>;
  type _ScratchTyped = Expect<ScratchTyped>;

  // The other escape hatch: a queue the registry does not describe.
  const mail = jobs.queue<{ to: string }>("mail");
  type MailTyped = Equal<
    typeof mail,
    BunQueue<{ to: string }, unknown, string>
  >;
  type _MailTyped = Expect<MailTyped>;

  await mail.add("welcome", { to: "ops" });

  // @ts-expect-error the named payload is still checked
  mail.add("welcome", { to: 7 });
}

/** A typed context on the default registry queue, for the checks below. */
function typed(): BunJobs<Jobs> {
  return new BunJobs<Jobs>({ namespace: "typed", driver: new MemoryDriver() });
}

export async function requiredDataChecks(): Promise<void> {
  const jobs = typed();
  const registry = jobs.queue("jobs");

  /* --- r1: now() requires a payload unless leaving it out is valid --- */

  // @ts-expect-error send-report's payload is required
  jobs.now("send-report");

  // @ts-expect-error nor may it be passed as undefined to reach the options
  jobs.now("resize-image", undefined, { priority: 1 });

  // A job declared with no payload needs none, with or without options.
  const _reindex = await jobs.now("reindex");
  type ReindexNow = Equal<typeof _reindex, TypedJob<Jobs, "reindex">>;
  type _ReindexNow = Expect<ReindexNow>;
  await jobs.now("reindex", undefined, { priority: 1 });
  await jobs.now("send-report", { month: "2026-08" }, { priority: 1 });

  // The builders and drafts keep `data?`, because `withData` fills it later.
  await jobs.schedule("send-report").withData({ month: "x" }).start();
  await jobs
    .run("send-report")
    .in("5 minutes")
    .withData({ month: "x" })
    .start();
  await jobs.create("send-report").withData({ month: "x" }).save();

  /* --- r2: the registry queue's add, the same rule -------------------- */

  const _added = await registry.add("reindex");
  type ReindexAdd = Equal<typeof _added, TypedJob<Jobs, "reindex">>;
  type _ReindexAdd = Expect<ReindexAdd>;
  await registry.add("reindex", undefined, { priority: 2 });

  // @ts-expect-error send-report's payload is required here too
  registry.add("send-report");
}

export async function registryQueueChecks(): Promise<void> {
  const jobs = typed();

  /* --- r3: only the declared registry queue is typed by the map ------ */

  const _mail = jobs.queue("mail");
  type MailPlain = Equal<typeof _mail, BunQueue<unknown, unknown, string>>;
  type _MailPlain = Expect<MailPlain>;

  const dynamicName: string = "jobs";
  const _dynamic = jobs.queue(dynamicName);
  type DynamicPlain = Equal<
    typeof _dynamic,
    BunQueue<unknown, unknown, string>
  >;
  type _DynamicPlain = Expect<DynamicPlain>;

  // @ts-expect-error a plain queue's reads are not discriminated by name
  const _notTyped: TypedJob<Jobs> | null = await _mail.getJob("id");

  // A registry queue named something else: declared, and then passed.
  const work = new BunJobs<Jobs, "work">({
    namespace: "typed",
    driver: new MemoryDriver(),
    registryQueue: "work",
  });

  const _workQueue = work.queue("work");
  type WorkTyped = Equal<typeof _workQueue, RegistryQueue<Jobs>>;
  type _WorkTyped = Expect<WorkTyped>;

  const _jobsQueue = work.queue("jobs");
  type JobsPlain = Equal<typeof _jobsQueue, BunQueue<unknown, unknown, string>>;
  type _JobsPlain = Expect<JobsPlain>;

  const driver = new MemoryDriver();

  // @ts-expect-error a declared registry queue has to be passed as well
  void new BunJobs<Jobs, "work">({ namespace: "t", driver });

  const elsewhere = { namespace: "t", driver, registryQueue: "x" as const };

  // @ts-expect-error and has to be the name that was declared
  void new BunJobs<Jobs, "work">(elsewhere);

  // @ts-expect-error a typed context cannot move its queue without saying so
  void new BunJobs<Jobs>({ namespace: "t", driver, registryQueue: "work" });

  // Inference from `new BunJobs<Jobs>` still works, with and without the
  // default name spelled out.
  const _default = new BunJobs<Jobs>({ namespace: "t", registryQueue: "jobs" });
  type DefaultTyped = Equal<typeof _default, BunJobs<Jobs, "jobs">>;
  type _DefaultTyped = Expect<DefaultTyped>;

  // jobsFromContext carries the same tie.
  const context = { namespace: "t", driver };
  const _fromContext = jobsFromContext<Jobs, "work">(context, {
    registryQueue: "work",
  });
  type ContextTyped = Equal<typeof _fromContext, BunJobs<Jobs, "work">>;
  type _ContextTyped = Expect<ContextTyped>;

  // @ts-expect-error the options must carry the declared queue
  jobsFromContext<Jobs, "work">(context);

  /* --- r4: the escape hatch refuses declared names -------------------- */

  const registry = jobs.queue("jobs");
  interface Note {
    note: string;
  }

  // @ts-expect-error a declared name cannot take another payload through it
  registry.add<"send-report", Note>("send-report", { note: "x" });

  // @ts-expect-error nor can a plain string, which could be a declared name
  registry.add<string, Note>("send-report", { note: "x" });

  // @ts-expect-error the payload type is required, not left to default
  registry.add<"audit">("audit", { note: "x" });

  // @ts-expect-error and the payload it names is checked
  registry.add<"audit", Note>("audit", { note: 1 });

  const _audit = await registry.add<"audit", Note, number>("audit", {
    note: "x",
  });
  type AuditTyped = Equal<typeof _audit, Job<Note, number>>;
  type _AuditTyped = Expect<AuditTyped>;

  // A void ad-hoc payload may be left out, as a declared one may.
  await registry.add<"ping", void>("ping");
}

export async function unionNameChecks(): Promise<void> {
  const jobs = typed();
  const registry = jobs.queue("jobs");

  /* --- r6: a union name takes a payload valid for every member ------- */

  const same = "notify-email" as "notify-email" | "notify-sms";
  const mixed = "reindex" as "send-report" | "reindex";
  const shapes = "resize-image" as "send-report" | "resize-image";

  // Same shape: that shape, and the result is the union of theirs.
  const _notified = await jobs.now(same, { userId: "u1" });
  type SameUnion = Equal<typeof _notified, TypedJob<Jobs, typeof same>>;
  type _SameUnion = Expect<SameUnion>;
  await registry.add(same, { userId: "u1" });

  type SameData = Equal<JobDataOf<Jobs, typeof same>, { userId: string }>;
  type _SameData = Expect<SameData>;

  // Two names whose payloads are the same union: each accepts the other's
  // values, though the type is spelled as each name's union in turn.
  type BoxedPair = JobDataOf<Jobs, "toggle" | "toggle-again">;
  type BoxedSame = Mutual<BoxedPair, { on: true } | { off: true }>;
  type _BoxedSame = Expect<BoxedSame>;

  // Shapes that differ still intersect, so the pair accepts nothing either
  // name alone would refuse.
  type MixedData = Equal<
    JobDataOf<Jobs, "send-report" | "reindex">,
    { month: string } & void
  >;
  type _MixedData = Expect<MixedData>;

  // @ts-expect-error send-report's payload is not a valid reindex payload
  jobs.now(mixed, { month: "x" });

  // @ts-expect-error nor is leaving it out valid for send-report
  jobs.now(mixed);

  // @ts-expect-error the registry queue's add refuses it as well
  registry.add(mixed, { month: "x" });

  // @ts-expect-error one shape is not enough when the other differs
  jobs.now(shapes, { month: "x" });

  // @ts-expect-error schedule and create use the same payload rule
  jobs.create(mixed, { month: "x" });

  // A payload that is itself a union stays that union for its one name.
  type ToggleData = JobDataOf<Jobs, "toggle">;
  type ToggleUnion = Equal<ToggleData, { on: true } | { off: true }>;
  type _ToggleUnion = Expect<ToggleUnion>;
  await jobs.now("toggle", { off: true });

  // A result read back for a union name is the union of their results.
  type Results2 = JobResultOf<Jobs, "send-report" | "notify-email">;
  type ResultUnion = Equal<Results2, string | boolean>;
  type _ResultUnion = Expect<ResultUnion>;
}

export async function readChecks(): Promise<void> {
  const jobs = typed();
  const registry = jobs.queue("jobs");

  /* --- r7: reads are discriminated by name ---------------------------- */

  const got = await registry.getJob("id");
  if (got?.name === "send-report") {
    type GotData = Equal<typeof got.data, { month: string }>;
    type _GotData = Expect<GotData>;
    type GotResult = Equal<typeof got.returnValue, string | null>;
    type _GotResult = Expect<GotResult>;
  }

  if (got) {
    // @ts-expect-error unnarrowed, the payload could be any declared one
    const _month: string = got.data.month;
  }

  const _listed = await registry.list("waiting");
  type Listed = Equal<(typeof _listed)[number], TypedJob<Jobs>>;
  type _Listed = Expect<Listed>;

  const _paged = await registry.page("waiting");
  type Paged = Equal<(typeof _paged.jobs)[number], TypedJob<Jobs>>;
  type _Paged = Expect<Paged>;

  const _many = await registry.getJobs(["a", "b"]);
  type Many = Equal<(typeof _many)[number], TypedJob<Jobs> | null>;
  type _Many = Expect<Many>;

  // @ts-expect-error a name the map does not declare cannot be compared
  if (got?.name === "nope") void got;

  /* --- handlers ------------------------------------------------------- */

  jobs.define("send-report", async (job) => {
    type HandlerName = Equal<typeof job.name, "send-report">;
    type _HandlerName = Expect<HandlerName>;
    return job.data.month;
  });

  /* --- events --------------------------------------------------------- */

  registry.on("completed", (job) => {
    if (job.name === "resize-image") {
      type EventData = Equal<typeof job.data, { id: string; width: number }>;
      type _EventData = Expect<EventData>;
    }
  });

  registry.on("completed:send-report", (job, _result) => {
    type ScopedJob = Equal<typeof job, TypedJob<Jobs, "send-report">>;
    type _ScopedJob = Expect<ScopedJob>;
    type ScopedResult = Equal<typeof _result, string>;
    type _ScopedResult = Expect<ScopedResult>;
  });

  // @ts-expect-error send-report's scoped result is a string
  registry.on("completed:send-report", (_job, _result: number) => {});

  // @ts-expect-error scoped events exist only for declared names
  registry.on("completed:nope", () => {});

  /* --- start(): the registry worker, typed over the map --------------- */

  const worker = await jobs.start();
  type WorkerTyped = Equal<typeof worker, RegistryWorker<Jobs>>;
  type _WorkerTyped = Expect<WorkerTyped>;

  worker.on("completed:send-report", (job, _result) => {
    type WorkerScoped = Equal<typeof _result, string>;
    type _WorkerScoped = Expect<WorkerScoped>;
    type WorkerJob = Equal<typeof job.data, { month: string }>;
    type _WorkerJob = Expect<WorkerJob>;
  });

  // @ts-expect-error the worker's scoped result is a string too
  worker.on("completed:send-report", (_job, _result: number) => {});

  /* --- definitions() -------------------------------------------------- */

  for (const definition of jobs.definitions()) {
    if (definition.name === "send-report") {
      type Handler = typeof definition.handler;
      type DefHandler = Equal<Handler, TypedJobProcessor<Jobs, "send-report">>;
      type _DefHandler = Expect<DefHandler>;
    }

    // @ts-expect-error a name the map does not declare is never _listed
    if (definition.name === "nope") void definition;
  }

  /* --- JobMapResult ----------------------------------------------------- */

  // Collapses to `unknown` when any entry leaves `result` out — which is the
  // truth, and why reads narrow per name instead of relying on it.
  type Collapsed = Equal<JobMapResult<Jobs>, unknown>;
  type _Collapsed = Expect<Collapsed>;

  // Every entry naming its result: the union, intact.
  type Full = Equal<JobMapResult<Results>, number | string>;
  type _Full = Expect<Full>;
}

/** A map whose every name carries the same shape, so `update` can write it. */
interface Uniform {
  /** One name. */
  first: { data: { id: string } };
  /** Another, with the same payload. */
  second: { data: { id: string } };
}

/** Object payloads that differ, so `update` needs a payload with both. */
interface Shapes {
  /** One field. */
  first: { data: { id: string } };
  /** Another. */
  second: { data: { width: number } };
}

/** The same, with a payload-less name beside them. */
interface ShapesAndVoid extends Shapes {
  /** No payload. */
  third: { data: void };
}

export async function updateDisplayChecks(): Promise<void> {
  /* --- update's payload reads flattened where that is exact ----------- */

  // Object payloads that differ flatten into one object with every field.
  type ShapesData = UpdateDataOf<unknown, Shapes>;
  type ShapesFlat = Equal<ShapesData, { id: string; width: number }>;
  type _ShapesFlat = Expect<ShapesFlat>;

  const shapes = new BunJobs<Shapes>({ namespace: "s" }).queue("jobs");
  await shapes.update("id", { data: { id: "x", width: 1 } });

  // @ts-expect-error one name's payload alone may be the other name's job
  shapes.update("id", { data: { id: "x" } });

  // `void` cannot be flattened into an object without dropping it, so it
  // stays beside the flattened object half.
  type VoidData = UpdateDataOf<unknown, ShapesAndVoid>;
  type VoidKept = Equal<VoidData, { id: string; width: number } & void>;
  type _VoidKept = Expect<VoidKept>;

  const withVoid = new BunJobs<ShapesAndVoid>({ namespace: "s" }).queue("jobs");

  // @ts-expect-error no object is also void
  withVoid.update("id", { data: { id: "x", width: 1 } });
}

export async function correlatedVerbChecks(): Promise<void> {
  const jobs = typed();
  const registry = jobs.queue("jobs");
  const mixed = "reindex" as "send-report" | "reindex";
  const same = "notify-email" as "notify-email" | "notify-sms";

  /* --- addBulk: each entry's payload follows its own name ------------- */

  const _bulk = await registry.addBulk([
    { name: "send-report", data: { month: "2026-08" } },
    { name: "reindex" },
    { name: "notify-sms", data: { userId: "u1" }, opts: { priority: 1 } },
  ]);
  // An array literal answers with a tuple, each job typed by its own entry.
  type BulkTyped = Equal<
    typeof _bulk,
    [
      TypedJob<Jobs, "send-report">,
      TypedJob<Jobs, "reindex">,
      TypedJob<Jobs, "notify-sms">,
    ]
  >;
  type _BulkTyped = Expect<BulkTyped>;

  // @ts-expect-error excess properties are still caught per entry
  registry.addBulk([{ name: "reindex", extra: 1 }]);

  // @ts-expect-error reindex carries no month
  registry.addBulk([{ name: "reindex", data: { month: "x" } }]);

  // @ts-expect-error send-report's payload is required in bulk too
  registry.addBulk([{ name: "send-report" }]);

  // @ts-expect-error a name the map does not declare
  registry.addBulk([{ name: "nope", data: 1 }]);

  // @ts-expect-error a union name's payload must suit every member
  registry.addBulk([{ name: mixed, data: { month: "x" } }]);

  // A union name whose members share a shape takes that shape.
  await registry.addBulk([{ name: same, data: { userId: "u1" } }]);

  // @ts-expect-error and still checks it
  registry.addBulk([{ name: same, data: { userId: 1 } }]);

  // @ts-expect-error each entry is checked on its own, not against the first
  registry.addBulk([{ name: "reindex" }, { name: "send-report" }]);

  // An entry's type, spelled out, discriminates the same way.
  // (Asserted, not annotated: an annotation would narrow it to reindex's.)
  const entry = { name: "reindex" } as RegistryBulkEntry<Jobs>;
  const _fromEntry = await registry.addBulk([entry]);
  type FromEntry = Equal<typeof _fromEntry, [TypedJob<Jobs>]>;
  type _FromEntry = Expect<FromEntry>;

  // Narrowed to some names, it answers with a job of those names.
  const _some = await registry.addBulk([
    entry as RegistryBulkEntry<Jobs, "reindex" | "send-report">,
  ]);
  type Some = Equal<typeof _some, [TypedJob<Jobs, "reindex" | "send-report">]>;
  type _Some = Expect<Some>;

  // An array built elsewhere answers with an array of every declared name.
  const entries: RegistryBulkEntry<Jobs>[] = [entry];
  const _fromArray = await registry.addBulk(entries);
  type FromArray = Equal<typeof _fromArray, TypedJob<Jobs>[]>;
  type _FromArray = Expect<FromArray>;

  /* --- addFlow: the top and every node inheriting the registry queue -- */

  const _flow = await registry.addFlow({
    name: "send-report",
    data: { month: "2026-08" },
    children: [
      { name: "reindex" },
      { name: "resize-image", data: { id: "a", width: 1 } },
      // Another queue: the map does not describe it, so it is unchecked.
      { name: "anything", data: { free: 1 }, queue: "mail" },
    ],
  });
  type FlowTop = Equal<typeof _flow.job, TypedJob<Jobs, "send-report">>;
  type _FlowTop = Expect<FlowTop>;

  // A top node built elsewhere answers with a job of any declared name.
  const top = { name: "reindex" } as RegistryFlowNode<Jobs>;
  const _anyTop = await registry.addFlow(top);
  type AnyTop = Equal<typeof _anyTop.job, TypedJob<Jobs>>;
  type _AnyTop = Expect<AnyTop>;

  // A same-shaped union name at the top: a job of either.
  const _unionTop = await registry.addFlow({
    name: same,
    data: { userId: "u" },
  });
  type UnionTop = Equal<typeof _unionTop.job, TypedJob<Jobs, typeof same>>;
  type _UnionTop = Expect<UnionTop>;

  // @ts-expect-error the top of the flow is checked
  registry.addFlow({ name: "send-report", data: { month: 8 } });

  // @ts-expect-error and must be a declared name
  registry.addFlow({ name: "nope", data: 1 });

  const wrongChild = { name: "reindex", data: { month: "x" } } as const;

  // @ts-expect-error a child on the registry queue is checked too
  registry.addFlow({ name: "reindex", children: [wrongChild] });

  // @ts-expect-error an undeclared child needs a queue of its own
  registry.addFlow({ name: "reindex", children: [{ name: "nope", data: 1 }] });

  registry.addFlow({
    name: "reindex",
    children: [
      {
        name: "reindex",
        // @ts-expect-error a grandchild inheriting the registry queue is checked
        children: [{ name: "send-report" }],
      },
    ],
  });

  // @ts-expect-error a union-named node's payload must suit every member
  registry.addFlow({ name: mixed, data: { month: "x" } });

  // Below a node on another queue nothing is checked: it inherits that queue.
  await registry.addFlow({
    name: "reindex",
    children: [
      {
        name: "elsewhere",
        data: 1,
        queue: "mail",
        children: [{ name: "free", data: { any: "shape" } }],
      },
    ],
  });

  /* --- update: the id does not say which job, so every name must fit -- */

  const _moved = await registry.update("id", { priority: 1 });
  type UpdateTyped = Equal<typeof _moved, TypedJob<Jobs> | null>;
  type _UpdateTyped = Expect<UpdateTyped>;

  // @ts-expect-error valid for send-report, but the job might be reindex
  registry.update("id", { data: { month: "x" } });

  // @ts-expect-error nor may reindex's void stand in for send-report's month
  registry.update("id", { data: undefined as void });

  // A map whose payloads all agree can write one.
  const uniform = new BunJobs<Uniform>({ namespace: "u" }).queue("jobs");
  await uniform.update("id", { data: { id: "x" } });

  // @ts-expect-error and the shape they agree on is still checked
  uniform.update("id", { data: { id: 1 } });

  // With the job in hand, narrowing its name says which payload it takes:
  // `updateData` on the narrowed job is checked against that name's.
  const found = await registry.getJob("id");
  if (found?.name === "send-report") {
    const _updated = await found.updateData({ month: "2026-10" });
    // The answer is the job it was asked of — `this` — so it stays narrowed.
    type Updated = Equal<typeof _updated, typeof found | null>;
    type _Updated = Expect<Updated>;
    type UpdatedName = Equal<
      NonNullable<typeof _updated>["name"],
      "send-report"
    >;
    type _UpdatedName = Expect<UpdatedName>;
    type UpdatedData = Equal<
      NonNullable<typeof _updated>["data"],
      { month: string }
    >;
    type _UpdatedData = Expect<UpdatedData>;

    // @ts-expect-error still send-report's payload
    await found.updateData({ month: 10 });
  }

  // @ts-expect-error unnarrowed, it could be any declared name's job
  await found?.updateData({ month: "2026-10" });

  /* --- retryAll: filter is handed a discriminated job ----------------- */

  await registry.retryAll("dead", {
    name: "send-report",
    filter: (job) => job.name === "send-report" && job.data.month === "x",
  });

  // @ts-expect-error unnarrowed, the payload could be reindex's void
  registry.retryAll("dead", { filter: (job) => job.data.month === "x" });

  // `name` narrows the job `filter` is handed, with no check of its own.
  await registry.retryAll("dead", {
    name: "send-report",
    filter: (job) => {
      type RetryNamed = Equal<typeof job, TypedJob<Jobs, "send-report">>;
      type _RetryNamed = Expect<RetryNamed>;
      return job.data.month === "x";
    },
  });

  registry.retryAll("dead", {
    name: "reindex",
    // @ts-expect-error reindex's payload has no month
    filter: (job) => job.data.month === "x",
  });

  // A name the map does not declare — an escape-hatch job — is described by
  // nothing, so its filter is handed a plain job.
  await registry.retryAll("dead", {
    name: "audit",
    filter: (job) => {
      type RetryAdHoc = Equal<typeof job, Job<unknown, unknown>>;
      type _RetryAdHoc = Expect<RetryAdHoc>;
      return job.data !== null;
    },
  });

  // So is one given as a plain string, which could be any name at all.
  const someName: string = "send-report";
  await registry.retryAll("dead", {
    name: someName,
    filter: (_job) => {
      type RetryLoose = Equal<typeof _job, Job<unknown, unknown>>;
      type _RetryLoose = Expect<RetryLoose>;
      return true;
    },
  });

  registry.retryAll("dead", {
    name: someName,
    // @ts-expect-error a plain string does not narrow to send-report's payload
    filter: (job) => job.data.month === "x",
  });

  // Without a filter, `name` and the rest are as they always were.
  await registry.retryAll("failed", { name: "send-report", limit: 10 });
  await registry.retryAll("dead");
}

/** Results spelled with literals, which a handler's return must keep. */
interface Literal {
  /** A literal field beside a plain one. */
  email: { data: { userId: string }; result: { via: "email"; userId: string } };
  /** A field whose type is a union of literals. */
  level: { data: void; result: { level: "low" | "high" } };
  /** A literal nested inside another object. */
  nested: { data: void; result: { outer: { kind: "leaf"; depth: 1 } } };
  /** A bare literal result. */
  bare: { data: void; result: "done" };
}

export async function literalReturnChecks(): Promise<void> {
  const jobs = new BunJobs<Literal>({ namespace: "lit" });

  /* --- a handler's literal return is typed by its name's result ------- */

  jobs.define("email", (job) => ({ via: "email", userId: job.data.userId }));
  jobs.define("email", async (job) => ({
    via: "email",
    userId: job.data.userId,
  }));
  jobs.define("level", () => ({ level: "high" }));
  jobs.define("level", async () => ({ level: "low" }));
  jobs.define("nested", () => ({ outer: { kind: "leaf", depth: 1 } }));
  jobs.define("nested", async () => ({ outer: { kind: "leaf", depth: 1 } }));
  jobs.define("bare", () => "done");

  // A bare literal from an async handler widens before it is checked — as it
  // does for any `async () => "done"` typed `() => "done" | Promise<"done">`,
  // with or without this package — so it needs `as const`. Inside an object,
  // as above, it does not.
  jobs.define("bare", async () => "done" as const);

  // @ts-expect-error the literal is still checked: "sms" is not "email"
  jobs.define("email", (job) => ({ via: "sms", userId: job.data.userId }));

  // @ts-expect-error nor may a union-literal field take another value
  jobs.define("level", async () => ({ level: "medium" }));

  // @ts-expect-error and a nested literal is checked all the way down
  jobs.define("nested", () => ({ outer: { kind: "leaf", depth: 2 } }));

  /* --- a union name's handler must still suit every result ------------- */

  const typed = new BunJobs<Jobs>({ namespace: "lit" });
  const same = "notify-email" as "notify-email" | "notify-sms";
  typed.define(same, async (job) => job.data.userId.length > 0);

  const results = new BunJobs<Results>({ namespace: "lit" });
  const either = "count" as "count" | "label";

  // @ts-expect-error a number is not also a string
  results.define(either, () => 1);

  // @ts-expect-error nor a string also a number
  results.define(either, async () => "one");
}

export async function untypedVerbChecks(): Promise<void> {
  const jobs = new BunJobs({ namespace: "loose", driver: new MemoryDriver() });
  const queue = jobs.queue("anything");
  const _mail = jobs.queue<{ to: string }>("mail");

  // Each of the four verbs is exactly what it was, on a plain queue.
  interface LooseEntry {
    name: string;
    data: unknown;
    opts?: JobOptions;
  }
  type BulkIn = Equal<Parameters<typeof queue.addBulk>[0], LooseEntry[]>;
  type _BulkIn = Expect<BulkIn>;
  type BulkOut = Equal<
    Awaited<ReturnType<typeof queue.addBulk>>,
    Job<unknown, unknown>[]
  >;
  type _BulkOut = Expect<BulkOut>;

  interface MailEntry {
    name: string;
    data: { to: string };
    opts?: JobOptions;
  }
  type MailBulk = Equal<Parameters<typeof _mail.addBulk>[0], MailEntry[]>;
  type _MailBulk = Expect<MailBulk>;

  type FlowIn = Equal<Parameters<typeof queue.addFlow>[0], FlowNode<unknown>>;
  type _FlowIn = Expect<FlowIn>;
  type FlowOut = Equal<
    Awaited<ReturnType<typeof queue.addFlow>>,
    FlowResult<unknown, unknown>
  >;
  type _FlowOut = Expect<FlowOut>;

  type UpdateData = Parameters<typeof _mail.update>[1]["data"];
  type UpdateIn = Equal<UpdateData, { to: string } | undefined>;
  type _UpdateIn = Expect<UpdateIn>;
  type UpdateOut = Equal<
    Awaited<ReturnType<typeof queue.update>>,
    Job<unknown, unknown> | null
  >;
  type _UpdateOut = Expect<UpdateOut>;

  type RetryIn = Parameters<typeof _mail.retryAll>[1];
  type RetryOptions = Equal<
    RetryIn,
    RetryAllOptions<{ to: string }> | undefined
  >;
  type _RetryOptions = Expect<RetryOptions>;

  // And they still take anything an untyped queue ever took.
  await queue.addBulk([{ name: "x", data: 1 }]);
  await queue.addFlow({
    name: "x",
    data: 1,
    children: [{ name: "y", data: 2 }],
  });
  await queue.update("id", { data: { any: "shape" } });
  await queue.retryAll("dead", { filter: (job) => job.data !== null });
}

export async function backCompatChecks(): Promise<void> {
  // No type argument: every name is allowed and nothing below is new.
  const jobs = new BunJobs({
    namespace: "loose",
    driver: new MemoryDriver(),
  });

  jobs.define("anything", async (_job) => {
    type LooseData = Equal<typeof _job.data, unknown>;
    type _LooseData = Expect<LooseData>;
  });

  const _inferred = await jobs.now("anything", { a: 1 });
  type NowInferred = Equal<typeof _inferred, Job<{ a: number }, unknown>>;
  type _NowInferred = Expect<NowInferred>;

  const _drafted = jobs.create<{ month: string }, number>("anything");
  type DraftExplicit = Equal<
    typeof _drafted,
    JobDraft<{ month: string }, number>
  >;
  type _DraftExplicit = Expect<DraftExplicit>;

  const _built = jobs.run<{ month: string }>("anything", { month: "2026-08" });
  type RunExplicit = Equal<
    typeof _built,
    JobBuilder<{ month: string }, unknown>
  >;
  type _RunExplicit = Expect<RunExplicit>;

  // Their start() and save() answer with a plain Job, as they always did.
  const _builtJob = await _built.start();
  type BuiltJob = Equal<typeof _builtJob, Job<{ month: string }, unknown>>;
  type _BuiltJob = Expect<BuiltJob>;
  const _draftJob = await _drafted.save();
  type DraftSaved = Equal<typeof _draftJob, Job<{ month: string }, number>>;
  type _DraftSaved = Expect<DraftSaved>;
  type DraftJobLoose = Equal<
    typeof _drafted.job,
    Job<{ month: string }, number> | undefined
  >;
  type _DraftJobLoose = Expect<DraftJobLoose>;

  const queue = jobs.queue("anything");
  type QueueLoose = Equal<typeof queue, BunQueue<unknown, unknown, string>>;
  type _QueueLoose = Expect<QueueLoose>;

  await queue.add("whatever", { shape: "free" });

  // A queue built directly never knows a registry, typed context or not.
  const direct = new BunQueue("mail", {
    namespace: "loose",
    driver: new MemoryDriver(),
  });

  const _plain = await direct.add("whatever", { shape: "free" });
  type DirectLoose = Equal<typeof _plain, Job<unknown, unknown>>;
  type _DirectLoose = Expect<DirectLoose>;

  // @ts-expect-error the escape hatch exists only on a registry-bound queue
  direct.add<"x", { a: number }>("x", { a: 1 });

  /* --- the untyped context is exactly what it was ---------------------- */

  type LooseType = Equal<typeof jobs, BunJobs>;
  type _LooseType = Expect<LooseType>;
  type LooseDefaults = Equal<typeof jobs, BunJobs<JobMap, "jobs">>;
  type _LooseDefaults = Expect<LooseDefaults>;

  // A custom queue name changes nothing about its type, nor its queue's.
  const moved = new BunJobs({
    namespace: "loose",
    driver: new MemoryDriver(),
    registryQueue: "work",
  });
  type MovedType = Equal<typeof moved, BunJobs>;
  type _MovedType = Expect<MovedType>;
  const _movedQueue = moved.queue("work");
  type MovedQueue = Equal<
    typeof _movedQueue,
    BunQueue<unknown, unknown, string>
  >;
  type _MovedQueue = Expect<MovedQueue>;

  // Data is optional on every verb, as it always was.
  await jobs.now("anything");
  await jobs.now("anything", undefined, { priority: 1 });

  const _worker = await jobs.start();
  type LooseWorker = Equal<typeof _worker, BunQueueWorker<unknown, unknown>>;
  type _LooseWorker = Expect<LooseWorker>;

  const _definitions = jobs.definitions();
  type LooseDefs = Equal<typeof _definitions, JobDefinition<never, never>[]>;
  type _LooseDefs = Expect<LooseDefs>;

  const _read = await queue.getJob("id");
  type LooseRead = Equal<typeof _read, Job<unknown, unknown> | null>;
  type _LooseRead = Expect<LooseRead>;

  const _page = await queue.page("waiting");
  type LoosePage = Equal<(typeof _page.jobs)[number], Job<unknown, unknown>>;
  type _LoosePage = Expect<LoosePage>;

  queue.on("completed:whatever", (job, _result) => {
    type LooseEvent = Equal<typeof job, Job<unknown, unknown>>;
    type _LooseEvent = Expect<LooseEvent>;
    type LooseResult = Equal<typeof _result, unknown>;
    type _LooseResult = Expect<LooseResult>;
  });

  // The untyped jobsFromContext takes any queue name, and no options at all.
  const _loosely = jobsFromContext({
    namespace: "loose",
    driver: direct.driver,
  });
  type LooseContext = Equal<typeof _loosely, BunJobs>;
  type _LooseContext = Expect<LooseContext>;
  jobsFromContext({ namespace: "loose" }, { registryQueue: "anything" });
}
