/**
 * Compile-time assertions for the runner's and the shared modules' types.
 *
 * These replaced a set of `unknown`s: progress and log payloads that had a
 * known shape all along, runner messages whose type only the caller knows,
 * error contexts that every class fills in the same way, and a job channel
 * whose replies differ by operation. Checked by the tests typecheck
 * (`bun scripts/typecheck.ts`), not by `bun test`.
 *
 * Every `@ts-expect-error` below is a negative control: if the error ever
 * stops appearing, the build fails on the unused directive.
 */
import type { LogLevel, SerializedError } from "@kingsleyweb/bun-common";
import type {
  BunRunner,
  BunRunnerEvents,
  BunRunnerManager,
  ChildToParent,
  JobChannelErrorReply,
  JobChannelOperation,
  JobChannelValueReply,
  JobsError,
  LogFields,
  QueueFullError,
  RunContext,
  RunHandle,
  RunnerHandler,
} from "../lib/index";
import type {
  BackoffWarning,
  BackoffWarningFields,
} from "../lib/queue/backoff";
import type { Job } from "../lib/queue/Job";
import type {
  IsolatedJob,
  IsolatedJobProcessor,
} from "../lib/runner/executors/executor";
import type {
  JobChannelReplies,
  JobChannelReply,
  ParentToChild,
  SerializableContext,
} from "../lib/runner/protocol";
import type { RunProgress } from "../lib/runner/types";
import {
  ChildExitError,
  defineHandler,
  JobTimeoutError,
  LockLostError,
  ProtocolError,
  RunKilledError,
} from "../lib/index";
import { toHandler } from "../lib/runner/executors/executor";
import { JOB_CHANNEL } from "../lib/runner/protocol";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/** What the handler receives from `runner.send()`. */
interface Ping {
  /** Always `true`. */
  ping: true;
}

/** What the handler sends back with `ctx.send()`. */
interface Echo {
  /** The ping it received. */
  echo: Ping;
}

/* --- progress and logs have a shape ------------------------------- */

type _progress = Expect<Equal<RunProgress, number | Record<string, unknown>>>;
type _progressEvent = Expect<
  Equal<Parameters<BunRunnerEvents["progress"]>[1], RunProgress>
>;
type _logLevel = Expect<Equal<Parameters<BunRunnerEvents["log"]>[1], LogLevel>>;
type _logFields = Expect<
  Equal<Parameters<BunRunnerEvents["log"]>[3], LogFields>
>;
type _wireProgress = Expect<
  Equal<Extract<ChildToParent, { t: "progress" }>["value"], RunProgress>
>;
type _wireLog = Expect<
  Equal<
    Pick<Extract<ChildToParent, { t: "log" }>, "level" | "fields">,
    { level: LogLevel; fields: LogFields }
  >
>;

declare const ctx: RunContext;
ctx.progress(50);
ctx.progress({ step: 1, of: 3 });
// @ts-expect-error progress is a number or a record, not a string
ctx.progress("half");

/* --- messages are the caller's type, and `unknown` by default ----- */

// The defaults keep an undeclared runner exactly as open as it was.
type _defaultSend = Expect<Equal<Parameters<RunContext["send"]>[0], unknown>>;
type _defaultMessage = Expect<
  Equal<Parameters<BunRunnerEvents["message"]>[1], unknown>
>;
type _defaultRunnerSend = Expect<
  Equal<Parameters<BunRunner["send"]>[0], unknown>
>;

type _declaredSend = Expect<
  Equal<Parameters<RunContext<unknown, Ping, Echo>["send"]>[0], Echo>
>;
type _declaredListener = Expect<
  Equal<
    Parameters<Parameters<RunContext<unknown, Ping, Echo>["onMessage"]>[0]>[0],
    Ping
  >
>;
type _declaredEvent = Expect<
  Equal<Parameters<BunRunnerEvents<unknown, number, Echo>["message"]>[1], Echo>
>;
type _declaredRunnerSend = Expect<
  Equal<Parameters<BunRunner<unknown, number, Ping, Echo>["send"]>[0], Ping>
>;

defineHandler<{ steps: number }, number, Ping, Echo>((context) => {
  context.onMessage((message) => {
    const ping: true = message.ping;
    context.send({ echo: { ping } });
  });
  // @ts-expect-error a declared runner sends only its declared message
  context.send({ unexpected: true });
  return context.args.steps;
});

declare const typed: BunRunner<{ steps: number }, number, Ping, Echo>;
typed.send({ ping: true });
// @ts-expect-error `send()` takes the runner's declared message type
typed.send({ ping: false });
typed.on("message", (_run, data) => {
  const echoed: Ping = data.echo;
  return echoed;
});

// A typed runner still fits a registry of mixed runners. Making the handle
// generic made `BunRunner` invariant in its message type and broke this.
declare const manager: BunRunnerManager;
const _registered = manager.add(typed);
type _registeredType = Expect<
  Equal<typeof _registered, BunRunner<{ steps: number }, number, Ping, Echo>>
>;
type _activeRuns = Expect<
  Equal<(typeof typed)["activeRuns"], ReadonlyMap<string, RunHandle>>
>;

/* --- `toHandler`'s return type follows `kind` --------------------- */

declare const imported: unknown;
const _runHandler = toHandler(imported, "file.ts");
const _runHandlerExplicit = toHandler(imported, "file.ts", "run");
const _jobProcessor = toHandler(imported, "file.ts", "job");
type _run = Expect<Equal<typeof _runHandler, RunnerHandler>>;
type _runExplicit = Expect<Equal<typeof _runHandlerExplicit, RunnerHandler>>;
type _job = Expect<Equal<typeof _jobProcessor, IsolatedJobProcessor>>;
// @ts-expect-error `kind` is "run" or "job"
toHandler(imported, "file.ts", "worker");

// A real `Job` is what the in-process path passes, so it must fit. The
// isolated job is the class's whole public surface: nothing is left out.
declare const realJob: Job<unknown, unknown>;
const _fits: IsolatedJob = realJob;
type _complete = Expect<Equal<keyof IsolatedJob, keyof Job<unknown, unknown>>>;
declare const isolated: IsolatedJob;
type _parent = Expect<Equal<IsolatedJob["parent"], Job["parent"]>>;
type _childrenValues = Expect<
  Equal<
    ReturnType<IsolatedJob["getChildrenValues"]>,
    Promise<Record<string, unknown>>
  >
>;
type _childrenFailures = Expect<
  Equal<
    ReturnType<IsolatedJob["getChildrenFailures"]>,
    Promise<Record<string, Error>>
  >
>;
// @ts-expect-error a structural copy is not the class, which has private fields
const _notTheClass: Job<unknown, unknown> = isolated;

/* --- the job channel's replies differ by operation ---------------- */

type _replies = Expect<
  Equal<
    JobChannelReplies,
    {
      log: number;
      heartbeat: boolean;
      childrenValues: Record<string, unknown>;
      childrenFailures: Record<string, SerializedError>;
    }
  >
>;
type _operations = Expect<
  Equal<
    JobChannelOperation,
    "log" | "heartbeat" | "childrenValues" | "childrenFailures"
  >
>;
type _replyValue = Expect<
  Equal<JobChannelValueReply["value"], JobChannelReplies[JobChannelOperation]>
>;
type _replyError = Expect<
  Equal<JobChannelErrorReply["error"], SerializedError>
>;
declare const serialized: SerializedError;
const _valueReply: JobChannelReply = {
  [JOB_CHANNEL]: "reply",
  seq: 1,
  value: 3,
};
const _errorReply: JobChannelReply = {
  [JOB_CHANNEL]: "reply",
  seq: 1,
  error: serialized,
};
// @ts-expect-error a reply carries a value or an error, never both
const _both: JobChannelReply = {
  [JOB_CHANNEL]: "reply",
  seq: 1,
  value: 3,
  error: serialized,
};
type _startCtx = Expect<
  Equal<Extract<ParentToChild, { t: "start" }>["ctx"], SerializableContext>
>;

/* --- errors declare the context they fill in ---------------------- */

type _baseContext = Expect<
  Equal<JobsError["context"], Record<string, unknown> | undefined>
>;
const timeout = new JobTimeoutError(250, { jobId: "j1" });
const _ms: number = timeout.context.ms;
const _key: string = new LockLostError("r:1").context.key;
const _reason: string = new RunKilledError("stop").context.reason;
const _exit: number | null = new ChildExitError(1, null).context.exitCode;
type _queueFull = Expect<
  Equal<QueueFullError["context"], { what: string; max: number }>
>;

// @ts-expect-error `ms` is the error's own field; a caller cannot replace it
void new JobTimeoutError(250, { ms: 1 });
// @ts-expect-error nor `key`, which the declared context promises is the lock's
void new LockLostError("r:1", { key: 42 });
// @ts-expect-error `reason` likewise
void new RunKilledError("stop", { reason: "other" });

const protocolError = new ProtocolError("job channel", "no value");
const _problem: string = protocolError.context.problem;
// @ts-expect-error `problem` is the error's own field
void new ProtocolError("job channel", "no value", { problem: "other" });

/* --- a backoff warning names its fields --------------------------- */

const _unknownStrategy: BackoffWarningFields = {
  jobId: "j1",
  strategy: "jitter",
  known: ["linear"],
};
// @ts-expect-error every warning names the strategy
const _missing: BackoffWarningFields = { jobId: "j1", known: [] };

// A logger's `warn` is still an acceptable warning sink, as the worker passes.
declare const warn: (message: string, fields?: LogFields) => void;
const _sink: BackoffWarning = warn;
