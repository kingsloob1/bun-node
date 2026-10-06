/**
 * Sending a job to another queue — `.toQueue(name)` and
 * `jobs.queue(name).<verb>`.
 *
 * ```bash
 * bun 03-job-registry/send-to-another-queue.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 03-job-registry/send-to-another-queue.ts
 * ```
 *
 * The builder verbs add to the registry queue (`"jobs"`) unless you name
 * another, in either of two ways, which make the same builder:
 *
 * - `jobs.schedule(name, data).toQueue("images")`, and the same on a saved
 *   draft, `jobs.create(name, data).toQueue("images")`. `toQueue()` moves a
 *   job whose name the registry **defines**: `jobs.schedule()`, `run()`,
 *   `now()` and `create()` still refuse an undefined name at the call, before
 *   `toQueue()` is reached.
 * - `jobs.queue("images").schedule(...)`, `.run(...)`, `.now(...)` and
 *   `.create(...)`, which take **any** name — the way to send a name the
 *   registry never defined.
 *
 * Whatever works that queue runs the job; the registry's worker never sees
 * it. And the job takes only what the call passes: the options `define()`
 * gave the name (attempts, priority, timeout, …) do not follow it, because
 * another queue's worker decides its own policy. Naming the registry queue
 * itself — `jobs.queue("jobs")`, or `.toQueue("jobs")` — is the plain
 * builder again, definition defaults and all.
 *
 * Every claim below is a `check(...)`, so a run is a test of it.
 */
import type { Job } from "@kingsleyweb/bun-jobs";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/** What an image job carries. */
interface Image {
  /** Which image to work on. */
  id: string;
}

/** The options a `define()` default could have set, as a job stored them. */
interface Policy {
  /** How many attempts it gets (`maxAttempts`). */
  attempts: number;
  /** Its priority; lower runs first. */
  priority: number;
  /** Its time limit per attempt, in ms; `0` or absent for none. */
  timeout: number | undefined;
}

title("Job registry: sending a job to another queue");

const jobs = new BunJobs({
  namespace: exampleNamespace("to-queue"),
  driver: exampleDriver(),
});

/** The options `define()` gives "resize" — the registry's policy for it. */
const RESIZE_DEFAULTS = { attempts: 5, priority: 3, timeout: 4_000 };

/** Ids of the jobs the registry's own "resize" handler has run. */
const registryRan: string[] = [];

jobs.define<Image>(
  "resize",
  async (job) => {
    registryRan.push(job.id);
  },
  RESIZE_DEFAULTS,
);

// "watermark" is never defined here: the images service, say, knows it.
const registry = jobs.queue<Image>("jobs");
const images = jobs.queue<Image>("images");

/** Every job sent to "images", to wait for the worker there to run them. */
const sentToImages: Job<Image>[] = [];
/** Every job added to the registry queue, for its own worker. */
const sentToRegistry: Job<Image>[] = [];

/** Where a job is stored: on "images", on "jobs", both or neither. */
async function whereStored(job: Job<Image>): Promise<string[]> {
  const found: string[] = [];
  if (await images.getJob(job.id)) found.push("images");
  if (await registry.getJob(job.id)) found.push("jobs");
  return found;
}

/* ------------------------------------------------------------------ */
step("The registry queue refuses a name it does not define, at the verb");

await checkRejects(
  'jobs.schedule("watermark") throws',
  () => jobs.schedule("watermark"),
  { name: "ConfigError", message: /watermark/ },
);
await checkRejects(
  'jobs.run("watermark") throws',
  () => jobs.run("watermark"),
  { name: "ConfigError" },
);
await checkRejects(
  'jobs.create("watermark") throws',
  () => jobs.create("watermark"),
  { name: "ConfigError" },
);
await checkRejects(
  'jobs.now("watermark") rejects',
  () => jobs.now("watermark"),
  { name: "ConfigError" },
);
// Named explicitly, the registry queue is the plain builder: the same rule.
await checkRejects(
  'jobs.queue("jobs").schedule("watermark") throws as well',
  () => registry.schedule("watermark"),
  { name: "ConfigError" },
);

/* ------------------------------------------------------------------ */
step('jobs.queue("images").<verb> takes any name');

const scheduled = await images
  .schedule("watermark", { id: "w-schedule" })
  .in("1 second")
  .start();
const run = await images.run("watermark", { id: "w-run" }).start();
const now = await images.now(
  "watermark",
  { id: "w-now" },
  { priority: 2 }, // options, as `jobs.now()` takes them
);
const saved = await images
  .create("watermark", { id: "w-create" })
  .priority(6)
  .save();
sentToImages.push(scheduled, run, now, saved);

for (const [verb, job] of Object.entries({ scheduled, run, now, saved })) {
  checkEqual(`${verb}: stored on "images" only`, await whereStored(job), [
    "images",
  ]);
}
checkEqual(
  "each kept its name and its data",
  [scheduled, run, now, saved].map((job) => `${job.name}:${job.data.id}`),
  [
    "watermark:w-schedule",
    "watermark:w-run",
    "watermark:w-now",
    "watermark:w-create",
  ],
);
checkEqual("schedule().in() made it delayed", scheduled.state, "delayed");
checkEqual("now() took the priority it was passed", now.priority, 2);
checkEqual("create().priority() took too", saved.priority, 6);

/* ------------------------------------------------------------------ */
step(".toQueue() moves a defined name's job, from a builder or a draft");

const viaBuilder = await jobs
  .schedule<Image>("resize", { id: "r-builder" })
  .toQueue<Image>("images")
  .in("1 second")
  .start();
const viaDraft = await jobs
  .create<Image>("resize", { id: "r-draft" })
  .toQueue<Image>("images")
  .priority(1)
  .save();
sentToImages.push(viaBuilder, viaDraft);

checkEqual(
  'builder .toQueue("images"): stored on "images" only',
  await whereStored(viaBuilder),
  ["images"],
);
checkEqual(
  'draft .toQueue("images"): stored on "images" only',
  await whereStored(viaDraft),
  ["images"],
);
checkEqual(
  "the job reports the queue it is on",
  viaBuilder.queue.queue,
  "images",
);
show("moved", {
  builder: { name: viaBuilder.name, state: viaBuilder.state },
  draft: { name: viaDraft.name, priority: viaDraft.priority },
});

/* ------------------------------------------------------------------ */
step("The registry's defaults stay behind; what the call passes goes");

// A job nobody said anything about: what "images" gives by itself.
const bare = await images.now("watermark", { id: "w-bare" });
const plainMove = await jobs
  .schedule<Image>("resize", { id: "r-plain" })
  .toQueue<Image>("images")
  .start();
const viaQueueVerb = await images.schedule("resize", { id: "r-verb" }).start();
sentToImages.push(bare, plainMove, viaQueueVerb);

/** The options the registry could have lent, read back from the store. */
async function policy(job: Job<Image>): Promise<Policy> {
  const stored = await jobs.queue<Image>(job.queue.queue).getJob(job.id);
  if (!stored) throw new Error(`job ${job.id} is not stored`);
  return {
    attempts: stored.maxAttempts,
    priority: stored.priority,
    timeout: stored.opts.timeout,
  };
}

show("define() gave resize", RESIZE_DEFAULTS);
show('"resize" moved with .toQueue(), nothing passed', await policy(plainMove));
checkEqual(
  ".toQueue(): attempts, priority and timeout are a bare job's",
  await policy(plainMove),
  await policy(bare),
);
checkEqual(
  'jobs.queue("images").schedule("resize"): the same',
  await policy(viaQueueVerb),
  await policy(bare),
);
const moved = await policy(plainMove);
check(
  "so none of define()'s options followed it",
  moved.attempts !== RESIZE_DEFAULTS.attempts &&
    moved.priority !== RESIZE_DEFAULTS.priority &&
    moved.timeout !== RESIZE_DEFAULTS.timeout,
  moved,
);
checkEqual(
  "nor the moved draft's: a bare job's, but the priority it set",
  await policy(viaDraft),
  { ...(await policy(bare)), priority: 1 },
);

// Told something before toQueue() and after it: both apply.
const told = await jobs
  .schedule<Image>("resize", { id: "r-told" })
  .priority(4)
  .toQueue<Image>("images")
  .attempts(2)
  .start();
sentToImages.push(told);
checkEqual(
  "priority(4) before .toQueue() and attempts(2) after it both stand",
  await policy(told),
  { ...(await policy(bare)), attempts: 2, priority: 4 },
);

/* ------------------------------------------------------------------ */
step("The registry queue, by any spelling, still applies them");

const plain = await jobs
  .schedule<Image>("resize", { id: "r-plain-registry" })
  .start();
const named = await registry
  .schedule("resize", { id: "r-named-registry" })
  .start();
const backAgain = await jobs
  .schedule<Image>("resize", { id: "r-back" })
  .toQueue<Image>("images")
  .toQueue<Image>("jobs") // the last toQueue() wins
  .start();
sentToRegistry.push(plain, named, backAgain);

for (const [spelling, job] of Object.entries({
  'jobs.schedule("resize")': plain,
  'jobs.queue("jobs").schedule("resize")': named,
  '.toQueue("images").toQueue("jobs")': backAgain,
})) {
  checkEqual(
    `${spelling}: define()'s options`,
    await policy(job),
    RESIZE_DEFAULTS,
  );
}
checkEqual(
  '.toQueue("jobs") last: stored on "jobs" only',
  await whereStored(backAgain),
  ["jobs"],
);

/* ------------------------------------------------------------------ */
step('A worker on "images" runs them; the registry\'s never sees them');

/** Ids of the jobs the "images" worker has run. */
const imagesRan: string[] = [];

const imagesWorker = jobs.worker<Image, string>(
  "images",
  async (job) => {
    imagesRan.push(job.id);
    return `${job.name} ${job.data.id}`;
  },
  { pollInterval: 50 },
);
void imagesWorker.run();
const registryWorker = await jobs.start({ pollInterval: 50 });

/** Whether every job in `list` has reached `completed` on `queue`. */
async function allCompleted(
  queue: typeof images,
  list: Job<Image>[],
): Promise<boolean> {
  for (const job of list) {
    if ((await queue.getJob(job.id))?.state !== "completed") return false;
  }
  return true;
}

await waitFor("the images jobs, the delayed two included", async () => {
  return await allCompleted(images, sentToImages);
});
await waitFor("the registry's jobs", async () => {
  return await allCompleted(registry, sentToRegistry);
});

/** The ids of `list`, sorted, for comparing sets. */
const ids = (list: Job<Image>[]) => list.map((job) => job.id).sort();

show("images worker ran", imagesRan.length);
show("registry worker ran", registryRan.length);
checkEqual(
  'the "images" worker ran every job sent there — moved or any-named',
  imagesRan.toSorted(),
  ids(sentToImages),
);
checkEqual(
  "the registry's resize handler ran only the registry queue's jobs",
  registryRan.toSorted(),
  ids(sentToRegistry),
);
check("no job ran on both", !imagesRan.some((id) => registryRan.includes(id)), {
  imagesRan,
  registryRan,
});

await imagesWorker.close();
await registryWorker.close();
await jobs.purge();
await jobs.close();

summary();
