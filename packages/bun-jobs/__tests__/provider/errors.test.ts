import type { LogEvent } from "@kingsleyweb/bun-common";
import type {
  JobsDriver,
  SummonControllerOptions,
  SummonEventPayload,
  SummonMarker,
  SummonPolicy,
} from "../../lib/index";
import type {
  ProviderErrorKind,
  SummonCapabilities,
  SummonFacet,
  SummonResult,
  UnitStatus,
} from "../../lib/provider/index";
import { join } from "node:path";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  ConfigError,
  createDriver,
  defineSummoner,
  JobsError,
  ProviderError as RootProviderError,
  SummonController,
} from "../../lib/index";
import { providerErrorFacts } from "../../lib/provider/errors";
import {
  defineComputeProvider,
  ProviderError,
  toStandardSchema,
} from "../../lib/provider/index";
import { SUMMON_MARKER } from "../../lib/summon/marker";
import { makeTmpDir, testNamespace, waitFor } from "../helpers";

/**
 * `ProviderError` and what the controller does with each kind (plugins §6.5,
 * summon-compute §13.10 PR-p2): the outcome, whether it counts toward the
 * circuit, the backoff, the circuit opening at once, the detail, and the
 * logs. Every kind has a negative control: the same failure thrown as a plain
 * `Error` is `transient` — `failed`, counted, the ordinary backoff — exactly
 * as before provider errors existed. Plus `status()`'s explanation of a lost
 * attempt, and the two warnings (a short grace, an unmapped throw).
 *
 * One file backend is enough: none of this depends on the driver.
 */

const dir = await makeTmpDir("bun-jobs-provider-errors");
afterAll(dir.cleanup);

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

/** Triggers off, no cooldown, a 5 ms backoff: every check is one the test asked for. */
const QUIET: Partial<SummonControllerOptions> = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  backoff: { initial: 5, max: 5 },
};

const CAPABILITIES: SummonCapabilities = {
  style: "launch",
  dedupe: { kind: "none" },
  passes: "argv",
  bootBudgetMs: 20_000,
  shutdown: { signal: "SIGTERM", graceMs: 10_000 },
  maxLifetimeMs: null,
  enforcesLifetime: false,
};

let unique = 0;

/**
 * A plugin provider whose `summon` throws what `next()` answers for each
 * call (or starts a unit when it answers `undefined`). Unique per call, so
 * the once-per-process warnings are its own.
 */
function throwing(
  next: (call: number) => unknown,
  options: {
    capabilities?: Partial<SummonCapabilities>;
    secrets?: boolean;
  } = {},
) {
  const counts = { calls: 0 };
  const name = `test-errors-${++unique}`;
  const provider = defineComputeProvider({
    name,
    version: "1.0.0",
    kind: "errs",
    apiVersion: { core: "0.1", summon: "0.1" },
    ...(options.secrets
      ? {
          config: toStandardSchema<{ token: string }>((input) => ({
            value: input as { token: string },
          })),
          secrets: ["token"],
        }
      : {}),
    summon: (): SummonFacet => ({
      capabilities: { ...CAPABILITIES, ...options.capabilities },
      summon: async () => {
        const thrown = next(++counts.calls);
        if (thrown !== undefined) {
          throw thrown;
        }
        return { status: "started", handles: [`unit-${counts.calls}`] };
      },
    }),
  });
  return {
    name,
    counts,
    summoner: options.secrets
      ? provider({ token: "s3cr3t-token-value-1234" })
      : provider(),
  };
}

/** A fresh driver, namespace and queue, with one job waiting; closed after the test. */
async function setup(): Promise<{
  driver: JobsDriver;
  namespace: string;
  controller: (
    policy: Partial<SummonPolicy> &
      Pick<SummonPolicy, "summoner"> & {
        logger?: SummonControllerOptions["logger"];
      },
  ) => SummonController;
  events: SummonEventPayload[];
  marker: () => Promise<SummonMarker>;
}> {
  const driver = createDriver({
    type: "file",
    root: join(dir.path, testNamespace("root")),
  });
  await driver.connect();
  const namespace = testNamespace("provider-errors");
  const events: SummonEventPayload[] = [];
  const owned: { close: () => Promise<unknown> }[] = [];
  perTest.push(async () => {
    for (const one of owned) {
      await one.close().catch(() => {});
    }
    await driver.purge(namespace);
    await driver.close();
  });
  const queue = new BunQueue("work", {
    namespace,
    driver,
    logger: noopLogger,
  });
  owned.push(queue);
  await queue.add("job", {});
  return {
    driver,
    namespace,
    events,
    marker: async () =>
      (
        await driver.getQueueState!(
          { ns: namespace, queue: "work" },
          SUMMON_MARKER,
        )
      )?.value as SummonMarker,
    controller: (policy) => {
      const controller = new SummonController({
        logger: noopLogger,
        ...QUIET,
        ...policy,
        driver,
        namespace,
        queue: "work",
      });
      controller.on("summon", (event) => events.push(event));
      owned.unshift(controller);
      return controller;
    },
  };
}

/** The log lines at `level` whose message contains `text`. */
function logged(logs: LogEvent[], level: string, text: string): LogEvent[] {
  return logs.filter(
    (event) => event.level === level && event.message.includes(text),
  );
}

/** A plain `Error` carrying the same fields a `ProviderError` of `kind` would, but no `kind`. */
function plainLike(
  kind: ProviderErrorKind,
  fields: { platformCode?: string; retryAfterMs?: number } = {},
): Error {
  return Object.assign(new Error(`a plain ${kind}`), {
    code: `PROVIDER_${kind.toUpperCase()}`,
    ...fields,
  });
}

describe("ProviderError", () => {
  it("carries its kind as PROVIDER_<KIND>, and what the platform said", () => {
    const cause = new Error("429 from the platform");
    const error = new ProviderError("the platform is throttling", "throttled", {
      platformCode: "ThrottlingException",
      status: 429,
      retryAfterMs: 1_500.2,
      cause,
    });
    expect(error).toBeInstanceOf(JobsError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ProviderError");
    expect(error.code).toBe("PROVIDER_THROTTLED");
    expect(error.kind).toBe("throttled");
    expect(error.platformCode).toBe("ThrottlingException");
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(1_501);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("the platform is throttling");
    expect(error.context).toEqual({
      kind: "throttled",
      platformCode: "ThrottlingException",
      status: 429,
      retryAfterMs: 1_501,
    });
    // The same class on both entries.
    expect(RootProviderError).toBe(ProviderError);

    const codes = (
      [
        "transient",
        "throttled",
        "quota",
        "auth",
        "misconfigured",
        "conflict",
      ] as const
    ).map((kind) => new ProviderError("x", kind).code);
    expect(codes).toEqual([
      "PROVIDER_TRANSIENT",
      "PROVIDER_THROTTLED",
      "PROVIDER_QUOTA",
      "PROVIDER_AUTH",
      "PROVIDER_MISCONFIGURED",
      "PROVIDER_CONFLICT",
    ]);
  });

  it("drops a retryAfterMs that is not a finite number of 0 or more, and an empty platformCode", () => {
    for (const retryAfterMs of [Number.NaN, -1, Infinity]) {
      const error = new ProviderError("x", "throttled", { retryAfterMs });
      expect(error.retryAfterMs).toBeUndefined();
      expect(error.context).toEqual({ kind: "throttled" });
    }
    expect(
      new ProviderError("x", "quota", { platformCode: "" }).platformCode,
    ).toBeUndefined();
    expect(new ProviderError("x", "auth").context).toEqual({ kind: "auth" });
  });

  it("refuses a kind that is not one of the six", () => {
    expect(
      () => new ProviderError("x", "capacity" as ProviderErrorKind),
    ).toThrow(ConfigError);
  });

  it("is recognised by shape too, as one from another copy of the package would be", () => {
    const copy = Object.assign(new Error("from another copy"), {
      kind: "quota",
      code: "PROVIDER_QUOTA",
      retryAfterMs: 10,
    });
    expect(providerErrorFacts(copy)).toEqual({
      kind: "quota",
      code: "PROVIDER_QUOTA",
      retryAfterMs: 10,
    });
    // Negative controls: a code without a kind, a kind whose code disagrees,
    // an unknown kind, and a non-Error.
    expect(providerErrorFacts(plainLike("quota"))).toBeUndefined();
    expect(
      providerErrorFacts(
        Object.assign(new Error("x"), { kind: "auth", code: "PROVIDER_QUOTA" }),
      ),
    ).toBeUndefined();
    expect(
      providerErrorFacts(
        Object.assign(new Error("x"), {
          kind: "capacity",
          code: "PROVIDER_CAPACITY",
        }),
      ),
    ).toBeUndefined();
    expect(
      providerErrorFacts({ kind: "auth", code: "PROVIDER_AUTH" }),
    ).toBeUndefined();
  });
});

describe("SummonController and each ProviderError kind", () => {
  it("throttled: unavailable, not counted toward the circuit, backed off at least retryAfterMs", async () => {
    const { controller, events } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner } = throwing(
      () =>
        new ProviderError("slow down", "throttled", {
          platformCode: "ThrottlingException",
          retryAfterMs: 60_000,
        }),
    );
    const summon = controller({
      summoner,
      logger,
      circuit: { failures: 1, resetAfter: 60_000 },
    });
    const before = Date.now();
    expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
    const status = await summon.status();
    expect(status.failures).toBe(0);
    expect(status.circuitOpenUntil).toBeUndefined();
    expect(status.backoffUntil).toBeGreaterThanOrEqual(before + 60_000);
    expect(status.pending).toEqual([]);
    expect(status.last).toMatchObject({
      outcome: "unavailable",
      detail: "ThrottlingException",
    });
    expect(events.at(-1)).toMatchObject({
      outcome: "unavailable",
      detail: "ThrottlingException",
    });
    expect(await summon.check()).toMatchObject({ reason: "backoff" });
    // Not the per-call error: a refusal is a warn.
    expect(logged(logs, "error", "summoner call failed")).toEqual([]);
    expect(logged(logs, "warn", "summoner call refused")).toHaveLength(1);
    expect(logged(logs, "error", "circuit")).toEqual([]);
  });

  it("throttled without retryAfterMs: the ordinary backoff, and never the circuit however many", async () => {
    const { controller } = await setup();
    const { summoner, counts } = throwing(
      () => new ProviderError("slow down", "throttled"),
    );
    const summon = controller({
      summoner,
      circuit: { failures: 2, resetAfter: 60_000 },
    });
    for (let i = 0; i < 4; i++) {
      expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
      await Bun.sleep(15);
    }
    expect(counts.calls).toBe(4);
    const status = await summon.status();
    expect(status.failures).toBe(0);
    expect(status.circuitOpenUntil).toBeUndefined();
    expect(status.last?.detail).toBe("PROVIDER_THROTTLED");
  });

  it("throttled, negative control: the same failure as a plain Error is failed and counted, and its retryAfterMs ignored", async () => {
    const { controller, events } = await setup();
    const { summoner } = throwing(() =>
      plainLike("throttled", {
        platformCode: "ThrottlingException",
        retryAfterMs: 60_000,
      }),
    );
    const summon = controller({
      summoner,
      circuit: { failures: 1, resetAfter: 60_000 },
    });
    const before = Date.now();
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    const status = await summon.status();
    expect(status.failures).toBe(1);
    expect(status.circuitOpenUntil).toBeNumber();
    // The 5 ms backoff, not the minute: only a ProviderError's is honoured.
    expect(status.backoffUntil ?? 0).toBeLessThan(before + 60_000);
    // Its code, as any error's: not its platformCode.
    expect(events.at(-1)).toMatchObject({
      outcome: "failed",
      detail: "PROVIDER_THROTTLED",
    });
  });

  it("quota: unavailable, counted toward the circuit, backed off at least retryAfterMs", async () => {
    const { controller } = await setup();
    const { summoner } = throwing(
      () =>
        new ProviderError("vCPU limit", "quota", {
          platformCode: "VcpuLimitExceeded",
          retryAfterMs: 30_000,
        }),
    );
    const summon = controller({
      summoner,
      circuit: { failures: 2, resetAfter: 60_000 },
    });
    const before = Date.now();
    expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
    const status = await summon.status();
    expect(status.failures).toBe(1);
    expect(status.circuitOpenUntil).toBeUndefined();
    expect(status.backoffUntil).toBeGreaterThanOrEqual(before + 30_000);
    expect(status.last).toMatchObject({
      outcome: "unavailable",
      detail: "VcpuLimitExceeded",
    });
    expect(await summon.check({ force: true })).toMatchObject({
      reason: "backoff",
    });
  });

  it("quota counts: two of them open a two-failure circuit", async () => {
    const { controller } = await setup();
    const { summoner } = throwing(() => new ProviderError("limit", "quota"));
    const summon = controller({
      summoner,
      circuit: { failures: 2, resetAfter: 60_000 },
    });
    expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
    await Bun.sleep(15);
    expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
    const status = await summon.status();
    expect(status.failures).toBe(2);
    expect(status.circuitOpenUntil).toBeNumber();
  });

  it("quota, negative control: a plain Error is failed, not unavailable", async () => {
    const { controller } = await setup();
    const { summoner } = throwing(() =>
      plainLike("quota", { retryAfterMs: 30_000 }),
    );
    const summon = controller({ summoner });
    const before = Date.now();
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    const status = await summon.status();
    expect(status.failures).toBe(1);
    expect(status.backoffUntil ?? 0).toBeLessThan(before + 30_000);
  });

  for (const kind of ["auth", "misconfigured"] as const) {
    it(`${kind}: failed, and the circuit opens at once, with one error naming the provider`, async () => {
      const { controller, events, marker } = await setup();
      const { logger, events: logs } = createTestLogger();
      const { summoner, name, counts } = throwing(
        () => new ProviderError("rejected", kind),
      );
      const summon = controller({
        summoner,
        logger,
        circuit: { failures: 5, resetAfter: 60_000 },
      });
      expect(await summon.check()).toMatchObject({ outcome: "failed" });
      const status = await summon.status();
      expect(status.circuitOpenUntil).toBeNumber();
      // What the circuit reads is raised to its threshold, as a run of
      // failures would have: `failures`, and the streak a late loss reads.
      expect(status.failures).toBe(5);
      expect((await marker()).lossStreak).toBe(5);
      expect(status.last).toMatchObject({
        outcome: "failed",
        detail: `PROVIDER_${kind.toUpperCase()}`,
      });
      expect(events.at(-1)).toMatchObject({
        outcome: "failed",
        detail: `PROVIDER_${kind.toUpperCase()}`,
      });
      const named = logged(logs, "error", `compute provider ${name}`);
      expect(named).toHaveLength(1);
      expect(named[0]!.message).toContain(`PROVIDER_${kind.toUpperCase()}`);
      expect(named[0]!.message).toContain("open at once");
      // Not also the by-count line: one error about the circuit.
      expect(logged(logs, "error", "too many consecutive failures")).toEqual(
        [],
      );
      // Still the per-call error every failure logs.
      expect(logged(logs, "error", "summoner call failed")).toHaveLength(1);

      expect(await summon.check({ force: true })).toMatchObject({
        reason: "circuit-open",
      });
      expect(counts.calls).toBe(1);
    });
  }

  it("auth, negative control: a plain Error — even one coded PROVIDER_AUTH — is one failure, and the circuit stays closed", async () => {
    const { controller, events, marker } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner } = throwing((call) =>
      call === 1 ? plainLike("auth") : new Error("401 Unauthorized"),
    );
    const summon = controller({
      summoner,
      logger,
      circuit: { failures: 5, resetAfter: 60_000 },
    });
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    let status = await summon.status();
    expect(status.failures).toBe(1);
    expect((await marker()).lossStreak).toBe(1);
    expect(status.circuitOpenUntil).toBeUndefined();
    expect(events.at(-1)?.detail).toBe("PROVIDER_AUTH");
    await Bun.sleep(15);
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    status = await summon.status();
    expect(status.failures).toBe(2);
    expect(status.circuitOpenUntil).toBeUndefined();
    expect(status.last?.detail).toBe("Error");
    expect(logged(logs, "error", "compute provider")).toEqual([]);
  });

  it("auth opens the circuit half-open: after resetAfter, the next failure of any kind reopens it", async () => {
    const { controller } = await setup();
    let first = true;
    const { summoner } = throwing(() => {
      if (first) {
        first = false;
        return new ProviderError("expired", "auth");
      }
      return new Error("boom");
    });
    const summon = controller({
      summoner,
      circuit: { failures: 3, resetAfter: 50 },
    });
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    expect(await summon.check()).toMatchObject({ reason: "circuit-open" });
    await Bun.sleep(80);
    // Closed again; one plain failure reopens it, since nothing succeeded.
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    expect((await summon.status()).circuitOpenUntil).toBeNumber();
  });

  it("half-open, negative control: without the auth failure, the same plain failures leave a three-failure circuit closed", async () => {
    const { controller } = await setup();
    const { summoner } = throwing(() => new Error("boom"));
    const summon = controller({
      summoner,
      circuit: { failures: 3, resetAfter: 50 },
    });
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    await Bun.sleep(80);
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    expect((await summon.status()).circuitOpenUntil).toBeUndefined();
  });

  it("conflict: failed and counted, with one error saying the provider is not a pure function of its key", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner, name } = throwing(
      () =>
        new ProviderError("token reused with other parameters", "conflict", {
          platformCode: "IdempotentParameterMismatch",
        }),
    );
    const summon = controller({ summoner, logger });
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    const status = await summon.status();
    expect(status.failures).toBe(1);
    expect(status.circuitOpenUntil).toBeUndefined();
    expect(status.last?.detail).toBe("IdempotentParameterMismatch");
    const bug = logged(logs, "error", "not a pure function of its key");
    expect(bug).toHaveLength(1);
    expect(bug[0]!.message).toContain(name);
  });

  it("conflict, negative control: a plain Error logs no provider bug", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner } = throwing(() => plainLike("conflict"));
    const summon = controller({ summoner, logger });
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    expect((await summon.status()).failures).toBe(1);
    expect(logged(logs, "error", "pure function")).toEqual([]);
  });

  it("transient: failed and counted, as a plain Error, but with no unmapped-throw warn", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner } = throwing(
      () => new ProviderError("502 from the platform", "transient"),
    );
    const summon = controller({ summoner, logger });
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    const status = await summon.status();
    expect(status.failures).toBe(1);
    expect(status.last?.detail).toBe("PROVIDER_TRANSIENT");
    expect(logged(logs, "warn", "other than a ProviderError")).toEqual([]);
  });
});

describe("the attempt's detail", () => {
  it("is the platformCode, else the PROVIDER_<KIND> code, else the error's code or name", async () => {
    const { controller, events } = await setup();
    const thrown = [
      new ProviderError("x", "transient", { platformCode: "ServerException" }),
      new ProviderError("x", "transient"),
      Object.assign(new Error("x"), { code: "ECONNRESET" }),
      new TypeError("x"),
    ];
    const { summoner } = throwing((call) => thrown[call - 1]);
    const summon = controller({ summoner });
    const details: (string | undefined)[] = [];
    for (let i = 0; i < thrown.length; i++) {
      await summon.check({ force: true });
      details.push((await summon.status()).last?.detail);
      await Bun.sleep(15);
    }
    expect(details).toEqual([
      "ServerException",
      "PROVIDER_TRANSIENT",
      "ECONNRESET",
      "TypeError",
    ]);
    expect(events.map((event) => event.detail)).toEqual(details);
  });

  it("has the provider's declared secrets redacted", async () => {
    const { controller, events } = await setup();
    const { summoner } = throwing(
      () =>
        new ProviderError("denied", "auth", {
          platformCode: "Denied:s3cr3t-token-value-1234",
        }),
      { secrets: true },
    );
    const summon = controller({ summoner });
    await summon.check();
    const detail = (await summon.status()).last?.detail;
    expect(detail).toStartWith("Denied:");
    expect(detail).not.toContain("s3cr3t-token-value-1234");
    expect(events.at(-1)?.detail).toBe(detail);
  });
});

describe("a provider's ready rejecting with a ProviderError", () => {
  /** A plugin whose asynchronous config validation throws what `next()` answers. */
  function rejecting(next: () => unknown) {
    const counts = { calls: 0, validations: 0 };
    const provider = defineComputeProvider({
      name: `test-errors-ready-${++unique}`,
      version: "1.0.0",
      kind: "ready",
      apiVersion: { core: "0.1", summon: "0.1" },
      config: toStandardSchema<{ region: string }>(async (input) => {
        counts.validations++;
        await Bun.sleep(1);
        const thrown = next();
        if (thrown !== undefined) {
          throw thrown;
        }
        return { value: input as { region: string } };
      }),
      summon: (): SummonFacet => ({
        capabilities: CAPABILITIES,
        summon: async () => {
          counts.calls++;
          return { status: "started", handles: [] };
        },
      }),
    });
    return { summoner: provider({ region: "eu" }), counts };
  }

  it("misconfigured opens the circuit on that check", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner, counts } = rejecting(
      () =>
        new ProviderError("no such cluster", "misconfigured", {
          platformCode: "ClusterNotFoundException",
        }),
    );
    const summon = controller({ summoner, logger });
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    const validated = counts.validations;
    const status = await summon.status();
    expect(status.circuitOpenUntil).toBeNumber();
    expect(status.last?.detail).toBe("ClusterNotFoundException");
    expect(counts.calls).toBe(0);
    expect(logged(logs, "error", "open at once")).toHaveLength(1);
    expect(await summon.check({ force: true })).toMatchObject({
      reason: "circuit-open",
    });
    // Not validated again while the circuit holds.
    expect(counts.validations).toBe(validated);
  });

  it("auth opens it too", async () => {
    const { controller } = await setup();
    const { summoner } = rejecting(() => new ProviderError("expired", "auth"));
    const summon = controller({ summoner });
    await summon.check();
    expect((await summon.status()).circuitOpenUntil).toBeNumber();
  });

  it("transient backs off only: counted once, the circuit closed", async () => {
    const { controller } = await setup();
    const { summoner } = rejecting(
      () => new ProviderError("the region's API is down", "transient"),
    );
    // A minute's backoff, so it cannot have run out by the time it is read.
    const summon = controller({
      summoner,
      backoff: { initial: 60_000, max: 60_000 },
    });
    const before = Date.now();
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    const status = await summon.status();
    expect(status.failures).toBe(1);
    expect(status.circuitOpenUntil).toBeUndefined();
    expect(status.backoffUntil).toBeGreaterThanOrEqual(before + 60_000);
    expect(status.last?.detail).toBe("PROVIDER_TRANSIENT");
  });

  it("throttled backs off only: unavailable, not counted, at least retryAfterMs", async () => {
    const { controller } = await setup();
    const { summoner } = rejecting(
      () =>
        new ProviderError("slow down", "throttled", { retryAfterMs: 60_000 }),
    );
    const summon = controller({ summoner });
    const before = Date.now();
    expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
    const status = await summon.status();
    expect(status.failures).toBe(0);
    expect(status.circuitOpenUntil).toBeUndefined();
    expect(status.backoffUntil).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("negative control: a plain Error from ready is one failure, the circuit closed", async () => {
    const { controller } = await setup();
    const { summoner } = rejecting(() => plainLike("misconfigured"));
    const summon = controller({ summoner });
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    const status = await summon.status();
    expect(status.failures).toBe(1);
    expect(status.circuitOpenUntil).toBeUndefined();
    expect(status.last?.detail).toBe("PROVIDER_MISCONFIGURED");
  });
});

describe("the unmapped-throw warn", () => {
  it("is logged once per plugin provider that throws something other than a ProviderError", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner, name } = throwing(() => new Error("boom"));
    const summon = controller({ summoner, logger });
    for (let i = 0; i < 3; i++) {
      expect(await summon.check({ force: true })).toMatchObject({
        outcome: "failed",
      });
      await Bun.sleep(15);
    }
    const warned = logged(logs, "warn", "other than a ProviderError");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain(name);
    // Once per process: another controller over the same provider says nothing.
    const again = await setup();
    const { logger: logger2, events: logs2 } = createTestLogger();
    await again.controller({ summoner, logger: logger2 }).check();
    expect(logged(logs2, "warn", "other than a ProviderError")).toEqual([]);
  });

  it("is never logged for a ProviderError, nor for defineSummoner", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const mapped = throwing(() => new ProviderError("boom", "transient"));
    await controller({ summoner: mapped.summoner, logger }).check();
    const other = await setup();
    const summon = other.controller({
      summoner: defineSummoner({
        kind: "mine",
        invoke: async () => {
          throw new Error("boom");
        },
      }),
      logger,
    });
    for (let i = 0; i < 2; i++) {
      expect(await summon.check({ force: true })).toMatchObject({
        outcome: "failed",
      });
      await Bun.sleep(15);
    }
    expect(logged(logs, "warn", "other than a ProviderError")).toEqual([]);
    // Each failure still logs its error, as it always has.
    expect(logged(logs, "error", "summoner call failed")).toHaveLength(3);
  });
});

describe("status() explaining a lost attempt", () => {
  /** A summoner that starts one unit per call and can say what became of it. */
  function explaining(
    answer: (handles: readonly string[]) => Promise<readonly UnitStatus[]>,
  ) {
    const asked: string[][] = [];
    const base = defineSummoner({
      kind: "explain",
      bootBudget: 100,
      invoke: async () => ({ status: "started", handles: ["unit-1"] }),
    });
    return {
      asked,
      summoner: {
        ...base,
        summon: {
          ...base.summon,
          status: async (handles: readonly string[]) => {
            asked.push([...handles]);
            return await answer(handles);
          },
        },
      },
    };
  }

  it("writes the first unit's detail to last.detail and to the one lost event", async () => {
    const { controller, events } = await setup();
    const { summoner, asked } = explaining(async () => [
      { handle: "unit-1", state: "failed", detail: "CannotPullContainerError" },
    ]);
    const summon = controller({ summoner, backoff: { initial: 60_000 } });
    expect(await summon.check()).toMatchObject({ outcome: "started" });
    await Bun.sleep(150);
    expect(await summon.check()).toMatchObject({ reason: "backoff" });
    await waitFor(() => events.some((event) => event.outcome === "lost"));
    expect(asked).toEqual([["unit-1"]]);
    const lost = events.filter((event) => event.outcome === "lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({
      detail: "CannotPullContainerError",
      handles: ["unit-1"],
    });
    await waitFor(
      async () =>
        (await summon.status()).last?.detail === "CannotPullContainerError",
    );
    expect((await summon.status()).last).toMatchObject({ outcome: "lost" });
  });

  it("negative control: a status with no detail leaves both without one, and the event is still announced once", async () => {
    const { controller, events } = await setup();
    const { summoner, asked } = explaining(async () => [
      { handle: "unit-1", state: "unknown" },
    ]);
    const summon = controller({ summoner, backoff: { initial: 60_000 } });
    await summon.check();
    await Bun.sleep(150);
    await summon.check();
    await waitFor(() => events.some((event) => event.outcome === "lost"));
    await summon.close();
    expect(asked).toHaveLength(1);
    const lost = events.filter((event) => event.outcome === "lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]!.detail).toBeUndefined();
    const status = await summon.status();
    expect(status.last).toMatchObject({ outcome: "lost" });
    expect(status.last?.detail).toBeUndefined();
  });

  it("announces the lost event even when status() throws", async () => {
    const { controller, events } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner } = explaining(async () => {
      throw new Error("the platform's API is down");
    });
    const summon = controller({
      summoner,
      logger,
      backoff: { initial: 60_000 },
    });
    await summon.check();
    await Bun.sleep(150);
    await summon.check();
    await summon.close();
    expect(events.filter((event) => event.outcome === "lost")).toHaveLength(1);
    expect(logged(logs, "warn", "could not explain")).toHaveLength(1);
  });

  it("close() waits for an explanation in flight, so its event is not lost", async () => {
    const { controller, events } = await setup();
    const { summoner } = explaining(async () => {
      await Bun.sleep(100);
      return [{ handle: "unit-1", state: "exited", detail: "OOMKilled" }];
    });
    const summon = controller({ summoner, backoff: { initial: 60_000 } });
    await summon.check();
    await Bun.sleep(150);
    await summon.check();
    await summon.close();
    expect(events.find((event) => event.outcome === "lost")?.detail).toBe(
      "OOMKilled",
    );
  });
});

describe("the short-grace warn", () => {
  /** The `warn`s about a grace under the shutdown buffer. */
  function graceWarnings(logs: LogEvent[]): LogEvent[] {
    return logged(logs, "warn", "shutdownBuffer");
  }

  it("is logged once per controller when a provider's grace is under runSummoned's 7,000 ms buffer", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner } = throwing(() => undefined, {
      capabilities: {
        shutdown: { signal: "SIGINT", graceMs: 5_000, graceMaxMs: 300_000 },
      },
    });
    const summon = controller({ summoner, logger });
    await summon.check();
    await summon.check({ force: true });
    const warned = graceWarnings(logs);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.fields).toMatchObject({
      graceMs: 5_000,
      shutdownBuffer: 7_000,
      graceMaxMs: 300_000,
    });
  });

  it("warns for defineSummoner only when the user set a short grace: its default is above the buffer", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    controller({
      summoner: defineSummoner({ kind: "dflt", invoke: async () => {} }),
      logger,
    });
    expect(graceWarnings(logs)).toEqual([]);
    controller({
      summoner: defineSummoner({
        kind: "fly",
        shutdown: { signal: "SIGINT", graceMs: 5_000 },
        invoke: async () => {},
      }),
      logger,
    });
    expect(graceWarnings(logs)).toHaveLength(1);
  });

  it("negative controls: a grace of exactly 7,000 ms, and a signal of none, say nothing", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    controller({
      summoner: defineSummoner({
        shutdown: { signal: "SIGTERM", graceMs: 7_000 },
        invoke: async () => {},
      }),
      logger,
    });
    controller({
      summoner: defineSummoner({
        shutdown: { signal: "none", graceMs: 0 },
        invoke: async () => {},
      }),
      logger,
    });
    expect(graceWarnings(logs)).toEqual([]);
  });

  it("waits for a late provider's real capabilities", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const provider = defineComputeProvider({
      name: `test-errors-grace-${++unique}`,
      version: "1.0.0",
      kind: "grace",
      apiVersion: { core: "0.1", summon: "0.1" },
      config: toStandardSchema<{ region: string }>(async (input) => {
        await Bun.sleep(5);
        return { value: input as { region: string } };
      }),
      summon: (): SummonFacet => ({
        capabilities: {
          ...CAPABILITIES,
          shutdown: { signal: "SIGTERM", graceMs: 2_000 },
        },
        summon: async () => ({ status: "started", handles: [] }),
      }),
    });
    const summon = controller({ summoner: provider({ region: "eu" }), logger });
    // Provisional capabilities at construction: nothing to say yet.
    expect(graceWarnings(logs)).toEqual([]);
    await summon.check();
    expect(graceWarnings(logs)).toHaveLength(1);
  });
});

/** Every string a log line carries: its message, fields, error, and the error's cause chain. */
function logText(logs: LogEvent[]): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || value === undefined) {
      return;
    }
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (value instanceof Error) {
      parts.push(value.message, value.stack ?? "");
      walk(value.cause, depth + 1);
    }
    for (const inner of Object.values(value)) {
      walk(inner, depth + 1);
    }
  };
  for (const event of logs) {
    parts.push(event.message);
    walk(event.fields, 0);
    walk(event.error, 0);
    walk(event.bindings, 0);
  }
  return parts.join("\n");
}

/** A `defineSummoner` summoner that answers `result` to every call. */
function answering(result: SummonResult) {
  return defineSummoner({ kind: "answers", invoke: async () => result });
}

/** The longest detail the controller stores. */
const DETAIL_MAX = 128;

describe("review round 2: retryAfterMs is bounded", () => {
  /** What a clamp caps a wait at under QUIET: the larger of backoff.max (5) and circuit.resetAfter. */
  const RESET = 120_000;

  it("clamps a throttled ProviderError's huge retryAfterMs to max(backoff.max, circuit.resetAfter), with one warn", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner, name } = throwing(
      () => new ProviderError("slow down", "throttled", { retryAfterMs: 1e12 }),
    );
    const summon = controller({
      summoner,
      logger,
      circuit: { failures: 5, resetAfter: RESET },
    });
    expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
    const after = Date.now();
    const status = await summon.status();
    expect(status.backoffUntil).toBeLessThanOrEqual(after + RESET);
    expect(status.backoffUntil).toBeGreaterThan(after + RESET - 5_000);
    // A second clamped value in the same controller says nothing more.
    await summon.reset();
    await summon.check();
    const clamped = logged(logs, "warn", "clamped");
    expect(clamped).toHaveLength(1);
    expect(clamped[0]!.fields).toMatchObject({
      provider: name,
      retryAfterMs: 1e12,
      clampedTo: RESET,
    });
  });

  it("clamps quota, and a same-shaped error from another copy of the package, the same way", async () => {
    for (const thrown of [
      new ProviderError("limit", "quota", { retryAfterMs: 1e12 }),
      Object.assign(new Error("foreign"), {
        kind: "throttled",
        code: "PROVIDER_THROTTLED",
        retryAfterMs: 1e12,
      }),
    ]) {
      const { controller } = await setup();
      const { summoner } = throwing(() => thrown);
      const summon = controller({
        summoner,
        circuit: { failures: 5, resetAfter: RESET },
      });
      expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
      expect((await summon.status()).backoffUntil).toBeLessThanOrEqual(
        Date.now() + RESET,
      );
    }
  });

  it("clamps a returned unavailable result's retryAfterMs too", async () => {
    const { controller } = await setup();
    const summon = controller({
      summoner: answering({
        status: "unavailable",
        reason: "no capacity",
        retryAfterMs: 1e12,
      }),
      circuit: { failures: 5, resetAfter: RESET },
    });
    await summon.check();
    expect((await summon.status()).backoffUntil).toBeLessThanOrEqual(
      Date.now() + RESET,
    );
  });

  it("negative control: a retryAfterMs within the cap is honoured as given, and nothing warns", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner } = throwing(
      () =>
        new ProviderError("slow down", "throttled", { retryAfterMs: 60_000 }),
    );
    const summon = controller({
      summoner,
      logger,
      circuit: { failures: 5, resetAfter: RESET },
    });
    const before = Date.now();
    await summon.check();
    const until = (await summon.status()).backoffUntil!;
    expect(until).toBeGreaterThanOrEqual(before + 60_000);
    expect(until).toBeLessThan(before + RESET);
    expect(logged(logs, "warn", "clamped")).toEqual([]);
  });

  it("uses backoff.max as the cap when it is the larger", async () => {
    const { controller } = await setup();
    const { summoner } = throwing(
      () => new ProviderError("slow down", "throttled", { retryAfterMs: 1e12 }),
    );
    const summon = controller({
      summoner,
      backoff: { initial: 5, max: 600_000 },
      circuit: { failures: 5, resetAfter: RESET },
    });
    await summon.check();
    const after = Date.now();
    const until = (await summon.status()).backoffUntil!;
    expect(until).toBeLessThanOrEqual(after + 600_000);
    expect(until).toBeGreaterThan(after + RESET);
  });
});

describe("review round 2: a non-finite retryAfterMs on a returned result", () => {
  for (const retryAfterMs of [Number.NaN, Infinity, -1]) {
    it(`${retryAfterMs} is dropped, and the marker keeps its failures, budget and epoch`, async () => {
      const { controller, marker } = await setup();
      const summon = controller({
        summoner: answering({
          status: "unavailable",
          reason: "no capacity",
          retryAfterMs,
        }),
      });
      await summon.check();
      const first = await marker();
      expect(first.backoffUntil).toBeNumber();
      await Bun.sleep(15);
      await summon.check();
      const status = await summon.status();
      expect(status.failures).toBe(2);
      expect(status.budget?.hour).toBe(2);
      expect((await marker()).epoch).toBe(first.epoch);
    });
  }

  it("negative control: a finite retryAfterMs is kept", async () => {
    const { controller } = await setup();
    const summon = controller({
      summoner: answering({
        status: "unavailable",
        reason: "no capacity",
        retryAfterMs: 60_000,
      }),
    });
    const before = Date.now();
    await summon.check();
    expect((await summon.status()).backoffUntil).toBeGreaterThanOrEqual(
      before + 60_000,
    );
  });
});

describe("review round 2: the refused warn redacts", () => {
  const SECRET = "s3cr3t-token-value-1234";

  it("keeps a declared secret in a throttled error's message and cause out of the logs", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner } = throwing(
      () =>
        new ProviderError(`throttled for token ${SECRET}`, "throttled", {
          cause: new Error(`upstream said no to ${SECRET}`),
        }),
      { secrets: true },
    );
    await controller({ summoner, logger }).check();
    expect(logged(logs, "warn", "summoner call refused")).toHaveLength(1);
    expect(logText(logs)).not.toContain(SECRET);
  });

  it("negative control: with no secret declared the same text reaches the log, so the check can see it", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner } = throwing(
      () =>
        new ProviderError(`throttled for token ${SECRET}`, "throttled", {
          cause: new Error(`upstream said no to ${SECRET}`),
        }),
    );
    await controller({ summoner, logger }).check();
    expect(logText(logs)).toContain(SECRET);
  });
});

describe("review round 2: details are capped", () => {
  it("cuts a long unavailable reason to 128 characters, ending in an ellipsis", async () => {
    const { controller, events } = await setup();
    const summon = controller({
      summoner: answering({ status: "unavailable", reason: "X".repeat(500) }),
    });
    await summon.check();
    const detail = (await summon.status()).last?.detail ?? "";
    expect(detail).toHaveLength(DETAIL_MAX);
    expect(detail.endsWith("…")).toBe(true);
    expect(events.at(-1)?.detail).toBe(detail);
  });

  it("negative control: a reason of exactly 128 characters is kept whole", async () => {
    const { controller } = await setup();
    const reason = "Y".repeat(DETAIL_MAX);
    const summon = controller({
      summoner: answering({ status: "unavailable", reason }),
    });
    await summon.check();
    expect((await summon.status()).last?.detail).toBe(reason);
  });

  it("negative control: a code-shaped platformCode of 64 characters is kept whole", async () => {
    const { controller } = await setup();
    const code = "C".repeat(64);
    const { summoner } = throwing(
      () => new ProviderError("x", "transient", { platformCode: code }),
    );
    const summon = controller({ summoner });
    await summon.check();
    expect((await summon.status()).last?.detail).toBe(code);
  });

  it("cuts a unit's long detail from status() the same way", async () => {
    const { controller, events } = await setup();
    const base = defineSummoner({
      kind: "explain",
      bootBudget: 100,
      invoke: async () => ({ status: "started", handles: ["unit-1"] }),
    });
    const summoner = {
      ...base,
      summon: {
        ...base.summon,
        status: async (): Promise<readonly UnitStatus[]> => [
          { handle: "unit-1", state: "failed", detail: "Z".repeat(500) },
        ],
      },
    };
    const summon = controller({ summoner, backoff: { initial: 60_000 } });
    await summon.check();
    await Bun.sleep(150);
    await summon.check();
    await summon.close();
    const lost = events.find((event) => event.outcome === "lost");
    expect(lost?.detail).toHaveLength(DETAIL_MAX);
    expect(lost?.detail?.endsWith("…")).toBe(true);
    expect((await summon.status()).last?.detail).toBe(lost?.detail);
  });
});

describe("review round 2: an unavailable result's reason is redacted", () => {
  const SECRET = "s3cr3t-token-value-1234";

  /** A plugin with a declared secret that answers `unavailable` with `reason`. */
  function declining(reason: string, secret: boolean) {
    const provider = defineComputeProvider({
      name: `test-errors-reason-${++unique}`,
      version: "1.0.0",
      kind: "reason",
      apiVersion: { core: "0.1", summon: "0.1" },
      config: toStandardSchema<{ token: string }>((input) => ({
        value: input as { token: string },
      })),
      ...(secret ? { secrets: ["token"] } : {}),
      summon: (): SummonFacet => ({
        capabilities: CAPABILITIES,
        summon: async () => ({ status: "unavailable", reason }),
      }),
    });
    return provider({ token: SECRET });
  }

  it("keeps a declared secret out of last.detail and the event", async () => {
    const { controller, events } = await setup();
    const summon = controller({
      summoner: declining(`no capacity for ${SECRET}`, true),
    });
    await summon.check();
    const detail = (await summon.status()).last?.detail ?? "";
    expect(detail).toStartWith("no capacity for ");
    expect(detail).not.toContain(SECRET);
    expect(events.at(-1)?.detail).toBe(detail);
  });

  it("negative control: undeclared, the same reason is kept as given", async () => {
    const { controller } = await setup();
    const summon = controller({
      summoner: declining(`no capacity for ${SECRET}`, false),
    });
    await summon.check();
    expect((await summon.status()).last?.detail).toBe(
      `no capacity for ${SECRET}`,
    );
  });
});

describe("review round 2: a run of throttled answers warns once", () => {
  /** The `warn`s about a run of throttled answers. */
  function throttleWarnings(logs: LogEvent[]): LogEvent[] {
    return logged(logs, "warn", "throttled");
  }

  it("warns once when consecutive throttled answers reach circuit.failures", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner, name } = throwing(
      () => new ProviderError("slow down", "throttled"),
    );
    const summon = controller({
      summoner,
      logger,
      circuit: { failures: 3, resetAfter: 60_000 },
    });
    for (let i = 0; i < 5; i++) {
      expect(await summon.check()).toMatchObject({ outcome: "unavailable" });
      await Bun.sleep(15);
    }
    const warned = throttleWarnings(logs);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain("3 summon attempts in a row");
    expect(warned[0]!.fields).toMatchObject({ provider: name, throttled: 3 });
    // Still never the circuit: the warn changes nothing else.
    expect((await summon.status()).circuitOpenUntil).toBeUndefined();
  });

  it("negative control: another outcome in between resets the run, so nothing warns", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { summoner } = throwing((call) =>
      call === 3
        ? new Error("boom")
        : new ProviderError("slow down", "throttled"),
    );
    const summon = controller({
      summoner,
      logger,
      circuit: { failures: 3, resetAfter: 60_000 },
    });
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await summon.check();
      outcomes.push(
        result.action === "summoned" ? result.outcome : result.action,
      );
      await Bun.sleep(15);
    }
    expect(outcomes).toEqual([
      "unavailable",
      "unavailable",
      "failed",
      "unavailable",
      "unavailable",
    ]);
    expect(throttleWarnings(logs)).toEqual([]);
  });

  it("warns again for a new run after another outcome ends the first", async () => {
    const { controller } = await setup();
    const { logger, events: logs } = createTestLogger();
    // throttled, throttled (warn), failed (reset), throttled, throttled (warn).
    const { summoner } = throwing((call) =>
      call === 3
        ? new Error("boom")
        : new ProviderError("slow down", "throttled"),
    );
    const summon = controller({
      summoner,
      logger,
      circuit: { failures: 2, resetAfter: 60_000 },
    });
    for (let i = 0; i < 5; i++) {
      await summon.check();
      await Bun.sleep(15);
    }
    expect(throttleWarnings(logs)).toHaveLength(2);
  });
});

describe("review round 2: undeclared credential shapes never reach the detail", () => {
  /** What must not survive into a detail from the probes below. */
  const LEAKS = ["u:pw@", ":pw@", "sk_live_abc123", "abc.def.ghi"];

  /** Asserts that neither `last.detail` nor the last event's carries a leak. */
  async function clean(
    summon: SummonController,
    events: SummonEventPayload[],
  ): Promise<string> {
    const detail = (await summon.status()).last?.detail ?? "";
    for (const leak of LEAKS) {
      expect(detail).not.toContain(leak);
      expect(events.at(-1)?.detail ?? "").not.toContain(leak);
    }
    expect(events.at(-1)?.detail).toBe(detail);
    return detail;
  }

  it("redacts URL userinfo in an unavailable reason", async () => {
    const { controller, events } = await setup();
    const summon = controller({
      summoner: answering({
        status: "unavailable",
        reason: "postgres://u:pw@h quota",
      }),
    });
    await summon.check();
    const detail = await clean(summon, events);
    expect(detail).toContain("quota");
  });

  it("negative control: a reason with no credential shape is kept as given", async () => {
    const { controller } = await setup();
    const summon = controller({
      summoner: answering({
        status: "unavailable",
        reason: "postgres quota reached on host h",
      }),
    });
    await summon.check();
    expect((await summon.status()).last?.detail).toBe(
      "postgres quota reached on host h",
    );
  });

  it("refuses a thrown code that is not code-shaped, falling back to the error's name", async () => {
    const { controller, events } = await setup();
    const summon = controller({
      summoner: defineSummoner({
        invoke: async () => {
          throw Object.assign(new Error("x"), {
            code: "token=sk_live_abc123 postgres://u:pw@h",
          });
        },
      }),
    });
    await summon.check();
    expect(await clean(summon, events)).toBe("Error");
  });

  it("negative control: a code-shaped code is the detail as before", async () => {
    const { controller } = await setup();
    const summon = controller({
      summoner: defineSummoner({
        invoke: async () => {
          throw Object.assign(new Error("x"), { code: "ERR_SOCKET.closed:1" });
        },
      }),
    });
    await summon.check();
    expect((await summon.status()).last?.detail).toBe("ERR_SOCKET.closed:1");
  });

  it('refuses a name that is not code-shaped, with no code, falling back to "error"', async () => {
    const { controller, events } = await setup();
    const summon = controller({
      summoner: defineSummoner({
        invoke: async () => {
          const error = new Error("x");
          error.name = "Bearer abc.def.ghi";
          throw error;
        },
      }),
    });
    await summon.check();
    expect(await clean(summon, events)).toBe("error");
  });

  it("negative control: a code-shaped name is the detail as before", async () => {
    const { controller } = await setup();
    const summon = controller({
      summoner: defineSummoner({
        invoke: async () => {
          throw new RangeError("x");
        },
      }),
    });
    await summon.check();
    expect((await summon.status()).last?.detail).toBe("RangeError");
  });

  it("refuses a platformCode that is not code-shaped, falling back to PROVIDER_<KIND>", async () => {
    const { controller, events } = await setup();
    const { summoner } = throwing(
      () =>
        new ProviderError("x", "transient", {
          platformCode: "token=sk_live_abc123 postgres://u:pw@h",
        }),
    );
    const summon = controller({ summoner });
    await summon.check();
    expect(await clean(summon, events)).toBe("PROVIDER_TRANSIENT");
  });
});
