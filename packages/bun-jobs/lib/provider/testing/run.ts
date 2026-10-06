import type { LogEvent } from "@kingsleyweb/bun-common";
import type { DriverConfig, QueueDemand } from "../../drivers/index";
import type { Summoner, SummonRequest } from "../../summon/types";
import type { ProviderCallContext } from "../context";
import type {
  ProviderIdentity,
  SummonCapabilities,
  SummonFacet,
} from "../define";
import type { FakeInternals, FakePlatform } from "./fake";
import type { ConformanceCheck } from "./report";
import { Buffer } from "node:buffer";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { wireRequest } from "../../summon/controller";
import { attemptId, dedupeKeyFor } from "../../summon/marker";
import { providerCallContext } from "../context";
import { redactingLogger, textRedactor } from "../redact";

/**
 * The state one conformance run shares between its check groups: the
 * provider as configured, the fake, the call context the kit hands the
 * provider, and everything collected for the secrets scan. Internal.
 */

/** The timer functions as they were when this module loaded: the kit's own timers are never the provider's. */
export const KIT_TIMERS = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
} as const;

/** How long one provider call may take before the kit gives up on it, in ms. */
export const CALL_DEADLINE_MS = 15_000;

/** The queue the kit's direct calls name, in the run's own namespace ({@link KitRun.namespace}). */
export const DIRECT_QUEUE = "work";

/** A worker's longest life the kit asks for when the platform allows it, in ms. */
export const KIT_LIFETIME_MS = 3_600_000;

/** A call's outcome: its value, or what it threw. */
export type CallOutcome<T> =
  | {
      /** It answered. */
      ok: true;
      /** What it answered. */
      value: T;
    }
  | {
      /** It threw, or outlived its deadline. */
      ok: false;
      /** What it threw. */
      error: unknown;
    };

/** The kit's timeout: a provider call outlived {@link CALL_DEADLINE_MS}. */
export class KitDeadlineError extends Error {
  constructor(ms: number) {
    super(`the call did not settle within ${ms}ms`);
    this.name = "KitDeadlineError";
  }
}

/** One conformance run's shared state. */
export interface KitRun {
  /** The provider's identity. */
  readonly identity: ProviderIdentity;
  /** The provider as configured: what a controller is handed. */
  readonly summoner: Summoner;
  /** Its summon facet. */
  readonly facet: SummonFacet;
  /** The facet's declared capabilities. */
  readonly capabilities: SummonCapabilities;
  /**
   * The namespace the kit's direct calls name: random per run, so two kit
   * runs never share one, and purged by the handoff with the rest.
   */
  readonly namespace: string;
  /**
   * The fake, or `undefined` for a provider with no platform API, which
   * starts its units itself (`localCompute`): see {@link KitRun.selfHosted}.
   */
  readonly platform: FakePlatform | undefined;
  /** The fake's internals, when there is a fake. */
  readonly internals: FakeInternals | undefined;
  /**
   * Whether the provider starts its units itself, with no platform to fake:
   * units are then known only by the handles `summon` answers and what
   * `status()` says of them, and the checks that need a platform to inject
   * a fault into or record a request on are skipped.
   */
  readonly selfHosted: boolean;
  /** Every handle a call answered, in order: a self-hosted run's units, stopped when it ends. */
  readonly handles: Set<string>;
  /** How many times the provider called `ctx.fetch`: a self-hosted provider must not at all. */
  fetchCalls: () => number;
  /** The backend the handoff and the compare-and-set check run on, when given. */
  readonly driver: DriverConfig | undefined;
  /**
   * A fresh instance of the provider, configured as {@link KitRun.summoner}
   * was and not yet awaited (an asynchronous config is then still
   * validating), or that same summoner when the kit was given one configured.
   */
  readonly fresh: () => Summoner;
  /** The secret values (canaries) the scan looks for. */
  readonly secrets: string[];
  /** Everything bun-jobs would write, collected for the secrets scan. */
  readonly scanned: unknown[];
  /** Every log line the provider and the kit's controllers wrote. */
  readonly logs: LogEvent[];
  /** The `ctx.fetch` the kit hands the provider: tags requests to the fake. */
  readonly fetch: typeof fetch;
  /** A logger collecting into {@link KitRun.logs}. */
  readonly logger: ReturnType<typeof createTestLogger>["logger"];
  /** A call context whose signal is `signal`, logging through the redacting pipeline. */
  context: (signal: AbortSignal) => ProviderCallContext;
  /**
   * Calls the provider with a fresh context, aborting its signal at
   * `deadlineMs`, and records what came back for the secrets scan.
   */
  call: <T>(
    fn: (context: ProviderCallContext) => Promise<T>,
    deadlineMs?: number,
  ) => Promise<CallOutcome<T>>;
  /** A request as the controller builds one, for a fresh attempt id unless `id` is given. */
  request: (options?: {
    /** The attempt id. */
    id?: string;
    /** Workers wanted. Defaults to `1`. */
    count?: number;
    /** The scale target. Defaults to `count`. */
    target?: number;
    /** The worker's longest life, in ms. */
    maxLifetimeMs?: number;
    /** The request's `env` (the policy's static environment). Defaults to `{}`. */
    env?: Readonly<Record<string, string>>;
  }) => SummonRequest;
  /** Records a check's outcome. */
  set: (
    id: string,
    status: ConformanceCheck["status"],
    detail?: string,
  ) => void;
  /** Whether a check is to run: it exists and the caller did not skip it. */
  wanted: (id: string) => boolean;
  /** Units started so far: the fake's, or for a self-hosted provider the distinct handles answered. */
  unitCount: () => number;
  /**
   * A host-side failure (a controller, a driver, the kit itself) for a
   * report: its name, code and message, with the run's secrets redacted.
   */
  explain: (error: unknown) => string;
}

/** A random hex string. */
export function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "hex",
  );
}

/** A demand reading for `count` waiting jobs. */
function demandFor(count: number): QueueDemand {
  return {
    at: Date.now(),
    paused: false,
    waiting: count,
    dueNow: 0,
    stalled: 0,
    active: 0,
    workers: 0,
    nextDueAt: null,
    demand: count,
    outstanding: count,
    capped: false,
    exact: true,
  };
}

/** The longest life the kit asks a worker for: an hour, or the platform's cap below it. */
export function kitLifetime(capabilities: SummonCapabilities): number {
  return capabilities.maxLifetimeMs === null
    ? KIT_LIFETIME_MS
    : Math.min(KIT_LIFETIME_MS, capabilities.maxLifetimeMs);
}

/** Builds a run's shared state. */
export function createRun(input: {
  /** The provider's identity. */
  identity: ProviderIdentity;
  /** The configured provider. */
  summoner: Summoner;
  /** The fake, when there is one. */
  platform: FakePlatform | undefined;
  /** Its internals, when there is a fake. */
  internals: FakeInternals | undefined;
  /** The handoff's backend, when given. */
  driver: DriverConfig | undefined;
  /** A fresh configured instance. */
  fresh: () => Summoner;
  /** The secrets to scan for. */
  secrets: string[];
  /** Records a check's outcome. */
  set: KitRun["set"];
  /** Whether a check is to run. */
  wanted: KitRun["wanted"];
}): KitRun {
  const { logger, events } = createTestLogger();
  const facet = input.summoner.summon;
  const capabilities = facet.capabilities;
  const scanned: unknown[] = [];
  const handles = new Set<string>();
  const origin =
    input.platform === undefined
      ? undefined
      : new URL(input.platform.url).origin;
  const tag = input.internals?.tag;
  const epoch = randomHex(8);
  const namespace = `conformance-direct-${randomHex(6)}`;
  input.internals?.namespaces.push(namespace);
  let version = 0;

  let fetchCalls = 0;
  const kitFetch = Object.assign(
    async (
      target: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      fetchCalls++;
      const request =
        target instanceof Request
          ? new Request(target, init)
          : new Request(String(target), init);
      if (tag !== undefined && new URL(request.url).origin === origin) {
        const headers = new Headers(request.headers);
        headers.set(tag.header, tag.value);
        return await fetch(new Request(request, { headers }));
      }
      return await fetch(request);
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;

  const context = (signal: AbortSignal): ProviderCallContext =>
    providerCallContext(
      signal,
      redactingLogger(logger, input.secrets),
      kitFetch,
    );

  const run: KitRun = {
    identity: input.identity,
    summoner: input.summoner,
    facet,
    capabilities,
    namespace,
    platform: input.platform,
    internals: input.internals,
    selfHosted: input.platform === undefined,
    handles,
    fetchCalls: () => fetchCalls,
    driver: input.driver,
    fresh: input.fresh,
    secrets: input.secrets,
    scanned,
    logs: events,
    fetch: kitFetch,
    logger,
    context,
    call: async (fn, deadlineMs = CALL_DEADLINE_MS) => {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = KIT_TIMERS.setTimeout(() => {
          const error = new KitDeadlineError(deadlineMs);
          abort.abort(error);
          reject(error);
        }, deadlineMs);
      });
      try {
        const value = await Promise.race([fn(context(abort.signal)), deadline]);
        scanned.push(value);
        for (const handle of answeredHandles(value)) {
          handles.add(handle);
        }
        return { ok: true, value };
      } catch (error) {
        scanned.push(error);
        return { ok: false, error };
      } finally {
        KIT_TIMERS.clearTimeout(timer);
      }
    },
    request: (options = {}) => {
      const count = options.count ?? 1;
      const id =
        options.id ?? attemptId(namespace, DIRECT_QUEUE, epoch, ++version);
      return {
        ...wireRequest(
          { id, count, target: options.target ?? count },
          {
            namespace,
            queue: DIRECT_QUEUE,
            kind: input.identity.kind,
            style: capabilities.style,
            dedupeKey: dedupeKeyFor(capabilities.dedupe),
            graceMs: capabilities.shutdown.graceMs,
            maxLifetime: options.maxLifetimeMs ?? kitLifetime(capabilities),
            env: { ...options.env },
          },
        ),
        demand: demandFor(count),
        reason: "poll",
      };
    },
    set: input.set,
    wanted: input.wanted,
    unitCount: () => input.internals?.unitCount() ?? handles.size,
    explain: (error) => {
      const what = describeThrown(error);
      const message = error instanceof Error ? error.message : "";
      return message === ""
        ? what
        : `${what}: ${textRedactor(input.secrets)(message)}`;
    },
  };
  return run;
}

/**
 * The fake and its internals, for a check group that never runs
 * self-hosted (its checks are skipped there).
 *
 * @throws {Error} on a self-hosted run: a kit bug, never a provider's.
 */
export function fakeOf(run: KitRun): {
  /** The fake. */
  platform: FakePlatform;
  /** Its internals. */
  internals: FakeInternals;
} {
  if (run.platform === undefined || run.internals === undefined) {
    throw new Error(
      "the conformance kit ran a platform check with no platform",
    );
  }
  return { platform: run.platform, internals: run.internals };
}

/** The handles a call's value carries, when it is a `SummonResult` with some. */
function answeredHandles(value: unknown): string[] {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return [];
  }
  const handles = (value as { handles?: unknown }).handles;
  return Array.isArray(handles)
    ? handles.filter((handle): handle is string => typeof handle === "string")
    : [];
}

/** A short, secret-free name for what a call threw. */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0
      ? `${error.name} (${code})`
      : error.name;
  }
  return typeof error;
}
