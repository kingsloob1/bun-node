/**
 * The reference executor's public types: what `createRemoteExecutor()` takes,
 * what a handler is handed, and the store it remembers attempts in.
 *
 * Browser-safe: type-only imports of browser-safe modules. Nothing here names
 * a Bun, Node or bun-common type, so the declarations load in an isolate.
 */

import type { RunLogLevel } from "../../api/contract/constants";
import type { RunProgress } from "../../api/contract/types";
import type { RemoteNonceStore } from "../nonce";
import type { RemoteSecret } from "../signing";
import type {
  RemoteHealthCheck,
  RemoteJobParent,
  RemoteRetainedOutcome,
} from "../types";

/**
 * The job a remote handler is handed: a reduced `Job`. It has the fields an
 * invoke carries, plus `log()` and `updateProgress()`, which travel back with
 * the outcome. Everything on `Job` that needs a driver (`retry()`,
 * `remove()`, `extendLock()`, …) is absent rather than present and broken:
 * the gateway holds the driver and the lease.
 */
export interface RemoteJob<TData = unknown> {
  /** The job's id. */
  readonly id: string;
  /** The job's name: which handler runs it. */
  readonly name: string;
  /** The job's data, as stored. */
  readonly data: TData;
  /** The queue the job belongs to, as `Job.queue` names it. */
  readonly queue: {
    /** The namespace the queue lives in. */
    readonly ns: string;
    /** The queue's name. */
    readonly queue: string;
  };
  /** The attempt this is, 1-based: `Job.attemptsMade` at the claim. */
  readonly attemptsMade: number;
  /** How many attempts the job has in all; `1` when the gateway did not say. */
  readonly maxAttempts: number;
  /** When the job was created, epoch ms, gateway clock; `0` when not sent. */
  readonly createdAt: number;
  /** The job's priority; `0` when not sent. */
  readonly priority: number;
  /** The repeatable schedule that produced the job, or `null`. */
  readonly repeatKey: string | null;
  /** The job's parent in a flow, or `null`. */
  readonly parent: RemoteJobParent | null;
  /**
   * `<namespace>:<queue>:<jobId>:<attempt>`: the same on every delivery of
   * this attempt. A handler that writes somewhere durable keys its writes by
   * it, because a push-mode handler must be idempotent: without a store, a
   * redelivered attempt runs again.
   */
  readonly idempotencyKey: string;
  /** `<lockToken>:<processedOn>`, the claim this attempt belongs to; grows with every claim. */
  readonly fence: string;
  /** Appends a line to the outcome's log; answers how many lines it holds. A line after the attempt ended is dropped. */
  log: (line: string) => Promise<number>;
  /** Records the job's progress; the last value travels back with the outcome. A value after the attempt ended is dropped. */
  updateProgress: (value: RunProgress) => Promise<void>;
}

/** What a remote handler is told besides its job: the attempt's signal, clock and channel. */
export interface RemoteContext {
  /**
   * Aborted when the attempt's time runs out (`maxDurationMs`, the job's
   * `timeoutMs` or the invoke's `deadlineAt`, whichever is first) or the
   * gateway cancels it. Long work should check it: the outcome is answered
   * at that moment either way, and what the handler returns afterwards is
   * discarded.
   */
  signal: AbortSignal;
  /** The attempt, 1-based. */
  attempt: number;
  /** How many times this attempt has been delivered, 1-based: above `1` means the gateway did not hear an earlier answer. */
  delivery: number;
  /** The gateway-side worker's incarnation id, to join logs with the Workers page. */
  workerId: string;
  /** The invoke's id (`bun-jobs-id`), to join logs with the gateway's. */
  invokeId: string;
  /** Epoch ms, gateway clock, after which the gateway stops waiting for the answer. */
  deadlineAt: number;
  /** Appends a line to the outcome's log, as `job.log()` does. */
  log: (line: string) => Promise<number>;
  /**
   * A sign of life before a long blocking step. On the unary `http` binding
   * there is no channel to send it on, so it resolves at once; the gateway
   * renews the lease for the whole call regardless.
   */
  heartbeat: () => Promise<void>;
}

/**
 * Runs one job on a remote executor. Same shape as a processor: return the
 * result (any JSON), or throw. An `UnrecoverableJobError`, matched by name,
 * fails the job with no further attempts.
 *
 * Declared as a method so a handler typed for its own data
 * (`(job: RemoteJob<{ url: string }>) => …`) can sit in the `handlers` map
 * beside the others: the executor cannot know each one's data type, and
 * hands each the job it was sent.
 */
export type RemoteJobHandler<TData = unknown, TResult = unknown> = {
  /** The handler. */
  // eslint-disable-next-line ts/method-signature-style -- the method form is what makes the parameter bivariant
  handle(job: RemoteJob<TData>, ctx: RemoteContext): TResult | Promise<TResult>;
}["handle"];

/** The author's readiness checks: run by `/readyz`, a `health` probe and the canary. */
export interface RemoteExecutorHealthOptions {
  /**
   * Answers whether this executor's own dependencies are ready (a model
   * loaded, a GPU, a database). Each check is reported by id; a check that
   * throws, or takes longer than 5 s, reports as a failed `health.check`.
   */
  check?: () => RemoteHealthCheck[] | Promise<RemoteHealthCheck[]>;
}

/**
 * Something an executor remembers about an attempt, stored as JSON. A store
 * never reads inside it; it holds it until its expiry.
 */
export type RemoteExecutorRecord =
  | {
      /** An attempt being run by one executor instance. */
      kind: "running";
      /** The instance running it: a random id per `createRemoteExecutor()` call. */
      instance: string;
      /** The fence of the claim being run. */
      fence: string;
    }
  | {
      /** An attempt answered, and its answer. */
      kind: "done";
      /** The outcome given, without its job and attempt. */
      outcome: RemoteRetainedOutcome;
    }
  | {
      /** The newest fence seen for a job. */
      kind: "fence";
      /** The fence. */
      fence: string;
    }
  | {
      /** Where a `status` question about one job and attempt finds its record. */
      kind: "alias";
      /** The idempotency key the record is under. */
      key: string;
    };

/**
 * Where an executor keeps idempotency records and fences between requests,
 * and across instances when the store is shared.
 *
 * The built-in one, {@link createRemoteExecutorStore}, is in memory: right for
 * a long-lived process, and protecting a warm isolate only. On Cloudflare
 * wrap a KV namespace or a Durable Object behind this interface; on a
 * container fleet, Redis. Every time is the executor's own clock, epoch ms.
 */
export interface RemoteExecutorStore {
  /** The record under `key`, or `undefined` when there is none or it has expired. */
  get: (
    key: string,
    now: number,
  ) =>
    | RemoteExecutorRecord
    | undefined
    | Promise<RemoteExecutorRecord | undefined>;
  /** Stores `record` under `key` until `expiresAt`, replacing what was there. */
  set: (
    key: string,
    record: RemoteExecutorRecord,
    expiresAt: number,
    now: number,
  ) => void | Promise<void>;
  /**
   * Reads the record under `key` (`undefined` when none, or expired), passes
   * it to `change`, and stores what `change` returns; `null` leaves it as it
   * was. Resolves the record that was there **before**.
   *
   * Should be atomic per key: two concurrent calls must not both see the
   * same "before". The built-in store is. A store over a backend without
   * transactions (a KV namespace) may read then write; what is lost then is
   * exactness between two instances racing on one job — both may run it, as
   * a store-less executor would — never a settled job.
   */
  update: (
    key: string,
    change: (
      current: RemoteExecutorRecord | undefined,
    ) => { record: RemoteExecutorRecord; expiresAt: number } | null,
    now: number,
  ) =>
    | RemoteExecutorRecord
    | undefined
    | Promise<RemoteExecutorRecord | undefined>;
}

/** Options for {@link createRemoteExecutorStore}. */
export interface RemoteExecutorStoreOptions {
  /**
   * The most records held at once. Default `10_000`. Past it the oldest is
   * forgotten, which reopens its attempt to running twice: size it above the
   * attempts one instance sees in `idempotencyTtl`. An executor writes up to
   * three records per attempt (the attempt, its `status` alias and the job's
   * fence).
   */
  max?: number;
}

/** Options for `createRemoteExecutor()`. */
export interface RemoteExecutorOptions {
  /**
   * What this executor runs, by job name. A handler under `"*"` runs any name
   * with no handler of its own, and the handshake then advertises `["*"]`.
   * The name `bun-jobs:canary` is reserved for the built-in canary.
   */
  handlers: Record<string, RemoteJobHandler>;
  /**
   * The shared secret every request is verified against and every response
   * signed with. A list accepts any of its keys and signs with the first, for
   * rotation. Each key at least 32 bytes.
   */
  secret: RemoteSecret;
  /** Reported in the signed handshake, so the Workers page can name this deployment. */
  name?: string;
  /** The most jobs one invoke may carry. Default `1`. Jobs past it in an invoke are `rejected` `BUSY`, never run. */
  maxBatch?: number;
  /**
   * The longest one attempt may run here, in ms: the platform's own ceiling
   * minus a margin. Default `300_000`. The gateway refuses to send a job
   * whose timeout exceeds it; an attempt that reaches it here is aborted and
   * answered as a timeout.
   */
  maxDurationMs?: number;
  /**
   * The largest request body accepted, in bytes. Default `1_048_576`
   * (1 MiB). A larger one is refused with 413 `TOO_LARGE` before it is read
   * past the cap.
   */
  maxBodyBytes?: number;
  /**
   * The most attempts running at once: the capacity advertised. Default `64`.
   * A job arriving with every slot taken is `rejected` `BUSY`, which does not
   * burn an attempt.
   */
  maxConcurrency?: number;
  /**
   * How long an attempt's outcome is remembered, in ms, so a redelivery is
   * answered from it instead of run again; also how long the job's newest
   * fence is kept. Default `600_000`. `0` turns idempotency, fencing and
   * `status` answers off, and the handshake stops advertising them.
   */
  idempotencyTtl?: number;
  /** Where outcomes and fences are remembered. Default an in-memory store per executor. */
  store?: RemoteExecutorStore;
  /**
   * Where seen signatures are remembered, so a replayed request is
   * `REPLAYED`. Default an in-memory cache per executor; an isolate that
   * wants protection across instances passes a shared one.
   */
  nonces?: RemoteNonceStore;
  /**
   * Called for each line a handler logs, and for the executor's own
   * diagnostics (a failing store), for the platform's logger. A throw here is
   * swallowed.
   */
  onLog?: (
    level: RunLogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  /** The author's readiness checks. */
  health?: RemoteExecutorHealthOptions;
}

/**
 * The executor `createRemoteExecutor()` builds: a fetch handler. Mount it
 * wherever a `Request` becomes a `Response` — `Bun.serve({ fetch })`, a
 * Next.js route, a Cloudflare Worker — at any path.
 *
 * `GET` answers the handshake, `POST` the `invoke`, `cancel`, `ping`,
 * `health` and `status` envelopes, and `GET …/healthz` and `GET …/readyz`
 * the platform's own probes.
 */
export type RemoteExecutor = (request: Request) => Promise<Response>;
