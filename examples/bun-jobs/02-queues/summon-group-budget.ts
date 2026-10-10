/**
 * Summon groups that share: one budget — and, if asked, one circuit — for
 * several queues' summon controllers, in any process (`SummonPolicy.group`).
 *
 * ```bash
 * bun 02-queues/summon-group-budget.ts
 * ```
 *
 * ```ts
 * summon: [
 *   {
 *     queues: ["renders", "thumbs", "previews"],
 *     summoner,
 *     // 60 attempts an hour and 400 a day for the three queues together.
 *     group: { name: "media", budget: { perHour: 60, perDay: 400 } },
 *   },
 * ]
 * ```
 *
 * The summoners here start nothing — they answer `unavailable`, fail, or say
 * `started` for a unit that never comes — and every controller is the
 * one-shot form (every trigger off, then `check()`), so nothing depends on a
 * summoned process. The one child process,
 * [`helpers/summon-group-member.ts`](./helpers/summon-group-member.ts), is a
 * controller of the same group in another process, charging the same budget.
 * A group's state lives in the backend, so on the memory driver this runs on
 * a temporary SQLite file. The budgets count per UTC hour, so before its
 * first attempt the tour makes sure at least a minute of the hour is left.
 *
 * The points that are easy to get wrong:
 *
 * - **The group's budget is the only budget unless you set one.** In a group
 *   with a budget, a queue that sets no `budget` has none of its own:
 *   `status().budget` says `off: true`, and its counts are kept to show its
 *   share. A `budget` set explicitly still applies, on top of the group's,
 *   and is checked first. `group.budget: false` keeps no group limit — the
 *   attempts are still counted — and leaves each queue's own budget on.
 * - **The name is the key.** The group's state is one entry under the
 *   namespace's reserved pseudo-queue `__bunjobs`: renaming a group starts a
 *   fresh budget, and two controllers of one queue in two groups charge one
 *   group each. No queue, `BunQueue` or `BunQueueWorker` may take that name,
 *   and `listQueues()` never shows it.
 * - **The circuit is keyed by the summoner's `kind`.** With `group.circuit`,
 *   failures on one queue open the circuit for every queue of the group with
 *   the same kind; a queue with another kind keeps summoning. Without it,
 *   each queue's circuit stands alone.
 * - **`reset()` leaves the group alone.** `reset({ group: true })` closes
 *   the group's circuit for the controller's kind and nothing else of the
 *   group's; only `reset({ group: true, budget: true })` clears its counts.
 * - **Over HTTP, a group shows only the members its reader may read.** The
 *   group routes ask `authorize` `queues.read` about each member queue, in
 *   name order, as `GET /queues/:queue/summon` asks it; a refused member's
 *   share is left out, and so is the `openedBy` of a circuit it opened, while
 *   the counts, limits and circuits stay. A group none of whose members may
 *   be read answers as an unknown one. Resetting a group asks
 *   `queues.summon` about every member and needs all of them.
 *
 * And two the bun-jobs README states, which this tour does not set out to
 * prove:
 *
 * - **It never overspends.** Each attempt is charged to the group *before*
 *   its queue's claim; a claim that is then lost gives the charge back (and
 *   a replica that sees the queue's summon state already moved charges
 *   nothing), and a give-back that never lands (every round lost to other
 *   writers, or a crash between the two writes) leaves the group one attempt
 *   over, never one under.
 * - **A mixed-version rollout can exceed the group's budget.** A process
 *   that predates groups charges only its queue, until every process runs
 *   the new version.
 */
import type {
  JobsApiAction,
  JobsApiAuthorizeContext,
  JobsApiConfig,
  MetaDto,
  SummonCheckResult,
  SummonEventPayload,
  SummonFailure,
  SummonGroupListDto,
  SummonGroupStatus,
  SummonGroupStatusDto,
  SummonRequest,
  SummonStatus,
  SummonStatusDto,
} from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  createJobsApi,
  defineSummoner,
  JOBS_API_ACTIONS,
  JOBS_API_OPT_IN_ACTIONS,
  ProviderError,
} from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { withinOneHour } from "../shared/budget-window";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Summon groups: one budget, and one circuit, for several queues");

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The library's default hourly limit, for a group or a queue that sets none. */
const DEFAULT_PER_HOUR = 30;
/** The library's default daily limit. */
const DEFAULT_PER_DAY = 300;
/**
 * How much of the current UTC hour steps 1 to 10 need left. They spend group
 * budgets and read the hour's counts back — up to the list over HTTP in step
 * 10 — and if an hour turned in between, the counts would start over and a
 * correct controller would look broken. Each controller's first refusal by
 * a group's budget in a window takes up to about 1.5 s (the re-check), and
 * the other process starts twice; from the first spend to the end of step
 * 10 took at most 15.8 s, measured on every backend on a 16-core machine at
 * a load of 32 (Postgres the slowest); 60 s is nearly four times that.
 */
const HOUR_NEEDED = 60_000;

/**
 * Every trigger off, no cooldown, a 1 ms backoff: every check is one the tour
 * asked for, and a failure holds back only the next millisecond.
 */
const ONE_SHOT = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  backoff: { initial: 1, max: 1 },
} as const;
/** A queue circuit that never opens in this tour, for queues about something else. */
const NO_CIRCUIT = { circuit: { failures: 1_000 } } as const;

const config = crossProcessDriver();
// The controllers log each failed call and each limit hit; collected, not printed.
const { logger } = createTestLogger();

/* ------------------------------------------------------------------ */
// The summoners. None starts anything.

/** Every request a summoner was handed, by queue (each queue name is used once). */
const calls = new Map<string, SummonRequest[]>();
/** Records `request` under its queue. */
function called(request: SummonRequest): void {
  calls.set(request.queue, [...(calls.get(request.queue) ?? []), request]);
}
/** How many times a summoner was called for `queue`. */
const callsTo = (queue: string): number => calls.get(queue)?.length ?? 0;

/** A platform with no room: every call answers `unavailable`, settled at once. */
function busy(kind: string) {
  return defineSummoner({
    kind,
    invoke: async (request: SummonRequest) => {
      called(request);
      return { status: "unavailable", reason: "busy" };
    },
  });
}

/** A platform that is down: every call throws, with a code. */
function down(kind: string) {
  return defineSummoner({
    kind,
    invoke: async (request: SummonRequest) => {
      called(request);
      throw Object.assign(new Error("the platform is down"), {
        code: "E_DOWN",
      });
    },
  });
}

/** A platform that rejects the credentials: an `auth` error, which opens a circuit at once. */
function revoked(kind: string) {
  return defineSummoner({
    kind,
    invoke: async (request: SummonRequest) => {
      called(request);
      throw new ProviderError("credentials rejected", "auth", {
        platformCode: "InvalidToken",
      });
    },
  });
}

/** A platform that takes the request: `started`, for a unit that never comes. */
function starting(kind: string) {
  return defineSummoner({
    kind,
    invoke: async (request: SummonRequest) => {
      called(request);
      return { status: "started", handles: [] };
    },
  });
}

/* ------------------------------------------------------------------ */
// What the tour reads back.

/** Everything the recording hooks were told, in order. */
const told: SummonFailure[] = [];
/** A hook that records what it is told. */
const record = (failure: SummonFailure): void => {
  told.push(failure);
};
/** What the hooks were told of `outcome` for `queue`. */
const toldFor = (queue: string, outcome: SummonFailure["outcome"]) =>
  told.filter(
    (failure) => failure.queue === queue && failure.outcome === outcome,
  );

/**
 * Lets the hooks the controllers scheduled run: each is called on a later
 * turn of the event loop than the check that decided it.
 */
async function hooksRan(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A check's outcome, or `skipped <reason>`. */
const said = (result: SummonCheckResult): string =>
  result.action === "summoned"
    ? result.outcome
    : result.action === "skipped"
      ? `skipped ${result.reason}`
      : result.action;

/** The 1 ms backoff passed, then one check of `queue`'s controller in `jobs`. */
async function again(jobs: BunJobs, queue: string): Promise<string> {
  await Bun.sleep(5);
  return said(await jobs.summonController(queue).check());
}

/** The group as `queue`'s controller in `jobs` reads it (`status().group`). */
async function groupOf(
  jobs: BunJobs,
  queue: string,
): Promise<SummonGroupStatus | undefined> {
  return (await jobs.summonController(queue).status()).group;
}

/** The end of the UTC window of `size` ms that holds `at`. */
const windowEnd = (at: number, size: number): number =>
  Math.floor(at / size) * size + size;

/**
 * Each queue's share of a group's day, with `lastAt` replaced by whether it
 * fell between `from` and `to`.
 */
function shares(
  group: Pick<SummonGroupStatus, "queues"> | undefined,
  from: number,
  to: number,
): Record<string, { day: number; lastAt: boolean }> {
  return Object.fromEntries(
    Object.entries(group?.queues ?? {}).map(([queue, share]) => [
      queue,
      { day: share.day, lastAt: share.lastAt >= from && share.lastAt <= to },
    ]),
  );
}

/** A queue's own budget, as checked: the counts, `off`, and whether the limits are there. */
function ownBudget(budget: SummonStatus["budget"]) {
  return {
    hour: budget?.hour,
    day: budget?.day,
    off: budget?.off,
    perHour: budget?.perHour,
    perDay: budget?.perDay,
    hasLimitKeys:
      budget !== undefined && ("perHour" in budget || "perDay" in budget),
  };
}

/** Every namespace the tour wrote to, and a context on each, purged at the end. */
const contexts: BunJobs[] = [];
/** A `BunJobs` the tour cleans up after. */
function context(options: ConstructorParameters<typeof BunJobs>[0]): BunJobs {
  const jobs = new BunJobs(options);
  contexts.push(jobs);
  return jobs;
}

/* ------------------------------------------------------------------ */
step("1. One budget for three queues: two attempts in all, then budget");

/** The group, written once in the array entry, as the README's recipe has it. */
const MEDIA = { name: "media", budget: { perHour: 2 } } as const;
const MEDIA_QUEUES = ["renders", "thumbs", "previews"] as const;
const mediaNamespace = exampleNamespace("summon-group-budget");
const media = context({
  namespace: mediaNamespace,
  driver: config,
  logger,
  summon: [
    {
      queues: [...MEDIA_QUEUES],
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: busy("example-busy"),
      group: MEDIA,
      onSummonFailed: record,
    },
  ],
});

/** Each media queue's `summon` events. */
const mediaEvents: Record<string, SummonEventPayload[]> = {};
for (const queue of MEDIA_QUEUES) {
  mediaEvents[queue] = [];
  media
    .summonController(queue)
    .on("summon", (event) => mediaEvents[queue]!.push(event));
  await media.queue(queue).add("work", { queue });
}

await withinOneHour(HOUR_NEEDED);
// A controller's first refusal by the group's budget in a window is not
// believed at once: the charge is retried, backing off, for up to about
// 1.5 s, so that replicas' charges on their way back are not read as the
// budget spent. `check()` answers once it is believed, so the refusals below
// take that long, and the hooks are told after.
const mediaFrom = Date.now();
const mediaChecks = [
  said(await media.summonController("renders").check()),
  said(await media.summonController("thumbs").check()),
  said(await media.summonController("previews").check()),
  await again(media, "renders"),
];
const mediaTo = Date.now();
await hooksRan();
show("renders, thumbs, previews, renders", mediaChecks);
checkEqual(
  `perHour: ${MEDIA.budget.perHour} for the group: renders and thumbs call the summoner, then previews and renders are skipped as budget`,
  [mediaChecks, MEDIA_QUEUES.map((queue) => callsTo(queue))],
  [
    ["unavailable", "unavailable", "skipped budget", "skipped budget"],
    [1, 1, 0],
  ],
);

const mediaGroup = await groupOf(media, "previews");
show("previews' status().group", mediaGroup);
checkEqual(
  "status().group: the group's name, its counts against its limits (perDay the default), and each queue's share of today",
  {
    ...mediaGroup,
    queues: shares(mediaGroup, mediaFrom, mediaTo),
  },
  {
    name: MEDIA.name,
    budget: {
      hour: MEDIA.budget.perHour,
      perHour: MEDIA.budget.perHour,
      day: MEDIA.budget.perHour,
      perDay: DEFAULT_PER_DAY,
      hourResetsAt: mediaGroup?.budget.hourResetsAt ?? 0,
      dayResetsAt: mediaGroup?.budget.dayResetsAt ?? 0,
    },
    queues: {
      renders: { day: 1, lastAt: true },
      thumbs: { day: 1, lastAt: true },
    },
  },
);
checkEqual(
  "the group's windows are UTC clock windows: hourResetsAt the next UTC hour, dayResetsAt the next UTC midnight",
  [mediaFrom, mediaTo].some(
    (at) =>
      mediaGroup?.budget.hourResetsAt === windowEnd(at, HOUR) &&
      mediaGroup?.budget.dayResetsAt === windowEnd(at, DAY),
  ),
  true,
);
checkEqual(
  "one state, whichever queue reads it: renders' and thumbs' status().group are previews'",
  [await groupOf(media, "renders"), await groupOf(media, "thumbs")],
  [mediaGroup, mediaGroup],
);
checkEqual(
  "the summoner sees nothing of the group: a grouped request has no group (that field is for a unit serving several queues)",
  (calls.get("renders") ?? []).map((request) => request.group),
  [undefined],
);

/* ------------------------------------------------------------------ */
step("2. What reports the group: the summon events and onSummonFailed");

/** The attempt events (an id) of the queues that summoned. */
const attemptEvents = [...mediaEvents.renders!, ...mediaEvents.thumbs!].filter(
  (event) => event.id !== "",
);
show("renders' and thumbs' attempt events", attemptEvents);
check(
  "every event of an attempt a grouped controller made names the group",
  attemptEvents.length > 0 &&
    attemptEvents.every((event) => event.group === MEDIA.name),
  attemptEvents,
);
checkEqual(
  "the group's budget-exhausted: one summon event on previews, with an empty id and the group",
  mediaEvents.previews,
  [
    {
      id: "",
      outcome: "budget-exhausted",
      kind: "example-busy",
      group: MEDIA.name,
    },
  ],
);
checkEqual(
  "onSummonFailed hears it once on each refused queue, with the group and the group's counts and limits",
  [
    ...toldFor("previews", "budget-exhausted"),
    ...toldFor("renders", "budget-exhausted"),
  ].map(({ at, ...rest }) => ({
    ...rest,
    at: at >= mediaFrom && at <= Date.now(),
  })),
  ["previews", "renders"].map((queue) => ({
    outcome: "budget-exhausted" as const,
    kind: "example-busy",
    namespace: mediaNamespace,
    queue,
    group: MEDIA.name,
    at: true,
    budget: {
      hour: MEDIA.budget.perHour,
      perHour: MEDIA.budget.perHour,
      day: MEDIA.budget.perHour,
      perDay: DEFAULT_PER_DAY,
    },
  })),
);
// A second refused check in the same window is not news.
await again(media, "previews");
await hooksRan();
checkEqual(
  "once per window: a second refused check on previews emits and tells nothing more",
  [
    mediaEvents.previews!.length,
    toldFor("previews", "budget-exhausted").length,
  ],
  [1, 1],
);

/* ------------------------------------------------------------------ */
step("3. Under a group budget, a queue's own budget is off unless set");

const mediaOwn = await Promise.all(
  MEDIA_QUEUES.map(async (queue) =>
    ownBudget((await media.summonController(queue).status()).budget),
  ),
);
show("each media queue's status().budget", mediaOwn);
checkEqual(
  "each queue's own budget: off: true, no perHour or perDay, and its attempts still counted",
  mediaOwn,
  [1, 1, 0].map((count) => ({
    hour: count,
    day: count,
    off: true as const,
    perHour: undefined,
    perDay: undefined,
    hasLimitKeys: false,
  })),
);

// A queue's own budget, set explicitly, still applies — on top of the group's.
const REPORTS = { name: "reports", budget: { perHour: 5 } } as const;
const WEEKLY_PER_HOUR = 1;
const ownNamespace = exampleNamespace("summon-group-budget-own");
const own = context({
  namespace: ownNamespace,
  driver: config,
  logger,
  summon: [
    {
      queues: ["daily", "weekly"],
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: busy("example-busy"),
      group: REPORTS,
      overrides: { weekly: { budget: { perHour: WEEKLY_PER_HOUR } } },
      onSummonFailed: record,
    },
    // 4. below: a group with no limit.
    {
      audit: {
        ...ONE_SHOT,
        ...NO_CIRCUIT,
        summoner: busy("example-busy"),
        group: { name: "audit", budget: false },
      },
    },
  ],
});
/** weekly's `summon` events. */
const weeklyEvents: SummonEventPayload[] = [];
own
  .summonController("weekly")
  .on("summon", (event) => weeklyEvents.push(event));
for (const queue of ["daily", "weekly", "audit"]) {
  await own.queue(queue).add("work", { queue });
}

const weeklyChecks = [
  said(await own.summonController("weekly").check()),
  await again(own, "weekly"),
  said(await own.summonController("daily").check()),
];
await hooksRan();
const reportsGroup = await groupOf(own, "daily");
show("weekly, weekly, daily", weeklyChecks);
checkEqual(
  `weekly's own perHour: ${WEEKLY_PER_HOUR} stops it first, while the group (${REPORTS.budget.perHour} an hour) still lets daily summon`,
  weeklyChecks,
  ["unavailable", "skipped budget", "unavailable"],
);
checkEqual(
  "the queue's limit is checked before the group is charged: two attempts made, two counted, weekly's refusal charged nothing",
  [reportsGroup?.budget.hour, reportsGroup?.queues.weekly?.day],
  [2, 1],
);
checkEqual(
  "weekly's status().budget has its own limits, the default perDay for the one it left out",
  ownBudget((await own.summonController("weekly").status()).budget),
  {
    hour: 1,
    day: 1,
    off: undefined,
    perHour: WEEKLY_PER_HOUR,
    perDay: DEFAULT_PER_DAY,
    hasLimitKeys: true,
  },
);
checkEqual(
  "a budget-exhausted of the queue's own budget names no group, on the event or the hook",
  [
    weeklyEvents.filter((event) => event.outcome === "budget-exhausted"),
    toldFor("weekly", "budget-exhausted").map(({ at: _at, ...rest }) => rest),
  ],
  [
    [{ id: "", outcome: "budget-exhausted", kind: "example-busy" }],
    [
      {
        outcome: "budget-exhausted",
        kind: "example-busy",
        namespace: ownNamespace,
        queue: "weekly",
        budget: {
          hour: 1,
          perHour: WEEKLY_PER_HOUR,
          day: 1,
          perDay: DEFAULT_PER_DAY,
        },
      },
    ],
  ],
);

/* ------------------------------------------------------------------ */
step("4. group.budget: false — no group limit, but every attempt counted");

const auditChecks = [
  said(await own.summonController("audit").check()),
  await again(own, "audit"),
  await again(own, "audit"),
];
const audit = await own.summonController("audit").status();
show("audit's status().group.budget", audit.group?.budget);
checkEqual(
  "three checks, three calls",
  [auditChecks, callsTo("audit")],
  [["unavailable", "unavailable", "unavailable"], 3],
);
checkEqual(
  "status().group.budget counts them, says off: true, and has no limits",
  {
    hour: audit.group?.budget.hour,
    day: audit.group?.budget.day,
    off: audit.group?.budget.off,
    hasLimitKeys:
      audit.group !== undefined &&
      ("perHour" in audit.group.budget || "perDay" in audit.group.budget),
  },
  { hour: 3, day: 3, off: true, hasLimitKeys: false },
);
checkEqual(
  "and leaves the queue's own budget on, with the defaults",
  ownBudget(audit.budget),
  {
    hour: 3,
    day: 3,
    off: undefined,
    perHour: DEFAULT_PER_HOUR,
    perDay: DEFAULT_PER_DAY,
    hasLimitKeys: true,
  },
);

/* ------------------------------------------------------------------ */
step("5. Across processes: another process charges the same budget");

const MEMBER = new URL("./helpers/summon-group-member.ts", import.meta.url)
  .pathname;
/** The group both processes name. */
const FLEET = { name: "fleet", budget: { perHour: 2 } } as const;
const fleetNamespace = exampleNamespace("summon-group-budget-fleet");

/** What the other process printed: its check, and the group as it read it. */
interface MemberReport {
  /** Its check's outcome, as {@link said} words it. */
  said: string;
  /** Its controller's `status().group`. */
  group?: SummonGroupStatus;
  /** Its pid. */
  pid: number;
}

/** Runs one check of `queue` in group `fleet` in a process of its own. */
async function member(queue: string): Promise<MemberReport & { code: number }> {
  const child = Bun.spawn({
    cmd: [process.execPath, MEMBER],
    env: {
      ...process.env,
      GROUP_DRIVER: JSON.stringify(config),
      GROUP_NAMESPACE: fleetNamespace,
      GROUP_QUEUE: queue,
      GROUP_NAME: FLEET.name,
      GROUP_PER_HOUR: String(FLEET.budget.perHour),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { ...(JSON.parse(output) as MemberReport), code };
}

const fleet = context({
  namespace: fleetNamespace,
  driver: config,
  logger,
  summon: {
    builds: {
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: busy("example-busy"),
      group: FLEET,
    },
  },
});
await fleet.queue("builds").add("work", {});

const fleetFrom = Date.now();
const first = await member("remote-builds");
show("the other process", {
  said: first.said,
  pid: first.pid,
  hour: first.group?.budget.hour,
});
checkEqual(
  "another process, a controller of queue remote-builds in the same group: one attempt, charged to the group",
  [first.code, first.said, first.group?.budget.hour, first.pid !== process.pid],
  [0, "unavailable", 1, true],
);
const seenHere = await groupOf(fleet, "builds");
checkEqual(
  "this process's controller (queue builds) sees the group's count include it, and remote-builds' share",
  [seenHere?.budget.hour, shares(seenHere, fleetFrom, Date.now())],
  [1, { "remote-builds": { day: 1, lastAt: true } }],
);
const fleetChecks = [
  said(await fleet.summonController("builds").check()),
  await again(fleet, "builds"),
];
checkEqual(
  `here, one more attempt spends the group's ${FLEET.budget.perHour}, and the next check is refused`,
  [fleetChecks, callsTo("builds")],
  [["unavailable", "skipped budget"], 1],
);
const second = await member("remote-builds");
checkEqual(
  "and the other process, run again, is refused too: the counts both read are one",
  [second.code, second.said, second.group?.budget.hour],
  [0, "skipped budget", FLEET.budget.perHour],
);

/* ------------------------------------------------------------------ */
step("6. A shared circuit, keyed by the summoner's kind");

/** Two failures across the group, of one kind, open it for a minute. */
const INGEST = {
  name: "ingest",
  circuit: { failures: 2, resetAfter: 60_000 },
} as const;
const circuitNamespace = exampleNamespace("summon-group-budget-circuit");
const circuits = context({
  namespace: circuitNamespace,
  driver: config,
  logger,
  summon: [
    {
      // Two queues on a platform that is down…
      queues: ["ingest-a", "ingest-b"],
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: down("example-ecs"),
      group: INGEST,
      onSummonFailed: record,
    },
    {
      // …and one in the same group on a platform of another kind.
      "ingest-c": {
        ...ONE_SHOT,
        ...NO_CIRCUIT,
        summoner: starting("example-fly"),
        group: INGEST,
        onSummonFailed: record,
      },
    },
    // The contrast: the same two queues' setup in a group without `circuit`,
    // where each queue's own circuit opens at two failures.
    {
      queues: ["solo-a", "solo-b"],
      ...ONE_SHOT,
      circuit: { failures: 2, resetAfter: 60_000 },
      summoner: down("example-ecs"),
      group: { name: "ingest-solo" },
      onSummonFailed: record,
    },
    // Rejected credentials: an `auth` error opens a shared circuit at once.
    {
      queues: ["sign-a", "sign-b"],
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: revoked("example-kms"),
      group: { name: "signing", circuit: true },
      onSummonFailed: record,
    },
  ],
});
for (const queue of [
  "ingest-a",
  "ingest-b",
  "ingest-c",
  "solo-a",
  "solo-b",
  "sign-a",
  "sign-b",
]) {
  await circuits.queue(queue).add("work", { queue });
}

const circuitFrom = Date.now();
const ingestChecks = [
  said(await circuits.summonController("ingest-a").check()),
  await again(circuits, "ingest-a"),
];
const circuitTo = Date.now();
const afterOpening = [
  said(await circuits.summonController("ingest-b").check()),
  said(await circuits.summonController("ingest-c").check()),
  await again(circuits, "ingest-a"),
];
await hooksRan();
show("ingest-a twice, then ingest-b, ingest-c, ingest-a", [
  ...ingestChecks,
  ...afterOpening,
]);
checkEqual(
  `two failures on ingest-a (group circuit failures: ${INGEST.circuit.failures}) open it: ingest-b, the same kind, is refused without a call; ingest-c, another kind, summons`,
  [
    ingestChecks,
    afterOpening,
    callsTo("ingest-a"),
    callsTo("ingest-b"),
    callsTo("ingest-c"),
  ],
  [
    ["failed", "failed"],
    ["skipped circuit-open", "started", "skipped circuit-open"],
    2,
    0,
    1,
  ],
);
/** The id of ingest-a's second attempt: the failure that opened the circuit. */
const secondFailure = calls.get("ingest-a")?.[1]?.id ?? "(no second attempt)";
const ingestB = await circuits.summonController("ingest-b").status();
show("ingest-b's status().group.circuit", ingestB.group?.circuit);
checkEqual(
  "ingest-b's status().group.circuit: the group's count for example-ecs, open, and the failure that opened it",
  ingestB.group?.circuit,
  {
    failures: INGEST.circuit.failures,
    openUntil: ingestB.group?.circuit?.openUntil,
    openedBy: { queue: "ingest-a", id: secondFailure, detail: "E_DOWN" },
  },
);
checkEqual(
  `it stays open resetAfter (${INGEST.circuit.resetAfter} ms) from the opening`,
  [
    (ingestB.group?.circuit?.openUntil ?? 0) >=
      circuitFrom + INGEST.circuit.resetAfter,
    (ingestB.group?.circuit?.openUntil ?? 0) <=
      circuitTo + INGEST.circuit.resetAfter,
  ],
  [true, true],
);
checkEqual(
  "each queue's own circuit stays closed: ingest-a counts its two failures, ingest-b none",
  [
    (await circuits.summonController("ingest-a").status()).failures,
    (await circuits.summonController("ingest-a").status()).circuitOpenUntil,
    ingestB.failures,
    ingestB.circuitOpenUntil,
  ],
  [2, undefined, 0, undefined],
);
const ingestC = (await circuits.summonController("ingest-c").status()).group;
checkEqual(
  "ingest-c's status().group.circuit is its own kind's, untouched; circuits shows every kind the group has counted",
  [ingestC?.circuit, Object.keys(ingestC?.circuits ?? {})],
  [{ failures: 0 }, ["example-ecs"]],
);
const ingestOpenings = told.filter(
  (failure) =>
    failure.outcome === "circuit-open" && failure.group === INGEST.name,
);
show("onSummonFailed's circuit-open", ingestOpenings);
checkEqual(
  "onSummonFailed hears circuit-open once, from the controller whose failure opened it, with the group; nothing for the checks it refused",
  ingestOpenings.map(({ at, ...rest }) => ({
    ...rest,
    at: at >= circuitFrom && at <= Date.now(),
  })),
  [
    {
      outcome: "circuit-open",
      kind: "example-ecs",
      namespace: circuitNamespace,
      queue: "ingest-a",
      group: INGEST.name,
      id: secondFailure,
      detail: "E_DOWN",
      at: true,
      until: ingestB.group?.circuit?.openUntil,
    },
  ],
);
checkEqual(
  "the failures themselves are the queue's, told without a group",
  toldFor("ingest-a", "failed").map((failure) => failure.group),
  [undefined, undefined],
);

// Without `group.circuit`: each queue on its own.
const soloChecks = [
  said(await circuits.summonController("solo-a").check()),
  await again(circuits, "solo-a"),
  await again(circuits, "solo-a"),
  said(await circuits.summonController("solo-b").check()),
];
await hooksRan();
const soloB = (await circuits.summonController("solo-b").status()).group;
checkEqual(
  "without group.circuit, solo-a's own circuit opens at two failures, and solo-b — same kind, same group — still calls the platform",
  [soloChecks, callsTo("solo-a"), callsTo("solo-b")],
  [["failed", "failed", "skipped circuit-open", "failed"], 2, 1],
);
checkEqual(
  "the group keeps no circuit (status().group has none), and the opening told is solo-a's own, with no group",
  [
    soloB?.circuit,
    soloB?.circuits,
    toldFor("solo-a", "circuit-open").map((failure) => failure.group),
  ],
  [undefined, undefined, [undefined]],
);

// An `auth` error opens a shared circuit at once.
const signChecks = [
  said(await circuits.summonController("sign-a").check()),
  said(await circuits.summonController("sign-b").check()),
];
const signB = (await circuits.summonController("sign-b").status()).group;
checkEqual(
  "rejected credentials open the group's circuit at once: one failed call for the group, not one per queue",
  [signChecks, callsTo("sign-a"), callsTo("sign-b")],
  [["failed", "skipped circuit-open"], 1, 0],
);
checkEqual(
  "and the opening names the auth error's platform code",
  signB?.circuit?.openedBy?.detail,
  "InvalidToken",
);

/* ------------------------------------------------------------------ */
step("7. reset: what it clears of the group");

const ingestBController = circuits.summonController("ingest-b");
await ingestBController.reset();
checkEqual(
  "a plain reset() on ingest-b clears only its queue: the group's circuit is still open, and the next check still refused",
  [
    (await groupOf(circuits, "ingest-b"))?.circuit?.openUntil !== undefined,
    await again(circuits, "ingest-b"),
    callsTo("ingest-b"),
  ],
  [true, "skipped circuit-open", 0],
);
await ingestBController.reset({ group: true });
const closed = await groupOf(circuits, "ingest-b");
checkEqual(
  "reset({ group: true }) closes the group's circuit for example-ecs and clears its count",
  [closed?.circuit, closed?.circuits],
  [{ failures: 0 }, undefined],
);
const reopened = [
  await again(circuits, "ingest-b"),
  await again(circuits, "ingest-a"),
  await again(circuits, "ingest-b"),
];
await hooksRan();
checkEqual(
  "summoning resumes: ingest-b calls the platform (and fails), ingest-a's failure makes two, and the circuit opens anew",
  [reopened, callsTo("ingest-b")],
  [["failed", "failed", "skipped circuit-open"], 1],
);
checkEqual(
  "a new opening is told again: two circuit-opens for the group in all",
  told.filter(
    (failure) =>
      failure.outcome === "circuit-open" && failure.group === INGEST.name,
  ).length,
  2,
);

// The budget: `media` is spent (two of two this hour).
const renders = media.summonController("renders");
/** The group's hour count and the next check on previews. */
const mediaState = async () => [
  (await groupOf(media, "renders"))?.budget.hour,
  await again(media, "previews"),
];
await renders.reset({ budget: true });
checkEqual(
  "reset({ budget: true }) clears the queue's own counts and leaves the group's: previews is still refused",
  [(await renders.status()).budget?.hour, ...(await mediaState())],
  [0, MEDIA.budget.perHour, "skipped budget"],
);
await renders.reset({ group: true });
checkEqual(
  "reset({ group: true }) on a group with no shared circuit clears nothing of the group's",
  await mediaState(),
  [MEDIA.budget.perHour, "skipped budget"],
);
await renders.reset({ group: true, budget: true });
const cleared = await groupOf(media, "renders");
checkEqual(
  "reset({ group: true, budget: true }) zeroes the group's counts and every queue's share",
  [cleared?.budget.hour, cleared?.budget.day, cleared?.queues],
  [0, 0, {}],
);
const afterClear = [
  await again(media, "previews"),
  await again(media, "thumbs"),
  await again(media, "renders"),
];
await hooksRan();
checkEqual(
  "the group summons again — previews, then thumbs — until renders meets the limit once more, which is news again to the controller that reset",
  [afterClear, toldFor("renders", "budget-exhausted").length],
  [["unavailable", "unavailable", "skipped budget"], 2],
);

/* ------------------------------------------------------------------ */
step("8. The name is the key");

const namesNamespace = exampleNamespace("summon-group-budget-names");
/** A context on the names namespace whose `queue` is in group `name`. */
function named(queue: string, name: string, perHour: number): BunJobs {
  return context({
    namespace: namesNamespace,
    driver: config,
    logger,
    summon: {
      [queue]: {
        ...ONE_SHOT,
        ...NO_CIRCUIT,
        summoner: busy("example-busy"),
        group: { name, budget: { perHour } },
      },
    },
  });
}
const batch = named("nightly", "batch", 1);
await batch.queue("nightly").add("work", {});
const batchChecks = [
  said(await batch.summonController("nightly").check()),
  await again(batch, "nightly"),
];
const renamed = named("nightly", "batch-v2", 1);
const renamedCheck = await again(renamed, "nightly");
checkEqual(
  "group batch, perHour 1: spent by one attempt; the same queue's controller in group batch-v2 starts afresh",
  [batchChecks, renamedCheck, (await groupOf(renamed, "nightly"))?.budget.hour],
  [["unavailable", "skipped budget"], "unavailable", 1],
);

// One queue, two controllers, two groups: a team budget and an org budget.
const team = named("exports", "team", 5);
const org = named("exports", "org", 50);
await team.queue("exports").add("work", {});
const twoGroups = [
  said(await team.summonController("exports").check()),
  await again(org, "exports"),
];
const teamGroup = await groupOf(team, "exports");
const orgGroup = await groupOf(org, "exports");
checkEqual(
  "two controllers of queue exports, in groups team and org: each attempt is charged to its own controller's group",
  [
    twoGroups,
    [teamGroup?.name, teamGroup?.budget.hour, teamGroup?.queues.exports?.day],
    [orgGroup?.name, orgGroup?.budget.hour, orgGroup?.queues.exports?.day],
    (await team.summonController("exports").status()).budget?.hour,
  ],
  [["unavailable", "unavailable"], ["team", 1, 1], ["org", 1, 1], 2],
);

/* ------------------------------------------------------------------ */
step("9. __bunjobs is reserved, and listQueues() never shows it");

const RESERVED =
  /may not be "__bunjobs": bun-jobs reserves that name for its own state/;
await checkRejects("a queue named __bunjobs", () => media.queue("__bunjobs"), {
  name: "ConfigError",
  message: RESERVED,
});
await checkRejects(
  "a BunQueue named __bunjobs",
  () =>
    new BunQueue("__bunjobs", {
      namespace: mediaNamespace,
      driver: media.driver,
      logger,
    }),
  { name: "ConfigError", message: RESERVED },
);
await checkRejects(
  "a BunQueueWorker named __bunjobs",
  () =>
    new BunQueueWorker("__bunjobs", async () => {}, {
      namespace: mediaNamespace,
      driver: media.driver,
      logger,
    }),
  { name: "ConfigError", message: RESERVED },
);
await checkRejects(
  "a group named __bunjobs",
  () =>
    new BunJobs({
      namespace: mediaNamespace,
      driver: media.driver,
      logger,
      summon: {
        x: {
          ...ONE_SHOT,
          summoner: busy("example-busy"),
          group: { name: "__bunjobs" },
        },
      },
    }),
  { name: "ConfigError", message: /group\.name may not be "__bunjobs"/ },
);
checkEqual(
  "listQueues() on namespaces holding group state: the queues, never the pseudo-queue",
  [(await media.listQueues()).sort(), (await fleet.listQueues()).sort()],
  [[...MEDIA_QUEUES].sort(), ["builds", "remote-builds"]],
);

/* ------------------------------------------------------------------ */
step("10. Over HTTP: the groups, read from storage");

/** The default actions plus `queues.summon`, which the group reset needs. */
const SUMMON_ACTIONS: JobsApiAction[] = JOBS_API_ACTIONS.filter(
  (action) =>
    !JOBS_API_OPT_IN_ACTIONS.has(action) || action === "queues.summon",
);
/** Everything `authorize` was asked, in order. */
const asked: JobsApiAuthorizeContext[] = [];
/** An error answer's body (RFC 9457 problem details), as far as the tour reads it. */
interface Problem {
  /** The error code, e.g. `SUMMON_NOT_CONFIGURED`. */
  code?: string;
  /** The error's title, the same for every error with its code. */
  title?: string;
  /** What went wrong, for this request. */
  detail?: string;
}

/**
 * An API over `jobs` at `/admin/jobs`, on an adapter of its own, whose
 * `authorize` records every question in {@link asked} and answers `allow`'s
 * verdict (every question allowed, unless given).
 */
function mount(
  jobs: BunJobs,
  extra: Partial<JobsApiConfig> = {},
  allow: (ctx: JobsApiAuthorizeContext) => boolean = () => true,
) {
  const api = createJobsApi({
    jobs,
    basePath: "/admin/jobs",
    actions: SUMMON_ACTIONS,
    authorize: (_req, ctx) => {
      asked.push(ctx);
      return allow(ctx);
    },
    ...extra,
  });
  const adapter = new BunHttpAdapter(0);
  adapter.use(api.basePath, api.router);
  /** One request, answered as status and parsed body. */
  async function call<T>(method: "GET" | "POST", path: string, body?: object) {
    const response = await adapter.fetch(`${api.basePath}${path}`, {
      method,
      ...(method === "GET"
        ? {}
        : { headers: { "content-type": "application/json" } }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as T };
  }
  /** The summon group routes this API registered, by operation id. */
  const groupRoutes = () =>
    api.routes
      .filter((route) => route.path.includes("/summon/groups"))
      .map(
        (route) => `${route.operationId}${route.mutation ? " (mutation)" : ""}`,
      )
      .sort();
  return { call, groupRoutes };
}

// An API in a process with no summon controller at all: what it shows of
// `fleet` — whose controllers ran here and in the other process — it reads
// from storage.
const bare = context({ namespace: fleetNamespace, driver: config, logger });
const remote = mount(bare);
checkEqual(
  "/meta.features.summonRemoteStatus is true",
  (await remote.call<MetaDto>("GET", "/meta")).body.features.summonRemoteStatus,
  true,
);
const listed = await remote.call<SummonGroupListDto>("GET", "/summon/groups");
show("GET /summon/groups", listed.body);
const fleetDto = listed.body.groups[0];
checkEqual(
  "GET /summon/groups lists fleet from storage: its counts, the limits its last charge persisted, both queues' shares, and no circuit",
  [
    listed.status,
    listed.body.groups.map((group) => group.name),
    {
      ...fleetDto,
      queues: shares(fleetDto, fleetFrom, Date.now()),
    },
  ],
  [
    200,
    [FLEET.name],
    {
      name: FLEET.name,
      budget: {
        hour: FLEET.budget.perHour,
        perHour: FLEET.budget.perHour,
        day: FLEET.budget.perHour,
        perDay: DEFAULT_PER_DAY,
        hourResetsAt: fleetDto?.budget.hourResetsAt ?? 0,
        dayResetsAt: fleetDto?.budget.dayResetsAt ?? 0,
      },
      queues: {
        builds: { day: 1, lastAt: true },
        "remote-builds": { day: 1, lastAt: true },
      },
    },
  ],
);
const one = await remote.call<SummonGroupStatusDto>(
  "GET",
  "/summon/groups/fleet",
);
const unknown = await remote.call<Problem>("GET", "/summon/groups/nope");
checkEqual(
  "GET /summon/groups/fleet answers the same group as the list",
  [one.status, one.body],
  [200, fleetDto],
);
checkEqual(
  "a group nothing has written is 409 SUMMON_NOT_CONFIGURED: not a 404, and not an empty entry",
  [unknown.status, unknown.body.code],
  [409, "SUMMON_NOT_CONFIGURED"],
);
/** The 409 detail of a group reset where no controller in the group runs. */
const noControllerHere = (group: string): string =>
  `Summon group "${group}" can be reset only through an API whose process runs a controller in it, and none runs in this process`;
const remoteReset = await remote.call<Problem>(
  "POST",
  "/summon/groups/fleet/reset",
  { budget: true },
);
checkEqual(
  "the reset needs a controller in the group in the API's process: here, 409 SUMMON_NOT_CONFIGURED, saying so",
  [remoteReset.status, remoteReset.body.code, remoteReset.body.detail],
  [409, "SUMMON_NOT_CONFIGURED", noControllerHere(FLEET.name)],
);

// The API in the process that has `builds`' controller: it can reset.
const local = mount(fleet);
const nothing = await local.call<SummonGroupStatusDto>(
  "POST",
  "/summon/groups/fleet/reset",
  {},
);
const resetBudget = await local.call<SummonGroupStatusDto>(
  "POST",
  "/summon/groups/fleet/reset",
  { budget: true },
);
checkEqual(
  "POST /summon/groups/fleet/reset with {} changes nothing; with { budget: true } the counts and shares go to 0",
  [
    [nothing.status, nothing.body.budget.hour],
    [resetBudget.status, resetBudget.body.budget.hour, resetBudget.body.queues],
  ],
  [
    [200, FLEET.budget.perHour],
    [200, 0, {}],
  ],
);
checkEqual(
  "and the group summons again",
  await again(fleet, "builds"),
  "unavailable",
);

// The circuit over HTTP: `ingest`'s is open again since step 7.
const ingestApi = mount(circuits);
const beforeIngest = await ingestApi.call<SummonGroupStatusDto>(
  "GET",
  "/summon/groups/ingest",
);
const ingestReset = await ingestApi.call<SummonGroupStatusDto>(
  "POST",
  "/summon/groups/ingest/reset",
  { circuit: true },
);
checkEqual(
  "{ circuit: true } closes the group's circuit, every kind's, and leaves its budget usage",
  [
    beforeIngest.body.circuit?.openUntil !== undefined,
    ingestReset.status,
    ingestReset.body.circuit,
    ingestReset.body.circuits,
    ingestReset.body.budget.hour === beforeIngest.body.budget.hour,
  ],
  [true, 200, { failures: 0 }, undefined, true],
);

// Who may see what. A group names its member queues — each one's share of
// today, and the attempt that opened a shared circuit — so every group route
// asks `authorize` about each member, in queue-name order, as
// `GET /queues/:queue/summon` asks it, and leaves out the members it refuses.
// One group, three members: payroll's failure opens the shared circuit.
const CREW = {
  name: "crew",
  circuit: { failures: 3, resetAfter: 60_000 },
} as const;
const CREW_QUEUES = ["intake", "payroll", "shipping"] as const;
const crew = context({
  namespace: exampleNamespace("summon-group-budget-crew"),
  driver: config,
  logger,
  summon: [
    {
      queues: [...CREW_QUEUES],
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: down("example-ecs"),
      group: CREW,
    },
  ],
});
for (const queue of CREW_QUEUES) {
  await crew.queue(queue).add("work", { queue });
}
const crewChecks = [
  said(await crew.summonController("intake").check()),
  said(await crew.summonController("shipping").check()),
  said(await crew.summonController("payroll").check()),
];
/** Every question allowed: the whole group. */
const crewAll = mount(crew);
const full = (
  await crewAll.call<SummonGroupStatusDto>("GET", "/summon/groups/crew")
).body;
show("GET /summon/groups/crew, every member readable", full);
checkEqual(
  "intake, shipping, then payroll fail, and payroll's opens the shared circuit: three shares, and openedBy payroll",
  [
    crewChecks,
    Object.keys(full.queues).sort(),
    full.circuit?.openedBy?.queue,
    full.circuits?.["example-ecs"]?.openedBy?.queue,
  ],
  [["failed", "failed", "failed"], [...CREW_QUEUES], "payroll", "payroll"],
);

/** Refuses every question about payroll: an allow-list of intake and shipping. */
const notPayroll = (ctx: JobsApiAuthorizeContext): boolean =>
  ctx.queue !== "payroll";
const crewPartial = mount(crew, {}, notPayroll);
/** What `authorize` was asked since the last call, as [action, queue, route]. */
function questions(): [string, string | undefined, string][] {
  const asks = asked.map((ctx): [string, string | undefined, string] => [
    ctx.action,
    ctx.queue,
    `${ctx.route?.method} ${ctx.route?.path}`,
  ]);
  asked.length = 0;
  return asks;
}
/** `queues.read` on each of `queues`, as `GET /queues/:queue/summon` asks it. */
const readsOf = (...queues: string[]): [string, string, string][] =>
  queues.map((queue) => ["queues.read", queue, "GET /queues/:queue/summon"]);

asked.length = 0;
const partialList = await crewPartial.call<SummonGroupListDto>(
  "GET",
  "/summon/groups",
);
const listAsks = questions();
const partialOne = await crewPartial.call<SummonGroupStatusDto>(
  "GET",
  "/summon/groups/crew",
);
const oneAsks = questions();
const partialQueue = await crewPartial.call<SummonStatusDto>(
  "GET",
  "/queues/intake/summon",
);
const queueAsks = questions();
show("GET /summon/groups/crew, payroll refused", partialOne.body);
checkEqual(
  "authorize is asked queues.read about every member, in order, as the status route asks it: after queues.list for the list, with nothing before it for one group, and after the route's own question for a queue's status (its own queue counts as read; its group's other queues are asked about)",
  [listAsks, oneAsks, queueAsks],
  [
    [
      ["queues.list", undefined, "GET /summon/groups"],
      ...readsOf(...CREW_QUEUES),
    ],
    readsOf(...CREW_QUEUES),
    [...readsOf("intake"), ...readsOf("payroll", "shipping")],
  ],
);
/** `full` as a caller refused payroll sees it: no share, no openedBy, nothing else changed. */
const { payroll: _payrollShare, ...readableShares } = full.queues;
const { openedBy: _byCircuit, ...circuitSeen } = full.circuit ?? {
  failures: 0,
};
const { openedBy: _byKind, ...kindSeen } = full.circuits?.["example-ecs"] ?? {
  failures: 0,
};
const redacted: SummonGroupStatusDto = {
  ...full,
  queues: readableShares,
  circuit: circuitSeen,
  circuits: { "example-ecs": kindSeen },
};
checkEqual(
  "the group without payroll: its share dropped, and the openedBy of the circuit it opened; the counts, limits, reset times and the circuit's failures and openUntil as they are",
  [partialList.body.groups, partialOne.status, partialOne.body],
  [[redacted], 200, redacted],
);
checkEqual(
  "and a queue's status embeds the group the same way: GET /queues/intake/summon's group has intake's and shipping's shares, and no openedBy",
  [
    partialQueue.status,
    Object.keys(partialQueue.body.group?.queues ?? {}).sort(),
    partialQueue.body.group?.circuit,
    partialQueue.body.group?.budget,
  ],
  [200, ["intake", "shipping"], circuitSeen, full.budget],
);

// A caller that may read none of the members gets nothing that says the
// group exists: it is left out of the list, and answered as an unknown group
// — after one question without a queue, whose denial is answered instead.
const crewBlind = mount(crew, {}, (ctx) => ctx.queue === undefined);
const blindList = await crewBlind.call<SummonGroupListDto>(
  "GET",
  "/summon/groups",
);
const blindListAsks = questions();
const blindCrew = await crewBlind.call<Problem>("GET", "/summon/groups/crew");
const blindCrewAsks = questions();
const blindNope = await crewBlind.call<Problem>("GET", "/summon/groups/nope");
/** `body` with every `nope` in it named `crew`. */
const asCrew = (body: Problem): Problem =>
  JSON.parse(JSON.stringify(body).replaceAll("nope", "crew")) as Problem;
show("GET /summon/groups/crew, no member readable", blindCrew.body);
checkEqual(
  "no member readable: crew is left out of the list (no question without a queue: it has members), and GET /summon/groups/crew is 409 with the body of a group nothing wrote, but for the name",
  [
    blindList.body.groups,
    blindListAsks,
    blindCrew.status,
    blindCrew.body,
    blindCrew.body.title,
  ],
  [
    [],
    [
      ["queues.list", undefined, "GET /summon/groups"],
      ...readsOf(...CREW_QUEUES),
    ],
    409,
    asCrew(blindNope.body),
    "No summon controller runs here",
  ],
);
checkEqual(
  "the 409 came after the members and one queues.read without a queue, asked as the group route",
  blindCrewAsks,
  [
    ...readsOf(...CREW_QUEUES),
    ["queues.read", undefined, "GET /summon/groups/:group"],
  ],
);
const crewSealed = mount(crew, {}, (ctx) => ctx.action !== "queues.read");
const sealedCrew = await crewSealed.call<Problem>("GET", "/summon/groups/crew");
const sealedNope = await crewSealed.call<Problem>("GET", "/summon/groups/nope");
checkEqual(
  "and where that question is refused too, both are its 403, alike but for the name",
  [sealedCrew.status, sealedCrew.body.code, sealedCrew.body],
  [403, "FORBIDDEN", asCrew(sealedNope.body)],
);

// The reset clears state that governs every member, so it asks queues.summon
// about each — all of them, refused or not — and needs every one.
asked.length = 0;
const refusedReset = await crewPartial.call<Problem>(
  "POST",
  "/summon/groups/crew/reset",
  { circuit: true },
);
const refusedAsks = questions();
/** The reset's question about each of `queues`. */
const resetsOf = (...queues: string[]): [string, string, string][] =>
  queues.map((queue) => [
    "queues.summon",
    queue,
    "POST /summon/groups/:group/reset",
  ]);
const afterRefusal = await crewAll.call<SummonGroupStatusDto>(
  "GET",
  "/summon/groups/crew",
);
checkEqual(
  "a reset refused queues.summon on payroll: every member asked, then 403 naming no queue, and the circuit still open",
  [
    refusedAsks,
    refusedReset.status,
    refusedReset.body.code,
    JSON.stringify(refusedReset.body).includes("payroll"),
    afterRefusal.body.circuit?.openUntil,
  ],
  [resetsOf(...CREW_QUEUES), 403, "FORBIDDEN", false, full.circuit?.openUntil],
);
// queues.summon on a queue is not queues.read on it: a caller allowed to
// reset every member but not to read payroll gets the answer without it.
const crewOperator = mount(
  crew,
  {},
  (ctx) => !(ctx.action === "queues.read" && ctx.queue === "payroll"),
);
asked.length = 0;
const operatorReset = await crewOperator.call<SummonGroupStatusDto>(
  "POST",
  "/summon/groups/crew/reset",
  { circuit: true },
);
checkEqual(
  "allowed on all three, the reset lands, then asks queues.read about each member to answer: the circuit closed, payroll's share left out",
  [
    questions(),
    operatorReset.status,
    operatorReset.body.circuit,
    Object.keys(operatorReset.body.queues).sort(),
    operatorReset.body.budget,
  ],
  [
    [...resetsOf(...CREW_QUEUES), ...readsOf(...CREW_QUEUES)],
    200,
    { failures: 0 },
    ["intake", "shipping"],
    full.budget,
  ],
);

// 403 before 409: with no controller of the group in the API's process the
// reset is 409 — but only to a caller allowed to ask. For a group with no
// state at all there is no member to ask about, so the question has no queue.
const remoteRefused = mount(bare, {}, (ctx) => ctx.action !== "queues.summon");
asked.length = 0;
const resetNowhere = [
  await remoteRefused.call<Problem>("POST", "/summon/groups/nope/reset", {}),
  await remote.call<Problem>("POST", "/summon/groups/nope/reset", {}),
];
checkEqual(
  "a reset of a group with no state and no controller here: one queues.summon without a queue — refused, 403; allowed, 409 saying no controller runs here",
  [
    questions(),
    resetNowhere.map(({ status, body }) => [status, body.code, body.detail]),
  ],
  [
    [
      ["queues.summon", undefined, "POST /summon/groups/:group/reset"],
      ["queues.summon", undefined, "POST /summon/groups/:group/reset"],
    ],
    [
      [403, "FORBIDDEN", "Not allowed to perform this action"],
      [409, "SUMMON_NOT_CONFIGURED", noControllerHere("nope")],
    ],
  ],
);
checkEqual(
  "readOnly drops the reset route and keeps the two reads",
  [local.groupRoutes(), mount(fleet, { readOnly: true }).groupRoutes()],
  [
    ["getSummonGroup", "listSummonGroups", "resetSummonGroup (mutation)"],
    ["getSummonGroup", "listSummonGroups"],
  ],
);

/* ------------------------------------------------------------------ */
step("Clean up");

const purged = new Set<string>();
for (const jobs of contexts) {
  if (!purged.has(jobs.namespace)) {
    purged.add(jobs.namespace);
    await jobs.purge();
  }
}
const afterPurge = await remote.call<SummonGroupListDto>(
  "GET",
  "/summon/groups",
);
checkEqual(
  "purge takes the groups' state with the namespace",
  afterPurge.body.groups,
  [],
);
await Promise.all(contexts.map(async (jobs) => await jobs.close()));
summary();
