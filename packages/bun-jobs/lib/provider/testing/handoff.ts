import type { Server } from "bun";
import type { DriverConfig, JobsDriver } from "../../drivers/index";
import type {
  SummonControllerOptions,
  SummonEventPayload,
  SummonReleaseRequest,
  SummonRequest,
} from "../../summon/types";
import type { UnitStatus } from "../define";
import type { VerdictProbe } from "./checks";
import type { FakeUnit } from "./fake";
import type { KitRun } from "./run";
import type { SpawnedUnit } from "./spawn";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriver, supportsWorkers } from "../../drivers/index";
import { BunQueue } from "../../queue/BunQueue";
import { ConfigError } from "../../shared/errors";
import { SUMMON_ARGS } from "../../summon/args";
import { SummonController } from "../../summon/controller";
import { PROVIDER_FETCH_PROBE } from "../context";
import { textRedactor } from "../redact";
import { VERDICT_POLICY } from "./checks";
import { RACER, RACER_ENV } from "./racer";
import {
  describeThrown,
  DIRECT_QUEUE,
  fakeOf,
  kitLifetime,
  randomHex,
} from "./run";
import { spawnUnit, unitLines, unitSpawner } from "./spawn";
import { FIXTURE_ENV, FIXTURE_WORKER } from "./worker";

/**
 * The summon kit's end-to-end checks (plugins §12.2): the argument round
 * trip — a request whose `argv` repeats an argument reaches the unit's
 * process whole and in order; the handoff — a real
 * `SummonController` summons through the provider, the fake starts the kit's
 * fixture worker for the unit, the worker registers and the attempt is
 * released — and the compare-and-set, two controllers in two processes
 * racing on one backlog. Internal.
 */

/** How long the handoff waits for the worker to register, in ms. */
const REGISTER_WITHIN_MS = 30_000;

/** How long the handoff waits for the backlog to drain and the worker to exit, in ms. */
const DRAIN_WITHIN_MS = 30_000;

/** How long the fixture worker stays idle before it exits, in ms. */
const FIXTURE_IDLE_MS = 1_000;

/** Jobs the handoff seeds the queue with. */
const HANDOFF_JOBS = 3;

/** Rounds of the compare-and-set race. */
const CAS_ROUNDS = 2;

/** Checks each racer runs per round. */
const CAS_CHECKS = 3;

/** A backend for the end-to-end checks: the given one, or a SQLite file in a temporary directory. */
async function backend(run: KitRun): Promise<{
  config: DriverConfig;
  cleanup: () => Promise<void>;
}> {
  if (run.driver !== undefined) {
    return { config: run.driver, cleanup: async () => {} };
  }
  const dir = await mkdtemp(join(tmpdir(), "bun-jobs-conformance-"));
  return {
    config: { type: "sql", url: `sqlite://${join(dir, "jobs.db")}` },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Refuses a backend the end-to-end checks cannot share between processes,
 * before any check runs: the refusals a `SummonController` would make (not
 * multi-process, no queue state, no worker records). It builds the driver
 * without connecting.
 *
 * @throws {ConfigError} naming what the driver lacks.
 */
export async function assertSharedDriver(config: DriverConfig): Promise<void> {
  const driver = createDriver(config);
  try {
    if (!driver.capabilities.multiProcess) {
      throw new ConfigError(
        `runProviderConformance: the ${driver.name} driver cannot be shared with another process, and the handoff and the race run the provider's worker and a second controller in processes of their own. Pass a backend they can share (SQLite, the file driver, Redis, Postgres, …), or none for a temporary SQLite file`,
        { driver: driver.name },
      );
    }
    if (
      typeof driver.getQueueState !== "function" ||
      typeof driver.setQueueState !== "function" ||
      !supportsWorkers(driver)
    ) {
      throw new ConfigError(
        `runProviderConformance: the ${driver.name} driver has no queue state or worker records, which summoning needs`,
        { driver: driver.name },
      );
    }
  } finally {
    await driver.close().catch(() => {});
  }
}

/** Resolves after `ms`, on the kit's own clock. */
async function pause(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

/** Resolves with `promise`, or `undefined` once `ms` passes. */
async function within<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, ms, undefined);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The queues the argument round trip names, in order: the first is the
 * direct calls' queue, and the others carry the `.`, `-` and `_` a queue
 * name may hold, so a delimiter a platform layer splits on shows.
 */
const ROUND_TRIP_QUEUES = [DIRECT_QUEUE, "work.b", "work_c-2"] as const;

/** The group the argument round trip names. */
const ROUND_TRIP_GROUP = "conformance";

/** How long the round trip waits for the fake to start a unit, and for it to answer, in ms. */
const ROUND_TRIP_WITHIN_MS = 10_000;

/**
 * The argv group (summon-multi-queue §4.8): a request for a unit serving
 * three queues repeats `--bun-jobs-summon-queue=` three times, and the
 * process the fake starts for it must see every argument of `request.argv`,
 * in order — what a shared unit's worker reads its queues from. A platform
 * layer that dedupes arguments, keys them by flag, drops one or reorders
 * them would otherwise break a shared unit silently, while every
 * single-queue check still passed.
 *
 * A scale platform's count goes back to what it was afterwards, by a
 * `release` naming the unit the round trip summoned (its queues and group);
 * a release that throws fails the check. An `already-running` answer that
 * starts no unit is a skip for a scale or wake platform, whose unit may be
 * up already, and a failure for a launch platform, which starts a unit per
 * attempt.
 */
export async function argvChecks(run: KitRun): Promise<void> {
  const id = "summon.argv.round-trip";
  if (run.capabilities.passes !== "argv") {
    run.set(id, "skip", "passes is none: the platform passes no arguments");
    return;
  }
  if (run.selfHosted) {
    await selfHostedArgv(run, id);
    return;
  }
  const { platform, internals } = fakeOf(run);
  const dir = await mkdtemp(join(tmpdir(), "bun-jobs-conformance-argv-"));
  const echo = join(dir, "args.json");
  const spawner = unitSpawner(FIXTURE_WORKER, { [FIXTURE_ENV.echo]: echo });
  const started: Promise<SpawnedUnit>[] = [];
  platform.onStart((unit) => {
    started.push(
      (async () => {
        const process = await spawner.start({ argv: unit.argv });
        internals.mark(unit.handle, "running");
        void process.exited.then(() => {
          internals.mark(unit.handle, "exited");
        });
        return process;
      })(),
    );
  });
  const style = run.capabilities.style;
  const scale = style === "scale";
  const live = internals.liveCount();
  const request = run.request({
    queues: ROUND_TRIP_QUEUES,
    group: ROUND_TRIP_GROUP,
    count: 1,
    // A scale platform starts a unit only when its count rises.
    target: scale ? live + 1 : 1,
  });
  let verdict: ["pass" | "fail" | "skip", string];
  try {
    verdict = await roundTrip(run, request, started, echo);
  } catch (error) {
    verdict = ["fail", `the round trip failed: ${run.explain(error)}`];
  } finally {
    platform.onStart(undefined);
    await Promise.all(started).catch(() => {});
    await within(spawner.kill("SIGKILL"), 5_000);
  }
  try {
    // A scale platform's count goes back to what it was: released by the
    // unit it summoned, its queues and group, as a controller would.
    if (scale && run.facet.release !== undefined) {
      const released = await run.call(
        async (context) =>
          await run.facet.release!(
            {
              namespace: request.namespace,
              queue: request.queue,
              queues: request.queues ?? [request.queue],
              ...(request.group === undefined ? {} : { group: request.group }),
              target: live,
            },
            context,
          ),
      );
      if (!released.ok) {
        const why = `release of the round trip's unit (target ${live}) threw ${describeThrown(released.error)}, so the count was not restored`;
        verdict =
          verdict[0] === "fail"
            ? ["fail", `${verdict[1]}; and the ${why}`]
            : ["fail", `the ${why}`];
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  run.set(id, ...verdict);
}

/** The round trip's call and wait: the verdict, unless something threw. */
async function roundTrip(
  /** The run. */
  run: KitRun,
  /** The request the round trip sends. */
  request: SummonRequest,
  /** The units the fake started, as the kit spawns them. */
  started: readonly Promise<SpawnedUnit>[],
  /** The file the fixture echoes to. */
  echo: string,
): Promise<["pass" | "fail" | "skip", string]> {
  const outcome = await run.call(
    async (context) => await run.facet.summon(request, context),
  );
  if (!outcome.ok) {
    return ["fail", `summon threw ${describeThrown(outcome.error)}`];
  }
  const by = Date.now() + ROUND_TRIP_WITHIN_MS;
  while (started.length === 0 && Date.now() < by) {
    await pause(20);
  }
  if (started.length === 0) {
    return outcome.value?.status === "already-running"
      ? alreadyRunning(run)
      : ["fail", "the fake started no unit for the request"];
  }
  const unit = await started[0]!;
  const code = await within(unit.exited, ROUND_TRIP_WITHIN_MS);
  return roundTripVerdict(
    request.argv,
    code === undefined
      ? "the unit's process did not answer"
      : await readEcho(echo, code),
  );
}

/**
 * The verdict when the provider answered `already-running` and started no
 * unit: a skip for a scale or wake platform, whose unit may be up already,
 * and a failure for a launch platform, which starts a unit per attempt.
 */
function alreadyRunning(run: KitRun): ["fail" | "skip", string] {
  return run.capabilities.style === "launch"
    ? [
        "fail",
        "a launch platform answered already-running for a fresh attempt and started no unit, so no arguments reached one",
      ]
    : [
        "skip",
        "the platform answered already-running and started no unit, so no arguments reached one",
      ];
}

/**
 * The round trip for a self-hosted provider (no platform): the provider
 * starts the kit's fixture worker itself, so the echo file reaches it through
 * the request's `env`, as test control, never identity. With no platform
 * count to read, a scale provider's unit is released to zero afterwards (a
 * self-hosted run's units are all the kit's), naming its queues and group; a
 * release that throws fails the check, as on a fake.
 */
async function selfHostedArgv(run: KitRun, id: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bun-jobs-conformance-argv-"));
  const echo = join(dir, "args.json");
  const request = run.request({
    queues: ROUND_TRIP_QUEUES,
    group: ROUND_TRIP_GROUP,
    count: 1,
    env: { [FIXTURE_ENV.echo]: echo },
  });
  let verdict: ["pass" | "fail" | "skip", string];
  try {
    const outcome = await run.call(
      async (context) => await run.facet.summon(request, context),
    );
    if (!outcome.ok) {
      verdict = ["fail", `summon threw ${describeThrown(outcome.error)}`];
    } else if (outcome.value?.status === "already-running") {
      verdict = alreadyRunning(run);
    } else {
      for (const handle of outcome.value?.status === "started"
        ? outcome.value.handles
        : []) {
        run.handles.add(handle);
      }
      const by = Date.now() + ROUND_TRIP_WITHIN_MS;
      while (!(await Bun.file(echo).exists()) && Date.now() < by) {
        await pause(20);
      }
      await pause(50);
      verdict = roundTripVerdict(
        request.argv,
        (await Bun.file(echo).exists())
          ? ((await Bun.file(echo).json()) as EchoedArgs)
          : "the unit's process never read its arguments",
      );
    }
  } catch (error) {
    verdict = ["fail", `the round trip failed: ${run.explain(error)}`];
  }
  try {
    if (run.capabilities.style === "scale" && run.facet.release !== undefined) {
      const released = await run.call(
        async (context) =>
          await run.facet.release!(
            {
              namespace: request.namespace,
              queue: request.queue,
              queues: request.queues ?? [request.queue],
              ...(request.group === undefined ? {} : { group: request.group }),
              target: 0,
            },
            context,
          ),
      );
      if (!released.ok) {
        const why = `release of the round trip's unit (target 0) threw ${describeThrown(released.error)}`;
        verdict =
          verdict[0] === "fail"
            ? ["fail", `${verdict[1]}; and the ${why}`]
            : ["fail", `the ${why}`];
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  run.set(id, ...verdict);
}

/** What the fixture worker wrote in echo mode. */
interface EchoedArgs {
  /** Its arguments, after the script. */
  argv: string[];
  /** What `summonedFromArgs()` read from them. */
  summon: {
    /** The queues it read. */
    queues?: readonly string[];
    /** The group it read. */
    group?: string;
  } | null;
}

/** The fixture's echo, or why there is none: it exited `code` without writing one. */
async function readEcho(
  /** The file it was told to write. */
  path: string,
  /** Its exit code. */
  code: number,
): Promise<EchoedArgs | string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return `the unit's process exited ${code} without reading its arguments`;
  }
  return (await file.json()) as EchoedArgs;
}

/**
 * The first argument of `sent` that `received` lacks once every earlier one
 * is matched in order (`sent` must be a subsequence of `received`), or
 * `undefined` when all of them arrived in order. A platform may add
 * arguments of its own around them; it may not drop or reorder any.
 */
function missingInOrder(
  /** The arguments the request carried. */
  sent: readonly string[],
  /** The arguments the unit's process received. */
  received: readonly string[],
): { index: number; arg: string; elsewhere: boolean } | undefined {
  let at = 0;
  for (const [index, arg] of sent.entries()) {
    const found = received.indexOf(arg, at);
    if (found === -1) {
      return { index, arg, elsewhere: received.includes(arg) };
    }
    at = found + 1;
  }
  return undefined;
}

/** The round trip's verdict: whether the unit saw every argument the request carried, in order. */
function roundTripVerdict(
  /** The arguments the request carried. */
  sent: readonly string[],
  /** What the unit read, or why nothing was read. */
  echoed: EchoedArgs | string,
): ["pass" | "fail", string] {
  if (typeof echoed === "string") {
    return ["fail", echoed];
  }
  const queueArgs = (argv: readonly string[]): string[] =>
    argv.filter((arg) => arg.startsWith(`${SUMMON_ARGS.queue}=`));
  const expected = queueArgs(sent);
  const received = queueArgs(echoed.argv);
  if (JSON.stringify(received) !== JSON.stringify(expected)) {
    return [
      "fail",
      `the unit received ${received.length} ${SUMMON_ARGS.queue}= argument(s), ${JSON.stringify(received.map((arg) => arg.slice(SUMMON_ARGS.queue.length + 1)))}, where the request had ${JSON.stringify([...ROUND_TRIP_QUEUES])}: pass request.argv to the unit whole and in order, repeated arguments included`,
    ];
  }
  const missing = missingInOrder(sent, echoed.argv);
  if (missing !== undefined) {
    const flag = missing.arg.slice(0, missing.arg.indexOf("=") + 1);
    return [
      "fail",
      missing.elsewhere
        ? `the unit received request.argv out of order: argument ${missing.index + 1} of ${sent.length} (${flag}) arrived before one the request put ahead of it; pass request.argv to the unit whole and in order`
        : `the unit never received argument ${missing.index + 1} of ${sent.length} (${flag}): pass request.argv to the unit whole and in order`,
    ];
  }
  if (
    JSON.stringify(echoed.summon?.queues) !==
      JSON.stringify(ROUND_TRIP_QUEUES) ||
    echoed.summon?.group !== ROUND_TRIP_GROUP
  ) {
    return [
      "fail",
      `summonedFromArgs() in the unit read queues ${JSON.stringify(echoed.summon?.queues ?? null)} and group ${JSON.stringify(echoed.summon?.group ?? null)}`,
    ];
  }
  return [
    "pass",
    `all ${sent.length} arguments arrived in order, the ${expected.length} repeated ${SUMMON_ARGS.queue}= among them`,
  ];
}

/** The handoff group's checks, in order. */
const HANDOFF_IDS = [
  "summon.handoff.started",
  "summon.handoff.released",
  "summon.handoff.drained",
  "summon.handoff.scale-down",
] as const;

/** Fails the handoff at stage `from`, and skips every later stage. */
function handoffFailer(run: KitRun): (from: number, detail: string) => void {
  return (from, detail) => {
    run.set(HANDOFF_IDS[from]!, "fail", detail);
    for (const id of HANDOFF_IDS.slice(from + 1)) {
      run.set(id, "skip", `skipped: ${HANDOFF_IDS[from]} failed`);
    }
  };
}

/** The handoff group: claim, call, boot, register, release, drain, exit. */
export async function handoffChecks(run: KitRun): Promise<void> {
  if (run.selfHosted) {
    await selfHostedHandoff(run);
    return;
  }
  const fake = fakeOf(run);
  const fail = handoffFailer(run);

  const store = await backend(run);
  const namespace = `conformance-${randomHex(6)}`;
  fake.internals.namespaces.push(namespace);
  const queueName = "work";
  let driver: JobsDriver | undefined;
  let queue: BunQueue<unknown> | undefined;
  let controller: SummonController | undefined;
  const spawner = unitSpawner(FIXTURE_WORKER, {
    [FIXTURE_ENV.driver]: JSON.stringify(store.config),
    [FIXTURE_ENV.namespace]: namespace,
    [FIXTURE_ENV.queue]: queueName,
    [FIXTURE_ENV.idleMs]: String(FIXTURE_IDLE_MS),
  });
  const units: { unit: FakeUnit; process: SpawnedUnit }[] = [];
  const events: SummonEventPayload[] = [];
  /** Which of `ids` the handoff has reached. */
  let stage = 0;
  const starting: Promise<void>[] = [];
  fake.platform.onStart((unit) => {
    starting.push(
      (async () => {
        const process = await spawner.start({ argv: unit.argv });
        units.push({ unit, process });
        fake.internals.mark(unit.handle, "running");
        fake.internals.onStop(unit.handle, () => {
          process.proc.kill("SIGTERM");
        });
        void process.exited.then(() => {
          fake.internals.mark(unit.handle, "exited");
        });
      })(),
    );
  });

  try {
    driver = createDriver(store.config);
    await driver.connect();
    queue = new BunQueue(queueName, {
      namespace,
      driver,
      logger: run.logger,
    });
    await queue.addBulk(
      Array.from({ length: HANDOFF_JOBS }, (_, index) => ({
        name: "conformance",
        data: { index },
      })),
    );

    try {
      controller = new SummonController({
        driver,
        namespace,
        queue: queueName,
        summoner: run.summoner,
        triggers: { onAdd: false, events: false, poll: false },
        cooldown: 0,
        bootBudget: REGISTER_WITHIN_MS,
        maxLifetime: kitLifetime(run.capabilities),
        scaleDown: { after: 0 },
        logger: run.logger,
        [PROVIDER_FETCH_PROBE]: run.fetch,
      } as SummonControllerOptions);
    } catch (error) {
      fail(0, `a SummonController refused the provider: ${run.explain(error)}`);
      return;
    }
    controller.on("summon", (event) => events.push(event));

    const first = await controller.check();
    run.scanned.push(first);
    if (first.action !== "summoned" || first.outcome !== "started") {
      fail(
        0,
        `the controller's first check answered ${first.action}${"outcome" in first ? ` ${String(first.outcome)}` : ""}${"reason" in first ? ` (${String(first.reason)})` : ""}, not summoned/started`,
      );
      return;
    }
    const attempt = first.id;
    run.set("summon.handoff.started", "pass");
    stage = 1;
    const summonedAt = Date.now();

    // Registration: the controller releases the attempt when the worker's
    // record carries its id (passes "argv") or started after it ("none").
    const deadline = Date.now() + REGISTER_WITHIN_MS;
    let registered = false;
    while (Date.now() < deadline) {
      await controller.check();
      if (
        events.some(
          (event) => event.id === attempt && event.outcome === "registered",
        )
      ) {
        registered = true;
        break;
      }
      if (
        events.some((event) => event.id === attempt && event.outcome === "lost")
      ) {
        break;
      }
      await Promise.all(starting);
      // Every worker came and went without releasing it: nothing will.
      if (
        units.length > 0 &&
        (
          await Promise.all(
            units.map(async ({ process }) => await within(process.exited, 0)),
          )
        ).every((code) => code !== undefined)
      ) {
        await controller.check();
        registered = events.some(
          (event) => event.id === attempt && event.outcome === "registered",
        );
        break;
      }
      // No unit five seconds on: the fake's route never started one.
      if (units.length === 0 && Date.now() - summonedAt > 5_000) {
        break;
      }
      await pause(100);
    }
    await Promise.all(starting);
    if (!registered) {
      const records = (
        await Promise.all(
          units.map(
            async ({ process }) =>
              (await within(unitLines(process), 1_000)) ?? [],
          ),
        )
      )
        .flat()
        .filter((line) => line.event === "record");
      fail(
        1,
        units.length === 0
          ? "the fake started no unit for the attempt"
          : run.capabilities.passes === "argv"
            ? `the worker never released attempt ${attempt}: ${records.length === 0 ? "it ran and exited" : `its record carried ${JSON.stringify(records[0]!.summon)}`} without the attempt's id (the provider must pass request.argv to the unit)`
            : "the worker never released the attempt by its start time",
      );
      return;
    }
    run.set(
      "summon.handoff.released",
      "pass",
      run.capabilities.passes === "argv" ? "by id" : "by start time",
    );
    stage = 2;

    // Drain: the backlog empties and the worker exits 0 (scale: once the
    // controller has set the count back to zero).
    const drainBy = Date.now() + DRAIN_WITHIN_MS;
    let drained = false;
    while (Date.now() < drainBy) {
      const demand = await queue.getDemand();
      if (demand.outstanding === 0) {
        drained = true;
        break;
      }
      await pause(100);
    }
    if (!drained) {
      fail(2, `the backlog of ${HANDOFF_JOBS} jobs did not drain`);
      return;
    }
    if (run.capabilities.style === "scale") {
      while (Date.now() < drainBy && fake.internals.liveCount() > 0) {
        await controller.check();
        await pause(100);
      }
    }
    const codes = await within(
      Promise.all(units.map(async ({ process }) => await process.exited)),
      Math.max(1_000, drainBy - Date.now()),
    );
    if (codes === undefined) {
      fail(
        2,
        run.capabilities.style === "scale"
          ? "the worker was not stopped after the controller released the count"
          : "the worker did not exit once the queue was idle",
      );
      return;
    }
    const bad = codes.find((code) => code !== 0);
    if (bad !== undefined) {
      const stderr = (await within(units[0]!.process.errors, 1_000)) ?? "";
      fail(
        2,
        `the worker exited ${bad}${stderr === "" ? "" : `: ${textRedactor(run.secrets)(stderr.trim().split("\n").slice(-3).join(" | "))}`}`,
      );
      return;
    }
    run.set("summon.handoff.drained", "pass");
    stage = 3;
    // Nothing more is the handoff's: a unit the scale-down check starts
    // stays a unit on the fake, with no worker process behind it.
    fake.platform.onStart(undefined);
    await scaleDownCheck(run, driver);
  } catch (error) {
    fail(stage, `the handoff failed: ${run.explain(error)}`);
  } finally {
    fake.platform.onStart(undefined);
    if (controller !== undefined) {
      run.scanned.push(await controller.status().catch(() => undefined));
      await controller.close().catch(() => {});
    }
    run.scanned.push(events);
    await within(spawner.kill("SIGKILL"), 5_000);
    await queue?.close().catch(() => {});
    await driver?.purge(namespace).catch(() => {});
    // The direct calls' namespace: nothing should have written there, but
    // the kit leaves no name of its own behind.
    await driver?.purge(run.namespace).catch(() => {});
    await driver?.close().catch(() => {});
    await store.cleanup();
  }
}

/** Whether a unit `status()` reports is still on its way or running. */
function live(unit: UnitStatus): boolean {
  return unit.state === "pending" || unit.state === "running";
}

/** A short account of what `status()` said of the units. */
function describeUnits(units: readonly UnitStatus[] | undefined): string {
  if (units === undefined || units.length === 0) {
    return "status() said nothing of its unit";
  }
  return units
    .map(
      (unit) =>
        `${unit.state}${unit.exitCode === undefined ? "" : ` ${unit.exitCode}`}${unit.detail === undefined ? "" : ` (${unit.detail})`}`,
    )
    .join(", ");
}

/**
 * The handoff for a self-hosted provider (no platform): the provider starts
 * the kit's fixture worker itself ({@link FIXTURE_WORKER}, which it was
 * configured to run), the worker's test settings reach it as the policy's
 * `env`, and the unit is followed through `status()` alone.
 */
async function selfHostedHandoff(run: KitRun): Promise<void> {
  const fail = handoffFailer(run);
  const { status } = run.facet;
  if (status === undefined) {
    fail(
      0,
      "a self-hosted provider needs status(): with no platform, nothing else can say whether its unit ran and exited",
    );
    return;
  }
  const store = await backend(run);
  const namespace = `conformance-${randomHex(6)}`;
  const queueName = "work";
  let driver: JobsDriver | undefined;
  let queue: BunQueue<unknown> | undefined;
  let controller: SummonController | undefined;
  const events: SummonEventPayload[] = [];
  let handles: string[] = [];
  let stage = 0;
  /** What `status()` says of the attempt's units now, or `undefined` when it threw. */
  const units = async (): Promise<readonly UnitStatus[] | undefined> => {
    if (handles.length === 0) {
      return [];
    }
    const answer = await run.call(
      async (context) => await status(handles, context),
    );
    return answer.ok ? answer.value : undefined;
  };

  try {
    driver = createDriver(store.config);
    await driver.connect();
    queue = new BunQueue(queueName, {
      namespace,
      driver,
      logger: run.logger,
    });
    await queue.addBulk(
      Array.from({ length: HANDOFF_JOBS }, (_, index) => ({
        name: "conformance",
        data: { index },
      })),
    );

    try {
      controller = new SummonController({
        driver,
        namespace,
        queue: queueName,
        summoner: run.summoner,
        triggers: { onAdd: false, events: false, poll: false },
        cooldown: 0,
        bootBudget: REGISTER_WITHIN_MS,
        maxLifetime: kitLifetime(run.capabilities),
        scaleDown: { after: 0 },
        // Test control for the fixture worker, never identity: the
        // provider passes the policy's env to its unit like any other.
        env: {
          [FIXTURE_ENV.driver]: JSON.stringify(store.config),
          [FIXTURE_ENV.namespace]: namespace,
          [FIXTURE_ENV.queue]: queueName,
          [FIXTURE_ENV.idleMs]: String(FIXTURE_IDLE_MS),
        },
        logger: run.logger,
        [PROVIDER_FETCH_PROBE]: run.fetch,
      } as SummonControllerOptions);
    } catch (error) {
      fail(0, `a SummonController refused the provider: ${run.explain(error)}`);
      return;
    }
    controller.on("summon", (event) => events.push(event));

    const first = await controller.check();
    run.scanned.push(first);
    if (first.action !== "summoned" || first.outcome !== "started") {
      fail(
        0,
        `the controller's first check answered ${first.action}${"outcome" in first ? ` ${String(first.outcome)}` : ""}${"reason" in first ? ` (${String(first.reason)})` : ""}, not summoned/started`,
      );
      return;
    }
    const attempt = first.id;
    handles = [
      ...(events.find(
        (event) => event.id === attempt && event.outcome === "started",
      )?.handles ??
        (await controller.status()).pending.find(
          (pending) => pending.id === attempt,
        )?.handles ??
        []),
    ];
    for (const handle of handles) {
      run.handles.add(handle);
    }
    run.set("summon.handoff.started", "pass");
    stage = 1;

    const deadline = Date.now() + REGISTER_WITHIN_MS;
    let registered = false;
    let seen: readonly UnitStatus[] | undefined;
    while (Date.now() < deadline) {
      await controller.check();
      if (
        events.some(
          (event) => event.id === attempt && event.outcome === "registered",
        )
      ) {
        registered = true;
        break;
      }
      if (
        events.some((event) => event.id === attempt && event.outcome === "lost")
      ) {
        break;
      }
      if (handles.length === 0) {
        break;
      }
      seen = await units();
      // Every unit came and went without releasing it: nothing will.
      if (seen !== undefined && seen.length > 0 && !seen.some(live)) {
        await controller.check();
        registered = events.some(
          (event) => event.id === attempt && event.outcome === "registered",
        );
        break;
      }
      await pause(100);
    }
    if (!registered) {
      fail(
        1,
        handles.length === 0
          ? "the provider answered no handle for the attempt, so nothing can be followed"
          : `the unit never released attempt ${attempt}; ${describeUnits(seen ?? (await units()))}. The provider must pass request.argv to the unit as its arguments, and request.env as its environment`,
      );
      return;
    }
    run.set("summon.handoff.released", "pass", "by id");
    stage = 2;

    const drainBy = Date.now() + DRAIN_WITHIN_MS;
    let drained = false;
    while (Date.now() < drainBy) {
      const demand = await queue.getDemand();
      if (demand.outstanding === 0) {
        drained = true;
        break;
      }
      await pause(100);
    }
    if (!drained) {
      fail(2, `the backlog of ${HANDOFF_JOBS} jobs did not drain`);
      return;
    }
    // As the fake's handoff: the drain's budget, and at least a second.
    const exitBy = Math.max(drainBy, Date.now() + 1_000);
    let after = await units();
    while (Date.now() < exitBy && (after === undefined || after.some(live))) {
      await pause(100);
      after = await units();
    }
    if (after === undefined || after.some(live)) {
      fail(
        2,
        after === undefined
          ? "status() threw while the kit waited for the unit to exit"
          : "the worker did not exit once the queue was idle",
      );
      return;
    }
    const bad = after.find(
      (unit) => unit.state !== "exited" || (unit.exitCode ?? 0) !== 0,
    );
    if (bad !== undefined) {
      fail(2, `the worker ended ${describeUnits([bad])}`);
      return;
    }
    run.set("summon.handoff.drained", "pass");
    stage = 3;
    run.set(
      "summon.handoff.scale-down",
      "skip",
      run.capabilities.style === "scale"
        ? "a self-hosted provider has no platform count to read"
        : `style is ${run.capabilities.style}`,
    );
  } catch (error) {
    fail(stage, `the handoff failed: ${run.explain(error)}`);
  } finally {
    if (controller !== undefined) {
      run.scanned.push(await controller.status().catch(() => undefined));
      await controller.close().catch(() => {});
    }
    run.scanned.push(events);
    const { cancel } = run.facet;
    const left = (await units().catch(() => undefined)) ?? [];
    if (cancel !== undefined && left.some(live)) {
      await run.call(async (context) => await cancel(handles, context));
    }
    await queue?.close().catch(() => {});
    await driver?.purge(namespace).catch(() => {});
    await driver?.purge(run.namespace).catch(() => {});
    await driver?.close().catch(() => {});
    await store.cleanup();
  }
}

/** How long a scale controller has to release an idle queue's count, in ms. */
const SCALE_DOWN_WITHIN_MS = 5_000;

/**
 * Scale style: a controller built on a fresh instance of the provider, over a
 * queue with nothing outstanding, sets the platform's count back to zero —
 * including while an asynchronous config is still validating when it is
 * built, so it must adopt the real capabilities without an attempt to adopt
 * them at.
 */
async function scaleDownCheck(run: KitRun, driver: JobsDriver): Promise<void> {
  const id = "summon.handoff.scale-down";
  if (run.capabilities.style !== "scale") {
    run.set(id, "skip", `style is ${run.capabilities.style}`);
    return;
  }
  // Something running on the platform, and nothing to do.
  const bumped = await run.call(
    async (context) =>
      await run.facet.summon(run.request({ count: 1, target: 1 }), context),
  );
  if (!bumped.ok || fakeOf(run).internals.liveCount() === 0) {
    run.set(
      id,
      "fail",
      bumped.ok
        ? "summon with target 1 left nothing running on the fake"
        : `summon threw ${describeThrown(bumped.error)}`,
    );
    return;
  }
  const namespace = `conformance-idle-${randomHex(6)}`;
  fakeOf(run).internals.namespaces.push(namespace);
  const controller = new SummonController({
    driver,
    namespace,
    queue: "work",
    summoner: run.fresh(),
    triggers: { onAdd: false, events: false, poll: false },
    cooldown: 0,
    maxLifetime: kitLifetime(run.capabilities),
    scaleDown: { after: 0 },
    logger: run.logger,
    [PROVIDER_FETCH_PROBE]: run.fetch,
  } as SummonControllerOptions);
  try {
    const by = Date.now() + SCALE_DOWN_WITHIN_MS;
    while (Date.now() < by && fakeOf(run).internals.liveCount() > 0) {
      run.scanned.push(await controller.check());
      await pause(100);
    }
    const left = fakeOf(run).internals.liveCount();
    run.set(
      id,
      left === 0 ? "pass" : "fail",
      left === 0
        ? undefined
        : `a scale controller over an idle queue left a count of ${left} after ${SCALE_DOWN_WITHIN_MS} ms`,
    );
  } finally {
    await controller.close().catch(() => {});
    await driver.purge(namespace).catch(() => {});
  }
}

/**
 * A real controller for the errors group's verdicts: one check per fault,
 * each on its own namespace with one job, under a circuit of 5 failures and
 * a 100 ms backoff, so the platform's retry-after (2 s) is what a throttled
 * backoff must honour.
 */
export async function verdictProbe(run: KitRun): Promise<{
  /** Runs one check with the injected fault, and reads what it recorded. */
  probe: VerdictProbe;
  /** Closes the driver and removes a temporary backend. */
  close: () => Promise<void>;
}> {
  const store = await backend(run);
  const driver = createDriver(store.config);
  let connected: unknown;
  try {
    await driver.connect();
  } catch (error) {
    connected = error;
  }
  const probe: VerdictProbe = async () => {
    if (connected !== undefined) {
      return `the backend for the controller's verdict could not connect: ${run.explain(connected)}`;
    }
    const namespace = `conformance-err-${randomHex(6)}`;
    run.internals?.namespaces.push(namespace);
    const queue = new BunQueue("work", {
      namespace,
      driver,
      logger: run.logger,
    });
    let controller: SummonController | undefined;
    try {
      await queue.add("conformance", {});
      controller = new SummonController({
        driver,
        namespace,
        queue: "work",
        summoner: run.summoner,
        triggers: { onAdd: false, events: false, poll: false },
        cooldown: 0,
        backoff: {
          initial: VERDICT_POLICY.backoffMs,
          max: VERDICT_POLICY.backoffMs,
        },
        circuit: {
          failures: VERDICT_POLICY.circuitFailures,
          resetAfter: VERDICT_POLICY.resetAfterMs,
        },
        bootBudget: REGISTER_WITHIN_MS,
        maxLifetime: kitLifetime(run.capabilities),
        logger: run.logger,
        [PROVIDER_FETCH_PROBE]: run.fetch,
      } as SummonControllerOptions);
      const started = Date.now();
      const result = await controller.check();
      const status = await controller.status();
      run.scanned.push(result, status);
      return {
        outcome: result.action === "summoned" ? result.outcome : result.action,
        failures: status.failures,
        circuitOpen: (status.circuitOpenUntil ?? 0) > Date.now(),
        backoffMs: Math.max(0, (status.backoffUntil ?? started) - started),
        ...(status.last?.detail === undefined
          ? {}
          : { detail: status.last.detail }),
      };
    } catch (error) {
      return `the controller's check failed: ${run.explain(error)}`;
    } finally {
      await controller?.close().catch(() => {});
      await queue.close().catch(() => {});
      await driver.purge(namespace).catch(() => {});
    }
  };
  return {
    probe,
    close: async () => {
      await driver.close().catch(() => {});
      await store.cleanup();
    },
  };
}

/**
 * The compare-and-set group: two controllers in two processes race on one
 * backlog, and one `summon` call reaches the provider. Each racer's summoner
 * forwards its call here, where the kit calls the real facet.
 */
export async function casChecks(run: KitRun): Promise<void> {
  const id = "summon.cas.one-call";
  const store = await backend(run);
  const calls: SummonRequest[] = [];
  const failures: string[] = [];
  const server: Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/summon": {
        POST: async (request) => {
          const summon = (await request.json()) as SummonRequest;
          calls.push(summon);
          const outcome = await run.call(
            async (context) => await run.facet.summon(summon, context),
          );
          return outcome.ok
            ? Response.json({ result: outcome.value })
            : Response.json(
                { error: describeThrown(outcome.error) },
                { status: 500 },
              );
        },
      },
      "/release": {
        POST: async (request) => {
          const release = (await request.json()) as SummonReleaseRequest;
          const outcome = await run.call(
            async (context) => await run.facet.release?.(release, context),
          );
          return outcome.ok
            ? Response.json({ result: null })
            : Response.json(
                { error: describeThrown(outcome.error) },
                { status: 500 },
              );
        },
      },
    },
    fetch: () => new Response(null, { status: 404 }),
  });
  let driver: JobsDriver | undefined;
  try {
    driver = createDriver(store.config);
    await driver.connect();
    for (let round = 0; round < CAS_ROUNDS; round++) {
      const namespace = `conformance-cas-${randomHex(6)}`;
      run.internals?.namespaces.push(namespace);
      const queue = new BunQueue("work", {
        namespace,
        driver,
        logger: run.logger,
      });
      try {
        await queue.add("conformance", {});
        const before = calls.length;
        const env = {
          [RACER_ENV.driver]: JSON.stringify(store.config),
          [RACER_ENV.namespace]: namespace,
          [RACER_ENV.queue]: "work",
          [RACER_ENV.startAt]: String(Date.now() + 1_500),
          [RACER_ENV.checks]: String(CAS_CHECKS),
          [RACER_ENV.forward]: `http://127.0.0.1:${server.port}`,
          [RACER_ENV.provider]: JSON.stringify({
            kind: run.identity.kind,
            capabilities: run.capabilities,
          }),
        };
        const racers = [spawnUnit(RACER, env), spawnUnit(RACER, env)];
        const codes = await within(
          Promise.all(racers.map(async (racer) => await racer.exited)),
          30_000,
        );
        if (codes === undefined || codes.some((code) => code !== 0)) {
          for (const racer of racers) {
            racer.proc.kill("SIGKILL");
          }
          const stderr = (await within(racers[0]!.errors, 1_000)) ?? "";
          failures.push(
            `round ${round + 1}: a racer ${codes === undefined ? "hung" : `exited ${codes.find((code) => code !== 0)}`}${stderr === "" ? "" : `: ${textRedactor(run.secrets)(stderr.trim().split("\n").slice(-2).join(" | "))}`}`,
          );
          break;
        }
        // A racer that died quietly raced nobody: each prints one line per check.
        const printed = await Promise.all(
          racers.map(async (racer) => {
            const lines = await unitLines(racer);
            return lines.filter((line) => "action" in line).length;
          }),
        );
        const short = printed.findIndex((count) => count !== CAS_CHECKS);
        if (short !== -1) {
          failures.push(
            `round ${round + 1}: racer ${short + 1} reported ${printed[short]} of its ${CAS_CHECKS} checks, so the controllers did not both race`,
          );
          break;
        }
        const reached = calls.length - before;
        if (reached !== 1) {
          // What each racer's checks answered, so a failure says why.
          const answers = (
            await Promise.all(
              racers.map(async (racer) => await unitLines(racer)),
            )
          )
            .flat()
            .map(
              (line) =>
                `${String(line.action)}${line.reason === null ? "" : `/${String(line.reason)}`}`,
            );
          failures.push(
            `round ${round + 1}: two controllers racing on one backlog made ${reached} summon calls (checks answered ${answers.join(", ")})`,
          );
          break;
        }
      } finally {
        await queue.close().catch(() => {});
        await driver.purge(namespace).catch(() => {});
      }
    }
    run.set(
      id,
      failures.length === 0 ? "pass" : "fail",
      failures.length === 0
        ? `${CAS_ROUNDS} rounds, one call each`
        : failures.join("; "),
    );
  } catch (error) {
    run.set(id, "fail", `the race failed: ${run.explain(error)}`);
  } finally {
    await server.stop(true);
    await driver?.close().catch(() => {});
    await store.cleanup();
  }
}
