/**
 * Summoning on this host: `localCompute` from `@kingsleyweb/bun-jobs/provider`,
 * the provider whose units are child processes of the queue's own process.
 *
 * ```bash
 * bun 02-queues/local-compute.ts
 * ```
 *
 * Every unit here runs `02-queues/helpers/local-unit.ts`, which reports its
 * pid and environment to a file and then works the queue with `runSummoned`
 * (or, for the steps about stopping, waits for a signal). The host whose
 * shutdown is watched is `02-queues/helpers/local-host.ts`, run as a child
 * process so the tour can signal it without signalling itself. A unit is a
 * separate process and cannot see this one's memory, so on the memory
 * driver this runs on a temporary SQLite file, as the controller requires.
 *
 * The points that are easy to get wrong:
 *
 * - **The entry is a worker script of its own**: a unit is `bun <entry>
 *   [...args] --bun-jobs-summon-*=…`, and the summon arguments always come
 *   last. Its backend travels in the summon policy's `env`.
 * - **The environment is an allowlist**: `CHILD_BASE_ENV` copied from the
 *   host's *live* `process.env`, then `passEnv` by name, then `env`'s
 *   literal values (`undefined` removes one), then the policy's `env`. A
 *   variable the host holds and names nowhere does not reach a unit.
 * - **`maxUnits` caps the units one configured instance runs at once**,
 *   across every queue it serves. A summon starts what fits; with none free
 *   it answers `unavailable` (`max-units: N of N running`), which the
 *   controller counts as a failure and backs off from.
 * - **Units stop with the host**, and what they started with them: on a
 *   `SIGINT`, `SIGTERM` or `SIGHUP` each unit's process group gets its stop
 *   signal (then `SIGKILL` after the grace), and on exit `SIGKILL` at once.
 *   From the first signal on, a summon answers `unavailable`
 *   (`host-shutdown: the host is stopping`), even while the app's own
 *   shutdown keeps the host alive.
 * - **`cgroup` is read when you configure the provider**: a path that is
 *   not a cgroup v2 directory is a `ConfigError` there, and whether a unit
 *   can run in it is `validate()`'s `cgroup` check. Without root it must
 *   sit in a subtree systemd delegates to your user.
 * - **The conformance kit runs it self-hosted**: `platform: "none"` is
 *   required for a provider with no platform API, and skips what needs one.
 */
import type { SummonEventPayload } from "@kingsleyweb/bun-jobs";
import type { UnitStatus } from "@kingsleyweb/bun-jobs/provider";
import type { Subprocess } from "bun";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import {
  CHILD_BASE_ENV,
  localCompute,
  removeCgroupTree,
} from "@kingsleyweb/bun-jobs/provider";
import {
  assertConformance,
  CONFORMANCE_WORKER,
  runProviderConformance,
} from "@kingsleyweb/bun-jobs/provider/testing";
import {
  crossProcessDriver,
  exampleNamespace,
  tempDir,
} from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { callContext, summonRequest } from "./helpers/local-calls";

title("Summoning on this host: localCompute");

/** A generous ceiling for a unit's start-up and anything a slow server stretches. */
const WAIT = { timeout: 30_000, interval: 20 };
/** Every trigger off: the controller checks only when told to. */
const ONE_SHOT = { onAdd: false, events: false, poll: false } as const;

const config = crossProcessDriver();
const namespace = exampleNamespace("local");
const UNIT = new URL("./helpers/local-unit.ts", import.meta.url);
const HOST = new URL("./helpers/local-host.ts", import.meta.url).pathname;
/** Where each step's units write their reports, a directory per step. */
const reports = tempDir("local");

/** A fresh report directory for one step. */
function reportDir(name: string): string {
  const dir = join(reports, name);
  mkdirSync(dir);
  return dir;
}

/* ------------------------------------------------------------------ */
/* Processes: what the tour started, and how it tells one is gone      */
/* ------------------------------------------------------------------ */

/**
 * Every process this tour started or caused, by pid, with a word its
 * command line holds: the hosts, the units and the units' own children.
 * Whatever is still alive at exit (a check failed mid-step, say) is killed,
 * after making sure the pid is still ours: a pid is reused once its process
 * has gone.
 */
const ours = new Map<number, string>();
/** The hosts this tour started. */
const hosts = new Set<Subprocess>();

/** Whether a process exists (a zombie, not yet reaped, counts). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether `pid` is alive and still runs a command holding `marker`. */
function stillOurs(pid: number, marker: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker);
  } catch {
    return alive(pid);
  }
}

/** The pids this tour started that are still running. */
function leftRunning(): number[] {
  return [...ours].filter(([pid]) => alive(pid)).map(([pid]) => pid);
}

process.on("exit", () => {
  for (const host of hosts) {
    if (host.exitCode === null && host.signalCode === null) {
      host.kill("SIGKILL");
    }
  }
  for (const [pid, marker] of ours) {
    if (stillOurs(pid, marker)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone meanwhile.
      }
    }
  }
});

/** Waits until every pid has gone: exited, and reaped by whoever its parent is now. */
async function allGone(pids: readonly number[]): Promise<boolean> {
  try {
    await waitFor("the processes to be gone", () => !pids.some(alive), {
      timeout: 10_000,
      interval: 20,
    });
    return true;
  } catch {
    return false;
  }
}

/** What a unit wrote to its report file. */
interface UnitReport {
  /** The unit's pid. */
  pid: number;
  /** Its whole environment, as it saw it. */
  env: Record<string, string>;
  /** Its `sleep`'s pid, for a spawner. */
  child?: number;
}

/** Every report in `dir`, each unit's pid (and its child's) recorded as ours. */
function readReports(dir: string): UnitReport[] {
  const found = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as UnitReport,
    );
  for (const unit of found) {
    ours.set(unit.pid, "local-unit.ts");
    if (unit.child !== undefined) {
      ours.set(unit.child, "sleep");
    }
  }
  return found;
}

/** Waits for `count` reports in `dir`, and answers them. */
async function reportsIn(dir: string, count: number): Promise<UnitReport[]> {
  await waitFor(
    `${count} unit report(s)`,
    () =>
      readdirSync(dir).filter((name) => name.endsWith(".json")).length >= count,
    WAIT,
  );
  return readReports(dir);
}

/* ------------------------------------------------------------------ */
step("An add summons a unit: a child process that works the queue, then exits");

// Set in this host at run time, after it started: the unit's environment is
// read from the live process.env at each spawn.
process.env.LOCAL_EXAMPLE_SECRET = "hunter2-for-this-host-only";
process.env.LOCAL_EXAMPLE_PASSED = "passed-by-name";
// On the allowlist, and removed below by `env: { NO_COLOR: undefined }`.
process.env.NO_COLOR = "1";

/** Where the units' output goes: each line logged, bound with its unit. */
const { logger: unitOutput, events: unitLines } = createTestLogger();
const emailsDir = reportDir("emails");
const emailsCompute = localCompute({
  entry: UNIT,
  // Before the summon arguments: the unit's mode and report directory.
  args: ["work", emailsDir],
  passEnv: ["LOCAL_EXAMPLE_PASSED"],
  env: { LOCAL_EXAMPLE_REGION: "eu-west-1", NO_COLOR: undefined },
  maxUnits: 2,
  output: { logger: unitOutput },
});

/** One instance for two queues, with room for one unit: they share it. */
const sharedDir = reportDir("shared");
const sharedCompute = localCompute({
  entry: UNIT,
  args: ["work", sharedDir],
  maxUnits: 1,
  output: "ignore",
});

/** The policy `env`: how a unit finds the backend, and how long it idles. */
function unitEnv(idleMs: number): Record<string, string> {
  return {
    LOCAL_DRIVER: JSON.stringify(config),
    LOCAL_IDLE_MS: String(idleMs),
  };
}

/**
 * What the controllers log, collected rather than printed: on SQLite, for
 * one, a warning that a summoned worker must run on this host to reach it,
 * which is what a local unit does.
 */
const { logger } = createTestLogger();

const jobs = new BunJobs({
  namespace,
  driver: config,
  logger,
  summon: {
    // On demand: the add triggers a check 50 ms after the last add. No
    // poll; the tour makes the checks that see the unit register.
    emails: {
      summoner: emailsCompute,
      triggers: { poll: false, debounce: 50 },
      env: unitEnv(500),
    },
    // Its unit idles a minute: it holds the shared instance's one slot
    // until the tour cancels it.
    first: {
      summoner: sharedCompute,
      triggers: ONE_SHOT,
      env: unitEnv(60_000),
    },
    second: {
      summoner: sharedCompute,
      triggers: ONE_SHOT,
      cooldown: 0,
      backoff: { initial: 1, max: 1 },
      env: unitEnv(500),
    },
  },
});

/** What a controller reported, by queue, in order. */
function watch(queue: string): SummonEventPayload[] {
  const events: SummonEventPayload[] = [];
  jobs.summonController(queue).on("summon", (event) => events.push(event));
  return events;
}

/** One status per handle, from a configured provider's facet. */
async function statusOf(
  provider: typeof emailsCompute,
  handles: readonly string[],
): Promise<readonly UnitStatus[]> {
  return await provider.summon.status!(handles, callContext());
}

const emailEvents = watch("emails");
const emails = jobs.queue("emails");
const added = [];
for (const to of ["ada", "grace", "edsger"]) {
  added.push(await emails.add("send", { to }));
}
// The add's own check starts the attempt; then the tour checks until the
// unit is seen registered.
await waitFor(
  "the add's check to start a unit",
  () => emailEvents.some((event) => event.outcome === "started"),
  WAIT,
);
await waitFor(
  "the unit to register",
  async () => {
    await jobs.summonController("emails").check();
    return emailEvents.some((event) => event.outcome === "registered");
  },
  WAIT,
);
const startedEvent = emailEvents.find((event) => event.outcome === "started")!;
const emailHandles = startedEvent.handles ?? [];
show("summon events", emailEvents);
check(
  "one attempt, started by the add with one local-<pid>-… handle, then registered by the unit's heartbeat",
  Bun.deepEquals(
    emailEvents.map((event) => event.outcome),
    ["started", "registered"],
  ) &&
    startedEvent.kind === "local" &&
    startedEvent.reason === "add" &&
    emailHandles.length === 1 &&
    emailHandles[0]!.startsWith(`local-${process.pid}-`),
  emailEvents,
);
const [emailUnit] = await reportsIn(emailsDir, 1);
await waitFor(
  "the three jobs to be done",
  async () => (await emails.count()).completed === 3,
  WAIT,
);
const ranBy = await Promise.all(
  added.map(
    async (job) =>
      ((await emails.getJob(job.id))?.returnValue as { pid: number }).pid,
  ),
);
checkEqual(
  "all three ran in the unit, a process of its own",
  [ranBy, emailUnit!.pid !== process.pid],
  [[emailUnit!.pid, emailUnit!.pid, emailUnit!.pid], true],
);
await waitFor(
  "the unit to exit once idle",
  async () =>
    (await statusOf(emailsCompute, emailHandles))[0]?.state !== "running",
  WAIT,
);
checkEqual(
  "idle, runSummoned exits 0 on its own: status() says exited, and the pid is gone",
  [
    await statusOf(emailsCompute, emailHandles),
    await allGone([emailUnit!.pid]),
  ],
  [[{ handle: emailHandles[0]!, state: "exited", exitCode: 0 }], true],
);
const printed = unitLines
  .filter((line) => line.message.startsWith("processed "))
  .map((line) => [line.level, line.bindings.unit, line.fields.stream]);
checkEqual(
  "output: { logger } logged each line it printed, at info, bound with its handle",
  printed,
  added.map(() => ["info", emailHandles[0]!, "stdout"]),
);

/* ------------------------------------------------------------------ */
step("The unit's environment: the allowlist, passEnv and env, nothing else");

const unitVars = emailUnit!.env;
const allowed = new Set([
  ...CHILD_BASE_ENV,
  "LOCAL_EXAMPLE_PASSED",
  "LOCAL_EXAMPLE_REGION",
  // The summon policy's `env`.
  "LOCAL_DRIVER",
  "LOCAL_IDLE_MS",
]);
show("the unit's variables", Object.keys(unitVars).sort());
checkEqual(
  "every variable it got is on the allowlist, in passEnv, in env or in the policy's env",
  Object.keys(unitVars).filter((name) => !allowed.has(name)),
  [],
);
checkEqual(
  "a variable this host holds and names nowhere does not reach it",
  [
    process.env.LOCAL_EXAMPLE_SECRET !== undefined,
    "LOCAL_EXAMPLE_SECRET" in unitVars,
  ],
  [true, false],
);
checkEqual(
  "passEnv copies one by name from the live process.env; env gives a value, and removes NO_COLOR though it is on the allowlist",
  [
    unitVars.LOCAL_EXAMPLE_PASSED,
    unitVars.LOCAL_EXAMPLE_REGION,
    process.env.NO_COLOR,
    "NO_COLOR" in unitVars,
  ],
  ["passed-by-name", "eu-west-1", "1", false],
);
checkEqual(
  "the allowlist itself comes from the host: the same PATH",
  unitVars.PATH,
  process.env.PATH,
);

/* ------------------------------------------------------------------ */
step("maxUnits: a summon starts what fits, and with none free is refused");

const cappedDir = reportDir("capped");
const capped = localCompute({
  entry: UNIT,
  args: ["hold", cappedDir],
  maxUnits: 2,
  output: "ignore",
  shutdown: { graceMs: 1_000 },
});
const asked = await capped.summon.summon(summonRequest(3), callContext());
const cappedHandles = asked.status === "started" ? asked.handles : [];
checkEqual(
  "asked for 3 with maxUnits 2: started 2",
  [asked.status, cappedHandles.length],
  ["started", 2],
);
const full = await capped.summon.summon(summonRequest(1), callContext());
show("one more", full);
checkEqual("one more while both run: unavailable, max-units", full, {
  status: "unavailable",
  reason: "max-units: 2 of 2 running",
});
const capacity = (await capped.validate()).find((one) => one.id === "capacity");
checkEqual("validate() warns that it is full", capacity, {
  id: "capacity",
  status: "warn",
  detail: "2 of 2 units running",
});
const cappedUnits = await reportsIn(cappedDir, 2);
await capped.summon.cancel!([cappedHandles[0]!], callContext());
const again = await capped.summon.summon(summonRequest(1), callContext());
checkEqual(
  "cancel() frees a slot: the first unit exited 0 on its stop signal, and the next summon starts one",
  [(await statusOf(capped, [cappedHandles[0]!]))[0]?.state, again.status],
  ["exited", "started"],
);
const allCapped = [
  ...cappedHandles,
  ...(again.status === "started" ? again.handles : []),
];
// Once the third has reported, so it is stopped running, not starting.
const cappedPids = (await reportsIn(cappedDir, 3)).map((unit) => unit.pid);
await capped.summon.cancel!(allCapped, callContext());
checkEqual(
  "cancelled, every unit exited and is gone",
  [
    (await statusOf(capped, allCapped)).map((unit) => unit.state),
    await allGone(cappedPids),
    cappedUnits.length,
  ],
  [["exited", "exited", "exited"], true, 2],
);

// Through the controller: two queues share one instance with one slot.
const firstEvents = watch("first");
const secondEvents = watch("second");
const first = jobs.queue("first");
const second = jobs.queue("second");
await first.add("send", {});
await jobs.summonController("first").check();
await waitFor(
  "first's job to be done",
  async () => (await first.count()).completed === 1,
  WAIT,
);
const firstHandles =
  firstEvents.find((event) => event.outcome === "started")?.handles ?? [];
await second.add("send", {});
await jobs.summonController("second").check();
const secondStatus = await jobs.summonController("second").status();
show(
  "second's summon events",
  secondEvents.map((event) => `${event.outcome}: ${event.detail ?? ""}`),
);
checkEqual(
  "first's unit holds the one slot: second's attempt is unavailable, max-units, counted as a failure with nothing pending",
  [
    secondEvents.map((event) => [event.outcome, event.detail]),
    secondStatus.failures,
    secondStatus.pending.length,
  ],
  [[["unavailable", "max-units: 1 of 1 running"]], 1, 0],
);
await sharedCompute.summon.cancel!(firstHandles, callContext());
// Backed off 1 ms: the next check is not held back.
await Bun.sleep(5);
await jobs.summonController("second").check();
await waitFor(
  "second's job to be done",
  async () => (await second.count()).completed === 1,
  WAIT,
);
checkEqual(
  "first's unit cancelled, the slot is free: second's next check starts a unit, which works its job",
  secondEvents.map((event) => event.outcome),
  ["unavailable", "started"],
);
const sharedUnits = await reportsIn(sharedDir, 2);
const secondHandles =
  secondEvents.find((event) => event.outcome === "started")?.handles ?? [];
await waitFor(
  "second's unit to exit once idle",
  async () =>
    (await statusOf(sharedCompute, secondHandles))[0]?.state !== "running",
  WAIT,
);
check(
  "both units of the shared instance are gone",
  await allGone(sharedUnits.map((unit) => unit.pid)),
);

/* ------------------------------------------------------------------ */
step("Units stop with their host, and what they started with them");

/** A host in `mode`, once it says its two units (and their `sleep`s) run. */
async function startHost(mode: "wait" | "listen" | "exit") {
  const dir = reportDir(`host-${mode}`);
  const proc = Bun.spawn({
    cmd: [process.execPath, HOST, dir, mode],
    stdout: "pipe",
    stderr: "inherit",
  });
  hosts.add(proc);
  ours.set(proc.pid, "local-host.ts");
  const lines: string[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      lines.push(...decoder.decode(chunk).split("\n").filter(Boolean));
    }
  })();
  await waitFor(
    `the ${mode} host to be ready`,
    () => lines.includes("ready"),
    WAIT,
  );
  const units = readReports(dir);
  const pids = units.flatMap((unit) => [unit.pid, unit.child!]);
  return {
    proc,
    dir,
    lines,
    units,
    pids,
    /** The host's exit code, once it has exited and its output is read. */
    exited: async () => {
      const code = await proc.exited;
      await reading;
      return code;
    },
  };
}

/** Whether each unit logged that it got `signal`. */
function unitsGot(dir: string, units: UnitReport[], signal: string): boolean {
  return units.every((unit) => {
    const log = join(dir, `${unit.pid}.log`);
    return existsSync(log) && readFileSync(log, "utf8").includes(signal);
  });
}

const waiting = await startHost("wait");
check(
  "the host runs two units, each with a sleep of its own: four processes",
  waiting.units.length === 2 &&
    waiting.pids.length === 4 &&
    waiting.pids.every(alive),
  waiting.pids,
);
waiting.proc.kill("SIGTERM");
const waitCode = await waiting.exited();
checkEqual(
  "SIGTERM with no listener of the host's own: each unit gets its stop signal, then the host ends by the signal (143), its units and their sleeps gone",
  [
    waitCode,
    unitsGot(waiting.dir, waiting.units, "signal SIGTERM"),
    await allGone(waiting.pids),
  ],
  [143, true, true],
);

const listening = await startHost("listen");
listening.proc.kill("SIGINT");
const listenCode = await listening.exited();
const answer = listening.lines.find((line) => line.startsWith('{"answer"'));
const stopped = listening.lines.find((line) => line.startsWith('{"units"'));
show("the host's summon after the signal", answer);
checkEqual(
  "after SIGINT, a summon is refused: unavailable, host-shutdown, while the app's own listener keeps the host alive",
  [
    listening.lines.includes("host-signal"),
    answer === undefined ? undefined : JSON.parse(answer),
  ],
  [
    true,
    {
      answer: {
        status: "unavailable",
        reason: "host-shutdown: the host is stopping",
      },
    },
  ],
);
checkEqual(
  "its units were stopped anyway (exited 0 on their stop signal), and the app ended on its own terms (exit 0), nothing left",
  [
    stopped === undefined
      ? undefined
      : (JSON.parse(stopped) as { units: UnitStatus[] }).units.map((unit) => [
          unit.state,
          unit.exitCode,
        ]),
    unitsGot(listening.dir, listening.units, "signal SIGTERM"),
    listenCode,
    await allGone(listening.pids),
  ],
  [
    [
      ["exited", 0],
      ["exited", 0],
    ],
    true,
    0,
    true,
  ],
);

const exiting = await startHost("exit");
checkEqual(
  "process.exit(): no time to wait, every unit and its sleep is killed",
  [await exiting.exited(), await allGone(exiting.pids)],
  [0, true],
);

/* ------------------------------------------------------------------ */
step("validate(), and a cgroup read when the provider is configured");

const healthy = await emailsCompute.validate();
show(
  "validate()",
  healthy.map((one) => `${one.id}: ${one.status}`),
);
checkEqual(
  "a healthy config: cwd, entry and bun pass, capacity is free, and it always warns it is not a sandbox",
  [
    healthy.map((one) => [one.id, one.status]),
    healthy.find((one) => one.id === "bun")?.detail,
  ],
  [
    [
      ["cwd", "pass"],
      ["entry", "pass"],
      ["bun", "pass"],
      ["capacity", "pass"],
      ["isolation", "warn"],
    ],
    `bun ${Bun.version}`,
  ],
);

const plainDir = tempDir("not-a-cgroup");
await checkRejects(
  "an ordinary directory as cgroup: a ConfigError when it is configured",
  () => localCompute({ entry: UNIT, cgroup: plainDir }),
  { code: "CONFIG" },
);
const configError = (() => {
  try {
    localCompute({
      entry: UNIT,
      cgroup: `/sys/fs/cgroup/bun-jobs-example-missing-${process.pid}`,
    });
  } catch (error) {
    return error as Error & { context?: { issues?: { message: string }[] } };
  }
  return undefined;
})();
show("a missing cgroup", configError?.context?.issues?.[0]?.message);
check(
  "a missing one too, and the issue says why: no cgroup.controllers",
  configError?.name === "ConfigError" &&
    /is not a cgroup v2 directory \(it has no cgroup\.controllers\)/.test(
      configError.context?.issues?.[0]?.message ?? "",
    ),
  configError,
);
await checkRejects(
  "removeCgroupTree refuses what is not a cgroup, before removing anything",
  () => removeCgroupTree(plainDir),
  { code: "CONFIG", message: /not a cgroup/ },
);
check("and the directory it refused is still there", existsSync(plainDir));

if (process.getuid?.() === 0) {
  console.log(
    "  skipped: running as root, every cgroup is writable, so the root cgroup cannot show a refusal",
  );
} else {
  // The root of the hierarchy: a real cgroup v2 directory, so it configures,
  // and one this user cannot make a cgroup in.
  const rootChecks = await localCompute({
    entry: UNIT,
    cgroup: "/sys/fs/cgroup",
  }).validate();
  const rootCgroup = rootChecks.find((one) => one.id === "cgroup");
  show("validate() with cgroup /sys/fs/cgroup", rootCgroup);
  check(
    "a cgroup this user cannot write configures, and validate() fails its cgroup check (EACCES)",
    rootCgroup?.status === "fail" &&
      /cannot hold a unit's cgroup \(EACCES\)/.test(rootCgroup.detail ?? ""),
    rootCgroup,
  );
}

// A cgroup of our own, only where systemd delegates one to this user and
// making it needs no privilege. Never sudo.
const uid = process.getuid?.();
const delegated = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;
const mine = join(delegated, `bun-jobs-example-${process.pid}`);
let made = false;
let whyNot = "";
try {
  mkdirSync(mine);
  made = true;
} catch (error) {
  whyNot = (error as { code?: string }).code ?? String(error);
}
if (!made) {
  console.log(
    `  skipped: a cgroup of its own, since ${delegated} is not writable by this user (${whyNot}); the steps above did not need one`,
  );
} else {
  process.on("exit", () => {
    // A failed check mid-step: what the units left is killed with them; the
    // directories go here.
    try {
      removeCgroupTree(mine);
    } catch {
      // No longer a cgroup: only the directory itself, if it is empty.
      try {
        rmdirSync(mine);
      } catch {
        // Not empty, or gone.
      }
    }
  });
  const cgroupDir = reportDir("cgroup");
  const bounded = localCompute({
    entry: UNIT,
    args: ["hold-spawner", cgroupDir],
    cgroup: mine,
    output: "ignore",
    shutdown: { graceMs: 1_000 },
  });
  const boundedChecks = await bounded.validate();
  checkEqual(
    "in a delegated cgroup, unprivileged: validate() starts bun in a cgroup inside it",
    boundedChecks.find((one) => one.id === "cgroup"),
    {
      id: "cgroup",
      status: "pass",
      detail: `a process started in a cgroup inside ${mine}`,
    },
  );
  const inCgroup = await bounded.summon.summon(summonRequest(1), callContext());
  const [cgroupHandle] = inCgroup.status === "started" ? inCgroup.handles : [];
  const [bounding] = await reportsIn(cgroupDir, 1);
  const leaf = join(mine, cgroupHandle!);
  const cgroupOf = (pid: number) =>
    readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
  const expected = `0::${leaf.slice("/sys/fs/cgroup".length)}`;
  show("the unit's cgroup", cgroupOf(bounding!.pid));
  checkEqual(
    "the unit runs in a cgroup of its own, named after its handle, and its sleep with it",
    [cgroupOf(bounding!.pid), cgroupOf(bounding!.child!)],
    [expected, expected],
  );
  await bounded.summon.cancel!([cgroupHandle!], callContext());
  await waitFor("its cgroup to be removed", () => !existsSync(leaf), WAIT);
  checkEqual(
    "cancelled: the unit and its sleep are gone, and so is its cgroup",
    [await allGone([bounding!.pid, bounding!.child!]), existsSync(leaf)],
    [true, false],
  );
  checkEqual(
    "removeCgroupTree removes ours, now empty",
    [removeCgroupTree(mine), existsSync(mine)],
    [true, false],
  );
}

/* ------------------------------------------------------------------ */
step('Conformance: the kit runs it self-hosted, with platform: "none"');

await checkRejects(
  'the kit refuses a run with no platform at all: a fake or "none" must be named',
  () =>
    runProviderConformance(localCompute, {
      config: { entry: CONFORMANCE_WORKER },
    } as never),
  { code: "CONFIG", message: /platform is required/ },
);
const report = await runProviderConformance(localCompute, {
  // The concurrency check starts 16 units at once.
  config: {
    entry: CONFORMANCE_WORKER,
    maxUnits: 32,
    output: "ignore",
    shutdown: { graceMs: 2_000 },
  },
  invalidConfigs: [
    { config: {}, path: "entry" },
    { config: { entry: CONFORMANCE_WORKER, maxUnits: 0 }, path: "maxUnits" },
    { config: { entry: CONFORMANCE_WORKER, cgroup: plainDir }, path: "cgroup" },
  ],
  platform: "none",
  driver: config,
});
/** The ids of the report's checks with `status`. */
function idsWith(status: "pass" | "fail" | "warn" | "skip"): string[] {
  return report.checks
    .filter((one) => one.status === status)
    .map((one) => one.id);
}
const statusById = Object.fromEntries(
  report.checks.map((one) => [one.id, one.status]),
);
show(report.subject, {
  passed: idsWith("pass").length,
  failed: idsWith("fail"),
  skipped: idsWith("skip").length,
});
const sample = [
  "summon.config.rejects-invalid",
  "summon.dedupe.same-key-one-unit",
  "summon.timeouts.rejects-on-abort",
  "summon.lifetime.enforced",
  "summon.validate.healthy",
  "summon.handoff.released",
  "summon.cas.one-call",
];
checkEqual(
  "it conforms: nothing failed, among them config, dedupe, timeouts, lifetime, validate and the handoff",
  [report.ok, idsWith("fail"), sample.map((id) => statusById[id])],
  [true, [], sample.map(() => "pass")],
);
checkEqual(
  "what needs a platform is skipped, not failed: routing, the error kinds",
  [
    statusById["summon.routing.through-ctx-fetch"],
    statusById["summon.errors.auth"],
  ],
  ["skip", "skip"],
);
let conformed = true;
try {
  assertConformance(report);
} catch {
  conformed = false;
}
check("assertConformance passes", conformed);

/* ------------------------------------------------------------------ */
step("Clean up");

checkEqual(
  "no process this tour started is left: hosts, units and their sleeps",
  leftRunning(),
  [],
);
checkEqual(
  "with no unit running, the guard's signal listeners are gone: the host's signals are its own again",
  [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
  [0, 0],
);
await jobs.purge();
await jobs.close();
summary();
