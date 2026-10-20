/**
 * A shared summon unit's progress, queue by queue, and how any process reads
 * it: each attempt in flight carries its `coverage` on every queue of the
 * unit, a unit that never registered on a queue keeps that queue in
 * `last.missing`, its group's status says `unit: "shared"`, and a management
 * API with no controller for the unit answers each of its queues with the
 * unit's status (`local: false`).
 *
 * ```bash
 * bun 02-queues/summon-shared-unit-coverage.ts
 * ```
 *
 * ```ts
 * const status = await jobs.summonController("renders").status();
 * status.pending[0]?.coverage; // { renders: "registered", thumbs: "pending", previews: "registered" }
 * status.last?.missing;        // ["thumbs"], once a partial attempt settled
 * status.group?.unit;          // "shared"
 * ```
 *
 * The unit is built by `BunJobs` from one entry of its `summon` option, in
 * one namespace with a per-queue controller for `emails` in a group of its
 * own; a second `BunJobs` on the same driver and namespace runs no
 * controller, and the management API over it is "any other process". Every
 * trigger is off, so a check runs only when the tour calls `check()`. The
 * unit's summoner records each request and starts nothing; the tour starts
 * the first attempt's unit itself, a moment later, as a platform would:
 * `02-queues/helpers/partial-unit-entry.ts` with the request's `argv`, an
 * entry that builds workers for renders and previews only. Step 7 runs the
 * conformance kit's checks a shared unit rests on against the Nimbus fake
 * (`02-queues/helpers/nimbus-platform.ts`); `02-queues/custom-provider.ts`
 * runs the whole kit. Summoning needs a backend another process can reach,
 * so on the memory driver this runs on a temporary SQLite file.
 *
 * The points that are easy to get wrong:
 *
 * - **Coverage is worked out each time the status is read**, from each
 *   queue's claim of the attempt and its live worker records, and never
 *   stored: `"registered"` once a worker of the unit holds the claim there,
 *   `"pending"` before that, and `"missing"` only once the attempt's `until`
 *   plus 5 s has passed with nothing registered there. The attempt itself
 *   stays in `pending` until the controller's next check settles it.
 * - **`GET /summon` items carry no attempts, so no coverage**;
 *   `GET /queues/<member>/summon` and `status()` do.
 * - **Coverage is best effort**: when the claim reads fail, the status is
 *   answered without it, with one `warn`, never with an error.
 * - **A unit that registered on some of its queues only settles
 *   `registered` with detail `partial:<queues>`**, and `last.missing`,
 *   stored with the outcome, names the same queues as the event's `missing`,
 *   so a process with no controller reads them too.
 * - **A process with no controller reads the unit from its group's state**
 *   (`local: false`), with coverage; before the unit's first claim there is
 *   nothing to read, and a member answers 409 `SUMMON_NOT_CONFIGURED`.
 * - **A queue charged by a controller of its own after the unit's last claim
 *   answers for itself**: the unit's `queues` leaves it out while the unit
 *   stays a unit for the rest; once every queue has gone back, the group has
 *   no `unit`; the unit's next claim answers for all of them again. The
 *   newer claim decides even for a controller in no group, whose charges
 *   never reach the group: the queue's own status answers for it, and the
 *   unit's `queues` leave it out just the same.
 * - **The kit's `summon.handoff.shared-unit` is a `should`**: a provider
 *   that does not pass `request.argv` whole fails the argument round trip (a
 *   `must`) and gets a warning on this check that blames the arguments.
 */
import type {
  JobsDriver,
  SummonCheckResult,
  SummonEventPayload,
  SummonGroupListDto,
  SummonGroupStatusDto,
  SummonListDto,
  SummonListItemDto,
  SummonRequest,
  SummonStatusDto,
} from "@kingsleyweb/bun-jobs";
import type {
  ConformanceCheck,
  ConformanceReport,
} from "@kingsleyweb/bun-jobs/provider/testing";
import type { Subprocess } from "bun";
import process from "node:process";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createDriver,
  createJobsApi,
  defineSummoner,
  ProviderError,
  RESERVED_STATE_PREFIX,
  SUMMON_ARGS,
} from "@kingsleyweb/bun-jobs";
import { runProviderConformance } from "@kingsleyweb/bun-jobs/provider/testing";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { A_UUID_V7, markEventId } from "../shared/summon-events";
import { nimbusPlatform } from "./helpers/nimbus-platform";

title("A shared summon unit's coverage, read from any process");

/** A generous ceiling for a child's start-up and anything a slow server stretches. */
const WAIT = { timeout: 30_000, interval: 20 };
/** Every trigger off, no cooldown, a 1 ms backoff: every check is one the tour asked for. */
const ONE_SHOT = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  backoff: { initial: 1, max: 1 },
} as const;
/**
 * The unit's boot budget: an attempt's `until` is its claim time plus this.
 * The tour waits for `until` plus 5 s before a queue reads `missing`, so the
 * shorter the better; but the unit must register before it, and at one
 * second a loaded machine booted the child too slowly. Five leave it room.
 */
const BOOT_BUDGET = 5_000;
/** How long past an attempt's `until` a queue with nothing registered still reads `pending` (the README's 5 s). */
const ALLOWANCE = 5_000;

/** The unit's queues, in the order it serves them. */
const MEDIA = ["renders", "thumbs", "previews"] as const;
/** The group, sharing one unit. */
const SHARED = { name: "media", unit: "shared" } as const;
/** The queues the partial unit's entry builds workers for: thumbs is missing. */
const PARTIAL = ["renders", "previews"];
/** The queue the partial unit never registers on. */
const MISSING = MEDIA.filter((queue) => !PARTIAL.includes(queue));

const config = crossProcessDriver();
const driver: JobsDriver = createDriver(config);
await driver.connect();
/** The entry file of the unit the tour starts: workers for `PARTIAL_QUEUES` only. */
const PARTIAL_ENTRY = new URL(
  "./helpers/partial-unit-entry.ts",
  import.meta.url,
).pathname;

/** What the controllers and APIs log, collected rather than printed. */
const { logger } = createTestLogger();

/**
 * Every child this tour started. One still alive when it exits — a check
 * failed mid-step, say — is killed, so it cannot outlive the tour.
 */
const children = new Set<Subprocess>();
process.on("exit", () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

/** Every context the tour built, purged and closed at the end. */
const contexts: BunJobs[] = [];
/** Every API and adapter the tour built, closed at the end. */
const apis: { close: () => Promise<void> }[] = [];

/** A check's outcome, or `skipped <reason>`. */
const said = (result: SummonCheckResult): string =>
  result.action === "summoned"
    ? result.outcome
    : result.action === "skipped"
      ? `skipped ${result.reason}`
      : result.action;

/** A summoner that records each request and says `started` for a unit it never starts itself. */
function recording(kind: string) {
  const calls: SummonRequest[] = [];
  return {
    calls,
    summoner: defineSummoner({
      kind,
      invoke: async (request: SummonRequest) => {
        calls.push(request);
        return { status: "started", handles: [] };
      },
    }),
  };
}

/** What one request to an API answered. */
interface Answer<T> {
  /** The HTTP status. */
  status: number;
  /** The parsed body. */
  body: T;
}

/** A management API over `jobs`, mounted on an adapter that never listens: `get` runs a request through it. */
function apiOver(jobs: BunJobs, apiLogger = logger) {
  const api = createJobsApi({
    jobs,
    basePath: "/jobs-api",
    authorize: () => true,
    logger: apiLogger,
  });
  const adapter = new BunHttpAdapter(0);
  adapter.use(api.basePath, api.router);
  apis.push(api, adapter);
  return {
    /** `GET <path>`, its status and parsed body. */
    get: async <T>(path: string): Promise<Answer<T>> => {
      const response = await adapter.fetch(`${api.basePath}${path}`);
      return { status: response.status, body: (await response.json()) as T };
    },
  };
}

/** A coverage record as a plain object, so it compares with a literal. */
const plain = (coverage: Readonly<Record<string, string>> | undefined) =>
  coverage === undefined ? undefined : { ...coverage };

/** The list item of the shared unit (the one with `queues`), if any. */
const unitItem = (list: SummonListDto): SummonListItemDto | undefined =>
  list.controllers.find((item) => item.queues !== undefined);

/* ------------------------------------------------------------------ */
step("1. Before the unit's first claim: nothing to read from storage");

const ns = exampleNamespace("summon-shared-coverage");
/** The requests the unit's summoner was handed: it starts nothing itself. */
const unitSummoner = recording("example-platform");
const mailSummoner = recording("example-record");
const unitJobs = new BunJobs({
  namespace: ns,
  driver,
  logger,
  summon: [
    {
      queues: [...MEDIA],
      group: SHARED,
      ...ONE_SHOT,
      bootBudget: BOOT_BUDGET,
      summoner: unitSummoner.summoner,
    },
    // A per-queue controller in a group of its own, for contrast in step 5.
    {
      emails: {
        group: { name: "mail" },
        ...ONE_SHOT,
        summoner: mailSummoner.summoner,
      },
    },
  ],
});
contexts.push(unitJobs);
const unit = unitJobs.summonController("renders");
const mail = unitJobs.summonController("emails");
/** What the unit emitted, in order. */
const unitEvents: SummonEventPayload[] = [];
unit.on("summon", (event) => unitEvents.push(event));

// One job on each queue, so every queue exists for the API and has work.
for (const queue of [...MEDIA, "emails"]) {
  await unitJobs.queue(queue).add("quick", {});
}

// Another process: the same driver and namespace, and no controller.
const remoteJobs = new BunJobs({ namespace: ns, driver, logger });
contexts.push(remoteJobs);
const remote = apiOver(remoteJobs);
const local = apiOver(unitJobs);

const early = await remote.get<{ code: string }>("/queues/renders/summon");
show("GET /queues/renders/summon with no controller, before any claim", early);
checkEqual(
  "an API with no controller answers a member 409 SUMMON_NOT_CONFIGURED: no claim has written the unit's state yet",
  [early.status, early.body.code],
  [409, "SUMMON_NOT_CONFIGURED"],
);

/* ------------------------------------------------------------------ */
step("2. Coverage on the attempt in flight: pending, then registered");

const first = await unit.check();
const request = unitSummoner.calls[0];
checkEqual(
  "one attempt for the three queues",
  [said(first), unitSummoner.calls.length, request.queues],
  ["started", 1, [...MEDIA]],
);
// The platform has not started the unit yet: nothing holds a claim.
const before = await unit.status();
const attempt = before.pending[0];
show("status().pending[0]", {
  id: attempt.id,
  until: attempt.until,
  coverage: plain(attempt.coverage),
});
/** Every queue `pending`. */
const ALL_PENDING = {
  renders: "pending",
  thumbs: "pending",
  previews: "pending",
};
checkEqual(
  "status().pending[0].coverage names every queue of the unit, each pending: no worker holds the claim anywhere yet",
  [before.pending.length, attempt.id, plain(attempt.coverage)],
  [1, request.id, ALL_PENDING],
);
const remoteBefore = await remote.get<SummonStatusDto>(
  "/queues/renders/summon",
);
checkEqual(
  "the API with no controller answers renders with the unit's status: local false, every queue, the attempt and its coverage",
  [
    remoteBefore.status,
    remoteBefore.body.local,
    remoteBefore.body.queues,
    remoteBefore.body.pending?.map((one) => one.id),
    plain(remoteBefore.body.pending?.[0]?.coverage),
  ],
  [200, false, [...MEDIA], [request.id], ALL_PENDING],
);
const localBefore = await local.get<SummonStatusDto>("/queues/thumbs/summon");
checkEqual(
  "the API over the controller's own context answers thumbs the same, local true",
  [
    localBefore.body.local,
    localBefore.body.queues,
    plain(localBefore.body.pending?.[0]?.coverage),
  ],
  [true, [...MEDIA], ALL_PENDING],
);
const lists = [
  (await local.get<SummonListDto>("/summon")).body,
  (await remote.get<SummonListDto>("/summon")).body,
];
show(
  "GET /summon's unit item, from each API",
  lists.map((list) => unitItem(list)),
);
checkEqual(
  "GET /summon lists the unit from either process — local, then not — and its items carry no attempts, so no coverage",
  lists.map((list) => {
    const item = unitItem(list);
    return [
      item?.queues,
      item?.local,
      item !== undefined && Object.hasOwn(item, "pending"),
      JSON.stringify(list).includes('"coverage":'),
    ];
  }),
  [
    [[...MEDIA], true, false, false],
    [[...MEDIA], false, false, false],
  ],
);

// The platform starts the unit now, with the request's argv: an entry that
// builds workers for renders and previews only.
const child = Bun.spawn({
  cmd: [process.execPath, PARTIAL_ENTRY, ...request.argv],
  env: {
    ...process.env,
    SUMMONED_DRIVER: JSON.stringify(config),
    PARTIAL_QUEUES: PARTIAL.join(","),
  },
  stdout: "ignore",
  stderr: "inherit",
});
children.add(child);

/** One status read: when it started and ended, by this process's clock, and thumbs' coverage. */
interface Read {
  /** `Date.now()` just before the read. */
  from: number;
  /** `Date.now()` just after it. */
  to: number;
  /** What the read said of each queue. */
  coverage: Record<string, string> | undefined;
}
/** Every status read from here until thumbs reads `missing`. */
const reads: Read[] = [];
/** Reads the unit's status, recording when, and answers its attempt's coverage. */
async function readCoverage(): Promise<Record<string, string> | undefined> {
  const from = Date.now();
  const status = await unit.status();
  const coverage = plain(
    status.pending.find((one) => one.id === request.id)?.coverage,
  );
  reads.push({ from, to: Date.now(), coverage });
  return coverage;
}
await waitFor(
  "renders and previews to read registered",
  async () => {
    const coverage = await readCoverage();
    return PARTIAL.every((queue) => coverage?.[queue] === "registered");
  },
  WAIT,
);
const registered = reads.at(-1)!.coverage;
show("coverage once the unit's workers are up", registered);
checkEqual(
  "renders and previews read registered once the unit's worker there holds the claim; thumbs, with no worker, never does",
  [
    registered?.renders,
    registered?.previews,
    reads.some((read) => read.coverage?.thumbs === "registered"),
  ],
  ["registered", "registered", false],
);

/* ------------------------------------------------------------------ */
step("3. missing, only once the attempt's until plus 5 s has passed");

await waitFor(
  "thumbs to read missing",
  async () => (await readCoverage())?.thumbs === "missing",
  WAIT,
);
/** The instant from which thumbs may read missing, by this process's clock. */
const missingFrom = attempt.until + ALLOWANCE;
const pendingReads = reads.filter(
  (read) => read.coverage?.thumbs === "pending",
);
const missingReads = reads.filter(
  (read) => read.coverage?.thumbs === "missing",
);
show("thumbs' reads", {
  pending: pendingReads.length,
  missing: missingReads.length,
  untilPlus5s: missingFrom,
  lastPendingStartedAt: pendingReads.at(-1)?.from,
  firstMissingEndedAt: missingReads[0]?.to,
});
checkEqual(
  "thumbs read pending on every read that started before until + 5 s, and missing only on a read that ended after it",
  [
    pendingReads.length > 0,
    pendingReads.every((read) => read.from < missingFrom),
    missingReads.every((read) => read.to >= missingFrom),
  ],
  [true, true, true],
);
const waiting = await unit.status();
checkEqual(
  "the attempt is still in pending, its last outcome still started — no check has settled it — with thumbs missing beside the two registered queues",
  [
    waiting.pending.map((one) => one.id),
    [waiting.last?.id, waiting.last?.outcome],
    plain(waiting.pending[0]?.coverage),
  ],
  [
    [request.id],
    [request.id, "started"],
    { renders: "registered", thumbs: "missing", previews: "registered" },
  ],
);
const remoteMissing = await remote.get<SummonStatusDto>(
  "/queues/previews/summon",
);
checkEqual(
  "the API with no controller works out the same coverage from the claims and worker records",
  [remoteMissing.body.local, plain(remoteMissing.body.pending?.[0]?.coverage)],
  [false, plain(waiting.pending[0]?.coverage)],
);

// Best effort: a process whose claim reads fail still answers the status,
// without coverage, and says why once.
const CLAIM_PREFIX = `${RESERVED_STATE_PREFIX}summon-claim:`;
/** `driver`, except that reading an attempt's claim throws. */
const failingDriver = new Proxy(driver, {
  get(target, key) {
    if (key === "getQueueState") {
      return async (
        ...args: Parameters<NonNullable<JobsDriver["getQueueState"]>>
      ) => {
        if (args[1].startsWith(CLAIM_PREFIX)) {
          throw new Error("the backend timed out");
        }
        return await target.getQueueState!(...args);
      };
    }
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const failingLog = createTestLogger();
const failingJobs = new BunJobs({
  namespace: ns,
  driver: failingDriver,
  logger: failingLog.logger,
});
const failing = apiOver(failingJobs, failingLog.logger);
const blind = [
  await failing.get<SummonStatusDto>("/queues/renders/summon"),
  await failing.get<SummonStatusDto>("/queues/renders/summon"),
];
const blindWarnings = failingLog.events.filter(
  (event) =>
    event.level === "warn" &&
    event.message.startsWith("could not read a shared summon unit"),
);
show("with claim reads failing", {
  statuses: blind.map((answer) => answer.status),
  pending: blind[0].body.pending,
  warnings: blindWarnings.map((event) => event.message),
});
checkEqual(
  "when the claim reads fail, the status is still answered, 200 with the attempt but no coverage, twice, and one warn says why",
  [
    blind.map((answer) => [
      answer.status,
      answer.body.pending?.map((one) => one.id),
      answer.body.pending?.some((one) => Object.hasOwn(one, "coverage")),
    ]),
    blindWarnings.map((event) => event.message),
  ],
  [
    [
      [200, [request.id], false],
      [200, [request.id], false],
    ],
    [
      "could not read a shared summon unit's claims or worker records; its status is shown without coverage",
    ],
  ],
);
await failingJobs.close();

/* ------------------------------------------------------------------ */
step("4. The next check settles it: last.missing");

await waitFor(
  "the attempt to settle",
  async () => {
    await unit.check();
    const { last } = await unit.status();
    return last?.id === request.id && last.outcome !== "started";
  },
  WAIT,
);
const settled = await unit.status();
show("status().last", settled.last);
checkEqual(
  `registered with detail partial:${MISSING.join(",")}, last.missing naming thumbs, one failure, and nothing pending`,
  [
    settled.last?.outcome,
    settled.last?.detail,
    settled.last?.missing,
    settled.failures,
    settled.pending.length,
  ],
  ["registered", `partial:${MISSING.join(",")}`, MISSING, 1, 0],
);
checkEqual(
  "the registered event lists the same queues in its missing",
  unitEvents
    .filter((event) => event.outcome === "registered")
    .map((event) =>
      markEventId({
        id: event.id,
        detail: event.detail,
        missing: event.missing,
        eventId: event.eventId,
      }),
    ),
  [
    {
      id: request.id,
      detail: `partial:${MISSING.join(",")}`,
      missing: MISSING,
      eventId: A_UUID_V7,
    },
  ],
);
const remoteLast = await remote.get<SummonStatusDto>("/queues/thumbs/summon");
const remoteList = (await remote.get<SummonListDto>("/summon")).body;
checkEqual(
  "stored with the outcome, so the API with no controller reads last.missing too: on thumbs' status and on GET /summon's item",
  [
    remoteLast.body.local,
    remoteLast.body.last?.missing,
    unitItem(remoteList)?.last?.missing,
  ],
  [false, MISSING, MISSING],
);

/* ------------------------------------------------------------------ */
step('5. unit: "shared" on the group\'s status');

checkEqual(
  "emails' per-queue controller summons, charging its own group, mail",
  said(await mail.check()),
  "started",
);
const unitGroup = (await unit.status()).group;
const mailGroup = (await mail.status()).group;
checkEqual(
  'status().group says unit: "shared" for the unit; a per-queue controller\'s group has no unit',
  [
    unitGroup?.name,
    unitGroup?.unit,
    mailGroup?.name,
    mailGroup !== undefined && Object.hasOwn(mailGroup, "unit"),
  ],
  [SHARED.name, "shared", "mail", false],
);
/** Each group's name and `unit`, as `GET /summon/groups` lists them. */
const groupUnits = (list: SummonGroupListDto) =>
  list.groups.map((group) => [group.name, group.unit]);
const localGroups = (await local.get<SummonGroupListDto>("/summon/groups"))
  .body;
const remoteGroups = (await remote.get<SummonGroupListDto>("/summon/groups"))
  .body;
show("GET /summon/groups, from each API", {
  local: groupUnits(localGroups),
  remote: groupUnits(remoteGroups),
});
checkEqual(
  'GET /summon/groups says unit: "shared" for media and nothing for mail, from the controller\'s process and from storage alone',
  [groupUnits(localGroups), groupUnits(remoteGroups)],
  [
    [
      ["mail", undefined],
      [SHARED.name, "shared"],
    ],
    [
      ["mail", undefined],
      [SHARED.name, "shared"],
    ],
  ],
);

/* ------------------------------------------------------------------ */
step("6. A queue with a controller of its own again answers for itself");

child.kill("SIGTERM");
checkEqual("the partial unit closes on SIGTERM", await child.exited, 0);

// A newer deployment: the same group, as per-queue controllers. thumbs'
// replica is updated first; its job is still waiting.
const perQueue = recording("example-record");
const switched = new BunJobs({
  namespace: ns,
  driver,
  logger,
  summon: [
    {
      queues: [...MEDIA],
      group: { name: SHARED.name },
      ...ONE_SHOT,
      bootBudget: BOOT_BUDGET,
      summoner: perQueue.summoner,
    },
  ],
});
contexts.push(switched);
checkEqual(
  "thumbs' own controller summons for it, charging thumbs' share of the group after the unit's last claim",
  said(await switched.summonController("thumbs").check()),
  "started",
);
/** `GET /queues/<queue>/summon` from the API with no controller. */
const remoteStatus = async (queue: string) =>
  (await remote.get<SummonStatusDto>(`/queues/${queue}/summon`)).body;
/** `GET /summon/groups/media` from the API with no controller. */
const remoteMedia = async () =>
  (await remote.get<SummonGroupStatusDto>(`/summon/groups/${SHARED.name}`))
    .body;
/** Each item of `GET /summon` from the API with no controller, as [queue, queues]. */
const remoteItems = async () =>
  (await remote.get<SummonListDto>("/summon")).body.controllers.map((item) => [
    item.queue,
    item.queues,
  ]);
const ownThumbs = await remoteStatus("thumbs");
const shrunk = await remoteStatus("renders");
checkEqual(
  "thumbs is answered by its own state — no queues, its own attempt — and renders by the unit, whose queues leave thumbs out",
  [
    [
      ownThumbs.queue,
      ownThumbs.queues,
      ownThumbs.pending?.map((one) => one.id),
    ],
    [shrunk.queue, shrunk.queues],
  ],
  [
    ["thumbs", undefined, [perQueue.calls[0]?.id]],
    ["renders", ["renders", "previews"]],
  ],
);
checkEqual(
  'the group is still a unit, for renders and previews: GET /summon lists it with those two, and thumbs on its own; GET /summon/groups/media says unit: "shared"',
  [await remoteItems(), (await remoteMedia()).unit],
  [
    [
      ["emails", undefined],
      ["renders", ["renders", "previews"]],
      ["thumbs", undefined],
    ],
    "shared",
  ],
);

// The other replicas follow: renders and previews get a job each (the unit
// worked theirs) and a controller of their own.
for (const queue of PARTIAL) {
  await switched.queue(queue).add("quick", {});
}
checkEqual(
  "renders' and previews' own controllers summon too",
  [
    said(await switched.summonController("renders").check()),
    said(await switched.summonController("previews").check()),
  ],
  ["started", "started"],
);
const ownRenders = await remoteStatus("renders");
const backMedia = await remoteMedia();
checkEqual(
  "every queue has gone back: renders answers for itself, GET /summon lists no unit, and the group has no unit",
  [
    [ownRenders.queue, ownRenders.queues],
    await remoteItems(),
    Object.hasOwn(backMedia, "unit"),
  ],
  [
    ["renders", undefined],
    [
      ["emails", undefined],
      ["previews", undefined],
      ["renders", undefined],
      ["thumbs", undefined],
    ],
    false,
  ],
);

// And the other way round: the unit claims again, after every queue's own.
checkEqual(
  "the unit summons once more: every queue has a job waiting",
  [said(await unit.check()), unitSummoner.calls.length],
  ["started", 2],
);
const again = await remoteStatus("thumbs");
checkEqual(
  'its claim is now the latest on every queue: thumbs is answered by the unit again, with every queue, and the group is unit: "shared"',
  [
    again.queues,
    again.pending?.map((one) => one.id),
    (await remoteMedia()).unit,
  ],
  [[...MEDIA], [unitSummoner.calls[1]?.id], "shared"],
);

// A controller of thumbs' own in no group at all: its charges never reach
// media's shares, so nothing in the group's state says thumbs left. What
// decides is the newer claim: the queue's own, now. A controller summons
// nothing over an attempt on its way, and thumbs has two: the unit's and the
// one its group's own controller made above. Nothing starts either, so each
// settles lost once its boot budget passes, at its controller's next check.
for (const [name, owner] of [
  ["the unit's second attempt", unit],
  ["thumbs' own attempt", switched.summonController("thumbs")],
] as const) {
  await waitFor(
    `${name} to settle`,
    async () => {
      await owner.check();
      return (await owner.status()).pending.length === 0;
    },
    WAIT,
  );
}
const ungrouped = recording("example-record");
const loneJobs = new BunJobs({
  namespace: ns,
  driver,
  logger,
  summon: { thumbs: { ...ONE_SHOT, summoner: ungrouped.summoner } },
});
contexts.push(loneJobs);
checkEqual(
  "a controller of thumbs' own, in no group, summons after the unit's claim",
  said(await loneJobs.summonController("thumbs").check()),
  "started",
);
const loneThumbs = await remoteStatus("thumbs");
const stillUnit = await remoteStatus("renders");
checkEqual(
  "its claim is newer, so thumbs answers for itself, with no group, and the unit's queues leave thumbs out, as they do for a queue charged in the group",
  [
    [
      loneThumbs.queues,
      loneThumbs.group,
      loneThumbs.pending?.map((one) => one.id),
    ],
    stillUnit.queues,
  ],
  [
    [undefined, undefined, [ungrouped.calls[0]?.id]],
    ["renders", "previews"],
  ],
);

/* ------------------------------------------------------------------ */
step("7. The conformance kit's summon.handoff.shared-unit");

/**
 * The checks this tour does not run: everything but identity, the
 * capabilities a controller insists on, routing, the argument round trip and
 * the handoff, which a shared unit rests on. `02-queues/custom-provider.ts`
 * runs them all.
 */
const NOT_HERE = [
  "summon.purity.identical-requests",
  "summon.dedupe.token-is-key",
  "summon.dedupe.same-key-one-unit",
  "summon.concurrency.distinct-ids",
  "summon.concurrency.same-id-one-unit",
  "summon.capabilities.platform-limits",
  "summon.errors.transient",
  "summon.errors.throttled",
  "summon.errors.quota",
  "summon.errors.auth",
  "summon.errors.misconfigured",
  "summon.errors.conflict",
  "summon.errors.capacity-200",
  "summon.errors.platform-code",
  "summon.timeouts.rejects-on-abort",
  "summon.timeouts.no-timer-left",
  "summon.status.knows-handles",
  "summon.status.cancel-stops-pending",
  "summon.lifetime.enforced",
  "summon.describe.facts",
  "summon.validate.healthy",
  "summon.validate.auth-fails",
  "summon.validate.starts-nothing",
  "summon.cas.one-call",
].map((id) => ({ id, reason: "not this tour's: custom-provider.ts runs it" }));

/** The fakes the kit ran against, closed at the end. */
const fakes: Awaited<ReturnType<typeof nimbusPlatform>>[] = [];

/**
 * Runs the kit on a summoner for a fresh Nimbus fake that starts units with
 * `args(request.argv)` as their arguments.
 */
async function kitRun(
  args: (argv: readonly string[]) => string[],
): Promise<ConformanceReport> {
  const nimbus = await nimbusPlatform();
  fakes.push(nimbus);
  const summoner = defineSummoner({
    kind: "example-nimbus",
    invoke: async (request: SummonRequest, ctx) => {
      const response = await ctx.fetch(`${nimbus.platform.url}/v1/runs`, {
        method: "POST",
        headers: {
          authorization: "Bearer nimbus-example-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          token: request.dedupeKey,
          args: args(request.argv),
          count: request.count,
        }),
        signal: ctx.signal,
      });
      if (!response.ok) {
        throw new ProviderError(
          `Nimbus answered ${response.status}`,
          "transient",
        );
      }
      const answer = (await response.json()) as {
        handles: string[];
        deduped?: boolean;
      };
      return {
        status: answer.deduped === true ? "deduped" : "started",
        handles: answer.handles,
      };
    },
  });
  return await runProviderConformance(summoner, {
    platform: nimbus.platform,
    driver: config,
    skip: NOT_HERE,
  });
}
/** A check of `report` by id. */
const checkOf = (report: ConformanceReport, id: string): ConformanceCheck =>
  report.checks.find((one) => one.id === id)!;
/** The ids of `report`'s checks that failed or warned, with their status. */
const notPassed = (report: ConformanceReport) =>
  report.checks
    .filter((one) => one.status === "fail" || one.status === "warn")
    .map((one) => [one.id, one.status]);

const whole = await kitRun((argv) => [...argv]);
const sharedWhole = checkOf(whole, "summon.handoff.shared-unit");
show("passing request.argv whole", sharedWhole);
checkEqual(
  "a provider passing request.argv whole: summon.handoff.shared-unit is a should and passes — one unit served both queues — and nothing failed",
  [
    sharedWhole.level,
    sharedWhole.status,
    sharedWhole.detail,
    checkOf(whole, "summon.argv.round-trip").status,
    notPassed(whole),
    whole.ok,
  ],
  [
    "should",
    "pass",
    "one unit served work and work.b: it registered on both, drained 3 jobs on each and exited 0",
    "pass",
    [],
    true,
  ],
);

// A provider that keys the arguments by flag: a repeated flag keeps only its
// last value, so the unit hears one --bun-jobs-summon-queue= of two.
const byFlag = await kitRun((argv) => [
  ...new Map(argv.map((arg) => [arg.split("=")[0], arg])).values(),
]);
const sharedByFlag = checkOf(byFlag, "summon.handoff.shared-unit");
show("keying request.argv by flag", sharedByFlag);
checkEqual(
  "a provider keying the arguments by flag fails the round trip, a must, and summon.handoff.shared-unit warns, blaming the arguments",
  [notPassed(byFlag), byFlag.ok, sharedByFlag.detail],
  [
    [
      ["summon.argv.round-trip", "fail"],
      ["summon.handoff.shared-unit", "warn"],
    ],
    false,
    "registration: the unit registered a worker on work.b only, none on work: the kit's worker builds one for each --bun-jobs-summon-queue= argument it receives, so the provider did not pass request.argv to the unit whole (keep every argument, in order)",
  ],
);
/** How many queue arguments each start request on `fake` naming a group carried: a unit for several queues. */
const queueArgs = (fake: (typeof fakes)[number]) =>
  fake.runs
    .filter((run) =>
      run.args.some((arg) => arg.startsWith(`${SUMMON_ARGS.group}=`)),
    )
    .map(
      (run) =>
        run.args.filter((arg) => arg.startsWith(`${SUMMON_ARGS.queue}=`))
          .length,
    );
checkEqual(
  "what Nimbus was asked to start each unit for several queues with: every queue argument (three for the round trip, two for the shared handoff), then one",
  fakes.map(queueArgs),
  [
    [3, 2],
    [1, 1],
  ],
);

/* ------------------------------------------------------------------ */
// Cleanup: every namespace this run wrote to, and nothing else; the kit
// cleans up after its own.
for (const fake of fakes) {
  await fake.platform.close();
}
for (const api of apis) {
  await api.close();
}
for (const jobs of contexts) {
  await jobs.purge();
  await jobs.close();
}
await driver.close();

summary();
