/**
 * When summoning goes wrong: the `onSummonFailed` hook, and the summon budget
 * — spent, turned off with `budget: false`, and cleared with
 * `reset({ budget: true })`.
 *
 * ```bash
 * bun 02-queues/summon-failures.ts
 * ```
 *
 * ```ts
 * summon: {
 *   emails: {
 *     summoner,
 *     budget: { perHour: 10 },            // or `false`: no limit, still counted
 *     onSummonFailed: (failure) => pager.notify(failure), // never awaited
 *   },
 * }
 * await jobs.summonController("emails").reset({ budget: true });
 * ```
 *
 * The summoners here start nothing — they fail, answer `unavailable`, or say
 * `started` for a unit that never registers — and every controller is the
 * one-shot form (every trigger off, then `check()`), so nothing depends on a
 * child process. Summoning needs a backend another process can reach, so on
 * the memory driver this runs on a temporary SQLite file.
 *
 * The points that are easy to get wrong:
 *
 * - **The hook hears five outcomes**: `failed`, `lost`, `unavailable`,
 *   `budget-exhausted` and `circuit-open`. `circuit-open` is told **once per
 *   opening**, not for each check the open circuit then refuses, and again
 *   only after the circuit has closed (here, by `reset()`) and opened anew.
 *   `budget-exhausted` is told once per budget window.
 * - **It is never awaited.** It runs on a later turn of the event loop than
 *   the check that decided the outcome, so when `check()` returns it has not
 *   even been called; a hook still running holds no check and no `close()`,
 *   and one that throws or rejects is logged once at `warn` and changes
 *   nothing else.
 * - **Its argument is secret-free.** `detail` is the same short code the
 *   `summon` event and `status().last` carry (an error's `code`, an
 *   `unavailable` reason), never the error's message.
 * - **The budget counts in the queue's shared state, not in the policy.**
 *   `budget: false` lifts the limit but the attempts are still counted, so a
 *   limit set later meets them; `status().budget` says `off: true` and has
 *   no `perHour`/`perDay`.
 * - **`reset()` keeps the budget's usage.** Only `reset({ budget: true })`
 *   zeroes the hour's and day's counts — and a limit hit again in the same
 *   window is then told again.
 * - **The windows are UTC clock windows**: `hourResetsAt` is the next UTC
 *   hour and `dayResetsAt` the next UTC midnight, not an hour after the
 *   first attempt. So a count read back starts over when an hour turns: the
 *   budget steps here first make sure at least 30 s of the hour are left.
 */
import type {
  SummonCheckResult,
  SummonEventPayload,
  SummonFailure,
  SummonRequest,
  SummonStatus,
} from "@kingsleyweb/bun-jobs";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { BunJobs, defineSummoner } from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { withinOneHour } from "../shared/budget-window";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("When summoning goes wrong: onSummonFailed and the budget");

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The library's default hourly limit, which a policy without `budget` gets. */
const DEFAULT_PER_HOUR = 30;
/** The library's default daily limit. */
const DEFAULT_PER_DAY = 300;

/**
 * How much of the current UTC hour steps 5 to 9 need left. They spend the
 * budget and then check what it decided — a check skipped as `budget`, the
 * hour's count in `status()` and in the hook — and if an hour turned in
 * between, the count would start over and a correct controller would look
 * broken. Those steps took at most 2.4 s, measured on a 16-core machine at a
 * load of 47; 30 s is more than ten times that.
 */
const HOUR_NEEDED = 30_000;

/**
 * Every trigger off, no cooldown, a 1 ms backoff: every check is one the tour
 * asked for, and a failure holds back only the next millisecond.
 */
const ONE_SHOT = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  backoff: { initial: 1, max: 1 },
} as const;
/** A circuit that never opens in this tour, for queues about something else. */
const NO_CIRCUIT = { circuit: { failures: 1_000 } } as const;
/** `charges`' circuit: two consecutive failures open it for a minute. */
const CIRCUIT = { failures: 2, resetAfter: 60_000 } as const;
/** `thumbnails`' boot budget, in ms: how long a started unit has to register. */
const BOOT_BUDGET = 50;

const config = crossProcessDriver();
const namespace = exampleNamespace("summon-failures");
// The controllers log every failed call, a SQLite file's one-host warning and
// each hook that throws; collected, so the tour can check the last.
const { logger, events: logged } = createTestLogger();

/* ------------------------------------------------------------------ */
// The summoners. None starts anything.

/** When each summoner call was made, epoch ms, by queue. */
const calls = new Map<string, number[]>();
/** Records a call for `request`'s queue. */
function called(request: SummonRequest): void {
  calls.set(request.queue, [...(calls.get(request.queue) ?? []), Date.now()]);
}
/** How many times `queue`'s summoner was called. */
const callsTo = (queue: string): number => calls.get(queue)?.length ?? 0;

/**
 * A platform that refuses: its error carries a code, and a message with a
 * token in it, as a real SDK's sometimes does.
 */
const refusing = defineSummoner({
  kind: "example-refuse",
  invoke: async (request: SummonRequest) => {
    called(request);
    throw Object.assign(new Error("token=sk_live_example refused"), {
      code: "E_REFUSED",
    });
  },
});

/** A platform with no room: every call answers `unavailable`. */
function noRoom(kind: string, reason: string) {
  return defineSummoner({
    kind,
    invoke: async (request: SummonRequest) => {
      called(request);
      return { status: "unavailable", reason };
    },
  });
}

/** A platform that takes the request, but whose unit never registers. */
const neverRegisters = defineSummoner({
  kind: "example-vanish",
  bootBudget: BOOT_BUDGET,
  invoke: async (request: SummonRequest) => {
    called(request);
    return { status: "started", handles: [] };
  },
});

/* ------------------------------------------------------------------ */
// The hooks.

/** Everything the recording hooks were told, in order. */
const told: SummonFailure[] = [];
/** What `queue`'s hook was told. */
const toldFor = (queue: string): SummonFailure[] =>
  told.filter((failure) => failure.queue === queue);
/** A hook that records what it is told. */
const record = (failure: SummonFailure): void => {
  told.push(failure);
};

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

/**
 * A failure as checked: `at` replaced by whether it fell between `from` and
 * `to`, the times either side of the check that decided it.
 */
function timed(
  failure: SummonFailure | undefined,
  from: number,
  to: number,
): Omit<SummonFailure, "at"> & { at: boolean } {
  const { at, ...rest } = failure ?? ({ at: Number.NaN } as SummonFailure);
  return { ...rest, at: at >= from && at <= to };
}

/** The hook of `slow`: it takes as long as the tour says, by a gate. */
const gate = Promise.withResolvers<void>();
/** How many times `slow`'s hook was called, and how many of those finished. */
const slowHook = { called: 0, finished: 0 };

const jobs = new BunJobs({
  namespace,
  driver: config,
  logger,
  summon: {
    charges: {
      ...ONE_SHOT,
      summoner: refusing,
      circuit: CIRCUIT,
      onSummonFailed: record,
    },
    exports: {
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: noRoom("example-full", "no capacity"),
      onSummonFailed: record,
    },
    thumbnails: {
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: neverRegisters,
      onSummonFailed: record,
    },
    reports: {
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: noRoom("example-busy", "busy"),
      budget: { perHour: 1, perDay: 10 },
      onSummonFailed: record,
    },
    uploads: {
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: noRoom("example-busy", "busy"),
      budget: false,
      onSummonFailed: record,
    },
    slow: {
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: noRoom("example-busy", "busy"),
      onSummonFailed: async () => {
        slowHook.called++;
        await gate.promise;
        slowHook.finished++;
      },
    },
    brittle: {
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: noRoom("example-busy", "busy"),
      onSummonFailed: () => {
        throw new Error("the pager is down");
      },
    },
    sulky: {
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: noRoom("example-busy", "busy"),
      onSummonFailed: async () => {
        await Bun.sleep(1);
        throw new Error("the pager said no");
      },
    },
  },
});

for (const queue of [
  "charges",
  "exports",
  "thumbnails",
  "reports",
  "uploads",
  "slow",
  "brittle",
  "sulky",
]) {
  await jobs.queue(queue).add("work", { queue });
}

/** The 1 ms backoff passed, then one check. */
async function again(queue: string): Promise<SummonCheckResult> {
  await Bun.sleep(5);
  return await jobs.summonController(queue).check();
}

/* ------------------------------------------------------------------ */
step("1. failed: a call that threw, told with the attempt's id and a code");

let from = Date.now();
const firstCharge = await jobs.summonController("charges").check();
let to = Date.now();
await hooksRan();
show("charges' check", said(firstCharge));
show("told", toldFor("charges"));
checkEqual(
  "the hook is told once: failed, the summoner's kind, the queue, the attempt, why the check ran and the error's code",
  toldFor("charges").map((failure) => timed(failure, from, to)),
  [
    {
      outcome: "failed",
      kind: "example-refuse",
      namespace,
      queue: "charges",
      id: firstCharge.action === "summoned" ? firstCharge.id : "(no attempt)",
      reason: "manual",
      detail: "E_REFUSED",
      at: true,
    },
  ],
);
checkEqual(
  "the detail is the summon event's and status().last's; the error's message, with its token, is not passed on",
  [
    (await jobs.summonController("charges").status()).last?.detail,
    JSON.stringify(toldFor("charges")).includes("sk_live"),
  ],
  ["E_REFUSED", false],
);

/* ------------------------------------------------------------------ */
step("2. circuit-open: once per opening, not for each check it refuses");

from = Date.now();
const secondCharge = await again("charges");
to = Date.now();
const refused = [
  said(await again("charges")),
  said(await again("charges")),
  said(await again("charges")),
];
await hooksRan();
const charges = await jobs.summonController("charges").status();
show("the second check, then three more", [said(secondCharge), ...refused]);
show("told", toldFor("charges").slice(1));
checkEqual(
  `the second failure opens the circuit (failures: ${CIRCUIT.failures}); the three checks after it are refused`,
  [said(secondCharge), ...refused],
  [
    "failed",
    "skipped circuit-open",
    "skipped circuit-open",
    "skipped circuit-open",
  ],
);
checkEqual(
  "the hook is told failed, then circuit-open once — nothing for the three refused checks",
  toldFor("charges").map((failure) => failure.outcome),
  ["failed", "failed", "circuit-open"],
);
checkEqual(
  "circuit-open names the attempt whose failure opened it, that failure's detail, and until: the status's circuitOpenUntil",
  timed(toldFor("charges")[2], from, to),
  {
    outcome: "circuit-open",
    kind: "example-refuse",
    namespace,
    queue: "charges",
    id: secondCharge.action === "summoned" ? secondCharge.id : "(no attempt)",
    detail: "E_REFUSED",
    at: true,
    until: charges.circuitOpenUntil,
  },
);
checkEqual(
  `until is resetAfter (${CIRCUIT.resetAfter} ms) after the opening`,
  (toldFor("charges")[2]?.until ?? 0) - (toldFor("charges")[2]?.at ?? 0),
  CIRCUIT.resetAfter,
);

// A reset closes the circuit; two more failures open it again: a new opening.
await jobs.summonController("charges").reset();
await again("charges");
await again("charges");
await again("charges");
await hooksRan();
checkEqual(
  "after reset(), the next two failures open it anew, and the hook is told a second circuit-open",
  toldFor("charges").map((failure) => failure.outcome),
  ["failed", "failed", "circuit-open", "failed", "failed", "circuit-open"],
);

/* ------------------------------------------------------------------ */
step("3. unavailable: the platform had no room");

from = Date.now();
const exportsCheck = await jobs.summonController("exports").check();
to = Date.now();
await hooksRan();
show("told", toldFor("exports"));
checkEqual(
  "told unavailable, with the platform's reason as the detail",
  toldFor("exports").map((failure) => timed(failure, from, to)),
  [
    {
      outcome: "unavailable",
      kind: "example-full",
      namespace,
      queue: "exports",
      id: exportsCheck.action === "summoned" ? exportsCheck.id : "(no attempt)",
      reason: "manual",
      detail: "no capacity",
      at: true,
    },
  ],
);

/* ------------------------------------------------------------------ */
step("4. lost: a unit that never registered within its boot budget");

const started = await jobs.summonController("thumbnails").check();
await hooksRan();
checkEqual(
  "the call itself answered started: nothing to tell yet",
  [said(started), toldFor("thumbnails")],
  ["started", []],
);
// The attempt is on its way until its boot budget passes; the first check
// after that declares it lost.
await Bun.sleep(BOOT_BUDGET * 2);
from = Date.now();
await jobs.summonController("thumbnails").check();
to = Date.now();
await waitFor(
  "the hook to hear of the loss",
  () => toldFor("thumbnails").length > 0,
);
show("told", toldFor("thumbnails"));
checkEqual(
  "told lost, by the check that declared it: the started attempt's id, and no reason or detail (the unit simply never came)",
  toldFor("thumbnails").map((failure) => timed(failure, from, to)),
  [
    {
      outcome: "lost",
      kind: "example-vanish",
      namespace,
      queue: "thumbnails",
      id: started.action === "summoned" ? started.id : "(no attempt)",
      at: true,
    },
  ],
);

/* ------------------------------------------------------------------ */
step("5. budget-exhausted: perHour: 1, spent by the first call");

await withinOneHour(HOUR_NEEDED);

/** The `summon` events `reports`' controller emitted. */
const reportEvents: SummonEventPayload[] = [];
jobs
  .summonController("reports")
  .on("summon", (event) => reportEvents.push(event));

const spent = await jobs.summonController("reports").check();
from = Date.now();
const overBudget = [said(await again("reports")), said(await again("reports"))];
to = Date.now();
await hooksRan();
const reports = await jobs.summonController("reports").status();
show("three checks", [said(spent), ...overBudget]);
show("told", toldFor("reports"));
checkEqual(
  "the first check calls the summoner (unavailable); the next two are skipped as budget, calling nothing",
  [said(spent), ...overBudget, callsTo("reports")],
  ["unavailable", "skipped budget", "skipped budget", 1],
);
checkEqual(
  "the hook is told budget-exhausted once, for two refused checks: no attempt id, the counts and the limits",
  toldFor("reports")
    .filter((failure) => failure.outcome === "budget-exhausted")
    .map((failure) => timed(failure, from, to)),
  [
    {
      outcome: "budget-exhausted",
      kind: "example-busy",
      namespace,
      queue: "reports",
      at: true,
      budget: { hour: 1, perHour: 1, day: 1, perDay: 10 },
    },
  ],
);
checkEqual(
  "the controller's summon event says the same, once: an empty id, the outcome and the kind",
  reportEvents.filter((event) => event.outcome === "budget-exhausted"),
  [{ id: "", outcome: "budget-exhausted", kind: "example-busy" }],
);
show("status().budget", reports.budget);
checkEqual(
  "status().budget: one attempt this hour and today, against perHour 1 and perDay 10",
  reports.budget,
  {
    hour: 1,
    perHour: 1,
    day: 1,
    perDay: 10,
    hourResetsAt: reports.budget?.hourResetsAt ?? 0,
    dayResetsAt: reports.budget?.dayResetsAt ?? 0,
  },
);

/* ------------------------------------------------------------------ */
step("6. reset() keeps the budget's usage; reset({ budget: true }) clears it");

await jobs.summonController("reports").reset();
const keptUsage = (await jobs.summonController("reports").status()).budget;
const stillOver = said(await again("reports"));
checkEqual(
  "after a plain reset(): still one attempt counted, and the next check is still skipped as budget",
  [keptUsage?.hour, keptUsage?.day, stillOver, callsTo("reports")],
  [1, 1, "skipped budget", 1],
);

await jobs.summonController("reports").reset({ budget: true });
const cleared = (await jobs.summonController("reports").status()).budget;
const afterClear = said(await again("reports"));
const overAgain = said(await again("reports"));
await hooksRan();
checkEqual(
  "after reset({ budget: true }): the counts are 0, the next check calls the summoner, and the one after is over the limit again",
  [cleared?.hour, cleared?.day, afterClear, overAgain, callsTo("reports")],
  [0, 0, "unavailable", "skipped budget", 2],
);
checkEqual(
  "the limit hit again in the same window is news again: the hook is told a second budget-exhausted",
  toldFor("reports")
    .filter((failure) => failure.outcome === "budget-exhausted")
    .map((failure) => failure.budget),
  [
    { hour: 1, perHour: 1, day: 1, perDay: 10 },
    { hour: 1, perHour: 1, day: 1, perDay: 10 },
  ],
);

/* ------------------------------------------------------------------ */
step("7. The hook is never awaited");

// `slow`'s hook waits on a gate the tour opens only at the very end.
const slowFirst = await jobs.summonController("slow").check();
checkEqual(
  "when check() returns, the hook has not even been called: it runs on a later turn of the event loop",
  [said(slowFirst), slowHook.called],
  ["unavailable", 0],
);
await hooksRan();
const slowSecond = await again("slow");
await hooksRan();
checkEqual(
  "the first call is still running, and the next check went ahead regardless: a second call, neither finished",
  [said(slowSecond), slowHook.called, slowHook.finished, callsTo("slow")],
  ["unavailable", 2, 0, 2],
);

/** The warns the controllers logged about a hook. */
const hookWarns = () =>
  logged
    .filter(
      (event) =>
        event.level === "warn" && event.message.includes("onSummonFailed"),
    )
    .map((event) => ({
      message: event.message,
      error: event.error?.message,
      outcome: event.fields?.outcome,
    }));

const brittle = [
  said(await jobs.summonController("brittle").check()),
  said(await again("brittle")),
];
const sulky = [
  said(await jobs.summonController("sulky").check()),
  said(await again("sulky")),
];
await waitFor("four warns about the hooks", () => hookWarns().length >= 4);
// A turn more, so a second warn for one call would have had time to arrive.
await Bun.sleep(20);
show("the warns", hookWarns());
checkEqual(
  "a hook that throws and one that rejects break nothing: every check called the summoner as usual",
  [brittle, sulky, callsTo("brittle"), callsTo("sulky")],
  [["unavailable", "unavailable"], ["unavailable", "unavailable"], 2, 2],
);
checkEqual(
  "each throw and each rejection is logged once, at warn, with the error and the outcome",
  hookWarns().sort((a, b) => (a.error ?? "").localeCompare(b.error ?? "")),
  [
    ...Array.from({ length: 2 }, () => ({
      message: "onSummonFailed threw; summoning goes on",
      error: "the pager is down",
      outcome: "unavailable",
    })),
    ...Array.from({ length: 2 }, () => ({
      message: "onSummonFailed threw; summoning goes on",
      error: "the pager said no",
      outcome: "unavailable",
    })),
  ],
);

/* ------------------------------------------------------------------ */
step("8. budget: false: no limit, but every attempt still counted");

/** `uploads`' summon events: a budget-exhausted one must never be among them. */
const uploadEvents: SummonEventPayload[] = [];
jobs
  .summonController("uploads")
  .on("summon", (event) => uploadEvents.push(event));

// One more check than the default hourly limit allows.
const uploadChecks: string[] = [];
for (let i = 0; i <= DEFAULT_PER_HOUR; i++) {
  uploadChecks.push(said(await again("uploads")));
}
await hooksRan();
const uploads = await jobs.summonController("uploads").status();
show(`${uploadChecks.length} checks`, [...new Set(uploadChecks)]);
checkEqual(
  `${DEFAULT_PER_HOUR + 1} checks in a row, past the default ${DEFAULT_PER_HOUR} an hour: each called the summoner`,
  [uploadChecks.every((one) => one === "unavailable"), callsTo("uploads")],
  [true, DEFAULT_PER_HOUR + 1],
);
checkEqual(
  "no budget-exhausted: neither the hook nor the summon event",
  [
    toldFor("uploads").filter((one) => one.outcome === "budget-exhausted"),
    uploadEvents.filter((one) => one.outcome === "budget-exhausted"),
  ],
  [[], []],
);
/** How many of `queue`'s calls fall in the window that ends at `end`. */
const callsInWindow = (queue: string, end: number, size: number): number =>
  (calls.get(queue) ?? []).filter((at) => at >= end - size).length;
show("status().budget", uploads.budget);
checkEqual(
  "status().budget counts every call this hour and today, says off: true, and has no perHour or perDay",
  uploads.budget,
  {
    hour: callsInWindow("uploads", uploads.budget?.hourResetsAt ?? 0, HOUR),
    day: callsInWindow("uploads", uploads.budget?.dayResetsAt ?? 0, DAY),
    off: true,
    hourResetsAt: uploads.budget?.hourResetsAt ?? 0,
    dayResetsAt: uploads.budget?.dayResetsAt ?? 0,
  },
);
check(
  "the limits are absent, not undefined-valued",
  uploads.budget !== undefined &&
    !("perHour" in uploads.budget) &&
    !("perDay" in uploads.budget),
  uploads.budget,
);

// The counts live in the queue's shared state: a controller with the
// defaults, on the same queue, meets the counts made while the budget was off.
const later = new BunJobs({
  namespace,
  driver: config,
  logger,
  summon: {
    uploads: {
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: noRoom("example-busy", "busy"),
    },
  },
});
await Bun.sleep(5);
const withDefaults = await later.summonController("uploads").check();
const laterBudget = (await later.summonController("uploads").status()).budget;
checkEqual(
  "a controller with the default limits, on the same queue, meets those counts: skipped as budget, calling nothing",
  [said(withDefaults), laterBudget?.perHour, callsTo("uploads")],
  ["skipped budget", DEFAULT_PER_HOUR, DEFAULT_PER_HOUR + 1],
);
await later.close();

/* ------------------------------------------------------------------ */
step("9. budget: false in the array form: an override turns it off, or on");

const groups = new BunJobs({
  namespace: exampleNamespace("summon-failures-groups"),
  driver: config,
  logger,
  summon: [
    {
      queues: ["emails", "sms"],
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: noRoom("example-busy", "busy"),
      budget: { perHour: 1 },
      overrides: { sms: { budget: false } },
    },
    {
      queues: ["audit", "billing"],
      ...ONE_SHOT,
      ...NO_CIRCUIT,
      summoner: noRoom("example-busy", "busy"),
      budget: false,
      overrides: { billing: { budget: { perHour: 2 } } },
    },
  ],
});

/** A queue's budget limits and `off`, as its controller reads them back. */
async function limits(queue: string) {
  const budget: SummonStatus["budget"] = (
    await groups.summonController(queue).status()
  ).budget;
  return { perHour: budget?.perHour, perDay: budget?.perDay, off: budget?.off };
}
const groupQueues = ["emails", "sms", "audit", "billing"];
checkEqual(
  "a budget: false override turns the group's budget off; a budget object over the group's false turns it on, the defaults for the rest",
  await Promise.all(groupQueues.map(limits)),
  [
    { perHour: 1, perDay: DEFAULT_PER_DAY, off: undefined },
    { perHour: undefined, perDay: undefined, off: true },
    { perHour: undefined, perDay: undefined, off: true },
    { perHour: 2, perDay: DEFAULT_PER_DAY, off: undefined },
  ],
);

const groupChecks: Record<string, string[]> = {};
for (const queue of groupQueues) {
  await groups.queue(queue).add("work", { queue });
  const controller = groups.summonController(queue);
  groupChecks[queue] = [];
  for (let i = 0; i < 3; i++) {
    await Bun.sleep(5);
    groupChecks[queue].push(said(await controller.check()));
  }
}
show("three checks on each", groupChecks);
checkEqual(
  "and they behave so: emails stops after one, billing after two, sms and audit never",
  groupChecks,
  {
    emails: ["unavailable", "skipped budget", "skipped budget"],
    sms: ["unavailable", "unavailable", "unavailable"],
    audit: ["unavailable", "unavailable", "unavailable"],
    billing: ["unavailable", "unavailable", "skipped budget"],
  },
);
await groups.purge();
await groups.close();

/* ------------------------------------------------------------------ */
step("10. When the budget's windows reset: the next UTC hour and midnight");

/** The end of the UTC window of `size` ms that holds `at`. */
const windowEnd = (at: number, size: number): number =>
  Math.floor(at / size) * size + size;

const readFrom = Date.now();
const windows = (await jobs.summonController("exports").status()).budget;
const readTo = Date.now();
show("windows", {
  hourResetsAt: new Date(windows?.hourResetsAt ?? 0).toISOString(),
  dayResetsAt: new Date(windows?.dayResetsAt ?? 0).toISOString(),
});
// A read that straddles a boundary may see either side of it: both ends of
// the read are allowed, but the two values must come from one of them.
checkEqual(
  "hourResetsAt is the next UTC hour, and dayResetsAt the next UTC midnight, after the read",
  [readFrom, readTo].some(
    (at) =>
      windows?.hourResetsAt === windowEnd(at, HOUR) &&
      windows?.dayResetsAt === windowEnd(at, DAY),
  ),
  true,
);

/* ------------------------------------------------------------------ */
step("Clean up");

await jobs.purge();
await jobs.close();
// close() did not wait for `slow`'s hook, which is still waiting on its gate.
checkEqual(
  "close() returned while slow's hook was still running",
  [slowHook.called, slowHook.finished],
  [2, 0],
);
gate.resolve();
await waitFor("slow's hook to finish", () => slowHook.finished === 2);
summary();
