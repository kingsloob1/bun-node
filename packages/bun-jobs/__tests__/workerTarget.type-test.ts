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
  BunQueueWorker,
  BunQueueWorkerOptions,
  ContainerTarget,
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
assertTrue<
  Equals<WorkerTargetKind, WorkerTargetMode | "container" | "custom">
>();
assertTrue<Equals<(typeof WORKER_TARGET_KINDS)[number], WorkerTargetKind>>();
assertTrue<Equals<WorkerTargetInfo["processor"], "function" | "file">>();

export const modes: BunQueueWorkerOptions[] = [
  { ...base, target: "in-process" },
  { ...base, target: "worker-thread" },
  { ...base, target: "child-process" },
];

// The pre-1r spellings are not a target.
// @ts-expect-error `"spawn"` is the old spelling of "child-process".
export const spawn: BunQueueWorkerOptions = { ...base, target: "spawn" };
// @ts-expect-error `"worker"` is the old spelling of "worker-thread".
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
    WorkerTargetMode | LocalWorkerTarget | ContainerTarget | WorkerTargetFactory
  >
>();

/* --- the container target -------------------------------------------------- */

export const container: BunQueueWorkerOptions = {
  ...base,
  target: {
    kind: "container",
    image: "oven/bun:1",
    processor: "/app/jobs/processor.ts",
    pull: "missing",
    engine: { cli: "podman", host: "unix:///run/podman.sock" },
    runtime: "runsc",
    limits: { memory: "256m", cpus: 0.5, pids: 64, tmpfs: "16m" },
    network: "none",
    env: { NODE_ENV: "production" },
    mounts: [{ source: "/srv/data", target: "/data", readOnly: true }],
    user: "1000:1000",
    allowRoot: false,
    security: { apparmor: "docker-default" },
    closeTimeout: 1000,
    maxLogBytes: 4096,
  },
};
assertTrue<Equals<ContainerTarget["kind"], "container">>();
// No string form: a container needs an image.
export const containerString: BunQueueWorkerOptions = {
  ...base,
  // @ts-expect-error `"container"` alone names no image.
  target: "container",
};
export const containerImage: ContainerTarget = {
  kind: "container",
  image: "x",
};
// @ts-expect-error the image is required.
export const containerNoImage: ContainerTarget = { kind: "container" };
export const containerNone: ContainerTarget = {
  kind: "container",
  image: "x",
  network: "none",
};
export const containerHostNet: ContainerTarget = {
  kind: "container",
  image: "x",
  // @ts-expect-error the host's network is not a value this target takes.
  network: "host",
};
export const containerEnv: ContainerTarget = {
  kind: "container",
  image: "x",
  env: { A: "1" },
};
export const containerEnvNoValue: ContainerTarget = {
  kind: "container",
  image: "x",
  // @ts-expect-error a variable without a value would copy the host's.
  env: { A: undefined },
};
export const containerPrivileged: ContainerTarget = {
  kind: "container",
  image: "x",
  // @ts-expect-error there is no privileged mode, nor any raw flag.
  privileged: true,
};
export const containerNnp: ContainerTarget = {
  kind: "container",
  image: "x",
  // @ts-expect-error no-new-privileges is fixed, not an option.
  security: { noNewPrivileges: false },
};

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

/* --- a worker says where its attempts run ---------------------------------- */

// The heartbeat record's own type, read-only: `worker.target` is the very
// object the record publishes, so a caller must not be able to change it.
assertTrue<Equals<BunQueueWorker["target"], Readonly<WorkerTargetInfo>>>();
declare const running: BunQueueWorker;
// Still usable wherever a `WorkerTargetInfo` is wanted (the record's field).
export const described: WorkerTargetInfo = running.target;
export const kind: WorkerTargetKind = running.target.kind;
// @ts-expect-error the description is read-only.
running.target.kind = "custom";
// @ts-expect-error a getter, with no setter.
running.target = described;

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
