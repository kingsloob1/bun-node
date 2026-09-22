/**
 * The vocabulary the queue and runner benchmarks share.
 *
 * A *contender* is one library configured against one backend. Contenders are
 * grouped by backend when reported, because a Redis figure next to a Postgres
 * figure measures the database rather than the library.
 */

/** A storage backend a contender can be configured against. */
export type Backend =
  | "memory"
  | "file"
  | "sqlite"
  | "redis"
  | "postgres"
  | "mysql"
  | "mariadb"
  | "mongodb";

/** What a contender is measured doing. */
export type QueueScenario =
  | "enqueue"
  | "enqueue-bulk"
  | "throughput"
  | "roundtrip"
  | "payload"
  | "contention";

/** What a runner contender is measured doing. */
export type RunnerScenario = "dispatch" | "cycle" | "drift" | "exclusive";

/** One job as it travels through a queue. */
export interface JobPayload {
  /** Monotonic sequence number, unique within a run. Identity for exactly-once checks. */
  seq: number;
  /** `performance.now()` at the moment the producer handed it over, for round-trip latency. */
  at: number;
  /** Filler that pads the payload to the requested size. Absent when no padding was asked for. */
  pad?: string;
}

/** Everything a contender needs to build itself for one measured run. */
export interface QueueSetupContext {
  /** Queue/topic name, unique per run so a previous run cannot leak into this one. */
  name: string;
  /** Connection string for this contender's backend. */
  url: string;
  /** Bytes of filler per job payload. Zero means no `pad` field at all. */
  payloadBytes: number;
  /**
   * Called from inside the processor, once per job, with the payload it
   * received: the moment the handler runs. The exactly-once check counts
   * these, and the round-trip scenario stops its clock here — it measures
   * dispatch, not bookkeeping.
   */
  onReceive: (payload: JobPayload) => void;
  /**
   * Called once per job the library reports as completed *and recorded*: its
   * own completion signal, fired after the write that marks the job done has
   * been acknowledged by the backend. The drain scenarios stop their clock at
   * the last of these. Contenders whose library has no such signal never call
   * it and implement {@link QueueHandle.outstanding} instead.
   */
  onCompleted: (payload: JobPayload) => void;
  /** Called when a contender's own machinery reports an error, so a run cannot look fast by failing. */
  onError: (error: unknown) => void;
}

/** A live contender, ready to be driven by a scenario. */
export interface QueueHandle {
  /** Enqueues one job and resolves once the backend has it. */
  add: (payload: JobPayload) => Promise<void>;
  /**
   * Enqueues many jobs in as few round trips as the library allows.
   * Contenders without a batch API fall back to a sequential loop and set
   * {@link QueueContender.nativeBulk} to false so the table can say so.
   */
  addBulk: (payloads: JobPayload[]) => Promise<void>;
  /** Starts consuming at the given concurrency. Resolves once the consumer is live. */
  startWorker: (concurrency: number) => Promise<void>;
  /**
   * How many of this run's jobs the backend still holds as not yet completed,
   * read from the backend itself.
   *
   * Only for a library that reports no per-job completion after its write
   * lands (graphile-worker fires its events before the write; pg-boss has no
   * completion event outside its test spies). A drain then stops its clock at
   * the answer of the first read that finds none outstanding, polled only once
   * every job has reached a handler, so the reads never compete with the
   * drain. Contenders that call {@link QueueSetupContext.onCompleted} leave it
   * undefined.
   */
  outstanding?: () => Promise<number>;
  /** Stops consuming and waits for in-flight work to settle. */
  stopWorker: () => Promise<void>;
  /** Deletes every job this contender can see, so the next scenario starts empty. */
  reset: () => Promise<void>;
  /** Releases connections, timers and child processes. */
  close: () => Promise<void>;
}

/** One library configured against one backend. */
export interface QueueContender {
  /** Stable id used on the command line and as the child-process selector. */
  id: string;
  /** Human-readable name for the report. */
  label: string;
  /** Which backend this entry talks to. */
  backend: Backend;
  /** True for the library this repository ships, so the report can mark the baseline. */
  ours?: boolean;
  /** Whether {@link QueueHandle.addBulk} is a real batch API or a sequential fallback. */
  nativeBulk: boolean;
  /** Scenarios this contender cannot answer, with the reason shown under the table. */
  unsupported?: Partial<Record<QueueScenario, string>>;
  /** A caveat printed under the table, for anything that makes the number less than face value. */
  note?: string;
  /** Builds a live instance. */
  setup: (ctx: QueueSetupContext) => Promise<QueueHandle>;
}

/** Everything a runner contender needs for one measured run. */
export interface RunnerSetupContext {
  /** Runner/job name, unique per run. */
  name: string;
  /** Connection string for this contender's backend, empty for in-process-only entries. */
  url: string;
  /** Absolute path of the handler file, for contenders that execute a file. */
  file: string;
  /** Called each time the handler starts, with `performance.now()` as observed by the parent. */
  onStart: (at: number) => void;
  /** Called each time a run finishes. */
  onFinish: (at: number) => void;
  /** Called when the contender reports an error. */
  onError: (error: unknown) => void;
}

/** A live runner contender. */
export interface RunnerHandle {
  /** Triggers one run on demand and resolves when that run has completed. */
  trigger: () => Promise<void>;
  /** Arms a one-second schedule, calling back with the wall clock at each fire. */
  schedule?: (onFire: (at: number) => void) => Promise<void>;
  /** Disarms the schedule armed by {@link RunnerHandle.schedule}. */
  unschedule?: () => Promise<void>;
  /**
   * Whether a second live instance of this job is refused or coordinated,
   * rather than simply running the job a second time. Set only by contenders
   * that claim exclusivity across processes.
   */
  exclusive?: boolean;
  /** Releases connections, timers and child processes. */
  close: () => Promise<void>;
}

/** One scheduler or file runner under test. */
export interface RunnerContender {
  /** Stable id used on the command line. */
  id: string;
  /** Human-readable name for the report. */
  label: string;
  /** Which backend this entry needs, or `memory` when it keeps no durable state. */
  backend: Backend;
  /** True for the library this repository ships. */
  ours?: boolean;
  /** How the handler body is executed, which is the main thing separating these entries. */
  execution: "in-process" | "worker" | "spawn";
  /** Whether a trigger is exclusive across processes, which is what makes a run cost more than a function call. */
  durable: boolean;
  /** Scenarios this contender cannot answer, with the reason shown under the table. */
  unsupported?: Partial<Record<RunnerScenario, string>>;
  /** A caveat printed under the table. */
  note?: string;
  /** Builds a live instance. */
  setup: (ctx: RunnerSetupContext) => Promise<RunnerHandle>;
}

/** One measured figure, as a child process hands it back to the driver. */
export interface Measurement {
  /** The contender that produced it. */
  contender: string;
  /** The scenario it was produced under. */
  scenario: string;
  /** Backend the contender was configured against. */
  backend: Backend;
  /** Operations per second, when the scenario measures throughput. */
  opsPerSec?: number;
  /** Latency percentiles in milliseconds, when the scenario measures latency. */
  latency?: {
    p50: number;
    p90: number;
    p99: number;
    max: number;
    mean: number;
  };
  /** Absolute drift from the scheduled instant, in milliseconds. */
  drift?: { mean: number; p99: number; max: number; fires: number };
  /**
   * What several instances of one scheduled job did: how many occurrences
   * came due, and how many runs actually happened across all instances.
   */
  exclusivity?: {
    /** How many instances were live at once. */
    instances: number;
    /** How many scheduled occurrences came due in the observation window. */
    occurrences: number;
    /** How many runs actually happened, summed over every instance. */
    runs: number;
    /** Runs per occurrence: 1.0 is exactly once, 3.0 is every replica running it. */
    perOccurrence: number;
  };
  /** How many jobs or runs the figure is based on. */
  count: number;
  /** Wall-clock milliseconds the measured phase took. */
  elapsedMs: number;
  /** Set when the contender could not answer, replacing every figure above. */
  skipped?: string;
  /** Set when the run produced a wrong result, so a failure can never read as a fast time. */
  failed?: string;
}
