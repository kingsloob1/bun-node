/**
 * Summon groups: one summon policy written once for several queues, in the
 * array form of `BunJobsOptions.summon`.
 *
 * ```bash
 * bun 02-queues/summon-groups.ts
 * ```
 *
 * ```ts
 * summon: [
 *   { queues: ["emails", "images"], summoner, jobsPerWorker: 10 },
 *   { reports: { summoner: other } },          // a record, in the same array
 * ]
 * ```
 *
 * The summoners in the first four steps start nothing — they record what
 * they were asked, or fail — so those steps need no child process. The last
 * step runs the bun-jobs README's recipe for real: one entry file
 * ([`helpers/summoned-group-entry.ts`](./helpers/summoned-group-entry.ts))
 * started once per queue of a group, each process serving the queue its
 * arguments name. Summoning needs a backend another process can reach, so on
 * the memory driver this runs on a temporary SQLite file.
 *
 * The points that are easy to get wrong:
 *
 * - **A group is shorthand, not a shared controller.** It builds one
 *   ordinary `SummonController` per queue, exactly as if each queue had its
 *   own key: each has its own marker, backoff, circuit and **budget** —
 *   `perHour: 1` on a group of two queues allows one attempt an hour for
 *   each. `jobs.summonController(queue)` finds each.
 * - **An override merges one level deep.** Where the group and a queue's
 *   override both hold a plain object (`triggers`, `backoff`, `circuit`,
 *   `budget`, `scaleDown`, `env`), the override's fields go over the group's
 *   and the rest are kept. Anything else — the summoner, a function, a
 *   number — replaces the group's value whole.
 * - **A bad option is refused whole**, as a `ConfigError` saying where, at
 *   construction: a queue named twice anywhere in the option, an empty group,
 *   an override for a queue outside its group, an invalid queue name, an
 *   entry that is `undefined`, a hole in the array.
 * - **`summon: null` builds nothing**, like leaving the option out.
 */
import type {
  SummonOption,
  SummonRequest,
  SummonStatus,
} from "@kingsleyweb/bun-jobs";
import type { Subprocess } from "bun";
import process from "node:process";
import { createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  ConfigError,
  createDriver,
  defineSummoner,
} from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Summon groups: one policy for several queues");

/** A generous ceiling for a child's start-up and anything a slow server stretches. */
const WAIT = { timeout: 30_000, interval: 20 };
/** Every trigger off: a controller checks only when told to. */
const ONE_SHOT = { onAdd: false, events: false, poll: false } as const;

const config = crossProcessDriver();
// The controllers log each failed call, and a SQLite file's one-host warning;
// collected, not printed.
const { logger } = createTestLogger();

/** Requests the recording summoners were handed, by queue. */
const recorded = new Map<string, SummonRequest[]>();
/** The requests recorded for `queue`, in order. */
const requests = (queue: string): SummonRequest[] => recorded.get(queue) ?? [];

/** A summoner of this `kind` that starts nothing: it records the request and says `started`. */
function recording(kind: string) {
  return defineSummoner({
    kind,
    invoke: async (request: SummonRequest) => {
      recorded.set(request.queue, [...requests(request.queue), request]);
      return { status: "started", handles: [] };
    },
  });
}

/** A queue's budget limits, as its controller reads them back. */
async function limits(
  jobs: BunJobs,
  queue: string,
): Promise<{ perHour?: number; perDay?: number }> {
  const budget: SummonStatus["budget"] = (
    await jobs.summonController(queue).status()
  ).budget;
  return { perHour: budget?.perHour, perDay: budget?.perDay };
}

/** The `kind` of the summoner a queue's controller calls. */
async function kindOf(
  jobs: BunJobs,
  queue: string,
): Promise<string | undefined> {
  return (await jobs.summonController(queue).status()).summoner?.provider.kind;
}

/* ------------------------------------------------------------------ */
step("A group and a record, in one array: one controller per queue");

const mixed = new BunJobs({
  namespace: exampleNamespace("summon-groups-mixed"),
  driver: config,
  logger,
  summon: [
    {
      queues: ["emails", "images"],
      summoner: recording("group-cloud"),
      triggers: ONE_SHOT,
      budget: { perHour: 1 },
    },
    {
      reports: {
        summoner: recording("report-cloud"),
        triggers: ONE_SHOT,
        budget: { perDay: 50 },
      },
    },
  ],
});

const emails = mixed.summonController("emails");
const images = mixed.summonController("images");
checkEqual(
  "the group built a controller for each of its queues, and the record one for its own",
  [
    emails.queue,
    images.queue,
    mixed.summonController("reports").queue,
    emails !== images,
  ],
  ["emails", "images", "reports", true],
);
checkEqual(
  "each queue calls the summoner its entry names",
  [
    await kindOf(mixed, "emails"),
    await kindOf(mixed, "images"),
    await kindOf(mixed, "reports"),
  ],
  ["group-cloud", "group-cloud", "report-cloud"],
);
checkEqual(
  "and reads its entry's budget, the defaults (30 an hour, 300 a day) for the rest",
  [
    await limits(mixed, "emails"),
    await limits(mixed, "images"),
    await limits(mixed, "reports"),
  ],
  [
    { perHour: 1, perDay: 300 },
    { perHour: 1, perDay: 300 },
    { perHour: 30, perDay: 50 },
  ],
);
await checkRejects(
  "the array's indexes are not queues",
  () => mixed.summonController("0"),
  {
    name: "ConfigError",
    message:
      /^No summon policy for queue "0": pass one, or name the queue in the summon option$/,
  },
);

await mixed.queue("emails").add("welcome", { to: "ada" });
await mixed.queue("images").add("thumbnail", { id: 7 });
const emailsCheck = await emails.check();
const imagesCheck = await images.check();
show("emails, then images", [emailsCheck.action, imagesCheck.action]);
const emailsStatus = await emails.status();
const imagesStatus = await images.status();
checkEqual(
  "the group's budget of one an hour is each queue's: emails spent its own, and images still summoned",
  [
    emailsCheck.action,
    imagesCheck.action,
    emailsStatus.budget?.hour,
    imagesStatus.budget?.hour,
  ],
  ["summoned", "summoned", 1, 1],
);
checkEqual(
  "each queue's marker holds its own attempt",
  [
    emailsStatus.pending.map((attempt) => attempt.id),
    imagesStatus.pending.map((attempt) => attempt.id),
  ],
  [[requests("emails")[0]?.id], [requests("images")[0]?.id]],
);
check(
  "two attempts, under two ids",
  requests("emails")[0]?.id !== requests("images")[0]?.id,
  { emails: requests("emails"), images: requests("images") },
);
await mixed.purge();
await mixed.close();

/* ------------------------------------------------------------------ */
step("How an override merges: one level deep, objects field by field");

/** A summoner whose platform is down: a bare function, which always throws. */
const platformDown = async (): Promise<never> => {
  throw new Error("the platform is down");
};

/** Scale-style summoners' `release` calls, by queue. */
const releases: string[] = [];
/** A scale-style summoner that starts nothing; its `release` is recorded. */
const scaling = defineSummoner({
  kind: "scale-cloud",
  style: "scale",
  invoke: async () => ({ status: "started", handles: [] }),
  release: async (request) => {
    releases.push(request.queue);
  },
});

const merged = new BunJobs({
  namespace: exampleNamespace("summon-groups-merge"),
  driver: config,
  logger,
  summon: [
    {
      queues: ["thumbs", "videos", "audio"],
      summoner: recording("media-cloud"),
      triggers: ONE_SHOT,
      cooldown: 0,
      jobsPerWorker: 1,
      budget: { perHour: 20, perDay: 100 },
      backoff: { initial: 40_000, max: 50_000 },
      circuit: { failures: 1, resetAfter: 120_000 },
      env: { REGION: "eu", TIER: "small" },
      overrides: {
        videos: {
          maxWorkers: 3,
          budget: { perHour: 5 },
          env: { TIER: "large" },
          triggers: { debounce: 0 },
        },
        audio: {
          summoner: platformDown,
          backoff: { max: 600_000 },
          circuit: { resetAfter: 300_000 },
        },
      },
    },
    {
      queues: ["live", "replay"],
      summoner: scaling,
      triggers: ONE_SHOT,
      scaleDown: { after: 0 },
      overrides: { replay: { scaleDown: {} } },
    },
    // No `scaleDown` at all: the default, five minutes.
    { archive: { summoner: scaling, triggers: ONE_SHOT } },
  ],
});

checkEqual(
  "budget: videos' { perHour: 5 } keeps the group's perDay: 100; the others keep the group's",
  [
    await limits(merged, "thumbs"),
    await limits(merged, "videos"),
    await limits(merged, "audio"),
  ],
  [
    { perHour: 20, perDay: 100 },
    { perHour: 5, perDay: 100 },
    { perHour: 20, perDay: 100 },
  ],
);

// Three jobs on each of thumbs and videos, and one more on videos with a
// plain `add`. videos' override sets only `triggers.debounce`, so it keeps
// the group's `onAdd: false`: had the override replaced the group's
// triggers, `onAdd` would be back to its default (`true`) and that add would
// have summoned within milliseconds.
for (const queue of ["thumbs", "videos"]) {
  await merged
    .queue(queue)
    .addBulk([1, 2, 3].map((index) => ({ name: "render", data: { index } })));
}
await merged.queue("videos").add("render", { index: 4 });
await Bun.sleep(300);
checkEqual(
  "triggers: videos' { debounce: 0 } keeps the group's onAdd: false, so an add summons nothing",
  requests("videos").length,
  0,
);
await merged.summonController("thumbs").check();
await merged.summonController("videos").check();
show(
  "thumbs asked for",
  requests("thumbs").map((request) => request.count),
);
show(
  "videos asked for",
  requests("videos").map((request) => request.count),
);
checkEqual(
  "a number replaces: videos' maxWorkers: 3 asks for three workers, thumbs keeps the default one",
  [
    requests("thumbs").map((request) => request.count),
    requests("videos").map((request) => request.count),
  ],
  [[1], [3]],
);
checkEqual(
  "env: videos' { TIER: \"large\" } keeps the group's REGION; thumbs gets the group's env",
  [requests("thumbs")[0]?.env, requests("videos")[0]?.env],
  [
    { REGION: "eu", TIER: "small" },
    { REGION: "eu", TIER: "large" },
  ],
);

await merged.queue("audio").add("transcode", { id: 1 });
const before = Date.now();
const audioCheck = await merged.summonController("audio").check();
const after = Date.now();
const audio = await merged.summonController("audio").status();
show(
  "audio's check",
  audioCheck.action === "summoned" ? audioCheck.outcome : audioCheck,
);
show("audio's status", {
  failures: audio.failures,
  backoffMs:
    audio.backoffUntil === undefined ? undefined : audio.backoffUntil - before,
  circuitMs:
    audio.circuitOpenUntil === undefined
      ? undefined
      : audio.circuitOpenUntil - before,
});
checkEqual(
  'a function replaces: audio calls its own summoner (a bare function, kind "custom"), which fails',
  [
    await kindOf(merged, "audio"),
    audioCheck.action === "summoned" ? audioCheck.outcome : audioCheck.action,
    audio.failures,
    requests("audio").length,
  ],
  ["custom", "failed", 1, 0],
);
/** Whether `at` is `ms` after the check, give or take how long the check took. */
const afterCheck = (at: number | undefined, ms: number): boolean =>
  at !== undefined && at >= before + ms && at <= after + ms;
check(
  "backoff: audio's { max: 600_000 } keeps the group's initial 40 s (the default is 30 s)",
  afterCheck(audio.backoffUntil, 40_000),
  { backoffUntil: audio.backoffUntil, before, after },
);
check(
  "circuit: audio's { resetAfter: 300_000 } keeps the group's failures: 1, so one failure opens it for 5 minutes",
  afterCheck(audio.circuitOpenUntil, 300_000),
  { circuitOpenUntil: audio.circuitOpenUntil, before, after },
);

// Nothing waits on live, replay or archive: a scale-style controller sets
// the count back to zero once the queue has been idle for `scaleDown.after`.
const scaled = [
  (await merged.summonController("live").check()).action,
  (await merged.summonController("replay").check()).action,
  (await merged.summonController("archive").check()).action,
];
show("live, replay, archive", scaled);
checkEqual(
  "scaleDown: replay's {} keeps the group's after: 0, so an idle check releases it; archive waits the default",
  [scaled, releases],
  [
    ["released", "released", "none"],
    ["live", "replay"],
  ],
);
await merged.purge();
await merged.close();

/* ------------------------------------------------------------------ */
step("Refused at construction, saying where");

// One driver, built here, for the refused contexts and the next step's: a
// context does not close a driver it was handed, so this one is closed once
// both steps are done.
const refusalDriver = createDriver(config);
/** A summoner for the refused options; never called. */
const idle = recording("never-called");

/**
 * Builds a context with this `summon` option and checks it is refused with a
 * `ConfigError` whose message is exactly `message` and, when given, whose
 * context names `queue`.
 */
async function refused(
  label: string,
  summon: SummonOption,
  message: string,
  queue?: string,
): Promise<void> {
  let error: unknown;
  try {
    const jobs = new BunJobs({
      namespace: exampleNamespace("summon-groups-refused"),
      driver: refusalDriver,
      logger,
      summon,
    });
    await jobs.close();
  } catch (caught) {
    error = caught;
  }
  checkEqual(
    label,
    error instanceof ConfigError
      ? {
          message: error.message,
          ...(queue === undefined ? {} : { queue: error.context?.queue }),
        }
      : { message: error === undefined ? "nothing thrown" : String(error) },
    { message, ...(queue === undefined ? {} : { queue }) },
  );
}

await refused(
  "a queue named in two groups",
  [
    { queues: ["emails", "images"], summoner: idle },
    { queues: ["reports", "images"], summoner: idle },
  ],
  'Queue "images" is named twice in the summon option (again at summon[1].queues[1]): each queue takes one policy',
  "images",
);
await refused(
  "a queue named twice in one group",
  [{ queues: ["emails", "emails"], summoner: idle }],
  'Queue "emails" is named twice in the summon option (again at summon[0].queues[1]): each queue takes one policy',
  "emails",
);
await refused(
  "a queue named in a record, then in a group",
  [
    { emails: { summoner: idle } },
    { queues: ["images", "emails"], summoner: idle },
  ],
  'Queue "emails" is named twice in the summon option (again at summon[1].queues[1]): each queue takes one policy',
  "emails",
);
await refused(
  "a queue named in a group, then in a record",
  [
    { queues: ["images", "emails"], summoner: idle },
    { emails: { summoner: idle } },
  ],
  'Queue "emails" is named twice in the summon option (again at summon[1].emails): each queue takes one policy',
  "emails",
);
await refused(
  "a group with no queues",
  [{ queues: [], summoner: idle }],
  "summon[0].queues is empty: a summon group names at least one queue",
);
await refused(
  "an override for a queue outside its group",
  [
    {
      queues: ["emails"],
      summoner: idle,
      overrides: { images: { maxWorkers: 2 } },
    },
  ],
  'summon[0].overrides names queue "images", which the group\'s queues do not: an override changes the policy of a queue in its own group',
  "images",
);
await refused(
  "an invalid queue name in a group",
  [{ queues: ["emails", "images", "bad name"], summoner: idle }],
  'summon queue "bad name" (at summon[0].queues[2]) may only contain letters, digits, "_", "." and "-"',
);
await refused(
  "an invalid queue name in a record",
  [{ "bad/name": { summoner: idle } }],
  'summon queue "bad/name" (at summon[0].bad/name) may only contain letters, digits, "_", "." and "-"',
);
await refused(
  "an undefined entry in the array",
  [undefined] as unknown as SummonOption,
  "summon[0] must be a group ({ queues, summoner, … }) or a record of policies by queue",
);
await refused(
  "an undefined policy in a record entry",
  [{ emails: undefined }] as unknown as SummonOption,
  'summon[0].emails must be a summon policy ({ summoner, … }) for queue "emails"',
  "emails",
);
await refused(
  "an undefined policy in the record form",
  { emails: undefined } as unknown as SummonOption,
  'summon.emails must be a summon policy ({ summoner, … }) for queue "emails"',
  "emails",
);
// Index 1 is never assigned: a hole, not an `undefined`.
const sparse: unknown[] = [{ queues: ["emails"], summoner: idle }];
sparse[2] = { reports: { summoner: idle } };
await refused(
  "a hole in the array",
  sparse as SummonOption,
  "summon[1] is a hole in the array: each entry is a group ({ queues, summoner, … }) or a record of policies by queue",
);

/* ------------------------------------------------------------------ */
step("summon: null builds nothing");

// An option read from configuration may come out `null`: like no option.
const none = new BunJobs({
  namespace: exampleNamespace("summon-groups-none"),
  driver: refusalDriver,
  logger,
  summon: null as unknown as SummonOption,
});
await checkRejects(
  "no controller for any queue",
  () => none.summonController("emails"),
  {
    name: "ConfigError",
    message:
      /^No summon policy for queue "emails": pass one, or name the queue in the summon option$/,
  },
);
await none.close();
await refusalDriver.close();

/* ------------------------------------------------------------------ */
step("One entry file for every queue of a group, run for real");

const ENTRY = new URL("./helpers/summoned-group-entry.ts", import.meta.url)
  .pathname;

/**
 * Every child this tour started, killed if still alive when it exits, so a
 * failed run leaves no worker behind.
 */
const children = new Set<Subprocess>();
process.on("exit", () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

/** One process the platform started. */
interface Unit {
  /** The queue its request named. */
  queue: string;
  /** The attempt id. */
  id: string;
  /** The process. */
  child: Subprocess;
}
/** The processes the platform started, in order. */
const units: Unit[] = [];

/**
 * A platform that runs the same file whatever the queue, as a single task
 * definition would: the request's `argv` is what tells the process which
 * queue it serves. The backend travels in the environment.
 */
const platform = defineSummoner({
  kind: "example-spawn",
  invoke: async (request: SummonRequest) => {
    const child = Bun.spawn({
      cmd: [process.execPath, ENTRY, ...request.argv],
      env: {
        ...process.env,
        ...request.env,
        SUMMONED_DRIVER: JSON.stringify(config),
        SUMMONED_IDLE_FOR: "300",
      },
      stdout: "ignore",
      stderr: "inherit",
    });
    children.add(child);
    units.push({ queue: request.queue, id: request.id, child });
    return { status: "started", handles: [`pid:${child.pid}`] };
  },
});

const recipe = new BunJobs({
  namespace: exampleNamespace("summon-groups-recipe"),
  driver: config,
  logger,
  summon: [
    { queues: ["emails", "images"], summoner: platform, triggers: ONE_SHOT },
  ],
});
const welcome = await recipe.queue("emails").add("welcome", { to: "ada" });
const thumbnail = await recipe.queue("images").add("thumbnail", { id: 7 });
checkEqual(
  "each queue's check summons a unit of the same file",
  [
    (await recipe.summonController("emails").check()).action,
    (await recipe.summonController("images").check()).action,
    units.map((unit) => unit.queue),
  ],
  ["summoned", "summoned", ["emails", "images"]],
);

/** Whether job `id` on `queue` has completed. */
const completed = async (queue: string, id: string): Promise<boolean> =>
  (await recipe.queue(queue).getJob(id))?.state === "completed";
await waitFor(
  "both jobs to complete",
  async () =>
    (await completed("emails", welcome.id)) &&
    (await completed("images", thumbnail.id)),
  WAIT,
);
const codes = await Promise.all(
  units.map(async (unit) => await unit.child.exited),
);
const ran = {
  emails: (await recipe.queue("emails").getJob(welcome.id))?.returnValue,
  images: (await recipe.queue("images").getJob(thumbnail.id))?.returnValue,
};
show("what each job's processor answered", ran);
const pid = (queue: string): number | undefined =>
  units.find((unit) => unit.queue === queue)?.child.pid;
checkEqual(
  "the queue in each unit's arguments chose its processor, in its own process",
  ran,
  {
    emails: { processor: "emails", job: "welcome", pid: pid("emails") },
    images: { processor: "images", job: "thumbnail", pid: pid("images") },
  },
);
checkEqual("both units exited 0 once idle", codes, [0, 0]);

const settled = [];
for (const queue of ["emails", "images"]) {
  const controller = recipe.summonController(queue);
  await controller.check();
  const status = await controller.status();
  settled.push({
    last: status.last?.outcome,
    id: status.last?.id,
    pending: status.pending,
  });
}
checkEqual(
  "each queue's marker settled its own attempt as registered",
  settled,
  units.map((unit) => ({ last: "registered", id: unit.id, pending: [] })),
);

await recipe.purge();
await recipe.close();
summary();
