/**
 * The typed job registry, continued — the registry queue's other verbs, a
 * registry queue with a name of its own, and union names.
 *
 * ```bash
 * bun 03-job-registry/typed-registry-verbs.ts
 * EXAMPLE_DRIVER=sqlite bun 03-job-registry/typed-registry-verbs.ts
 * ```
 *
 * `typed-registry.ts` covers `define`, `now`, the builders, `add` and reads.
 * On the registry queue the map also checks:
 *
 * - `addBulk(entries)` — each entry is discriminated by its name, so its
 *   payload is checked against that name's. An array literal answers with a
 *   tuple, each job a `TypedJob` of its own entry's name; an array built
 *   elsewhere answers with `TypedJob<Jobs>[]`. There is no ad-hoc escape
 *   hatch here: a bulk entry must be a declared name.
 * - `addFlow(node)` — the top node, and every descendant that leaves `queue`
 *   out and so stays on the registry queue. A child that names a `queue` is
 *   unchecked, as on an untyped queue, and so are its children. `queue` on the
 *   top node is an error: it was always ignored at runtime. `flow.job` is a
 *   `TypedJob` of the top node's name.
 * - `retryAll(state, { name, filter })` — `name` narrows the job `filter` is
 *   handed. A name the map does not declare, or a plain `string`, hands it a
 *   `Job<unknown, unknown>`.
 * - `update(id, { data })` — the id does not say which name the job has, so
 *   `data` must suit *every* declared payload. When they differ that accepts
 *   nothing. With the job in hand, narrow its name and call `updateData`,
 *   which is checked against that name's payload; with only an id, or for the
 *   other fields together, `jobs.queue<unknown>("jobs").update(...)`, after
 *   checking the job's name yourself.
 *
 * A handler is typed by its name's `result`, literals included, so
 * `() => ({ via: "email" })` satisfies `result: { via: "email" }` with no
 * annotation. A registry queue other than `"jobs"` is declared as
 * `BunJobs`'s second type argument and passed as the `registryQueue` option
 * too, and the two must agree. A union of names takes a payload valid for
 * every name in it — the intersection — and answers with a `TypedJob` of
 * either name.
 *
 * With no map, all four verbs keep exactly the types they always had; the
 * last section checks that. As in `typed-registry.ts`, every
 * `@ts-expect-error` is a live negative control inside a never-invoked
 * `compileOnly`, and the `check(...)` calls assert the runtime half.
 */
import type {
  BunQueue,
  FlowNode,
  FlowResult,
  Job,
  JobDataOf,
  JobOptions,
  JobResultOf,
  RegistryBulkEntry,
  RegistryFlowNode,
  RegistryQueue,
  TypedJob,
  UpdateDataOf,
} from "@kingsleyweb/bun-jobs";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/** `true` only when `A` and `B` are exactly the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when given `true` — a positive compile-time assertion. */
type Expect<T extends true> = T;

/** `true` when each of `A` and `B` is assignable to the other. */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Holds calls that must *not* compile, without ever running them. Only the
 * typecheck looks inside.
 */
function compileOnly(_controls: () => unknown): void {}

/** What a notification answers with: which channel sent it, and to whom. */
interface Sent<TVia extends string> {
  /** The channel. */
  via: TVia;
  /** The user notified. */
  userId: string;
}

/**
 * This service's jobs. Every entry declares a `result`, so the union of them
 * is a real union rather than `unknown` (compare `typed-registry.ts`).
 */
interface Jobs {
  /** A monthly report. */
  "send-report": { data: { month: string }; result: string };
  /** No payload. */
  reindex: { data: void; result: number };
  /** Two names that carry the same shape, with different results. */
  "notify-email": { data: { userId: string }; result: Sent<"email"> };
  /** See "notify-email". */
  "notify-sms": { data: { userId: string }; result: Sent<"sms"> };
  /** A result that is a bare literal. */
  "warm-cache": { data: void; result: "warm" };
}

title("Typed job registry: the other verbs");

const jobs = new BunJobs<Jobs>({
  namespace: exampleNamespace("typed-verbs"),
  driver: exampleDriver(),
  defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
});

/** Months whose report fails, until the example "fixes" one. */
const brokenMonths = new Set(["2026-01", "2026-02"]);
let reindexes = 0;

jobs.define(
  "send-report",
  async (job) => {
    if (brokenMonths.has(job.data.month)) {
      throw new Error(`no ledger for ${job.data.month}`);
    }
    return `report ${job.data.month}`;
  },
  { attempts: 1 },
);
jobs.define("reindex", () => ++reindexes);
// No return annotation: the handler is typed by the name's result, so the
// literal "email" stays "email", sync or async, nested in an object or not.
jobs.define("notify-email", (job) => {
  return { via: "email", userId: job.data.userId };
});
jobs.define("notify-sms", async (job) => {
  return { via: "sms", userId: job.data.userId };
});
// The one exception is plain TypeScript, not the registry: a bare literal
// returned from an `async` function widens to `string` before it is checked
// against "warm", as it would against any function type. `as const` keeps it.
// (A sync `() => "warm"` needs nothing.)
jobs.define("warm-cache", async () => "warm" as const);

compileOnly(() => {
  // @ts-expect-error a wrong literal is refused: "notify-sms" answers via "sms"
  jobs.define("notify-sms", (job) => ({
    via: "email",
    userId: job.data.userId,
  }));

  // A sync bare literal is typed from the map as it is.
  jobs.define("warm-cache", () => "warm");

  // @ts-expect-error the exception: without `as const`, "warm" became string
  jobs.define("warm-cache", async () => "warm");
});

await jobs.start({ concurrency: 4, pollInterval: 50 });
const registry = jobs.queue("jobs");
type _Registry = Expect<Equal<typeof registry, RegistryQueue<Jobs>>>;

/** Waits until every job given has reached one of the states. */
async function settle(ids: string[], states: string[]): Promise<void> {
  await waitFor(`${ids.length} job(s) to settle`, async () => {
    const back = await registry.getJobs(ids);
    return back.every((job) => job !== null && states.includes(job.state));
  });
}

/* ------------------------------------------------------------------ */
step("addBulk: each entry checked against its own name");

const bulk = await registry.addBulk([
  { name: "send-report", data: { month: "2026-01" } },
  { name: "send-report", data: { month: "2026-02" } },
  { name: "send-report", data: { month: "2026-03" } },
  // A payload-less entry may leave `data` out.
  { name: "reindex" },
  { name: "notify-email", data: { userId: "u_1" }, opts: { priority: 1 } },
]);
// An array literal answers with a tuple: each job typed by its own entry's
// name, in order.
type _BulkResult = Expect<
  Equal<
    typeof bulk,
    [
      TypedJob<Jobs, "send-report">,
      TypedJob<Jobs, "send-report">,
      TypedJob<Jobs, "send-report">,
      TypedJob<Jobs, "reindex">,
      TypedJob<Jobs, "notify-email">,
    ]
  >
>;
// So a destructured entry needs no narrowing to read its payload.
const [firstReport, , , , firstEmail] = bulk;
type _FirstMonth = Expect<Equal<typeof firstReport.data.month, string>>;
checkEqual(
  "addBulk: the tuple's first report",
  firstReport.data.month,
  "2026-01",
);
checkEqual("addBulk: the tuple's email", firstEmail.data.userId, "u_1");

// An array built elsewhere — its names are not known statically — answers
// with a TypedJob over every declared name, to narrow as usual.
const prebuiltEntries: RegistryBulkEntry<Jobs>[] = [{ name: "warm-cache" }];
const prebuilt = await registry.addBulk(prebuiltEntries);
type _PrebuiltResult = Expect<Equal<typeof prebuilt, TypedJob<Jobs>[]>>;
checkEqual(
  "addBulk: a prebuilt array",
  prebuilt.map(({ name }) => name),
  ["warm-cache"],
);
await settle(
  prebuilt.map(({ id }) => id),
  ["completed"],
);
const warmed = await registry.getJob(prebuilt[0]?.id ?? "");
checkEqual("warmed: read back under its name", warmed?.name, "warm-cache");
if (warmed?.name === "warm-cache") {
  type _WarmResult = Expect<Equal<typeof warmed.returnValue, "warm" | null>>;
  checkEqual("warm-cache: the literal result", warmed.returnValue, "warm");
}

checkEqual(
  "addBulk: names stored in order",
  bulk.map(({ name }) => name),
  ["send-report", "send-report", "send-report", "reindex", "notify-email"],
);
checkEqual("addBulk: payloads stored", bulk[4].data, { userId: "u_1" });

compileOnly(() => {
  // @ts-expect-error "reindex" carries nothing, so not a month
  registry.addBulk([{ name: "reindex", data: { month: "2026-01" } }]);

  // @ts-expect-error "send-report" needs its payload
  registry.addBulk([{ name: "send-report" }]);

  // @ts-expect-error month is a string
  registry.addBulk([{ name: "send-report", data: { month: 1 } }]);

  // @ts-expect-error one wrong entry among right ones is still caught
  registry.addBulk([{ name: "reindex" }, { name: "notify-sms", data: {} }]);

  // @ts-expect-error no escape hatch: an undeclared name is refused in bulk
  registry.addBulk([{ name: "audit", data: { note: "x" } }]);
});

await settle(
  bulk.map(({ id }) => id),
  ["completed", "dead", "failed"],
);
const [january, february, march] = await registry.getJobs(
  bulk.slice(0, 3).map(({ id }) => id),
);
show("reports", [january?.state, february?.state, march?.state]);
checkEqual("addBulk: the unbroken month completed", march?.state, "completed");
check(
  "addBulk: the two broken months failed for good",
  january?.state === "dead" && february?.state === "dead",
  [january?.state, february?.state],
);

/* ------------------------------------------------------------------ */
step("retryAll: `name` narrows the job `filter` is handed");

// The ledger for January turns up. Only that report is re-driven: the filter
// reads `job.data.month`, which it can because `name` said "send-report".
brokenMonths.delete("2026-01");
const retried = await registry.retryAll("dead", {
  name: "send-report",
  filter: (job) => {
    type _Narrowed = Expect<Equal<typeof job, TypedJob<Jobs, "send-report">>>;
    return job.data.month === "2026-01";
  },
});
checkEqual("retryAll: only January re-driven", retried, [january?.id]);

// Without `name`, filter is handed a TypedJob over every declared name, to
// narrow itself.
const retriedNone = await registry.retryAll("dead", {
  filter: (job) => {
    type _Any = Expect<Equal<typeof job, TypedJob<Jobs>>>;
    return job.name === "reindex";
  },
});
checkEqual("retryAll: no dead reindex to re-drive", retriedNone, []);

// A name the map does not declare describes nothing, so filter gets a plain
// `Job<unknown, unknown>` — the same for a `string` known only at runtime.
const retriedAudit = await registry.retryAll("dead", {
  name: "audit",
  filter: (job) => {
    type _Plain = Expect<Equal<typeof job, Job<unknown, unknown>>>;
    return job.data !== undefined;
  },
});
checkEqual("retryAll: nothing named audit", retriedAudit, []);

compileOnly(() => {
  const runtimeName: string = "send-report";
  return registry.retryAll("dead", {
    name: runtimeName,
    filter: (_job) => {
      type _Plain = Expect<Equal<typeof _job, Job<unknown, unknown>>>;
      return true;
    },
  });
});

compileOnly(() => {
  registry.retryAll("dead", {
    name: "send-report",
    // @ts-expect-error a report job has no userId
    filter: (job) => job.data.userId === "u",
  });

  // @ts-expect-error unnarrowed, not every declared job carries a month
  registry.retryAll("dead", { filter: (job) => job.data.month === "2026-01" });
});

await settle(january ? [january.id] : [], ["completed"]);
const januaryBack = await registry.getJob(january?.id ?? "");
checkEqual(
  "januaryBack: read back under its name",
  januaryBack?.name,
  "send-report",
);
if (januaryBack?.name === "send-report") {
  checkEqual(
    "retryAll: January completed, typed as a report",
    januaryBack.returnValue,
    "report 2026-01",
  );
}
checkEqual(
  "retryAll: February is still dead",
  (await registry.getJob(february?.id ?? ""))?.state,
  "dead",
);

/* ------------------------------------------------------------------ */
step("addFlow: the top node and its registry-queue descendants checked");

type _FlowParam = Expect<
  Equal<Parameters<typeof registry.addFlow>[0], RegistryFlowNode<Jobs>>
>;

// A worker for the flow's foreign branch, on a queue of its own.
const digested: string[] = [];
const digest = jobs.worker(
  "digest",
  async (job) => {
    digested.push(job.name);
  },
  { pollInterval: 50 },
);
void digest.run();

const flow = await registry.addFlow({
  name: "send-report",
  data: { month: "2026-04" },
  children: [
    // No `queue`: on the registry queue, so checked by name.
    { name: "reindex" },
    {
      name: "notify-email",
      data: { userId: "u_2" },
      // Checked at every depth that stays on the registry queue.
      children: [{ name: "notify-sms", data: { userId: "u_2" } }],
    },
    // Names a queue of its own: the map does not describe it, so name and
    // payload are unchecked — and so are its children, which inherit it.
    {
      name: "summarise",
      data: { anything: ["goes"] },
      queue: "digest",
      children: [{ name: "collect", data: 42 }],
    },
  ],
});
// The top job is typed by the top node's name, so no narrowing is needed.
type _FlowTop = Expect<Equal<typeof flow.job, TypedJob<Jobs, "send-report">>>;
type _FlowResult = Expect<
  Equal<
    typeof flow,
    FlowResult<unknown, unknown, TypedJob<Jobs, "send-report">>
  >
>;
checkEqual("addFlow: the top job's payload", flow.job.data.month, "2026-04");
checkEqual("addFlow: the top job", flow.job.name, "send-report");
checkEqual(
  "addFlow: children in the order given",
  flow.children.map(({ job }) => job.name),
  ["reindex", "notify-email", "summarise"],
);

compileOnly(() => {
  // @ts-expect-error the top node is checked: month is a string
  registry.addFlow({ name: "send-report", data: { month: 4 } });

  // @ts-expect-error and needs its payload
  registry.addFlow({ name: "send-report" });

  // @ts-expect-error `queue` on the top node: it was always ignored, now refused
  registry.addFlow({ name: "reindex", queue: "digest" });

  registry.addFlow({
    name: "reindex",
    // @ts-expect-error a child on the registry queue is checked
    children: [{ name: "send-report", data: { month: 4 } }],
  });

  registry.addFlow({
    name: "reindex",
    children: [
      // @ts-expect-error and so is a grandchild, at any depth
      {
        name: "reindex",
        children: [{ name: "notify-sms", data: { userId: 1 } }],
      },
    ],
  });

  registry.addFlow({
    name: "reindex",
    // @ts-expect-error an undeclared name, with no `queue` to take it elsewhere
    children: [{ name: "audit", data: {} }],
  });
});

compileOnly(() => {
  // The one way past the check, documented rather than hidden: a child that
  // names the registry queue itself is a foreign node to the type. Leave
  // `queue` out for a node that belongs on the registry queue.
  return registry.addFlow({
    name: "reindex",
    children: [{ name: "audit", data: 1, queue: "jobs" }],
  });
});

await settle([flow.job.id], ["completed"]);
const flowBack = await registry.getJob(flow.job.id);
checkEqual("flowBack: read back under its name", flowBack?.name, "send-report");
if (flowBack?.name === "send-report") {
  checkEqual(
    "addFlow: the parent ran after its children",
    flowBack.returnValue,
    "report 2026-04",
  );
}
checkEqual(
  "addFlow: the foreign branch ran on its own queue",
  digested.sort(),
  ["collect", "summarise"],
);

/* ------------------------------------------------------------------ */
step("update: data must suit every declared payload");

// A report for later, to change before it runs.
const later = await jobs
  .run("send-report", { month: "2026-05" })
  .in("1 hour")
  .start();

// Anything that is not a payload is as before, and the job comes back typed.
const bumped = await registry.update(later.id, { priority: 5 });
type _Bumped = Expect<Equal<typeof bumped, TypedJob<Jobs> | null>>;
checkEqual("update: priority changed", bumped?.priority, 5);

// `update` is given an id, not a name: the payload would have to be a report
// month, void and a user all at once, which no value is. It is spelled that
// way too: the object payloads flattened into one, beside the `void`.
type _UpdateData = Expect<
  Equal<UpdateDataOf<unknown, Jobs>, { month: string; userId: string } & void>
>;
type _NotAReport = Expect<
  Equal<[{ month: string }] extends [UpdateDataOf<unknown, Jobs>] ? 1 : 0, 0>
>;

compileOnly(() => {
  // @ts-expect-error the id could name any job, and this suits only a report
  registry.update(later.id, { data: { month: "2026-06" } });
});

// The way round, when only the data changes and the job is in hand: narrow
// its name, and `updateData` is checked against that name's payload.
const job = await registry.getJob(later.id);
if (job?.name === "send-report") await job.updateData({ month: "2026-06" });
checkEqual(
  "update: rewritten through the narrowed job",
  (await registry.getJob(later.id))?.data,
  { month: "2026-06" },
);

compileOnly(() => {
  if (job?.name === "send-report") {
    // @ts-expect-error narrowed to a report, so a user is not its payload
    return job.updateData({ userId: "u" });
  }
});

// For the other fields together, or with only an id, write through the
// untyped view of the same queue — after checking the name yourself.
const current = await registry.getJob(later.id);
if (current?.name === "send-report") {
  await jobs.queue<unknown>("jobs").update(current.id, {
    data: { month: "2026-07" },
    priority: 7,
  });
}
const rewritten = await registry.getJob(later.id);
checkEqual(
  'update: rewritten through queue<unknown>("jobs")',
  [rewritten?.data, rewritten?.priority],
  [{ month: "2026-07" }, 7],
);

/* ------------------------------------------------------------------ */
step("Union names: the payload must suit each, the result is either");

/** Picks a channel at runtime, so the name is a union statically. */
function channelFor(userId: string): "notify-email" | "notify-sms" {
  return userId.endsWith("7") ? "notify-sms" : "notify-email";
}

// Both carry `{ userId }`, so a payload of that shape suits whichever it is.
const channel = channelFor("u_7");
const notified = await jobs.now(channel, { userId: "u_7" });
// A TypedJob of either name: check `name` and it narrows to that one's.
type _UnionJob = Expect<
  Equal<typeof notified, TypedJob<Jobs, "notify-email" | "notify-sms">>
>;
// The payload is the shape they share, spelled plainly.
type _UnionData = Expect<
  Equal<JobDataOf<Jobs, "notify-email" | "notify-sms">, { userId: string }>
>;
// Shapes that differ stay an intersection, which no value satisfies.
type _MixedData = Expect<
  Equal<JobDataOf<Jobs, "send-report" | "reindex">, { month: string } & void>
>;
type _UnionResult = Expect<
  Equal<
    JobResultOf<Jobs, "notify-email" | "notify-sms">,
    Sent<"email"> | Sent<"sms">
  >
>;
checkEqual(
  "union name: the runtime name was picked",
  notified.name,
  "notify-sms",
);

await settle([notified.id], ["completed"]);
checkEqual(
  "union name: the result is one of the declared",
  (await notified.refresh())?.returnValue,
  { via: "sms", userId: "u_7" },
);

compileOnly(() => {
  const mixed = channelFor("x") === "notify-sms" ? "send-report" : "reindex";

  // @ts-expect-error no payload is both { month } and void
  jobs.now(mixed, { month: "2026-08" });

  // @ts-expect-error nor may it be left out: that suits "reindex" only
  jobs.now(mixed);

  // @ts-expect-error the registry queue's add applies the same rule
  registry.add(mixed, { month: "2026-08" });
});

/** Two names whose payload is the same union — a type-only illustration. */
interface Toggles {
  /** Switch something on or off. */
  toggle: { data: { on: true } | { off: true }; result: void };
  /** The same payload under another name. */
  "toggle-again": { data: { on: true } | { off: true }; result: void };
}
// Where each payload is itself a union, the pair accepts exactly the same
// values but is not spelled as that union: intersecting two unions
// distributes, leaving cross terms such as `{ on: true; off: true }` as
// members of their own. Each is assignable to `{ on: true }`, so the two
// types accept the same values, but they are not identical — hence
// assignability both ways here, not Equal.
type _BoxedData = Expect<
  Mutual<
    JobDataOf<Toggles, "toggle" | "toggle-again">,
    { on: true } | { off: true }
  >
>;

/* ------------------------------------------------------------------ */
step('A registry queue of its own: BunJobs<Map, "work">');

/** A second service, whose two payloads have the same shape. */
interface Notify {
  /** Email a user. */
  "notify-email": { data: { userId: string }; result: Sent<"email"> };
  /** Text a user. */
  "notify-sms": { data: { userId: string }; result: Sent<"sms"> };
}

const notify = new BunJobs<Notify, "work">({
  namespace: exampleNamespace("typed-verbs-work"),
  driver: exampleDriver(),
  // Required once the second type argument names another queue, and it must
  // name the same one.
  registryQueue: "work",
  defaultJobOptions: { removeOnComplete: false },
});
// Literal results need no annotation here either.
notify.define("notify-email", (job) => ({
  via: "email",
  userId: job.data.userId,
}));
notify.define("notify-sms", async (job) => ({
  via: "sms",
  userId: job.data.userId,
}));

// Only the declared name is the registry queue; "jobs" is a plain queue here.
const work = notify.queue("work");
type _Work = Expect<Equal<typeof work, RegistryQueue<Notify>>>;
const notJobs = notify.queue("jobs");
type _NotJobs = Expect<
  Equal<typeof notJobs, BunQueue<unknown, unknown, string>>
>;

compileOnly(() => {
  return new BunJobs<Notify>({
    namespace: "n",
    driver: { type: "memory" },
    // @ts-expect-error without the second type argument only "jobs" is allowed
    registryQueue: "work",
  });
});
compileOnly(() => {
  // @ts-expect-error declared as "work", so the option is required
  return new BunJobs<Notify, "work">({
    namespace: "n",
    driver: { type: "memory" },
  });
});
compileOnly(() => {
  return new BunJobs<Notify, "work">({
    namespace: "n",
    driver: { type: "memory" },
    // @ts-expect-error and must say the same name
    registryQueue: "jobs",
  });
});

const workJob = await notify.now("notify-email", { userId: "u_8" });
checkEqual(
  'registryQueue: the job went on "work"',
  workJob.queue.queue,
  "work",
);
check(
  'registryQueue: and not on "jobs"',
  (await notJobs.getJob(workJob.id)) === null,
);

// Where every payload has the same shape, update's rule is no obstacle: one
// `{ userId }` suits whichever name the id turns out to have.
type _SameShape = Expect<
  Equal<UpdateDataOf<unknown, Notify>, { userId: string }>
>;
const delayedNote = await notify
  .run("notify-sms", { userId: "u_9" })
  .in("1 hour")
  .start();
const renamed = await work.update(delayedNote.id, { data: { userId: "u_10" } });
checkEqual(
  "update: every payload is { userId }, so it takes one",
  renamed?.data,
  {
    userId: "u_10",
  },
);

const workWorker = await notify.start({ pollInterval: 50 });
const heard: string[] = [];
workWorker.on("completed:notify-email", (_job, result) => {
  type _EmailResult = Expect<Equal<typeof result, Sent<"email">>>;
  heard.push(result.userId);
});
await waitFor("the work queue's email", async () => {
  return (await work.getJob(workJob.id))?.state === "completed";
});
await waitFor("the scoped completed event", () => heard.length === 1);
checkEqual("completed:notify-email: heard on the work worker", heard, ["u_8"]);
const workBack = await work.getJob(workJob.id);
checkEqual(
  "workBack: read back under its name",
  workBack?.name,
  "notify-email",
);
if (workBack?.name === "notify-email") {
  checkEqual("work: the result, narrowed", workBack.returnValue?.via, "email");
}

/* ------------------------------------------------------------------ */
step("Without a map, all four verbs keep their old types");

/** A payload for a plain queue. */
interface Mail {
  /** Recipient address. */
  to: string;
}

const loose = new BunJobs({
  namespace: exampleNamespace("typed-verbs-loose"),
  driver: exampleDriver(),
});

// An untyped context's queue, and a typed context's plain queue, alike.
for (const plain of [loose.queue<Mail>("mail"), jobs.queue<Mail>("mail")]) {
  type _Bulk = Expect<
    Equal<
      Parameters<typeof plain.addBulk>[0],
      { name: string; data: Mail; opts?: JobOptions }[]
    >
  >;
  type _Flow = Expect<
    Equal<Parameters<typeof plain.addFlow>[0], FlowNode<Mail>>
  >;
  type _Update = Expect<
    Equal<NonNullable<Parameters<typeof plain.update>[1]["data"]>, Mail>
  >;

  const added = await plain.addBulk([
    { name: "any-name", data: { to: "a@example.com" } },
    { name: "another", data: { to: "b@example.com" } },
  ]);
  type _Added = Expect<Equal<typeof added, Job<Mail, unknown>[]>>;

  const tree = await plain.addFlow({
    name: "parent",
    data: { to: "p@example.com" },
    // Children were always unchecked `FlowNode`s: any payload.
    children: [{ name: "child", data: 1 }],
  });
  type _Tree = Expect<Equal<typeof tree, FlowResult<Mail, unknown>>>;

  const changed = await plain.update(added[0]?.id ?? "", {
    data: { to: "c@example.com" },
  });
  checkEqual(
    `plain ${plain.namespace}: update wrote the payload`,
    changed?.data,
    {
      to: "c@example.com",
    },
  );

  const none = await plain.retryAll("dead", {
    name: "any-name",
    filter: (job) => {
      type _Filter = Expect<Equal<typeof job, Job<Mail, unknown>>>;
      return job.data.to.length > 0;
    },
  });
  checkEqual(`plain ${plain.namespace}: retryAll found nothing`, none, []);
  check(
    `plain ${plain.namespace}: the flow was added`,
    tree.children.length === 1,
  );
}

compileOnly(() => {
  // @ts-expect-error a plain queue still checks the payload it was given
  loose.queue<Mail>("mail").addBulk([{ name: "x", data: { to: 1 } }]);
});

/* ------------------------------------------------------------------ */
// Only the three namespaces this run created are purged.
await Promise.all([jobs.purge(), notify.purge(), loose.purge()]);
await Promise.all([jobs.close(), notify.close(), loose.close()]);
summary();
