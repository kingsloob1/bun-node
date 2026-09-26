/**
 * Compile-time assertions for a worker's `target` option: each local kind
 * takes its own tuning and nothing else, the string modes are exactly the
 * three new spellings, and `defineProcessors` takes what `BunJobs` hands out.
 * Checked by the tests typecheck (`bun scripts/typecheck.ts`), not by
 * `bun test`.
 *
 * Every `@ts-expect-error` below is a negative control: if the error ever
 * stops appearing, the build fails on the unused directive. Each sits beside
 * the same call written correctly, which must compile, so a directive cannot
 * pass merely because something unrelated on its line is broken.
 */
import type {
  BunJobs,
  BunQueueWorkerOptions,
  JobDefinition,
  LocalWorkerTarget,
  WORKER_TARGET_KINDS,
  WorkerTarget,
  WorkerTargetCloseOptions,
  WorkerTargetExecutor,
  WorkerTargetFactory,
  WorkerTargetInfo,
  WorkerTargetKind,
  WorkerTargetMode,
} from "../lib/index";
import { defineProcessors } from "../lib/index";

/** `true` only when `A` and `B` are the same type, exactly. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when given `true`. */
function assertTrue<T extends true>(_value?: T): void {}

/** The options every case below shares. */
const base = { namespace: "types" } satisfies BunQueueWorkerOptions;

/* --- the modes ------------------------------------------------------------- */

assertTrue<
  Equals<WorkerTargetMode, "in-process" | "worker-thread" | "child-process">
>();
assertTrue<Equals<LocalWorkerTarget["kind"], WorkerTargetMode>>();
assertTrue<Equals<WorkerTargetKind, WorkerTargetMode | "custom">>();
assertTrue<Equals<(typeof WORKER_TARGET_KINDS)[number], WorkerTargetKind>>();
assertTrue<Equals<WorkerTargetInfo["processor"], "function" | "file">>();

export const modes: BunQueueWorkerOptions[] = [
  { ...base, target: "in-process" },
  { ...base, target: "worker-thread" },
  { ...base, target: "child-process" },
];

// The runner's spellings are not a worker's.
// @ts-expect-error `"spawn"` is a runner's executionMode; a worker's is "child-process".
export const spawn: BunQueueWorkerOptions = { ...base, target: "spawn" };
// @ts-expect-error `"worker"` is a runner's executionMode; a worker's is "worker-thread".
export const worker: BunQueueWorkerOptions = { ...base, target: "worker" };

// `isolation` and `isolationOptions` are gone, not aliased.
// @ts-expect-error `isolation` was replaced by `target`.
export const isolation: BunQueueWorkerOptions = { ...base, isolation: "spawn" };

/* --- each kind takes its own tuning ---------------------------------------- */

export const tuned: BunQueueWorkerOptions[] = [
  { ...base, target: { kind: "in-process" } },
  {
    ...base,
    target: { kind: "worker-thread", closeTimeout: 1, worker: { smol: true } },
  },
  {
    ...base,
    target: {
      kind: "child-process",
      closeTimeout: 1,
      killTimeout: 1,
      spawn: { cwd: "/srv" },
    },
  },
];

export const wrongKind: BunQueueWorkerOptions[] = [
  {
    ...base,
    target: {
      kind: "worker-thread",
      // @ts-expect-error `spawn` belongs to a child-process target.
      spawn: { cwd: "/srv" },
    },
  },
  {
    ...base,
    target: {
      kind: "worker-thread",
      // @ts-expect-error `killTimeout` belongs to a child-process target.
      killTimeout: 1,
    },
  },
  {
    ...base,
    target: {
      kind: "child-process",
      // @ts-expect-error `worker` belongs to a worker-thread target.
      worker: { smol: true },
    },
  },
  {
    ...base,
    target: {
      kind: "in-process",
      // @ts-expect-error an in-process target takes no tuning.
      closeTimeout: 1,
    },
  },
  // @ts-expect-error there is no `file` on a target: the processor argument is the file.
  { ...base, target: { kind: "child-process", file: "./jobs/resize.ts" } },
];

/* --- a factory -------------------------------------------------------------- */

export const factory: WorkerTargetFactory = (context) => {
  // Every field the context carries, and no driver among them.
  const { namespace, queue, workerId, logger, processor } = context;
  logger.info("building", { namespace, queue, workerId });
  // @ts-expect-error deliberately no driver: writes go through `attempt.job`.
  void context.driver;
  return {
    name: processor.kind === "file" ? processor.path : "fn",
    run: async ({ job, record, context: ctx }) => {
      await job.updateProgress(1);
      return { id: record.id, attempt: ctx.attempt };
    },
    close: async () => {},
  } satisfies WorkerTargetExecutor;
};
export const withFactory: BunQueueWorkerOptions = { ...base, target: factory };
assertTrue<
  Equals<
    WorkerTarget,
    WorkerTargetMode | LocalWorkerTarget | WorkerTargetFactory
  >
>();

/* --- a target's close() may be told the close is forced ------------------- */

// Optional and additive: the no-argument `close` above still satisfies it.
assertTrue<
  Equals<
    Parameters<NonNullable<WorkerTargetExecutor["close"]>>,
    [options?: WorkerTargetCloseOptions]
  >
>();
assertTrue<Equals<WorkerTargetCloseOptions, { force?: boolean }>>();
export const honoursForce = {
  name: "forceful",
  run: async () => null,
  close: async (options) => {
    const force: boolean | undefined = options?.force;
    void force;
  },
} satisfies WorkerTargetExecutor;

/* --- defineProcessors takes what BunJobs hands out ------------------------- */

declare const jobs: BunJobs;
declare const typed: JobDefinition<{ to: string }, number>;
export const fromContext = defineProcessors(jobs.definitions());
export const fromTyped = defineProcessors([typed]);
export const inline = defineProcessors([
  {
    name: "inline",
    // An inline handler is still handed a `Job`, not `never`.
    handler: async (job) => job.name.length,
  },
]);
// @ts-expect-error a definition needs a handler.
export const noHandler = defineProcessors([{ name: "missing" }]);
