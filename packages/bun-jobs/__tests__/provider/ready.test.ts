import type { LogEvent } from "@kingsleyweb/bun-common";
import type {
  JobsDriver,
  SummonControllerOptions,
  SummonEventPayload,
  SummonPolicy,
} from "../../lib/index";
import type {
  SummonCapabilities,
  SummonFacet,
  SummonRequest,
} from "../../lib/provider/index";
import { join } from "node:path";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  createDriver,
  defineSummoner,
  SummonController,
} from "../../lib/index";
import {
  defineComputeProvider,
  toStandardSchema,
} from "../../lib/provider/index";
import { makeTmpDir, testNamespace } from "../helpers";

/**
 * The controller and a provider's `ready` (plugins §6.3, as revised by the
 * review of PR-p1): an asynchronous config is awaited before the first call.
 * A rejection, or no answer within `summonTimeout`, is a failed attempt for
 * that check — no call, the backoff and the circuit as for any failure, one
 * `warn` per run of them — and `ready` is awaited again at the next attempt;
 * only a resolution is kept. Plus the registration warnings (experimental,
 * newer minor, two versions of one name), which `defineSummoner` never logs.
 *
 * One file backend is enough: none of this depends on the driver.
 */

const dir = await makeTmpDir("bun-jobs-provider-ready");
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
 * A provider whose config validates asynchronously: each validation takes
 * `delay` ms and fails while `fail(n)` (n = the validation's number, from 1)
 * says so, or never answers when `delay` is `Infinity`. Counts validations
 * and summon calls.
 */
function asyncProvider(options: {
  fail?: (n: number) => boolean;
  delay?: number;
  /** Validation `n` never answers. */
  hang?: (n: number) => boolean;
  /** How long validation `n` takes, in ms, over `delay`. */
  delayOf?: (n: number) => number;
  /** The first validation waits for this before answering: its timing is the test's. */
  latch?: Promise<void>;
  /** Validate synchronously instead: the control twin of an async provider. */
  sync?: boolean;
  capabilities?: Partial<SummonCapabilities>;
  release?: boolean;
}) {
  const counts = { validations: 0, calls: 0, releases: 0 };
  const requests: SummonRequest[] = [];
  const provider = defineComputeProvider({
    name: `test-async-${++unique}`,
    version: "1.0.0",
    kind: "async",
    apiVersion: { core: "0.1", summon: "0.1" },
    config: toStandardSchema<{ region: string }>((input) => {
      if (options.sync) {
        ++counts.validations;
        return { value: input as { region: string } };
      }
      return (async () => {
        const n = ++counts.validations;
        if (options.delay === Infinity || options.hang?.(n)) {
          return await new Promise<never>(() => {});
        }
        if (n === 1 && options.latch !== undefined) {
          await options.latch;
        }
        await Bun.sleep(options.delayOf?.(n) ?? options.delay ?? 20);
        return options.fail?.(n)
          ? {
              issues: [
                { message: "the region is unreachable", path: ["region"] },
              ],
            }
          : { value: input as { region: string } };
      })();
    }),
    describe: (config) => ({ region: config.region }),
    summon: (): SummonFacet => ({
      capabilities: { ...CAPABILITIES, ...options.capabilities },
      summon: async (request) => {
        counts.calls++;
        requests.push(request);
        return { status: "started", handles: [`unit-${counts.calls}`] };
      },
      ...(options.release
        ? {
            release: async () => {
              counts.releases++;
            },
          }
        : {}),
    }),
  });
  return { provider, counts, requests };
}

/** A fresh driver, namespace and queue, with one job waiting; closed after the test. */
async function setup(queueName = "work"): Promise<{
  driver: JobsDriver;
  namespace: string;
  controller: (
    policy: Partial<SummonPolicy> &
      Pick<SummonPolicy, "summoner"> & {
        logger?: SummonControllerOptions["logger"];
        queue?: string;
      },
  ) => SummonController;
  events: SummonEventPayload[];
  add: (queue?: string) => Promise<void>;
}> {
  const driver = createDriver({
    type: "file",
    root: join(dir.path, testNamespace("root")),
  });
  await driver.connect();
  const namespace = testNamespace("provider-ready");
  const events: SummonEventPayload[] = [];
  const owned: { close: () => Promise<unknown> }[] = [];
  perTest.push(async () => {
    for (const one of owned) {
      await one.close().catch(() => {});
    }
    await driver.purge(namespace);
    await driver.close();
  });
  return {
    driver,
    namespace,
    events,
    add: async (queue = queueName) => {
      const bunQueue = new BunQueue(queue, {
        namespace,
        driver,
        logger: noopLogger,
      });
      owned.push(bunQueue);
      await bunQueue.add("job", {});
    },
    controller: (policy) => {
      const controller = new SummonController({
        logger: noopLogger,
        ...QUIET,
        ...policy,
        driver,
        namespace,
        queue: policy.queue ?? queueName,
      });
      controller.on("summon", (event) => events.push(event));
      owned.unshift(controller);
      return controller;
    },
  };
}

/** The `warn`s saying the provider is not ready. */
function notReadyWarnings(events: LogEvent[]): LogEvent[] {
  return events.filter(
    (event) =>
      event.level === "warn" && event.message.includes("provider is not ready"),
  );
}

/** Waits out the 5 ms backoff. */
async function afterBackoff(): Promise<void> {
  await Bun.sleep(15);
}

describe("SummonController and a provider's ready", () => {
  it("fails the attempt without a call when ready rejects, then summons once it resolves", async () => {
    const { controller, add, events } = await setup();
    const { logger, events: logs } = createTestLogger();
    let failing = true;
    const { provider, counts } = asyncProvider({ fail: () => failing });
    // A backoff long enough for the status read and the gated check below to
    // land inside it on a loaded machine (5 ms did not, at load ~38).
    const summon = controller({
      summoner: provider({ region: "eu" }),
      logger,
      backoff: { initial: 500, max: 500 },
    });
    await add();

    // The validation provider(config) started is awaited (or, if it already
    // failed unobserved, one more is), and it fails.
    const first = await summon.check();
    expect(first).toMatchObject({ action: "summoned", outcome: "failed" });
    expect(counts.calls).toBe(0);
    const validated = counts.validations;
    expect(validated).toBeGreaterThanOrEqual(1);
    expect(events).toEqual([
      expect.objectContaining({ outcome: "failed", detail: "CONFIG" }),
    ]);
    const failed = await summon.status();
    expect(failed.failures).toBe(1);
    expect(failed.pending).toEqual([]);
    expect(failed.last).toMatchObject({ outcome: "failed", detail: "CONFIG" });
    expect(failed.backoffUntil).toBeNumber();
    // Its capabilities are unknown until it is ready: no summoner shown.
    expect(failed.summoner).toBeUndefined();
    // Logged as any failed attempt is (§9.1's one line per outcome), but
    // without the per-call "summoner call failed": nothing was called, and
    // the cause is in the one warn below.
    expect(
      logs.filter((event) => event.message === "summoner call failed"),
    ).toEqual([]);
    expect(
      logs.filter((event) => event.message === "summon attempt failed"),
    ).toHaveLength(1);

    // Within the backoff, the gate holds: ready is not even asked.
    expect(await summon.check()).toMatchObject({
      action: "skipped",
      reason: "backoff",
    });
    expect(counts.validations).toBe(validated);

    // The fault clears; the next check after the backoff validates again.
    failing = false;
    await Bun.sleep(550);
    const second = await summon.check();
    expect(second).toMatchObject({ action: "summoned", outcome: "started" });
    expect(counts.validations).toBe(validated + 1);
    expect(counts.calls).toBe(1);
    expect(notReadyWarnings(logs)).toHaveLength(1);
    const ready = await summon.status();
    expect(ready.summoner?.capabilities.bootBudgetMs).toBe(20_000);
    expect(ready.summoner?.facts).toEqual({ region: "eu" });
    expect(ready.pending).toHaveLength(1);

    // Kept once resolved: no validation on later checks.
    await summon.check({ force: true });
    expect(counts.validations).toBe(validated + 1);
  });

  it("counts every rejection toward the circuit, with one warn for the whole run", async () => {
    const { controller, add } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { provider, counts } = asyncProvider({ fail: () => true, delay: 1 });
    const summon = controller({
      summoner: provider({ region: "eu" }),
      logger,
      circuit: { failures: 3, resetAfter: 60_000 },
    });
    await add();

    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await summon.check();
      outcomes.push(
        result.action === "summoned"
          ? result.outcome
          : result.action === "skipped"
            ? result.reason
            : result.action,
      );
      await afterBackoff();
    }
    expect(outcomes).toEqual([
      "failed",
      "failed",
      "failed",
      "circuit-open",
      "circuit-open",
    ]);
    const status = await summon.status();
    expect(status.failures).toBe(3);
    expect(status.circuitOpenUntil).toBeNumber();
    expect(counts.calls).toBe(0);
    expect(notReadyWarnings(logs)).toHaveLength(1);
    expect(
      logs.filter((event) => event.message.includes("summon circuit open")),
    ).toHaveLength(1);
  });

  it("warns once for a run of failures that ends in success", async () => {
    const { controller, add } = await setup();
    const { logger, events: logs } = createTestLogger();
    // A success adopts the facet for good, so no second run can follow it.
    let failing = true;
    const { provider } = asyncProvider({ fail: () => failing, delay: 1 });
    const summon = controller({ summoner: provider({ region: "eu" }), logger });
    await add();
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    await afterBackoff();
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    await afterBackoff();
    failing = false;
    expect(await summon.check()).toMatchObject({ outcome: "started" });
    expect(notReadyWarnings(logs)).toHaveLength(1);
  });

  it("bounds ready by summonTimeout: a ready that never settles fails the attempt, and is awaited again", async () => {
    const { controller, add, events } = await setup();
    const { provider, counts } = asyncProvider({ delay: Infinity });
    const summon = controller({
      summoner: provider({ region: "eu" }),
      summonTimeout: 100,
    });
    await add();

    const started = Date.now();
    const first = await summon.check();
    const took = Date.now() - started;
    expect(first).toMatchObject({ action: "summoned", outcome: "failed" });
    expect(took).toBeGreaterThanOrEqual(95);
    expect(took).toBeLessThan(2_000);
    expect(events.at(-1)).toMatchObject({
      outcome: "failed",
      detail: "ready timed out",
    });
    expect((await summon.status()).last?.detail).toBe("ready timed out");

    await afterBackoff();
    const second = await summon.check();
    expect(second).toMatchObject({ action: "summoned", outcome: "failed" });
    expect(events.at(-1)).toMatchObject({ detail: "ready timed out" });
    // The hung validation was abandoned: the next attempt started a fresh one.
    expect(counts.validations).toBe(2);
    expect(counts.calls).toBe(0);
  });

  it("drops a hung ready on timeout, so a fresh validation can succeed", async () => {
    const { controller, add, events } = await setup();
    const { provider, counts } = asyncProvider({
      hang: (n) => n === 1,
      delay: 1,
    });
    const summon = controller({
      summoner: provider({ region: "eu" }),
      summonTimeout: 100,
    });
    await add();

    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    expect(events.at(-1)).toMatchObject({ detail: "ready timed out" });
    await afterBackoff();
    expect(await summon.check()).toMatchObject({ outcome: "started" });
    expect(counts.validations).toBe(2);
    expect(counts.calls).toBe(1);
  });

  it("adopts a ready scale provider at the top of a check with no demand, and releases (sync twin as control)", async () => {
    /** Three checks on an empty queue, scale style, scaled down at once. */
    async function threeChecks(sync: boolean) {
      const { controller } = await setup();
      const { provider, counts } = asyncProvider({
        sync,
        delay: 1,
        release: true,
        capabilities: { style: "scale" },
      });
      const configured = provider({ region: "eu" });
      // Built before the config is ready, as at a process's start.
      const summon = controller({
        summoner: configured,
        scaleDown: { after: 0 },
      });
      await configured.ready;
      const actions: string[] = [];
      for (let i = 0; i < 3; i++) {
        actions.push((await summon.check()).action);
      }
      const status = await summon.status();
      return { actions, releases: counts.releases, status };
    }
    const control = await threeChecks(true);
    expect(control.actions).toEqual(["released", "none", "none"]);
    expect(control.releases).toBe(1);
    const late = await threeChecks(false);
    expect(late.actions).toEqual(control.actions);
    expect(late.releases).toBe(1);
    expect(late.status.summoner?.capabilities.style).toBe("scale");
  });

  it("validates in the background on a check that will not summon, and adopts at the next", async () => {
    const { controller } = await setup();
    let failing = true;
    const { provider, counts } = asyncProvider({
      fail: () => failing,
      delay: 1,
      release: true,
      capabilities: { style: "scale" },
    });
    const configured = provider({ region: "eu" });
    // The first validation fails before any check: nothing is pinned by it.
    await configured.ready.catch(() => {});
    failing = false;
    const summon = controller({
      summoner: configured,
      scaleDown: { after: 0 },
    });
    expect((await summon.check()).action).toBe("none");
    await Bun.sleep(20);
    expect(counts.validations).toBe(2);
    expect((await summon.check()).action).toBe("released");
    expect(counts.releases).toBe(1);
  });

  it("decides nothing about pending attempts before adoption: a passes-none attempt is registered, not lost (sync twin as control)", async () => {
    /** An attempt summoned by a passes-none controller, then a worker with no id holding the job past its until; a second controller checks. */
    async function scenario(sync: boolean) {
      const { controller, add, driver, namespace } = await setup();
      const first = asyncProvider({
        sync: true,
        capabilities: { passes: "none" },
      });
      const a = controller({
        summoner: first.provider({ region: "eu" }),
        bootBudget: 300,
      });
      await add();
      expect(await a.check()).toMatchObject({ outcome: "started" });
      await a.close();

      let finish = (): void => {};
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const worker = new BunQueueWorker(
        "work",
        async () => {
          await held;
        },
        {
          namespace,
          driver,
          pollInterval: 20,
          reportInterval: 100,
          logger: noopLogger,
        },
      );
      perTest.unshift(async () => {
        finish();
        await worker.close({ force: true });
      });
      void worker.run();
      await Bun.sleep(450);

      const second = asyncProvider({
        sync,
        delay: 2_000,
        capabilities: { passes: "none" },
      });
      const configured = second.provider({ region: "eu" });
      const b = controller({ summoner: configured, bootBudget: 300 });
      await b.check();
      const before = await b.status();
      return { b, configured, before };
    }

    const control = await scenario(true);
    expect(control.before.last?.outcome).toBe("registered");
    expect(control.before.failures).toBe(0);

    const late = await scenario(false);
    // Not adopted yet: the attempt is left as it was, nothing written.
    expect(late.before.pending).toHaveLength(1);
    expect(late.before.failures).toBe(0);
    expect(late.before.last?.outcome).toBe("started");
    // Once ready, the first check decides it on the real capabilities.
    await late.configured.ready;
    await late.b.check();
    const after = await late.b.status();
    expect(after.last?.outcome).toBe("registered");
    expect(after.failures).toBe(0);
  });

  it("keeps a facet that cannot be built as a permanent error, not a transient retry", async () => {
    const { controller, add } = await setup();
    let validations = 0;
    const broken = defineComputeProvider({
      name: `test-broken-${++unique}`,
      version: "1.0.0",
      kind: "broken",
      apiVersion: { core: "0.1", summon: "0.1" },
      config: toStandardSchema<{ region: string }>(async (input) => {
        validations++;
        return { value: input as { region: string } };
      }),
      summon: () => ({ capabilities: CAPABILITIES }) as unknown as SummonFacet,
    });
    const configured = broken({ region: "eu" });
    await expect(configured.ready).rejects.toThrow(/needs a summon function/);
    expect(configured.config).toBeUndefined();
    const summon = controller({ summoner: configured });
    await add();
    await expect(summon.check()).rejects.toThrow(/needs a summon function/);
    await expect(summon.check()).rejects.toBeInstanceOf(ConfigError);
    expect(validations).toBe(1);
  });

  it("logs an adoption error once, and keeps throwing it", async () => {
    const { controller, add } = await setup();
    const { logger, events: logs } = createTestLogger();
    const { provider } = asyncProvider({
      delay: 1,
      capabilities: { style: "scale" },
    });
    await add();
    const summon = controller({
      summoner: provider({ region: "eu" }),
      logger,
      triggers: { onAdd: false, events: false, poll: 20 },
    });
    await Bun.sleep(300);
    await expect(summon.check()).rejects.toThrow(/needs release/);
    expect(
      logs.filter((event) => event.message === "summon check failed"),
    ).toHaveLength(1);
  });

  it("redacts the secrets of a spread taken before the config was ready", async () => {
    const { controller, add } = await setup();
    const { logger, events: logs } = createTestLogger();
    const secret = "sk-live-spread-0123456789";
    const withSecret = defineComputeProvider({
      name: `test-spread-${++unique}`,
      version: "1.0.0",
      kind: "spread",
      apiVersion: { core: "0.1", summon: "0.1" },
      config: toStandardSchema<{ apiToken: string }>(async (input) => {
        await Bun.sleep(5);
        return { value: input as { apiToken: string } };
      }),
      secrets: ["apiToken"],
      summon: (config) => ({
        capabilities: CAPABILITIES,
        summon: async (_request, context) => {
          context.logger.info(`using ${config.apiToken}`);
          return { status: "started", handles: [] };
        },
      }),
    });
    const configured = withSecret({ apiToken: secret });
    const spread = { ...configured };
    expect(spread.config).toBeUndefined();
    const summon = controller({ summoner: spread, logger });
    await add();
    expect(await summon.check()).toMatchObject({ outcome: "started" });
    const used = logs.find((event) => event.message.startsWith("using"));
    expect(used?.message).toBe("using [REDACTED]");
  });

  it("adopts a valid validation that outlasted summonTimeout, when it lands (round 4 #1)", async () => {
    const { controller, add } = await setup();
    let land = (): void => {};
    const latch = new Promise<void>((resolve) => {
      land = resolve;
    });
    // Any later validation hangs: only validation 1's late answer can help.
    const { provider, counts } = asyncProvider({
      latch,
      delay: 1,
      hang: (n) => n >= 2,
    });
    const summon = controller({
      summoner: provider({ region: "eu" }),
      summonTimeout: 100,
    });
    await add();
    // The validation outlasts the check's wait: a failed attempt.
    expect(await summon.check()).toMatchObject({
      outcome: "failed",
    });
    // It lands late, valid: adopted, not thrown away as superseded.
    land();
    await Bun.sleep(20);
    await afterBackoff();
    expect(await summon.check()).toMatchObject({ outcome: "started" });
    expect(counts.calls).toBe(1);
    // Adopted from validation 1, at the top of the check: none other ran.
    expect(counts.validations).toBe(1);
  });

  it("lets one controller's timeout leave another's wait, and ready, alone (round 4 #2)", async () => {
    const { controller, add } = await setup();
    let land = (): void => {};
    const latch = new Promise<void>((resolve) => {
      land = resolve;
    });
    const { provider, counts } = asyncProvider({ latch, delay: 1 });
    await add("short");
    await add("long");
    const configured = provider({ region: "eu" });
    const ready = configured.ready.then(
      () => "resolved",
      (error: unknown) => `rejected: ${String(error)}`,
    );
    const short = controller({
      summoner: configured,
      queue: "short",
      summonTimeout: 100,
    });
    const long = controller({
      summoner: configured,
      queue: "long",
      summonTimeout: 5_000,
    });
    const waiting = long.check();
    // The short wait gives up and abandons; only then does validation 1 land.
    const a = await short.check();
    land();
    const b = await waiting;
    expect(a).toMatchObject({ action: "summoned", outcome: "failed" });
    expect(b).toMatchObject({ action: "summoned", outcome: "started" });
    expect(await ready).toBe("resolved");
    expect(counts.calls).toBe(1);
  });

  it("lets a waiter on an abandoned validation that then fails take a newer success", async () => {
    const { controller, add } = await setup();
    // Validation 1 takes 300 ms and fails; every later one succeeds at once.
    const { provider, counts } = asyncProvider({
      fail: (n) => n === 1,
      delayOf: (n) => (n === 1 ? 300 : 5),
    });
    await add("short");
    await add("long");
    const configured = provider({ region: "eu" });
    const ready = configured.ready.then(
      () => "resolved",
      () => "rejected",
    );
    const short = controller({
      summoner: configured,
      queue: "short",
      summonTimeout: 100,
      backoff: { initial: 5, max: 5 },
    });
    const long = controller({
      summoner: configured,
      queue: "long",
      summonTimeout: 5_000,
    });
    const waiting = long.check();
    expect(await short.check()).toMatchObject({ outcome: "failed" });
    await afterBackoff();
    // A fresh validation, in parallel with the abandoned one, succeeds.
    expect(await short.check()).toMatchObject({ outcome: "started" });
    // The long wait joined validation 1, which fails late: it takes the
    // success instead of failing.
    expect(await waiting).toMatchObject({ outcome: "started" });
    expect(await ready).toBe("resolved");
    expect(counts.validations).toBe(2);
  });

  it("abandons only the validation a caller waited on: one controller's timeout never abandons another's newer one (PR-p2 round 2, E2)", async () => {
    const { controller, add } = await setup();
    // Validation 1 hangs; every later one takes 250 ms and succeeds.
    const { provider, counts } = asyncProvider({
      hang: (n) => n === 1,
      delayOf: () => 250,
    });
    await add("a");
    await add("b");
    await add("c");
    const configured = provider({ region: "eu" });
    const a = controller({
      summoner: configured,
      queue: "a",
      summonTimeout: 100,
    });
    const b = controller({
      summoner: configured,
      queue: "b",
      summonTimeout: 200,
    });
    const c = controller({
      summoner: configured,
      queue: "c",
      summonTimeout: 5_000,
    });
    // b and a both wait on validation 1; a gives up first and abandons it.
    const bFirst = b.check();
    expect(await a.check()).toMatchObject({ outcome: "failed" });
    // c starts validation 2. b's wait on validation 1 then times out: it
    // must abandon 1 (already abandoned), never c's validation 2.
    const cFirst = c.check();
    expect(await bFirst).toMatchObject({ outcome: "failed" });
    await afterBackoff();
    // So b's next check joins validation 2 rather than starting a third.
    expect(await b.check()).toMatchObject({ outcome: "started" });
    expect(await cFirst).toMatchObject({ outcome: "started" });
    expect(counts.validations).toBe(2);
  });

  it("negative control: a caller's timeout still abandons the validation it waited on, so the next attempt starts a fresh one", async () => {
    const { controller, add } = await setup();
    const { provider, counts } = asyncProvider({
      hang: (n) => n === 1,
      delayOf: () => 5,
    });
    await add();
    const summon = controller({
      summoner: provider({ region: "eu" }),
      summonTimeout: 100,
    });
    expect(await summon.check()).toMatchObject({ outcome: "failed" });
    await afterBackoff();
    expect(await summon.check()).toMatchObject({ outcome: "started" });
    expect(counts.validations).toBe(2);
  });

  it("bounds the background validation too: a hung first one, no demand, still adopts and releases (round 4 #3)", async () => {
    const { controller } = await setup();
    const { provider, counts } = asyncProvider({
      hang: (n) => n === 1,
      delay: 1,
      release: true,
      capabilities: { style: "scale" },
    });
    const summon = controller({
      summoner: provider({ region: "eu" }),
      scaleDown: { after: 0 },
      summonTimeout: 100,
    });
    const actions: string[] = [];
    for (let i = 0; i < 10 && !actions.includes("released"); i++) {
      actions.push((await summon.check()).action);
      await Bun.sleep(60);
    }
    expect(actions).toContain("released");
    expect(counts.releases).toBe(1);
    expect(counts.validations).toBe(2);
  });

  it("shows the summoner in status() once ready resolves, before any check (round 4 #5)", async () => {
    const { controller } = await setup();
    const { provider } = asyncProvider({ delay: 300 });
    const configured = provider({ region: "eu" });
    const summon = controller({ summoner: configured });
    expect((await summon.status()).summoner).toBeUndefined();
    await configured.ready;
    expect((await summon.status()).summoner?.provider.kind).toBe("async");
  });

  it("shares one ready in flight between overlapping checks", async () => {
    const { controller, add } = await setup();
    const { provider, counts } = asyncProvider({ delay: 200 });
    await add("one");
    await add("two");
    // Two controllers on one configured provider, each with work, checked
    // while the validation provider(config) started is still in flight.
    const configured = provider({ region: "eu" });
    const one = controller({ summoner: configured, queue: "one" });
    const two = controller({ summoner: configured, queue: "two" });

    const results = await Promise.all([one.check(), two.check()]);
    expect(results.map((result) => result.action)).toEqual([
      "summoned",
      "summoned",
    ]);
    expect(counts.validations).toBe(1);
    expect(counts.calls).toBe(2);
  });

  it("adopts the real capabilities late, and refuses them as at construction when they are wrong", async () => {
    const { controller, add } = await setup();
    // Scale style without release: a ConfigError at construction for a
    // synchronous provider, and at the first ready check for this one.
    const { provider, counts } = asyncProvider({
      delay: 1,
      capabilities: { style: "scale" },
    });
    const summon = controller({ summoner: provider({ region: "eu" }) });
    await add();
    await expect(summon.check()).rejects.toThrow(
      /scale-style summoner needs release/,
    );
    await expect(summon.check()).rejects.toBeInstanceOf(ConfigError);
    expect(counts.calls).toBe(0);
    expect((await summon.status()).summoner).toBeUndefined();
  });

  it("runs on the real capabilities once adopted", async () => {
    const { controller, add } = await setup();
    const { provider, requests } = asyncProvider({
      delay: 1,
      capabilities: {
        maxCountPerCall: 1,
        shutdown: { signal: "SIGINT", graceMs: 9_000 },
      },
    });
    const summon = controller({
      summoner: provider({ region: "eu" }),
      maxWorkers: 3,
    });
    await add();
    await add();
    await add();
    expect(await summon.check()).toMatchObject({ outcome: "started" });
    expect(requests[0]!.count).toBe(1);
    expect(requests[0]!.argv).toContain("--bun-jobs-summon-grace-ms=9000");
  });

  it("throws a synchronous config error at construction, before any controller", async () => {
    const { controller } = await setup();
    const sync = defineComputeProvider({
      name: `test-sync-${++unique}`,
      version: "1.0.0",
      kind: "sync",
      apiVersion: { core: "0.1", summon: "0.1" },
      config: toStandardSchema<{ region: string }>((input) =>
        typeof (input as { region?: unknown }).region === "string"
          ? { value: input as { region: string } }
          : { issues: [{ message: "region is required", path: ["region"] }] },
      ),
      summon: () => ({
        capabilities: CAPABILITIES,
        summon: async () => ({ status: "started", handles: [] }),
      }),
    });
    expect(() =>
      controller({ summoner: sync({} as { region: string }) }),
    ).toThrow(ConfigError);
    // Valid, it is ready at construction: the summoner shows at once.
    const summon = controller({ summoner: sync({ region: "eu" }) });
    expect((await summon.status()).summoner?.provider.kind).toBe("sync");
  });
});

describe("registration warnings", () => {
  /** A provider with a synchronous config, named uniquely unless told. */
  function syncProvider(
    apiVersion = { core: "0.1", summon: "0.1" },
    name?: string,
    version = "1.0.0",
  ) {
    return defineComputeProvider({
      name: name ?? `test-reg-${++unique}`,
      version,
      kind: "reg",
      apiVersion,
      summon: () => ({
        capabilities: CAPABILITIES,
        summon: async () => ({ status: "started", handles: [] }),
      }),
    });
  }

  /** The `warn` messages matching `pattern`. */
  function warnings(events: LogEvent[], pattern: RegExp): string[] {
    return events
      .filter((event) => event.level === "warn" && pattern.test(event.message))
      .map((event) => event.message);
  }

  it("says once per process that a defineComputeProvider provider's API is experimental", async () => {
    const { controller } = await setup();
    const { logger, events } = createTestLogger();
    const configured = syncProvider()();
    controller({ summoner: configured, logger, queue: "a" });
    controller({ summoner: configured, logger, queue: "b" });
    controller({ summoner: syncProvider()(), logger, queue: "c" });
    const found = warnings(events, /provider API is experimental/);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("(core 0.1, summon 0.1)");
  });

  it("never warns for defineSummoner", async () => {
    const { controller } = await setup();
    const { logger, events } = createTestLogger();
    controller({
      summoner: defineSummoner({ kind: "quiet", invoke: async () => {} }),
      logger,
    });
    controller({ summoner: async () => {}, logger, queue: "other" });
    expect(warnings(events, /compute provider/)).toEqual([]);
  });

  it("warns about a newer minor, and about two versions of one name", async () => {
    const { controller } = await setup();
    const { logger, events } = createTestLogger();
    controller({
      summoner: syncProvider({ core: "0.1", summon: "0.4" })(),
      logger,
      queue: "a",
    });
    expect(
      warnings(
        events,
        /written for summon 0\.4; this bun-jobs speaks summon 0\.1/,
      ),
    ).toHaveLength(1);

    const name = `test-twice-${++unique}`;
    controller({
      summoner: syncProvider(undefined, name, "1.0.0")(),
      logger,
      queue: "b",
    });
    controller({
      summoner: syncProvider(undefined, name, "1.0.0")(),
      logger,
      queue: "c",
    });
    expect(warnings(events, /two versions/)).toEqual([]);
    controller({
      summoner: syncProvider(undefined, name, "2.0.0")(),
      logger,
      queue: "d",
    });
    expect(warnings(events, /two versions of compute provider/)).toHaveLength(
      1,
    );
  });
});
