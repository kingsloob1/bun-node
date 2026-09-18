/**
 * The typed job registry — declare a service's jobs once, as types, and let
 * the compiler check every call site.
 *
 * ```bash
 * bun 03-job-registry/typed-registry.ts
 * EXAMPLE_DRIVER=sqlite bun 03-job-registry/typed-registry.ts
 * ```
 *
 * `new BunJobs<Jobs>(...)` takes a map from each job name to what it carries
 * (`data`) and what running it answers with (`result`). From then on:
 *
 * - `define(name, handler)` — the handler is handed a job typed for that name,
 *   and must return that name's result;
 * - `now`, `schedule`/`run`/`process` (and so `.every()`), `create` — accept
 *   only declared names, check the payload, and answer with a job typed by
 *   that name: `now` with a `TypedJob` of that name, whose `name` is the
 *   literal, and a builder's `start()` or a draft's `save()` with the same
 *   `TypedJob` — the builder and the draft carry it as their third type
 *   argument. `now` requires the payload unless leaving it out is itself
 *   valid (`data: void`); the builders keep it optional, since `withData()`
 *   can supply it later;
 * - `jobs.queue("jobs")` — the registry queue, whose `add` does the same, and
 *   whose reads hand back a `TypedJob`: check `job.name` and the payload and
 *   result narrow to that name's;
 * - `start()`'s worker and `definitions()` — typed by the map too, and a
 *   scoped event such as `completed:generate-invoice` carries that name's own
 *   job and result.
 *
 * Two escape hatches keep other work possible. `jobs.queue<Payload>(name)`,
 * with a `jobs.worker` on it, is for ad-hoc work this service runs itself.
 * `queue.add<"audit", Payload>("audit", data)` — the name spelled twice, as
 * the type argument and as the value — puts a name the map does not declare on
 * the registry queue, for *another* deployment that defines it: this
 * service's own worker fails such a job with a `ConfigError`. Leave the type
 * argument off `BunJobs` and nothing changes — the last section runs the
 * untyped API exactly as before.
 *
 * `typed-registry-verbs.ts` carries on from here: `addBulk`, `addFlow`,
 * `retryAll` and `update` on the registry queue, a registry queue with a name
 * of its own, and union names.
 *
 * The checking is entirely compile-time: runtime behaviour is identical with
 * or without the map. So this file proves both halves. Each `@ts-expect-error`
 * below is a negative control — delete the directive and the examples'
 * typecheck (`bun scripts/typecheck.ts` at the repo root) fails, because that
 * line really is an error. The `check(...)` calls then assert at runtime that
 * the typed calls did what they say.
 *
 * A directive only covers the next line, so each sits on the line the error
 * is reported on — for a one-line call, the line above it.
 */
import type {
  BunQueue,
  BunQueueWorker,
  DataArgs,
  Job,
  JobBuilder,
  JobDefinition,
  JobDefinitionOf,
  JobDraft,
  JobMapData,
  JobMapResult,
  JobsPage,
  RegistryQueue,
  RegistryWorker,
  TypedJob,
  TypedJobProcessor,
} from "@kingsleyweb/bun-jobs";
import { BunJobs, ConfigError } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/** `true` only when `A` and `B` are exactly the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when given `true` — a positive compile-time assertion. */
type Expect<T extends true> = T;

/**
 * Holds calls that must *not* compile, without ever running them — a wrong
 * `define` would otherwise really replace a handler, and a wrong `now` really
 * add a job. Only the typecheck looks inside.
 */
function compileOnly(_controls: () => unknown): void {}

/** What an invoice job carries. */
interface Invoice {
  /** The customer being billed. */
  customerId: string;
  /** Amount, in cents. */
  amountCents: number;
}

/** What generating an invoice answers with. */
interface InvoicePdf {
  /** Where the rendered PDF was written. */
  pdf: string;
}

/**
 * This service's jobs: every name it defines, what each carries, and what
 * running each answers with.
 *
 * An entry is always `{ data; result? }`. `data` is required — a job with no
 * payload says `data: void` — and a left-out `result` means `unknown`. Write it
 * as an `interface` or a `type`; either satisfies the constraint, and a wrong
 * entry is reported by name (`Types of property 'x' are incompatible`).
 */
interface Jobs {
  /** A payload and a result. */
  "generate-invoice": { data: Invoice; result: InvoicePdf };
  /** A payload and a plain result. */
  "sync-crm": { data: { userId: string }; result: string };
  /** No payload at all. */
  heartbeat: { data: void; result: number };
  /** A payload, with `result` left out — so it is `unknown`. */
  "resize-image": { data: { id: string; width: number } };
}

title("Typed job registry");

const jobs = new BunJobs<Jobs>({
  namespace: exampleNamespace("typed-registry"),
  driver: exampleDriver(),
  // Kept, so the example can read results back after the worker is done.
  defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
});

/* ------------------------------------------------------------------ */
step("define: the handler's job and return type come from the map");

jobs.define(
  "generate-invoice",
  async (job, ctx) => {
    // No `<Invoice, InvoicePdf>` here: the name picked the entry. The job is
    // a TypedJob for that one name, so even `job.name` is the literal.
    type _InvoiceJob = Expect<
      Equal<typeof job, TypedJob<Jobs, "generate-invoice">>
    >;
    type _InvoiceData = Expect<Equal<typeof job.data, Invoice>>;
    type _InvoiceName = Expect<Equal<typeof job.name, "generate-invoice">>;
    await ctx.log(`billing ${job.data.customerId}`);
    await Bun.sleep(10);
    return { pdf: `invoices/${job.data.customerId}.pdf` };
  },
  { attempts: 3, backoff: { type: "exponential", delay: 200 } },
);

jobs.define("sync-crm", async (job) => `synced ${job.data.userId}`);

let beats = 0;
jobs.define("heartbeat", (_job) => {
  type _NoPayload = Expect<Equal<typeof _job.data, void>>;
  return ++beats;
});

jobs.define("resize-image", async (job) => {
  // Any return value is fine: the entry left `result` out.
  return `${job.data.id}@${job.data.width}w`;
});

compileOnly(() => {
  // @ts-expect-error "send-fax" is not a name the map declares
  jobs.define("send-fax", async () => "sent");

  // @ts-expect-error the handler must answer with the declared result string
  jobs.define("sync-crm", async () => 42);

  // @ts-expect-error job.data is { userId }, which has no `email`
  jobs.define("sync-crm", async (job) => job.data.email);
});

/* ------------------------------------------------------------------ */
step("definitions(): each one discriminated by name");

const definitions = jobs.definitions();
type _Definitions = Expect<Equal<typeof definitions, JobDefinitionOf<Jobs>[]>>;
show(
  "defined",
  definitions.map(({ name }) => name),
);

// Checking `name` narrows the rest of the definition, handler included.
let invoiceAttempts: number | undefined;
for (const definition of definitions) {
  if (definition.name === "generate-invoice") {
    type _Handler = Expect<
      Equal<
        typeof definition.handler,
        TypedJobProcessor<Jobs, "generate-invoice">
      >
    >;
    invoiceAttempts = definition.options.attempts;
  }
}
checkEqual("definitions(): four names", definitions.length, 4);
checkEqual("definitions(): the invoice's own options", invoiceAttempts, 3);

/* ------------------------------------------------------------------ */
step("start(): a worker whose events are typed by the map");

const worker = await jobs.start({ concurrency: 4, pollInterval: 50 });
type _WorkerTyped = Expect<Equal<typeof worker, RegistryWorker<Jobs>>>;

/** Completed jobs by name, and every failure, as the worker reports them. */
const completed = new Map<string, number>();
const failures: { name: string; error: Error }[] = [];
worker.on("completed", (job, _result) => {
  // The unscoped event's job is a TypedJob over every declared name. Its
  // `result` is the union of every declared result — which is `unknown` here,
  // because "resize-image" leaves `result` out and `unknown` absorbs a union.
  // Narrow `job.name` and read `job.returnValue`, or listen on a scoped event.
  type _AnyJob = Expect<Equal<typeof job, TypedJob<Jobs>>>;
  type _Collapsed = Expect<Equal<typeof _result, JobMapResult<Jobs>>>;
  type _IsUnknown = Expect<Equal<typeof _result, unknown>>;
  completed.set(job.name, (completed.get(job.name) ?? 0) + 1);
});
worker.on("failed", (job, error) => {
  failures.push({ name: job.name, error });
});

// A scoped event carries that name's own job and result, with no narrowing.
const pdfsHeard: string[] = [];
worker.on("completed:generate-invoice", (job, result) => {
  type _ScopedJob = Expect<
    Equal<typeof job, TypedJob<Jobs, "generate-invoice">>
  >;
  type _ScopedResult = Expect<Equal<typeof result, InvoicePdf>>;
  pdfsHeard.push(result.pdf);
});

compileOnly(() => {
  // @ts-expect-error "nope" is not declared, so neither is its scoped event
  worker.on("completed:nope", () => {});

  // @ts-expect-error "sync-crm" answers with a string, not a number
  worker.on("completed:sync-crm", (_job, _result: number) => {});
});

/* ------------------------------------------------------------------ */
step("now: the payload is checked, and required unless it may be left out");

const invoice = await jobs.now("generate-invoice", {
  customerId: "cus_42",
  amountCents: 12_900,
});
// A `TypedJob` of the name given: that name's payload and result, and a
// `name` that is the literal itself.
type _NowTyped = Expect<
  Equal<typeof invoice, TypedJob<Jobs, "generate-invoice">>
>;
type _NowName = Expect<Equal<typeof invoice.name, "generate-invoice">>;
type _NowData = Expect<Equal<typeof invoice.data, Invoice>>;

// The definition's defaults reached the job, exactly as on the untyped path.
checkEqual("now: payload stored as given", invoice.data, {
  customerId: "cus_42",
  amountCents: 12_900,
});
checkEqual("now: definition defaults applied", invoice.opts.attempts, 3);

// A job with `data: void` needs no payload.
const beat = await jobs.now("heartbeat");
type _BeatTyped = Expect<Equal<typeof beat, TypedJob<Jobs, "heartbeat">>>;
checkEqual("now: a payload-less job added", beat.name, "heartbeat");

// The rule behind both: the payload argument is optional exactly when
// `undefined` is itself a valid payload.
type _VoidOptional = Expect<Equal<DataArgs<void>, [data?: void]>>;
type _ShapeRequired = Expect<
  Equal<DataArgs<{ userId: string }>, [data: { userId: string }]>
>;

// @ts-expect-error "send-fax" is not declared
await checkRejects("now: undeclared name", () => jobs.now("send-fax"), {
  name: "ConfigError",
});

compileOnly(() => {
  // @ts-expect-error amountCents is a number
  jobs.now("generate-invoice", { customerId: "c", amountCents: "9" });

  // @ts-expect-error { userId } has no `email`: excess properties are caught
  jobs.now("sync-crm", { userId: "u", email: "x" });

  // @ts-expect-error the payload is required: "sync-crm" cannot run without one
  jobs.now("sync-crm");
});

/* ------------------------------------------------------------------ */
step("Results: typed wherever the job's name is known statically");

await waitFor("the first invoice", async () => {
  return (await invoice.refresh())?.state === "completed";
});

// `refresh()` keeps the Job's types, so `returnValue` is `InvoicePdf | null`.
const done = await invoice.refresh();
const pdf = done?.returnValue?.pdf;
type _ResultTyped = Expect<Equal<typeof pdf, string | undefined>>;
checkEqual(
  "result: returnValue is the declared shape",
  pdf,
  "invoices/cus_42.pdf",
);
await waitFor("the scoped completed event", () => pdfsHeard.length === 1);
checkEqual("completed:generate-invoice: heard with its own result", pdfsHeard, [
  "invoices/cus_42.pdf",
]);

/* ------------------------------------------------------------------ */
step("schedule / run / process: builders typed for the name, every() too");

// The builder carries the name's payload and result, and — as its third type
// argument — the job `start()` answers with: a TypedJob of that name.
const syncLater = jobs.run("sync-crm", { userId: "u_1" }).in("200ms");
type _RunTyped = Expect<
  Equal<
    typeof syncLater,
    JobBuilder<{ userId: string }, string, TypedJob<Jobs, "sync-crm">>
  >
>;
const syncJob = await syncLater.start();
type _RunStarted = Expect<Equal<typeof syncJob, TypedJob<Jobs, "sync-crm">>>;
type _RunName = Expect<Equal<typeof syncJob.name, "sync-crm">>;
check("run().in(): delayed", syncJob.state === "delayed", syncJob.state);

// The builders keep the payload optional, because `withData` can supply it —
// and `withData` is checked against the same entry.
await jobs
  .process("sync-crm")
  .withData({ userId: "u_2" })
  .on(new Date(Date.now() + 300))
  .start();

// `every()` repeats the declared job — here the payload-less heartbeat — and
// `start()` answers with it typed by its name, as `now` would.
const repeating = await jobs
  .schedule("heartbeat")
  .every("150ms")
  .immediately()
  .limit(3)
  .start();
checkEqual(
  "every(): the repeating job is a heartbeat",
  repeating.name,
  "heartbeat",
);
type _EveryTyped = Expect<Equal<typeof repeating, TypedJob<Jobs, "heartbeat">>>;
type _EveryResult = Expect<Equal<typeof repeating.returnValue, number | null>>;

compileOnly(() => {
  // @ts-expect-error "send-fax" is not declared
  jobs.schedule("send-fax").every("1 hour");

  // @ts-expect-error withData must match { id, width }: width is a number
  jobs.schedule("resize-image").withData({ id: "a", width: "9" });

  // @ts-expect-error run() checks the payload the same way
  jobs.run("sync-crm", { userId: 7 });

  // @ts-expect-error and so does process()
  jobs.process("resize-image", { id: "a" });
});

/* ------------------------------------------------------------------ */
step("create: a draft typed for its name, and the job it saves");

const draft = jobs
  .create("resize-image", { id: "img_1", width: 640 })
  .unique("resize-img_1-640")
  .priority(2);
// Like a builder, the draft carries the job it saves as its third type
// argument: a TypedJob of "resize-image", whose result is `unknown` because
// the entry leaves `result` out.
type _DraftTyped = Expect<
  Equal<
    typeof draft,
    JobDraft<
      { id: string; width: number },
      unknown,
      TypedJob<Jobs, "resize-image">
    >
  >
>;

const saved = await draft.save();
type _SavedTyped = Expect<Equal<typeof saved, TypedJob<Jobs, "resize-image">>>;
type _SavedName = Expect<Equal<typeof saved.name, "resize-image">>;
type _DraftJob = Expect<
  Equal<typeof draft.job, TypedJob<Jobs, "resize-image"> | undefined>
>;
checkEqual("create: saved under the unique id", saved.id, "resize-img_1-640");
checkEqual("create: payload stored", saved.data, { id: "img_1", width: 640 });

compileOnly(() => {
  // @ts-expect-error width is a number
  jobs.create("resize-image", { id: "a", width: "9" });

  // @ts-expect-error "send-fax" is not declared
  jobs.create("send-fax");

  // @ts-expect-error a draft's withData is checked too
  draft.withData({ id: 1, width: 1 });
});

/* ------------------------------------------------------------------ */
step("queue.add: the registry queue takes a declared name and its payload");

// The registry queue is `"jobs"` unless `registryQueue` says otherwise.
const registry = jobs.queue("jobs");
type _RegistryTyped = Expect<Equal<typeof registry, RegistryQueue<Jobs>>>;

// The queue's own events are typed the same way, scoped ones included.
const heardBeats: string[] = [];
registry.on("added:heartbeat", (job) => {
  type _AddedJob = Expect<Equal<typeof job, TypedJob<Jobs, "heartbeat">>>;
  heardBeats.push(job.id);
});

const added = await registry.add("sync-crm", { userId: "u_3" });
type _AddTyped = Expect<Equal<typeof added, TypedJob<Jobs, "sync-crm">>>;
type _AddData = Expect<Equal<typeof added.data, { userId: string }>>;
checkEqual("queue.add: payload stored", added.data, { userId: "u_3" });

// A payload-less entry needs no payload here either.
const quietBeat = await registry.add("heartbeat");
type _QuietTyped = Expect<Equal<typeof quietBeat, TypedJob<Jobs, "heartbeat">>>;
check(
  "added:heartbeat: heard with the job it added",
  heardBeats.includes(quietBeat.id),
  heardBeats,
);

compileOnly(() => {
  // @ts-expect-error "send-fax" is not declared
  registry.add("send-fax", { to: "+1 555 0100" });

  // @ts-expect-error userId is a string
  registry.add("sync-crm", { userId: 3 });

  // @ts-expect-error the payload is required, as on now()
  registry.add("sync-crm");

  // @ts-expect-error an undeclared name without type arguments is refused
  registry.add("scratch", { note: "one off" });

  // @ts-expect-error "added:nope" is no more an event than "completed:nope"
  registry.on("added:nope", () => {});
});

/* ------------------------------------------------------------------ */
step("Reads: a TypedJob, discriminated by name");

// A read cannot know the name statically, so it answers with a TypedJob: a
// union with one member per declared name, keyed on the literal `name`.
const read = await registry.getJob(added.id);
type _ReadTyped = Expect<Equal<typeof read, TypedJob<Jobs> | null>>;

// Checking the name narrows the payload and the result to that name's.
let readUser: string | undefined;
if (read?.name === "sync-crm") {
  type _Narrowed = Expect<Equal<typeof read.data, { userId: string }>>;
  type _NarrowedResult = Expect<Equal<typeof read.returnValue, string | null>>;
  readUser = read.data.userId;
}
checkEqual("getJob: narrowed by name", readUser, "u_3");

compileOnly(() => {
  // @ts-expect-error not narrowed yet: only some declared names carry userId
  return read?.data.userId;
});

/** One line per job, by name — `switch` narrows each case, and is exhaustive. */
function describe(job: TypedJob<Jobs>): string {
  switch (job.name) {
    case "generate-invoice":
      return `invoice for ${job.data.customerId} -> ${job.returnValue?.pdf}`;
    case "sync-crm":
      return `crm sync for ${job.data.userId}`;
    case "heartbeat":
      return `heartbeat #${job.returnValue}`;
    case "resize-image":
      return `resize ${job.data.id} to ${job.data.width}px`;
    default: {
      // Every declared name is handled, so nothing is left.
      const rest: never = job;
      return String(rest);
    }
  }
}

await waitFor("the queue.add jobs", async () => {
  const back = await registry.getJobs([added.id, quietBeat.id]);
  return back.every((job) => job?.state === "completed");
});

// list, page and getJobs answer with the same TypedJob.
const listed = await registry.list("completed");
type _ListTyped = Expect<Equal<typeof listed, TypedJob<Jobs>[]>>;

const paged = await registry.page("completed", { limit: 50 });
type _PageTyped = Expect<
  Equal<
    typeof paged,
    JobsPage<JobMapData<Jobs>, JobMapResult<Jobs>, TypedJob<Jobs>>
  >
>;
type _PageJob = Expect<Equal<(typeof paged.jobs)[number], TypedJob<Jobs>>>;
checkEqual(
  "page: the same completed jobs as list",
  paged.jobs.map(({ id }) => id).sort(),
  listed.map(({ id }) => id).sort(),
);

const fetched = await registry.getJobs([invoice.id, "no-such-id"]);
type _GetJobsTyped = Expect<Equal<typeof fetched, (TypedJob<Jobs> | null)[]>>;
checkEqual("getJobs: a null for the missing id", fetched[1], null);

show("completed so far", listed.map(describe));
check(
  "describe(): narrowed the invoice to its result",
  listed.some((job) => describe(job) === `invoice for cus_42 -> ${pdf}`),
);

/* ------------------------------------------------------------------ */
step("Escape hatch 1: queue.add<Name, Payload>() for another deployment");

// Naming both the name and the payload type is what unlocks an undeclared
// name. The job is real, and it lands on the registry queue — for a
// deployment that defines "audit". This service's registry worker claims
// every job on that queue, and fails this one with a ConfigError.
const audit = await registry.add<"audit", { note: string }>(
  "audit",
  { note: "one off" },
  { attempts: 1 },
);
type _AuditTyped = Expect<Equal<typeof audit, Job<{ note: string }, unknown>>>;
checkEqual("add<Name, Payload>: stored under its name", audit.name, "audit");

compileOnly(() => {
  // @ts-expect-error a declared name is refused: its payload is already known
  registry.add<"sync-crm", { userId: number }>("sync-crm", { userId: 1 });

  const runtimeName: string = "audit";
  // @ts-expect-error a plain string is refused: it could be a declared name
  registry.add<string, { note: string }>(runtimeName, { note: "x" });

  // @ts-expect-error the payload type is required too, not only the name
  registry.add<"audit">("audit", { note: "x" });

  // @ts-expect-error the named payload is checked: note is a string
  registry.add<"audit", { note: string }>("audit", { note: 1 });
});

await waitFor("the audit job to fail", () => {
  return failures.some(({ name }) => name === "audit");
});
const auditError = failures.find(({ name }) => name === "audit")?.error;
check(
  "add<Name, Payload>: this service's worker fails it with a ConfigError",
  auditError instanceof ConfigError,
  auditError,
);
checkEqual(
  "add<Name, Payload>: the error names the job",
  auditError?.message,
  'No job is defined for "audit"',
);

// Reads assume the map describes everything on the registry queue, and the
// audit job is the exception: its TypedJob type claims a declared name. The
// untyped view of the same queue says what it really is.
const rawRegistry = jobs.queue<unknown>("jobs");
type _RawView = Expect<
  Equal<typeof rawRegistry, BunQueue<unknown, unknown, string>>
>;
check(
  'queue<unknown>("jobs"): the same instance, untyped',
  (rawRegistry as unknown) === (registry as unknown),
);
const auditBack = await rawRegistry.getJob(audit.id);
checkEqual("untyped view: the audit job's name", auditBack?.name, "audit");
check(
  "untyped view: the audit job did not complete",
  auditBack?.state === "failed" || auditBack?.state === "dead",
  auditBack?.state,
);

/* ------------------------------------------------------------------ */
step("Escape hatch 2: jobs.queue<Payload>() for ad-hoc work run here");

/** What the mail queue carries — nothing the registry knows about. */
interface Mail {
  /** Recipient address. */
  to: string;
  /** Subject line. */
  subject: string;
}

const mail = jobs.queue<Mail, string>("mail");
type _MailTyped = Expect<Equal<typeof mail, BunQueue<Mail, string, string>>>;

// Only the registry queue is typed by the map: any other name — or a string
// only known at runtime — is a plain queue, as on an untyped context.
const _other = jobs.queue("mail");
type _OtherPlain = Expect<
  Equal<typeof _other, BunQueue<unknown, unknown, string>>
>;
const dynamicName: string = "jobs";
const _dynamic = jobs.queue(dynamicName);
type _DynamicPlain = Expect<
  Equal<typeof _dynamic, BunQueue<unknown, unknown, string>>
>;

const sent: string[] = [];
const mailWorker = jobs.worker<Mail, string>(
  "mail",
  async (job) => {
    sent.push(job.data.to);
    return `sent to ${job.data.to}`;
  },
  { pollInterval: 50 },
);
// A worker from `jobs.worker()` consumes once it is run; `close()` stops it.
void mailWorker.run();

await mail.add("welcome", { to: "ops@example.com", subject: "hi" });

compileOnly(() => {
  // @ts-expect-error the named payload is still checked: subject is missing
  mail.add("welcome", { to: "ops@example.com" });
});

await waitFor("the mail job", () => sent.length === 1);
checkEqual("queue<Payload>: ran on its own worker", sent, ["ops@example.com"]);

/* ------------------------------------------------------------------ */
step("The runtime guard is still there for JavaScript callers");

// The types make an undefined name unreachable from TypeScript. JavaScript —
// or a cast — can still get there, and gets the same ConfigError as ever.
const asLoose = jobs as unknown as BunJobs;
await checkRejects(
  "undeclared name at runtime",
  () => asLoose.now("send-fax"),
  {
    name: "ConfigError",
  },
);

await waitFor(
  "1 invoice, 3 syncs, 5 heartbeats and 1 resize",
  () =>
    completed.get("generate-invoice") === 1 &&
    completed.get("sync-crm") === 3 &&
    completed.get("heartbeat") === 5 &&
    completed.get("resize-image") === 1,
  { timeout: 20_000 },
);
show("completed by name", Object.fromEntries(completed));
checkEqual("every(): heartbeat ran 1 + 1 + 3 times", beats, 5);

/* ------------------------------------------------------------------ */
step("Without the type argument, nothing changes");

const loose = new BunJobs({
  namespace: exampleNamespace("typed-registry-loose"),
  driver: exampleDriver(),
});

// Any name; TData / TResult from explicit type arguments, as before.
loose.define<{ a: number }, number>("anything", async (job) => job.data.a * 2);
loose.define("untyped", async (_job) => {
  type _LooseData = Expect<Equal<typeof _job.data, unknown>>;
});

// TData inferred from the payload passed in.
const inferred = await loose.now("anything", { a: 21 });
type _LooseNow = Expect<Equal<typeof inferred, Job<{ a: number }, unknown>>>;

compileOnly(() => {
  // Still optional, as it always was: no map, so nothing says it is required.
  return loose.now("anything");
});

const looseDraft = loose.create<{ a: number }, number>("anything", { a: 1 });
type _LooseDraft = Expect<
  Equal<typeof looseDraft, JobDraft<{ a: number }, number>>
>;

await looseDraft.save();

// A queue from an untyped context takes any name and any payload, and reads
// back a plain Job.
const looseQueue = loose.queue("jobs");
type _LooseQueue = Expect<
  Equal<typeof looseQueue, BunQueue<unknown, unknown, string>>
>;
await looseQueue.add("anything", { a: 4 });
const _looseRead = await looseQueue.getJob(inferred.id);
type _LooseRead = Expect<
  Equal<typeof _looseRead, Job<unknown, unknown> | null>
>;

// definitions() and start() keep their old types.
const _looseDefinitions = loose.definitions();
type _LooseDefinitions = Expect<
  Equal<typeof _looseDefinitions, JobDefinition<never, never>[]>
>;

const looseWorker = await loose.start({ pollInterval: 50 });
type _LooseWorker = Expect<
  Equal<typeof looseWorker, BunQueueWorker<unknown, unknown>>
>;
let looseDone = 0;
looseWorker.on("completed", (job, _result) => {
  type _LooseEventJob = Expect<Equal<typeof job, Job<unknown, unknown>>>;
  type _LooseEventResult = Expect<Equal<typeof _result, unknown>>;
  looseDone++;
});
await waitFor("all three untyped jobs", () => looseDone === 3);
checkEqual(
  "untyped: result read back",
  (await inferred.refresh())?.returnValue,
  42,
);

// And an undefined name is still a runtime ConfigError, never a type error.
await checkRejects("untyped: undefined name", () => loose.now("nope"), {
  name: "ConfigError",
});

/* ------------------------------------------------------------------ */
// Only the two namespaces this run created are purged.
await jobs.purge();
await loose.purge();
await Promise.all([jobs.close(), loose.close()]);
summary();
