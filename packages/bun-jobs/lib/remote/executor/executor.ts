/**
 * `createRemoteExecutor()`: the reference remote executor, as a fetch
 * handler (`worker-runtimes.md` §5.3–§5.12, §6.1; `remote-transports.md`
 * §4.9, §5.3, §5.5, §7.2).
 *
 * One handler serves every operation of the unary `http` binding:
 *
 * | Request | Answer |
 * |---|---|
 * | `GET` (any path but the two below) | the handshake; the full document, signed, to a signed request |
 * | `GET …/healthz` | `200 {"ok":true}`: the process answers. Unauthenticated, discloses nothing |
 * | `GET …/readyz` | `200 {"ready":true}`, or `503` with a reason: not full, and the author's checks pass |
 * | `POST` `invoke` | `invoke-result`: one outcome per job, keyed by id |
 * | `POST` `cancel`, `ping`, `health`, `status` | `cancel-result`, `pong`, `health-result`, `status-result` |
 *
 * **Every `POST` is verified as a `request`** before its body is parsed, and
 * every answer to an authenticated request is signed as a `response`. A
 * request that fails verification is answered 401 with the problem code and
 * no signature, so a caller without the key never obtains a signature over
 * bytes it chose. Only request envelopes are accepted: a response's `op`
 * (a captured `invoke-result` re-signed as a request) is `UNSUPPORTED_OP`.
 *
 * **A job's failure is never an HTTP error.** It is a `fail` outcome inside
 * a 200; only transport problems (signature, size, protocol, op, a malformed
 * message) are HTTP statuses (`worker-runtimes.md` §5.3).
 *
 * Browser-safe: Web APIs (`Request`, `Response`, `crypto`, `TextDecoder`,
 * timers) and the protocol core only. The host injects `node:crypto` through
 * {@link createRemoteExecutorWith}, which is internal.
 */

import type { HmacSha256 } from "../mac";
import type {
  CancelEnvelope,
  HandshakeEnvelope,
  HealthEnvelope,
  InvokeEnvelope,
  PingEnvelope,
  RemoteAttemptStatus,
  RemoteCapacity,
  RemoteInvokeJob,
  RemoteJobRef,
  RemoteOutcome,
  RemoteQueueRef,
  RemoteRejectedOutcome,
  RemoteRetainedOutcome,
  StatusEnvelope,
} from "../types";
import type { SettledOutcome, TimeLimit } from "./attempt";
import type { Signer } from "./http";
import type {
  RemoteExecutor,
  RemoteExecutorOptions,
  RemoteExecutorRecord,
  RemoteExecutorStore,
  RemoteJobHandler,
} from "./types";
import { ConfigError, RemoteMessageTooLargeError } from "../../shared/errors";
import { REMOTE_HEADERS, WORKER_PROTOCOL_VERSION } from "../constants";
import { subtleHmacSha256, toHex, utf8 } from "../mac";
import { createRemoteNonceCache } from "../nonce";
import { parseRemoteRequest } from "../schemas";
import { REMOTE_ID_PATTERN, verifyEnvelopeWith } from "../signing";
import { runAttempt } from "./attempt";
import {
  allPass,
  createCanaryHandler,
  createHealthRunner,
  REMOTE_CANARY_JOB,
} from "./canary";
import { answer, problem, readBounded } from "./http";
import { createRemoteExecutorStore } from "./store";

/** Defaults for the options that have one. */
const DEFAULTS = {
  maxBatch: 1,
  maxDurationMs: 300_000,
  maxBodyBytes: 1_048_576,
  maxConcurrency: 64,
  idempotencyTtl: 600_000,
} as const;

/** The longest timer a runtime keeps without firing at once: 2³¹ − 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
/** The shortest key a secret may have, in bytes. */
const MIN_KEY_BYTES = 32;
/** How long a `BUSY` or `DUPLICATE_RUNNING` rejection asks the gateway to wait, in ms. */
const RETRY_AFTER_MS = 1_000;
/** How long past its time a `running` record outlives a crashed instance, in ms. */
const RUNNING_GRACE_MS = 1_000;
/** What the executor calls itself in the handshake. */
const SDK = "@kingsleyweb/bun-jobs/remote";
/** The protocol versions this executor speaks. */
const PROTOCOLS = [WORKER_PROTOCOL_VERSION];

/** A whole-number option, checked, or its default. */
function integer(
  options: object,
  name: keyof typeof DEFAULTS,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = (options as Record<string, unknown>)[name] ?? DEFAULTS[name];
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new ConfigError(
      `createRemoteExecutor(): ${name} must be a whole number from ${minimum} to ${maximum}`,
      { [name]: value },
    );
  }
  return value as number;
}

/** The secret's keys, after checking each is a string of at least 32 bytes. */
function checkSecret(secret: unknown): string[] {
  const list = typeof secret === "string" ? [secret] : secret;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError(
      "createRemoteExecutor(): secret must be a string or a non-empty list of them",
    );
  }
  return list.map((key: unknown, index) => {
    if (typeof key !== "string" || utf8(key).length < MIN_KEY_BYTES) {
      throw new ConfigError(
        `createRemoteExecutor(): every key of secret must be a string of at least ${MIN_KEY_BYTES} bytes`,
        { index },
      );
    }
    return key;
  });
}

/** Checks that an option, when given, is an object with these methods. */
function checkMethods(name: string, value: unknown, methods: string[]): void {
  if (
    value !== undefined &&
    (value === null ||
      typeof value !== "object" ||
      methods.some(
        (method) =>
          typeof (value as Record<string, unknown>)[method] !== "function",
      ))
  ) {
    throw new ConfigError(
      `createRemoteExecutor(): ${name} must be an object with ${methods.join(", ")}`,
    );
  }
}

/** The handlers, after checking each is a function and none takes the canary's name. */
function checkHandlers(handlers: unknown): Map<string, RemoteJobHandler> {
  if (handlers === null || typeof handlers !== "object") {
    throw new ConfigError(
      "createRemoteExecutor(): handlers must be an object of job name to function",
    );
  }
  const out = new Map<string, RemoteJobHandler>();
  for (const [name, handler] of Object.entries(handlers)) {
    if (name === REMOTE_CANARY_JOB) {
      throw new ConfigError(
        `createRemoteExecutor(): "${REMOTE_CANARY_JOB}" is reserved for the built-in canary`,
      );
    }
    if (name.length === 0 || typeof handler !== "function") {
      throw new ConfigError(
        "createRemoteExecutor(): every handler must be a function under a non-empty name",
        { name },
      );
    }
    out.set(name, handler as RemoteJobHandler);
  }
  return out;
}

/** A fence's parts: `<lockToken>:<claimedAt>`. `undefined` when it does not have that shape. */
function parseFence(fence: string): { token: string; at: number } | undefined {
  const colon = fence.lastIndexOf(":");
  const at = fence.slice(colon + 1);
  return colon > 0 && /^\d{1,16}$/.test(at)
    ? { token: fence.slice(0, colon), at: Number(at) }
    : undefined;
}

/**
 * Orders two fences by their claim time: negative when `a` is the older
 * claim. `undefined` when they cannot be ordered — either is not
 * `<lockToken>:<claimedAt>`, or two different claims share one instant —
 * in which case neither is refused.
 */
export function compareFences(a: string, b: string): number | undefined {
  if (a === b) {
    return 0;
  }
  const left = parseFence(a);
  const right = parseFence(b);
  if (left === undefined || right === undefined || left.at === right.at) {
    return undefined;
  }
  return left.at - right.at;
}

/** A result for a job that is not run now, with a code. Never burns an attempt. */
function rejected(
  job: RemoteInvokeJob,
  code: RemoteRejectedOutcome["code"],
  retryAfterMs?: number,
): RemoteRejectedOutcome {
  return {
    op: "rejected",
    job: job.id,
    attempt: job.attempt,
    fence: job.fence,
    code,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

/** An outcome without its job and attempt, as it is remembered. */
function retain(outcome: SettledOutcome): RemoteRetainedOutcome {
  const { job: _job, attempt: _attempt, ...rest } = outcome;
  return rest;
}

/** The runtime this runs on, from `navigator.userAgent` where there is one. */
function detectRuntime(): string | undefined {
  const scope = globalThis as { navigator?: { userAgent?: unknown } };
  const agent = scope.navigator?.userAgent;
  return typeof agent === "string" && agent.length > 0 ? agent : undefined;
}

/** The last path segment, ignoring trailing slashes. */
function lastSegment(request: Request): string {
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return "";
  }
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** A `bun-jobs-id` worth echoing: one that matches `REMOTE_ID_PATTERN`. */
function echoableId(value: string | null | undefined): string | null {
  return typeof value === "string" && REMOTE_ID_PATTERN.test(value)
    ? value
    : null;
}

/**
 * One attempt's identity across queues: the namespace, the queue, the job id
 * and the attempt. A job id is unique only within its queue, so the job id
 * and the attempt alone would let two queues' attempts collide.
 */
function attemptId(
  queue: RemoteQueueRef,
  job: string,
  attempt: number,
): string {
  return JSON.stringify([queue.ns, queue.queue, job, attempt]);
}

/** An answer to `HEAD`: the `GET` answer's status and headers, no body. */
function headless(response: Response): Response {
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}

/**
 * {@link createRemoteExecutor} through a given MAC: the seam the Bun host
 * injects `node:crypto` through. Internal.
 */
export function createRemoteExecutorWith(
  mac: HmacSha256,
  options: RemoteExecutorOptions,
): RemoteExecutor {
  if (options === null || typeof options !== "object") {
    throw new ConfigError("createRemoteExecutor() takes an options object");
  }
  const handlers = checkHandlers(options.handlers);
  const keys = checkSecret(options.secret);
  const maxBatch = integer(options, "maxBatch", 1);
  const maxDurationMs = integer(options, "maxDurationMs", 1, MAX_TIMER_MS);
  const maxBodyBytes = integer(options, "maxBodyBytes", 1);
  const maxConcurrency = integer(options, "maxConcurrency", 1);
  const idempotencyTtl = integer(options, "idempotencyTtl", 0);
  if (options.name !== undefined && typeof options.name !== "string") {
    throw new ConfigError("createRemoteExecutor(): name must be a string");
  }
  checkMethods("store", options.store, ["get", "set", "update"]);
  checkMethods("nonces", options.nonces, ["remember"]);
  if (options.onLog !== undefined && typeof options.onLog !== "function") {
    throw new ConfigError("createRemoteExecutor(): onLog must be a function");
  }
  if (
    options.health !== undefined &&
    (options.health === null ||
      typeof options.health !== "object" ||
      (options.health.check !== undefined &&
        typeof options.health.check !== "function"))
  ) {
    throw new ConfigError(
      "createRemoteExecutor(): health must be { check?: () => checks }",
    );
  }

  const secret = [...keys];
  const nonces = options.nonces ?? createRemoteNonceCache();
  /** `null` when idempotency is off: nothing is remembered, nothing is fenced. */
  const store: RemoteExecutorStore | null =
    idempotencyTtl > 0 ? (options.store ?? createRemoteExecutorStore()) : null;
  const instance = crypto.randomUUID();
  const runChecks = createHealthRunner(options.health);
  const canary = createCanaryHandler(runChecks);
  const runtime = detectRuntime();
  const names = [...handlers.keys()];
  const advertised = handlers.has("*") ? ["*"] : names;
  const features: Record<string, string> = {
    cancel: "v1",
    health: "v1",
    canary: "v1",
    "replay-protection": "v1",
    ...(store === null
      ? {}
      : { idempotency: "v1", fencing: "v1", "attempt-status": "v1" }),
  };
  let secretHash: Promise<string> | undefined;

  /** Slots held by attempts whose handler has not yet returned. */
  let inFlight = 0;
  /** Attempts in progress here, by idempotency key: a redelivery joins the first. */
  const inProgress = new Map<string, Promise<RemoteOutcome>>();
  /** The controller of every attempt whose handler is running here, by job and attempt. */
  const controllers = new Map<string, AbortController>();

  const log = (
    level: Parameters<NonNullable<RemoteExecutorOptions["onLog"]>>[0],
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    try {
      options.onLog?.(level, message, fields);
    } catch {
      // The author's logger failing must not fail the attempt.
    }
  };

  const capacity = (): RemoteCapacity => ({
    inFlight,
    max: maxConcurrency,
    accepting: inFlight < maxConcurrency,
  });

  /** Takes a slot, or answers `null` when all are taken; the release is idempotent. */
  const reserve = (): (() => void) | null => {
    if (inFlight >= maxConcurrency) {
      return null;
    }
    inFlight++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        inFlight--;
      }
    };
  };

  /** Which limit bounds an attempt, and how long it has. */
  const budgetOf = (
    envelope: InvokeEnvelope,
    job: RemoteInvokeJob,
  ): { ms: number; limit: TimeLimit } => {
    let budget: { ms: number; limit: TimeLimit } = {
      ms: maxDurationMs,
      limit: "maxDurationMs",
    };
    if (
      job.timeoutMs !== undefined &&
      job.timeoutMs > 0 &&
      job.timeoutMs < budget.ms
    ) {
      budget = { ms: job.timeoutMs, limit: "timeoutMs" };
    }
    // The gateway's clock is authoritative: what remains is its deadline less
    // its own now, never this machine's clock.
    const remaining = envelope.deadlineAt - envelope.now;
    if (remaining < budget.ms) {
      budget = { ms: Math.max(0, remaining), limit: "deadlineAt" };
    }
    return budget;
  };

  /** Runs a job in a slot already reserved; the slot is freed when the handler returns. */
  const execute = (
    envelope: InvokeEnvelope,
    job: RemoteInvokeJob,
    handler: RemoteJobHandler,
    release: () => void,
  ): Promise<SettledOutcome> => {
    const controller = new AbortController();
    const ref = attemptId(
      { ns: envelope.namespace, queue: envelope.queue },
      job.id,
      job.attempt,
    );
    controllers.set(ref, controller);
    const run = runAttempt({
      envelope,
      job,
      handler,
      budget: budgetOf(envelope, job),
      controller,
      onLog: log,
    });
    void run.finished.then(() => {
      release();
      if (controllers.get(ref) === controller) {
        controllers.delete(ref);
      }
    });
    return run.outcome;
  };

  /**
   * One job with the store: fence it, join or answer a redelivery, then run
   * it and remember the outcome. `release` is the slot reserved for it.
   */
  const runRemembered = async (
    store: RemoteExecutorStore,
    envelope: InvokeEnvelope,
    job: RemoteInvokeJob,
    handler: RemoteJobHandler,
    release: () => void,
  ): Promise<RemoteOutcome> => {
    const now = Date.now();
    const fenceKey = `f:${JSON.stringify([envelope.namespace, envelope.queue, job.id])}`;
    const attemptKey = `a:${job.idempotencyKey}`;
    const aliasKey = `s:${attemptId({ ns: envelope.namespace, queue: envelope.queue }, job.id, job.attempt)}`;
    const runningUntil = now + budgetOf(envelope, job).ms + RUNNING_GRACE_MS;
    let before: RemoteExecutorRecord | undefined;
    try {
      // Fencing: refuse a claim older than one already seen for this job.
      let stale = false;
      await store.update(
        fenceKey,
        (current) => {
          const order =
            current?.kind === "fence"
              ? compareFences(job.fence, current.fence)
              : undefined;
          stale = order !== undefined && order < 0;
          return stale
            ? null
            : {
                record: { kind: "fence", fence: job.fence },
                expiresAt: now + idempotencyTtl,
              };
        },
        now,
      );
      if (stale) {
        release();
        return rejected(job, "STALE_FENCE");
      }
      // Idempotency: claim the attempt unless it is answered, or running elsewhere.
      before = await store.update(
        attemptKey,
        (current) =>
          current?.kind === "done" ||
          (current?.kind === "running" && current.instance !== instance)
            ? null
            : {
                record: { kind: "running", instance, fence: job.fence },
                expiresAt: runningUntil,
              },
        now,
      );
      if (before?.kind === "done") {
        release();
        return { ...before.outcome, job: job.id, attempt: job.attempt };
      }
      if (before?.kind === "running" && before.instance !== instance) {
        release();
        return rejected(job, "DUPLICATE_RUNNING", RETRY_AFTER_MS);
      }
      await store.set(
        aliasKey,
        { kind: "alias", key: job.idempotencyKey },
        Math.max(runningUntil, now + idempotencyTtl),
        now,
      );
    } catch (error) {
      release();
      log(
        "error",
        "The remote executor's store failed; the job is refused as BUSY",
        {
          job: job.id,
          attempt: job.attempt,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return rejected(job, "BUSY", RETRY_AFTER_MS);
    }

    const outcome = await execute(envelope, job, handler, release);
    const at = Date.now();
    try {
      await store.set(
        attemptKey,
        { kind: "done", outcome: retain(outcome) },
        at + idempotencyTtl,
        at,
      );
      await store.set(
        aliasKey,
        { kind: "alias", key: job.idempotencyKey },
        at + idempotencyTtl,
        at,
      );
    } catch (error) {
      log(
        "error",
        "The remote executor's store failed to remember an outcome",
        {
          job: job.id,
          attempt: job.attempt,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    return outcome;
  };

  /** One job of an invoke, to its outcome. */
  const runJob = async (
    envelope: InvokeEnvelope,
    job: RemoteInvokeJob,
  ): Promise<RemoteOutcome> => {
    const isCanary = job.name === REMOTE_CANARY_JOB;
    const handler = isCanary
      ? canary
      : (handlers.get(job.name) ?? handlers.get("*"));
    if (handler === undefined) {
      return {
        op: "fail",
        job: job.id,
        attempt: job.attempt,
        fence: job.fence,
        status: "handler-not-found",
        error: {
          name: "HandlerNotFoundError",
          message: `No handler for "${job.name}" on this executor`,
        },
      };
    }
    // A redelivery of an attempt in progress here joins it, holding no slot.
    const key = job.idempotencyKey;
    const joined = store === null || isCanary ? undefined : inProgress.get(key);
    if (joined !== undefined) {
      return await joined;
    }
    const release = reserve();
    if (release === null) {
      return rejected(job, "BUSY", RETRY_AFTER_MS);
    }
    // The canary writes nothing durable, so it is neither fenced nor remembered.
    if (store === null || isCanary) {
      return await execute(envelope, job, handler, release);
    }
    const pending = runRemembered(store, envelope, job, handler, release);
    inProgress.set(key, pending);
    try {
      return await pending;
    } finally {
      if (inProgress.get(key) === pending) {
        inProgress.delete(key);
      }
    }
  };

  /** The handshake document: the public one, or the full one for a signed request. */
  const handshake = async (request: Request): Promise<Response> => {
    const header = request.headers.get(REMOTE_HEADERS.signature);
    const id = request.headers.get(REMOTE_HEADERS.id);
    let authenticated: boolean | null = null;
    if (header !== null) {
      const verified = await verifyEnvelopeWith(mac, null, header, {
        direction: "request",
        secret,
        nonces,
        id,
      });
      authenticated = verified.ok;
    }
    const document: HandshakeEnvelope = {
      v: WORKER_PROTOCOL_VERSION,
      op: "handshake",
      protocols: PROTOCOLS,
      authenticated,
      maxBatch,
      maxDurationMs,
      now: Date.now(),
    };
    if (authenticated !== true) {
      return await answer(200, document, null);
    }
    secretHash ??= crypto.subtle
      .digest("SHA-256", utf8(secret[0]!) as Uint8Array<ArrayBuffer>)
      .then((digest) => toHex(new Uint8Array(digest)));
    return await answer(
      200,
      {
        ...document,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(runtime === undefined ? {} : { runtime }),
        sdk: SDK,
        names: advertised,
        maxBodyBytes,
        features,
        secretHash: await secretHash,
      } satisfies HandshakeEnvelope,
      { mac, secret, id: echoableId(id) },
    );
  };

  /** `/readyz`: accepting, and every author check passes. */
  const readyz = async (): Promise<Response> => {
    if (inFlight >= maxConcurrency) {
      return await answer(503, { ready: false, reason: "busy" }, null);
    }
    if (!allPass(await runChecks())) {
      return await answer(503, { ready: false, reason: "checks-failed" }, null);
    }
    return await answer(200, { ready: true }, null);
  };

  /** What the executor knows of one attempt, for `status`. */
  const statusOf = async (sent: RemoteJobRef): Promise<RemoteAttemptStatus> => {
    // Echo only the fields a ref has, never unknown ones that rode along.
    const ref = {
      queue: { ns: sent.queue.ns, queue: sent.queue.queue },
      job: sent.job,
      attempt: sent.attempt,
    };
    const id = attemptId(ref.queue, ref.job, ref.attempt);
    const unknown: RemoteAttemptStatus = { ...ref, state: "unknown" };
    if (store !== null) {
      const now = Date.now();
      const alias = await store.get(`s:${id}`, now);
      if (alias?.kind === "alias") {
        const record = await store.get(`a:${alias.key}`, now);
        if (record?.kind === "done") {
          return { ...ref, state: "done", outcome: record.outcome };
        }
        if (record?.kind === "running") {
          return { ...ref, state: "running" };
        }
      }
    }
    return controllers.has(id) ? { ...ref, state: "running" } : unknown;
  };

  /** Answers an authenticated, parsed request envelope. */
  const dispatch = async (
    envelope:
      | InvokeEnvelope
      | CancelEnvelope
      | PingEnvelope
      | HealthEnvelope
      | StatusEnvelope,
    signer: Signer,
  ): Promise<Response> => {
    switch (envelope.op) {
      case "invoke": {
        const seen = new Set<string>();
        const issues = envelope.jobs.flatMap((job, index) => {
          if (seen.has(job.id)) {
            return [
              {
                target: "body" as const,
                path: `jobs.${index}.id`,
                message: "A job id may appear once per invoke",
              },
            ];
          }
          seen.add(job.id);
          return [];
        });
        if (issues.length > 0) {
          return await problem(400, "VALIDATION", { issues }, signer);
        }
        const outcomes = await Promise.all(
          envelope.jobs.map((job, index) =>
            index < maxBatch
              ? runJob(envelope, job)
              : Promise.resolve(rejected(job, "BUSY", 0)),
          ),
        );
        return await answer(
          200,
          {
            v: WORKER_PROTOCOL_VERSION,
            op: "invoke-result",
            id: envelope.id,
            now: Date.now(),
            outcomes,
            capacity: capacity(),
          },
          signer,
        );
      }
      case "cancel": {
        const jobs = envelope.jobs.map((ref) => {
          const queue = { ns: ref.queue.ns, queue: ref.queue.queue };
          const controller = controllers.get(
            attemptId(queue, ref.job, ref.attempt),
          );
          const cancelled =
            controller !== undefined && !controller.signal.aborted;
          if (cancelled) {
            const reason = new Error(
              `Cancelled by the gateway${envelope.reason ? ` (${envelope.reason})` : ""}`,
            );
            reason.name = "AbortError";
            controller.abort(reason);
          }
          return { queue, job: ref.job, attempt: ref.attempt, cancelled };
        });
        return await answer(
          200,
          {
            v: WORKER_PROTOCOL_VERSION,
            op: "cancel-result",
            id: envelope.id,
            jobs,
            at: Date.now(),
          },
          signer,
        );
      }
      case "ping":
        return await answer(
          200,
          {
            v: WORKER_PROTOCOL_VERSION,
            op: "pong",
            id: envelope.id,
            capacity: capacity(),
            at: Date.now(),
          },
          signer,
        );
      case "health": {
        const checks = await runChecks();
        const current = capacity();
        return await answer(
          200,
          {
            v: WORKER_PROTOCOL_VERSION,
            op: "health-result",
            id: envelope.id,
            ok: current.accepting === true && allPass(checks),
            capacity: current,
            checks,
            at: Date.now(),
          },
          signer,
        );
      }
      case "status":
        return await answer(
          200,
          {
            v: WORKER_PROTOCOL_VERSION,
            op: "status-result",
            id: envelope.id,
            jobs: await Promise.all(envelope.jobs.map(statusOf)),
            at: Date.now(),
          },
          signer,
        );
    }
  };

  /** A `POST`: protocol, size, signature, JSON, schema, then the op. */
  const post = async (request: Request): Promise<Response> => {
    const version = request.headers.get(REMOTE_HEADERS.protocol);
    if (version !== null && !PROTOCOLS.map(String).includes(version.trim())) {
      return await problem(
        400,
        "UNSUPPORTED_PROTOCOL",
        {
          detail: `This executor speaks protocol ${PROTOCOLS.join(", ")}`,
          supported: PROTOCOLS,
        },
        null,
      );
    }
    let raw: Uint8Array;
    try {
      raw = await readBounded(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof RemoteMessageTooLargeError) {
        return await problem(
          413,
          "TOO_LARGE",
          {
            detail: error.message,
            context: { bytes: error.bytes, max: error.max },
          },
          null,
        );
      }
      throw error;
    }
    const verified = await verifyEnvelopeWith(
      mac,
      raw,
      request.headers.get(REMOTE_HEADERS.signature),
      { direction: "request", secret, nonces },
    );
    if (!verified.ok) {
      return await problem(
        401,
        verified.code,
        {
          detail: verified.detail,
          ...(verified.skewMs === undefined
            ? {}
            : { context: { skewMs: verified.skewMs } }),
        },
        null,
      );
    }

    const signer: Signer = {
      mac,
      secret,
      id: echoableId(request.headers.get(REMOTE_HEADERS.id)),
    };
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return await problem(
        400,
        "VALIDATION",
        {
          detail: "The body is not UTF-8 JSON",
          issues: [{ target: "body", path: "", message: "Not valid JSON" }],
        },
        signer,
      );
    }
    const sent = (value as { v?: unknown } | null)?.v;
    if (typeof sent === "number" && !PROTOCOLS.includes(sent as 1)) {
      return await problem(
        400,
        "UNSUPPORTED_PROTOCOL",
        {
          detail: `This executor speaks protocol ${PROTOCOLS.join(", ")}`,
          supported: PROTOCOLS,
        },
        signer,
      );
    }
    const parsed = parseRemoteRequest(value);
    if (!parsed.ok) {
      const [first] = parsed.issues;
      if (
        parsed.issues.length === 1 &&
        first!.path === "op" &&
        first!.message === "Unsupported op"
      ) {
        const op = (value as { op?: unknown } | null)?.op;
        return await problem(
          400,
          "UNSUPPORTED_OP",
          {
            detail: `This executor does not accept ${typeof op === "string" ? `"${op}"` : "a message without an op"}`,
          },
          signer,
        );
      }
      return await problem(
        400,
        "VALIDATION",
        {
          detail: "The message does not match its op's schema",
          issues: parsed.issues.map((issue) => ({
            target: "body" as const,
            path: issue.path,
            message: issue.message,
          })),
        },
        signer,
      );
    }
    const envelope = parsed.value;
    return await dispatch(envelope, {
      ...signer,
      id: echoableId(envelope.id) ?? signer.id,
    });
  };

  const route = async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD") {
      const segment = lastSegment(request);
      const response =
        segment === "healthz"
          ? await answer(200, { ok: true }, null)
          : segment === "readyz"
            ? await readyz()
            : await handshake(request);
      return method === "HEAD" ? headless(response) : response;
    }
    if (method !== "POST") {
      return await problem(
        405,
        "UNSUPPORTED_OP",
        {
          detail: "GET answers the handshake; every other operation is a POST",
          headers: { allow: "GET, HEAD, POST" },
        },
        null,
      );
    }
    return await post(request);
  };

  return async (request) => {
    try {
      return await route(request);
    } catch (error) {
      log("error", "The remote executor failed to answer a request", {
        error: error instanceof Error ? error.message : String(error),
      });
      return await problem(
        500,
        "INTERNAL",
        {
          // A configuration mistake is ours to name; anything else stays generic.
          detail:
            error instanceof ConfigError
              ? error.message
              : "The executor failed to answer",
        },
        null,
      );
    }
  };
}

/**
 * Builds the reference remote executor: a fetch handler,
 * `(request: Request) => Promise<Response>`, that answers the handshake and
 * every unary operation of the remote-worker protocol, verifies every
 * request's signature, signs every answer to an authenticated one,
 * de-duplicates by idempotency key, refuses a stale fence, and runs each job
 * with the handler registered for its name.
 *
 * It imports nothing platform-specific: mount it in `Bun.serve`, bun-common's
 * router, a Next.js route, a Cloudflare Worker or anything else that turns a
 * `Request` into a `Response`. Throws `ConfigError` for unusable options.
 *
 * ```ts
 * const executor = createRemoteExecutor({
 *   secret: process.env.BUN_JOBS_SECRET!,
 *   handlers: { "resize-image": async (job) => await resize(job.data) },
 * });
 * Bun.serve({ port: 8080, idleTimeout: 255, fetch: executor });
 * ```
 */
export function createRemoteExecutor(
  options: RemoteExecutorOptions,
): RemoteExecutor {
  return createRemoteExecutorWith(subtleHmacSha256, options);
}
