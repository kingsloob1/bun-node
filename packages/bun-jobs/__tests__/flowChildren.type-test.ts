import type {
  FlowChildrenValues,
  FlowNode,
  Job,
  JobChildrenOf,
  JobMapFromSchemas,
  TypedJob,
} from "../lib/index";
import { z } from "zod";
import { BunJobs, BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";

/**
 * Compile-time guarantees for a flow parent's typed children (bun-validate
 * V5c, plan §4.8.4 and Q-C9): `FlowChildrenValues` derives what
 * `getChildrenValues()` answers from the flow's declared shape, keyed
 * `queue:id`; a job map entry's `children` types a registry parent's handler
 * with it; a child that may fail (`optional`, `ignoreFailure`) is
 * `T | undefined`; and nothing changes for a job that declares none.
 *
 * Checked by `bun run check`, not `bun test`. Each `@ts-expect-error` is a
 * negative control (`bun scripts/prove-type-controls.ts
 * __tests__/flowChildren.type-test.ts` removes each in turn and requires an
 * error), and each guarded line is kept to one line so the directive reaches
 * it. Nothing here runs.
 */

/** Resolves to `true` only when `A` and `B` are the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Fails to compile unless given `true`. */
type Expect<T extends true> = T;

/** A month's report, declared once and passed to `addFlow` as it is. */
const report = {
  name: "send-report",
  data: { month: "2026-10" },
  children: [
    // On the registry queue, with a literal id: its own key, its own result.
    {
      name: "totals",
      data: { month: "2026-10" },
      opts: { jobId: "totals-2026-10" },
    },
    // May fail without failing the parent: `T | undefined`.
    {
      name: "refunds",
      data: { month: "2026-10" },
      opts: { jobId: "refunds-2026-10", ignoreFailure: true },
    },
    // Marked optional although nothing sets ignoreFailure.
    {
      name: "fx",
      data: undefined,
      opts: { jobId: "fx" },
      optional: true,
    },
    // `optional: false` claims the value is there, ignoreFailure or not.
    {
      name: "audit",
      data: undefined,
      opts: { jobId: "audit", ignoreFailure: true },
      optional: false,
    },
    // A generated id: read through the pattern.
    { name: "summary", data: { month: "2026-10" } },
    // Another queue: the map does not describe it, so its result is unknown.
    {
      name: "thumbnail",
      data: { page: 1 },
      queue: "media",
      opts: { jobId: "t1" },
    },
  ],
} as const;

/** The report's children, as its parent reads them. */
type ReportChildren = FlowChildrenValues<typeof report, Jobs, "jobs">;

/** What this service's jobs carry; the report's entry declares its children. */
interface Jobs {
  /** A total. */
  totals: { data: { month: string }; result: number };
  /** Refunds, which may fail. */
  refunds: { data: { month: string }; result: { count: number } };
  /** A rate. */
  fx: { data: void; result: string };
  /** An audit flag. */
  audit: { data: void; result: boolean };
  /** A summary. */
  summary: { data: { month: string }; result: { lines: number } };
  /** The parent: its children typed from the declared flow. */
  "send-report": {
    data: { month: string };
    result: string;
    children: ReportChildren;
  };
  /** A job that is never a parent. */
  ping: { data: void };
}

/** Schemas for a registry typed with `JobMapFromSchemas`. */
const _schemas = {
  totals: { data: z.object({ month: z.string() }), result: z.number() },
};

/** A small flow over the schema-typed registry. */
const small = {
  name: "report",
  data: null,
  children: [{ name: "totals", data: { month: "x" }, opts: { jobId: "t" } }],
} as const;

/** A map built on `JobMapFromSchemas`, the parent's entry declaring its children. */
type SchemaJobs = JobMapFromSchemas<typeof _schemas> & {
  /** The parent. */
  report: {
    data: null;
    children: FlowChildrenValues<typeof small, SchemaJobs, "jobs">;
  };
};

export async function flowChildrenTypeChecks(): Promise<void> {
  const driver = new MemoryDriver();
  const jobs = new BunJobs<Jobs>({ namespace: "types", driver });

  /* --- the derived record ------------------------------------------------- */

  type Totals = Equal<ReportChildren["jobs:totals-2026-10"], number>;
  type _Totals = Expect<Totals>;
  type Refunds = Equal<
    ReportChildren["jobs:refunds-2026-10"],
    { count: number } | undefined
  >;
  type _Refunds = Expect<Refunds>;
  type Fx = Equal<ReportChildren["jobs:fx"], string | undefined>;
  type _Fx = Expect<Fx>;
  type Audit = Equal<ReportChildren["jobs:audit"], boolean>;
  type _Audit = Expect<Audit>;
  type Thumb = Equal<ReportChildren["media:t1"], unknown>;
  type _Thumb = Expect<Thumb>;
  // Every child whose key is not known until it is added shares one index.
  type Generated = Equal<
    ReportChildren[`${string}:${string}`],
    { lines: number }
  >;
  type _Generated = Expect<Generated>;

  // Negative controls: the result is the child's, not anything at all.
  type WrongTotals = Equal<ReportChildren["jobs:totals-2026-10"], string>;
  // @ts-expect-error -- `totals` answers a number
  type _WrongTotals = Expect<WrongTotals>;
  type RefundsThere = Equal<
    ReportChildren["jobs:refunds-2026-10"],
    { count: number }
  >;
  // @ts-expect-error -- an ignoreFailure child may be missing
  type _RefundsThere = Expect<RefundsThere>;

  /* --- addFlow takes the declared flow as it is ------------------------- */

  const registry = jobs.queue("jobs");
  const flow = await registry.addFlow(report);
  type FlowTop = Equal<typeof flow.job, TypedJob<Jobs, "send-report">>;
  type _FlowTop = Expect<FlowTop>;
  // The top job's view reads the same record.
  const _fromFlow = await flow.job.getChildrenValues();
  type FromFlow = Equal<typeof _fromFlow, ReportChildren>;
  type _FromFlow = Expect<FromFlow>;

  /* --- the parent's handler ---------------------------------------------- */

  jobs.define("send-report", async (job) => {
    const values = await job.getChildrenValues();
    const total: number = values["jobs:totals-2026-10"];
    const refunds = values["jobs:refunds-2026-10"];
    // @ts-expect-error -- may be undefined: narrow it first
    const count: number = refunds.count;
    const audited: boolean = values["jobs:audit"];
    // @ts-expect-error -- a key the flow does not hold, when every other key is literal or a pattern it does not match
    const _missing = values.nope;
    return `${total} ${refunds?.count ?? 0} ${count} ${audited}`;
  });

  // A job that declares no children reads a plain record, as before.
  jobs.define("ping", async (job) => {
    const _values = await job.getChildrenValues();
    type PingValues = Equal<typeof _values, Record<string, unknown>>;
    type _PingValues = Expect<PingValues>;
  });
  type PingChildren = Equal<
    JobChildrenOf<Jobs, "ping">,
    Record<string, unknown>
  >;
  type _PingChildren = Expect<PingChildren>;

  /* --- with no map --------------------------------------------------------- */

  // Keys from the shape, results unknown: no map describes them.
  const bare = {
    name: "parent",
    data: null,
    queue: "reports",
    children: [
      { name: "a", data: 1, opts: { jobId: "a" } },
      {
        name: "b",
        data: 2,
        queue: "other",
        opts: { jobId: "b", ignoreFailure: true },
      },
    ],
  } as const;
  type Bare = FlowChildrenValues<typeof bare>;
  type BareA = Equal<Bare["reports:a"], unknown>;
  type _BareA = Expect<BareA>;
  type BareB = Equal<keyof Bare, "reports:a" | "other:b">;
  type _BareB = Expect<BareB>;
  // @ts-expect-error -- `a` inherits the node's own queue, "reports"
  type _BareWrongKey = Expect<Equal<keyof Bare, "a" | "other:b">>;

  // An untyped queue takes the `as const` flow too (readonly children).
  const reports = new BunQueue("reports", { namespace: "types", driver });
  const added = await reports.addFlow(bare);
  const _plain = await added.job.getChildrenValues();
  type Plain = Equal<typeof _plain, Record<string, unknown>>;
  type _Plain = Expect<Plain>;

  // A bare worker's job keeps the plain record unless the job type says otherwise.
  const _worker = new BunQueueWorker(
    "reports",
    async (job) => {
      const _values = await job.getChildrenValues();
      type WorkerValues = Equal<typeof _values, Record<string, unknown>>;
      type _WorkerValues = Expect<WorkerValues>;
    },
    { namespace: "types", driver },
  );

  /* --- the queue a node inherits ------------------------------------------ */

  // Without `TQueue`, an inheriting child's literal id is not enough for a
  // literal key: its queue is not in the type.
  type Unnamed = FlowChildrenValues<typeof report, Jobs>;
  type UnnamedKeys = Equal<keyof Unnamed, "media:t1" | `${string}:${string}`>;
  type _UnnamedKeys = Expect<UnnamedKeys>;

  /* --- options typed wider than a literal --------------------------------- */

  // A child built as a plain `FlowNode` may set ignoreFailure: optional.
  const wide: FlowNode = { name: "x", data: 1 };
  const _widened = { name: "p", data: 0, children: [wide] } as const;
  type Wide = FlowChildrenValues<typeof _widened>;
  type WideValue = Equal<Wide[`${string}:${string}`], unknown>;
  type _WideValue = Expect<WideValue>;

  /* --- a map built on JobMapFromSchemas ----------------------------------- */

  const schemaJobs = new BunJobs<SchemaJobs>({ namespace: "types", driver });
  schemaJobs.define("report", async (job) => {
    const _values = await job.getChildrenValues();
    type SchemaValues = Equal<(typeof _values)["jobs:t"], number>;
    type _SchemaValues = Expect<SchemaValues>;
  });
  void schemaJobs.queue("jobs").addFlow(small);

  /* --- Job's own default is unchanged --------------------------------------- */

  type Default = Equal<
    Awaited<ReturnType<Job["getChildrenValues"]>>,
    Record<string, unknown>
  >;
  type _Default = Expect<Default>;
}
