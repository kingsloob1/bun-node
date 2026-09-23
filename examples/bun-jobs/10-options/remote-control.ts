/**
 * Option tour: controlling workers and runners from another process —
 * `RemoteWorker`, runner configuration overrides — and, at the end, a buried
 * flow retried in either order.
 *
 * ```bash
 * bun 10-options/remote-control.ts
 * EXAMPLE_DRIVER=postgres EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost/jobs \
 *   bun 10-options/remote-control.ts
 * ```
 *
 * "Another process" here is another `BunJobs` context on the same driver and
 * namespace, holding no workers or runners of its own: every call goes
 * through what the backend stores, exactly as it would across processes.
 * `07-runner/remote-control.ts` shows the runner half with a real second
 * process; this tour asserts the rules.
 *
 * The points that are easy to get wrong:
 *
 * - **Lifecycle is addressed by incarnation or by key; configuration by key
 *   alone.** `{ key }` fans out to every live replica, and a config override
 *   reaches one started tomorrow.
 * - **`pause()`/`resume()` refuse a parked worker** with
 *   `WorkerStateConflictError`, writing nothing — for a `{ key }` target, one
 *   parked replica refuses the whole call. `start()` is how it comes back.
 * - **`setConfig()` refuses what a worker could not apply** — an unknown key,
 *   a value out of `WORKER_CONFIG_BOUNDS`, a fraction for a count — with a
 *   `ConfigError`, and nothing is written.
 * - **A stop lasts as long as the worker says.** `stopPersistence: "process"`
 *   (the default) ends with the incarnation, `"key"` outlives it; `persist`
 *   asks for the other one and only an overridable worker honours it.
 * - **A runner's own `updateConfig()` is announced** with a `control` event,
 *   so its other owners adopt it within the driver's event latency rather
 *   than at their next `syncInterval`.
 */
import type {
  BunQueueWorker,
  BunRunnerOptions,
  ConfigError,
  WorkerEventPayloads,
  WorkerStateConflictError,
} from "@kingsleyweb/bun-jobs";
import type { WorkArgs, WorkResult } from "./handlers/runner-work";
import { BunRouter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createDriver,
  createJobsApi,
  describeRunnerConfig,
  EXECUTION_MODES,
  JOBS_API_ACTIONS,
  readWorkerStop,
  RUNNER_CONFIG_BOUNDS,
  RUNNER_CONFIG_KEYS,
  RUNNER_CONFIG_STATE,
  runnerKey,
  UnrecoverableJobError,
  BunQueueWorker as Worker,
  WORKER_CONFIG_BOUNDS,
  WORKER_CONFIG_KEYS,
  writeRunnerConfig,
  writeWorkerStop,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: remote control");

/** Generous ceiling for anything a busy machine or a slow server stretches. */
const WAIT = { timeout: 30_000, interval: 10 };

const config = exampleDriver();
const namespace = exampleNamespace("tour-remote");
const driver = createDriver(config);
await driver.connect();

/** Every context the tour opens, closed at the end. */
const contexts: BunJobs[] = [];

/** A context on the shared backend: one "process". */
function context(service?: string): BunJobs {
  const jobs = new BunJobs({
    namespace,
    driver,
    logger: createTestLogger().logger,
    ...(service === undefined ? {} : { service }),
    // A driver instance cannot cross into a spawned child; its config can.
    runnerDefaults: { childDriver: config },
  });
  contexts.push(jobs);
  return jobs;
}

/**
 * A worker on `mail` in a context of its own. It polls its instructions every
 * 100ms where the driver does not push them, so the tour is quick on every
 * backend; the default is 2 s.
 */
function mailWorker(
  jobs: BunJobs,
  options: Parameters<BunJobs["worker"]>[2] = {},
): BunQueueWorker {
  const worker = jobs.worker<unknown, unknown>("mail", async () => "sent", {
    remoteControl: { interval: 100 },
    ...options,
  });
  void worker.run();
  return worker;
}

/** An admin service: a context with no workers or runners of its own. */
const admin = context();
const mail = admin.workers.remote("mail");

/** Waits until every worker given reports `state`, locally and in its record. */
async function reaches(
  state: BunQueueWorker["state"],
  ...workers: BunQueueWorker[]
): Promise<void> {
  await waitFor(
    `${workers.map((worker) => worker.id).join(", ")} to be ${state}`,
    async () => {
      if (!workers.every((worker) => worker.state === state)) {
        return false;
      }
      const records = await mail.list();
      return workers.every(
        (worker) =>
          records.find((record) => record.id === worker.id)?.state === state,
      );
    },
    WAIT,
  );
}

/** `control` actions published on the `mail` queue's worker channel. */
const workerControls: string[] = [];
const unsubscribeWorkers = await driver.subscribe(
  namespace,
  "worker",
  "mail",
  (event) => {
    if (event.type === "control") {
      workerControls.push(event.payload.action);
    }
  },
);

/* ------------------------------------------------------------------ */
step("Two replicas of one worker, and the constants a UI builds from");

const replicaA = mailWorker(context("billing"));
const replicaB = mailWorker(context("billing"));
await reaches("running", replicaA, replicaB);

checkEqual(
  "the stable key is [service.]queue",
  [replicaA.key, replicaB.key],
  ["billing.mail", "billing.mail"],
);
check("each has its own incarnation id", replicaA.id !== replicaB.id);
checkEqual(
  "a context's workers obey by default, subscribing or polling by driver",
  [replicaA.control.enabled, replicaA.control.stopPersistence],
  [true, "process"],
);
const listed = await mail.list();
checkEqual(
  "list(): both live workers, with key, service and state",
  listed.map((worker) => [worker.key, worker.service, worker.state]),
  [
    ["billing.mail", "billing", "running"],
    ["billing.mail", "billing", "running"],
  ],
);
checkEqual("get(id) finds one", (await mail.get(replicaA.id))?.id, replicaA.id);
checkEqual(
  "get() of an unknown id is null",
  await mail.get("no-such-worker"),
  null,
);
checkEqual(
  "WORKER_CONFIG_KEYS",
  [...WORKER_CONFIG_KEYS],
  [
    "concurrency",
    "pollInterval",
    "maxBlock",
    "lockDuration",
    "heartbeatInterval",
    "stalledInterval",
    "maxStalledCount",
    "reportInterval",
    "drainDelay",
  ],
);
checkEqual(
  "WORKER_CONFIG_BOUNDS.concurrency",
  WORKER_CONFIG_BOUNDS.concurrency,
  {
    min: 1,
    max: 1000,
  },
);

/* ------------------------------------------------------------------ */
step("pause, resume, stop and start");

const paused = await mail.pause({ key: "billing.mail" });
checkEqual(
  "pause({ key }) addresses every replica",
  paused.instances.map((instance) => instance.id).sort(),
  [replicaA.id, replicaB.id].sort(),
);
await reaches("paused", replicaA, replicaB);
show("both paused");
await mail.resume({ key: "billing.mail" });
await reaches("running", replicaA, replicaB);

await mail.stop({ id: replicaA.id });
await reaches("stopped", replicaA);
checkEqual(
  "stop({ id }) parks one incarnation only",
  replicaB.state,
  "running",
);

const pauseRefused = (await checkRejects(
  "pause() of a stopped worker",
  () => mail.pause({ id: replicaA.id }),
  {
    name: "WorkerStateConflictError",
    code: "WORKER_STATE_CONFLICT",
    message: /start it first/,
  },
)) as WorkerStateConflictError | undefined;
checkEqual(
  "its context names the action and the worker's state",
  pauseRefused?.context,
  {
    action: "pause",
    workers: [{ id: replicaA.id, state: "stopped" }],
  },
);
await checkRejects(
  "resume() of a stopped worker",
  () => mail.resume({ id: replicaA.id }),
  { name: "WorkerStateConflictError", message: /use start/ },
);
await checkRejects(
  "pause({ key }) with one parked replica refuses the whole call",
  () => mail.pause({ key: "billing.mail" }),
  { name: "WorkerStateConflictError" },
);
await Bun.sleep(300);
checkEqual(
  "and wrote nothing: one still stopped, the other still running",
  [replicaA.state, replicaB.state],
  ["stopped", "running"],
);

await mail.start({ id: replicaA.id });
await reaches("running", replicaA);
await mail.pause({ id: replicaA.id });
await reaches("paused", replicaA);
check("once started, pause works", true);
await mail.start({ id: replicaA.id });
await reaches("running", replicaA);
checkEqual("start() clears paused too", replicaA.isPaused(), false);

checkEqual(
  "a target matching no live worker is not an error: no instances",
  (await mail.pause({ id: "no-such-worker" })).instances,
  [],
);

/* ------------------------------------------------------------------ */
step("Configuration: by key, validated, versioned, reset");

const stored = await mail.setConfig("billing.mail", { concurrency: 4 });
checkEqual(
  "setConfig() stores the override",
  [stored.values, stored.contended],
  [{ concurrency: 4 }, false],
);
await waitFor(
  "both replicas to run with concurrency 4",
  () => [replicaA, replicaB].every((worker) => worker.concurrency === 4),
  WAIT,
);
checkEqual(
  "config says what is overridden and what the code asked for",
  [
    replicaA.config.effective.concurrency,
    replicaA.config.code.concurrency,
    replicaA.config.overridden,
  ],
  [4, 1, ["concurrency"]],
);

const before = await mail.getConfig("billing.mail");
for (const [label, values, pattern] of [
  [
    "concurrency: 0 is below the bound",
    { concurrency: 0 },
    /concurrency[^\n\r1\u2028\u2029]*1.*1000/,
  ],
  [
    "concurrency: 2.5 is not a whole number",
    { concurrency: 2.5 },
    /whole number/,
  ],
  ["pollInterval: 5 is below the bound", { pollInterval: 5 }, /pollInterval/],
  ["an unknown key", { bogus: 1 }, /bogus/],
] as const) {
  await checkRejects(
    `setConfig(): ${label}`,
    () => mail.setConfig("billing.mail", values as Record<string, number>),
    { name: "ConfigError", message: pattern },
  );
}
checkEqual(
  "and nothing was written",
  await mail.getConfig("billing.mail"),
  before,
);

const merged = await mail.setConfig("billing.mail", { drainDelay: 50 });
checkEqual("a second write merges", merged.values, {
  concurrency: 4,
  drainDelay: 50,
});
const stale = await mail.setConfig(
  "billing.mail",
  { concurrency: 8 },
  { expectedSeq: before.seq },
);
checkEqual(
  "a stale expectedSeq writes nothing and reports contended, without throwing",
  [stale.contended, stale.values],
  [true, { concurrency: 4, drainDelay: 50 }],
);
checkEqual(
  "null removes one field",
  (await mail.setConfig("billing.mail", { drainDelay: null })).values,
  { concurrency: 4 },
);
checkEqual(
  "listConfigs() lists what is stored on the queue",
  (await mail.listConfigs()).map((entry) => [entry.key, entry.values]),
  [["billing.mail", { concurrency: 4 }]],
);

const reset = await mail.resetConfig("billing.mail");
check(
  "resetConfig() empties the override and moves seq on",
  Bun.deepEquals(reset.values, {}) && reset.seq > merged.seq,
  reset,
);
await waitFor(
  "both replicas back to the code's concurrency",
  () => [replicaA, replicaB].every((worker) => worker.concurrency === 1),
  WAIT,
);

check(
  "every call published a control event, whatever publish says",
  ["pause", "resume", "stop", "start", "config", "reset"].every((action) =>
    workerControls.includes(action),
  ),
  workerControls,
);

/* ------------------------------------------------------------------ */
step("How long a stop lasts: stopPersistence and persist");

/**
 * Stops a worker built with `options` from the admin, closes its context —
 * the process going away — and starts a replacement built the same way.
 * Answers the replacement, once it has read its instructions.
 */
async function restartAfterStop(
  service: string,
  options: Parameters<BunJobs["worker"]>[2],
  persist?: "key" | "process",
): Promise<BunQueueWorker> {
  const first = context(service);
  const worker = mailWorker(first, options);
  await reaches("running", worker);
  await mail.stop(
    { id: worker.id },
    persist === undefined ? undefined : { persist },
  );
  await reaches("stopped", worker);
  await first.close();

  const replacement = mailWorker(context(service), options);
  await waitFor(
    "the replacement to report",
    async () => (await mail.get(replacement.id)) !== null,
    WAIT,
  );
  return replacement;
}

const byProcess = await restartAfterStop("p1", {});
checkEqual(
  '"process" (the default): the replacement comes back running',
  byProcess.state,
  "running",
);

const byKey = await restartAfterStop("p2", { stopPersistence: "key" });
checkEqual('"key": the replacement comes up stopped', byKey.state, "stopped");
await mail.start({ key: byKey.key });
await reaches("running", byKey);
show("until somebody starts it", byKey.state);

const notAllowed = await restartAfterStop("p3", {}, "key");
checkEqual(
  "persist on a worker that is not overridable is ignored",
  notAllowed.state,
  "running",
);

const narrowed = await restartAfterStop(
  "p4",
  { stopPersistence: "key", stopPersistenceOverridable: true },
  "process",
);
checkEqual(
  'an overridable "key" worker told persist: "process" comes back running',
  [narrowed.state, narrowed.control.stopPersistenceOverridable],
  ["running", true],
);

/** Where the tour's `mail` queue lives, as the store helpers want it. */
const mailRef = { ns: namespace, queue: "mail" };

const widened = await restartAfterStop(
  "p5",
  { stopPersistenceOverridable: true },
  "key",
);
checkEqual(
  'an overridable "process" worker told persist: "key": its replacement comes up stopped',
  [widened.state, widened.control.stopPersistence],
  ["stopped", "process"],
);
await Bun.sleep(300);
checkEqual(
  "and stays stopped until somebody starts it",
  widened.state,
  "stopped",
);
await mail.start({ key: widened.key });
await reaches("running", widened);
await waitFor(
  "the start to clear the stop recorded against the key",
  async () => (await readWorkerStop(driver, mailRef, widened.key)) === null,
  WAIT,
);

/** Starts a `"key"` worker on `service`'s key, once it has read its stop. */
async function laterKeyWorker(service: string): Promise<BunQueueWorker> {
  const later = mailWorker(context(service), { stopPersistence: "key" });
  await waitFor(
    "the later worker to report",
    async () => (await mail.get(later.id)) !== null,
    WAIT,
  );
  return later;
}

checkEqual(
  'a later "key" worker on that key is not parked: the start cleared the stop',
  (await laterKeyWorker("p5")).state,
  "running",
);
checkEqual(
  "nor on the key whose ignored persist wrote nothing",
  (await laterKeyWorker("p3")).state,
  "running",
);

/* ------------------------------------------------------------------ */
step("A worker announces its first start: a `state` with no `previous`");

// Published only by a worker that publishes (`publish`, or `publishEvents`
// on its context). The first `run()` announces what startup settled —
// `running`, `paused`, or `stopped` under a stop recorded against its key —
// and leaves `previous` out; that absence is how a dashboard tells a start
// from a transition. Nothing is announced before `run()`.

/** Every `state` payload published on the `digest` queue's worker channel. */
const digestStates: WorkerEventPayloads["state"][] = [];
const unsubscribeDigest = await driver.subscribe(
  namespace,
  "worker",
  "digest",
  (event) => {
    if (event.type === "state") {
      digestStates.push(event.payload as WorkerEventPayloads["state"]);
    }
  },
);

/** A publishing, remotely controllable worker on `digest`, not yet run. */
function digestWorker(
  service: string,
  options: Parameters<BunJobs["worker"]>[2] = {},
): BunQueueWorker {
  return context(service).worker<unknown, unknown>("digest", async () => "ok", {
    publish: true,
    remoteControl: { interval: 100 },
    ...options,
  });
}

/** One worker's `state` events, as `first:<state>` or `<previous>-><state>`. */
function stepsOf(worker: BunQueueWorker): string[] {
  return digestStates
    .filter((event) => event.worker === worker.id)
    .map((event) =>
      event.previous === undefined
        ? `first:${event.state}`
        : `${event.previous}->${event.state}`,
    );
}

/** Waits until `worker` has published `count` state events. */
async function statesFrom(worker: BunQueueWorker, count: number) {
  await waitFor(
    `${count} state event(s) from ${worker.id}`,
    () => stepsOf(worker).length >= count,
    WAIT,
  );
}

const plain = digestWorker("d1");
void plain.run();
await statesFrom(plain, 1);
const plainFirst = digestStates.find((event) => event.worker === plain.id)!;
checkEqual(
  "a first run(): state running, and no previous at all",
  [plainFirst.state, plainFirst.key, Object.hasOwn(plainFirst, "previous")],
  ["running", "d1.digest", false],
);
await plain.pause();
await statesFrom(plain, 2);
checkEqual("every later change carries previous", stepsOf(plain), [
  "first:running",
  "running->paused",
]);

const early = digestWorker("d2");
await early.pause();
await Bun.sleep(300);
checkEqual("pause() before run() announces nothing yet", stepsOf(early), []);
void early.run();
await statesFrom(early, 1);
checkEqual(
  "paused before run(): the first start is announced as paused",
  stepsOf(early),
  ["first:paused"],
);

// A stop recorded against the key, as `stop({ key }, { persist: "key" })`
// leaves it for a `"key"` worker's replacement.
await writeWorkerStop(
  driver,
  { ns: namespace, queue: "digest" },
  "d3.digest",
  true,
);
const parked = digestWorker("d3", { stopPersistence: "key" });
void parked.run();
await statesFrom(parked, 1);
const parkedFirst = digestStates.find((event) => event.worker === parked.id)!;
checkEqual(
  "under a key stop: stopped, with its reason, and no previous",
  [
    parkedFirst.state,
    parkedFirst.reason,
    Object.hasOwn(parkedFirst, "previous"),
  ],
  ["stopped", "stopped persistently", false],
);
await admin.workers.remote("digest").start({ id: parked.id });
await statesFrom(parked, 2);
checkEqual("started remotely, it is a transition", stepsOf(parked), [
  "first:stopped",
  "stopped->running",
]);
checkEqual(
  "one first start per worker, and only one",
  [plain, early, parked].map(
    (worker) => stepsOf(worker).filter((s) => s.startsWith("first:")).length,
  ),
  [1, 1, 1],
);

/* ------------------------------------------------------------------ */
step("The same rules over the management API");

const api = createJobsApi({
  jobs: admin,
  basePath: "/admin/jobs",
  logger: createTestLogger().logger,
  authorize: () => true,
  // workers.configure and runners.configure are opt-in.
  actions: [...JOBS_API_ACTIONS],
});
const root = new BunRouter();
root.use(api.basePath, api.router);

/** Sends one JSON request; answers the status and parsed body. */
async function call(method: string, path: string, body?: unknown) {
  const response = await root.fetch(`/admin/jobs${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

await mail.stop({ id: replicaB.id });
await reaches("stopped", replicaB);
const apiPause = await call(
  "POST",
  `/queues/mail/workers/${replicaB.id}/pause`,
);
checkEqual(
  "pause of a stopped worker is 409 WORKER_STATE_CONFLICT",
  [apiPause.status, apiPause.body?.code],
  [409, "WORKER_STATE_CONFLICT"],
);
const apiPersist = await call(
  "POST",
  `/queues/mail/workers/${replicaB.id}/stop`,
  {
    persist: "key",
  },
);
checkEqual(
  "persist on a worker that is not overridable is 409 WORKER_PERSISTENCE_NOT_ALLOWED",
  [apiPersist.status, apiPersist.body?.code],
  [409, "WORKER_PERSISTENCE_NOT_ALLOWED"],
);
const apiStart = await call(
  "POST",
  `/queues/mail/workers/${replicaB.id}/start?wait=10000`,
);
checkEqual(
  "start with ?wait= answers 200 once the worker acknowledges",
  [apiStart.status, apiStart.body?.state ?? apiStart.body?.worker?.state],
  [200, "running"],
);
const apiConfig = await call(
  "PUT",
  "/queues/mail/worker-configs/billing.mail",
  {
    concurrency: 0,
  },
);
checkEqual(
  "an out-of-bounds override is 400 VALIDATION",
  [apiConfig.status, apiConfig.body?.code],
  [400, "VALIDATION"],
);

const direct = new Worker("mail", async () => "sent", {
  namespace,
  driver,
  id: "built-directly",
  logger: createTestLogger().logger,
});
void direct.run();
await waitFor(
  "the direct worker to report",
  async () => (await mail.get(direct.id)) !== null,
  WAIT,
);
checkEqual(
  "a BunQueueWorker built directly does not obey by default",
  (await mail.get(direct.id))?.control?.enabled,
  false,
);
const apiDirect = await call("POST", `/queues/mail/workers/${direct.id}/pause`);
checkEqual(
  "so the API answers 409 WORKER_NOT_CONTROLLABLE",
  [apiDirect.status, apiDirect.body?.code],
  [409, "WORKER_NOT_CONTROLLABLE"],
);
checkEqual(
  "while RemoteWorker, the lower-level call, writes it anyway",
  (await mail.pause({ id: direct.id })).instances.length,
  1,
);
await direct.close();

/* ------------------------------------------------------------------ */
step("A runner's configuration, changed by one owner, adopted by the other");

checkEqual(
  "EXECUTION_MODES",
  [...EXECUTION_MODES],
  ["spawn", "worker", "in-process"],
);
checkEqual(
  "RUNNER_CONFIG_KEYS",
  [...RUNNER_CONFIG_KEYS],
  ["executionMode", "runMode", "maxConcurrency"],
);
checkEqual("RUNNER_CONFIG_BOUNDS", RUNNER_CONFIG_BOUNDS, {
  maxConcurrency: { min: 1, max: 1000 },
});

/** Options both owners of the `report` runner share. */
const reportOptions: Omit<
  BunRunnerOptions<WorkArgs>,
  "namespace" | "driver"
> = {
  id: "report",
  file: new URL("./handlers/runner-work.ts", import.meta.url),
  executionMode: "in-process",
  remoteConfig: { executionModes: ["in-process", "worker"] },
  // "auto", the default, subscribes on Redis and memory only; true subscribes
  // everywhere, so the other owner hears the change on every backend.
  remoteControl: true,
};
const ownerContext = context("a");
const ownerA = ownerContext.runner<WorkArgs, WorkResult>(reportOptions);
const ownerB = context("b").runner<WorkArgs, WorkResult>(reportOptions);
/** `configured` events on the second owner, with when they arrived. */
const configuredOnB: { at: number; mode: string; runMode: string }[] = [];
ownerB.on("configured", (info) => {
  configuredOnB.push({
    at: Date.now(),
    mode: info.effective.executionMode,
    runMode: info.effective.runMode,
  });
});
await ownerA.start();
await ownerB.start();

/** `control` actions published for the runner. */
const runnerControls: string[] = [];
const unsubscribeRunner = await driver.subscribe(
  namespace,
  "runner",
  "report",
  (event) => {
    if (event.type === "control") {
      runnerControls.push(event.payload.action);
    }
  },
);

const writtenAt = Date.now();
const updated = await ownerA.updateConfig({ executionMode: "worker" });
checkEqual(
  "updateConfig() adopts it here at once",
  [
    updated.effective.executionMode,
    updated.code?.executionMode,
    updated.overridden,
  ],
  ["worker", "in-process", ["executionMode"]],
);
await waitFor(
  "the control event",
  () => runnerControls.includes("config"),
  WAIT,
);
check(
  "a direct updateConfig() publishes control { action: 'config' }",
  true,
  runnerControls,
);
await waitFor(
  "the other owner to adopt it",
  () => configuredOnB.some((event) => event.mode === "worker"),
  WAIT,
);
const lag =
  configuredOnB.find((event) => event.mode === "worker")!.at - writtenAt;
check(
  `the other owner adopted it in ${lag}ms, not at its next sync (30000ms)`,
  lag < 15_000 && ownerB.config.effective.executionMode === "worker",
  { lag, config: ownerB.config },
);

const ran = await ownerA.trigger({ args: { tag: "after" } });
await waitFor(
  "the run after the change to settle",
  async () => (await ownerA.history(1))[0]?.status === "success",
  WAIT,
);
checkEqual(
  "it applies from the next run",
  [ran.outcome, (await ownerA.history(1))[0]?.mode],
  ["started", "worker"],
);

for (const [label, patch, reason] of [
  ["an empty patch", {}, "empty"],
  ["a mode remoteConfig forbids", { executionMode: "spawn" }, "not-allowed"],
  [
    "maxConcurrency 0",
    { concurrency: { runMode: "parallel", maxConcurrency: 0 } },
    "invalid",
  ],
  [
    "maxConcurrency 1001",
    { concurrency: { runMode: "parallel", maxConcurrency: 1001 } },
    "invalid",
  ],
] as const) {
  const error = (await checkRejects(
    `updateConfig(): ${label}`,
    () =>
      ownerA.updateConfig(patch as Parameters<typeof ownerA.updateConfig>[0]),
    { name: "ConfigError" },
  )) as ConfigError | undefined;
  checkEqual(`  context.reason is "${reason}"`, error?.context?.reason, reason);
}

const remoteReport = await admin.runners.remote("report");
checkEqual("from the admin, the runner is remote", remoteReport.isLocal, false);
await remoteReport.updateConfig({
  concurrency: { runMode: "parallel", maxConcurrency: 3 },
});
await waitFor(
  "both owners to run parallel",
  () =>
    ownerA.config.effective.runMode === "parallel" &&
    ownerB.config.effective.runMode === "parallel",
  WAIT,
);
// `config()` reads the store, and an owner adopts a change *before* it
// writes one: `#adoptConfig` emits `configured` and only then awaits
// `driver.setState` (BunRunner.ts, around l.1110). So the wait above — on the
// owners' own fields — does not mean the store has caught up, and a single
// read here is a race the owners lose under load, MySQL most often, its
// `setState` being a locking transaction two owners contend for. Wait for the
// store itself, which is what `config()` documents itself as reading.
let remoteView = await remoteReport.config();
await waitFor(
  "the store to carry what the owners adopted",
  async () => {
    remoteView = await remoteReport.config();
    return remoteView?.effective.runMode === "parallel";
  },
  WAIT,
);
checkEqual(
  "RemoteRunner.config() reads what the owners stored",
  [
    remoteView?.effective,
    remoteView?.overridden.slice().sort(),
    remoteView?.allowed?.slice().sort(),
  ],
  [
    { executionMode: "worker", runMode: "parallel", maxConcurrency: 3 },
    ["executionMode", "maxConcurrency", "runMode"],
    ["in-process", "worker"],
  ],
);

// On the owner's own context, remote(id) is local: it delegates to the
// runner, which announces the change once — not once more on top.
const localController = await ownerContext.runners.remote("report");
checkEqual(
  "on the owner's context, remote(id) is local",
  localController.isLocal,
  true,
);
const controlsBefore = runnerControls.length;
await localController.updateConfig({ executionMode: null });
await waitFor(
  "its control event",
  () => runnerControls.length > controlsBefore,
  WAIT,
);
await Bun.sleep(500);
checkEqual(
  "one call, one control event",
  runnerControls.length,
  controlsBefore + 1,
);

const apiRunner = await call("PUT", "/runners/report/config", {
  executionMode: "spawn",
});
checkEqual(
  "over the API, a forbidden mode is 409 CONFIG_NOT_ALLOWED",
  [apiRunner.status, apiRunner.body?.code],
  [409, "CONFIG_NOT_ALLOWED"],
);

const resetInfo = await ownerA.resetConfig();
checkEqual(
  "resetConfig(): back to the code",
  [resetInfo.effective, resetInfo.overridden],
  [
    { executionMode: "in-process", runMode: "single", maxConcurrency: null },
    [],
  ],
);
await waitFor(
  "the other owner to follow the reset",
  () =>
    ownerB.config.effective.runMode === "single" &&
    ownerB.config.overridden.length === 0,
  WAIT,
);

// An owner built from a driver instance, with no config to hand a child,
// cannot move its handler out of the process. It publishes only the modes it
// can adopt, so the call is refused up front rather than stored and dropped.
const bare = new BunJobs({
  namespace,
  driver,
  logger: createTestLogger().logger,
});
contexts.push(bare);
const bareRunner = bare.runner<WorkArgs, WorkResult>({
  ...reportOptions,
  id: "bare-report",
  remoteControl: false,
});
await bareRunner.start();
checkEqual(
  "an owner with no childDriver permits only in-process",
  bareRunner.config.allowed,
  ["in-process"],
);
const bareRefusal = (await checkRejects(
  "so updateConfig({ executionMode: 'worker' }) is refused up front",
  () => bareRunner.updateConfig({ executionMode: "worker" }),
  { name: "ConfigError" },
)) as ConfigError | undefined;
checkEqual(
  '  context.reason is "not-allowed", and nothing was stored',
  [bareRefusal?.context?.reason, bareRunner.config.overridden],
  ["not-allowed", []],
);

/* ------------------------------------------------------------------ */
step("A refusal names the settings it refused: config.error.keys");

// The owner is the last word on an override: it adopts what it can and
// refuses the rest, and `config.error.keys` names what it refused — in
// `RUNNER_CONFIG_KEYS` order — so a controller can tell a partial refusal
// from a whole one without parsing `message`. Every overridden key not listed
// was adopted.
//
// This owner's code permits `worker`, but it was built from a driver instance
// with no `childDriver`, so it cannot move its handler out of the process.
// It publishes only `in-process`, so `updateConfig()`, `RemoteRunner` and the
// API all refuse `worker` up front; the override below is written straight to
// the store, as an owner that had a `childDriver` — or an older controller —
// would have stored it before this one started.
const keysRunner = bare.runner<WorkArgs, WorkResult>({
  ...reportOptions,
  id: "keys-report",
  runMode: "parallel",
  remoteControl: false,
  // Polls the store every 100ms rather than every 30 s, so the tour is quick.
  syncInterval: 100,
});
await keysRunner.start();
/** Where the owner keeps its state, as the store helpers want it. */
const keysKey = runnerKey("keys-report");

await writeRunnerConfig(driver, namespace, keysKey, {
  [RUNNER_CONFIG_STATE.executionMode]: "worker",
  [RUNNER_CONFIG_STATE.runMode]: "single",
});
await waitFor(
  "the owner to refuse part of the override",
  () => keysRunner.config.error !== undefined,
  WAIT,
);
checkEqual(
  "a partial refusal: keys names only the refused setting; the rest adopted",
  [
    keysRunner.config.overridden,
    keysRunner.config.error?.keys,
    keysRunner.config.effective.executionMode,
    keysRunner.config.effective.runMode,
  ],
  [["executionMode", "runMode"], ["executionMode"], "in-process", "single"],
);
check(
  "  and message still says why",
  /driver config/.test(keysRunner.config.error?.message ?? ""),
  keysRunner.config.error,
);
checkEqual(
  "  another process reads the same keys (RemoteRunner.config())",
  (await (await admin.runners.remote("keys-report")).config())?.error?.keys,
  ["executionMode"],
);
// The API finds a runner another context owns through its cached discovery
// (`limits.queueCacheMs`, 2 s by default) — and finds it *at once*, however
// new it is. The guarantee is not that the API stopped reading the backend:
// `RunnerSource.resolve` still asks it again when the cached discovery has
// never heard of the id, since an id it does not know may simply be newer
// than the cache. What is bounded is how often: at most one such re-read per
// cache window however many misses arrive, shared between concurrent ones
// (`lib/api/sources.ts`, `TtlSet.has`), so an id nothing knows still cannot
// turn into a backend read per request.
const keysOverApi = await call("GET", "/runners/keys-report");
checkEqual(
  "  and so does GET /runners/{id}, at once: config.error.keys",
  [keysOverApi.status, keysOverApi.body?.config?.error?.keys],
  [200, ["executionMode"]],
);

// Every setting overridden, and every one refused: an unusable mode, an
// overlap policy that does not exist, a cap out of `RUNNER_CONFIG_BOUNDS`.
await writeRunnerConfig(driver, namespace, keysKey, {
  [RUNNER_CONFIG_STATE.executionMode]: "worker",
  [RUNNER_CONFIG_STATE.runMode]: "sometimes",
  [RUNNER_CONFIG_STATE.maxConcurrency]: "9000",
});
await waitFor(
  "the owner to refuse the whole override",
  () => keysRunner.config.error?.keys.length === 3,
  WAIT,
);
checkEqual(
  "a whole refusal: keys names every overridden key, and the code's values stand",
  [
    keysRunner.config.error?.keys,
    keysRunner.config.overridden,
    keysRunner.config.effective,
  ],
  [
    ["executionMode", "runMode", "maxConcurrency"],
    ["executionMode", "runMode", "maxConcurrency"],
    {
      executionMode: "in-process",
      runMode: "parallel",
      maxConcurrency: keysRunner.config.code?.maxConcurrency ?? null,
    },
  ],
);
checkEqual(
  "  one message per refused setting",
  keysRunner.config.error?.message.split("; ").length,
  3,
);

// An error an owner stored before `keys` existed reads as `keys: []`: known
// to be a refusal, of settings nobody recorded.
const keysState = await driver.getState(namespace, keysKey);
checkEqual(
  "an error stored before keys existed reads keys: []",
  describeRunnerConfig({
    ...keysState,
    [RUNNER_CONFIG_STATE.error]: JSON.stringify({
      at: 123,
      message: 'executionMode "worker" needs a driver config',
    }),
  })?.error,
  {
    at: 123,
    message: 'executionMode "worker" needs a driver config',
    keys: [],
  },
);

await keysRunner.resetConfig();
checkEqual("once reset, no error at all", keysRunner.config.error, undefined);

/* ------------------------------------------------------------------ */
step("A buried flow completes whichever order it is retried in");

const flows = context();
const reports = flows.queue("reports");
const fetch = flows.queue("fetch");
/** Children that have already failed once; they succeed when retried. */
const failedOnce = new Set<string>();
const fetcher = flows.worker("fetch", async (job) => {
  if (job.name === "bad" && !failedOnce.has(job.id)) {
    failedOnce.add(job.id);
    throw new UnrecoverableJobError("upstream answered garbage");
  }
  return `${job.name} ok`;
});
const reporter = flows.worker(
  "reports",
  async (job) => await job.getChildrenValues(),
);
void fetcher.run();
void reporter.run();

/** Adds `report <- [bad, good]` and waits for the bury. */
async function buriedFlow(label: string) {
  const tree = await reports.addFlow({
    name: "report",
    data: { label },
    children: [
      { name: "bad", data: {}, queue: "fetch" },
      { name: "good", data: {}, queue: "fetch" },
    ],
  });
  const parent = tree.job;
  const [bad, good] = tree.children!.map((child) => child.job);
  await waitFor(
    `${label}: the parent to be buried and the good child to complete`,
    async () =>
      (await reports.getJob(parent.id))?.state === "dead" &&
      (await fetch.getJob(good!.id))?.state === "completed",
    WAIT,
  );
  const buried = (await reports.getJob(parent.id))!;
  checkEqual(
    `${label}: the parent is dead with a ChildFailedError; good completed`,
    [buried.failedReason?.name, (await fetch.getJob(good!.id))?.state],
    ["ChildFailedError", "completed"],
  );
  return { parent: parent.id, bad: bad!.id, good: good!.id };
}

/** Waits for the parent to complete, and checks it saw both children. */
async function completes(
  label: string,
  ids: { parent: string; bad: string; good: string },
) {
  await waitFor(
    `${label}: the parent to complete`,
    async () => (await reports.getJob(ids.parent))?.state === "completed",
    WAIT,
  );
  checkEqual(
    `${label}: completed, with both children's values`,
    (await reports.getJob(ids.parent))?.returnValue,
    { [`fetch:${ids.bad}`]: "bad ok", [`fetch:${ids.good}`]: "good ok" },
  );
}

const orderA = await buriedFlow("parent first");
checkEqual(
  "  retry(parent) answers true",
  await reports.retry(orderA.parent),
  true,
);
checkEqual(
  "  and returns it to waiting-children",
  (await reports.getJob(orderA.parent))?.state,
  "waiting-children",
);
await fetch.retry(orderA.bad);
await completes("parent first", orderA);

const orderB = await buriedFlow("child first");
await fetch.retry(orderB.bad);
await waitFor(
  "child first: the child to complete while its parent is still buried",
  async () => (await fetch.getJob(orderB.bad))?.state === "completed",
  WAIT,
);
checkEqual(
  "  the parent stays dead until it is retried",
  (await reports.getJob(orderB.parent))?.state,
  "dead",
);
await reports.retry(orderB.parent);
await completes("child first", orderB);

/* ------------------------------------------------------------------ */
step("Clean up");

await unsubscribeWorkers();
await unsubscribeDigest();
await unsubscribeRunner();
for (const jobs of contexts.reverse()) {
  await jobs.close();
}
await driver.purge(namespace);
await driver.close();
summary();
