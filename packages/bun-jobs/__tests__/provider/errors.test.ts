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
    const summon = controller({ summoner });
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    const status = await summon.status();
    expect(status.failures).toBe(1);
    expect(status.circuitOpenUntil).toBeUndefined();
    expect(status.backoffUntil).toBeNumber();
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
