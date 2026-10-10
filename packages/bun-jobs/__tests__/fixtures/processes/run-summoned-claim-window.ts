import type { DriverConfig, JobsDriver } from "../../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  BunQueue,
  BunQueueWorker,
  createDriver,
  MemoryDriver,
  runSummoned,
  summonedFromArgs,
} from "../../../lib/index";
import { WORKER_CONFIG_PREFIX } from "../../../lib/queue/workerControl";
import {
  SUMMON_CLAIM_PREFIX,
  summonClaimName,
} from "../../../lib/summon/claim";

/**
 * A summoned unit stopped while `renders`' summon claim has committed but its
 * worker does not know it yet (`worker.summon` unset), for
 * `run-summoned-claim-window.test.ts`. `renders` owns its driver (`DRIVER`, a
 * config), `thumbs` runs on a memory driver. Reports JSON lines on stdout,
 * ending with `claim`: the exit mark on `renders`' claim, read back.
 *
 * Configured by the environment:
 *
 * - `MODE=window` (default): renders' claim write is held `COMMIT_DELAY` ms
 *   after it commits, and the stop is sent the moment it commits — `SIGUSR2`
 *   with `STOP=signal` (default), or with `STOP=fail` a third worker, `maps`,
 *   whose connect fails then (reason `error`, code `1`). With `READY=1`,
 *   renders' control is off and its claim is held until it is ready: a ready
 *   worker whose first report's claim is still in flight. Otherwise its
 *   config read is held until the unit begins closing: a worker starting.
 * - `MODE=natural`: nothing is injected. `thumbs`' connect fails `FAIL_MS`
 *   in; with timing alone the failure lands before, inside or after the
 *   window, depending on the backend. `CONTROL=1` turns renders' control on.
 *
 * Adapted from the #313 round-3 review's probes.
 */

/** Prints one JSON line. */
function report(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

const env = process.env;
const summon = summonedFromArgs()!;
const namespace = summon.namespace!;
const config = JSON.parse(env.DRIVER!) as DriverConfig;
const natural = env.MODE === "natural";
const delay = Number(env.COMMIT_DELAY ?? 0);
const readyFirst = env.READY === "1";

/** Fails `maps`' connect (window mode) when it resolves. */
const fail = Promise.withResolvers<void>();

/**
 * A memory driver whose `connect()` fails: `FAIL_MS` after it is called in
 * natural mode, once {@link fail} resolves otherwise.
 */
class FailingDriver extends MemoryDriver {
  override async connect(): Promise<void> {
    if (natural) {
      await Bun.sleep(Number(env.FAIL_MS ?? 0));
    } else {
      await fail.promise;
    }
    throw new Error("connect refused (fixture)");
  }
}

const common = {
  namespace,
  summon,
  logger: noopLogger,
  pollInterval: 20,
  reportInterval: 200,
} as const;
const renders = new BunQueueWorker(
  "renders",
  async (): Promise<string> => {
    report("renders-handler-ran");
    return "ok";
  },
  {
    ...common,
    driver: config,
    control: natural ? env.CONTROL === "1" : !readyFirst,
  },
);
const thumbs = new BunQueueWorker("thumbs", async () => "ok", {
  ...common,
  driver: natural ? new FailingDriver() : new MemoryDriver(),
});
const maps =
  !natural && env.STOP === "fail"
    ? new BunQueueWorker("maps", async () => "ok", {
        ...common,
        driver: new FailingDriver(),
      })
    : undefined;

let closingSeen = false;
const configHeld = Promise.withResolvers<void>();
const rendersReady = Promise.withResolvers<void>();
renders.on("ready", () => {
  report("renders-ready");
  rendersReady.resolve();
});

if (!natural) {
  const driver = renders.driver as JobsDriver & {
    getQueueState: NonNullable<JobsDriver["getQueueState"]>;
    setQueueState: NonNullable<JobsDriver["setQueueState"]>;
  };
  const get = driver.getQueueState.bind(driver);
  const set = driver.setQueueState.bind(driver);
  let claimRead = false;
  driver.getQueueState = async (...args) => {
    const [, name] = args;
    if (!readyFirst && name.startsWith(WORKER_CONFIG_PREFIX) && !closingSeen) {
      await configHeld.promise;
    }
    if (name.startsWith(SUMMON_CLAIM_PREFIX) && !claimRead) {
      claimRead = true;
      if (readyFirst) {
        await rendersReady.promise;
      }
    }
    return await get(...args);
  };
  let claimed = false;
  driver.setQueueState = async (...args) => {
    const result = await set(...args);
    const [, name, , expected] = args;
    if (
      !claimed &&
      name.startsWith(SUMMON_CLAIM_PREFIX) &&
      expected === null &&
      !closingSeen
    ) {
      claimed = true;
      report("claim-committed", { summonKnown: renders.summon !== undefined });
      if (env.STOP === "fail") {
        fail.resolve();
      } else {
        process.kill(process.pid, "SIGUSR2");
      }
      await Bun.sleep(delay);
      report("claim-call-returning", { closingSeen });
    }
    return result;
  };
}

const seed = createDriver(config);
await seed.connect();
await new BunQueue("renders", {
  namespace,
  driver: seed,
  logger: noopLogger,
}).add("work", {}, { attempts: 1 });

const result = await runSummoned(
  natural ? [thumbs, renders] : [thumbs, renders, ...(maps ? [maps] : [])],
  {
    exit: false,
    signals: ["SIGUSR2"],
    grace: 10_000,
    idleFor: 60_000,
    idleCheckInterval: 50,
    logger: (event) => {
      if (event.level === "warn" || event.level === "error") {
        report("log", { level: event.level, message: event.message });
      }
      if (event.message.startsWith("Summoned worker closing")) {
        closingSeen = true;
        report("closing", { message: event.message });
        setTimeout(() => configHeld.resolve(), 0);
      }
    },
  },
);
report("result", { reason: result.reason, code: result.code });
const claim = await seed.getQueueState!(
  renders.ref,
  summonClaimName(summon.id),
);
const holders = (claim?.value as { holders?: { exit?: unknown }[] } | undefined)
  ?.holders;
report("claim", {
  held: holders !== undefined && holders.length > 0,
  exit: holders?.[0]?.exit ?? null,
});
await seed.close();
process.exit(0);
