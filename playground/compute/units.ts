import type { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type {
  BunJobs,
  SummonController,
  Summoner,
  SummonFailure,
  SummonListDto,
  SummonListItemDto,
} from "@kingsleyweb/bun-jobs";
import type {
  ProviderCallContext,
  SummonFacet,
  SummonRequest,
  SummonResult,
  UnitStatus,
} from "@kingsleyweb/bun-jobs/provider";
import { noopLogger } from "@kingsleyweb/bun-common";
import { ConfigError } from "@kingsleyweb/bun-jobs";

/**
 * The playground's view of the units the library's `localCompute()` starts,
 * and the faults it can inject into them, **per queue**.
 *
 * `localCompute()` is the real thing: each unit is a child process it spawns,
 * in a process group (and, with `PLAYGROUND_CGROUP`, a cgroup) of its own.
 * The playground does not reimplement any of that. It only wraps each
 * configured instance's summon facet — a spread of a configured provider
 * keeps its brand and its registry entry, so the Providers screen and the
 * Summon panel still name it — to do three things on the way through:
 *
 * - **Record** every unit started, with the queue it was summoned for, so
 *   the control page (`/playground/compute`) can list them with the
 *   provider's own `status()`: running, exited with a code, or failed with
 *   its last stderr line or `max-lifetime`.
 * - **Inject a fault into the next start for one queue**, by adding
 *   `LOCAL_COMPUTE_FAULT=<kind>` to that start's environment, so it reaches
 *   every unit the start asks for. The unit's entry (`worker.ts`,
 *   `obinna-queue-worker.ts`, `shared-unit.ts`) reads it. A fault is spent
 *   only by a start that happens; one that answered `unavailable` leaves it
 *   queued. A shared unit's start is `request.queue`'s, its first queue, so
 *   its faults are queued there (`ingest`).
 * - **Stop every unit and await its exit** when the playground stops, through
 *   the facet's own `cancel()`, which resolves on the real exit (after the
 *   stop signal, and `SIGKILL` once the grace has passed).
 *
 * The queues of the vault provider (`provider.ts`) also take the **provider
 * faults** — answers a remote platform gives and a local one never does —
 * which that provider raises itself before it reaches `localCompute()`.
 *
 * Once {@link UnitBoard.attach} has handed it the context and the API's
 * `GET /summon` URL, the page also shows every summoning queue's status (that
 * route, fetched over loopback), the last failures the policies'
 * `onSummonFailed` hooks reported ({@link UnitBoard.alert}), and a button
 * that clears one queue's budget usage through the library's
 * `summonController(queue).reset({ budget: true })`.
 */

/** Faults injected into a unit, through its environment (`LOCAL_COMPUTE_FAULT`). */
export type UnitFault =
  "crash" | "die" | "slow-boot" | "ignore-stop" | "forget-queue";

/** Faults the vault provider answers with, before any unit starts. */
export type ProviderFault = "throttled" | "quota" | "auth" | "transient";

/** Any fault the control page queues. */
export type Fault = UnitFault | ProviderFault;

/** Every unit fault, with what it does, for the control page and the 400 answer. */
export const UNIT_FAULTS: Readonly<Record<UnitFault, string>> = {
  crash:
    "the unit exits 1 before its worker reports: the attempt is lost after the boot budget, with the unit's last stderr line as the detail",
  die: "the unit SIGKILLs itself after its first job: registered, then lost, detail SIGKILL (exit 137); the next worker finishes the queue",
  "slow-boot":
    "the unit sleeps 25 s before building its worker, past the 15 s boot budget: the attempt is lost, then the worker registers late and drains the queue anyway",
  "ignore-stop":
    "the unit ignores SIGTERM and its own deadline: at the policy's maxLifetime localCompute sends the stop signal, then SIGKILL after the grace (exit 137, detail max-lifetime). Use it on marathon, which never goes idle",
  "forget-queue":
    "a shared unit's entry builds its last queue's worker without summon, as a script that forgot a queue would: the unit registers on the others only, so the attempt is registered with detail partial:<queue> and missing [<queue>], and counts one failure",
};

/** Every provider fault, with what the vault provider answers. */
export const PROVIDER_FAULTS: Readonly<Record<ProviderFault, string>> = {
  throttled:
    "ProviderError throttled, retryAfter 8 s: unavailable, not counted; backoff 8 s",
  quota: "ProviderError quota, retryAfter 20 s: counted; backoff 20 s",
  auth: "ProviderError auth: the circuit opens at once (Reset closes it)",
  transient: "ProviderError transient: failed, counted, backoff",
};

/** Every unit fault, in the order the control page lists them. */
export const ALL_UNIT_FAULTS: readonly UnitFault[] = [
  "crash",
  "die",
  "slow-boot",
  "ignore-stop",
  "forget-queue",
];

/** Every provider fault, in the order the control page lists them. */
export const ALL_PROVIDER_FAULTS: readonly ProviderFault[] = [
  "throttled",
  "quota",
  "auth",
  "transient",
];

/** Whether `kind` names a unit fault: an own key, so `toString` and `__proto__` are not. */
export function isUnitFault(kind: string): kind is UnitFault {
  return Object.hasOwn(UNIT_FAULTS, kind);
}

/** Whether `kind` names a provider fault: an own key, so `toString` and `__proto__` are not. */
export function isProviderFault(kind: string): kind is ProviderFault {
  return Object.hasOwn(PROVIDER_FAULTS, kind);
}

/** What a fault does, for the page and the 400 answers. */
function faultText(kind: Fault): string {
  return isUnitFault(kind) ? UNIT_FAULTS[kind] : PROVIDER_FAULTS[kind];
}

/** The most faults one queue may have queued at once: a POST past it is refused. */
export const MAX_QUEUED_PER_QUEUE = 3;

/** One unit the playground saw started. */
interface UnitRecord {
  /** Which configured instance started it: the facet that answers its `status()`. */
  pool: string;
  /** The queue it was summoned for: for a shared unit, the first of {@link queues}. */
  queue: string;
  /** Every queue a shared unit was summoned for (`request.queues`); absent for one queue. */
  queues?: readonly string[];
  /** Its handle, as `localCompute()` answered it. */
  handle: string;
  /** The fault it was started with, if any. */
  fault?: string;
  /** When it was started, epoch ms. */
  startedAt: number;
}

/** A unit as the control page shows it: the record and the provider's status. */
export interface UnitView extends UnitStatus {
  /** The instance that started it. */
  pool: string;
  /** The queue it was summoned for: for a shared unit, the first of {@link queues}. */
  queue: string;
  /** Every queue a shared unit was summoned for; absent for one queue. */
  queues?: readonly string[];
  /** The fault it was started with, if any. */
  fault?: string;
  /** When it was started, ISO. */
  startedAt: string;
}

/**
 * The unit records kept past which the oldest **exited** ones are dropped,
 * once a status read has said they exited. A running unit's record is never
 * dropped: it is what {@link UnitBoard.stop} stops.
 */
const KEEP = 200;

/** How many `onSummonFailed` reports the page keeps: the newest. */
const KEEP_ALERTS = 30;

/** `GET /summon` as the page shows it: the list, or why it could not be read. */
export type SummonListView = SummonListDto | { error: string };

/** The queue the page's budget-reset button clears. */
const RESET_EXAMPLE_QUEUE = "transcodes";

/** An epoch-ms instant as ISO text, or `""` when absent. */
function iso(at: number | undefined): string {
  return at === undefined ? "" : new Date(at).toISOString();
}

/** A budget's usage for a table cell: `hour/perHour, day/perDay`, or `off` with the counts. */
function budgetText(
  budget:
    | {
        hour: number;
        perHour?: number;
        day: number;
        perDay?: number;
        off?: true;
      }
    | undefined,
): string {
  if (budget === undefined) {
    return "";
  }
  if (budget.off === true) {
    return `off (hour ${budget.hour}, day ${budget.day})`;
  }
  return `${budget.hour}/${budget.perHour ?? "?"} hour, ${budget.day}/${budget.perDay ?? "?"} day`;
}

/** A call context for the board's own facet calls (status, cancel), bounded by `ms`. */
function callContext(ms: number): ProviderCallContext {
  return {
    signal: AbortSignal.timeout(ms),
    logger: noopLogger,
    fetch: globalThis.fetch,
    now: Date.now,
  };
}

/** Escapes text for HTML. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The units of every instrumented instance, the fault queue, and the control routes. */
export class UnitBoard {
  /** Where the control page and its routes are mounted. */
  readonly basePath = "/playground/compute";
  /** Queued faults, by queue, spent in order. */
  readonly #faults = new Map<string, Fault[]>();
  /** Every unit seen started, oldest first. */
  readonly #units: UnitRecord[] = [];
  /** The raw facet of each instrumented instance, by pool name: what answers `status()` and `cancel()`. */
  readonly #facets = new Map<string, SummonFacet>();
  /** The queues summoned for, each with the faults its units (or provider) act on. */
  readonly #queues = new Map<string, readonly Fault[]>();
  /** Set by {@link stop}: from then on no start goes through. */
  #stopping = false;
  /** The last {@link KEEP_ALERTS} failures the `onSummonFailed` hooks reported, oldest first. */
  readonly #alerts: SummonFailure[] = [];
  /** The context whose summon controllers the budget reset reaches; set by {@link attach}. */
  #jobs: BunJobs | undefined;
  /** The management API's `GET /summon` URL, read over loopback; set by {@link attach}. */
  #summonList: string | undefined;
  /** Every queue the `summon` option names: the ones a reset may ask about. */
  #summoned: readonly string[] = [];

  constructor(
    /**
     * Called after every start that started a unit, once the unit is
     * spawned: the playground records the new units' pids there
     * (`leftovers.ts`), so a later run can stop them if this one is killed.
     */
    readonly onStarted: () => void = () => {},
  ) {}

  /**
   * Names a queue the board accepts faults for, and which: only the faults
   * its units' entry acts on (`obinna-queue-worker.ts` knows `crash` and
   * `die` alone), plus the provider faults where the vault provider
   * summons. Any other is refused, naming these.
   */
  addQueue(queue: string, faults: readonly Fault[]): void {
    this.#queues.set(queue, [...faults]);
  }

  /** Queues a fault for the next start for `queue`, or says why not (the 400's text). */
  inject(queue: string, kind: string): string | undefined {
    const allowed = this.#queues.get(queue);
    if (allowed === undefined) {
      return `queue must be one of ${[...this.#queues.keys()].join(", ")}`;
    }
    if (!isUnitFault(kind) && !isProviderFault(kind)) {
      return `kind must be one of ${[...ALL_UNIT_FAULTS, ...ALL_PROVIDER_FAULTS].join(", ")}`;
    }
    if (!allowed.includes(kind)) {
      const why = isProviderFault(kind)
        ? `${kind} is a provider fault, which localCompute never answers`
        : `${queue}'s units do not act on ${kind}`;
      return `${why}: ${queue} takes ${allowed.join(", ")}`;
    }
    const queued = this.#faults.get(queue)?.length ?? 0;
    if (queued >= MAX_QUEUED_PER_QUEUE) {
      return `${queue} already has ${queued} faults queued, the most it takes: wait for a start to spend one, or clear them`;
    }
    this.#push(queue, kind);
    return undefined;
  }

  /** Every queued fault, by queue. */
  pending(): Record<string, readonly Fault[]> {
    return Object.fromEntries(
      [...this.#faults].filter(([, faults]) => faults.length > 0),
    );
  }

  /** Whether `queue` has a fault queued. */
  hasPending(queue: string): boolean {
    return (this.#faults.get(queue)?.length ?? 0) > 0;
  }

  /** Forgets every queued fault. */
  clear(): void {
    this.#faults.clear();
  }

  /** Appends a fault to a queue's list. */
  #push(queue: string, fault: Fault): void {
    const list = this.#faults.get(queue) ?? [];
    list.push(fault);
    this.#faults.set(queue, list);
  }

  /**
   * Takes the next queued fault for `queue` when it is one of `kinds`; a
   * fault of another kind stays first in line.
   */
  take<K extends Fault>(
    queue: string,
    kinds: Readonly<Record<K, string>>,
  ): K | undefined {
    const list = this.#faults.get(queue);
    const next = list?.[0];
    if (next === undefined || !Object.hasOwn(kinds, next)) {
      return undefined;
    }
    list!.shift();
    return next as K;
  }

  /** Puts a fault back at the front of its queue's list: its start did not happen. */
  #putBack(queue: string, fault: Fault): void {
    this.#faults.set(queue, [fault, ...(this.#faults.get(queue) ?? [])]);
  }

  /**
   * A spread of a configured `localCompute()` instance with its summon facet
   * wrapped: the same provider (the spread keeps its brand, its `validate`,
   * and so its registry id on the Providers screen), whose starts are
   * recorded under `pool` and take the queue's next unit fault.
   */
  instrument<T extends Summoner>(instance: T, pool: string): T {
    const facet = instance.summon;
    this.#facets.set(pool, facet);
    const summon = async (
      request: SummonRequest,
      context: ProviderCallContext,
    ): Promise<SummonResult> => {
      if (this.#stopping) {
        return { status: "unavailable", reason: "the playground is stopping" };
      }
      const queued = this.take(request.queue, UNIT_FAULTS);
      const env =
        queued === undefined
          ? request.env
          : { ...request.env, LOCAL_COMPUTE_FAULT: queued };
      let result: SummonResult;
      try {
        result = await facet.summon({ ...request, env }, context);
      } catch (error) {
        if (queued !== undefined) {
          this.#putBack(request.queue, queued);
        }
        throw error;
      }
      if (result.status === "started") {
        this.onStarted();
        for (const handle of result.handles) {
          this.#record({
            pool,
            queue: request.queue,
            // A shared unit's queues, for the page: its faults go by the
            // first (`request.queue`), which is where they are queued.
            ...(request.queues === undefined || request.queues.length < 2
              ? {}
              : { queues: [...request.queues] }),
            handle,
            // A fault from the policy's own env (brittle's override) shows too.
            ...(env.LOCAL_COMPUTE_FAULT === undefined
              ? {}
              : { fault: env.LOCAL_COMPUTE_FAULT }),
            startedAt: Date.now(),
          });
        }
      } else if (queued !== undefined) {
        this.#putBack(request.queue, queued);
      }
      return result;
    };
    // A plain object, not a spread of the facet: its `capabilities` may be a
    // getter on a provider whose config validates asynchronously.
    const wrapped: SummonFacet = {
      get capabilities() {
        return facet.capabilities;
      },
      summon,
      ...(facet.status === undefined
        ? {}
        : { status: facet.status.bind(facet) }),
      ...(facet.cancel === undefined
        ? {}
        : { cancel: facet.cancel.bind(facet) }),
    };
    return { ...instance, summon: wrapped };
  }

  /** Records a started unit. Old records go in {@link #prune}. */
  #record(unit: UnitRecord): void {
    this.#units.push(unit);
  }

  /**
   * Past {@link KEEP} records, drops the oldest whose unit a status read has
   * just said is no longer running; a running unit's record always stays.
   */
  #prune(statuses: readonly UnitStatus[]): void {
    if (this.#units.length <= KEEP) {
      return;
    }
    const ended = new Set(
      statuses
        .filter((status) => status.state !== "running")
        .map((status) => status.handle),
    );
    let excess = this.#units.length - KEEP;
    for (let index = 0; index < this.#units.length && excess > 0;) {
      if (ended.has(this.#units[index].handle)) {
        this.#units.splice(index, 1);
        excess--;
      } else {
        index++;
      }
    }
  }

  /** Every recorded unit with its provider status, newest first. */
  async snapshot(): Promise<UnitView[]> {
    const views: UnitView[] = [];
    for (const [pool, facet] of this.#facets) {
      const units = this.#units.filter((unit) => unit.pool === pool);
      if (units.length === 0 || facet.status === undefined) {
        continue;
      }
      const statuses = await facet.status(
        units.map((unit) => unit.handle),
        callContext(5_000),
      );
      this.#prune(statuses);
      units.forEach((unit, index) => {
        views.push({
          ...(statuses[index] ?? { handle: unit.handle, state: "unknown" }),
          pool,
          queue: unit.queue,
          ...(unit.queues === undefined ? {} : { queues: unit.queues }),
          ...(unit.fault === undefined ? {} : { fault: unit.fault }),
          startedAt: new Date(unit.startedAt).toISOString(),
        });
      });
    }
    return views.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** The handles of `pool`'s units still running, for `queue` when given. */
  async running(pool: string, queue?: string): Promise<string[]> {
    const facet = this.#facets.get(pool);
    const handles = this.#units
      .filter(
        (unit) =>
          unit.pool === pool && (queue === undefined || unit.queue === queue),
      )
      .map((unit) => unit.handle);
    if (facet?.status === undefined || handles.length === 0) {
      return [];
    }
    const statuses = await facet.status(handles, callContext(5_000));
    this.#prune(statuses);
    return statuses
      .filter((status) => status.state === "running")
      .map((status) => status.handle);
  }

  /** Stops `pool`'s units in `handles` and resolves once each has exited. */
  async cancel(pool: string, handles: readonly string[]): Promise<void> {
    const facet = this.#facets.get(pool);
    if (facet?.cancel !== undefined && handles.length > 0) {
      await facet.cancel(handles, callContext(30_000));
    }
  }

  /**
   * Refuses every new start, then stops every unit still running and waits
   * for each to exit: the stop signal, then `SIGKILL` after its instance's
   * grace (`localCompute()`'s `cancel()`). Repeats until none is running, in
   * case a start was already inside the provider when this began. Resolves
   * with how many units were still running when it began, each of which has
   * exited by then.
   */
  async stop(): Promise<number> {
    this.#stopping = true;
    let stopped = 0;
    for (let round = 0; round < 5; round++) {
      let any = false;
      for (const pool of this.#facets.keys()) {
        const handles = await this.running(pool);
        if (handles.length > 0) {
          any = true;
          stopped += handles.length;
          await this.cancel(pool, handles);
        }
      }
      if (!any) {
        break;
      }
    }
    return stopped;
  }

  /**
   * Hands the board the context and the API's `GET /summon` URL, for the
   * page's summon status table and its budget reset. Called once the server
   * listens (the URL needs its port), on every driver: on the memory one the
   * list is simply empty.
   */
  attach(
    /** The context whose summon controllers a reset reaches. */
    jobs: BunJobs,
    /** The management API's `GET /summon`, e.g. `http://localhost:4000/jobs-api/summon`. */
    summonList: string,
    /** Every queue the `summon` option names: those a reset is asked about. */
    summoned: readonly string[],
  ): void {
    this.#jobs = jobs;
    this.#summonList = summonList;
    this.#summoned = [...summoned];
  }

  /**
   * An `onSummonFailed` hook: keeps the failure, the newest
   * {@link KEEP_ALERTS} of them, for the page. Synchronous and cheap, as a
   * hook should be (the controller never awaits it anyway).
   */
  alert(failure: SummonFailure): void {
    this.#alerts.push(failure);
    if (this.#alerts.length > KEEP_ALERTS) {
      this.#alerts.splice(0, this.#alerts.length - KEEP_ALERTS);
    }
  }

  /** The kept `onSummonFailed` reports, newest first. */
  alerts(): SummonFailure[] {
    return [...this.#alerts].reverse();
  }

  /**
   * `GET /summon` from the management API, over loopback, as any client would
   * read it; or the fetch's error, which the page shows instead of the table.
   */
  async summonStatus(): Promise<SummonListView> {
    if (this.#summonList === undefined) {
      return { error: "not attached yet: the playground is still starting" };
    }
    try {
      const response = await fetch(this.#summonList, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return {
          error: `GET ${this.#summonList} answered ${response.status}: ${await response.text()}`,
        };
      }
      return (await response.json()) as SummonListDto;
    } catch (error) {
      return {
        error: `GET ${this.#summonList} failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * `queue`'s summon controller when it runs in this context, else
   * `undefined`: `summonController(queue)` without a policy answers an
   * existing one and throws a `ConfigError` for a queue with none here (one
   * hosted by the mailer context, or any queue on the memory driver).
   */
  #localController(queue: string): SummonController | undefined {
    if (this.#jobs === undefined) {
      return undefined;
    }
    try {
      return this.#jobs.summonController(queue);
    } catch (error) {
      if (error instanceof ConfigError) {
        return undefined;
      }
      throw error;
    }
  }

  /** The summoned queues whose controller runs in this context: the ones a reset accepts. */
  localQueues(): string[] {
    return this.#summoned.filter(
      (queue) => this.#localController(queue) !== undefined,
    );
  }

  /**
   * Clears `queue`'s budget usage (`reset({ budget: true })`, which also
   * closes its circuit and clears its failures and backoff), or says why not
   * (the 400's text): only a queue with a controller in this context.
   */
  async resetBudget(queue: string): Promise<string | undefined> {
    const controller = this.#localController(queue);
    if (controller === undefined) {
      const local = this.localQueues();
      return local.length === 0
        ? `${queue === "" ? "a queue" : queue} has no summon controller in this process, and no queue here has one`
        : `queue must be one with a summon controller in this process: ${local.join(", ")}`;
    }
    await controller.reset({ budget: true });
    return undefined;
  }

  /** The summon status section: the table, or the fetch's error. */
  #summonSection(list: SummonListView): string {
    if ("error" in list) {
      return `<p><strong>Could not read it:</strong> ${escapeHtml(list.error)}</p>`;
    }
    const row = (item: SummonListItemDto): string =>
      `<tr><td>${escapeHtml((item.queues ?? [item.queue]).join(", "))}</td><td>${escapeHtml(item.group ?? "")}</td><td>${item.local}</td><td>${escapeHtml(item.kind)}</td><td>${item.readiness ?? ""}</td><td>${item.inert === true ? `yes${item.inertReason === undefined ? "" : ` (${item.inertReason})`}` : ""}</td><td>${escapeHtml(item.last === undefined ? "" : `${item.last.outcome}${item.last.detail === undefined ? "" : `: ${item.last.detail}`}`)}</td><td>${escapeHtml(budgetText(item.budget))}</td><td>${iso(item.circuitOpenUntil)}</td></tr>`;
    return `<table><tr><th>Queues</th><th>Group</th><th>Local</th><th>Kind</th><th>Readiness</th><th>Inert</th><th>Last outcome</th><th>Budget</th><th>Circuit open until</th></tr>
${list.controllers.map(row).join("\n")}
</table>`;
  }

  /** The `onSummonFailed` section's table. */
  #alertsSection(): string {
    const alerts = this.alerts();
    if (alerts.length === 0) {
      return "<p>None yet.</p>";
    }
    const row = (failure: SummonFailure): string =>
      `<tr><td>${iso(failure.at)}</td><td>${escapeHtml((failure.queues ?? [failure.queue]).join(", "))}</td><td>${failure.outcome}</td><td>${escapeHtml(failure.kind)}</td><td>${escapeHtml(failure.detail ?? "")}</td><td>${iso(failure.until)}</td><td>${escapeHtml(failure.budget === undefined ? "" : `${budgetText(failure.budget)}${failure.group === undefined ? "" : ` (group ${failure.group})`}`)}</td></tr>`;
    return `<table><tr><th>At</th><th>Queues</th><th>Outcome</th><th>Kind</th><th>Detail</th><th>Until</th><th>Budget</th></tr>
${alerts.map(row).join("\n")}
</table>`;
  }

  /** The control page. */
  async #page(): Promise<string> {
    const units = await this.snapshot();
    const summon = await this.summonStatus();
    const queues = [...this.#queues];
    const pending = this.pending();
    const form = (queue: string, kind: string, text: string): string =>
      `<form method="post" action="${this.basePath}/faults?kind=${kind}&amp;queue=${encodeURIComponent(queue)}"><button>${kind}</button> <span>${escapeHtml(text)}</span></form>`;
    const sections = queues
      .map(([queue, allowed]) => {
        const kinds = allowed.map((kind): [string, string] => [
          kind,
          faultText(kind),
        ]);
        return `<details><summary><a href="/jobs/queues/${queue}">${queue}</a>${
          pending[queue] === undefined
            ? ""
            : ` — queued: ${pending[queue].join(", ")}`
        }</summary>${kinds.map(([kind, text]) => form(queue, kind, text)).join("\n")}</details>`;
      })
      .join("\n");
    const rows = units
      .slice(0, 80)
      .map(
        (unit) =>
          `<tr><td>${(unit.queues ?? [unit.queue]).join(", ")}</td><td>${unit.pool}</td><td>${unit.handle}</td><td>${unit.state}</td><td>${unit.exitCode ?? ""}</td><td>${unit.fault ?? ""}</td><td>${escapeHtml(unit.detail ?? "")}</td><td>${unit.startedAt}</td></tr>`,
      )
      .join("\n");
    const running = units.filter((unit) => unit.state === "running").length;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Playground compute</title>
<style>
:root{--fg:#1d1d1f;--bg:#fff;--line:#8884}
@media (prefers-color-scheme:dark){:root{--fg:#e6e6e6;--bg:#161616}}
body{font:14px system-ui,sans-serif;margin:16px;max-width:1100px;color:var(--fg);background:var(--bg)}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}td,th{padding:4px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
form{margin:4px 0 4px 16px}button{min-width:110px}span{opacity:.75}details{margin:6px 0}
</style></head><body>
<h1>Playground compute</h1>
<p>The units the library's <code>localCompute()</code> started for the playground's summoned queues:
real <code>bun</code> child processes, each in a process group of its own. Their state is the
provider's own <code>status()</code>. The Summon panels are on each queue's page; the providers on
<a href="/jobs/providers">/jobs/providers</a>.</p>
<h2>Queue a fault for a queue's next start</h2>
<p>Spent by the next unit that actually starts for that queue (a start answered
<code>unavailable</code> leaves it queued). Also: <code>curl -X POST '${this.basePath}/faults?kind=crash&amp;queue=renders'</code>.</p>
${sections}
<form method="post" action="${this.basePath}/faults/clear"><button>clear</button> <span>forget every queued fault</span></form>
<h2>Summon status (<code>GET /jobs-api/summon</code>)</h2>
<p>Every summoning queue the management API can read, in one call, read here over loopback as
any client would. A shared unit is one row for its queues; one hosted by another process reads
<code>local: false</code>, from storage.</p>
${this.#summonSection(summon)}
<form method="post" action="${this.basePath}/summon/reset-budget?queue=${RESET_EXAMPLE_QUEUE}"><button>Clear ${RESET_EXAMPLE_QUEUE}' budget</button> <span><code>jobs.summonController("${RESET_EXAMPLE_QUEUE}").reset({ budget: true })</code>: its hour and day counts go to 0 (and its failures, backoff and circuit clear). Any queue whose controller runs in this process: <code>curl -X POST '${this.basePath}/summon/reset-budget?queue=renders'</code></span></form>
<h2>Summon alerts (<code>onSummonFailed</code>)</h2>
<p>The last ${KEEP_ALERTS} failures the policies' <code>onSummonFailed</code> hook reported, newest first:
<code>failed</code>, <code>lost</code>, <code>unavailable</code>, <code>budget-exhausted</code> and <code>circuit-open</code>.</p>
${this.#alertsSection()}
<h2>Units (${running} running)</h2>
<table><tr><th>Queues</th><th>Pool</th><th>Handle</th><th>State</th><th>Exit</th><th>Fault</th><th>Detail</th><th>Started</th></tr>
${rows}
</table>
</body></html>`;
  }

  /**
   * Mounts the control page and its routes. A form post is redirected back
   * to the page; any other request gets JSON.
   *
   * | Route | What |
   * |---|---|
   * | `GET /playground/compute` | the page |
   * | `GET /playground/compute/state` | `{ faults, units, alerts, summon }` as JSON (`summon`: `GET /jobs-api/summon`'s body, or `{ error }`) |
   * | `POST /playground/compute/faults?kind=&queue=` | queues a fault for that queue's next start |
   * | `POST /playground/compute/faults/clear` | forgets every queued fault |
   * | `POST /playground/compute/summon/reset-budget?queue=` | `reset({ budget: true })` on that queue's controller in this process; 400 naming those queues otherwise |
   *
   * Like the fault routes, the reset takes no CSRF token: the playground
   * listens on 127.0.0.1 only and must never be exposed (`index.ts`).
   */
  mount(app: BunHttpAdapter): void {
    const base = this.basePath;
    const wantsHtml = (accept: string | null | undefined): boolean =>
      (accept ?? "").includes("text/html");
    app.get(base, async (_req, res) => {
      res.type("html").send(await this.#page());
    });
    app.get(`${base}/state`, async (_req, res) => {
      res.json({
        faults: this.pending(),
        units: await this.snapshot(),
        alerts: this.alerts(),
        summon: await this.summonStatus(),
      });
    });
    app.post(`${base}/faults`, (req, res) => {
      const { kind = "", queue = "" } = req.query as {
        kind?: string;
        queue?: string;
      };
      const problem = this.inject(String(queue), String(kind));
      if (problem !== undefined) {
        res.status(400).json({ error: problem });
        return;
      }
      if (wantsHtml(req.get("accept"))) {
        res.redirect(base, 303);
        return;
      }
      res.json({ queued: this.pending() });
    });
    app.post(`${base}/faults/clear`, (req, res) => {
      this.clear();
      if (wantsHtml(req.get("accept"))) {
        res.redirect(base, 303);
        return;
      }
      res.json({ queued: {} });
    });
    app.post(`${base}/summon/reset-budget`, async (req, res) => {
      const { queue = "" } = req.query as { queue?: string };
      const problem = await this.resetBudget(String(queue));
      if (problem !== undefined) {
        res.status(400).json({ error: problem });
        return;
      }
      if (wantsHtml(req.get("accept"))) {
        res.redirect(base, 303);
        return;
      }
      res.json({ reset: String(queue), budget: true });
    });
  }
}
